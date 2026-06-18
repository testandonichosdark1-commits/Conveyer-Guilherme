import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import db from "./db";

/**
 * DATA_DIR is where the SQLite database lives (settings, run records, logs).
 * We keep it in the user's home so Turbopack file-watcher (in the project
 * folder) doesn't see lock-prone files.
 */
export const DATA_DIR =
  process.env.CONVEYER_GUILHERME_DATA_DIR ?? path.join(os.homedir(), ".conveyer-guilherme");

/**
 * Root for run output folders (audio, images, animations, clips, final.mp4).
 * User can override via /settings → RUNS_OUTPUT_DIR.
 * Default: <DATA_DIR>/runs/
 */
const getRunsOutputSetting = db.prepare(
  "SELECT value FROM settings WHERE key = 'RUNS_OUTPUT_DIR'"
);

export function getRunsRoot(): string {
  const row = getRunsOutputSetting.get() as { value: string } | undefined;
  const custom = row?.value?.trim();
  return custom && custom.length > 0 ? custom : path.join(/*turbopackIgnore: true*/ DATA_DIR, "runs");
}

const getFolderStmt = db.prepare("SELECT folder_name FROM runs WHERE id = ?");

/** Absolute path to a specific run's folder. */
export function getRunDir(runId: string): string {
  const row = getFolderStmt.get(runId) as { folder_name: string | null } | undefined;
  return path.join(/*turbopackIgnore: true*/ getRunsRoot(), row?.folder_name || runId);
}

/**
 * Turn a run title into a safe folder name:
 *  - strip Windows-forbidden characters `<>:"/\|?*` and control chars
 *  - clamp to 80 characters
 *  - if empty after sanitization, fall back to the short UUID
 */
export function sanitizeFolderName(title: string | null | undefined, fallback: string): string {
  let name = (title ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name || fallback;
}

/**
 * Pick a folder name that doesn't collide with anything on disk yet
 * (appends `(2)`, `(3)`, ... if base already taken).
 */
export function pickAvailableFolderName(base: string): string {
  const root = getRunsRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  let name = base;
  let n = 2;
  while (fs.existsSync(path.join(root, name))) {
    name = `${base} (${n})`;
    n++;
  }
  return name;
}

/**
 * Validate + create the RUNS_OUTPUT_DIR, then refresh the `data/runs` junction
 * inside the project so file browsers always see the right contents.
 * Called from /api/settings when RUNS_OUTPUT_DIR changes.
 */
export function applyRunsRoot(newPath: string | undefined): { ok: boolean; error?: string; resolved?: string } {
  const target = newPath?.trim() ? newPath.trim() : path.join(DATA_DIR, "runs");

  // Reject paths inside the project source tree — Turbopack would scan them
  if (/[\\/](src|node_modules|\.next)[\\/]?/.test(target)) {
    return { ok: false, error: "Path cannot be inside src/, node_modules/, or .next/" };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Failed to create folder: ${(e as Error).message}` };
  }

  // Refresh the `data/runs` junction in the project so navigating from the
  // project folder always lands in the current runs directory. Best-effort.
  try {
    const folderName = "da" + "ta";
    const runsName = "ru" + "ns";
    const projectData = path.join(/*turbopackIgnore: true*/ process.cwd(), folderName);
    const projectRunsLink = path.join(/*turbopackIgnore: true*/ projectData, runsName);
    if (!fs.existsSync(projectData)) fs.mkdirSync(projectData, { recursive: true });
    if (fs.existsSync(projectRunsLink)) {
      const stat = fs.lstatSync(projectRunsLink);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        fs.rmSync(projectRunsLink, { recursive: true, force: true });
      }
    }
    if (process.platform === "win32") {
      fs.symlinkSync(target, projectRunsLink, "junction");
    } else {
      fs.symlinkSync(target, projectRunsLink, "dir");
    }
  } catch {
    // Non-critical: the platform still works even if the junction fails.
  }

  return { ok: true, resolved: target };
}
