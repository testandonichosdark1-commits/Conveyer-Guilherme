import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { generateHeyGenTestVideo } from "@/lib/services/heygen";

export async function POST(req: Request) {
  ensureInit();

  try {
    const body = await req.json().catch(() => ({} as { script?: string }));
    const script = typeof body?.script === "string" ? body.script : undefined;
    const result = await generateHeyGenTestVideo(script);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
