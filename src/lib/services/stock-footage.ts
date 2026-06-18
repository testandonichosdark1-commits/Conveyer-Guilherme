import fs from "node:fs";
import path from "node:path";
import db, { DATA_DIR } from "../db";
import { pLimit } from "../plimit";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import type { Scene } from "./scene-split";

/**
 * Pexels stock footage service — search + download.
 *
 * This is the b-roll source for Conveyer Guilherme. Replaces the AI video
 * generation used in the other Conveyer forks (Grok / Veo / Kling).
 *
 * Free tier: 200 req/hour, 20 000/month. The API key is required.
 * Sign-up: https://www.pexels.com/api/  (free, ~30 seconds)
 * Docs:    https://www.pexels.com/api/documentation/
 *
 * Attribution: Pexels licenses everything for commercial use without
 * attribution, but their TOS recommend a credit "Video by <author> from
 * Pexels". We log the author name on every download so it can land in the
 * final video's description block later.
 */

const PEXELS_BASE = "https://api.pexels.com";

// ── Types (mirroring Pexels API JSON) ────────────────────────────────────────

export interface PexelsVideoFile {
  id: number;
  quality: string;       // "hd" | "sd" | "uhd"
  file_type: string;     // "video/mp4"
  width: number;
  height: number;
  link: string;          // direct download URL
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;      // seconds
  url: string;           // pexels.com page URL (not a file)
  image: string;         // thumbnail URL
  video_files: PexelsVideoFile[];
  user?: { name?: string; url?: string };
}

interface PexelsVideoSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  videos: PexelsVideo[];
  next_page?: string;
}

export type Orientation = "landscape" | "portrait" | "square";

export interface StockSearchOptions {
  orientation?: Orientation;
  /** Pexels accepts "large" (4K+) / "medium" (1080p+) / "small" (HD). */
  size?: "large" | "medium" | "small";
  /** Filters out flashy short stingers (< minDuration seconds). */
  minDuration?: number;
  /** Max results per request (default 15, max 80). */
  perPage?: number;
}

// ── Photo types (Pexels Photos API) ──────────────────────────────────────────

export interface PexelsPhotoSrc {
  original: string;   // full-resolution original
  large2x: string;    // ~1880px wide — good default for 1080p
  large: string;      // ~940px wide
  medium: string;     // ~640px wide
  small: string;
  portrait: string;
  landscape: string;
  tiny: string;
}

export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;           // pexels.com page URL
  photographer: string;
  photographer_url?: string;
  src: PexelsPhotoSrc;
  alt?: string;
}

interface PexelsPhotoSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsPhoto[];
  next_page?: string;
}

// ── Multi-key pool with rate-limit awareness ────────────────────────────────
//
// Pexels free tier = 200 req/hour, 20 000/month (rolling).
// Successful responses include X-Ratelimit-Remaining + X-Ratelimit-Reset
// (UNIX seconds). On 429 those headers are NOT returned, so we fall back to
// the last resetAt we saw from a successful response.
//
// PEXELS_API_KEY can hold multiple keys (one per line, or comma/semicolon
// separated). The pool tries the current key until it's rate-limited, then
// rotates to the next. When all keys are exhausted at once, it waits on the
// one whose window refreshes earliest, then resumes there.

// ── Stats and Cooldown States ───────────────────────────────────────────────

export interface RunStats {
  pexelsCalls: number;
  pixabayCalls: number;
  geminiVisionCalls: number;
  cacheHits: number;
  cacheMisses: number;
  pexels429s: number;
  pixabay429s: number;
  geminiVision429s: number;
  assetsReusedFromCache: number;
}

export const runStatsMap = new Map<string, RunStats>();

export function getOrCreateStats(runId: string): RunStats {
  let stats = runStatsMap.get(runId);
  if (!stats) {
    stats = {
      pexelsCalls: 0,
      pixabayCalls: 0,
      geminiVisionCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      pexels429s: 0,
      pixabay429s: 0,
      geminiVision429s: 0,
      assetsReusedFromCache: 0,
    };
    runStatsMap.set(runId, stats);
  }
  return stats;
}

let visionCooldownUntil = 0;
let pixabayCooldownUntil = 0;
let lastAllPexelsKeysLimitedLogTime = 0;

export function isVisionCooldown(): boolean {
  return Date.now() < visionCooldownUntil;
}

export function setVisionCooldown() {
  const durationSec = Math.max(10, Number(getSetting("VISION_COOLDOWN_ON_429_SEC") || "120"));
  visionCooldownUntil = Date.now() + durationSec * 1000;
}

export function isPixabaySuspended(): boolean {
  return Date.now() < pixabayCooldownUntil;
}

export function setPixabayCooldown() {
  pixabayCooldownUntil = Date.now() + 120000;
}

// ── Cache Prepared Statements ────────────────────────────────────────────────

const getSearchCacheStmt = db.prepare("SELECT value, created_at FROM search_cache WHERE key = ?");
const insertSearchCacheStmt = db.prepare("INSERT OR REPLACE INTO search_cache (key, value, created_at) VALUES (?, ?, ?)");

const getDownloadCacheStmt = db.prepare("SELECT cached_filename FROM download_cache WHERE dedupe_id = ? OR source_url = ?");
const insertDownloadCacheStmt = db.prepare("INSERT OR REPLACE INTO download_cache (dedupe_id, source_url, cached_filename, created_at) VALUES (?, ?, ?, ?)");

const getVisionCacheStmt = db.prepare("SELECT score, created_at FROM vision_cache WHERE key = ?");
const insertVisionCacheStmt = db.prepare("INSERT OR REPLACE INTO vision_cache (key, score, created_at) VALUES (?, ?, ?)");

// ── Cache Helper Functions ───────────────────────────────────────────────────

function getShortHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function deserializeHit(sh: any, runId: string): FootageHit {
  return {
    source: sh.source,
    dedupeId: sh.dedupeId,
    desc: sh.desc,
    thumbUrl: sh.thumbUrl,
    author: sh.author,
    sourceUrl: sh.sourceUrl,
    meta: sh.meta,
    pexelsVideoFile: sh.pexelsVideoFile,
    pexelsPhotoUrl: sh.pexelsPhotoUrl,
    downloadUrl: sh.downloadUrl,
    download: async (out: string) => {
      if (sh.source === "pexels") {
        if (sh.pexelsVideoFile) {
          return downloadPexelsVideo(sh.pexelsVideoFile, out);
        } else if (sh.pexelsPhotoUrl) {
          return downloadPexelsPhoto(sh.pexelsPhotoUrl, out);
        }
      } else if (sh.source === "pixabay") {
        if (sh.downloadUrl) {
          return downloadUrlToFile(sh.downloadUrl, out, runId);
        }
      }
      throw new Error(`Cannot download cached hit ${sh.dedupeId}: missing download payload`);
    }
  };
}

async function downloadWithCache(hit: FootageHit, outPath: string, runId: string): Promise<void> {
  const cacheKey = hit.dedupeId;
  const sourceUrl = hit.sourceUrl;

  const downloadCacheDir = path.join(DATA_DIR, "download_cache");
  if (!fs.existsSync(downloadCacheDir)) {
    fs.mkdirSync(downloadCacheDir, { recursive: true });
  }

  try {
    const cached = getDownloadCacheStmt.get(cacheKey, sourceUrl) as { cached_filename: string } | undefined;
    if (cached) {
      const cachedFilePath = path.join(downloadCacheDir, cached.cached_filename);
      if (fs.existsSync(cachedFilePath)) {
        fs.copyFileSync(cachedFilePath, outPath);
        getOrCreateStats(runId).assetsReusedFromCache++;
        log(runId, "info", `Asset reused from cache: ${cacheKey}`, { stage: "animate" });
        return;
      }
    }
  } catch (e) {
    // ignore
  }

  await hit.download(outPath);

  try {
    const ext = path.extname(outPath) || (hit.meta.includes("photo") || hit.pexelsPhotoUrl ? ".jpg" : ".mp4");
    const safeFilename = `${hit.dedupeId.replace(/:/g, "_")}${ext}`;
    const cachedFilePath = path.join(downloadCacheDir, safeFilename);
    fs.copyFileSync(outPath, cachedFilePath);
    insertDownloadCacheStmt.run(cacheKey, sourceUrl, safeFilename, Date.now());
  } catch (e) {
    // ignore
  }
}

interface KeyState {
  key: string;
  remaining: number | null;
  resetAt: number | null;          // UNIX seconds (from X-Ratelimit-Reset)
  exhaustedUntilMs: number | null; // UNIX ms — when this key becomes usable again
}

const keyPool: { keys: KeyState[]; cursor: number } = {
  keys: [],
  cursor: 0,
};

export function isPexelsSuspended(): boolean {
  const keys = keyPool.keys;
  if (keys.length === 0) return false;
  const now = Date.now();
  return keys.every(k => k.exhaustedUntilMs !== null && k.exhaustedUntilMs > now);
}

/** Re-parse PEXELS_API_KEY each call; preserve state for keys we've seen before. */
function refreshKeyPool(): KeyState[] {
  const raw = getSetting("PEXELS_API_KEY") || "";
  const parsed = raw
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error("PEXELS_API_KEY is not set — add it in /settings (one key per line for multiple)");
  }
  const existing = new Map(keyPool.keys.map((k) => [k.key, k]));
  keyPool.keys = parsed.map(
    (k) =>
      existing.get(k) ?? {
        key: k,
        remaining: null,
        resetAt: null,
        exhaustedUntilMs: null,
      }
  );
  if (keyPool.cursor >= keyPool.keys.length) keyPool.cursor = 0;
  return keyPool.keys;
}

function updateKeyFromHeaders(state: KeyState, headers: Headers): void {
  const rem = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (rem !== null) {
    const n = parseInt(rem, 10);
    if (Number.isFinite(n)) state.remaining = n;
  }
  if (reset !== null) {
    const n = parseInt(reset, 10);
    if (Number.isFinite(n)) state.resetAt = n;
  }
}

function markKeyExhausted(state: KeyState): void {
  // Use the last known reset, else default to one hour from now (Pexels window).
  if (state.resetAt !== null) {
    state.exhaustedUntilMs = state.resetAt * 1000 + 5000; // +5s safety
  } else {
    state.exhaustedUntilMs = Date.now() + 60 * 60 * 1000;
  }
}

/** Cancel-aware sleep — checks `checkCancelled(runId)` every 5 seconds. */
async function sleepWithCancel(ms: number, runId?: string): Promise<void> {
  const CHECK_INTERVAL_MS = 5000;
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (runId) checkCancelled(runId);
    const remaining = ms - (Date.now() - start);
    await new Promise<void>((r) => setTimeout(r, Math.min(CHECK_INTERVAL_MS, remaining)));
  }
}

function formatLocalTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Picks an available key. If none are available, sleeps until the
 * earliest-recovering key is ready, then returns it.
 */
async function acquireKey(runId?: string): Promise<KeyState> {
  while (true) {
    const keys = refreshKeyPool();
    const now = Date.now();

    // Scan starting at cursor for any key not currently exhausted.
    for (let i = 0; i < keys.length; i++) {
      const idx = (keyPool.cursor + i) % keys.length;
      const k = keys[idx];
      if (k.exhaustedUntilMs === null || k.exhaustedUntilMs <= now) {
        // This one is available — clear stale state if cooldown ended.
        if (k.exhaustedUntilMs !== null && k.exhaustedUntilMs <= now) {
          k.exhaustedUntilMs = null;
          k.remaining = null;
          if (runId) {
            log(runId, "info", `Pexels key #${idx + 1} cooldown ended — using it`, { stage: "animate" });
          }
        }
        keyPool.cursor = idx;
        return k;
      }
    }

    // All keys exhausted. Find the one that recovers soonest.
    let earliestIdx = 0;
    let earliestUntil = keys[0].exhaustedUntilMs ?? Infinity;
    for (let i = 1; i < keys.length; i++) {
      const u = keys[i].exhaustedUntilMs ?? Infinity;
      if (u < earliestUntil) {
        earliestIdx = i;
        earliestUntil = u;
      }
    }
    const earliest = keys[earliestIdx];
    const waitMs = Math.max(0, (earliest.exhaustedUntilMs ?? now) - now) + 5000;
    const cappedWait = Math.min(waitMs, 75 * 60 * 1000);

    if (runId) {
      const untilLabel = earliest.resetAt !== null ? ` until ${formatLocalTime(earliest.resetAt)}` : "";
      const minutes = Math.max(1, Math.ceil(cappedWait / 60000));
      log(
        runId,
        "warn",
        `All ${keys.length} Pexels key${keys.length === 1 ? "" : "s"} rate-limited — pausing ~${minutes} min${untilLabel}, then auto-resume on key #${earliestIdx + 1}`,
        { stage: "animate" }
      );
    }

    keyPool.cursor = earliestIdx;
    await sleepWithCancel(cappedWait, runId);
    // Loop back to top — re-pick (the woken-up key is now ready).
  }
}

/**
 * Wraps fetch with multi-key rate-limit handling.
 * On 429 → mark current key exhausted → loop, picking the next available key.
 * If every key gets exhausted N times → bail (likely monthly quota hit).
 */
async function pexelsFetch(url: URL | string, runId: string | undefined): Promise<Response> {
  const keys = refreshKeyPool();
  // Allow up to 3 cycles through all keys before giving up (handles edge cases
  // where a key returns 429 even after its supposed reset).
  const MAX_429_HITS = keys.length * 3;

  let hits429 = 0;
  while (hits429 < MAX_429_HITS) {
    const state = await acquireKey(runId);
    if (runId) {
      getOrCreateStats(runId).pexelsCalls++;
    }
    const resp = await fetch(url, { headers: { Authorization: state.key } });

    if (resp.status === 429) {
      hits429++;
      getOrCreateStats(runId || "").pexels429s++;
      try {
        await resp.text();
      } catch {}
      const idx = keyPool.keys.indexOf(state);
      markKeyExhausted(state);
      if (runId) {
        const untilLabel =
          state.resetAt !== null ? ` (window resets ${formatLocalTime(state.resetAt)})` : "";
        log(
          runId,
          "warn",
          `Pexels key #${idx + 1} rate-limited${untilLabel} — rotating to next available key`,
          { stage: "animate" }
        );
      }
      // Move cursor past this one so the next acquireKey starts elsewhere.
      keyPool.cursor = (idx + 1) % keyPool.keys.length;
      continue;
    }

    if (resp.ok) {
      updateKeyFromHeaders(state, resp.headers);
      // Preemptive: if this key is almost out, mark it exhausted so the
      // next request rotates instead of racing into a 429.
      if (state.remaining !== null && state.remaining < 3) {
        markKeyExhausted(state);
      }
    }
    return resp;
  }

  throw new Error(
    `All Pexels keys rate-limited for too long (${MAX_429_HITS} retries) — likely monthly quota exhausted on every key. ` +
      `Check https://www.pexels.com/api/`
  );
}

/** Raw search call. Returns up to options.perPage videos, newest first by relevance. */
export async function searchPexelsVideos(
  query: string,
  options: StockSearchOptions & { runId?: string } = {}
): Promise<PexelsVideo[]> {
  const url = new URL(`${PEXELS_BASE}/videos/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(options.perPage ?? 15));
  if (options.orientation) url.searchParams.set("orientation", options.orientation);
  if (options.size) url.searchParams.set("size", options.size);
  if (options.minDuration && options.minDuration > 0) {
    url.searchParams.set("min_duration", String(options.minDuration));
  }

  const resp = await pexelsFetch(url, options.runId);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`Pexels search HTTP ${resp.status}: ${txt}`);
  }
  const data = (await resp.json()) as PexelsVideoSearchResponse;
  return Array.isArray(data.videos) ? data.videos : [];
}

/**
 * Pre-flight connectivity + key check. Does one tiny Pexels search.
 * - Succeeds (or transparently waits out a rate limit) → Pexels is usable.
 * - Throws a clear error → key missing/invalid or network down.
 *
 * The pipeline calls this BEFORE generating any voiceovers, so a misconfigured
 * Pexels key fails in a few seconds instead of after hundreds of paid TTS jobs.
 */
export async function pexelsPreflight(runId: string): Promise<void> {
  await searchPexelsVideos("nature", { perPage: 1, runId });
}

/**
 * Picks the best MP4 file from one Pexels video:
 *  - MP4 only (Pexels also serves .mov sometimes)
 *  - Prefers the largest file whose height is <= maxHeight (no upscaling needed)
 *  - Falls back to smallest file above maxHeight if nothing fits
 */
export function pickBestVideoFile(
  video: PexelsVideo,
  options: { maxHeight?: number } = {}
): PexelsVideoFile | null {
  const maxH = options.maxHeight ?? 1080;
  const mp4s = video.video_files.filter((f) => /mp4/i.test(f.file_type));
  if (mp4s.length === 0) return null;

  const below = mp4s.filter((f) => f.height <= maxH).sort((a, b) => b.height - a.height);
  if (below.length > 0) return below[0];

  // Nothing at or below maxHeight — fall back to the smallest one above
  // (better than nothing; FFmpeg will downscale during assembly).
  return [...mp4s].sort((a, b) => a.height - b.height)[0] ?? null;
}

/** Stream-download a video file to disk. Throws on non-200. */
export async function downloadPexelsVideo(
  videoFile: PexelsVideoFile,
  outPath: string
): Promise<void> {
  const resp = await fetch(videoFile.link);
  if (!resp.ok) {
    throw new Error(`Pexels download HTTP ${resp.status}: ${videoFile.link}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error(`Pexels returned empty file: ${videoFile.link}`);
  }
  fs.writeFileSync(outPath, buf);
}

// ── Pexels Photos ────────────────────────────────────────────────────────────

/** Search Pexels for stock photos matching a query. */
export async function searchPexelsPhotos(
  query: string,
  options: StockSearchOptions & { runId?: string } = {}
): Promise<PexelsPhoto[]> {
  const url = new URL(`${PEXELS_BASE}/v1/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(options.perPage ?? 15));
  if (options.orientation) url.searchParams.set("orientation", options.orientation);
  if (options.size) url.searchParams.set("size", options.size);

  const resp = await pexelsFetch(url, options.runId);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`Pexels photo search HTTP ${resp.status}: ${txt}`);
  }
  const data = (await resp.json()) as PexelsPhotoSearchResponse;
  return Array.isArray(data.photos) ? data.photos : [];
}

/** Picks the best photo src URL for our target max-height. */
export function pickBestPhotoSrc(photo: PexelsPhoto, maxHeight = 1080): string {
  // Pexels src tiers don't expose pixel heights directly — but practically:
  // - large2x ≈ 1880x... → good for 1080p
  // - original is full-res (sometimes 5000+px wide)
  // We grab large2x for 1080p targets, original for 4K targets.
  if (maxHeight >= 2000) return photo.src.original;
  if (maxHeight >= 900) return photo.src.large2x;
  if (maxHeight >= 500) return photo.src.large;
  return photo.src.medium;
}

/** Stream-download a photo file to disk. Throws on non-200. */
export async function downloadPexelsPhoto(url: string, outPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Pexels photo download HTTP ${resp.status}: ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error(`Pexels returned empty photo: ${url}`);
  }
  fs.writeFileSync(outPath, buf);
}

// ── Scene-level wrapper used by the pipeline ─────────────────────────────────

/**
 * Builds a Pexels-friendly search query from a scene's visual_prompt.
 *
 * The pipeline produces long, descriptive visual_prompts ("An ancient stone
 * temple emerging from misty jungle vines, golden afternoon light filtering
 * through canopy, cinematic wide shot"). Pexels search works much better
 * with shorter natural-language queries.
 *
 * For the MVP we just take the first ~10 words and strip punctuation. Phase 2
 * will route this through Gemini for better keyword extraction.
 */
export function visualPromptToQuery(visualPrompt: string, maxWords = 18): string {
  return visualPrompt
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ordered, cleaned Pexels query candidates for a scene (best first).
 *
 * Uses `scene.visual_queries` when present (the 2–3 alternates Gemini produces),
 * otherwise falls back to the single `visual_prompt`. Each is normalized for
 * Pexels and de-duplicated. The acquire helpers try them in order and use the
 * first that returns a usable asset — so a junk/empty first result no longer
 * fails the whole scene.
 */
function sceneQueryCandidates(scene: Scene): string[] {
  const raw =
    scene.visual_queries && scene.visual_queries.length > 0
      ? scene.visual_queries
      : [scene.visual_prompt];
  const cleaned = raw.map((q) => visualPromptToQuery(q)).filter(Boolean);
  return [...new Set(cleaned)];
}

// ── Relevance scoring (local, zero extra API calls) ──────────────────────────
//
// Pexels already tells us what each candidate depicts: a video's page URL ends
// in a descriptive slug ("…/video/a-woman-shopping-in-a-pharmacy-855386/") and
// a photo carries an `alt` sentence. We score every candidate against the
// scene's search queries and skip ones that share nothing with what we asked
// for — that's what stops a "pharmacy shopping basket" search from silently
// using a wicker basket on a bathroom shelf just because Pexels ranked it #1.

const RELEVANCE_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "and", "or", "with", "to", "for",
  "by", "from", "is", "are", "this", "that", "over", "under", "into", "near",
  "his", "her", "its", "their", "video", "photo", "footage", "stock", "free",
]);

function relevanceTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !RELEVANCE_STOPWORDS.has(t));
}

/** Descriptive words of a Pexels page URL ("…/video/a-woman-shopping-in-a-pharmacy-855386/"
 *  → woman, shopping, pharmacy). Returns [] when the URL has no usable slug. */
function pexelsSlugTokens(pageUrl: string): string[] {
  try {
    const segs = new URL(pageUrl).pathname.split("/").filter(Boolean);
    const slug = (segs[segs.length - 1] ?? "").replace(/-\d+$/, "");
    return relevanceTokens(slug.replace(/-/g, " "));
  } catch {
    return [];
  }
}

export function stemWord(w: string): string {
  w = w.toLowerCase().trim();
  // Strip common suffixes in order of specificity
  if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.endsWith("er")) w = w.slice(0, -2);
  else if (w.endsWith("es")) w = w.slice(0, -2);
  else if (w.endsWith("ion")) w = w.slice(0, -3);
  else if (w.endsWith("e")) w = w.slice(0, -1);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);

  // Strip double consonants at the end (e.g. running -> runn -> run, shopping -> shopp -> shop)
  if (w.length >= 4 && w[w.length - 1] === w[w.length - 2]) {
    const last = w[w.length - 1];
    if (["b", "d", "g", "l", "m", "n", "p", "r", "t"].includes(last)) {
      w = w.slice(0, -1);
    }
  }
  return w;
}

const ANCHOR_STOPWORDS = new Set([
  // Basic stopwords
  "a", "an", "the", "of", "in", "on", "at", "and", "or", "with", "to", "for",
  "by", "from", "is", "are", "this", "that", "over", "under", "into", "near",
  "his", "her", "its", "their", "video", "photo", "footage", "stock", "free",
  
  // Pronouns
  "you", "your", "yours", "he", "him", "she", "they", "them", "their", "theirs",
  "we", "us", "our", "ours", "i", "me", "my", "mine", "it", "who", "whom", "whose",
  "these", "those", "what", "which", "someone", "something", "anyone", "anything",
  
  // Common generic verbs & helpers
  "let", "make", "makes", "making", "put", "puts", "putting", "get", "gets", "getting",
  "take", "takes", "taking", "go", "goes", "going", "come", "comes", "coming",
  "see", "sees", "seeing", "look", "looks", "looking", "want", "wants", "wanting",
  "need", "needs", "needing", "use", "uses", "using", "do", "does", "did", "done", "doing",
  "have", "has", "had", "having", "keep", "keeps", "keeping", "give", "gives", "giving",
  "tell", "tells", "telling", "say", "says", "saying", "think", "thinks", "thinking",
  "know", "knows", "knowing", "find", "finds", "finding", "work", "works", "working",
  
  // Generic action & visual keywords that should not be anchors
  "reach", "reaching", "grab", "grabbing", "open", "opening", "close", "closing", "hold", "holding",
  "container", "contain", "box", "bag", "pack", "package", "packaging", "shelf", "shelves",
  "display", "table", "store", "shop", "shopper", "supermarket", "kitchen", "home",
  "clamshell",
  
  // Filler/adverbs
  "like", "just", "even", "also", "very", "too", "really", "back", "here", "there",
  "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "than", "then", "once", "now", "well", "dont"
]);

export function extractAnchorWords(scriptText: string): string[] {
  const tokens = scriptText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ANCHOR_STOPWORDS.has(w))
    .map(stemWord);

  const freqs = new Map<string, number>();
  for (const t of tokens) {
    freqs.set(t, (freqs.get(t) ?? 0) + 1);
  }

  // If the script is very short (under 100 words), let's allow frequency >= 1
  const minFreq = scriptText.split(/\s+/).length < 100 ? 1 : 2;

  const sorted = [...freqs.entries()]
    .filter(([_, count]) => count >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 12);

  return sorted;
}

/** Loose word match so "shopping" pairs with "shop", "waves" with "wave":
 *  exact, or one is a ≥3-char prefix of the other with bounded length difference. */
function tokensMatch(a: string, b: string): boolean {
  const sa = stemWord(a);
  const sb = stemWord(b);
  if (sa === sb) return true;
  if (Math.min(sa.length, sb.length) < 3) return false;
  if (sa.startsWith(sb) || sb.startsWith(sa)) {
    // Only match if the length difference between stems is small (avoid strawberries matching straw)
    return Math.abs(sa.length - sb.length) <= 3;
  }
  return false;
}

/**
 * 0..1: how much of ONE of the scene's queries this candidate's description
 * covers (the best-matching query wins). 1 = every meaningful word of a query
 * is present; 0 = shares nothing with any query, or has no description at all.
 * Optionally penalizes candidates that miss script-level anchor words present in the query.
 */
function relevanceScore(
  candTokens: string[],
  queryTokenLists: string[][],
  anchorWords?: string[]
): number {
  if (candTokens.length === 0) return 0;
  let best = 0;
  for (const q of queryTokenLists) {
    if (q.length === 0) continue;
    let hit = 0;
    for (const t of q) if (candTokens.some((c) => tokensMatch(c, t))) hit++;
    let score = hit / q.length;

    // Apply anchor words penalty if anchorWords are provided
    if (anchorWords && anchorWords.length > 0) {
      // Find which query tokens match any anchor word (with flexible endsWith/startsWith matches)
      const queryAnchors = q.filter((qt) => {
        const sqt = stemWord(qt);
        return anchorWords.some((aw) => {
          const saw = stemWord(aw);
          return saw === sqt || saw.endsWith(sqt) || sqt.endsWith(saw);
        });
      });

      if (queryAnchors.length > 0) {
        // Check if the candidate matches at least one of these query anchors
        const matchesAnyAnchor = queryAnchors.some((qa) =>
          candTokens.some((ct) => tokensMatch(ct, qa))
        );
        if (!matchesAnyAnchor) {
          // Penalize the score significantly (multiply by 0.35)
          score *= 0.35;
        }
      }
    }

    if (score > best) best = score;
  }
  return best;
}

// ── Multi-source footage (Pexels + Pixabay), unified + AI-picked ─────────────
//
// A scene's footage can come from more than one library. We query every
// configured source for the SAME query, pool all candidates into one normalized
// shape, score them locally, optionally let Gemini pick the best, then download
// the winner. Adding sources widens coverage; the relevance gate keeps quality.

const FOOTAGE_UA = "ConveyerGuilherme/1.0 (local video tool)";

/** A normalized candidate from any source, with everything needed to score,
 *  dedupe, log and download it. `desc` is free text used for relevance. */
interface FootageHit {
  source: string;       // "pexels" | "pixabay"
  dedupeId: string;     // cross-source unique id, e.g. "pexels:123" / "pixabay:45"
  desc: string;         // slug / alt / tags — used by the text fallback scorer
  thumbUrl: string;     // small preview image — what the VISION scorer actually looks at ("" if none)
  author: string | null;
  sourceUrl: string;
  meta: string;         // short label for logs, e.g. "1920x1080 12s"
  download: (outPath: string) => Promise<void>;
  pexelsVideoFile?: any;
  pexelsPhotoUrl?: string;
  downloadUrl?: string;
}

/** Which libraries to query, in order. Default Pexels + Pixabay. */
function configuredFootageSources(): string[] {
  const raw = getSetting("FOOTAGE_SOURCES") || "pexels,pixabay";
  const known = new Set(["pexels", "pixabay"]);
  const list = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => known.has(s));
  return list.length > 0 ? [...new Set(list)] : ["pexels", "pixabay"];
}

/** Generic stream-download (used by Pixabay + any direct-URL source). */
async function downloadUrlToFile(url: string, outPath: string, runId?: string): Promise<void> {
  const isPixabay = url.includes("pixabay.com");
  if (isPixabay && isPixabaySuspended()) {
    throw new Error("Pixabay downloads temporarily rate-limited — in cooldown");
  }

  if (runId && isPixabay) {
    getOrCreateStats(runId).pixabayCalls++;
  }
  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
  if (resp.status === 429) {
    if (isPixabay) {
      setPixabayCooldown();
      getOrCreateStats(runId || "").pixabay429s++;
      log(runId || "", "warn", "Pixabay downloads temporarily rate-limited — cooling down for 120s", { stage: "animate" });
    }
    throw new Error(`download HTTP ${resp.status}`);
  }

  if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("download: empty file");
  fs.writeFileSync(outPath, buf);
}

// ── Pexels → FootageHit builders (wrap the existing Pexels primitives) ────────

async function pexelsVideoHits(
  query: string,
  opts: { orientation: Orientation; maxHeight: number; minDuration: number; runId: string }
): Promise<FootageHit[]> {
  const videos = await searchPexelsVideos(query, {
    orientation: opts.orientation,
    minDuration: opts.minDuration,
    perPage: 30,
    runId: opts.runId,
  });
  const hits: FootageHit[] = [];
  for (const v of videos) {
    const file = pickBestVideoFile(v, { maxHeight: opts.maxHeight });
    if (!file) continue;
    hits.push({
      source: "pexels",
      dedupeId: `pexels:${v.id}`,
      desc: pexelsSlugTokens(v.url).join(" "),
      thumbUrl: v.image || "",
      author: v.user?.name ?? null,
      sourceUrl: v.url,
      meta: `${file.width}x${file.height} ${v.duration}s`,
      download: (out) => downloadPexelsVideo(file, out),
      pexelsVideoFile: file,
    });
  }
  return hits;
}

async function pexelsPhotoHits(
  query: string,
  opts: { orientation: Orientation; maxHeight: number; runId: string }
): Promise<FootageHit[]> {
  const photos = await searchPexelsPhotos(query, {
    orientation: opts.orientation,
    perPage: 30,
    runId: opts.runId,
  });
  return photos.map((p) => {
    const url = pickBestPhotoSrc(p, opts.maxHeight);
    return {
      source: "pexels",
      dedupeId: `pexels:${p.id}`,
      desc: `${p.alt || ""} ${pexelsSlugTokens(p.url).join(" ")}`.trim(),
      thumbUrl: p.src?.medium || p.src?.small || "",
      author: p.photographer || null,
      sourceUrl: p.url,
      meta: `${p.width}x${p.height}`,
      download: (out) => downloadPexelsPhoto(url, out),
      pexelsPhotoUrl: url,
    };
  });
}

// ── Pixabay → FootageHit builders (video + photo) ─────────────────────────────
//
// Pixabay free API: video + photo, no attribution required (Pixabay License).
// PIXABAY_API_KEY is required; without it these return [] (Pexels-only).
// Pixabay gives a `tags` keyword list per hit — excellent for relevance scoring.

function pixabayOrientation(o: Orientation): string | null {
  if (o === "portrait") return "vertical";
  if (o === "landscape") return "horizontal";
  return null; // square — Pixabay has no square filter; omit it
}

function pixabayDesc(tags: string | undefined, pageURL: string | undefined): string {
  const slug = (() => {
    try {
      const segs = new URL(pageURL || "").pathname.split("/").filter(Boolean);
      return (segs[segs.length - 1] ?? "").replace(/-\d+$/, "").replace(/-/g, " ");
    } catch {
      return "";
    }
  })();
  return `${tags || ""} ${slug}`.trim();
}

async function pixabayVideoHits(
  query: string,
  opts: { orientation: Orientation; minDuration: number; runId: string }
): Promise<FootageHit[]> {
  const key = getSetting("PIXABAY_API_KEY").trim();
  if (!key) return [];
  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("video_type", "film");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "30");
  const orient = pixabayOrientation(opts.orientation);
  if (orient) url.searchParams.set("orientation", orient);

  if (opts.runId) {
    getOrCreateStats(opts.runId).pixabayCalls++;
  }
  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
  if (resp.status === 429) {
    setPixabayCooldown();
    if (opts.runId) getOrCreateStats(opts.runId).pixabay429s++;
    throw new Error("Pixabay videos HTTP 429");
  }
  if (!resp.ok) throw new Error(`Pixabay videos HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: {
      id: number;
      duration?: number;
      pageURL?: string;
      user?: string;
      tags?: string;
      videos?: Record<string, { url: string; width: number; height: number; thumbnail?: string }>;
    }[];
  };
  const hits: FootageHit[] = [];
  for (const h of data.hits ?? []) {
    const v = h.videos?.large?.url ? h.videos.large : h.videos?.medium || h.videos?.small;
    if (!v?.url) continue;
    const fileUrl = v.url;
    hits.push({
      source: "pixabay",
      dedupeId: `pixabay:${h.id}`,
      desc: pixabayDesc(h.tags, h.pageURL),
      thumbUrl: v.thumbnail || h.videos?.small?.thumbnail || "",
      author: h.user ?? null,
      sourceUrl: h.pageURL ?? "",
      meta: `${v.width}x${v.height}${h.duration ? ` ${h.duration}s` : ""}`,
      download: (out) => downloadUrlToFile(fileUrl, out, opts.runId),
      downloadUrl: fileUrl,
    });
  }
  return hits;
}

async function pixabayPhotoHits(
  query: string,
  opts: { orientation: Orientation; runId: string }
): Promise<FootageHit[]> {
  const key = getSetting("PIXABAY_API_KEY").trim();
  if (!key) return [];
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "30");
  url.searchParams.set("min_width", "1280");
  const orient = pixabayOrientation(opts.orientation);
  if (orient) url.searchParams.set("orientation", orient);

  if (opts.runId) {
    getOrCreateStats(opts.runId).pixabayCalls++;
  }
  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
  if (resp.status === 429) {
    setPixabayCooldown();
    if (opts.runId) getOrCreateStats(opts.runId).pixabay429s++;
    throw new Error("Pixabay images HTTP 429");
  }
  if (!resp.ok) throw new Error(`Pixabay images HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: {
      id: number;
      pageURL?: string;
      user?: string;
      tags?: string;
      imageWidth?: number;
      imageHeight?: number;
      largeImageURL?: string;
      fullHDURL?: string;
      webformatURL?: string;
      previewURL?: string;
    }[];
  };
  const hits: FootageHit[] = [];
  for (const h of data.hits ?? []) {
    const imgUrl = h.fullHDURL || h.largeImageURL || h.webformatURL;
    if (!imgUrl) continue;
    hits.push({
      source: "pixabay",
      dedupeId: `pixabay:${h.id}`,
      desc: pixabayDesc(h.tags, h.pageURL),
      thumbUrl: h.webformatURL || h.previewURL || "",
      author: h.user ?? null,
      sourceUrl: h.pageURL ?? "",
      meta: h.imageWidth && h.imageHeight ? `${h.imageWidth}x${h.imageHeight}` : "photo",
      download: (out) => downloadUrlToFile(imgUrl, out, opts.runId),
      downloadUrl: imgUrl,
    });
  }
  return hits;
}

/** Query EVERY configured source for one query, pool the normalized hits.
 *  A source that errors is logged and skipped (never fails the whole gather). */
async function gatherHits(
  kind: "video" | "photo",
  query: string,
  opts: { runId: string; orientation: Orientation; maxHeight: number; minDuration: number }
): Promise<FootageHit[]> {
  const sources = configuredFootageSources();
  const tasks = sources.map(async (src): Promise<FootageHit[]> => {
    const cacheKey = `${src}:${kind}:${opts.orientation}:${query.trim().toLowerCase()}`;

    // 1. Check Search Cache
    try {
      const cached = getSearchCacheStmt.get(cacheKey) as { value: string; created_at: number } | undefined;
      if (cached) {
        const now = Date.now();
        const ageMs = now - cached.created_at;
        if (ageMs < 24 * 60 * 60 * 1000) { // 24h TTL
          const parsed = JSON.parse(cached.value) as any[];
          const deserialized = parsed.map((sh) => deserializeHit(sh, opts.runId));
          getOrCreateStats(opts.runId).cacheHits++;
          log(opts.runId, "debug", `Search cache hit for ${src} ${kind}: "${query}"`, { stage: "animate" });
          return deserialized;
        }
      }
    } catch (e) {
      // ignore
    }

    // 2. Cooldown check before API calls
    if (src === "pexels") {
      if (isPexelsSuspended()) {
        const now = Date.now();
        if (now - lastAllPexelsKeysLimitedLogTime > 60000) {
          lastAllPexelsKeysLimitedLogTime = now;
          log(opts.runId, "warn", "All Pexels keys are currently rate-limited — skipping Pexels searches, continuing with cache and Pixabay if available", { stage: "animate" });
        }
        return [];
      }
    } else if (src === "pixabay") {
      if (isPixabaySuspended()) {
        log(opts.runId, "debug", `Pixabay search skipped (suspended due to rate limit): "${query}"`, { stage: "animate" });
        return [];
      }
    }

    // 3. API Call on Cache Miss
    getOrCreateStats(opts.runId).cacheMisses++;
    try {
      let hits: FootageHit[] = [];
      if (src === "pexels") {
        hits = kind === "video"
          ? await pexelsVideoHits(query, opts)
          : await pexelsPhotoHits(query, opts);
      } else if (src === "pixabay") {
        hits = kind === "video"
          ? await pixabayVideoHits(query, { orientation: opts.orientation, minDuration: opts.minDuration, runId: opts.runId })
          : await pixabayPhotoHits(query, { orientation: opts.orientation, runId: opts.runId });
      }

      // 4. Save to Search Cache if hits found
      if (hits.length > 0) {
        const serializable = hits.map((h) => ({
          source: h.source,
          dedupeId: h.dedupeId,
          desc: h.desc,
          thumbUrl: h.thumbUrl,
          author: h.author,
          sourceUrl: h.sourceUrl,
          meta: h.meta,
          pexelsVideoFile: h.pexelsVideoFile,
          pexelsPhotoUrl: h.pexelsPhotoUrl,
          downloadUrl: h.downloadUrl,
        }));
        try {
          insertSearchCacheStmt.run(cacheKey, JSON.stringify(serializable), Date.now());
        } catch (e) {
          // ignore
        }
      }
      return hits;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(opts.runId, "debug", `${src} ${kind} search failed for "${query}": ${msg.slice(0, 120)}`, {
        stage: "animate",
      });
      return [];
    }
  });

  const results = await Promise.all(tasks);
  const seen = new Set<string>();
  const out: FootageHit[] = [];
  for (const h of results.flat()) {
    if (seen.has(h.dedupeId)) continue;
    seen.add(h.dedupeId);
    out.push(h);
  }
  return out;
}

/** Downloads a thumbnail → base64 for an inline Gemini Vision image part.
 *  Returns null on any problem (non-image, too big, error) so the caller skips it. */
async function fetchThumbInline(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 4_000_000) return null;
    return { data: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

/** Progressively broaden a query to widen the candidate net on later attempts. */
function broadenQuery(query: string, level: number): string {
  if (level <= 0) return query;
  const words = relevanceTokens(query);
  const keep = level === 1 ? 4 : 2; // attempt 2 → top 4 words, attempt 3 → top 2
  return (words.length ? words : query.split(/\s+/)).slice(0, keep).join(" ") || query;
}

/**
 * VISION relevance — Gemini LOOKS AT each candidate's thumbnail (not its text)
 * and scores 0..1 how well the IMAGE fits (a) this scene's narration moment and
 * (b) the whole video's context. One call, up to `MAX` thumbnails attached.
 * Returns scores per hit, or null when disabled / no key / no usable thumbnails
 * / any error — the caller then falls back to the local text score, so a run is
 * NEVER blocked by the vision step.
 */
const visionLimits = new Map<string, any>();

function getVisionLimitForRun(runId: string): any {
  let lim = visionLimits.get(runId);
  if (!lim) {
    const limitVal = Math.max(1, Number(getSetting("VISION_CONCURRENCY") || "2"));
    lim = pLimit(limitVal);
    visionLimits.set(runId, lim);
  }
  return lim;
}

async function aiScoreHitsByVision(
  runId: string,
  sceneText: string,
  videoContext: string,
  hits: FootageHit[]
): Promise<Map<string, number> | null> {
  if ((getSetting("FOOTAGE_AI_PICK") || "on").trim().toLowerCase() === "off") return null;
  const apiKey = getSetting("GOOGLE_API_KEY").trim();
  if (!apiKey) return null;

  if (isVisionCooldown()) {
    return null;
  }

  const model = getSetting("GEMINI_VISION_MODEL") || "gemini-flash-latest";
  const visualIntentRepr = `intent:${sceneText} context:${videoContext}`;
  const intentHash = getShortHash(visualIntentRepr);

  const scoresMap = new Map<string, number>();
  const toQuery: FootageHit[] = [];

  for (const h of hits) {
    const key = `${model}:${h.dedupeId}:${intentHash}`;
    let cachedScore: number | null = null;
    try {
      const cached = getVisionCacheStmt.get(key) as { score: number; created_at: number } | undefined;
      if (cached) {
        const now = Date.now();
        if (now - cached.created_at < 7 * 24 * 60 * 60 * 1000) {
          cachedScore = cached.score;
        }
      }
    } catch (e) {
      // ignore
    }

    if (cachedScore !== null) {
      scoresMap.set(h.dedupeId, cachedScore);
      getOrCreateStats(runId).cacheHits++;
    } else {
      toQuery.push(h);
      getOrCreateStats(runId).cacheMisses++;
    }
  }

  if (toQuery.length === 0) {
    return scoresMap;
  }

  const limit = getVisionLimitForRun(runId);
  return limit(async () => {
    if (isVisionCooldown()) {
      return scoresMap.size > 0 ? scoresMap : null;
    }

    const MAX = Math.max(1, Number(getSetting("VISION_CANDIDATE_LIMIT") || "8"));
    const subset = toQuery.filter((h) => h.thumbUrl).slice(0, MAX);
    if (subset.length === 0) {
      return scoresMap.size > 0 ? scoresMap : null;
    }

    const thumbs = await Promise.all(subset.map((h) => fetchThumbInline(h.thumbUrl)));
    const usable = subset
      .map((h, i) => ({ h, t: thumbs[i] }))
      .filter((x): x is { h: FootageHit; t: { data: string; mime: string } } => x.t !== null);
    if (usable.length === 0) {
      return scoresMap.size > 0 ? scoresMap : null;
    }

    getOrCreateStats(runId).geminiVisionCalls++;

    const parts: unknown[] = [
      {
        text:
          `You are choosing B-roll footage for ONE moment of a video.\n` +
          (videoContext ? `The whole video is about: "${videoContext.slice(0, 300)}".\n` : "") +
          `This moment's narration: "${sceneText.slice(0, 300)}".\n\n` +
          `${usable.length} candidate images follow, each labelled "index N". LOOK AT EACH IMAGE and score 0-100 how well what is ACTUALLY SHOWN fits this moment AND the video's overall context (100 = perfect on-screen match). Judge only by the visible content, not by any text.\n` +
          `Return STRICTLY a JSON array [{"i":<N>,"score":<int>}] covering all ${usable.length}. No markdown.`,
      },
    ];
    usable.forEach((x, i) => {
      parts.push({ text: `index ${i}` });
      parts.push({ inlineData: { mimeType: x.t.mime, data: x.t.data } });
    });

    try {
      log(runId, "debug", `Gemini vision scoring with model ${model}`, { stage: "animate" });

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
          }),
        }
      );
      if (!r.ok) {
        if (r.status === 429) {
          getOrCreateStats(runId).geminiVision429s++;
          setVisionCooldown();
          log(runId, "warn", "Gemini Vision rate-limited — cooling down for 120s, using text score temporarily", { stage: "animate" });
          throw new Error("Gemini Vision 429");
        }
        if (r.status === 404) {
          throw new Error(`Gemini vision 404 using model ${model}`);
        }
        throw new Error(`Gemini vision ${r.status}`);
      }
      const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
      
      for (const x of arr) {
        const u = usable[Number(x.i)];
        if (u) {
          const scoreVal = Math.max(0, Math.min(100, Number(x.score))) / 100;
          const key = `${model}:${u.h.dedupeId}:${intentHash}`;
          try {
            insertVisionCacheStmt.run(key, scoreVal, Date.now());
          } catch (e) {
            // ignore
          }
          scoresMap.set(u.h.dedupeId, scoreVal);
        }
      }
      return scoresMap.size > 0 ? scoresMap : null;
    } catch (e) {
      log(runId, "debug", `Vision scoring unavailable (fallback to text score): ${(e as Error).message.slice(0, 100)}`, {
        stage: "animate",
      });
      return scoresMap.size > 0 ? scoresMap : null;
    }
  });
}

interface PoolHit {
  hit: FootageHit;
  score: number;        // 0..1 — vision score if available, else local text score
  via: "vision" | "text";
  query: string;
}

/**
 * Unified acquire: best matching VIDEO or PHOTO for a scene across all sources.
 *
 * Per Vlad's spec:
 *   1. Search Pexels + Pixabay for the scene's query; pool the candidates.
 *   2. Gemini LOOKS AT each candidate's thumbnail and scores it 0–100 vs this
 *      moment + the whole-video context (falls back to a local text score if
 *      vision is unavailable).
 *   3. If any candidate scores ≥ 80%, take the HIGHEST and stop. Otherwise
 *      broaden the search and try again, up to 3 attempts total.
 *   4. After 3 attempts with nothing ≥ 80%, descend the bar (70% → 60% → 50%)
 *      over everything found so far and take the highest that clears it.
 *   5. If still nothing, take the single best candidate — a scene NEVER fails.
 *
 * Thresholds are hardcoded (not user-facing). Shared cross-source `usedIds`
 * ("source:id") stop two scenes grabbing the same asset.
 */
const VISION_TIERS = [0.8, 0.7, 0.6, 0.5];

async function acquireFootage(
  kind: "video" | "photo",
  scene: Scene,
  outPath: string,
  options: AcquireOptions
): Promise<{ author: string | null; sourceUrl: string; source: string; dedupeId: string }> {
  const { runId, orientation = "landscape", maxHeight = 1080, minDuration = 4, usedIds, avoidDedupeIds, videoContext = "", anchorWords } = options;
  const gatherOpts = { runId, orientation, maxHeight, minDuration };

  const baseQueries = sceneQueryCandidates(scene);
  if (baseQueries.length === 0) {
    throw new Error(`Scene #${scene.index}: empty query (no visual_queries)`);
  }
  const queryTokenLists = baseQueries.map(relevanceTokens);
  let lastErr: unknown;

  const tryList = async (list: PoolHit[], ignoreAvoidList = false) => {
    if (list.length === 0) return null;
    const fresh = usedIds && usedIds.size > 0 ? list.filter((s) => !usedIds.has(s.hit.dedupeId)) : list;
    const ordered = fresh.length > 0 ? fresh : list;
    const reusing = fresh.length === 0 && usedIds && usedIds.size > 0;
    for (const s of ordered) {
      if (usedIds && usedIds.has(s.hit.dedupeId) && !reusing) continue;

      if (!ignoreAvoidList && avoidDedupeIds && avoidDedupeIds.has(s.hit.dedupeId)) {
        log(runId, "warn", `Skipping adjacent duplicate footage: ${s.hit.dedupeId}`, { stage: "animate" });
        continue;
      }

      if (usedIds && !usedIds.has(s.hit.dedupeId)) usedIds.add(s.hit.dedupeId);
      try {
        await downloadWithCache(s.hit, outPath, runId);
        const reusedTag = reusing ? " (reused — no fresh matches)" : "";

        if (ignoreAvoidList && avoidDedupeIds && avoidDedupeIds.has(s.hit.dedupeId)) {
          log(runId, "warn", `Adjacent duplicate allowed only because no alternative footage was found`, { stage: "animate" });
        }

        log(
          runId,
          "info",
          `${kind} via ${s.hit.source}: ${s.hit.dedupeId} ${s.hit.meta} by ${s.hit.author ?? "?"}${reusedTag} [${s.via} match ${(s.score * 100).toFixed(0)}% · "${s.query}"]`,
          { stage: "animate", data: { source: s.hit.source, author: s.hit.author, sourceUrl: s.hit.sourceUrl } }
        );
        return { author: s.hit.author, sourceUrl: s.hit.sourceUrl, source: s.hit.source, dedupeId: s.hit.dedupeId };
      } catch (e) {
        if (usedIds && !reusing) usedIds.delete(s.hit.dedupeId);
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "warn", `${s.hit.source} download failed (${s.hit.dedupeId}), trying next: ${msg.slice(0, 150)}`, {
          stage: "animate",
        });
      }
    }
    return null;
  };

  // Accumulate scored candidates across attempts (deduped by asset id).
  const pool: PoolHit[] = [];
  const seen = new Set<string>();

  const maxAttempts = Math.max(1, Number(getSetting("FOOTAGE_SEARCH_ATTEMPTS") || "3"));

  // Up to maxAttempts search attempts; broaden the query each round to widen the net.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const baseQuery = baseQueries[Math.min(attempt, baseQueries.length - 1)];
    const query = attempt < baseQueries.length ? baseQuery : broadenQuery(baseQueries[0], attempt);
    log(runId, "debug", `Footage search [${configuredFootageSources().join("+")}] attempt ${attempt + 1}/${maxAttempts}: "${query}"`, {
      stage: "animate",
    });

    const hits = (await gatherHits(kind, query, gatherOpts)).filter((h) => !seen.has(h.dedupeId));
    if (hits.length === 0) {
      lastErr = lastErr ?? new Error(`no ${kind} results for "${query}"`);
      continue;
    }
    hits.forEach((h) => seen.add(h.dedupeId));

    // Local text score — used to pre-pick which thumbnails to send to vision,
    // and as the fallback score when vision is unavailable.
    const localScored = hits
      .map((h) => ({ hit: h, local: relevanceScore(relevanceTokens(h.desc), queryTokenLists, anchorWords) }))
      .sort((a, b) => b.local - a.local);

    // Apply avoid/filtering before vision scoring:
    let candidatesToScore = localScored.filter(x => {
      // Exclude adjacent duplicate IDs from vision checks
      if (avoidDedupeIds && avoidDedupeIds.has(x.hit.dedupeId)) {
        return false;
      }
      return x.local > 0; // Don't send completely bad matches to Vision
    });

    // Fallback: if everything is filtered out but we have hits, let's keep them so we don't return nothing
    if (candidatesToScore.length === 0 && localScored.length > 0) {
      candidatesToScore = localScored;
    }

    const visLimit = Math.max(1, Number(getSetting("VISION_CANDIDATE_LIMIT") || "8"));
    const toScore = candidatesToScore.slice(0, visLimit).map((x) => x.hit);

    const vision = await aiScoreHitsByVision(runId, scene.text, videoContext, toScore);
    for (const x of localScored) {
      const v = vision?.get(x.hit.dedupeId);
      pool.push({
        hit: x.hit,
        score: v !== undefined ? v : x.local,
        via: v !== undefined ? "vision" : "text",
        query,
      });
    }
    pool.sort((a, b) => b.score - a.score);

    // Found a strong (≥80%) match → take the best and stop searching.
    if (pool[0] && pool[0].score >= VISION_TIERS[0]) {
      const got = await tryList(pool.filter((p) => p.score >= VISION_TIERS[0]));
      if (got) return got;
    } else if (attempt < maxAttempts - 1) {
      log(runId, "debug", `Best so far ${((pool[0]?.score ?? 0) * 100).toFixed(0)}% < 80% — broadening`, {
        stage: "animate",
      });
    }
  }

  // No ≥80% match after maxAttempts attempts — descend the bar over everything found.
  if (pool.length > 0) {
    pool.sort((a, b) => b.score - a.score);
    for (const tier of VISION_TIERS) {
      const atTier = pool.filter((p) => p.score >= tier);
      if (atTier.length === 0) continue;
      if (tier < VISION_TIERS[0]) {
        log(runId, "info", `Scene #${scene.index}: no ≥80% match — taking best ≥${(tier * 100).toFixed(0)}% (${(atTier[0].score * 100).toFixed(0)}%)`, {
          stage: "animate",
        });
      }
      const got = await tryList(atTier);
      if (got) return got;
    }
    // Below every tier — take the single best rather than fail the scene.
    log(runId, "warn", `Scene #${scene.index}: weak match only — using best available (${((pool[0]?.score ?? 0) * 100).toFixed(0)}%)`, {
      stage: "animate",
    });
    const got = await tryList(pool);
    if (got) return got;
  }

  // Last resort: if we got nothing because of avoid list, try pool again allowing avoided assets
  if (pool.length > 0 && avoidDedupeIds && avoidDedupeIds.size > 0) {
    log(runId, "warn", `Scene #${scene.index}: all candidates skipped due to adjacent duplicate. Retrying with duplicate allowed as fallback.`, {
      stage: "animate",
    });
    const got = await tryList(pool, true);
    if (got) return got;
  }

  const tried = baseQueries.map((q) => `"${q}"`).join(", ");
  throw new Error(
    `No ${kind} found for scene #${scene.index} across [${configuredFootageSources().join("+")}] (tried ${tried})` +
      (lastErr instanceof Error ? `: ${lastErr.message.slice(0, 150)}` : "")
  );
}

export interface AcquireOptions {
  runId: string;
  orientation?: Orientation;
  maxHeight?: number;
  minDuration?: number;
  /**
   * MUTABLE set of cross-source asset ids ("pexels:123" / "pixabay:45") already
   * claimed/downloaded in this run. Read to skip duplicates AND added to
   * atomically before download (JS is single-threaded, so nothing interleaves
   * between has() and add() — even 5 parallel scenes never grab the same asset).
   *
   * Pass a fresh `new Set<string>()` per pipeline run.
   */
  usedIds?: Set<string>;
  /** Set of asset ids to avoid for adjacent duplicates. */
  avoidDedupeIds?: Set<string>;
  /** One-line summary of the whole video, for the vision relevance scorer. */
  videoContext?: string;
  anchorWords?: string[];
}

/**
 * High-level helper: search Pexels for a scene's visual_prompt, download the
 * best non-duplicate candidate to outPath. Returns the picked video id.
 *
 * Deduplication: when `usedIds` is provided, candidates already in the set
 * are skipped and the picked id is added to the set before the download
 * starts (so concurrent scenes can't all grab the same clip). If every
 * candidate is already used, falls back to reusing — better a repeat clip
 * than a failed scene.
 *
 * Throws if no candidates download successfully.
 */
export async function acquireStockClipForScene(
  scene: Scene,
  outPath: string,
  options: AcquireOptions
): Promise<{ author: string | null; sourceUrl: string; source: string; dedupeId: string }> {
  return acquireFootage("video", scene, outPath, options);
}

// ── Photo acquisition (mirror of acquireStockClipForScene) ───────────────────

export interface AcquirePhotoOptions {
  runId: string;
  orientation?: Orientation;
  maxHeight?: number;
  /** Mutable set of cross-source PHOTO ids ("pexels:123" / "pixabay:45") used in
   *  this run. Kept SEPARATE from the video set (a video and a photo can share an
   *  id within a source, but they're distinct assets). Pass `new Set<string>()`. */
  usedIds?: Set<string>;
  /** Set of asset ids to avoid for adjacent duplicates. */
  avoidDedupeIds?: Set<string>;
  /** One-line summary of the whole video, for the vision relevance scorer. */
  videoContext?: string;
  anchorWords?: string[];
}

/**
 * High-level helper: search Pexels for a scene's visual_prompt, download the
 * best non-duplicate photo to outPath as JPG. Mirrors `acquireStockClipForScene`
 * but for photos (Pexels has separate video and photo libraries — same scene
 * can yield both, so we keep separate `usedIds` sets per kind).
 *
 * The photo will be turned into a moving clip by FFmpeg's ken-burns step later.
 */
export async function acquireStockPhotoForScene(
  scene: Scene,
  outPath: string,
  options: AcquirePhotoOptions
): Promise<{ author: string | null; sourceUrl: string; source: string; dedupeId: string }> {
  return acquireFootage("photo", scene, outPath, options);
}

export function logRunStats(runId: string) {
  const stats = getOrCreateStats(runId);
  const report = [
    "Stock usage summary:",
    `* Pexels API calls: ${stats.pexelsCalls}`,
    `* Pixabay API calls: ${stats.pixabayCalls}`,
    `* Gemini Vision calls: ${stats.geminiVisionCalls}`,
    `* Cache hits: ${stats.cacheHits}`,
    `* Cache misses: ${stats.cacheMisses}`,
    `* Pexels 429 count: ${stats.pexels429s}`,
    `* Pixabay 429 count: ${stats.pixabay429s}`,
    `* Gemini Vision 429 count: ${stats.geminiVision429s}`,
    `* Assets reused from cache: ${stats.assetsReusedFromCache}`
  ].join("\n");
  log(runId, "success", report, { stage: "pipeline" });
}
