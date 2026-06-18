import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSetting } from "../settings";
import { resolveFfmpegBinary } from "./video-assemble";
import { extractIntroAudioClip, generateHeyGenAvatarFromAudio } from "./heygen";

export interface HeyGenIntroAssembleResult {
  ok: true;
  outputPath: string;
  heygenVideoPath: string;
  introAudioPath: string;
  requestedSeconds: number;
  seconds: number;
  cutReason: string;
  videoId: string;
  cached: boolean;
  duration?: number;
}

function videoSize(): { w: number; h: number } {
  const raw = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const [w, h] = raw.split("x").map((n) => Number(n));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 1920, h: 1080 };
  return { w, h };
}

function runFfmpeg(args: string[], label: string): string {
  const bin = resolveFfmpegBinary();
  const result = spawnSync(bin, args, { stdio: "pipe" });
  const stderr = result.stderr?.toString() || "";
  if (result.status !== 0) {
    throw new Error(`${label} failed with ffmpeg rc=${result.status}: ${stderr.slice(-1200)}`);
  }
  return stderr;
}

function normalizeSegment(srcPath: string, outPath: string, opts: { trimStartSec?: number; seconds?: number }): void {
  if (!fs.existsSync(srcPath)) throw new Error(`FFmpeg input not found: ${srcPath}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { w, h } = videoSize();
  const fps = Number(getSetting("VIDEO_FPS") || "30") || 30;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  const args = ["-y"];

  if (opts.trimStartSec && opts.trimStartSec > 0) {
    args.push("-ss", opts.trimStartSec.toFixed(3));
  }

  args.push("-i", srcPath);

  if (opts.seconds && opts.seconds > 0) {
    args.push("-t", opts.seconds.toFixed(3));
  }

  args.push(
    "-vf", vf,
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath
  );

  runFfmpeg(args, `Normalize ${path.basename(srcPath)}`);
}

function concatClips(firstPath: string, secondPath: string, outPath: string): void {
  if (!fs.existsSync(firstPath)) throw new Error(`Concat input not found: ${firstPath}`);
  if (!fs.existsSync(secondPath)) throw new Error(`Concat input not found: ${secondPath}`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  runFfmpeg([
    "-y",
    "-i", firstPath,
    "-i", secondPath,
    "-filter_complex", "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ], "Concat HeyGen intro");
}

function detectNextSilenceCut(srcPath: string, minSeconds: number): { seconds: number; reason: string } {
  const maxExtraSeconds = 8;
  const maxSeconds = Math.min(60, minSeconds + maxExtraSeconds);
  const scanDuration = Math.max(2, maxSeconds + 1);

  try {
    const stderr = runFfmpeg([
      "-hide_banner",
      "-nostats",
      "-i", srcPath,
      "-t", scanDuration.toFixed(3),
      "-af", "silencedetect=n=-35dB:d=0.22",
      "-f", "null",
      "-",
    ], "Detect intro silence");

    const candidates: number[] = [];
    const re = /silence_start:\s*([0-9.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stderr))) {
      const t = Number(match[1]);
      if (Number.isFinite(t) && t >= minSeconds && t <= maxSeconds) {
        candidates.push(t);
      }
    }

    if (candidates.length > 0) {
      const chosen = Math.max(minSeconds, candidates[0]);
      return { seconds: round3(chosen), reason: `next silence after ${minSeconds}s` };
    }
  } catch {
    // If silence detection fails, keep the original requested cut.
  }

  return { seconds: round3(minSeconds), reason: "requested seconds; no silence found nearby" };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export async function applyHeyGenIntroToFinalVideoSafe(finalVideoPath: string, seconds = 10): Promise<HeyGenIntroAssembleResult> {
  if (!fs.existsSync(finalVideoPath)) throw new Error(`Final video not found: ${finalVideoPath}`);

  const requestedSeconds = Math.max(1, Math.min(60, seconds));
  const cut = detectNextSilenceCut(finalVideoPath, requestedSeconds);
  const introSeconds = cut.seconds;

  const runDir = path.dirname(finalVideoPath);
  const workDir = path.join(runDir, "heygen_intro");
  fs.mkdirSync(workDir, { recursive: true });

  const introAudioPath = path.join(workDir, `intro_${introSeconds.toFixed(3)}s.mp3`);
  await extractIntroAudioClip(finalVideoPath, introAudioPath, introSeconds);

  const heygen = await generateHeyGenAvatarFromAudio(introAudioPath, `Conveyer HeyGen Intro ${introSeconds}s`);

  const introNorm = path.join(workDir, "intro_heygen_normalized.mp4");
  const tailNorm = path.join(workDir, "tail_after_intro.mp4");
  const outPath = path.join(runDir, "final_heygen_intro.mp4");

  normalizeSegment(heygen.outputPath, introNorm, { seconds: introSeconds });
  normalizeSegment(finalVideoPath, tailNorm, { trimStartSec: introSeconds });
  concatClips(introNorm, tailNorm, outPath);

  return {
    ok: true,
    outputPath: outPath,
    heygenVideoPath: heygen.outputPath,
    introAudioPath,
    requestedSeconds,
    seconds: introSeconds,
    cutReason: cut.reason,
    videoId: heygen.videoId,
    cached: heygen.cached,
    duration: heygen.duration,
  };
}
