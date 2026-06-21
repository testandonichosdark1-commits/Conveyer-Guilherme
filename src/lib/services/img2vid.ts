import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import {
  acquireStockClipForScene,
  acquireStockPhotoForScene,
  type Orientation,
} from "./stock-footage";

/**
 * Acquires the visual asset for one scene from Pexels — EITHER a stock video
 * clip OR a still photo (which becomes a ken-burns clip during assembly).
 *
 * Mix is controlled by `mode` (caller decides per scene). The choice itself
 * lives in `pickPhotoScenes()` below — called once per run by the pipeline.
 */
export type AssetMode = "video" | "photo";

export interface AnimateResult {
  /** Disk path of the downloaded asset (mp4 for video, jpg for photo). */
  path: string;
  /** Whether the path is a moving clip or a still image. */
  kind: AssetMode;
  /** Unique identifier of the stock asset. */
  dedupeId?: string;
}

export interface AnimateOptions {
  /** Mutable set of VIDEO asset ids ("source:id") already used in this run. */
  videoUsedIds?: Set<string>;
  /** Mutable set of PHOTO asset ids ("source:id") already used in this run. */
  photoUsedIds?: Set<string>;
  /** Set of asset ids to avoid for adjacent duplicates. */
  avoidDedupeIds?: Set<string>;
  /** Which kind of asset to fetch for this scene. Default "video". */
  mode?: AssetMode;
  /**
   * Override the output filename stem (without extension). Defaults to
   * `scene_NNN`. Single-shot mode passes e.g. `scene_007_sub_01` so a scene
   * split into several timed sub-clips writes a distinct file per sub-clip
   * instead of overwriting `scene_007`.
   */
  fileStem?: string;
  /** One-line summary of the WHOLE video, passed to the vision relevance scorer
   *  so footage is judged against the overall context, not just this moment. */
  videoContext?: string;
  anchorWords?: string[];
  /** Force stricter topic/world anchoring for opening-hook scenes. */
  openingTopicLock?: boolean;
}

const OPENING_TOPIC_LOCK_SECONDS = 30;

function isLikelyOpeningScene(scene: Scene): boolean {
  // Approximate opening position without changing the pipeline API. The pipeline
  // assigns zero-based scene indices and duration hints; for single-shot mode this
  // is close enough to catch the first hook scenes, where generic B-roll errors
  // are most common.
  const hintSec = Math.max(1, Number(scene.duration_hint_sec || 5));
  return scene.index * hintSec < OPENING_TOPIC_LOCK_SECONDS;
}

export async function animateScene(
  runId: string,
  scene: Scene,
  outDir: string,
  options: AnimateOptions = {}
): Promise<AnimateResult | null> {
  const mode: AssetMode = options.mode ?? "video";
  const openingTopicLock = options.openingTopicLock ?? isLikelyOpeningScene(scene);

  const ext = mode === "photo" ? "jpg" : "mp4";
  const stem = options.fileStem || `scene_${String(scene.index).padStart(3, "0")}`;
  const fileName = `${stem}.${ext}`;
  const filePath = path.join(outDir, fileName);

  log(runId, "info", `Stock ${mode} for scene #${scene.index}`, {
    stage: "animate",
    data: { mode, openingTopicLock, prompt: scene.visual_prompt.slice(0, 120) },
  });

  let assetInfo;
  if (mode === "photo") {
    assetInfo = await pexelsPhoto(runId, scene, filePath, options.photoUsedIds, options.avoidDedupeIds, options.videoContext, options.anchorWords, openingTopicLock);
  } else {
    assetInfo = await pexelsClip(runId, scene, filePath, options.videoUsedIds, options.avoidDedupeIds, options.videoContext, options.anchorWords, openingTopicLock);
  }

  log(runId, "success", `Asset ready: ${fileName}`, { stage: "animate" });
  return { path: filePath, kind: mode, dedupeId: assetInfo?.dedupeId };
}

// ── Pexels video pipeline ───────────────────────────────────────────────────

async function pexelsClip(
  runId: string,
  scene: Scene,
  outPath: string,
  usedIds?: Set<string>,
  avoidDedupeIds?: Set<string>,
  videoContext?: string,
  anchorWords?: string[],
  openingTopicLock?: boolean
): Promise<{ author: string | null; sourceUrl: string; source: string; dedupeId?: string }> {
  const orientation = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation;
  const maxHeight = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));
  const minDuration = Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4"));

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await acquireStockClipForScene(scene, outPath, {
        runId,
        orientation,
        maxHeight,
        minDuration,
        usedIds,
        avoidDedupeIds,
        videoContext,
        anchorWords,
        openingTopicLock,
      });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/no video found|returned 0 videos|empty query/i.test(msg)) throw e;
      if (attempt < MAX_ATTEMPTS) {
        const delay = 3000 * attempt;
        log(runId, "warn", `Pexels video attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "animate",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Pexels photo pipeline ───────────────────────────────────────────────────

async function pexelsPhoto(
  runId: string,
  scene: Scene,
  outPath: string,
  usedIds?: Set<string>,
  avoidDedupeIds?: Set<string>,
  videoContext?: string,
  anchorWords?: string[],
  openingTopicLock?: boolean
): Promise<{ author: string | null; sourceUrl: string; source: string; dedupeId?: string }> {
  const orientation = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation;
  const maxHeight = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await acquireStockPhotoForScene(scene, outPath, {
        runId,
        orientation,
        maxHeight,
        usedIds,
        avoidDedupeIds,
        videoContext,
        anchorWords,
        openingTopicLock,
      });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/no photo found|returned 0 photos|empty query/i.test(msg)) throw e;
      if (attempt < MAX_ATTEMPTS) {
        const delay = 3000 * attempt;
        log(runId, "warn", `Pexels photo attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "animate",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ── Scene-mix distribution ──────────────────────────────────────────────────

const HOOK_VIDEO_BIAS_SECONDS = 30;
const HOOK_PHOTO_RATIO_PERCENT = 15; // 85% video / 15% photo in the opening hook.

function pickPhotosWithinSubset(
  scenes: Scene[],
  target: number,
  mode: "random" | "alternating"
): Set<number> {
  const picks = new Set<number>();
  if (target <= 0 || scenes.length === 0) return picks;
  const clampedTarget = Math.max(0, Math.min(scenes.length, target));

  if (mode === "alternating") {
    const step = scenes.length / clampedTarget;
    for (let i = 0; picks.size < clampedTarget && i < scenes.length; i++) {
      picks.add(scenes[Math.floor(i * step)].index);
    }
    return picks;
  }

  const indices = scenes.map((s) => s.index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return new Set(indices.slice(0, clampedTarget));
}

function splitHookScenes(scenes: Scene[]): { hook: Scene[]; rest: Scene[] } {
  const hook: Scene[] = [];
  const rest: Scene[] = [];
  let accSec = 0;

  for (const scene of scenes) {
    const startsInHook = accSec < HOOK_VIDEO_BIAS_SECONDS;
    if (startsInHook) hook.push(scene);
    else rest.push(scene);
    accSec += Math.max(1, Number(scene.duration_hint_sec || 5));
  }

  return { hook, rest };
}

/**
 * Picks which scenes get PHOTOS (the rest get videos). Photos render through
 * ken-burns zoom in/out in FFmpeg assembly, which gives a different visual
 * rhythm and helps when Pexels has a strong photo for a query but weak video.
 *
 * Global behavior:
 *  - First ~30 seconds always favour VIDEO: about 85% video / 15% photo.
 *  - After the first ~30 seconds, use SCENE_PHOTO_RATIO normally.
 *
 * Modes:
 *  - "random": shuffles scene indices and takes the first N (default)
 *  - "alternating": evenly spaces photo scenes across the timeline
 */
export function pickPhotoScenes(
  scenes: Scene[],
  photoRatioPercent: number,
  mode: "random" | "alternating" = "random"
): Set<number> {
  if (scenes.length === 0) return new Set();

  const ratio = Math.max(0, Math.min(100, photoRatioPercent));
  const { hook, rest } = splitHookScenes(scenes);

  const hookPhotoTarget = Math.round((hook.length * HOOK_PHOTO_RATIO_PERCENT) / 100);
  const restPhotoTarget = Math.round((rest.length * ratio) / 100);

  const picked = new Set<number>();
  for (const idx of pickPhotosWithinSubset(hook, hookPhotoTarget, mode)) picked.add(idx);
  for (const idx of pickPhotosWithinSubset(rest, restPhotoTarget, mode)) picked.add(idx);

  return picked;
}
