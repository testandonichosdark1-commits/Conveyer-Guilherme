import fs from "node:fs";
import { getSetting } from "../settings";
import { log, type LogLevel } from "../logger";

/**
 * ai33.pro API client — TTS via ElevenLabs voices (cheaper proxy).
 *
 * Docs: https://ai33.pro/app/api-document (ElevenLabs + Common tabs)
 *
 * V1 flow is async:
 *   1. POST /v1/text-to-speech/{voice_id} → { success, task_id, ec_remain_credits }
 *   2. Poll  GET /v1/task/{task_id} until status === "done"
 *   3. Download the audio from metadata.audio_url
 *
 * V1 auth: xi-api-key.
 */

const BASE = "https://api.ai33.pro/v1";
const POLL_INTERVAL_MS = 2500;
const DEFAULT_POLL_MAX_MINUTES = 45;
const DEFAULT_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

type TaskStatus = "doing" | "done" | "error" | string;

function getKey(): string {
  const k = getSetting("AI33PRO_API_KEY").trim();
  if (!k) throw new Error("AI33PRO_API_KEY is not set (Settings)");
  return k;
}

function getPollMaxMs(): number {
  const raw = Number(getSetting("AI33PRO_POLL_MAX_MINUTES") || "");
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MAX_MINUTES;
  // Guardrail: allow long MiniMax jobs but avoid accidental 9999-minute hangs.
  return Math.max(1, Math.min(240, minutes)) * 60 * 1000;
}

function authHeaders(): Record<string, string> {
  return {
    "xi-api-key": getKey(),
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── V1 ElevenLabs-compatible TTS ─────────────────────────────────────────────

interface CreateTtsTaskResponse {
  success?: boolean;
  task_id?: string;
  ec_remain_credits?: number;
  error?: string;
  message?: string;
}

export interface CreateTtsOptions {
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  receiveUrl?: string;
}

export async function createTtsTask(text: string, opts: CreateTtsOptions): Promise<string> {
  if (!opts.voiceId) throw new Error("ai33pro createTtsTask: voiceId is required");

  const outputFormat = opts.outputFormat || "mp3_44100_128";
  const url = `${BASE}/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const body: Record<string, unknown> = {
    text,
    model_id: opts.modelId || "eleven_multilingual_v2",
    with_transcript: false,
  };
  if (opts.receiveUrl) body.receive_url = opts.receiveUrl;
  const bodyJson = JSON.stringify(body);

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: authHeaders(),
        body: bodyJson,
      });
      if (!resp.ok) {
        const txt = (await resp.text()).slice(0, 400);
        if (resp.status < 500) throw new Error(`ai33pro POST /text-to-speech HTTP ${resp.status}: ${txt}`);
        lastErr = new Error(`ai33pro POST /text-to-speech HTTP ${resp.status}: ${txt}`);
      } else {
        const json = (await resp.json()) as CreateTtsTaskResponse;
        if (json.success === false || !json.task_id) {
          const msg = json.error || json.message || JSON.stringify(json).slice(0, 200);
          throw new Error(`ai33pro task create failed: ${msg}`);
        }
        return json.task_id;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2000);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface TaskInfo {
  id: string;
  created_at: string;
  status: TaskStatus;
  error_message?: string | null;
  credit_cost?: number;
  progress?: number;
  type?: string;
  metadata?: {
    audio_url?: string;
    srt_url?: string;
    json_url?: string;
    output_uri?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function getTask(taskId: string): Promise<TaskInfo> {
  const url = `${BASE}/task/${encodeURIComponent(taskId)}`;
  const resp = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`ai33pro GET task HTTP ${resp.status}: ${txt}`);
  }
  return (await resp.json()) as TaskInfo;
}

function resolveAudioUrl(task: TaskInfo): string | null {
  return task.metadata?.audio_url || task.metadata?.output_uri || null;
}

export async function pollTask(taskId: string, runId: string, stage: string = "tts"): Promise<TaskInfo> {
  const startedAt = Date.now();
  const pollMaxMs = getPollMaxMs();
  let lastStatus: TaskStatus | null = null;

  while (true) {
    if (Date.now() - startedAt > pollMaxMs) {
      throw new Error(`ai33pro polling timeout (${Math.round(pollMaxMs / 60000)} min) — task ${taskId}`);
    }

    let task: TaskInfo;
    try {
      task = await getTask(taskId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Poll error (will retry): ${msg.slice(0, 200)}`, { stage: stage as LogLevel });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (task.status !== lastStatus) {
      lastStatus = task.status;
      log(runId, "debug", `Task ${taskId.slice(0, 8)}… status=${task.status}`, { stage: stage as LogLevel });
    }

    if (task.status === "done") return task;
    if (task.status === "error") {
      throw new Error(`ai33pro task ${taskId} error: ${task.error_message || "no error message"}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export async function downloadTask(task: TaskInfo, outPath: string): Promise<void> {
  const audioUrl = resolveAudioUrl(task);
  if (!audioUrl) {
    throw new Error(
      `ai33pro task done but metadata.audio_url is missing. ` +
        `metadata keys: ${task.metadata ? Object.keys(task.metadata).join(", ") : "(no metadata object)"}`
    );
  }

  const resp = await fetchWithTimeout(audioUrl, undefined, DOWNLOAD_TIMEOUT_MS);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 200);
    throw new Error(`ai33pro audio download HTTP ${resp.status}: ${txt}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("ai33pro download: empty file");
  fs.writeFileSync(outPath, buf);
}

// ════════════════════════════════════════════════════════════════════════════
// V3 unified API (ElevenLabs / Minimax / Edge / Kokoro).
//
// ai33.pro V3 deployments have used different auth header names over time.
// To avoid false 401s, we try the known variants and remember the one that works.
// ════════════════════════════════════════════════════════════════════════════

const V3_BASE = "https://api.ai33.pro/v3";

interface V3AuthVariant {
  name: string;
  headers: Record<string, string>;
}

let workingV3AuthName: string | null = null;

function v3AuthHeaderVariants(): V3AuthVariant[] {
  const key = getKey();
  return [
    { name: "Authorization", headers: { Authorization: key } },
    { name: "Authorization Bearer", headers: { Authorization: `Bearer ${key}` } },
    { name: "xi-api-key", headers: { "xi-api-key": key } },
    { name: "x-api-key", headers: { "x-api-key": key } },
  ];
}

async function fetchV3WithAuth(
  url: string,
  initFactory: (headers: Record<string, string>) => RequestInit,
  context: string
): Promise<Response> {
  const variants = v3AuthHeaderVariants();
  const ordered = workingV3AuthName
    ? [
        ...variants.filter((v) => v.name === workingV3AuthName),
        ...variants.filter((v) => v.name !== workingV3AuthName),
      ]
    : variants;

  let lastAuthError = "";
  for (const variant of ordered) {
    const resp = await fetchWithTimeout(url, initFactory(variant.headers));
    if (resp.status === 401 || resp.status === 403) {
      const txt = (await resp.text()).slice(0, 400);
      lastAuthError = `${context} via ${variant.name} HTTP ${resp.status}: ${txt}`;
      continue;
    }
    if (resp.ok) workingV3AuthName = variant.name;
    return resp;
  }

  throw new Error(`${context} unauthorized with all supported auth headers. Last error: ${lastAuthError}`);
}

export interface CreateV3SpeechOptions {
  voiceId: string;
  speed?: number;
  withTranscript?: boolean;
  contextChaining?: boolean;
  language?: string;
  similarity?: number;
  fileName?: string;
  receiveUrl?: string;
}

export async function createV3SpeechTask(text: string, opts: CreateV3SpeechOptions): Promise<string> {
  if (!opts.voiceId) throw new Error("ai33pro V3 createV3SpeechTask: voiceId is required");

  const url = `${V3_BASE}/text-to-speech`;
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchV3WithAuth(
        url,
        (headers) => {
          const form = new FormData();
          form.append("text", text);
          form.append("voice_id", opts.voiceId);
          if (opts.speed != null && Number.isFinite(opts.speed)) form.append("speed", String(opts.speed));
          form.append("with_transcript", String(opts.withTranscript ?? false));
          form.append("context_chaining", String(opts.contextChaining ?? false));
          if (opts.language) form.append("language", opts.language);
          if (opts.similarity != null && Number.isFinite(opts.similarity)) form.append("similarity", String(opts.similarity));
          if (opts.fileName) form.append("file_name", opts.fileName);
          if (opts.receiveUrl) form.append("receive_url", opts.receiveUrl);
          return { method: "POST", headers, body: form };
        },
        "ai33pro V3 POST /text-to-speech"
      );

      if (!resp.ok) {
        const txt = (await resp.text()).slice(0, 400);
        if (resp.status < 500) throw new Error(`ai33pro V3 POST /text-to-speech HTTP ${resp.status}: ${txt}`);
        lastErr = new Error(`ai33pro V3 POST /text-to-speech HTTP ${resp.status}: ${txt}`);
      } else {
        const json = (await resp.json()) as {
          success?: boolean;
          task_id?: string;
          error?: string;
          message?: string;
        };
        if (json.success === false || !json.task_id) {
          const msg = json.error || json.message || JSON.stringify(json).slice(0, 200);
          throw new Error(`ai33pro V3 task create failed: ${msg}`);
        }
        return json.task_id;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2000);
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface V3TaskInfo {
  id: string;
  type?: string;
  status: TaskStatus;
  progress?: number;
  credit_cost?: number;
  error_message?: string | null;
  metadata?: { audio_url?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export async function getV3Task(taskId: string): Promise<V3TaskInfo> {
  const url = `${V3_BASE}/task/${encodeURIComponent(taskId)}`;
  const resp = await fetchV3WithAuth(
    url,
    (headers) => ({ headers }),
    "ai33pro V3 GET task"
  );
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`ai33pro V3 GET task HTTP ${resp.status}: ${txt}`);
  }
  const json = (await resp.json()) as { success?: boolean; data?: V3TaskInfo; error?: string };
  if (!json.data) {
    throw new Error(`ai33pro V3 GET task: missing data (${JSON.stringify(json).slice(0, 200)})`);
  }
  return json.data;
}

export async function pollV3Task(taskId: string, runId: string, stage: string = "tts"): Promise<V3TaskInfo> {
  const startedAt = Date.now();
  const pollMaxMs = getPollMaxMs();
  let lastStatus: TaskStatus | null = null;

  while (true) {
    if (Date.now() - startedAt > pollMaxMs) {
      throw new Error(`ai33pro V3 polling timeout (${Math.round(pollMaxMs / 60000)} min) — task ${taskId}`);
    }
    let task: V3TaskInfo;
    try {
      task = await getV3Task(taskId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `V3 poll error (will retry): ${msg.slice(0, 200)}`, { stage: stage as LogLevel });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      log(runId, "debug", `V3 task ${taskId.slice(0, 8)}… status=${task.status}`, { stage: stage as LogLevel });
    }
    if (task.status === "done") return task;
    if (task.status === "error" || task.status === "failed") {
      throw new Error(`ai33pro V3 task ${taskId} error: ${task.error_message || "no error message"}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function downloadV3Task(task: V3TaskInfo, outPath: string): Promise<void> {
  const audioUrl = task.metadata?.audio_url;
  if (!audioUrl) {
    throw new Error(
      `ai33pro V3 task done but metadata.audio_url is missing. ` +
        `metadata keys: ${task.metadata ? Object.keys(task.metadata).join(", ") : "(no metadata object)"}`
    );
  }
  const resp = await fetchWithTimeout(audioUrl, undefined, DOWNLOAD_TIMEOUT_MS);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 200);
    throw new Error(`ai33pro V3 audio download HTTP ${resp.status}: ${txt}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("ai33pro V3 download: empty file");
  fs.writeFileSync(outPath, buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// V1 Minimax proxy API (using xi-api-key)
// ════════════════════════════════════════════════════════════════════════════

const V1M_BASE = "https://api.ai33.pro/v1m";

export interface CreateMinimaxAi33proOptions {
  voiceId: string;
  model?: string;
  speed?: number;
}

export async function createMinimaxAi33proTask(text: string, opts: CreateMinimaxAi33proOptions): Promise<string> {
  if (!opts.voiceId) throw new Error("ai33pro createMinimaxAi33proTask: voiceId is required");

  const url = `${V1M_BASE}/task/text-to-speech`;
  const body = JSON.stringify({
    text,
    model: opts.model || "speech-02-hd",
    voice_setting: {
      voice_id: opts.voiceId,
      vol: 1,
      pitch: 0,
      speed: opts.speed ?? 1,
    },
    language_boost: "Auto",
    with_transcript: false,
  });

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: "POST",
        headers: authHeaders(),
        body,
      });
      if (!resp.ok) {
        const txt = (await resp.text()).slice(0, 400);
        if (resp.status < 500) throw new Error(`ai33pro POST /v1m/task/text-to-speech HTTP ${resp.status}: ${txt}`);
        lastErr = new Error(`ai33pro POST /v1m/task/text-to-speech HTTP ${resp.status}: ${txt}`);
      } else {
        const json = (await resp.json()) as {
          success?: boolean;
          task_id?: string;
          error?: string;
          message?: string;
        };
        if (json.success === false || !json.task_id) {
          const msg = json.error || json.message || JSON.stringify(json).slice(0, 200);
          throw new Error(`ai33pro Minimax task create failed: ${msg}`);
        }
        return json.task_id;
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2000);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
