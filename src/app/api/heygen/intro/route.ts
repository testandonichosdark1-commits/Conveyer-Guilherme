import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { applyHeyGenIntroToFinalVideoSafe } from "@/lib/services/heygen-intro";

export async function POST(req: Request) {
  ensureInit();

  try {
    const body = (await req.json().catch(() => ({}))) as { finalPath?: string; seconds?: number };
    const finalPath = typeof body.finalPath === "string" ? body.finalPath.trim() : "";
    const seconds = Number.isFinite(Number(body.seconds)) ? Number(body.seconds) : 10;

    if (!finalPath) {
      return NextResponse.json({ ok: false, error: "finalPath is required." }, { status: 400 });
    }

    const result = await applyHeyGenIntroToFinalVideoSafe(finalPath, seconds);
    return NextResponse.json({ ...result, originalPath: finalPath });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
