import fs from "node:fs";
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
    const resp = await fetch(url, { headers: { Authorization: state.key } });

    if (resp.status === 429) {
      hits429++;
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

/** Loose word match so "shopping" pairs with "shop", "waves" with "wave":
 *  exact, or one is a ≥4-char prefix of the other. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * 0..1: how much of ONE of the scene's queries this candidate's description
 * covers (the best-matching query wins). 1 = every meaningful word of a query
 * is present; 0 = shares nothing with any query, or has no description at all.
 */
function relevanceScore(candTokens: string[], queryTokenLists: string[][]): number {
  if (candTokens.length === 0) return 0;
  let best = 0;
  for (const q of queryTokenLists) {
    if (q.length === 0) continue;
    let hit = 0;
    for (const t of q) if (candTokens.some((c) => tokensMatch(c, t))) hit++;
    if (hit / q.length > best) best = hit / q.length;
  }
  return best;
}

/** FOOTAGE_MATCH_STRICTNESS → minimum relevance score. 0 = scoring off. */
function relevanceThreshold(): number {
  const v = (getSetting("FOOTAGE_MATCH_STRICTNESS") || "normal").trim().toLowerCase();
  if (v === "off") return 0;
  if (v === "strict") return 0.6;
  return 0.34; // "normal" — kills shares-nothing / one-word-of-three matches
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
  desc: string;         // slug / alt / tags — scored against the scene's queries
  author: string | null;
  sourceUrl: string;
  meta: string;         // short label for logs, e.g. "1920x1080 12s"
  download: (outPath: string) => Promise<void>;
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
async function downloadUrlToFile(url: string, outPath: string): Promise<void> {
  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
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
      author: v.user?.name ?? null,
      sourceUrl: v.url,
      meta: `${file.width}x${file.height} ${v.duration}s`,
      download: (out) => downloadPexelsVideo(file, out),
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
      author: p.photographer || null,
      sourceUrl: p.url,
      meta: `${p.width}x${p.height}`,
      download: (out) => downloadPexelsPhoto(url, out),
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
  opts: { orientation: Orientation; minDuration: number }
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

  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
  if (!resp.ok) throw new Error(`Pixabay videos HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: {
      id: number;
      duration?: number;
      pageURL?: string;
      user?: string;
      tags?: string;
      videos?: Record<string, { url: string; width: number; height: number }>;
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
      author: h.user ?? null,
      sourceUrl: h.pageURL ?? "",
      meta: `${v.width}x${v.height}${h.duration ? ` ${h.duration}s` : ""}`,
      download: (out) => downloadUrlToFile(fileUrl, out),
    });
  }
  return hits;
}

async function pixabayPhotoHits(
  query: string,
  opts: { orientation: Orientation }
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

  const resp = await fetch(url, { headers: { "User-Agent": FOOTAGE_UA } });
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
      author: h.user ?? null,
      sourceUrl: h.pageURL ?? "",
      meta: h.imageWidth && h.imageHeight ? `${h.imageWidth}x${h.imageHeight}` : "photo",
      download: (out) => downloadUrlToFile(imgUrl, out),
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
    try {
      if (src === "pexels") {
        return kind === "video"
          ? await pexelsVideoHits(query, opts)
          : await pexelsPhotoHits(query, opts);
      }
      if (src === "pixabay") {
        return kind === "video"
          ? await pixabayVideoHits(query, { orientation: opts.orientation, minDuration: opts.minDuration })
          : await pixabayPhotoHits(query, { orientation: opts.orientation });
      }
      return [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(opts.runId, "debug", `${src} ${kind} search failed for "${query}": ${msg.slice(0, 120)}`, {
        stage: "animate",
      });
      return [];
    }
  });
  const results = await Promise.all(tasks);
  // Dedupe across sources (defensive — ids are namespaced so collisions are rare).
  const seen = new Set<string>();
  const out: FootageHit[] = [];
  for (const h of results.flat()) {
    if (seen.has(h.dedupeId)) continue;
    seen.add(h.dedupeId);
    out.push(h);
  }
  return out;
}

interface ScoredHit {
  hit: FootageHit;
  score: number;
  hasDesc: boolean;
  query: string;
}

/**
 * Gemini picks the most relevant candidate. Given the locally-decent pool, it
 * scores each 0–100 against the scene's visual goal and returns them best-first.
 * This is the "AI chooses the footage" step. Fail-open: returns null (keep the
 * local order) when disabled, no Google key, too few candidates, or any error —
 * a run must NEVER fail because of the picker. Only the top 8 are sent (cheap;
 * one short call). Disable with FOOTAGE_AI_PICK = off.
 */
async function aiReorderHits(runId: string, query: string, pool: ScoredHit[]): Promise<ScoredHit[] | null> {
  if ((getSetting("FOOTAGE_AI_PICK") || "on").trim().toLowerCase() === "off") return null;
  const apiKey = getSetting("GOOGLE_API_KEY").trim();
  if (!apiKey || pool.length <= 1) return null;

  const top = pool.slice(0, 8);
  const lines = top.map((s, i) => `[${i}] ${(s.hit.desc || s.hit.dedupeId).slice(0, 80)}`).join("\n");
  const prompt =
    `Visual goal for a video scene: "${query}"\n\n` +
    `Stock footage candidates (one per line as "[index] description"):\n${lines}\n\n` +
    `Score EACH candidate 0-100 for how well it visually matches the goal (100 = exactly this). ` +
    `Return STRICTLY a JSON array [{"i": <index>, "score": <int>}] for all candidates. No markdown.`;
  try {
    const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
    const ai = new Map(arr.map((x) => [Number(x.i), Number(x.score)]));
    const reordered = top
      .map((s, i) => ({ s, ai: ai.get(i) ?? -1 }))
      .sort((a, b) => b.ai - a.ai)
      .map((x) => x.s);
    log(runId, "debug", `AI pick for "${query}": top → "${(reordered[0]?.hit.desc || "?").slice(0, 50)}"`, {
      stage: "animate",
    });
    return reordered;
  } catch {
    return null; // fail-open — keep local order
  }
}

/**
 * Unified acquire: pull the best matching VIDEO or PHOTO for a scene across all
 * configured sources. Per query candidate: gather from all sources → score
 * locally → let Gemini pick the best → download the winner. Below-threshold
 * hits are held in reserve so a scene NEVER fails for lack of a perfect match
 * (best-available is used with a warning). Shared `usedIds` (cross-source
 * "source:id" strings) prevents two scenes grabbing the same asset.
 */
async function acquireFootage(
  kind: "video" | "photo",
  scene: Scene,
  outPath: string,
  options: AcquireOptions
): Promise<{ author: string | null; sourceUrl: string; source: string }> {
  const { runId, orientation = "landscape", maxHeight = 1080, minDuration = 4, usedIds } = options;
  const gatherOpts = { runId, orientation, maxHeight, minDuration };

  const candidates = sceneQueryCandidates(scene);
  if (candidates.length === 0) {
    throw new Error(`Scene #${scene.index}: empty query (no visual_queries)`);
  }
  const threshold = relevanceThreshold();
  const queryTokenLists = candidates.map(relevanceTokens);
  const reserve: ScoredHit[] = [];
  let lastErr: unknown;

  const tryList = async (list: ScoredHit[]) => {
    if (list.length === 0) return null;
    const fresh = usedIds && usedIds.size > 0 ? list.filter((s) => !usedIds.has(s.hit.dedupeId)) : list;
    const ordered = fresh.length > 0 ? fresh : list;
    const reusing = fresh.length === 0 && usedIds && usedIds.size > 0;
    for (const s of ordered) {
      if (usedIds && usedIds.has(s.hit.dedupeId) && !reusing) continue;
      if (usedIds && !usedIds.has(s.hit.dedupeId)) usedIds.add(s.hit.dedupeId);
      try {
        await s.hit.download(outPath);
        const reusedTag = reusing ? " (reused — no fresh matches)" : "";
        log(
          runId,
          "info",
          `${kind} via ${s.hit.source}: ${s.hit.dedupeId} ${s.hit.meta} by ${s.hit.author ?? "?"}${reusedTag} [${s.query} · match ${s.score.toFixed(2)}]`,
          { stage: "animate", data: { source: s.hit.source, author: s.hit.author, sourceUrl: s.hit.sourceUrl } }
        );
        return { author: s.hit.author, sourceUrl: s.hit.sourceUrl, source: s.hit.source };
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

  for (let qi = 0; qi < candidates.length; qi++) {
    const query = candidates[qi];
    const tag = candidates.length > 1 ? ` (query ${qi + 1}/${candidates.length})` : "";
    log(runId, "debug", `Footage search [${configuredFootageSources().join("+")}]${tag}: "${query}"`, {
      stage: "animate",
    });

    const hits = await gatherHits(kind, query, gatherOpts);
    if (hits.length === 0) {
      lastErr = new Error(`no ${kind} results for "${query}"`);
      if (qi < candidates.length - 1) {
        log(runId, "debug", `No ${kind} for "${query}" — trying next query`, { stage: "animate" });
      }
      continue;
    }

    const scored: ScoredHit[] = hits.map((h) => {
      const d = relevanceTokens(h.desc);
      return { hit: h, score: relevanceScore(d, queryTokenLists), hasDesc: d.length > 0, query };
    });

    let pool: ScoredHit[];
    if (threshold > 0 && scored.some((s) => s.hasDesc)) {
      const ranked = scored.slice().sort((a, b) => b.score - a.score);
      pool = ranked.filter((s) => s.score >= threshold);
      reserve.push(...ranked.filter((s) => s.score < threshold));
      if (pool.length === 0) {
        const best = ranked[0]?.score ?? 0;
        log(runId, "debug", `Nothing ≥ ${threshold} for "${query}" (best ${best.toFixed(2)}) — next query`, {
          stage: "animate",
        });
        continue;
      }
    } else {
      pool = scored.slice().sort((a, b) => b.score - a.score);
    }

    // Gemini picks the single best from the locally-decent pool (his requirement).
    const reordered = await aiReorderHits(runId, query, pool);
    const got = await tryList(reordered ?? pool);
    if (got) return got;
    // Everything in this query's pool failed to download — try the next query.
  }

  // Nothing met the bar anywhere — use the best below-threshold candidate.
  if (reserve.length > 0) {
    reserve.sort((a, b) => b.score - a.score);
    log(
      runId,
      "warn",
      `Scene #${scene.index}: no ${kind} met the relevance threshold — using best available (match ${reserve[0].score.toFixed(2)})`,
      { stage: "animate" }
    );
    const got = await tryList(reserve);
    if (got) return got;
  }

  const tried = candidates.map((q) => `"${q}"`).join(", ");
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
): Promise<{ author: string | null; sourceUrl: string; source: string }> {
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
): Promise<{ author: string | null; sourceUrl: string; source: string }> {
  return acquireFootage("photo", scene, outPath, options);
}
