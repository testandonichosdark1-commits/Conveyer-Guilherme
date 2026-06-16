import fs from "node:fs";
import { getSetting } from "../settings";

/**
 * MiniMax Text-to-Speech (T2A v2) — DIRECT official API (not via the ai33.pro
 * proxy). A self-contained voiceover engine, used when TTS_PROVIDER = minimax.
 *
 * Docs: https://platform.minimax.io/docs/api-reference/speech-t2a-http
 *
 * Flow (synchronous, one request):
 *   POST https://api.minimax.io/v1/t2a_v2   (optional ?GroupId=… )
 *     headers: Authorization: Bearer <MINIMAX_API_KEY>, Content-Type: application/json
 *     body: { model, text, voice_setting{voice_id,speed,vol,pitch},
 *             audio_setting{format:"mp3",…}, output_format:"hex" }
 *   → response data.audio is a HEX string of the mp3 bytes; base_resp.status_code 0 = OK.
 *
 * Voices are MiniMax's OWN ids (e.g. "English_Graceful_Lady") — NOT ElevenLabs.
 * Speed is native ([0.5, 2]), so callers pass TTS_SPEED here and DON'T run atempo.
 */

const BASE = "https://api.minimax.io/v1/t2a_v2";
const TIMEOUT_MS = 120_000;

export interface MinimaxTtsOptions {
  /** MiniMax voice id, e.g. "English_Graceful_Lady". */
  voiceId: string;
  /** MiniMax model, e.g. "speech-02-hd". */
  model: string;
  /** 0.5–2.0 native speed (no ffmpeg post-process needed). */
  speed?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Synthesizes `text` to an mp3 at `outPath` via MiniMax T2A v2. */
export async function synthesizeMinimax(text: string, outPath: string, opts: MinimaxTtsOptions): Promise<void> {
  const apiKey = getSetting("MINIMAX_API_KEY").trim();
  if (!apiKey) throw new Error("MINIMAX_API_KEY is not set (Settings → MiniMax key)");
  if (!opts.voiceId) throw new Error("No MiniMax voice set — paste a MiniMax voice id into /settings → Voice id");

  // GroupId is required on some MiniMax accounts/regions and absent on others —
  // append it only when the user provided one (works either way).
  const groupId = getSetting("MINIMAX_GROUP_ID").trim();
  const url = groupId ? `${BASE}?GroupId=${encodeURIComponent(groupId)}` : BASE;

  const body = JSON.stringify({
    model: opts.model || "speech-02-hd",
    text,
    stream: false,
    output_format: "hex",
    voice_setting: {
      voice_id: opts.voiceId,
      speed: clamp(opts.speed ?? 1, 0.5, 2),
      vol: 1,
      pitch: 0,
    },
    audio_setting: { sample_rate: 44100, bitrate: 128000, format: "mp3", channel: 1 },
  });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 400);
    throw new Error(`MiniMax T2A HTTP ${resp.status}: ${txt}`);
  }
  const json = (await resp.json()) as {
    data?: { audio?: string; status?: number };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const code = json.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(
      `MiniMax T2A error ${code}: ${json.base_resp?.status_msg || "unknown"} — check the voice id "${opts.voiceId}", model "${opts.model}", and that your MiniMax account has credits.`
    );
  }
  const hex = json.data?.audio;
  if (!hex) {
    throw new Error(`MiniMax T2A returned no audio (base_resp: ${JSON.stringify(json.base_resp)})`);
  }
  // Buffer.from(hex,"hex") silently truncates at the first invalid nibble, which
  // would write a corrupt mp3 that only fails later in ffmpeg. Validate first.
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("MiniMax T2A: audio field is not valid hex (truncated/garbled response)");
  }
  const buf = Buffer.from(hex, "hex");
  if (buf.byteLength === 0) throw new Error("MiniMax T2A: decoded audio is empty");
  fs.writeFileSync(outPath, buf);
}
