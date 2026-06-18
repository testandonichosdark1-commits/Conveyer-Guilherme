import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { DATA_DIR } from "../run-paths";

const HEYGEN_API_BASE = "https://api.heygen.com";

interface HeyGenCreateResponse {
  data?: {
    video_id?: string;
    id?: string;
    status?: string;
    output_format?: string;
  };
  error?: unknown;
  message?: string;
}

interface HeyGenVideoResponse {
  data?: {
    id?: string;
    status?: string;
    video_url?: string;
    captioned_video_url?: string;
    thumbnail_url?: string;
    gif_url?: string;
    subtitle_url?: string;
    duration?: number;
    failure_code?: string;
    failure_message?: string;
    video_page_url?: string;
  };
  error?: unknown;
  message?: string;
}

interface HeyGenAssetUploadResponse {
  data?: {
    asset_id?: string;
    url?: string;
    mime_type?: string;
    size_bytes?: number;
  };
  error?: unknown;
  message?: string;
}

export interface HeyGenVideoResult {
  ok: true;
  videoId: string;
  status: string;
  cached: boolean;
  outputPath: string;
  videoUrl?: string;
  duration?: number;
}

export interface HeyGenIntroResult {
  ok: true;
  outputPath: string;
  heygenVideoPath: string;
  introAudioPath: string;
  seconds: number;
  videoId: string;
  cached: boolean;
  duration?: number;
}

export type HeyGenTestResult = HeyGenVideoResult;

function requiredSetting(key: "HEYGEN_API_KEY" | "HEYGEN_AVATAR_ID" | "HEYGEN_VOICE_ID"): string {
  const value = getSetting(key).trim();
  if (!value) throw new Error(`${key} is missing. Fill it in Settings, save, then try again.`);
  return value;
}

function normalizeAspectRatio(value: string): "16:9" | "9:16" | "1:1" | "4:5" | "5:4" | "auto" {
  const v = value.trim();
  if (v === "9:16" || v === "1:1" || v === "4:5" || v === "5:4" || v === "auto") return v;
  return "16:9";
}

function normalizeOutputFormat(value: string): "mp4" | "webm" {
  return value.trim().toLowerCase() === "webm" ? "webm" : "mp4";
}

function ensureFfmpegPaths(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (!ffmpegPath) return;
  ffmpeg.setFfmpegPath(ffmpegPath);
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
}

function safeErrorFromJson(json: unknown): string {
  if (!json || typeof json !== "object") return "Unknown HeyGen error";
  const obj = json as Record<string, unknown>;
  const message = obj.message;
  if (typeof message === "string" && message.trim()) return message;
  const error = obj.error;
  if (typeof error === "string" && error.trim()) return error;
  try {
    return JSON.stringify(json).slice(0, 1200);
  } catch {
    return "Unknown HeyGen error";
  }
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 1200) };
    }
  }
  if (!res.ok) {
    throw new Error(`HeyGen HTTP ${res.status}: ${safeErrorFromJson(json)}`);
  }
  return json as T;
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HeyGen download HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, Buffer.from(bytes));
}

function sha1Text(input: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

function sha1File(filePath: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
}

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function uploadHeyGenAsset(filePath: string, apiKey: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  const mimeType = mimeForFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), path.basename(filePath));

  const res = await fetch(`${HEYGEN_API_BASE}/v3/assets`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Idempotency-Key": `conveyer-asset-${sha1File(filePath)}`,
    },
    body: form,
  });
  const json = await readJsonResponse<HeyGenAssetUploadResponse>(res);
  const assetId = json.data?.asset_id;
  if (!assetId) throw new Error(`HeyGen asset upload did not return asset_id: ${safeErrorFromJson(json)}`);
  return assetId;
}

async function createHeyGenAvatarVideo(args: {
  apiKey: string;
  avatarId: string;
  title: string;
  outputPath: string;
  cacheKey: string;
  script?: string;
  voiceId?: string;
  audioAssetId?: string;
}): Promise<HeyGenVideoResult> {
  const aspectRatio = normalizeAspectRatio(getSetting("HEYGEN_ASPECT_RATIO") || "16:9");
  const outputFormat = normalizeOutputFormat(getSetting("HEYGEN_OUTPUT_FORMAT") || "mp4");

  const body: Record<string, unknown> = {
    type: "avatar",
    avatar_id: args.avatarId,
    title: args.title,
    aspect_ratio: aspectRatio,
    output_format: outputFormat,
    resolution: "720p",
  };

  if (args.audioAssetId) {
    body.audio_asset_id = args.audioAssetId;
  } else {
    body.script = args.script;
    if (args.voiceId) body.voice_id = args.voiceId;
  }

  const createRes = await fetch(`${HEYGEN_API_BASE}/v3/videos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.apiKey,
      "Idempotency-Key": `conveyer-video-${args.cacheKey}`,
    },
    body: JSON.stringify(body),
  });

  const createJson = await readJsonResponse<HeyGenCreateResponse>(createRes);
  const videoId = createJson.data?.video_id || createJson.data?.id;
  if (!videoId) throw new Error(`HeyGen create response did not include video_id: ${safeErrorFromJson(createJson)}`);

  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  let lastStatus = createJson.data?.status || "submitted";

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const statusRes = await fetch(`${HEYGEN_API_BASE}/v3/videos/${encodeURIComponent(videoId)}`, {
      headers: { "x-api-key": args.apiKey },
    });
    const statusJson = await readJsonResponse<HeyGenVideoResponse>(statusRes);
    const data = statusJson.data;
    lastStatus = data?.status || (data?.video_url ? "completed" : lastStatus);

    if (data?.failure_code || data?.failure_message) {
      throw new Error(`HeyGen generation failed: ${data.failure_code || "failure"} ${data.failure_message || ""}`.trim());
    }

    if (data?.video_url) {
      await downloadFile(data.video_url, args.outputPath);
      return {
        ok: true,
        videoId,
        status: lastStatus,
        cached: false,
        outputPath: args.outputPath,
        videoUrl: data.video_url,
        duration: data.duration,
      };
    }
  }

  throw new Error(`HeyGen video timed out after 15 minutes. Last status: ${lastStatus}. Video id: ${videoId}`);
}

export async function generateHeyGenTestVideo(script?: string): Promise<HeyGenTestResult> {
  const apiKey = requiredSetting("HEYGEN_API_KEY");
  const avatarId = requiredSetting("HEYGEN_AVATAR_ID");
  const voiceId = requiredSetting("HEYGEN_VOICE_ID");
  const aspectRatio = normalizeAspectRatio(getSetting("HEYGEN_ASPECT_RATIO") || "16:9");
  const outputFormat = normalizeOutputFormat(getSetting("HEYGEN_OUTPUT_FORMAT") || "mp4");
  const cacheEnabled = (getSetting("HEYGEN_CACHE") || "on").trim().toLowerCase() !== "off";
  const cleanScript = (script || "This is a quick HeyGen host test for Conveyer.").trim();
  if (!cleanScript) throw new Error("HeyGen test script is empty.");

  const cacheKey = sha1Text({ avatarId, voiceId, script: cleanScript, aspectRatio, outputFormat, kind: "test" });
  const cacheDir = path.join(DATA_DIR, "heygen_cache");
  const outputPath = path.join(cacheDir, `heygen_test_${cacheKey}.${outputFormat}`);

  if (cacheEnabled && fs.existsSync(outputPath)) {
    return { ok: true, videoId: `cache:${cacheKey}`, status: "cached", cached: true, outputPath };
  }

  return createHeyGenAvatarVideo({
    apiKey,
    avatarId,
    voiceId,
    title: "Conveyer HeyGen Test",
    script: cleanScript,
    outputPath,
    cacheKey: `test-${cacheKey}`,
  });
}

export async function generateHeyGenAvatarFromAudio(audioPath: string, title = "Conveyer HeyGen Intro"): Promise<HeyGenVideoResult> {
  const apiKey = requiredSetting("HEYGEN_API_KEY");
  const avatarId = requiredSetting("HEYGEN_AVATAR_ID");
  const aspectRatio = normalizeAspectRatio(getSetting("HEYGEN_ASPECT_RATIO") || "16:9");
  const outputFormat = normalizeOutputFormat(getSetting("HEYGEN_OUTPUT_FORMAT") || "mp4");
  const cacheEnabled = (getSetting("HEYGEN_CACHE") || "on").trim().toLowerCase() !== "off";
  const audioHash = sha1File(audioPath);
  const cacheKey = sha1Text({ avatarId, audioHash, aspectRatio, outputFormat, kind: "audio_intro_v1" });
  const cacheDir = path.join(DATA_DIR, "heygen_cache");
  const outputPath = path.join(cacheDir, `heygen_audio_${cacheKey}.${outputFormat}`);

  if (cacheEnabled && fs.existsSync(outputPath)) {
    return { ok: true, videoId: `cache:${cacheKey}`, status: "cached", cached: true, outputPath };
  }

  const audioAssetId = await uploadHeyGenAsset(audioPath, apiKey);
  return createHeyGenAvatarVideo({
    apiKey,
    avatarId,
    title,
    audioAssetId,
    outputPath,
    cacheKey: `audio-${cacheKey}`,
  });
}

export async function extractIntroAudioClip(srcMediaPath: string, outAudioPath: string, seconds: number): Promise<void> {
  ensureFfmpegPaths();
  fs.mkdirSync(path.dirname(outAudioPath), { recursive: true });
  const duration = Math.max(1, Math.min(60, seconds));
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(srcMediaPath)
      .outputOptions([
        "-vn",
        `-t ${duration.toFixed(3)}`,
        "-c:a libmp3lame",
        "-q:a 3",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outAudioPath);
  });
}

async function normalizeVideoSegment(srcPath: string, outPath: string, seconds: number, trimStartSec = 0): Promise<void> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const [w, h] = resolution.split("x").map(Number);
  const videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg();
    if (trimStartSec > 0) cmd.inputOptions([`-ss ${trimStartSec.toFixed(3)}`]);
    cmd
      .input(srcPath)
      .videoFilters(videoFilter)
      .outputOptions([
        `-r ${fps}`,
        ...(seconds > 0 ? [`-t ${seconds.toFixed(3)}`] : []),
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

async function concatTwoClips(firstPath: string, secondPath: string, outPath: string): Promise<void> {
  ensureFfmpegPaths();
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(firstPath)
      .input(secondPath)
      .complexFilter("[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]")
      .outputOptions([
        "-map [v]",
        "-map [a]",
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

export async function applyHeyGenIntroToFinalVideo(finalVideoPath: string, seconds = 10): Promise<HeyGenIntroResult> {
  if (!fs.existsSync(finalVideoPath)) throw new Error(`Final video not found: ${finalVideoPath}`);
  const introSeconds = Math.max(1, Math.min(60, seconds));
  const runDir = path.dirname(finalVideoPath);
  const workDir = path.join(runDir, "heygen_intro");
  fs.mkdirSync(workDir, { recursive: true });

  const introAudioPath = path.join(workDir, `intro_${introSeconds.toFixed(0)}s.mp3`);
  await extractIntroAudioClip(finalVideoPath, introAudioPath, introSeconds);

  const heygen = await generateHeyGenAvatarFromAudio(introAudioPath, `Conveyer HeyGen Intro ${introSeconds}s`);

  const introNorm = path.join(workDir, "intro_heygen_normalized.mp4");
  const tailNorm = path.join(workDir, "tail_after_intro.mp4");
  const outPath = path.join(runDir, "final_heygen_intro.mp4");

  await normalizeVideoSegment(heygen.outputPath, introNorm, introSeconds, 0);
  await normalizeVideoSegment(finalVideoPath, tailNorm, 0, introSeconds);
  await concatTwoClips(introNorm, tailNorm, outPath);

  return {
    ok: true,
    outputPath: outPath,
    heygenVideoPath: heygen.outputPath,
    introAudioPath,
    seconds: introSeconds,
    videoId: heygen.videoId,
    cached: heygen.cached,
    duration: heygen.duration,
  };
}
