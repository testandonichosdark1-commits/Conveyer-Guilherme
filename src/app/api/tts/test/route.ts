import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { ensureInit } from "@/lib/init";
import { DATA_DIR } from "@/lib/run-paths";
import { synthesizeFullScript, resolveTtsProvider } from "@/lib/services/tts";

export async function POST(req: Request) {
  ensureInit();

  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    const text = (typeof body.text === "string" && body.text.trim())
      ? body.text.trim()
      : "This is a quick voice test for Conveyer.";

    const dir = path.join(DATA_DIR, "tts_tests");
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID().slice(0, 8);
    const outPath = path.join(dir, `tts_test_${id}.mp3`);
    const provider = resolveTtsProvider();
    const result = await synthesizeFullScript(`tts-test-${id}`, text, outPath);

    return NextResponse.json({ ok: true, provider, outputPath: result.filePath, durationSec: result.durationSec });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
