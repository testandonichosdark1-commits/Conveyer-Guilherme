import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsTask, pollTask, downloadTask, createMinimaxAi33proTask } from "./ai33pro";
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

type TtsOptions = Record<string, never>;

export type ResolvedTtsProvider =
  | "ai33pro"
  | "ai33pro-v3"
  | "69labs"
  | "kokoro"
  | "minimax"
  | "minimax-ai33pro"
  | "edge-ai33pro";

/**
 * The voice engine that will ACTUALLY be used for this run.
 *
 * ai33.pro ElevenLabs V3 support:
 *   TTS_PROVIDER=ai33pro-v3
 *   TTS_VOICE_ID=<ElevenLabs voice id>
 *   TTS_MODEL=eleven_multilingual_v2, eleven_turbo_v2_5, etc.
 *
 * Edge support:
 *   TTS_PROVIDER=edge-ai33pro
 *   TTS_VOICE_ID=en-US-GuyNeural, en-US-AriaNeural, etc.
 *
 * Edge voices use AI33PRO_API_KEY through the ai33.pro V3 API.
 * Do NOT fall back to V1 for Edge: the V1 endpoint is ElevenLabs-oriented and
 * appears as ElevenLabs in the ai33.pro dashboard.
 */
export function resolveTtsProvider(): ResolvedTtsProvider {
  const selected = (getSetting("TTS_PROVIDER") || "ai33pro").trim().toLowerCase();
  const hasAi33 = getSetting("AI33PRO_API_KEY").trim().length > 0;
  const has69 = getSetting("LABS69_API_KEY").trim().length > 0;
  const hasMinimax = getSetting("MINIMAX_API_KEY").trim().length > 0;

  if (
    selected === "ai33pro-v3" ||
    selected === "ai33-v3" ||
    selected === "elevenlabs-ai33pro-v3" ||
    selected === "elevenlabs-v3"
  ) {
    return hasAi33 || !has69 ? "ai33pro-v3" : "69labs";
  }

  if (selected === "edge-ai33pro" || selected === "edge" || selected === "edgetts") {
    if (hasAi33) return "edge-ai33pro";
    if (has69) return "69labs";
    return "edge-ai33pro";
  }

  if (selected === "minimax-ai33pro") {
    return hasAi33 || !hasMinimax ? "minimax-ai33pro" : "minimax";
  }

  if (selected === "minimax") {
    if (hasMinimax) return "minimax";
    if (hasAi33) return "minimax-ai33pro";
    if (has69) return "69labs";
    return "minimax";
  }

  if (selected === "kokoro") {
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
  const text = rawText.replace(/\s+/g, " ").trim();
  const provider = resolveTtsProvider();

  if (provider === "69labs") {
    await labs69Tts(runId, text, outPath);
  } else if (provider === "kokoro") {
    await kokoroTts(runId, text, outPath);
  } else if (provider === "minimax") {
    await minimaxTts(runId, text, outPath);
  } else if (provider === "minimax-ai33pro") {
    await minimaxAi33proTts(runId, text, outPath);
  } else if (provider === "edge-ai33pro") {
    await edgeAi33proTts(runId, text, outPath);
  } else if (provider === "ai33pro-v3") {
    await ai33proV3Tts(runId, text, outPath);
  } else {
    await ai33proTts(runId, text, outPath);
  }
}

async function ai33proTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = normalizeVoiceId(getSetting("TTS_VOICE_ID") || "");
  if (!voiceId) {
    throw new Error("No ai33pro voice set — paste an ElevenLabs voice id into Settings → TTS_VOICE_ID");
  }
  const modelId = getSetting("TTS_MODEL") || "eleven_multilingual_v2";
  const taskId = await createTtsTask(text, { voiceId, modelId });
  log(runId, "debug", `ai33pro TTS task ${taskId.slice(0, 8)}… (${modelId} / ${voiceId})`, { stage: "tts" });

  let task;
  try {
    task = await pollTask(taskId, runId, "tts");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg} — check the voice id "${voiceId}" and model "${modelId}" are valid for this ai33pro account.`);
  }
  await downloadTask(task, outPath);
  await maybeApplyTempo(runId, outPath, "ai33pro / atempo");
}

async function ai33proV3Tts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = resolveElevenLabsAi33proV3VoiceId(getSetting("TTS_VOICE_ID") || "");
  if (!voiceId) {
    throw new Error("No ai33pro V3 ElevenLabs voice set — paste an ElevenLabs voice id into Settings → TTS_VOICE_ID");
  }

  const modelId = getSetting("TTS_MODEL") || "eleven_multilingual_v2";
  const speed = readSpeed(0.5, 2, 1);

  try {
    const taskId = await createV3SpeechTask(text, { voiceId, modelId, speed, withTranscript: false });
    log(runId, "debug", `ElevenLabs (ai33pro V3) TTS task ${taskId.slice(0, 8)}… (${modelId} / ${voiceId}, speed=${speed})`, { stage: "tts" });
    const task = await pollV3Task(taskId, runId, "tts");
    await downloadV3Task(task, outPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isUnauthorizedError(msg)) {
      throw new Error(
        `${msg} — ElevenLabs via ai33.pro V3 requires access to the ai33.pro V3 API for this API key.`
      );
    }
    throw new Error(`${msg} — check the ElevenLabs V3 voice "${voiceId}" and model "${modelId}" are valid for this ai33.pro account.`);
  }
}

async function labs69Tts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = normalizeVoiceId(getSetting("TTS_VOICE_ID") || "");
  if (!voiceId) throw new Error("No voice set — paste an ElevenLabs voice id into Settings → TTS_VOICE_ID");

  const rawProvider = (getSetting("TTS_VOICE_PROVIDER") || "elevenlabs").toLowerCase();
  const voiceProvider =
    rawProvider === "elevenlabs" || rawProvider === "edgetts" || rawProvider === "voice-clone"
      ? (rawProvider as "elevenlabs" | "edgetts" | "voice-clone")
      : "elevenlabs";
  const modelId = getSetting("TTS_MODEL") || undefined;
  const voiceSettings: { speed?: number; stability?: number; similarityBoost?: number; style?: number; useSpeakerBoost?: boolean } = {};
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
  log(runId, "debug", `69labs TTS job ${jobId.slice(0, 8)}… (${voiceProvider}/${voiceId})`, { stage: "tts" });
  await pollJob("tts", jobId, runId, "tts");
  await downloadJob("tts", jobId, outPath);
}

async function kokoroTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = resolveKokoroVoiceId(getSetting("TTS_VOICE_ID") || "");
  const taskId = await createTtsTask(text, { voiceId, modelId: "kokoro" });
  log(runId, "debug", `Kokoro TTS task ${taskId.slice(0, 8)}… (${voiceId})`, { stage: "tts" });

  let task;
  try {
    task = await pollTask(taskId, runId, "tts");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg} — check the Kokoro voice "${voiceId}" is valid for this ai33.pro account.`);
  }
  await downloadTask(task, outPath);
  await maybeApplyTempo(runId, outPath, "Kokoro / atempo");
}

async function minimaxTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = (getSetting("TTS_VOICE_ID") || "").trim() || "English_Graceful_Lady";
  const model = getSetting("MINIMAX_MODEL") || "speech-02-hd";
  const speed = readSpeed(0.5, 2, 1);
  log(runId, "debug", `MiniMax TTS (${model} / ${voiceId}, speed=${speed})`, { stage: "tts" });
  await synthesizeMinimax(text, outPath, { voiceId, model, speed });
}

async function minimaxAi33proTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = resolveMinimaxAi33proVoiceId(getSetting("TTS_VOICE_ID") || "");
  const model = getSetting("MINIMAX_MODEL") || "speech-02-hd";
  const speed = readSpeed(0.5, 2, 1);
  const taskId = await createMinimaxAi33proTask(text, { voiceId, model, speed });
  log(runId, "debug", `MiniMax (ai33pro) task ${taskId.slice(0, 8)}… (${model} / ${voiceId}, speed=${speed})`, { stage: "tts" });

  let task;
  try {
    task = await pollTask(taskId, runId, "tts");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${msg} — check the MiniMax voice "${voiceId}" is valid for this ai33.pro account.`);
  }
  await downloadTask(task, outPath);
}

async function edgeAi33proTts(runId: string, text: string, outPath: string): Promise<void> {
  const voiceId = resolveEdgeAi33proVoiceId(getSetting("TTS_VOICE_ID") || "");
  const speed = readSpeed(0.5, 1.5, 1);

  try {
    const taskId = await createV3SpeechTask(text, { voiceId, speed, withTranscript: false });
    log(runId, "debug", `Edge (ai33pro V3) TTS task ${taskId.slice(0, 8)}… (${voiceId}, speed=${speed})`, { stage: "tts" });
    const task = await pollV3Task(taskId, runId, "tts");
    await downloadV3Task(task, outPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isUnauthorizedError(msg)) {
      throw new Error(
        `${msg} — Edge via ai33.pro requires access to the ai33.pro V3 API for this API key. ` +
        `I did not fall back to V1 because V1 is routed as ElevenLabs in the ai33.pro dashboard.`
      );
    }
    throw new Error(`${msg} — check the Edge voice "${voiceId}" is valid for this ai33.pro account.`);
  }
}

function isUnauthorizedError(msg: string): boolean {
  return /unauthorized|http\s*401|http\s*403/i.test(msg);
}

function normalizeVoiceId(raw: string): string {
  return raw.trim().replace(/^elevenlabs_/i, "");
}

function resolveElevenLabsAi33proV3VoiceId(raw: string): string {
  let v = raw.trim();
  if (!v) return "";
  v = v.replace(/^(edge_|edgetts_|minimax_|kokoro_|clone_)/i, "");
  if (!/^elevenlabs_/i.test(v)) v = `elevenlabs_${v}`;
  return v;
}

function resolveKokoroVoiceId(raw: string): string {
  let v = raw.trim();
  if (!v) return "kokoro_af_heart";
  v = v.replace(/^(elevenlabs_|minimax_|clone_|edge_|edgetts_)/i, "");
  if (!/^kokoro_/i.test(v)) v = `kokoro_${v}`;
  return v;
}

function resolveMinimaxAi33proVoiceId(raw: string): string {
  const v = raw.trim() || "English_Graceful_Lady";
  return v.replace(/^(elevenlabs_|minimax_|kokoro_|clone_|edge_|edgetts_)/i, "");
}

function resolveEdgeAi33proVoiceId(raw: string): string {
  let v = raw.trim();
  if (!v) v = "en-US-GuyNeural";
  v = v.replace(/^(elevenlabs_|minimax_|kokoro_|clone_)/i, "");
  v = v.replace(/^(edge_|edgetts_)/i, "");
  return `edge_${v}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readSpeed(min: number, max: number, fallback: number): number {
  const speed = parseFloat(getSetting("TTS_SPEED") || String(fallback));
  return Number.isFinite(speed) ? clamp(speed, min, max) : fallback;
}

async function maybeApplyTempo(runId: string, outPath: string, label: string): Promise<void> {
  const speed = parseFloat(getSetting("TTS_SPEED") || "1");
  if (!Number.isFinite(speed) || Math.abs(speed - 1) <= 0.01) return;
  try {
    await applyAudioTempo(outPath, speed);
    log(runId, "debug", `Voice speed ${speed}× applied (${label})`, { stage: "tts" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(runId, "warn", `Voice-speed adjust failed (using original): ${msg.slice(0, 150)}`, { stage: "tts" });
  }
}

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

  await dispatchTts(runId, scene.text, filePath, options);
  const durationSec = await probeDurationSafe(filePath);
  log(runId, "success", `TTS done: ${fileName} (${durationSec.toFixed(1)}s)`, { stage: "tts" });
  return { filePath, durationSec };
}

export async function synthesizeFullScript(
  runId: string,
  text: string,
  outPath: string,
  options: TtsOptions = {}
): Promise<TtsResult> {
  const provider = resolveTtsProvider();
  log(runId, "info", `TTS full script (${provider}, ${text.length} chars)`, { stage: "tts" });

  const MAX_CHARS = 2500;
  const chunks = chunkAtSentences(text, MAX_CHARS);

  if (chunks.length === 1) {
    await dispatchTts(runId, chunks[0], outPath, options);
  } else {
    log(runId, "info", `Long script — chunking into ${chunks.length} TTS calls (sentence-aligned)`, { stage: "tts" });
    const chunkPaths: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outPath.replace(/\.mp3$/i, `__chunk${String(i).padStart(2, "0")}.mp3`);
      log(runId, "info", `TTS chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`, { stage: "tts" });
      await dispatchTts(runId, chunks[i], chunkPath, options);
      chunkPaths.push(chunkPath);
    }
    concatMp3s(chunkPaths, outPath);
    for (const p of chunkPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  const durationSec = await probeDurationSafe(outPath);
  log(runId, "success", `TTS full script done: ${path.basename(outPath)} (${durationSec.toFixed(1)}s)`, { stage: "tts" });
  return { filePath: outPath, durationSec };
}

function chunkAtSentences(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return [trimmed];
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

function concatMp3s(chunkPaths: string[], outPath: string): void {
  const listPath = outPath.replace(/\.mp3$/i, `__concat.txt`);
  const listLines = chunkPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, listLines + "\n", "utf-8");

  const bin = resolveFfmpegBinary();
  const r = spawnSync(bin, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], {
    stdio: "pipe",
  });
  try { fs.unlinkSync(listPath); } catch {}
  if (r.status !== 0) {
    throw new Error(`ffmpeg mp3 concat failed (rc=${r.status}): ${r.stderr?.toString().slice(-300)}`);
  }
}
