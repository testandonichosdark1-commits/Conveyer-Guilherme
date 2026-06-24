import db from "./db";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting and Gemini Vision scoring
  "PEXELS_API_KEY",          // Pexels — stock b-roll
  "PIXABAY_API_KEY",         // Pixabay — second stock source (video+photo). Optional; empty = Pexels only.
  "COVERR_API_KEY",         // Coverr — optional third stock video source.
  "AI33PRO_API_KEY",         // ai33.pro — ElevenLabs voices proxy
  "GROQ_API_KEY",            // Groq Whisper — word-level transcription for single-shot voiceover mode

  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (Gemini / OpenAI / DeepSeek) ──────────────────
  "SCENE_SPLIT_PROVIDER",    // gemini (default) | openai
  "SCENE_SPLIT_MODEL",       // e.g. gemini-flash-latest, deepseek-chat, gpt-4o-mini
  "OPENAI_API_KEY",          // custom API key (for DeepSeek, OpenAI, OpenRouter, etc.)
  "OPENAI_BASE_URL",         // custom base URL (e.g. https://api.deepseek.com)
  "VIDEO_CONTEXT",           // optional short channel/setting hint injected into scene split and footage scoring

  // ── Text-to-Speech (ai33.pro / ElevenLabs / MiniMax) ──────────────
  "TTS_PROVIDER",            // ai33pro | ai33pro-v3 | 69labs | kokoro | minimax | minimax-ai33pro | edge-ai33pro | local-mp3
  "LABS69_API_KEY",          // 69labs API key
  "MINIMAX_API_KEY",         // MiniMax direct T2A API key
  "MINIMAX_GROUP_ID",        // MiniMax GroupId
  "MINIMAX_MODEL",           // MiniMax TTS model, e.g. speech-02-hd
  "AI33PRO_POLL_MAX_MINUTES", // max minutes to wait for one ai33.pro TTS task before timing out
  "TTS_LOCAL_AUDIO_PATH",    // local MP3/WAV/M4A voiceover path used when TTS_PROVIDER=local-mp3
  "TTS_VOICE_PROVIDER",      // 69labs path only: elevenlabs | edgetts | voice-clone
  "TTS_VOICE_ID",            // narration voice id/name
  "TTS_MODEL",               // ElevenLabs model, e.g. eleven_multilingual_v2
  "TTS_SPEED",               // 0.5–2.0 playback tempo
  "TTS_MODE",                // single-shot | per-scene
  "MAX_CLIP_SECONDS",        // single-shot max length of one b-roll clip
  "MIN_SCENE_SECONDS",       // single-shot minimum seconds a visual stays on screen
  "MAX_PAUSE_SECONDS",       // single-shot max silence cap

  // ── HeyGen host/avatar segments ───────────────────────────────────
  "HEYGEN_MODE",             // off | host_segments | full_host (reserved)
  "HEYGEN_API_KEY",          // HeyGen API key. Secret; never commit real values.
  "HEYGEN_AVATAR_ID",        // HeyGen avatar id
  "HEYGEN_VOICE_ID",         // HeyGen voice id
  "HEYGEN_ASPECT_RATIO",     // 16:9 | 9:16 | 1:1
  "HEYGEN_OUTPUT_FORMAT",    // mp4
  "HEYGEN_CACHE",            // on | off

  // ── Stock footage (multi-source) ──────────────────────────────────
  "FOOTAGE_SOURCES",           // comma list of libraries to query, in order. Default "pexels,pixabay".
  "FOOTAGE_AI_PICK",           // on | off — Gemini Vision scores candidate thumbnails
  "GEMINI_VISION_MODEL",       // Gemini model used for vision/preview image scoring
  "PRODUCTION_MODE",           // quality | balanced (default) | batch
  "FOOTAGE_SEARCH_ATTEMPTS",   // default: 3
  "VISION_CONCURRENCY",        // default: 2
  "VISION_CANDIDATE_LIMIT",    // default: 8
  "VISION_COOLDOWN_ON_429_SEC", // default: 120
  "STOCK_FOOTAGE_ORIENTATION", // landscape | portrait | square
  "STOCK_FOOTAGE_MAX_HEIGHT",  // 720 | 1080 | 2160
  "STOCK_FOOTAGE_MIN_DURATION", // seconds
  "SCENE_PHOTO_RATIO",         // 0–100
  "SCENE_MIX_MODE",            // random | alternating
  "IMAGE_RATIO",               // 16:9 | 9:16 | 1:1

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",
  "VIDEO_FPS",
  "SCENE_DURATION_SECONDS",
  "TRANSITION_MIN",
  "TRANSITION_MAX",
  "SCENE_TAIL_SILENCE",

  // ── On-screen text (hook emphasis) ────────────────────────────────
  "TEXT_OVERLAY_MODE",
  "TEXT_OVERLAY_HOOK_SECONDS",
  "TEXT_OVERLAY_FONT",
  "CAPTION_LEAD_IN_SEC",
  "CAPTION_TRAIL_SEC",
  "CAPTION_FONT_SIZE_PERCENT",
  "CAPTION_POSITION_Y_PERCENT",
  "CAPTION_DETECTION_MODE",
  "STEP_OVERLAY_TRAIL_SEC",
  "STEP_OVERLAY_ANIMATION",
  "STEP_OVERLAY_ENTER_SEC",
  "STEP_OVERLAY_EXIT_SEC",

  // ── Performance / Concurrency ─────────────────────────────────────
  "TTS_CONCURRENCY",
  "ANIMATION_CONCURRENCY",
  "ASSEMBLE_CONCURRENCY",

  // ── Reliability ───────────────────────────────────────────────────
  "FAILURE_THRESHOLD_PERCENT",

  // ── Google Drive backup (optional) ────────────────────────────────
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  "GDRIVE_REFRESH_TOKEN",
  "GDRIVE_CONNECTED_EMAIL",
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
  "GDRIVE_RUNS_FOLDER_ID",
  "GDRIVE_SYNC_ENABLED",
] as const;

/** Keys whose values are secrets and should be masked when sent to the UI. */
function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

export function getSetting(key: SettingKey): string {
  const row = getStmt.get(key) as { value: string } | undefined;
  let val = (row && row.value !== "") ? row.value : (process.env[key] ?? "");

  const mode = getProductionMode();
  if (mode === "batch") {
    if (key === "ANIMATION_CONCURRENCY" && (val === "" || val === "5")) return "2";
    if (key === "MAX_CLIP_SECONDS" && (val === "" || val === "7")) return "12";
    if (key === "SCENE_PHOTO_RATIO" && (val === "" || val === "40")) return "50";
    if (key === "FOOTAGE_SEARCH_ATTEMPTS" && (val === "" || val === "3")) return "2";
    if (key === "VISION_CONCURRENCY" && (val === "" || val === "2")) return "1";
    if (key === "VISION_CANDIDATE_LIMIT" && (val === "" || val === "8")) return "6";
    if (key === "VISION_COOLDOWN_ON_429_SEC" && (val === "" || val === "120")) return "120";
  }

  return val;
}

function getProductionMode(): string {
  const row = getStmt.get("PRODUCTION_MODE") as { value: string } | undefined;
  let val = (row && row.value !== "") ? row.value : (process.env["PRODUCTION_MODE"] ?? "");
  return val.trim().toLowerCase() || "balanced";
}

export function setSetting(key: SettingKey, value: string) {
  upsertStmt.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  return out;
}

/** Safe version — masks secret keys/tokens/secrets. */
export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isSecretKey(k)) {
      masked[k] = v ? `${v.slice(0, 4)}…${v.slice(-4)}` : "";
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export const DEFAULTS: Record<SettingKey, string> = {
  // Required API keys
  GOOGLE_API_KEY: "",
  PEXELS_API_KEY: "",
  PIXABAY_API_KEY: "",
  COVERR_API_KEY: "",
  AI33PRO_API_KEY: "",
  GROQ_API_KEY: "",

  FFMPEG_PATH: "",

  // Storage
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "gemini",
  SCENE_SPLIT_MODEL: "gemini-flash-latest",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  VIDEO_CONTEXT: "",

  // TTS
  TTS_PROVIDER: "ai33pro",
  LABS69_API_KEY: "",
  MINIMAX_API_KEY: "",
  MINIMAX_GROUP_ID: "",
  MINIMAX_MODEL: "speech-02-hd",
  AI33PRO_POLL_MAX_MINUTES: "45",
  TTS_LOCAL_AUDIO_PATH: "",
  TTS_VOICE_PROVIDER: "elevenlabs",
  TTS_VOICE_ID: "",
  TTS_MODEL: "eleven_multilingual_v2",
  TTS_SPEED: "1.0",
  TTS_MODE: "single-shot",
  MAX_CLIP_SECONDS: "7",
  MIN_SCENE_SECONDS: "3",
  MAX_PAUSE_SECONDS: "0.6",

  // HeyGen host/avatar segments. Empty by default; user fills locally in Settings/.env.
  HEYGEN_MODE: "off",
  HEYGEN_API_KEY: "",
  HEYGEN_AVATAR_ID: "",
  HEYGEN_VOICE_ID: "",
  HEYGEN_ASPECT_RATIO: "16:9",
  HEYGEN_OUTPUT_FORMAT: "mp4",
  HEYGEN_CACHE: "on",

  // Stock footage
  FOOTAGE_SOURCES: "pexels,pixabay",
  FOOTAGE_AI_PICK: "on",
  GEMINI_VISION_MODEL: "gemini-flash-latest",
  PRODUCTION_MODE: "balanced",
  FOOTAGE_SEARCH_ATTEMPTS: "3",
  VISION_CONCURRENCY: "2",
  VISION_CANDIDATE_LIMIT: "8",
  VISION_COOLDOWN_ON_429_SEC: "120",
  STOCK_FOOTAGE_ORIENTATION: "landscape",
  STOCK_FOOTAGE_MAX_HEIGHT: "1080",
  STOCK_FOOTAGE_MIN_DURATION: "4",
  SCENE_PHOTO_RATIO: "40",
  SCENE_MIX_MODE: "random",
  IMAGE_RATIO: "16:9",

  // Video assembly
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  SCENE_DURATION_SECONDS: "5",
  TRANSITION_MIN: "0.3",
  TRANSITION_MAX: "0.7",
  SCENE_TAIL_SILENCE: "0.4",

  // Captions / step overlays
  TEXT_OVERLAY_MODE: "hook",
  TEXT_OVERLAY_HOOK_SECONDS: "30",
  TEXT_OVERLAY_FONT: "",
  CAPTION_LEAD_IN_SEC: "0",
  CAPTION_TRAIL_SEC: "0.35",
  CAPTION_FONT_SIZE_PERCENT: "13",
  CAPTION_POSITION_Y_PERCENT: "72",
  CAPTION_DETECTION_MODE: "literal",
  STEP_OVERLAY_TRAIL_SEC: "1.0",
  STEP_OVERLAY_ANIMATION: "slide-up",
  STEP_OVERLAY_ENTER_SEC: "0.35",
  STEP_OVERLAY_EXIT_SEC: "0.25",

  // Performance
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "5",
  ASSEMBLE_CONCURRENCY: "4",

  // Reliability
  FAILURE_THRESHOLD_PERCENT: "25",

  // Google Drive backup
  GDRIVE_CLIENT_ID: "",
  GDRIVE_CLIENT_SECRET: "",
  GDRIVE_REFRESH_TOKEN: "",
  GDRIVE_CONNECTED_EMAIL: "",
  GDRIVE_FINAL_VIDEOS_FOLDER_ID: "",
  GDRIVE_RUNS_FOLDER_ID: "",
  GDRIVE_SYNC_ENABLED: "",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
}