import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { synthesizeFullScript } from "./tts";
import { downsampleForTranscription, capPauses, probeDurationSafe } from "./video-assemble";
import type { Scene } from "./scene-split";

/** One transcribed word from Whisper, in milliseconds. */
export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
}

/** Range of the global single-shot audio file that belongs to one scene. */
export interface SceneAudioRange {
  sceneIdx: number;
  startMs: number;
  endMs: number;
  /**
   * For scenes that carry an `overlay` token, the audio time (ms) when that
   * token is actually SPOKEN — taken from the matched Whisper word when found,
   * else estimated from the token's word position in the scene. Lets the
   * assembler pop the caption exactly on the word instead of mid-scene.
   */
  overlayAtMs?: number;
}

/** Result of synthesize-then-align: one mp3 + per-scene timing. */
export interface SingleShotAudio {
  /** Path to the one continuous voiceover mp3 for the whole script. */
  filePath: string;
  /** Total mp3 duration in seconds (ffprobe-measured). */
  durationSec: number;
  /** [startMs, endMs] of each scene's words inside `filePath`. */
  ranges: SceneAudioRange[];
  /** The full Whisper transcript words with timestamps. */
  transcript?: TranscriptWord[];
}

/**
 * Single-shot TTS + Groq Whisper alignment.
 *
 * Why this exists:
 *   Per-scene TTS calls each produce a STANDALONE intonation arc — and worse,
 *   a sentence that spans two scenes gets read as two disconnected pieces, so
 *   the listener hears an unnatural pause in the MIDDLE of a sentence at every
 *   scene boundary. The fix isn't a setting tweak — it's an architectural
 *   change: synthesize the whole script once, then time the visuals to it.
 *
 * Strategy:
 *   1. Concatenate every scene's text and call TTS ONCE → one continuous mp3.
 *   2. Send that mp3 to Groq Whisper (whisper-large-v3) and request word-level
 *      timestamps via response_format=verbose_json, timestamp_granularities=[word].
 *      Groq pricing: ~$0.11/h audio — pennies per video, and the free tier
 *      covers normal use.
 *   3. Greedy-align source scene words to Whisper transcript words →
 *      { sceneIdx, startMs, endMs } for each scene.
 *   4. The assembler uses these ranges: it renders per-scene visuals at the
 *      right durations and muxes the single global audio over the final
 *      silent video — no per-scene audio crossfade, no per-scene boundaries.
 */
export async function synthesizeAndAlign(
  runId: string,
  scenes: Scene[],
  audioDir: string,
  _options: Record<string, never> = {}
): Promise<SingleShotAudio> {
  if (scenes.length === 0) {
    throw new Error("synthesizeAndAlign: no scenes to align");
  }

  // 1. One TTS call (chunked at sentence boundaries internally) for the whole script.
  const fullText = scenes
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  const audioPath = path.join(audioDir, "full.mp3");
  log(
    runId,
    "info",
    `Single-shot TTS — one continuous voiceover for ${scenes.length} scenes (${fullText.length} chars)`,
    { stage: "tts_align" }
  );
  const synth = await synthesizeFullScript(runId, fullText, audioPath, {});
  let audioDurationSec = synth.durationSec;

  // 1b. Cap over-long pauses. Single-shot is one continuous take with no other
  //     pause knob (SCENE_TAIL_SILENCE is per-scene only), so this is where we
  //     tame the long gaps between sentences / at chunk seams. MAX_PAUSE_SECONDS
  //     <= 0 disables it. Done BEFORE transcription so Whisper timings match the
  //     final (capped) audio.
  const maxPause = parseFloat(getSetting("MAX_PAUSE_SECONDS") || "0");
  if (Number.isFinite(maxPause) && maxPause > 0) {
    try {
      await capPauses(audioPath, maxPause);
      const capped = await probeDurationSafe(audioPath);
      log(
        runId,
        "info",
        `Pauses capped to ≤${maxPause}s (voiceover ${audioDurationSec.toFixed(1)}s → ${capped.toFixed(1)}s)`,
        { stage: "tts_align" }
      );
      audioDurationSec = capped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Pause-cap skipped (using original audio): ${msg.slice(0, 150)}`, {
        stage: "tts_align",
      });
    }
  }

  // 2. Word-level transcription via Groq Whisper.
  log(
    runId,
    "info",
    `Transcribing ${audioDurationSec.toFixed(1)}s with Groq Whisper (whisper-large-v3, word timestamps)`,
    { stage: "tts_align" }
  );
  const transcript = await transcribeWithGroqWhisper(runId, audioPath);
  log(runId, "info", `Groq Whisper returned ${transcript.length} words`, { stage: "tts_align" });

  // 3. Align scene texts to transcript timestamps.
  const totalDurationMs = Math.round(audioDurationSec * 1000);
  const ranges = alignScenesToTranscript(scenes, transcript, totalDurationMs);
  const aligned = ranges.filter((r) => r.endMs > r.startMs + 1).length;
  log(
    runId,
    "success",
    `Single-shot align: ${aligned}/${scenes.length} scenes mapped to audio ranges, total ${(totalDurationMs / 1000).toFixed(1)}s`,
    { stage: "tts_align" }
  );

  return { filePath: audioPath, durationSec: audioDurationSec, ranges, transcript };
}

/**
 * Resume helper: aligns scene boundaries to an ALREADY-synthesised audio file
 * (audioDir/full.mp3 from a previous run). Skips the TTS call — just runs
 * Whisper transcription + greedy alignment. Lets a re-assembly avoid paying for
 * the voiceover twice. Caller passes the audio duration (from ffprobe) since we
 * can't infer it without re-decoding.
 *
 * NOTE: Conveyer Guilherme has no Resume UI wired up yet, so nothing calls this
 * today — it's here so a future resume path can reuse the exact alignment logic.
 */
export async function alignToExistingAudio(
  runId: string,
  scenes: Scene[],
  audioPath: string,
  audioDurationSec: number
): Promise<SingleShotAudio> {
  if (scenes.length === 0) {
    throw new Error("alignToExistingAudio: no scenes to align");
  }
  log(
    runId,
    "info",
    `Re-aligning existing audio (${audioDurationSec.toFixed(1)}s) — Whisper word timestamps`,
    { stage: "tts_align" }
  );
  const transcript = await transcribeWithGroqWhisper(runId, audioPath);
  log(runId, "info", `Groq Whisper returned ${transcript.length} words`, { stage: "tts_align" });
  const totalDurationMs = Math.round(audioDurationSec * 1000);
  const ranges = alignScenesToTranscript(scenes, transcript, totalDurationMs);
  const aligned = ranges.filter((r) => r.endMs > r.startMs + 1).length;
  log(
    runId,
    "success",
    `Re-align: ${aligned}/${scenes.length} scenes mapped to audio ranges`,
    { stage: "tts_align" }
  );
  return { filePath: audioPath, durationSec: audioDurationSec, ranges, transcript };
}

/**
 * Calls Groq Whisper (OpenAI-compatible endpoint) and returns word-level
 * timestamps in milliseconds.
 *
 * Endpoint: POST https://api.groq.com/openai/v1/audio/transcriptions
 *   multipart/form-data fields:
 *     file (audio bytes)
 *     model = whisper-large-v3
 *     response_format = verbose_json
 *     timestamp_granularities[] = word
 *   Auth: Authorization: Bearer ${GROQ_API_KEY}
 *
 * FREE-TIER 25 MB LIMIT: Groq's free tier rejects uploads larger than 25 MB and
 * a long full-quality mp3 (a 40-min narration ≈ 38 MB) blows past that. Whisper
 * downsamples everything to 16 kHz mono internally anyway, so we transcribe a
 * throwaway 16 kHz mono ~48 kbps copy (a fraction of the size, zero accuracy
 * loss) and delete it afterwards. The original full.mp3 stays full quality and
 * is what goes into the final video.
 *
 * Pricing as of writing: $0.111/hour audio. A 3-minute video ≈ $0.006.
 */
async function transcribeWithGroqWhisper(
  runId: string,
  audioPath: string
): Promise<TranscriptWord[]> {
  const apiKey = getSetting("GROQ_API_KEY");
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set — required for single-shot voiceover mode. Paste it in /settings (free tier covers normal use: https://console.groq.com/keys), or switch TTS_MODE to per-scene."
    );
  }

  // Downsample to a small temp file before upload (free-tier 25 MB fix).
  const tmpPath = path.join(
    os.tmpdir(),
    `conveyer_whisper_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`
  );
  let uploadPath = audioPath;
  try {
    await downsampleForTranscription(audioPath, tmpPath);
    uploadPath = tmpPath;
    try {
      const origMb = fs.statSync(audioPath).size / (1024 * 1024);
      const dsMb = fs.statSync(tmpPath).size / (1024 * 1024);
      log(
        runId,
        "debug",
        `Whisper upload downsampled to 16kHz mono (${origMb.toFixed(1)}MB → ${dsMb.toFixed(1)}MB)`,
        { stage: "tts_align" }
      );
    } catch {
      /* stat is best-effort logging only */
    }
  } catch (e) {
    // If downsampling fails for any reason, fall back to the original file —
    // it'll only be rejected if it's actually over 25 MB.
    const msg = e instanceof Error ? e.message : String(e);
    log(
      runId,
      "warn",
      `Whisper downsample failed (uploading original file): ${msg.slice(0, 150)}`,
      { stage: "tts_align" }
    );
    uploadPath = audioPath;
  }

  try {
    const buffer = fs.readFileSync(uploadPath);
    const blob = new Blob([buffer], { type: "audio/mpeg" });
    const fd = new FormData();
    fd.append("file", blob, "audio.mp3");
    fd.append("model", "whisper-large-v3");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");

    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error(`Groq Whisper ${r.status}: ${errBody.slice(0, 400)}`);
    }

    const json = (await r.json()) as {
      words?: { word: string; start: number; end: number }[];
      text?: string;
      duration?: number;
    };
    if (!Array.isArray(json.words)) {
      throw new Error(
        `Groq Whisper returned no word timestamps (response: ${JSON.stringify(json).slice(0, 200)})`
      );
    }
    return json.words.map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    }));
  } finally {
    // Always clean up the throwaway downsampled copy.
    if (uploadPath === tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

/** Strip non-alphanumeric chars and lowercase — used to compare source vs transcript words. */
function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/gi, "");
}

/**
 * Greedy word-by-word alignment between source scenes and Whisper transcript.
 *
 * Whisper occasionally swaps representations ("$2" → "two dollars", "5" →
 * "five") or skips/inserts a word. The matcher tolerates small drift (up to
 * MAX_TRANS_LOOKAHEAD transcript inserts and MAX_SOURCE_SKIP source misses)
 * before nudging the cursor to resync. Scenes whose words couldn't be located
 * are filled in by interpolating from neighbors. After that, boundaries are
 * smoothed: scene N+1 starts exactly where scene N ended; the last scene
 * runs to the total audio duration. This guarantees a hole-free timeline
 * for the assembler regardless of how rough alignment was.
 */
function alignScenesToTranscript(
  scenes: Scene[],
  transcript: TranscriptWord[],
  totalDurationMs: number
): SceneAudioRange[] {
  // Precompute, for each scene that has an overlay token, WHICH word in the
  // scene text is the token (by normalized match of the token's first word) so
  // we can capture exactly when it's spoken.
  const overlayAnchorByScene = new Map<number, { idxInScene: number; wordCount: number }>();
  for (const s of scenes) {
    const ov = (s.overlay || "").trim();
    if (!ov) continue;
    const target = normWord(ov.split(/\s+/)[0] || ov);
    if (!target) continue;
    const norms = s.text.split(/\s+/).map(normWord).filter(Boolean);
    let idx = norms.findIndex((n) => n === target);
    if (idx < 0) idx = norms.findIndex((n) => n.includes(target) || target.includes(n));
    overlayAnchorByScene.set(s.index, {
      idxInScene: idx >= 0 ? idx : 0,
      wordCount: Math.max(1, norms.length),
    });
  }

  type SourceWord = { sceneIdx: number; norm: string; overlayAnchor: boolean };
  const sourceWords: SourceWord[] = [];
  for (const s of scenes) {
    const anchor = overlayAnchorByScene.get(s.index);
    let wi = -1;
    for (const w of s.text.split(/\s+/)) {
      const n = normWord(w);
      if (!n) continue;
      wi++;
      sourceWords.push({
        sceneIdx: s.index,
        norm: n,
        overlayAnchor: anchor != null && wi === anchor.idxInScene,
      });
    }
  }
  const normTrans = transcript.map((t) => ({ ...t, norm: normWord(t.word) }));

  // Exact spoken time of each scene's overlay token, captured during matching.
  const overlayAtByScene = new Map<number, number>();

  const startByScene = new Map<number, number>();
  const endByScene = new Map<number, number>();
  let tCursor = 0;
  let sourceSkipStreak = 0;
  const MAX_TRANS_LOOKAHEAD = 4;
  const MAX_SOURCE_SKIP = 2;

  for (const sw of sourceWords) {
    let found = -1;
    const limit = Math.min(normTrans.length, tCursor + MAX_TRANS_LOOKAHEAD + 1);
    for (let i = tCursor; i < limit; i++) {
      if (normTrans[i].norm === sw.norm) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      sourceSkipStreak++;
      if (sourceSkipStreak > MAX_SOURCE_SKIP) {
        // Drift too far — nudge the transcript cursor to try to resync
        tCursor = Math.min(normTrans.length, tCursor + 1);
        sourceSkipStreak = 0;
      }
      continue;
    }
    sourceSkipStreak = 0;
    const tw = normTrans[found];
    if (!startByScene.has(sw.sceneIdx)) startByScene.set(sw.sceneIdx, tw.startMs);
    endByScene.set(sw.sceneIdx, tw.endMs);
    if (sw.overlayAnchor && !overlayAtByScene.has(sw.sceneIdx)) {
      overlayAtByScene.set(sw.sceneIdx, tw.startMs);
    }
    tCursor = found + 1;
  }

  // Raw ranges (may have unaligned scenes marked with -1)
  const raw: SceneAudioRange[] = scenes.map((s) => ({
    sceneIdx: s.index,
    startMs: startByScene.get(s.index) ?? -1,
    endMs: endByScene.get(s.index) ?? -1,
  }));

  // Fill un-aligned scenes from neighbors' anchors. For TAIL scenes with
  // no `after` anchor (Whisper failed to align the last words of the script),
  // distribute the remaining audio range PROPORTIONALLY by text word-count
  // across those tail scenes — otherwise they all collapse into one giant
  // range that produces a multi-minute freeze frame.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startMs >= 0 && raw[i].endMs >= 0) continue;
    const before = [...raw.slice(0, i)].reverse().find((r) => r.endMs >= 0);
    const after = raw.slice(i + 1).find((r) => r.startMs >= 0);
    if (after) {
      if (raw[i].startMs < 0) raw[i].startMs = before?.endMs ?? 0;
      if (raw[i].endMs < 0) raw[i].endMs = after.startMs;
    } else {
      // No further anchor — handle the unaligned tail proportionally below.
      // Mark as still unaligned for the second pass.
      if (raw[i].startMs < 0) raw[i].startMs = -1;
      if (raw[i].endMs < 0) raw[i].endMs = -1;
    }
  }

  // Second pass: distribute the unaligned tail across remaining scenes
  // proportionally by word count, so we don't get a giant final scene.
  const lastAlignedIdx = raw
    .map((r, k) => (r.endMs >= 0 ? k : -1))
    .filter((k) => k >= 0)
    .pop();
  if (lastAlignedIdx !== undefined && lastAlignedIdx < raw.length - 1) {
    const tailStart = raw[lastAlignedIdx].endMs;
    const tailScenes = scenes.slice(lastAlignedIdx + 1);
    const tailWords = tailScenes.map((s) => Math.max(1, (s.text || "").trim().split(/\s+/).length));
    const totalWords = tailWords.reduce((a, b) => a + b, 0);
    const tailTotalMs = Math.max(0, totalDurationMs - tailStart);
    let cursor = tailStart;
    for (let k = 0; k < tailScenes.length; k++) {
      const slice = Math.round((tailWords[k] / totalWords) * tailTotalMs);
      const idx = lastAlignedIdx + 1 + k;
      raw[idx].startMs = cursor;
      raw[idx].endMs = cursor + slice;
      cursor += slice;
    }
    // Snap last scene to EOF exactly to avoid rounding drift
    raw[raw.length - 1].endMs = totalDurationMs;
  }

  // Smooth boundaries — no gaps, no overlaps — and pin the last scene to EOF
  for (let i = 1; i < raw.length; i++) {
    raw[i].startMs = raw[i - 1].endMs;
  }
  if (raw.length > 0) raw[raw.length - 1].endMs = totalDurationMs;

  // Guard against collapsed (zero / negative duration) scenes
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].endMs <= raw[i].startMs) {
      raw[i].endMs = raw[i].startMs + 1;
    }
  }

  // Hard cap per scene at 30s. If a single scene exceeds 30s (Whisper failed
  // to align mid-script), it means we've inherited too much audio time on
  // one boundary. Cap and shift the excess into the immediate next scene.
  // Result is some audio playing over a slightly-wrong visual instead of an
  // 8-minute freeze frame. This is a safety net for alignment failures.
  const MAX_SCENE_MS = 30_000;
  for (let i = 0; i < raw.length - 1; i++) {
    const dur = raw[i].endMs - raw[i].startMs;
    if (dur > MAX_SCENE_MS) {
      raw[i].endMs = raw[i].startMs + MAX_SCENE_MS;
      raw[i + 1].startMs = raw[i].endMs;
      // Next scene absorbs the excess (its end is unchanged → it grows).
      raw[i + 1].endMs = Math.max(raw[i + 1].endMs, raw[i + 1].startMs + 1);
    }
  }
  // The LAST scene must ALWAYS reach the true audio end (totalDurationMs).
  // Never truncate it: capping the final scene made the silent-video total
  // shorter than the voiceover, so the final mux dropped the tail of the
  // narration ("large section of audio missing"). If the last scene ends up
  // long because alignment drift funnelled excess here, a freeze at the very
  // end is the lesser evil vs. lost audio — and the assembler's audio-
  // preserving mux holds the last frame anyway.
  if (raw.length > 0) {
    const last = raw[raw.length - 1];
    if (last.startMs >= totalDurationMs) last.startMs = Math.max(0, totalDurationMs - 1);
    last.endMs = totalDurationMs;
  }

  // Pin each overlay token to its spoken moment: the exact matched-word time if
  // Whisper aligned it, else estimated from the token's word position within the
  // scene. The assembler pops the caption here instead of mid-scene.
  for (const r of raw) {
    const a = overlayAnchorByScene.get(r.sceneIdx);
    if (!a) continue;
    const exact = overlayAtByScene.get(r.sceneIdx);
    r.overlayAtMs =
      exact != null
        ? exact
        : Math.round(r.startMs + (a.idxInScene / a.wordCount) * (r.endMs - r.startMs));
  }

  return raw;
}
