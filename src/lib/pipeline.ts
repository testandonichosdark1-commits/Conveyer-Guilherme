import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeScene, resolveTtsProvider } from "./services/tts";
import { synthesizeAndAlign, type SceneAudioRange } from "./services/tts-align";
import { animateScene, pickPhotoScenes, type AssetMode } from "./services/img2vid";
import { pexelsPreflight } from "./services/stock-footage";
import {
  assembleVideo,
  assembleSingleShot,
  type AssembleInput,
  type SingleShotInput,
  type OverlaySpec,
} from "./services/video-assemble";
import { syncRunToDrive } from "./services/run-upload";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

type SceneResult = AssembleInput | null;

export async function runPipeline(runId: string, script: string) {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const animDir = path.join(runDir, "animations");
  for (const d of [runDir, audioDir, animDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", `Pipeline started · folder: ${path.basename(runDir)}`, { stage: "pipeline" });

    // 1. Split script into scenes via Gemini.
    const scenes = await splitScript(runId, script);
    checkCancelled(runId);
    fs.writeFileSync(path.join(runDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf-8");

    // 1b. Pexels pre-flight — verify the stock-footage source works BEFORE we
    //     generate any (paid) voiceovers. A bad/missing PEXELS_API_KEY otherwise
    //     wastes hundreds of TTS jobs and then fails at the end (the "audio but
    //     no visuals" failure). Fail fast + clear instead.
    checkCancelled(runId);
    try {
      await pexelsPreflight(runId);
      log(runId, "info", "Pexels check OK — stock footage is reachable", { stage: "pipeline" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Pexels pre-flight failed — aborting before any voiceovers are generated (saves your TTS credits). ` +
          `Cause: ${msg}. Fix: open Settings and confirm PEXELS_API_KEY is set and valid, then run again.`
      );
    }

    // 1c. SINGLE-SHOT VOICEOVER MODE (default). One continuous voiceover is
    //     synthesised for the WHOLE script, Groq Whisper word-aligns the scene
    //     boundaries back, and visuals are rendered silent then muxed under the
    //     global audio. Fixes the mid-sentence pause a per-scene voiceover makes
    //     when one sentence spans two scenes. `per-scene` keeps the legacy flow.
    const ttsMode = (getSetting("TTS_MODE") || "single-shot").toLowerCase();
    if (ttsMode === "single-shot") {
      await runSingleShot(runId, scenes, runDir, audioDir, animDir);
      return;
    }

    // 2. Per scene: TTS + Pexels stock clip, in parallel, concurrency-limited.
    const ttsConc = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
    const animConc = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "5"));
    const limitTts = pLimit(ttsConc);
    const limitAnim = pLimit(animConc);

    // Scene-mix decision: which scenes get a still photo (ken-burns) vs a
    // moving video clip. Default 40% photos for visual variety.
    const photoRatio = Math.max(0, Math.min(100, Number(getSetting("SCENE_PHOTO_RATIO") || "40")));
    const mixMode = (getSetting("SCENE_MIX_MODE") || "random") as "random" | "alternating";
    const photoScenes = pickPhotoScenes(scenes, photoRatio, mixMode);

    log(
      runId,
      "info",
      `Voice engine: ${resolveTtsProvider()} · voice ${getSetting("TTS_VOICE_ID") || "(not set)"} · per-scene mode`,
      { stage: "tts" }
    );
    log(
      runId,
      "info",
      `Generating ${scenes.length} scenes · TTS=${ttsConc}, Pexels=${animConc} in parallel · ${photoScenes.size} photo / ${scenes.length - photoScenes.size} video`,
      { stage: "pipeline" }
    );

    // Shared across scenes — Pexels ids already claimed, so adjacent scenes
    // with near-identical visual_prompts don't all grab the same clip.
    // Videos and photos have separate id spaces in Pexels, so we track them
    // separately to avoid spurious "duplicate" hits.
    const videoUsedIds = new Set<string>();
    const photoUsedIds = new Set<string>();

    // Collect failure reasons so we can log an aggregated breakdown at the end.
    // On a 691-scene run the per-scene errors scroll out of the visible log
    // window — the summary makes the CAUSE visible even in a truncated view.
    const failureReasons: string[] = [];

    // Text overlays for the per-scene (legacy) path. No word timestamps here, so
    // hook scoping uses the running sum of per-scene duration hints.
    const overlayMode = (getSetting("TEXT_OVERLAY_MODE") || "hook").toLowerCase();
    const overlayByScene = new Map<number, OverlaySpec>();
    if (overlayMode !== "off") {
      const hookSec = Math.max(0, Number(getSetting("TEXT_OVERLAY_HOOK_SECONDS") || "30"));
      const MAX_OVERLAYS = 4;
      let accSec = 0;
      let count = 0;
      for (const scene of scenes) {
        const startSec = accSec;
        accSec += Math.max(1, scene.duration_hint_sec || 5);
        const text = (scene.overlay || "").trim();
        if (!text) continue;
        if (overlayMode === "hook" && startSec >= hookSec) continue;
        if (count >= MAX_OVERLAYS) break;
        overlayByScene.set(scene.index, { text, atSec: 0.3 });
        count++;
      }
    }

    const processScene = async (scene: Scene): Promise<SceneResult> => {
      try {
        checkCancelled(runId);
        const mode = photoScenes.has(scene.index) ? "photo" : "video";
        const [audio, asset] = await Promise.all([
          limitTts(() => synthesizeScene(runId, scene, audioDir)),
          limitAnim(() => animateScene(runId, scene, animDir, { mode, videoUsedIds, photoUsedIds })),
        ]);
        if (!asset) throw new Error(`Scene #${scene.index} produced no visual asset`);
        // Photo scenes use imagePath only (ken-burns). Video scenes set both
        // — videoPath drives the assembler; imagePath is a fallback thumb.
        return {
          scene,
          imagePath: asset.path,
          videoPath: asset.kind === "video" ? asset.path : null,
          audio,
          overlay: overlayByScene.get(scene.index),
        };
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        failureReasons.push(msg);
        log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 1500)}`, { stage: "pipeline" });
        return null;
      }
    };

    const settled = await Promise.allSettled(scenes.map((s) => processScene(s)));
    const sceneAssets: AssembleInput[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) sceneAssets.push(r.value);
    }

    logFailureBreakdown(runId, failureReasons);
    enforceFailureThreshold(runId, scenes.length, sceneAssets.length);
    if (sceneAssets.length === 0) {
      throw new Error(
        "No scenes succeeded — every scene failed. See the failure breakdown above for the cause " +
          "(most often: PEXELS_API_KEY missing/invalid, or all Pexels keys rate-limited)."
      );
    }

    checkCancelled(runId);
    const finalPath = await assembleVideo(runId, sceneAssets, runDir);
    updateRun.run("done", finalPath, runId);
    log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });

    // Best-effort Google Drive backup. The run is already marked "done" — a
    // failed upload must NOT fail the run, so swallow any error here. Only
    // runs when GDRIVE_SYNC_ENABLED === "1" (checked inside syncRunToDrive).
    try {
      await syncRunToDrive(runId, runDir, finalPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Drive sync failed (run is unaffected): ${msg}`, { stage: "gdrive" });
    }
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Single-shot voiceover flow
// ───────────────────────────────────────────────────────────────────────────

/** One planned sub-clip: which scene + sub-segment, its asset mode, and the
 *  [startMs,endMs] slice of the global voiceover it should cover. */
interface SubClipPlan {
  scene: Scene;
  mode: AssetMode;
  /** Unique output filename stem so sub-clips of the same scene don't collide. */
  fileStem: string;
  startMs: number;
  endMs: number;
  /** Optional hook-emphasis caption assigned to this sub-clip. */
  overlay?: OverlaySpec;
}

/**
 * Single-shot voiceover pipeline. Called from runPipeline after scene-split +
 * Pexels pre-flight. Synthesises ONE continuous voiceover, Whisper-aligns scene
 * boundaries, then fetches Pexels visuals timed to each (possibly split) range
 * and assembles silent clips muxed under the global audio.
 */
async function runSingleShot(
  runId: string,
  scenes: Scene[],
  runDir: string,
  audioDir: string,
  animDir: string
): Promise<void> {
  log(
    runId,
    "info",
    "Voice mode: single-shot — one continuous voiceover + Whisper word-alignment to scene boundaries",
    { stage: "pipeline" }
  );
  log(
    runId,
    "info",
    `Voice engine: ${resolveTtsProvider()} · voice ${getSetting("TTS_VOICE_ID") || "(not set)"}`,
    { stage: "tts" }
  );

  // 1. One continuous voiceover for the whole script + Whisper word-alignment.
  const globalAudio = await synthesizeAndAlign(runId, scenes, audioDir, {});
  checkCancelled(runId);

  // 2. Scene-mix decision: which scenes use a still photo (ken-burns) vs video.
  const photoRatio = Math.max(0, Math.min(100, Number(getSetting("SCENE_PHOTO_RATIO") || "40")));
  const mixMode = (getSetting("SCENE_MIX_MODE") || "random") as "random" | "alternating";
  const photoScenes = pickPhotoScenes(scenes, photoRatio, mixMode);

  const maxClipSec = Math.max(0, Number(getSetting("MAX_CLIP_SECONDS") || "7"));
  const minSceneMs = Math.max(0, Number(getSetting("MIN_SCENE_SECONDS") || "3")) * 1000;
  const rangeByScene = new Map<number, SceneAudioRange>();
  for (const r of globalAudio.ranges) rangeByScene.set(r.sceneIdx, r);

  // 3. MERGE adjacent scenes into "segments" so each visual stays on screen at
  //    least MIN_SCENE_SECONDS. This stops the picture flipping every 1-2s AND
  //    absorbs stray micro-scenes (e.g. a lone "candy.") into a neighbour — the
  //    segment keeps the FIRST scene's footage for the whole merged span, so a
  //    one-word off-topic scene never gets its own literal clip.
  type Segment = { scene: Scene; startMs: number; endMs: number };
  const segments: Segment[] = [];
  for (const scene of scenes) {
    const range = rangeByScene.get(scene.index) ?? { sceneIdx: scene.index, startMs: 0, endMs: 0 };
    const prev = segments[segments.length - 1];
    if (prev && prev.endMs - prev.startMs < minSceneMs) {
      prev.endMs = range.endMs; // previous segment still too short → extend it, keep its visual
    } else {
      segments.push({ scene, startMs: range.startMs, endMs: range.endMs });
    }
  }
  // Fold a too-short FINAL segment back into the previous one.
  if (segments.length >= 2) {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg.endMs - lastSeg.startMs < minSceneMs) {
      segments[segments.length - 2].endMs = lastSeg.endMs;
      segments.pop();
    }
  }
  const mergedAway = scenes.length - segments.length;

  // 4. Build the sub-clip plan from segments. A segment longer than
  //    MAX_CLIP_SECONDS is split into equal sub-clips, each getting its OWN
  //    Pexels asset, so a long segment still keeps the picture moving.
  const plans: SubClipPlan[] = [];
  for (const seg of segments) {
    const scene = seg.scene;
    const mode: AssetMode = photoScenes.has(scene.index) ? "photo" : "video";
    const sliceMs = Math.max(0, seg.endMs - seg.startMs);
    const sliceSec = sliceMs / 1000;
    const segCount = maxClipSec > 0 && sliceSec > maxClipSec ? Math.ceil(sliceSec / maxClipSec) : 1;
    const padded = String(scene.index).padStart(3, "0");

    if (segCount <= 1) {
      plans.push({ scene, mode, fileStem: `scene_${padded}`, startMs: seg.startMs, endMs: seg.endMs });
    } else {
      const segLen = sliceMs / segCount;
      for (let k = 0; k < segCount; k++) {
        const subStart = Math.round(seg.startMs + k * segLen);
        const subEnd = k === segCount - 1 ? seg.endMs : Math.round(seg.startMs + (k + 1) * segLen);
        // First sub-clip keeps the canonical `scene_NNN` stem so the Drive backup
        // still finds a representative asset. Later sub-clips get a _sub_NN suffix.
        const fileStem = k === 0 ? `scene_${padded}` : `scene_${padded}_sub_${String(k + 1).padStart(2, "0")}`;
        plans.push({ scene, mode, fileStem, startMs: subStart, endMs: subEnd });
      }
    }
  }

  const splitScenes = new Set(plans.filter((p) => p.fileStem.includes("_sub_")).map((p) => p.scene.index)).size;
  log(
    runId,
    "info",
    `${scenes.length} scenes → ${segments.length} visual segments (≥${minSceneMs / 1000}s each` +
      (mergedAway > 0 ? `, ${mergedAway} short scene(s) merged` : "") +
      `) → ${plans.length} Pexels clip(s)` +
      (splitScenes > 0 ? ` (${splitScenes} long segment(s) split, ${maxClipSec}s max each)` : "") +
      ` · ${photoScenes.size} photo / ${scenes.length - photoScenes.size} video`,
    { stage: "pipeline" }
  );

  // 4b. Text overlays (hook emphasis). Attach a fading caption to the sub-clip
  //     whose time range covers each qualifying scene's spoken token. Scoped to
  //     the first N seconds by default ("hook") — captions everywhere gets noisy.
  assignTextOverlays(runId, scenes, plans, rangeByScene);

  // 5. Fetch every sub-clip's Pexels asset, concurrency-limited, sharing the
  //    dedup id sets so adjacent sub-clips don't all grab the same footage.
  const animConc = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "5"));
  const limitAnim = pLimit(animConc);
  const videoUsedIds = new Set<string>();
  const photoUsedIds = new Set<string>();
  const failureReasons: string[] = [];

  const settled = await Promise.all(
    plans.map((plan) =>
      limitAnim(async (): Promise<SingleShotInput | null> => {
        try {
          checkCancelled(runId);
          const asset = await animateScene(runId, plan.scene, animDir, {
            mode: plan.mode,
            videoUsedIds,
            photoUsedIds,
            fileStem: plan.fileStem,
          });
          if (!asset) throw new Error(`Scene #${plan.scene.index} produced no visual asset`);
          return {
            scene: plan.scene,
            assetPath: asset.path,
            kind: asset.kind,
            startMs: plan.startMs,
            endMs: plan.endMs,
            overlay: plan.overlay,
          };
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          failureReasons.push(msg);
          log(runId, "error", `Scene #${plan.scene.index} (${plan.fileStem}) failed: ${msg.slice(0, 1500)}`, {
            stage: "pipeline",
          });
          return null;
        }
      })
    )
  );

  // 5. Drop failed sub-clips; abort if too many overall failed. Preserve order
  //    by the original plan sequence (scene index, then sub-clip).
  const inputs: SingleShotInput[] = [];
  for (const r of settled) {
    if (r !== null) inputs.push(r);
  }

  logFailureBreakdown(runId, failureReasons);
  enforceFailureThreshold(runId, plans.length, inputs.length);
  if (inputs.length === 0) {
    throw new Error(
      "No scenes succeeded — every Pexels fetch failed. See the failure breakdown above for the cause " +
        "(most often: PEXELS_API_KEY missing/invalid, or all Pexels keys rate-limited)."
    );
  }

  // 6. Assemble: silent clips concatenated, global voiceover muxed on top.
  checkCancelled(runId);
  const finalPath = await assembleSingleShot(runId, inputs, globalAudio.filePath, runDir);
  updateRun.run("done", finalPath, runId);
  log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });

  // 7. Best-effort Google Drive backup (same as the per-scene path).
  try {
    await syncRunToDrive(runId, runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Drive sync failed (run is unaffected): ${msg}`, { stage: "gdrive" });
  }
}

/**
 * Attaches hook-emphasis text overlays to sub-clip plans (single-shot path).
 *
 * For each scene carrying an `overlay` token (a striking number / year / place)
 * that qualifies for the configured scope — whole video, or by default only the
 * opening TEXT_OVERLAY_HOOK_SECONDS — the caption is bound to the sub-clip whose
 * [startMs,endMs] range covers the MIDPOINT of that scene's spoken audio. The
 * total is capped so the hook never gets cluttered.
 */
function assignTextOverlays(
  runId: string,
  scenes: Scene[],
  plans: SubClipPlan[],
  rangeByScene: Map<number, SceneAudioRange>
): void {
  const mode = (getSetting("TEXT_OVERLAY_MODE") || "hook").toLowerCase();
  if (mode === "off") return;
  const hookMs = Math.max(0, Number(getSetting("TEXT_OVERLAY_HOOK_SECONDS") || "30")) * 1000;
  const MAX_OVERLAYS = 4;

  const candidates: { text: string; atMs: number }[] = [];
  for (const scene of scenes) {
    const text = (scene.overlay || "").trim();
    if (!text) continue;
    const range = rangeByScene.get(scene.index);
    if (!range) continue;
    // Use the token's actual spoken time (from Whisper word-alignment); fall
    // back to the scene midpoint only if alignment couldn't place it.
    const atMs = range.overlayAtMs ?? (range.startMs + range.endMs) / 2;
    if (mode === "hook" && atMs >= hookMs) continue;
    candidates.push({ text, atMs });
  }
  candidates.sort((a, b) => a.atMs - b.atMs);
  const chosen = candidates.slice(0, MAX_OVERLAYS);

  const applied: string[] = [];
  for (const ov of chosen) {
    const plan =
      plans.find((p) => ov.atMs >= p.startMs && ov.atMs < p.endMs) ??
      plans.find((p) => ov.atMs >= p.startMs && ov.atMs <= p.endMs);
    if (plan && !plan.overlay) {
      // Lead-in: start slightly BEFORE the word so the (now near-instant) pop is
      // fully up by the word's first sound — Whisper marks word starts a touch
      // late, so this compensates and makes it feel exactly on the number.
      plan.overlay = { text: ov.text, atSec: Math.max(0, (ov.atMs - plan.startMs) / 1000 - 0.15) };
      applied.push(ov.text);
    }
  }
  if (applied.length > 0) {
    log(
      runId,
      "info",
      `Text overlays: ${applied.length} caption(s) in ${mode === "hook" ? "the hook" : "the whole video"} — ${applied.join(", ")}`,
      { stage: "assemble" }
    );
  }
}

/**
 * Normalizes an error message into a category so similar failures group
 * together: strips scene-specific bits (quoted queries, ids, numbers) so
 * "Pexels returned 0 videos for: \"a man walking\"" and "...\"a dog running\""
 * collapse into one bucket.
 */
function normalizeReason(msg: string): string {
  return msg
    .replace(/"[^"]*"/g, '"…"')          // quoted queries → "…"
    .replace(/scene #?\d+/gi, "scene #N") // scene numbers
    .replace(/\b[0-9a-f]{6,}\b/gi, "ID")  // hex ids / task ids
    .replace(/\d+/g, "N")                  // remaining numbers
    .trim()
    .slice(0, 100);
}

/**
 * Logs an aggregated breakdown of WHY scenes failed. Critical for long runs:
 * the per-scene errors scroll out of the 500-line live window, so without this
 * summary the user (and we) can't see the cause. Shows the top reasons + counts.
 */
function logFailureBreakdown(runId: string, reasons: string[]): void {
  if (reasons.length === 0) return;

  const counts = new Map<string, number>();
  for (const r of reasons) {
    const key = normalizeReason(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  log(runId, "error", `Failure breakdown — ${reasons.length} scene-failure(s), top causes:`, {
    stage: "pipeline",
  });
  for (const [reason, count] of sorted.slice(0, 6)) {
    log(runId, "error", `   ${count}× ${reason}`, { stage: "pipeline" });
  }
}

/**
 * Logs the failure tally and throws if the failure rate is over the
 * user-configured threshold.
 */
function enforceFailureThreshold(runId: string, totalScenes: number, succeeded: number): void {
  const failedCount = totalScenes - succeeded;
  if (failedCount <= 0) return;
  const failedPct = (failedCount / totalScenes) * 100;
  const threshold = Math.max(
    0,
    Math.min(100, Number(getSetting("FAILURE_THRESHOLD_PERCENT") || "25"))
  );
  const over = failedPct > threshold;
  log(
    runId,
    over ? "error" : "warn",
    `${failedCount}/${totalScenes} scenes failed (${failedPct.toFixed(0)}%) · abort threshold ${threshold}%`,
    { stage: "pipeline" }
  );
  if (over) {
    throw new Error(
      `Too many scenes failed: ${failedCount}/${totalScenes} (${failedPct.toFixed(0)}% over the ${threshold}% threshold).`
    );
  }
}
