import db from "./db";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting
  "PEXELS_API_KEY",          // Pexels — stock b-roll
  "PIXABAY_API_KEY",         // Pixabay — second stock source (video+photo, no attribution). Optional; empty = Pexels only.
  "AI33PRO_API_KEY",         // ai33.pro — ElevenLabs voices proxy
  "GROQ_API_KEY",            // Groq Whisper — word-level transcription for single-shot voiceover mode

  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (Gemini only) ─────────────────────────────────
  "SCENE_SPLIT_MODEL",       // e.g. gemini-flash-latest
  "VIDEO_CONTEXT",           // optional 1–2 sentence channel/setting hint, injected into scene-split as background DATA (never as commands). Capped ~300 chars. Empty = setting inferred automatically from the script.

  // ── Text-to-Speech (ai33.pro / ElevenLabs voices) ─────────────────
  "TTS_PROVIDER",            // voiceover engine: ai33pro (default) | 69labs. Both serve the SAME ElevenLabs voices; 69labs is just an alternate gateway.
  "LABS69_API_KEY",          // 69labs API key (vk_...). Only needed when TTS_PROVIDER = 69labs.
  "TTS_VOICE_PROVIDER",      // 69labs path only: elevenlabs (default) | edgetts | voice-clone. We use elevenlabs so the voice matches ai33pro.
  "TTS_VOICE_ID",            // ElevenLabs voice id (path-segment in ai33pro URL; also used by 69labs-elevenlabs)
  "TTS_MODEL",               // ElevenLabs model, e.g. eleven_multilingual_v2
  "TTS_SPEED",               // 0.5–2.0 playback tempo. <1 = slower/calmer voice (applied via ffmpeg, pitch-preserving)
  "TTS_MODE",                // single-shot (default) | per-scene. Single-shot synthesizes ONE continuous voiceover for the whole script then aligns scene boundaries via Groq Whisper word-timestamps — fixes mid-sentence pauses at scene boundaries.
  "MAX_CLIP_SECONDS",        // single-shot: max length of one b-roll clip (seconds). Longer scene ranges are split into equal sub-clips, each with its own Pexels asset. 0 = disabled (one clip per scene).
  "MIN_SCENE_SECONDS",       // single-shot: minimum seconds a visual stays on screen. Scenes shorter than this are merged with the next (keeping the first scene's footage) so the picture doesn't flip every 1-2s.
  "MAX_PAUSE_SECONDS",       // single-shot: cap every silence in the continuous voiceover to this many seconds (tames over-long pauses between sentences / at chunk seams). 0 = off.

  // ── Stock footage (multi-source) ──────────────────────────────────
  "FOOTAGE_SOURCES",           // comma list of libraries to query, in order. Default "pexels,pixabay".
  "FOOTAGE_AI_PICK",           // on (default) | off — let Gemini pick the most relevant candidate from all sources' results.
  "FOOTAGE_MATCH_STRICTNESS",  // off | normal (default) | strict — score each candidate's own description against the scene's queries; skip off-topic ones, fall through query 2/3, then best-available. A scene never fails because of this.
  "STOCK_FOOTAGE_ORIENTATION", // landscape | portrait | square
  "STOCK_FOOTAGE_MAX_HEIGHT",  // 720 | 1080 | 2160 — caps file size
  "STOCK_FOOTAGE_MIN_DURATION", // seconds — skip stingers shorter than this
  "SCENE_PHOTO_RATIO",         // 0–100, % of scenes that use a still photo (ken-burns) vs a video clip
  "SCENE_MIX_MODE",            // random | alternating — how photo scenes are distributed
  "IMAGE_RATIO",             // 16:9 | 9:16 | 1:1 — read by FFmpeg assembly

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",        // e.g. 1920x1080
  "VIDEO_FPS",               // 24 / 30 / 60
  "SCENE_DURATION_SECONDS",  // fallback duration when TTS length is unknown
  "TRANSITION_MIN",          // min crossfade length (s); each cut gets a random fade in [min,max]
  "TRANSITION_MAX",          // max crossfade length (s); max<=0 → hard cuts (no transitions)
  "SCENE_TAIL_SILENCE",      // silence appended to each clip's audio (seconds)

  // ── On-screen text (hook emphasis) ────────────────────────────────
  "TEXT_OVERLAY_MODE",       // off | hook (default) | all — pop key numbers/years/places as big text
  "TEXT_OVERLAY_HOOK_SECONDS", // when mode=hook, only show overlays inside the first N seconds
  "TEXT_OVERLAY_FONT",       // absolute path to a .ttf/.otf for the overlay; empty = auto-detect a bold system font

  // ── Performance / Concurrency ─────────────────────────────────────
  "TTS_CONCURRENCY",         // parallel TTS jobs
  "ANIMATION_CONCURRENCY",   // parallel Pexels jobs
  "ASSEMBLE_CONCURRENCY",    // parallel FFmpeg clip renders

  // ── Reliability ───────────────────────────────────────────────────
  "FAILURE_THRESHOLD_PERCENT", // 0–100. If more than this % of scenes fail, the run aborts.

  // ── Google Drive backup (optional) ────────────────────────────────
  "GDRIVE_CLIENT_ID",            // OAuth2 client id (Google Cloud Console)
  "GDRIVE_CLIENT_SECRET",        // OAuth2 client secret (masked in UI)
  "GDRIVE_REFRESH_TOKEN",        // set by the OAuth callback, not by the user
  "GDRIVE_CONNECTED_EMAIL",      // set by the OAuth callback — shows who is connected
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID", // Drive folder id for final.mp4s. Empty = auto-create
  "GDRIVE_RUNS_FOLDER_ID",       // Drive folder id for per-run source assets. Empty = auto-create
  "GDRIVE_SYNC_ENABLED",         // "1" = auto-upload finished runs to Drive
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
  if (row && row.value !== "") return row.value;
  return process.env[key] ?? "";
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
  // Required API keys — empty by default, user must provide
  GOOGLE_API_KEY: "",
  PEXELS_API_KEY: "",
  PIXABAY_API_KEY: "",
  AI33PRO_API_KEY: "",
  GROQ_API_KEY: "",

  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split — Gemini only
  SCENE_SPLIT_MODEL: "gemini-flash-latest",
  // Optional channel/setting hint. Empty = the model infers the setting from
  // the script itself (recommended). When set, it's passed as background DATA
  // so footage stays on-theme — but never executed as instructions.
  VIDEO_CONTEXT: "",

  // TTS — ai33.pro with ElevenLabs voices. Default voice left empty so the
  // user picks one in /settings (any ElevenLabs voice id works).
  // Voiceover engine: ai33pro by default. Switch to 69labs to route the SAME
  // ElevenLabs voices through the 69labs gateway (needs LABS69_API_KEY).
  TTS_PROVIDER: "ai33pro",
  LABS69_API_KEY: "",
  // 69labs path only — elevenlabs keeps the voice identical to ai33pro.
  TTS_VOICE_PROVIDER: "elevenlabs",
  TTS_VOICE_ID: "",
  TTS_MODEL: "eleven_multilingual_v2",
  TTS_SPEED: "1.0",
  // single-shot = one continuous voiceover for the whole script (no mid-sentence
  // pauses at scene cuts). per-scene = legacy one-TTS-call-per-scene flow.
  TTS_MODE: "single-shot",
  // Cap a single b-roll clip at 7s; longer scene audio ranges are split into
  // equal sub-clips so the visuals keep changing. 0 disables the split.
  MAX_CLIP_SECONDS: "7",
  // Merge scenes shorter than this into the next so footage stays ≥3s on screen
  // (stops the 1-2s "jumping on every word" look). Pairs with MAX_CLIP_SECONDS=7
  // → visuals land in a calm ~3–7s range.
  MIN_SCENE_SECONDS: "3",
  // Cap any silence in the single-shot voiceover to 0.6s. Trims the over-long
  // gaps (sentence pauses, chunk-seam silence) while leaving natural short
  // pauses alone. 0 disables it (keep the raw TTS pacing).
  MAX_PAUSE_SECONDS: "0.6",

  // Stock footage (Pexels) — defaults match a typical long-form 16:9 channel.
  // Query Pexels + Pixabay (both video+photo, no attribution). Add a key for
  // each you want; a source with no key is silently skipped.
  FOOTAGE_SOURCES: "pexels,pixabay",
  // Let Gemini pick the most relevant candidate across all sources' results
  // (after the local score pre-filters the obvious junk). off = local score only.
  FOOTAGE_AI_PICK: "on",
  // Reject candidates whose own description shares nothing with our search
  // (the "searched pharmacy basket, got a bathroom basket" fix). Safe default:
  // worst case it falls back to the best available clip, never fails a scene.
  FOOTAGE_MATCH_STRICTNESS: "normal",
  STOCK_FOOTAGE_ORIENTATION: "landscape",
  STOCK_FOOTAGE_MAX_HEIGHT: "1080",
  STOCK_FOOTAGE_MIN_DURATION: "4",
  // 40% of scenes use a still photo with ken-burns zoom — adds visual variety
  // and helps when Pexels has a strong photo for a query but weak video.
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

  // On-screen text emphasis. "hook" = pop key numbers/years/places as big text
  // only in the opening seconds (where it lifts retention without getting noisy).
  // "all" = whole video, "off" = never. Font auto-detected unless overridden.
  TEXT_OVERLAY_MODE: "hook",
  TEXT_OVERLAY_HOOK_SECONDS: "30",
  TEXT_OVERLAY_FONT: "",

  // Performance
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "5",
  ASSEMBLE_CONCURRENCY: "4",

  // Reliability
  FAILURE_THRESHOLD_PERCENT: "25",

  // Google Drive backup — all empty by default (feature off until configured).
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
