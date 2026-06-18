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
  seconds: number;
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

function runFfmpeg(args: string[], label: string): void {
  const bin = resolveFfmpegBinary();
  const result = spawnSync(bin, args, { stdio: "pipe" });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().slice(-1200) || "";
    throw new Error(`${label} failed with ffmpeg rc=${result.status}: ${stderr}`);
  }
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

export async function applyHeyGenIntroToFinalVideoSafe(finalVideoPath: string, seconds = 10): Promise<HeyGenIntroAssembleResult> {
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

  normalizeSegment(heygen.outputPath, introNorm, { seconds: introSeconds });
  normalizeSegment(finalVideoPath, tailNorm, { trimStartSec: introSeconds });
  concatClips(introNorm, tailNorm, outPath);

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
