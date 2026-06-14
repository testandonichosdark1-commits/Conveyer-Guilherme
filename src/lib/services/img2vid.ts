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
}

export interface AnimateOptions {
  /** Mutable set of VIDEO asset ids ("source:id") already used in this run. */
  videoUsedIds?: Set<string>;
  /** Mutable set of PHOTO asset ids ("source:id") already used in this run. */
  photoUsedIds?: Set<string>;
  /** Which kind of asset to fetch for this scene. Default "video". */
  mode?: AssetMode;
  /**
   * Override the output filename stem (without extension). Defaults to
   * `scene_NNN`. Single-shot mode passes e.g. `scene_007_sub_01` so a scene
   * split into several timed sub-clips writes a distinct file per sub-clip
   * instead of overwriting `scene_007`.
   */
  fileStem?: string;
}

export async function animateScene(
  runId: string,
  scene: Scene,
  outDir: string,
  options: AnimateOptions = {}
): Promise<AnimateResult | null> {
  const mode: AssetMode = options.mode ?? "video";

  const ext = mode === "photo" ? "jpg" : "mp4";
  const stem = options.fileStem || `scene_${String(scene.index).padStart(3, "0")}`;
  const fileName = `${stem}.${ext}`;
  const filePath = path.join(outDir, fileName);

  log(runId, "info", `Stock ${mode} for scene #${scene.index}`, {
    stage: "animate",
    data: { mode, prompt: scene.visual_prompt.slice(0, 120) },
  });

  if (mode === "photo") {
    await pexelsPhoto(runId, scene, filePath, options.photoUsedIds);
  } else {
    await pexelsClip(runId, scene, filePath, options.videoUsedIds);
  }

  log(runId, "success", `Asset ready: ${fileName}`, { stage: "animate" });
  return { path: filePath, kind: mode };
}

// ── Pexels video pipeline ───────────────────────────────────────────────────

async function pexelsClip(
  runId: string,
  scene: Scene,
  outPath: string,
  usedIds?: Set<string>
): Promise<void> {
  const orientation = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation;
  const maxHeight = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));
  const minDuration = Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4"));

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await acquireStockClipForScene(scene, outPath, {
        runId,
        orientation,
        maxHeight,
        minDuration,
        usedIds,
      });
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/returned 0 videos|empty Pexels query/i.test(msg)) throw e;
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
  usedIds?: Set<string>
): Promise<void> {
  const orientation = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape") as Orientation;
  const maxHeight = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await acquireStockPhotoForScene(scene, outPath, {
        runId,
        orientation,
        maxHeight,
        usedIds,
      });
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/returned 0 photos|empty Pexels query/i.test(msg)) throw e;
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

/**
 * Picks which scenes get PHOTOS (the rest get videos). Photos render through
 * ken-burns zoom in/out in FFmpeg assembly, which gives a different visual
 * rhythm and helps when Pexels has a strong photo for a query but weak video.
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
  const ratio = Math.max(0, Math.min(100, photoRatioPercent));
  if (ratio === 0) return new Set();
  if (ratio === 100) return new Set(scenes.map((s) => s.index));

  const target = Math.max(1, Math.round((scenes.length * ratio) / 100));

  if (mode === "alternating") {
    const step = scenes.length / target;
    const picks = new Set<number>();
    for (let i = 0; picks.size < target && i < scenes.length; i++) {
      picks.add(scenes[Math.floor(i * step)].index);
    }
    return picks;
  }

  // "random" — Fisher–Yates shuffle, take first N
  const indices = scenes.map((s) => s.index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return new Set(indices.slice(0, target));
}
