import path from "node:path";
import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

/**
 * Max clips fed into a single ffmpeg xfade call. Above this we use hierarchical
 * chunking (see concatWithCrossfadeChunked). 50 keeps every ffmpeg process far
 * under the per-process file-descriptor limit (256 on macOS / 512 on Windows),
 * which is what causes the "Resource temporarily unavailable" / code-221 crash
 * on long videos.
 */
const MAX_CLIPS_PER_PASS = 50;

/** A short caption to flash on a clip (hook-emphasis text overlay). */
export interface OverlaySpec {
  /** Short text to display, e.g. "$400", "1998", "73%", "Texas". */
  text: string;
  /** Start time LOCAL to this clip, in seconds (clamped during render). */
  atSec: number;
  /** Optional custom display duration in seconds. */
  duration?: number;
}

/** Custom step overlay specification. */
export interface StepOverlaySpec {
  stepNum: string;      // e.g. "1"
  title: string;        // formatted title: "COLLECT & CHOP KITCHEN SCRAPS"
  rawTitle: string;     // raw title: "Collect and chop your kitchen scraps"
  startMs?: number;     // calculated start timestamp (from Whisper)
  endMs?: number;       // calculated end timestamp (from Whisper + trail)
  atSec?: number;       // start relative to plan clip
  duration?: number;    // duration in seconds
}


export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
  /** Optional big fading caption burned into this clip. */
  overlay?: OverlaySpec;
  /** Optional step overlay. */
  stepOverlay?: StepOverlaySpec;
  dedupeId?: string;
}


/**
 * Builds the final video:
 *  1. For each scene render a clip whose duration matches its audio.
 *  2. Concat all clips with randomized-length crossfades (or hard cuts if TRANSITION_MAX = 0).
 */
export async function assembleVideo(
  runId: string,
  scenes: AssembleInput[],
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  // Each scene cut gets a RANDOM crossfade length in [min, max] for a dynamic
  // feel, but bounded so it's never a long slow blend. Type stays a plain fade.
  let transMin = Math.max(0, Number(getSetting("TRANSITION_MIN") || "0.3"));
  let transMax = Math.max(0, Number(getSetting("TRANSITION_MAX") || "0.7"));
  if (transMax < transMin) [transMin, transMax] = [transMax, transMin]; // tolerate swapped
  const tailSilence = Math.max(0, Number(getSetting("SCENE_TAIL_SILENCE") || "0.4"));
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(runId, "info", `Assembling ${scenes.length} clips (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`, {
    stage: "assemble",
  });

  // 1. Render individual clips in parallel; preserve order by scene index.
  const limitClip = pLimit(assembleConcurrency);
  const indexed: { path: string; durationSec: number; index: number }[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const audioDuration = await probeDuration(item.audio.filePath);
        const clipDuration = audioDuration + tailSilence;
        if (item.videoPath) {
          await renderAnimatedClip(item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence, item.overlay, item.stepOverlay);
        } else {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderKenBurnsClip(item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence, item.overlay, item.stepOverlay);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);
  const clipInfos = indexed.map((c) => ({ path: c.path, durationSec: c.durationSec }));

  // 2. Concat
  const finalPath = path.join(outDir, "final.mp4");
  if (transMax > 0 && clipInfos.length >= 2) {
    // A monolithic xfade with hundreds of inputs blows past the per-process
    // file-descriptor limit (256 on macOS, 512 on Windows) and ffmpeg crashes
    // with "Resource temporarily unavailable" (EAGAIN). So past MAX_CLIPS_PER_PASS
    // clips we fall back to hierarchical chunked xfade — each ffmpeg call stays
    // well under the FD limit. Below that, one monolithic call is fine and faster.
    if (clipInfos.length > MAX_CLIPS_PER_PASS) {
      await concatWithCrossfadeChunked(runId, clipInfos, clipsDir, finalPath, transMin, transMax, fps);
    } else {
      await concatWithCrossfade(clipInfos, finalPath, transMin, transMax, fps);
      log(runId, "info", `Crossfade ${transMin}-${transMax}s (randomized) across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
    await concatSimple(clipInfos.map((c) => c.path), clipsDir, finalPath);
  }

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/** Points fluent-ffmpeg at the ffmpeg/ffprobe binaries from the FFMPEG_PATH setting. */
function ensureFfmpegPaths(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (!ffmpegPath) return;
  ffmpeg.setFfmpegPath(ffmpegPath);
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
}

/**
 * Resolves the ffmpeg binary to invoke directly via spawnSync (for the few
 * places that bypass fluent-ffmpeg — audio concat, the Whisper downsample).
 * Honours the FFMPEG_PATH setting; falls back to `ffmpeg` on the system PATH.
 */
export function resolveFfmpegBinary(): string {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  return ffmpegPath && ffmpegPath.trim() ? ffmpegPath.trim() : "ffmpeg";
}

/**
 * Writes a DOWNSAMPLED 16 kHz mono mp3 copy of `srcAudioPath` to `outPath`.
 *
 * Why: Groq's free Whisper tier rejects uploads larger than 25 MB. A 40-minute
 * full-quality mp3 is ~38 MB — over the limit. Whisper resamples everything to
 * 16 kHz mono internally anyway, so a 16 kHz mono ~48 kbps copy is a fraction
 * of the size with ZERO transcription-accuracy loss. The original full-quality
 * file is untouched and is what goes into the final video — only this throwaway
 * copy is downsampled, and the caller deletes it after transcription.
 */
export async function downsampleForTranscription(
  srcAudioPath: string,
  outPath: string
): Promise<void> {
  ensureFfmpegPaths();
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(srcAudioPath)
      .outputOptions([
        "-ar", "16000",       // 16 kHz — Whisper's internal rate
        "-ac", "1",           // mono
        "-c:a", "libmp3lame",
        "-b:a", "48k",        // small file, plenty for speech recognition
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Reads the exact audio duration via ffprobe. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) {
        const stat = fs.statSync(filePath);
        return resolve(Math.max(1, stat.size / 16000));
      }
      resolve(d);
    });
  });
}

/**
 * Best-effort media duration in seconds — safe to call from any pipeline stage.
 */
export async function probeDurationSafe(filePath: string): Promise<number> {
  try {
    ensureFfmpegPaths();
    return await probeDuration(filePath);
  } catch {
    try {
      return Math.max(1, fs.statSync(filePath).size / 16000);
    } catch {
      return 1;
    }
  }
}

/**
 * Re-times an audio file in place using ffmpeg's `atempo` filter (tempo change
 * WITHOUT pitch shift — the voice stays natural, just paced). `tempo` < 1 makes
 * it slower/calmer, > 1 faster. Used by TTS to honor the TTS_SPEED setting.
 * Writes to a temp file then atomically replaces the original.
 */
export async function applyAudioTempo(filePath: string, tempo: number): Promise<void> {
  ensureFfmpegPaths();
  const clamped = Math.max(0.5, Math.min(2.0, tempo));
  const tmp = `${filePath}.tempo.mp3`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(filePath)
      .audioFilters(`atempo=${clamped.toFixed(3)}`)
      .outputOptions(["-c:a libmp3lame", "-q:a 4"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(tmp);
  });
  // Replace original with the re-timed file.
  fs.rmSync(filePath, { force: true });
  fs.renameSync(tmp, filePath);
}

/**
 * Caps every silence in `filePath` to at most `maxPauseSec` seconds, in place.
 *
 * Single-shot voiceover is ONE continuous take, so there's no per-scene gap knob
 * (SCENE_TAIL_SILENCE only affects per-scene mode). Over-long pauses there come
 * from the TTS engine's own sentence pauses and from silence at chunk seams when
 * a long script is synthesized in pieces. `silenceremove` with stop_silence caps
 * each silent stretch to maxPauseSec and leaves SHORTER pauses untouched — so the
 * natural rhythm stays, only the excessively long gaps get trimmed. Speech/pitch
 * are not altered. Verified: a 1.2s gap → ~maxPauseSec.
 */
export async function capPauses(filePath: string, maxPauseSec: number): Promise<void> {
  ensureFfmpegPaths();
  const cap = Math.max(0.05, maxPauseSec);
  const tmp = `${filePath}.pausecap.mp3`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(filePath)
      .audioFilters(`silenceremove=stop_periods=-1:stop_threshold=-40dB:stop_silence=${cap.toFixed(3)}`)
      .outputOptions(["-c:a libmp3lame", "-q:a 4"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(tmp);
  });
  fs.rmSync(filePath, { force: true });
  fs.renameSync(tmp, filePath);
}

// ── On-screen text overlays (hook emphasis) ──────────────────────────────────

let cachedOverlayFont: string | null | undefined; // undefined = not resolved yet

/**
 * Resolves a bold font file for overlays: the TEXT_OVERLAY_FONT setting if it
 * exists, else the first bold system font found. Returns null if none exist —
 * overlays are then silently skipped (they must NEVER fail a render).
 */
function resolveOverlayFont(): string | null {
  if (cachedOverlayFont !== undefined) return cachedOverlayFont;
  const custom = (getSetting("TEXT_OVERLAY_FONT") || "").trim();
  const candidates = [
    custom,
    "C:/Windows/Fonts/impact.ttf",
    "C:/Windows/Fonts/ariblk.ttf", // Arial Black
    "C:/Windows/Fonts/arialbd.ttf", // Arial Bold
    "C:/Windows/Fonts/seguibl.ttf", // Segoe UI Black
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      cachedOverlayFont = c;
      return c;
    }
  }
  cachedOverlayFont = null;
  return null;
}

/** Escapes a filesystem path for an ffmpeg filtergraph option value (forward
 *  slashes + escaped drive colon). The caller wraps the result in single quotes. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/** Keeps only characters that are safe AND meaningful in a short caption — drops
 *  anything that could break filtergraph quoting (quotes, colons, braces, etc.). */
function sanitizeOverlayText(s: string): string {
  return s
    .replace(/[^A-Za-z0-9 $%.,+\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
}

/** Keeps only characters that are safe AND meaningful in a step overlay caption. */
function sanitizeStepOverlayText(s: string): string {
  return s
    .replace(/[^A-Za-z0-9 $%.,+\-&]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Builds double drawtext filters for Step Overlay: Line 1 "STEP X" and Line 2 "TITLE".
 * Returns them joined by comma, or null when there's no usable font.
 */
function buildStepOverlayDrawtext(
  stepOverlay: StepOverlaySpec | undefined,
  w: number,
  h: number,
  durationSec: number
): string | null {
  if (!stepOverlay) return null;
  const font = resolveOverlayFont();
  if (!font) return null;

  const anim = (getSetting("STEP_OVERLAY_ANIMATION") || "slide-up").toLowerCase();
  const enterSec = Math.max(0.01, parseFloat(getSetting("STEP_OVERLAY_ENTER_SEC") || "0.35"));
  const exitSec = Math.max(0.01, parseFloat(getSetting("STEP_OVERLAY_EXIT_SEC") || "0.25"));

  const f = (n: number) => n.toFixed(2);
  const t0 = Math.max(0, stepOverlay.atSec ?? 0);
  const duration = stepOverlay.duration ?? 2.0;
  const t1 = t0 + duration;

  // Font sizes:
  // Line 1: STEP X (smaller, bold, ~60–75px)
  // Line 2: TITLE (larger, bold, ~90–115px)
  let fontSize1 = Math.round(68 * (h / 1080));
  let fontSize2 = Math.round(100 * (h / 1080));

  // Dynamically shrink title font size to fit within 85% of video width
  const maxTextWidth = w * 0.85;
  const text2 = sanitizeStepOverlayText(stepOverlay.title);
  const estimatedTextWidth = text2.length * fontSize2 * 0.65;
  if (estimatedTextWidth > maxTextWidth) {
    const fittedSize = Math.round(maxTextWidth / (text2.length * 0.65));
    fontSize2 = Math.min(fontSize2, fittedSize);
  }

  // Set lower bounds and upper bounds to keep them sane
  fontSize1 = Math.max(40, Math.min(100, fontSize1));
  fontSize2 = Math.max(60, Math.min(160, fontSize2));

  const lineGap = 15;

  let yExpr1 = "";
  let yExpr2 = "";

  if (anim === "slide-up") {
    // Initial Y: h * 0.70
    // Final Y: h * 0.50
    yExpr1 = `if(lt(t,${f(t0 + enterSec)}),h*0.70-${fontSize1 + lineGap}-(h*0.20)*(t-${f(t0)})/${f(enterSec)},h*0.50-${fontSize1 + lineGap})`;
    yExpr2 = `if(lt(t,${f(t0 + enterSec)}),h*0.70+${lineGap}-(h*0.20)*(t-${f(t0)})/${f(enterSec)},h*0.50+${lineGap})`;
  } else {
    yExpr1 = `h*0.50-${fontSize1 + lineGap}`;
    yExpr2 = `h*0.50+${lineGap}`;
  }

  let alphaExpr = "";
  if (anim === "fade") {
    alphaExpr = `if(lt(t,${f(t0)}),0,if(lt(t,${f(t0 + enterSec)}),(t-${f(t0)})/${f(enterSec)},if(lt(t,${f(t1 - exitSec)}),1,if(lt(t,${f(t1)}),(${f(t1)}-t)/${f(exitSec)},0))))`;
  } else if (anim === "slide-up") {
    alphaExpr = `if(lt(t,${f(t0)}),0,if(lt(t,${f(t1 - exitSec)}),1,if(lt(t,${f(t1)}),(${f(t1)}-t)/${f(exitSec)},0)))`;
  } else {
    alphaExpr = `if(lt(t,${f(t0)}),0,if(lt(t,${f(t1)}),1,0))`;
  }

  const text1 = `STEP ${stepOverlay.stepNum}`;
  const borderW1 = Math.max(4, Math.round(fontSize1 / 10));
  const borderW2 = Math.max(4, Math.round(fontSize2 / 10));

  const dt1 = `drawtext=fontfile='${escapeFilterPath(font)}'` +
    `:text='${text1}':expansion=none` +
    `:fontcolor=white:fontsize=${fontSize1}` +
    `:borderw=${borderW1}:bordercolor=black@0.9` +
    `:shadowx=3:shadowy=3:shadowcolor=black@0.6` +
    `:x=(w-text_w)/2:y='${yExpr1}'` +
    `:alpha='${alphaExpr}':enable='between(t,${f(t0)},${f(t1)})'`;

  const dt2 = `drawtext=fontfile='${escapeFilterPath(font)}'` +
    `:text='${text2}':expansion=none` +
    `:fontcolor=white:fontsize=${fontSize2}` +
    `:borderw=${borderW2}:bordercolor=black@0.9` +
    `:shadowx=3:shadowy=3:shadowcolor=black@0.6` +
    `:x=(w-text_w)/2:y='${yExpr2}'` +
    `:alpha='${alphaExpr}':enable='between(t,${f(t0)},${f(t1)})'`;

  return `${dt1},${dt2}`;
}

/**
 * Builds a `drawtext` filter that fades a big caption in and out — or null when
 * there's no usable font/text or the clip is too short to read. Times are LOCAL
 * to the clip (it starts at t=0). Append to the END of a video filter chain so
 * it draws on the final WxH frames.
 */
function buildOverlayDrawtext(
  overlay: OverlaySpec | undefined,
  w: number,
  h: number,
  durationSec: number
): string | null {
  if (!overlay) return null;
  const text = sanitizeOverlayText(overlay.text);
  if (!text) return null;
  if (durationSec < 0.8) return null; // too short to read comfortably
  const font = resolveOverlayFont();
  if (!font) return null;

  // Anchor the caption AT the spoken moment (overlay.atSec). Only clamp so at
  // least ~0.5s remains in the clip; the hold then shrinks to fit rather than
  // sliding the caption earlier — so it stays on the word even near a clip end.
  const t0 = Math.min(Math.max(0, overlay.atSec), Math.max(0, durationSec - 0.5));
  let hold = overlay.duration ?? Math.max(0.5, Math.min(1.8, durationSec - t0 - 0.05));
  
  // Clamp hold so it doesn't overshoot the clip duration
  hold = Math.min(hold, durationSec - t0);
  if (hold < 0.8) {
    hold = Math.max(0.8, hold);
    hold = Math.min(hold, durationSec);
  }

  // Snappy pop-IN (near-instant) so the caption lands ON the word
  const fadeIn = Math.min(0.08, hold / 4);
  const fadeOut = Math.min(0.3, hold / 3);
  const t1 = t0 + hold;
  const f = (n: number) => n.toFixed(2);

  // Piecewise alpha: quick pop in → hold at 1 → gentle fade out.
  const alpha =
    `if(lt(t,${f(t0)}),0,` +
    `if(lt(t,${f(t0 + fadeIn)}),(t-${f(t0)})/${f(fadeIn)},` +
    `if(lt(t,${f(t1 - fadeOut)}),1,` +
    `if(lt(t,${f(t1)}),(${f(t1)}-t)/${f(fadeOut)},0))))`;

  // Get font size settings
  const pct = parseFloat(getSetting("CAPTION_FONT_SIZE_PERCENT") || "13");
  let fontSize = Math.round((pct / 100) * h);
  
  // Proportional bounds based on 1080p standards: min 110px, max 180px
  const minFontSize = Math.round(110 * (h / 1080));
  const maxFontSize = Math.round(180 * (h / 1080));
  fontSize = Math.max(minFontSize, Math.min(maxFontSize, fontSize));

  // Reduce font size dynamically for longer texts to fit within 80% of video width
  // Assumes character width ratio of roughly 0.65 for bold sans-serif font
  const estimatedTextWidth = text.length * fontSize * 0.65;
  if (estimatedTextWidth > w * 0.8) {
    const fittedSize = Math.round((w * 0.8) / (text.length * 0.65));
    fontSize = Math.min(fontSize, fittedSize);
  }

  // Keep a strong border/stroke width
  const borderW = Math.max(4, Math.round(fontSize / 12));

  // Vertical position
  const posY = parseFloat(getSetting("CAPTION_POSITION_Y_PERCENT") || "72");
  const yCoord = `h*${(posY / 100).toFixed(2)}`;

  return (
    `drawtext=fontfile='${escapeFilterPath(font)}'` +
    // expansion=none → the text is taken 100% literally, so "$400", "73%" and
    // "1,200" render as-is with no %{}/backslash interpretation surprises.
    `:text='${text}':expansion=none` +
    `:fontcolor=white:fontsize=${fontSize}` +
    `:borderw=${borderW}:bordercolor=black@0.9` +
    `:shadowx=3:shadowy=3:shadowcolor=black@0.6` +
    `:x=(w-text_w)/2:y=${yCoord}` +
    `:alpha='${alpha}':enable='between(t,${f(t0)},${f(t1)})'`
  );
}

/** Appends an overlay drawtext (if any) to an existing video filter chain. */
function withOverlay(
  videoFilter: string,
  overlay: OverlaySpec | undefined,
  stepOverlay: StepOverlaySpec | undefined,
  w: number,
  h: number,
  durationSec: number
): string {
  let filter = videoFilter;
  if (stepOverlay) {
    const dt = buildStepOverlayDrawtext(stepOverlay, w, h, durationSec);
    if (dt) filter = `${filter},${dt}`;
  }
  if (overlay) {
    const dt = buildOverlayDrawtext(overlay, w, h, durationSec);
    if (dt) filter = `${filter},${dt}`;
  }
  return filter;
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 */
function renderKenBurnsClip(
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  tailSilenceSec: number = 0,
  overlay?: OverlaySpec,
  stepOverlay?: StepOverlaySpec
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`;
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
  }

  // Scale to COVER the 2x canvas preserving the photo's real aspect ratio, then
  // crop to exactly 2x WxH. Using a bare `scale=W:H` here would STRETCH a non-16:9
  // photo to 16:9 (the "squished / distorted image" bug). The 2x supersample keeps
  // the ken-burns zoom crisp; zoompan then renders down to the final WxH.
  const filter = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w * 2}:${h * 2},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .videoFilters(withOverlay(filter, overlay, stepOverlay, w, h, durationSec));
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Stock clip render: scale/crop the Pexels video, match audio length.
 * If the audio is longer than the clip, mildly stretch and/or freeze last frame.
 */
async function renderAnimatedClip(
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0,
  overlay?: OverlaySpec,
  stepOverlay?: StepOverlaySpec
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }
  videoFilter = withOverlay(videoFilter, overlay, stepOverlay, w, h, durationSec);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(videoFilter);
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Simple stream-copy concat (no transitions).
 *  Paths are wrapped in `file '...'`; an embedded single quote must be escaped
 *  as `'\''` or the concat demuxer mis-parses the path and ffmpeg fails with
 *  "Error opening input file ... No such file or directory". Run-folder names
 *  come from arbitrary video titles (e.g. "...Can't Fix..."), so this matters.
 *  Backslashes are normalised to forward slashes for Windows paths. */
function concatSimple(clipPaths: string[], clipsDir: string, finalPath: string): Promise<void> {
  const listFile = path.join(clipsDir, "concat.txt");
  const lines = clipPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listFile, lines, "utf-8");
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

/**
 * Hierarchical xfade for large clip counts.
 *
 * Why: one ffmpeg call with hundreds of `-i` inputs (a) can't use multiple
 * cores (the xfade chain is sequential) and (b) opens hundreds of files at
 * once, blowing the per-process FD limit → "Resource temporarily unavailable"
 * (EAGAIN) crash on macOS/Windows.
 *
 * Strategy: cap each ffmpeg call at MAX_CLIPS_PER_PASS inputs, run several in
 * parallel, collapse the intermediates the same way, repeat until ≤
 * MAX_CLIPS_PER_PASS clips remain — that final pass writes finalPath.
 *
 *   691 clips → L0: 14 chunks × ~50 → L1: 14 ≤ 50 → final. 2 levels.
 */
async function concatWithCrossfadeChunked(
  runId: string,
  clips: { path: string; durationSec: number }[],
  clipsDir: string,
  finalPath: string,
  minDur: number,
  maxDur: number,
  fps: number
): Promise<void> {
  const baseParallel = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  // RAM-aware throttle: many parallel ffmpegs each holding 50 inputs can spill
  // a 16-GB laptop into swap and freeze the machine. For huge videos cap at 2.
  const isLargeVideo = clips.length >= 500;
  const maxParallel = isLargeVideo ? Math.min(baseParallel, 2) : baseParallel;
  if (isLargeVideo && baseParallel > maxParallel) {
    log(
      runId,
      "info",
      `Large video (${clips.length} clips) — throttling assemble concurrency ${baseParallel} → ${maxParallel} to keep RAM bounded`,
      { stage: "assemble" }
    );
  }

  let current = clips;
  let level = 0;
  const intermediateFiles: string[] = [];

  while (current.length > MAX_CLIPS_PER_PASS) {
    const chunkCount = Math.ceil(current.length / MAX_CLIPS_PER_PASS);
    const baseSize = Math.floor(current.length / chunkCount);
    const extra = current.length % chunkCount;

    const chunks: { path: string; durationSec: number }[][] = [];
    let cursor = 0;
    for (let i = 0; i < chunkCount; i++) {
      const size = baseSize + (i < extra ? 1 : 0);
      chunks.push(current.slice(cursor, cursor + size));
      cursor += size;
    }

    log(
      runId,
      "info",
      `xfade L${level}: ${current.length} clips → ${chunkCount} chunks, ${Math.min(maxParallel, chunkCount)} in parallel`,
      { stage: "assemble" }
    );

    const limit = pLimit(maxParallel);
    const nextLevel = await Promise.all(
      chunks.map((chunkClips, idx) =>
        limit(async () => {
          if (chunkClips.length === 1) return chunkClips[0];
          const chunkPath = path.join(clipsDir, `xfade_L${level}_${String(idx).padStart(3, "0")}.mp4`);
          // concatWithCrossfade returns the EXACT assembled duration (it picks a
          // random fade per cut, so we can't compute it from a single fadeDur).
          const chunkDuration = await concatWithCrossfade(chunkClips, chunkPath, minDur, maxDur, fps);
          intermediateFiles.push(chunkPath);
          log(runId, "info", `xfade L${level} #${idx}: ${chunkClips.length} clips → ${chunkDuration.toFixed(1)}s`, {
            stage: "assemble",
          });
          return { path: chunkPath, durationSec: chunkDuration };
        })
      )
    );

    current = nextLevel;
    level++;
  }

  log(
    runId,
    "info",
    `xfade final pass: ${current.length} ${current.length === 1 ? "clip" : "clips"} → final.mp4`,
    { stage: "assemble" }
  );
  if (current.length === 1) {
    fs.copyFileSync(current[0].path, finalPath);
  } else {
    await concatWithCrossfade(current, finalPath, minDur, maxDur, fps);
  }

  // Cleanup intermediate chunk files.
  for (const f of intermediateFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

/**
 * Concat clips with a plain crossfade (the classic look — NOT slides/wipes).
 * The transition LENGTH is randomized per cut within [minDur, maxDur] so the
 * pacing feels dynamic, but it's bounded so a cut is never a long slow blend.
 * Each fade is also clamped to half the shorter neighbouring clip so xfade
 * always has enough overlap. Audio uses a matching acrossfade so it never jars.
 *
 * Returns the EXACT assembled duration (sum of clip lengths minus the overlap
 * of every chosen fade) — the chunked caller needs this for the next level's
 * offset math, since per-cut random durations can't be derived from one number.
 */
function concatWithCrossfade(
  clips: { path: string; durationSec: number }[],
  finalPath: string,
  minDur: number,
  maxDur: number,
  fps: number
): Promise<number> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);

  let videoChain = "";
  let audioChain = "";
  let lastV = "0:v";
  let lastA = "0:a";

  let cumOffset = 0;
  let totalOverlap = 0;
  for (let i = 1; i < clips.length; i++) {
    // Random length for THIS cut, clamped so it never exceeds half of either
    // neighbouring clip (xfade needs both clips longer than the fade).
    const rand = minDur + Math.random() * Math.max(0, maxDur - minDur);
    const fade = Math.max(
      0.1,
      Math.min(rand, clips[i - 1].durationSec * 0.5, clips[i].durationSec * 0.5)
    );
    cumOffset += clips[i - 1].durationSec - fade;
    totalOverlap += fade;
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    audioChain += `[${lastA}][${i}:a]acrossfade=d=${fade.toFixed(3)}[${aOut}];`;
    lastV = vOut;
    lastA = aOut;
  }
  const filterComplex = (videoChain + audioChain).replace(/;$/, "");
  const totalDuration = clips.reduce((s, c) => s + c.durationSec, 0) - totalOverlap;

  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        `-map [${lastA}]`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve(totalDuration))
      .save(finalPath);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Single-shot voiceover assembly
// ───────────────────────────────────────────────────────────────────────────

/**
 * One input for single-shot assembly: a Pexels asset (video clip OR still
 * photo) plus the [startMs, endMs] slice of the global continuous voiceover
 * it should cover (from Whisper word-alignment, possibly a sub-segment of a
 * scene when MAX_CLIP_SECONDS splits a long range).
 */
export interface SingleShotInput {
  scene: Scene;
  /** Disk path of the visual asset (mp4 for video, jpg for photo). */
  assetPath: string;
  /** Whether assetPath is a moving clip or a still image. */
  kind: "video" | "photo";
  startMs: number;
  endMs: number;
  /** Optional big fading caption burned into this clip. */
  overlay?: OverlaySpec;
  /** Optional step overlay. */
  stepOverlay?: StepOverlaySpec;
  fileStem?: string;
  dedupeId?: string;
}


/**
 * Assemble the final video in single-shot voiceover mode.
 *
 * Input shape: one continuous voiceover mp3 (synthesised in tts-align.ts) plus
 * a list of per-sub-clip visuals (Pexels video OR photo) and their
 * [startMs, endMs] ranges inside that audio (from Whisper word-alignment).
 *
 * Steps:
 *   1. Render each visual SILENTLY at duration (endMs-startMs)/1000:
 *        - video → scale/crop to WxH, mild stretch (≤1.15×) then freeze last
 *          frame to fill, NO audio.
 *        - photo → ken-burns zoom, NO audio.
 *   2. Concatenate the silent clips end-to-end with a plain concat (NO xfade —
 *      even a small crossfade would desync the visuals against the single
 *      continuous audio track).
 *   3. Mux the global voiceover onto the concat'd silent video → final.mp4.
 *
 * Why this exists: per-scene TTS makes a sentence that spans two scenes read as
 * two disconnected pieces (unnatural mid-sentence pause). One continuous take
 * aligned to word timestamps removes every scene boundary from the audio.
 */
export async function assembleSingleShot(
  runId: string,
  inputs: SingleShotInput[],
  globalAudioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(
    runId,
    "info",
    `Single-shot assembly: ${inputs.length} silent clips → global audio mux (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`,
    { stage: "assemble" }
  );

  // 1. Render silent clips in parallel; preserve order (index, then sub-clip).
  //    Each clip's filename embeds its position so concat order is stable even
  //    though Promise.all resolves out of order.
  const limit = pLimit(assembleConcurrency);
  const indexed = await Promise.all(
    inputs.map((item, order) =>
      limit(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(order).padStart(4, "0")}.mp4`
        );
        const durationSec = Math.max(0.1, (item.endMs - item.startMs) / 1000);
        if (item.kind === "photo") {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderSilentKenBurns(item.assetPath, clipPath, w, h, fps, durationSec, zoomDirection, item.overlay, item.stepOverlay);
        } else {
          await renderSilentVideo(item.assetPath, clipPath, w, h, fps, durationSec, item.overlay, item.stepOverlay);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} silent ${durationSec.toFixed(2)}s (${item.kind}) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec, order };
      })
    )
  );
  indexed.sort((a, b) => a.order - b.order);

  // 2. Concat silent clips (simple, no xfade — see header comment).
  const silentConcat = path.join(outDir, "silent_concat.mp4");
  await concatSimple(indexed.map((c) => c.path), clipsDir, silentConcat);
  log(runId, "info", `Concatenated ${indexed.length} silent clips into one track`, {
    stage: "assemble",
  });

  // 3. Mux the global voiceover onto the silent concat.
  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioOntoVideo(silentConcat, globalAudioPath, finalPath);
  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });

  // 4. Clean up the intermediate silent concat.
  try {
    fs.unlinkSync(silentConcat);
  } catch {}

  return finalPath;
}

/**
 * Render ONE Pexels VIDEO clip silently, with duration trimmed / stretched /
 * freeze-padded to match `durationSec`. Same scale/crop/stretch/freeze policy
 * as renderAnimatedClip (≤1.15× stretch, then last-frame freeze) but no audio
 * input or output — audio joins later in the global mux.
 */
async function renderSilentVideo(
  videoPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  overlay?: OverlaySpec,
  stepOverlay?: StepOverlaySpec
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .videoFilters(withOverlay(videoFilter, overlay, stepOverlay, w, h, durationSec))
      .outputOptions([
        "-an", // drop any audio from the Pexels clip — audio is muxed globally
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Render ONE still PHOTO as a silent ken-burns clip of exactly `durationSec`.
 * Same zoom/pan math as renderKenBurnsClip but with no audio input and `-an`
 * output (audio is muxed globally afterwards).
 */
function renderSilentKenBurns(
  imagePath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  overlay?: OverlaySpec,
  stepOverlay?: StepOverlaySpec
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`;
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
  }

  // Scale to COVER the 2x canvas preserving the photo's real aspect ratio, then
  // crop to exactly 2x WxH. Using a bare `scale=W:H` here would STRETCH a non-16:9
  // photo to 16:9 (the "squished / distorted image" bug). The 2x supersample keeps
  // the ken-burns zoom crisp; zoompan then renders down to the final WxH.
  const filter = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w * 2}:${h * 2},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .videoFilters(withOverlay(filter, overlay, stepOverlay, w, h, durationSec))
      .outputOptions([
        "-an", // silent — audio is muxed globally afterwards
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Mux: copy the video stream from `videoPath`, attach audio from `audioPath`.
 *
 * The voiceover is the source of truth for length. If the silent video came
 * out even slightly shorter than the audio (alignment drift, a dropped clip),
 * a plain `-shortest` mux would DROP the tail of the narration. So we measure
 * both: if the video is short, hold its last frame to cover the gap (needs a
 * video re-encode); otherwise stream-copy the video (fast path). `-shortest`
 * then trims back to the audio end, so the narration is never cut.
 */
async function muxAudioOntoVideo(
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);
  const gap = audioDur - videoDur;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(videoPath).input(audioPath);
    const out: string[] = ["-map", "0:v:0", "-map", "1:a:0"];
    if (gap > 0.15) {
      // Freeze the last frame past the audio end; -shortest trims the whole
      // thing back to the (shorter) audio → narration is never cut.
      cmd.videoFilters(`tpad=stop_mode=clone:stop_duration=${(gap + 0.5).toFixed(3)}`);
      out.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
    } else {
      out.push("-c:v", "copy");
    }
    out.push("-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart");
    cmd
      .outputOptions(out)
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}
