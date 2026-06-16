import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsTask, pollTask, downloadTask } from "./ai33pro";
import { createV3SpeechTask, pollV3Task, downloadV3Task } from "./ai33pro";
import { synthesizeMinimax } from "./minimax";
import { createTtsJob, pollJob, downloadJob } from "./labs69";
import { probeDurationSafe, applyAudioTempo, resolveFfmpegBinary } from "./video-assemble";

export interface TtsResult {
  /** Path to the mp3 file. */
  filePath: string;
  /** Audio duration in seconds, measured via ffprobe. */
  durationSec: number;
}

/** No per-call overrides today (Guilherme has one global voice). Kept as a typed
 *  options bag so a future per-scene/per-channel override is a one-line change. */
type TtsOptions = Record<string, never>;

/**
 * Routes `text` to the currently-configured TTS provider, writing the audio to
 * `outPath`. Shared by per-scene (synthesizeScene) and single-shot
 * (synthesizeFullScript) so the provider switch lives in ONE place.
 *
 * IMPORTANT — voice speed (TTS_SPEED) is applied HERE, exactly once, and the
 * mechanism differs per provider:
 *   • ai33pro → ElevenLabs-direct has no speed knob on this proxy, so we apply
 *     TTS_SPEED as an ffmpeg atempo POST-PROCESS on the written file.
 *   • 69labs  → ElevenLabs exposes a NATIVE voiceSettings.speed, so we pass
 *     TTS_SPEED in the request and DO NOT run atempo (doing both would
 *     double-slow the voice).
 * Callers must therefore NOT apply atempo again on top of dispatchTts output.
 */
/**
 * The voice engine that will ACTUALLY be used for this run. It's the
 * TTS_PROVIDER setting, except: if the selected engine has no key configured
 * but the OTHER one does, we use the configured one (auto-fallback). So
 * whichever single voice key you paste (ai33pro OR 69labs), narration works.
 * If both keys are set, TTS_PROVIDER is respected. Exported so the pipeline can
 * show the user which engine is live.
 */
export function resolveTtsProvider(): "ai33pro" | "69labs" | "kokoro" | "minimax" {
  const selected = (getSetting("TTS_PROVIDER") || "ai33pro").toLowerCase();
  const hasAi33 = getSetting("AI33PRO_API_KEY").trim().length > 0;
  const has69 = getSetting("LABS69_API_KEY").trim().length > 0;
  const hasMinimax = getSetting("MINIMAX_API_KEY").trim().length > 0;
  if (selected === "minimax") {
    // MiniMax uses its own key. If it's missing, fall back to a configured engine
    // so narration still works; otherwise stay (a clear key error surfaces later).
    if (hasMinimax) return "minimax";
    if (hasAi33) return "ai33pro";
    if (has69) return "69labs";
    return "minimax";
  }
  if (selected === "kokoro") {
    // Kokoro runs on the ai33.pro key (it's the ai33.pro V3 API). If that key is
    // missing but 69labs is set, fall back so narration still works; otherwise
    // stay on kokoro (a clear "AI33PRO_API_KEY not set" error surfaces later).
    return hasAi33 || !has69 ? "kokoro" : "69labs";
  }
  if (selected === "69labs") {
    return has69 || !hasAi33 ? "69labs" : "ai33pro";
  }
  return hasAi33 || !has69 ? "ai33pro" : "69labs";
}

async function dispatchTts(
  runId: string,
  rawText: string,
  outPath: string,
  _options: TtsOptions = {}
): Promise<void> {
  // Collapse line breaks / tabs / runs of spaces to a single space. TTS engines
  // turn a literal newline (common in pasted scripts) into a LONG pause, which
  // reads as an unwanted gap between sentences — normalizing removes that cause
  // without changing any words. (Pause MARKERS like Kokoro's `*` are untouched.)
  const text = rawText.replace(/\s+/g, " ").trim();
  const provider = resolveTtsProvider();
  if (provider === "69labs") {
    await labs69Tts(runId, text, outPath);
  } else if (provider === "kokoro") {
    await kokoroTts(runId, text, outPath);
  } else if (provider === "minimax") {
    await minimaxTts(runId, text, outPath);
  } else {
    await ai33proTts(runId, text, outPath);
  }
}

/**
 * ai33.pro TTS for one piece of text → outPath, then apply the voice-speed
 * setting via ffmpeg atempo (pitch-preserving). ai33pro/ElevenLabs-direct has
 * no native speed parameter on this proxy, so tempo is a post-process — exactly
 * as Conveyer Guilherme has always done it.
 */
async function ai33proTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = normalizeVoiceId(getSetting("TTS_VOICE_ID") || "");
  if (!voiceId) {
    throw new Error(
      "No ai33pro voice set — paste an ElevenLabs voice id into /settings → TTS_VOICE_ID"
    );
  }
  const modelId = getSetting("TTS_MODEL") || "eleven_multilingual_v2";

  const taskId = await createTtsTask(text, { voiceId, modelId });
  log(runId, "debug", `ai33pro TTS task ${taskId.slice(0, 8)}… (${modelId} / ${voiceId})`, {
    stage: "tts",
  });

  let task;
  try {
    task = await pollTask(taskId, runId, "tts");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg} — check the voice id "${voiceId}" and model "${modelId}" are valid for this ai33pro account.`
    );
  }
  await downloadTask(task, outPath);

  // Apply the voice-speed setting (pitch-preserving). <1 = slower/calmer.
  const speed = parseFloat(getSetting("TTS_SPEED") || "1");
  if (Number.isFinite(speed) && Math.abs(speed - 1) > 0.01) {
    try {
      await applyAudioTempo(outPath, speed);
      log(runId, "debug", `Voice speed ${speed}× applied (ai33pro / atempo)`, { stage: "tts" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Voice-speed adjust failed (using original): ${msg.slice(0, 150)}`, {
        stage: "tts",
      });
    }
  }
}

/**
 * 69labs TTS for one piece of text → outPath. Uses the SAME ElevenLabs voice id
 * as ai33pro, just through the 69labs gateway. ElevenLabs has a NATIVE speed
 * control here, so TTS_SPEED is passed as voiceSettings.speed (clamped to the
 * ElevenLabs-supported 0.7–1.2 range) — we do NOT run atempo afterwards.
 */
async function labs69Tts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = normalizeVoiceId(getSetting("TTS_VOICE_ID") || "");
  if (!voiceId) {
    throw new Error(
      "No voice set — paste an ElevenLabs voice id into /settings → TTS_VOICE_ID"
    );
  }
  const voiceProviderRaw = (getSetting("TTS_VOICE_PROVIDER") || "elevenlabs").toLowerCase();
  const voiceProvider =
    voiceProviderRaw === "elevenlabs" ||
    voiceProviderRaw === "edgetts" ||
    voiceProviderRaw === "voice-clone"
      ? (voiceProviderRaw as "elevenlabs" | "edgetts" | "voice-clone")
      : "elevenlabs";
  const modelId = getSetting("TTS_MODEL") || undefined;

  // ElevenLabs-specific fine-tuning. We only wire SPEED here (reusing the global
  // TTS_SPEED). speed is the NATIVE ElevenLabs knob — clamp to its 0.7–1.2 range.
  const voiceSettings: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  } = {};
  if (voiceProvider === "elevenlabs") {
    const speed = parseFloat(getSetting("TTS_SPEED") || "");
    if (Number.isFinite(speed)) voiceSettings.speed = clamp(speed, 0.7, 1.2);
  }

  const jobId = await createTtsJob({
    text,
    voiceId,
    voiceProvider,
    modelId,
    splitType: "smart",
    voiceSettings,
    runId,
  });
  log(
    runId,
    "debug",
    `69labs TTS job ${jobId.slice(0, 8)}… (${voiceProvider}/${voiceId}, speed=${voiceSettings.speed ?? "default"})`,
    { stage: "tts" }
  );
  await pollJob("tts", jobId, runId, "tts");
  await downloadJob("tts", jobId, outPath);
  // NOTE: no applyAudioTempo here — speed is native (voiceSettings.speed above).
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Kokoro TTS via the ai33.pro V3 unified API. Kokoro is a different, ~50% cheaper
 * model with its OWN voices (kokoro_af_heart, kokoro_am_adam, …) — NOT ElevenLabs
 * ids. It exposes a NATIVE speed (0.5–1.5), so TTS_SPEED is passed in-request and
 * we do NOT run atempo afterwards (doing both would double-slow the voice). Uses
 * the same AI33PRO_API_KEY as the ElevenLabs ai33pro path.
 */
async function kokoroTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = resolveKokoroVoiceId(getSetting("TTS_VOICE_ID") || "");
  const speedRaw = parseFloat(getSetting("TTS_SPEED") || "1");
  const speed = Number.isFinite(speedRaw) ? clamp(speedRaw, 0.5, 1.5) : 1;

  const taskId = await createV3SpeechTask(text, { voiceId, speed, withTranscript: false });
  log(runId, "debug", `Kokoro TTS task ${taskId.slice(0, 8)}… (${voiceId}, speed=${speed})`, {
    stage: "tts",
  });

  let task;
  try {
    task = await pollV3Task(taskId, runId, "tts");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg} — check the Kokoro voice "${voiceId}" is valid for this ai33.pro account.`
    );
  }
  await downloadV3Task(task, outPath);
  // NOTE: no applyAudioTempo here — speed is native (passed in the request above).
}

/**
 * Normalizes a Kokoro voice id to the ai33.pro V3 `kokoro_<voice>` form. Accepts a
 * bare Kokoro voice ("af_heart"), the already-prefixed form ("kokoro_af_heart"),
 * or a mistakenly-pasted other-provider prefix (swapped for kokoro_). Empty input
 * → a sensible default so it works out of the box.
 */
function resolveKokoroVoiceId(raw: string): string {
  let v = raw.trim();
  if (!v) return "kokoro_af_heart";
  v = v.replace(/^(elevenlabs_|minimax_|clone_|edge_)/i, "");
  if (!/^kokoro_/i.test(v)) v = `kokoro_${v}`;
  return v;
}

/**
 * MiniMax TTS via the DIRECT official API (bypasses the ai33.pro proxy entirely
 * — used when that proxy is flaky). MiniMax has its OWN voices (e.g.
 * "English_Graceful_Lady") — NOT ElevenLabs ids — and a NATIVE speed (0.5–2.0),
 * so TTS_SPEED is passed in-request and we do NOT run atempo. Needs MINIMAX_API_KEY
 * (and MINIMAX_GROUP_ID if the account requires it).
 */
async function minimaxTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = (getSetting("TTS_VOICE_ID") || "").trim() || "English_Graceful_Lady";
  const model = getSetting("MINIMAX_MODEL") || "speech-02-hd";
  const speedRaw = parseFloat(getSetting("TTS_SPEED") || "1");
  const speed = Number.isFinite(speedRaw) ? clamp(speedRaw, 0.5, 2) : 1;

  log(runId, "debug", `MiniMax TTS (${model} / ${voiceId}, speed=${speed})`, { stage: "tts" });
  await synthesizeMinimax(text, outPath, { voiceId, model, speed });
  // NOTE: no applyAudioTempo — speed is native (voice_setting.speed above).
}

/**
 * Normalizes a pasted voice id. ai33.pro's dashboard lists ElevenLabs voices as
 * "elevenlabs_<id>", but the TTS API (and 69labs) want the BARE ElevenLabs id
 * (e.g. "KeU8nqWFDbaoi0QVUjD3"). If the user pastes the prefixed form, strip the
 * leading "elevenlabs_" — otherwise the service doesn't recognise the voice and
 * silently falls back to a default, so the output voice doesn't match the id.
 * Only the known display prefix is stripped; a correct bare id is untouched.
 */
function normalizeVoiceId(raw: string): string {
  return raw.trim().replace(/^elevenlabs_/i, "");
}

/**
 * Synthesizes one scene's narration to sceneN.mp3 in `outDir`, via whichever
 * provider TTS_PROVIDER selects (ai33pro default, or 69labs). Speed is handled
 * inside dispatchTts, so this function just dispatches then probes duration.
 */
export async function synthesizeScene(
  runId: string,
  scene: Scene,
  outDir: string,
  options: TtsOptions = {}
): Promise<TtsResult> {
  const provider = resolveTtsProvider();
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp3`;
  const filePath = path.join(outDir, fileName);

  log(runId, "info", `TTS scene #${scene.index} (${provider})`, {
    stage: "tts",
    data: { text: scene.text.slice(0, 80) },
  });

  // dispatchTts applies TTS_SPEED itself (atempo for ai33pro, native for 69labs).
  await dispatchTts(runId, scene.text, filePath, options);

  const durationSec = await probeDurationSafe(filePath);

  log(runId, "success", `TTS done: ${fileName} (${durationSec.toFixed(1)}s)`, {
    stage: "tts",
  });
  return { filePath, durationSec };
}

/**
 * Single-shot: synthesize the WHOLE concatenated script in ONE continuous
 * voiceover, written to `outPath`.
 *
 * Used by single-shot voiceover mode (tts-align.ts) so the narration flows as
 * one performance — no per-scene intonation arcs to stitch and no mid-sentence
 * pauses where one scene ends and the next begins.
 *
 * ai33pro / ElevenLabs has a per-request character limit, so a long script is
 * chunked at SENTENCE boundaries (never mid-sentence) with each chunk capped at
 * ~2500 chars. Each chunk is dispatched via dispatchTts — which means each chunk
 * is ALREADY speed-correct + provider-correct — then the chunk mp3s are
 * concatenated with ffmpeg's concat demuxer. Speed is applied PER-CHUNK inside
 * dispatchTts, so we MUST NOT apply it again on the concatenated file.
 */
export async function synthesizeFullScript(
  runId: string,
  text: string,
  outPath: string,
  options: TtsOptions = {}
): Promise<TtsResult> {
  const provider = (getSetting("TTS_PROVIDER") || "ai33pro").toLowerCase();
  log(runId, "info", `TTS full script (${provider}, ${text.length} chars)`, {
    stage: "tts",
  });

  // Chunk at sentence boundaries (. ! ? … and unicode variants), each chunk
  // ≤ MAX_CHARS. A single sentence longer than the cap is sent whole rather
  // than split mid-sentence.
  const MAX_CHARS = 2500;
  const chunks = chunkAtSentences(text, MAX_CHARS);

  if (chunks.length === 1) {
    // One call — dispatch straight to outPath (already speed/provider-correct).
    await dispatchTts(runId, chunks[0], outPath, options);
  } else {
    log(runId, "info", `Long script — chunking into ${chunks.length} TTS calls (sentence-aligned)`, {
      stage: "tts",
    });

    const chunkPaths: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outPath.replace(/\.mp3$/i, `__chunk${String(i).padStart(2, "0")}.mp3`);
      log(runId, "info", `TTS chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`, {
        stage: "tts",
      });
      // Each chunk is dispatched → speed (TTS_SPEED) is applied here, per chunk.
      await dispatchTts(runId, chunks[i], chunkPath, options);
      chunkPaths.push(chunkPath);
    }

    // Concat the chunk mp3s into outPath with ffmpeg's concat demuxer (stream
    // copy — no re-encode, so it's instant and lossless).
    concatMp3s(chunkPaths, outPath);

    // Clean up chunk files.
    for (const p of chunkPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  // NOTE: speed (TTS_SPEED) was ALREADY applied per-chunk inside dispatchTts.
  // We deliberately do NOT call applyAudioTempo on the concatenated file —
  // doing so would slow the voice a second time (double-slow).

  const durationSec = await probeDurationSafe(outPath);
  log(
    runId,
    "success",
    `TTS full script done: ${path.basename(outPath)} (${durationSec.toFixed(1)}s)`,
    { stage: "tts" }
  );
  return { filePath: outPath, durationSec };
}

/**
 * Splits `text` into chunks of at most `maxChars`, breaking only on sentence
 * boundaries. If a single sentence exceeds `maxChars` it is emitted whole (we
 * never cut mid-sentence — that's the whole point of single-shot synthesis).
 */
function chunkAtSentences(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];

  // Match a run of non-terminator chars followed by one or more sentence
  // enders (. ! ? … and the full-width variants) plus trailing whitespace.
  const sentences = trimmed.match(/[^.!?…。！？]+[.!?…。！？]+[\s]*|[^.!?…。！？]+$/g) ?? [trimmed];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > maxChars) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length > 0 ? chunks : [trimmed];
}

/**
 * Concatenates several mp3 files into `outPath` using ffmpeg's concat demuxer
 * with stream copy (no re-encode). Mirrors the per-scene concatSimple approach
 * but for audio-only files.
 */
function concatMp3s(chunkPaths: string[], outPath: string): void {
  const listPath = outPath.replace(/\.mp3$/i, `__concat.txt`);
  // Escape backslashes (Windows paths) and single quotes for ffmpeg's
  // concat-demuxer line syntax `file '...'`.
  const listLines = chunkPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, listLines + "\n", "utf-8");

  const bin = resolveFfmpegBinary();
  const r = spawnSync(
    bin,
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath],
    { stdio: "pipe" }
  );
  try { fs.unlinkSync(listPath); } catch {}
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg mp3 concat failed (rc=${r.status}): ${r.stderr?.toString().slice(-300)}`
    );
  }
}
