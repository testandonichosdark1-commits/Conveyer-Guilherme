import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeScene, resolveTtsProvider } from "./services/tts";
import { synthesizeAndAlign, type SceneAudioRange, type TranscriptWord } from "./services/tts-align";
import { animateScene, pickPhotoScenes, type AssetMode } from "./services/img2vid";
import { pexelsPreflight, extractAnchorWords, logRunStats } from "./services/stock-footage";
import {
  assembleVideo,
  assembleSingleShot,
  type AssembleInput,
  type SingleShotInput,
  type OverlaySpec,
  type StepOverlaySpec,
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
        if (!isExplicitMatch(runId, text, scene.text)) continue;
        if (overlayMode === "hook" && startSec >= hookSec) continue;
        if (count >= MAX_OVERLAYS) break;
        overlayByScene.set(scene.index, { text, atSec: 0.3, duration: 1.4 });
        count++;
      }
    }

    const videoContext = buildVideoContext(scenes);
    const anchorWords = extractAnchorWords(script);

    const processScene = async (scene: Scene): Promise<SceneResult> => {
      try {
        checkCancelled(runId);
        const mode = photoScenes.has(scene.index) ? "photo" : "video";
        const [audio, asset] = await Promise.all([
          limitTts(() => synthesizeScene(runId, scene, audioDir)),
          limitAnim(() => animateScene(runId, scene, animDir, { mode, videoUsedIds, photoUsedIds, videoContext, anchorWords })),
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
          dedupeId: asset.dedupeId,
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

    // --- Post-concurrency correction for adjacent duplicates ---
    for (let i = 1; i < sceneAssets.length; i++) {
      const prevAsset = sceneAssets[i - 1];
      const curAsset = sceneAssets[i];
      if (prevAsset.dedupeId && curAsset.dedupeId && prevAsset.dedupeId === curAsset.dedupeId) {
        log(runId, "warn", `Adjacent duplicate detected: ${curAsset.dedupeId} on scene #${curAsset.scene.index}. Re-running search to avoid it.`, { stage: "animate" });
        const mode = photoScenes.has(curAsset.scene.index) ? "photo" : "video";
        const avoid = new Set<string>([prevAsset.dedupeId]);
        const asset = await animateScene(runId, curAsset.scene, animDir, {
          mode,
          videoUsedIds,
          photoUsedIds,
          avoidDedupeIds: avoid,
          videoContext,
          anchorWords
        });
        if (asset) {
          curAsset.imagePath = asset.path;
          curAsset.videoPath = asset.kind === "video" ? asset.path : null;
          curAsset.dedupeId = asset.dedupeId;
        }
      }
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
    logRunStats(runId);
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
  /** Optional step overlay. */
  stepOverlay?: StepOverlaySpec;

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

  // 4b. Step overlays detection and timing
  detectAndAssignStepOverlays(runId, scenes, plans, rangeByScene, globalAudio.transcript);

  // 4c. Text overlays (hook emphasis). Attach a fading caption to the sub-clip

  //     whose time range covers each qualifying scene's spoken token. Scoped to
  //     the first N seconds by default ("hook") — captions everywhere gets noisy.
  assignTextOverlays(runId, scenes, plans, rangeByScene, globalAudio.transcript);

  const videoContext = buildVideoContext(scenes);
  const anchorWords = extractAnchorWords(scenes.map((s) => s.text).join(" "));

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
            videoContext,
            anchorWords,
          });
          if (!asset) throw new Error(`Scene #${plan.scene.index} produced no visual asset`);
          return {
            scene: plan.scene,
            assetPath: asset.path,
            kind: asset.kind,
            startMs: plan.startMs,
            endMs: plan.endMs,
            overlay: plan.overlay,
            stepOverlay: plan.stepOverlay,
            fileStem: plan.fileStem,
            dedupeId: asset.dedupeId,
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

  // --- Post-concurrency correction for adjacent duplicates ---
  for (let i = 1; i < inputs.length; i++) {
    const prevInput = inputs[i - 1];
    const curInput = inputs[i];
    if (prevInput.dedupeId && curInput.dedupeId && prevInput.dedupeId === curInput.dedupeId) {
      log(runId, "warn", `Adjacent duplicate detected: ${curInput.dedupeId} on subclip ${curInput.fileStem} (scene #${curInput.scene.index}). Re-running search to avoid it.`, { stage: "animate" });
      const avoid = new Set<string>([prevInput.dedupeId]);
      const asset = await animateScene(runId, curInput.scene, animDir, {
        mode: curInput.kind,
        videoUsedIds,
        photoUsedIds,
        fileStem: curInput.fileStem,
        avoidDedupeIds: avoid,
        videoContext,
        anchorWords
      });
      if (asset) {
        curInput.assetPath = asset.path;
        curInput.kind = asset.kind;
        curInput.dedupeId = asset.dedupeId;
      }
    }
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
  logRunStats(runId);
  log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });

  // 7. Best-effort Google Drive backup (same as the per-scene path).
  try {
    await syncRunToDrive(runId, runDir, finalPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "error", `Drive sync failed (run is unaffected): ${msg}`, { stage: "gdrive" });
  }
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", 
              "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10 === 0 ? "" : "-" + ONES[n % 10];
    return tens + ones;
  }
  if (n < 1000) {
    const hundred = ONES[Math.floor(n / 100)] + " hundred";
    const rest = n % 100 === 0 ? "" : " " + numToWords(n % 100);
    return hundred + rest;
  }
  if (n >= 1000 && n < 3000) {
    const firstPart = Math.floor(n / 100);
    const secondPart = n % 100;
    const word1 = numToWords(firstPart);
    const word2 = secondPart === 0 ? "hundred" : numToWords(secondPart);
    return `${word1} ${word2}`;
  }
  return String(n);
}

function isExplicitMatch(runId: string, overlay: string, text: string): boolean {
  const normText = text.toLowerCase();
  const normOverlay = overlay.toLowerCase();

  // 1. Specific forbidden conversions for logging
  if (normText.includes("half") && normOverlay.includes("50")) {
    if (!normText.includes("50") && !normText.includes("fifty")) {
      log(runId, "info", `Caption candidate skipped: inferred fraction "half" should not become "50%"`, { stage: "assemble" });
      return false;
    }
  }
  if (normText.includes("quarter") && normOverlay.includes("25")) {
    if (!normText.includes("25") && !normText.includes("twenty-five") && !normText.includes("twenty five")) {
      log(runId, "info", `Caption candidate skipped: inferred fraction "quarter" should not become "25%"`, { stage: "assemble" });
      return false;
    }
  }
  if (normText.includes("most") && normOverlay.includes("80")) {
    if (!normText.includes("80") && !normText.includes("eighty")) {
      log(runId, "info", `Caption candidate skipped: inferred fraction "most" should not become "80%"`, { stage: "assemble" });
      return false;
    }
  }
  if (normText.includes("a few") && normOverlay.includes("3")) {
    if (!normText.includes("3") && !normText.includes("three")) {
      log(runId, "info", `Caption candidate skipped: inferred fraction "a few" should not become "3"`, { stage: "assemble" });
      return false;
    }
  }
  if (normText.includes("dozens") && normOverlay.includes("24")) {
    if (!normText.includes("24") && !normText.includes("twenty-four") && !normText.includes("twenty four")) {
      log(runId, "info", `Caption candidate skipped: inferred fraction "dozens" should not become "24"`, { stage: "assemble" });
      return false;
    }
  }
  if (normText.includes("several")) {
    const digits = normOverlay.match(/\d+/g) || [];
    if (digits.length > 0) {
      let explicit = false;
      for (const d of digits) {
        if (normText.includes(d) || normText.includes(numToWords(parseInt(d, 10)))) {
          explicit = true;
        }
      }
      if (!explicit) {
        log(runId, "info", `Caption candidate skipped: inferred fraction "several" should not become "${overlay}"`, { stage: "assemble" });
        return false;
      }
    }
  }

  // 2. Extract digits and check if they are explicitly mentioned
  const overlayDigits = normOverlay.match(/\d+/g) || [];
  for (const digitStr of overlayDigits) {
    const num = parseInt(digitStr, 10);
    const wordRep = numToWords(num);
    const wordTokens = wordRep.replace(/-/g, " ").split(/\s+/);

    const hasDigits = normText.includes(digitStr);
    const hasWords = wordTokens.every(token => normText.includes(token));

    if (!hasDigits && !hasWords) {
      log(runId, "info", `Caption candidate skipped: inferred number for "${overlay}" is not explicit in text`, { stage: "assemble" });
      return false;
    }
  }

  // 3. Check explicit percent indicator
  if (normOverlay.includes("%") || normOverlay.includes("percent")) {
    if (!normText.includes("%") && !normText.includes("percent") && !normText.includes("percentage")) {
      log(runId, "info", `Caption candidate skipped: percent indicator in "${overlay}" is not explicit in text`, { stage: "assemble" });
      return false;
    }
  }

  // 4. Check explicit money indicator
  if (normOverlay.includes("$") || normOverlay.includes("dollar")) {
    if (!normText.includes("$") && !normText.includes("dollar") && !normText.includes("bucks")) {
      log(runId, "info", `Caption candidate skipped: currency indicator in "${overlay}" is not explicit in text`, { stage: "assemble" });
      return false;
    }
  }

  // 5. Check units
  const units = ["day", "minute", "hour", "week", "month", "year", "cup", "gallon", "percent", "dollar", "euro"];
  for (const unit of units) {
    if (normOverlay.includes(unit)) {
      if (!normText.includes(unit) && !normText.includes(unit + "s")) {
        log(runId, "info", `Caption candidate skipped: unit "${unit}" in "${overlay}" is not explicit in text`, { stage: "assemble" });
        return false;
      }
    }
  }

  // 6. Generic check for non-numeric overlays
  if (overlayDigits.length === 0) {
    if (!normText.includes(normOverlay)) {
      log(runId, "info", `Caption candidate skipped: "${overlay}" is not explicitly mentioned in text`, { stage: "assemble" });
      return false;
    }
  }

  return true;
}

function findMatchInTranscript(overlay: string, words: TranscriptWord[]): { startMs: number; endMs: number } | null {
  const normOverlay = overlay.toLowerCase();
  const overlayWords = normOverlay.replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean);
  if (overlayWords.length === 0) return null;

  for (let i = 0; i < words.length; i++) {
    let matchLen = 0;
    let overlayIdx = 0;

    while (overlayIdx < overlayWords.length && (i + matchLen) < words.length) {
      const oWord = overlayWords[overlayIdx];
      const tWord = words[i + matchLen].word.toLowerCase().replace(/[^a-z0-9]/g, "");

      if (oWord === tWord) {
        matchLen++;
        overlayIdx++;
        continue;
      }

      const oNum = parseInt(oWord, 10);
      if (!isNaN(oNum)) {
        const wordRep = numToWords(oNum).replace(/-/g, " ").split(/\s+/);
        let wordsMatched = true;
        for (let k = 0; k < wordRep.length; k++) {
          if (i + matchLen + k >= words.length) {
            wordsMatched = false;
            break;
          }
          const nextTWord = words[i + matchLen + k].word.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (nextTWord !== wordRep[k]) {
            wordsMatched = false;
            break;
          }
        }
        if (wordsMatched) {
          matchLen += wordRep.length;
          overlayIdx++;
          continue;
        }
      }

      break;
    }

    if (overlayIdx === overlayWords.length) {
      const startMs = words[i].startMs;
      const endMs = words[i + matchLen - 1].endMs;
      return { startMs, endMs };
    }
  }

  // Fallback for single-word digit / word representations in transcript
  const digits = normOverlay.match(/\d+/g);
  if (digits && digits.length > 0) {
    const targetDigit = digits[0];
    const targetNum = parseInt(targetDigit, 10);
    const targetWord = numToWords(targetNum);

    for (let i = 0; i < words.length; i++) {
      const tWordNorm = words[i].word.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (tWordNorm === targetDigit || tWordNorm === targetWord) {
        return { startMs: words[i].startMs, endMs: words[i].endMs };
      }
    }
  }

  return null;
}

function normalizeStepNumber(str: string): string {
  const map: Record<string, string> = {
    one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9", ten: "10"
  };
  const val = str.toLowerCase();
  return map[val] || str.toUpperCase();
}

function formatStepTitle(title: string): string {
  let clean = title.replace(/\band\b/gi, "&");
  clean = clean.replace(/\byour\b/gi, "");
  clean = clean.replace(/\s+/g, " ").trim();
  return clean;
}

function toTitleCase(str: string): string {
  return str
    .split(" ")
    .map(word => {
      if (word === "&") return "&";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeWordForStep(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stepWordsMatch(w1: string, w2: string): boolean {
  const n1 = normalizeWordForStep(w1);
  const n2 = normalizeWordForStep(w2);
  if (n1 === n2) return true;

  const numbers = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const numIdx1 = numbers.indexOf(n1);
  const numIdx2 = numbers.indexOf(n2);
  if (numIdx1 >= 0 && (n2 === String(numIdx1) || n2 === numbers[numIdx1])) return true;
  if (numIdx2 >= 0 && (n1 === String(numIdx2) || n1 === numbers[numIdx2])) return true;

  return false;
}

function findStepOverlayRange(
  stepNumWord: string,
  title: string,
  transcriptWords: TranscriptWord[]
): { startMs: number; endMs: number } | null {
  const normStepNum = normalizeWordForStep(stepNumWord);
  const titleWords = title.split(/\s+/).map(normalizeWordForStep).filter(Boolean);
  if (titleWords.length === 0) return null;

  const stopWords = new Set(["and", "or", "but", "the", "a", "an", "your", "my", "our", "their", "his", "her", "its", "of", "to", "in", "on", "at", "for", "with", "by", "is", "are", "was", "were", "be", "been", "have", "has", "had", "do", "does", "did", "this", "that", "these", "those"]);
  const mainTitleWords = titleWords.filter(w => !stopWords.has(w));
  if (mainTitleWords.length === 0) {
    mainTitleWords.push(...titleWords);
  }

  // 1. Try exact/sequential match: "step" + stepNumWord + titleWords
  for (let i = 0; i <= transcriptWords.length - 2; i++) {
    if (!stepWordsMatch(transcriptWords[i].word, "step")) continue;

    let stepNumIdx = -1;
    if (stepWordsMatch(transcriptWords[i + 1]?.word, normStepNum)) {
      stepNumIdx = i + 1;
    } else if (stepWordsMatch(transcriptWords[i + 2]?.word, normStepNum)) {
      stepNumIdx = i + 2;
    }

    if (stepNumIdx === -1) continue;

    let currentTransIdx = stepNumIdx + 1;
    let matchedCount = 0;
    let lastMatchedIdx = stepNumIdx;

    for (const targetW of titleWords) {
      let found = false;
      for (let offset = 0; offset < 4; offset++) {
        const checkIdx = currentTransIdx + offset;
        if (checkIdx >= transcriptWords.length) break;
        if (stepWordsMatch(transcriptWords[checkIdx].word, targetW)) {
          currentTransIdx = checkIdx + 1;
          matchedCount++;
          lastMatchedIdx = checkIdx;
          found = true;
          break;
        }
      }
    }

    const exactThreshold = Math.max(1, titleWords.length - 1);
    if (matchedCount >= exactThreshold) {
      return {
        startMs: transcriptWords[i].startMs,
        endMs: transcriptWords[lastMatchedIdx].endMs
      };
    }
  }

  // 2. Fallback: match "step" + stepNumWord, and main title words within 20 words
  for (let i = 0; i <= transcriptWords.length - 2; i++) {
    if (!stepWordsMatch(transcriptWords[i].word, "step")) continue;

    let stepNumIdx = -1;
    if (stepWordsMatch(transcriptWords[i + 1]?.word, normStepNum)) {
      stepNumIdx = i + 1;
    } else if (stepWordsMatch(transcriptWords[i + 2]?.word, normStepNum)) {
      stepNumIdx = i + 2;
    }

    if (stepNumIdx === -1) continue;

    let lastMatchedIdx = stepNumIdx;
    let matchedMainCount = 0;
    const searchLimit = Math.min(transcriptWords.length, stepNumIdx + 20);

    for (let checkIdx = stepNumIdx + 1; checkIdx < searchLimit; checkIdx++) {
      const tWord = normalizeWordForStep(transcriptWords[checkIdx].word);
      if (mainTitleWords.some(mw => stepWordsMatch(tWord, mw))) {
        matchedMainCount++;
        lastMatchedIdx = checkIdx;
      }
    }

    const requiredMain = Math.max(1, Math.ceil(mainTitleWords.length * 0.5));
    if (matchedMainCount >= requiredMain) {
      return {
        startMs: transcriptWords[i].startMs,
        endMs: transcriptWords[lastMatchedIdx].endMs
      };
    }
  }

  return null;
}

function detectAndAssignStepOverlays(
  runId: string,
  scenes: Scene[],
  plans: SubClipPlan[],
  rangeByScene: Map<number, SceneAudioRange>,
  transcript?: TranscriptWord[]
): void {
  if (!transcript) {
    for (const scene of scenes) {
      const stepMatch = scene.text.match(/^\s*Step\s+(\w+)\s*:\s*([^.!?]+)/i);
      if (stepMatch) {
        const normStepNum = normalizeStepNumber(stepMatch[1]);
        log(runId, "warn", `Step overlay skipped: no reliable Whisper timestamp match for STEP ${normStepNum}`, { stage: "assemble" });
      }
    }
    return;
  }

  for (const scene of scenes) {
    const stepMatch = scene.text.match(/^\s*Step\s+(\w+)\s*:\s*([^.!?]+)/i);
    if (!stepMatch) continue;

    const stepNumWord = stepMatch[1];
    const rawTitle = stepMatch[2].trim();
    const normStepNum = normalizeStepNumber(stepNumWord);
    const cleanTitle = formatStepTitle(rawTitle);
    const logTitle = toTitleCase(cleanTitle);

    log(runId, "info", `Step overlay detected: STEP ${normStepNum} — ${logTitle}`, { stage: "assemble" });

    const range = rangeByScene.get(scene.index);
    if (!range) {
      log(runId, "warn", `Step overlay skipped: no audio range found for scene #${scene.index}`, { stage: "assemble" });
      continue;
    }

    // Scope the transcript search to this scene's audio range (with 2 seconds padding)
    const sceneWords = transcript.filter(
      (w) => w.startMs >= range.startMs - 2000 && w.endMs <= range.endMs + 2000
    );

    const matchRange = findStepOverlayRange(stepNumWord, rawTitle, sceneWords);
    if (!matchRange) {
      log(runId, "warn", `Step overlay skipped: no reliable Whisper timestamp match for STEP ${normStepNum}`, { stage: "assemble" });
      continue;
    }

    // Calculate start/end timestamps and duration
    const trailSec = parseFloat(getSetting("STEP_OVERLAY_TRAIL_SEC") || "1.0");
    const matchedStartMs = matchRange.startMs;
    const matchedEndMs = matchRange.endMs;

    let durationSec = ((matchedEndMs - matchedStartMs) / 1000) + trailSec;
    durationSec = Math.max(1.5, Math.min(6.0, durationSec));

    const finalEndMs = matchedStartMs + durationSec * 1000;

    log(runId, "info", `Step overlay timed: STEP ${normStepNum} start=${(matchedStartMs/1000).toFixed(2)}s end=${(finalEndMs/1000).toFixed(2)}s trail=${trailSec.toFixed(1)}s`, { stage: "assemble" });
    log(runId, "info", `Step overlay animation: ${getSetting("STEP_OVERLAY_ANIMATION") || "slide-up"}`, { stage: "assemble" });

    const plan =
      plans.find((p) => matchedStartMs >= p.startMs && matchedStartMs < p.endMs) ??
      plans.find((p) => matchedStartMs >= p.startMs && matchedStartMs <= p.endMs);

    if (plan) {
      plan.stepOverlay = {
        stepNum: normStepNum,
        title: cleanTitle.toUpperCase(),
        rawTitle,
        startMs: matchedStartMs,
        endMs: finalEndMs,
        atSec: Math.max(0, (matchedStartMs - plan.startMs) / 1000),
        duration: durationSec,
      };
    } else {
      log(runId, "warn", `Step overlay skipped: no sub-clip plan covers start time ${(matchedStartMs/1000).toFixed(2)}s`, { stage: "assemble" });
    }
  }
}


/**
 * Attaches hook-emphasis text overlays to sub-clip plans (single-shot path).
 */
function assignTextOverlays(
  runId: string,
  scenes: Scene[],
  plans: SubClipPlan[],
  rangeByScene: Map<number, SceneAudioRange>,
  transcript?: TranscriptWord[]
): void {
  const mode = (getSetting("TEXT_OVERLAY_MODE") || "hook").toLowerCase();
  const detectionMode = (getSetting("CAPTION_DETECTION_MODE") || "literal").toLowerCase();

  if (mode === "off" || detectionMode === "off") return;
  const hookMs = Math.max(0, Number(getSetting("TEXT_OVERLAY_HOOK_SECONDS") || "30")) * 1000;
  const MAX_OVERLAYS = 4;

  const stepOverlayRanges: { startMs: number; endMs: number }[] = [];
  for (const plan of plans) {
    if (plan.stepOverlay && plan.stepOverlay.startMs !== undefined && plan.stepOverlay.endMs !== undefined) {
      stepOverlayRanges.push({
        startMs: plan.stepOverlay.startMs,
        endMs: plan.stepOverlay.endMs
      });
    }
  }

  const candidates: { text: string; atMs: number; endMs: number }[] = [];
  for (const scene of scenes) {
    const text = (scene.overlay || "").trim();
    if (!text) continue;

    // Validate that the overlay is explicitly matching the scene text
    if (!isExplicitMatch(runId, text, scene.text)) {
      continue;
    }

    const range = rangeByScene.get(scene.index);
    if (!range) continue;

    let exactTime: { startMs: number; endMs: number } | null = null;
    if (transcript) {
      const sceneWords = transcript.filter(
        (w) => w.startMs >= range.startMs - 1000 && w.endMs <= range.endMs + 1000
      );
      exactTime = findMatchInTranscript(text, sceneWords);
    }

    if (!exactTime) {
      log(runId, "info", `Caption skipped: no exact Whisper timestamp match`, { stage: "assemble" });
      continue;
    }

    const atMs = exactTime.startMs;
    const endMs = exactTime.endMs;

    if (mode === "hook" && atMs >= hookMs) continue;

    const overlapsStep = stepOverlayRanges.some(
      (sr) => atMs < sr.endMs && endMs > sr.startMs
    );
    if (overlapsStep) {
      log(runId, "info", `Caption candidate "${text}" skipped: overlaps with active step overlay range`, { stage: "assemble" });
      continue;
    }

    log(runId, "info", `Caption timed from Whisper words: "${text}" at ${(atMs / 1000).toFixed(2)}s`, { stage: "assemble" });
    candidates.push({ text, atMs, endMs });
  }

  candidates.sort((a, b) => a.atMs - b.atMs);
  const chosen = candidates.slice(0, MAX_OVERLAYS);

  const applied: string[] = [];
  for (const ov of chosen) {
    const plan =
      plans.find((p) => ov.atMs >= p.startMs && ov.atMs < p.endMs) ??
      plans.find((p) => ov.atMs >= p.startMs && ov.atMs <= p.endMs);
    if (plan && !plan.overlay) {
      const leadIn = Math.min(0.1, Math.max(0, parseFloat(getSetting("CAPTION_LEAD_IN_SEC") || "0")));
      const wordDuration = (ov.endMs - ov.atMs) / 1000;
      const trail = parseFloat(getSetting("CAPTION_TRAIL_SEC") || "0.35");
      let dur = wordDuration + trail;
      dur = Math.max(0.8, Math.min(1.4, dur));

      plan.overlay = {
        text: ov.text,
        atSec: Math.max(0, (ov.atMs - plan.startMs) / 1000 - leadIn),
        duration: dur,
      };
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
 * A one-line summary of the WHOLE video, passed to the vision relevance scorer
 * so footage is judged against the overall context (not just the single moment).
 * Uses the manual VIDEO_CONTEXT hint if set, else the script's opening words
 * (intros reliably establish the topic/setting).
 */
function buildVideoContext(scenes: Scene[]): string {
  const manual = (getSetting("VIDEO_CONTEXT") || "").trim();
  if (manual) return manual.slice(0, 300);
  const full = scenes.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return full.split(/\s+/).slice(0, 60).join(" ");
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
