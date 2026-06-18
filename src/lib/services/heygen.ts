import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

export interface HeyGenTestResult {
  ok: true;
  videoId: string;
  status: string;
  cached: boolean;
  outputPath: string;
  videoUrl?: string;
  duration?: number;
}

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

function buildCacheKey(input: { avatarId: string; voiceId: string; script: string; aspectRatio: string; outputFormat: string }) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
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

  const cacheKey = buildCacheKey({ avatarId, voiceId, script: cleanScript, aspectRatio, outputFormat });
  const cacheDir = path.join(DATA_DIR, "heygen_cache");
  const outputPath = path.join(cacheDir, `heygen_test_${cacheKey}.${outputFormat}`);

  if (cacheEnabled && fs.existsSync(outputPath)) {
    return {
      ok: true,
      videoId: `cache:${cacheKey}`,
      status: "cached",
      cached: true,
      outputPath,
    };
  }

  const idempotencyKey = `conveyer-heygen-test-${cacheKey}`;
  const createRes = await fetch(`${HEYGEN_API_BASE}/v3/videos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      type: "avatar",
      avatar_id: avatarId,
      title: "Conveyer HeyGen Test",
      aspect_ratio: aspectRatio,
      output_format: outputFormat,
      script: cleanScript,
      voice_id: voiceId,
      resolution: "720p",
    }),
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
      headers: { "x-api-key": apiKey },
    });
    const statusJson = await readJsonResponse<HeyGenVideoResponse>(statusRes);
    const data = statusJson.data;
    lastStatus = data?.status || (data?.video_url ? "completed" : lastStatus);

    if (data?.failure_code || data?.failure_message) {
      throw new Error(`HeyGen generation failed: ${data.failure_code || "failure"} ${data.failure_message || ""}`.trim());
    }

    if (data?.video_url) {
      await downloadFile(data.video_url, outputPath);
      return {
        ok: true,
        videoId,
        status: lastStatus,
        cached: false,
        outputPath,
        videoUrl: data.video_url,
        duration: data.duration,
      };
    }
  }

  throw new Error(`HeyGen test timed out after 15 minutes. Last status: ${lastStatus}. Video id: ${videoId}`);
}
