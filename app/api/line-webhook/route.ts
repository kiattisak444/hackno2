import { NextRequest, NextResponse } from "next/server";
import { verifySignature, replyMessage } from "@/lib/line";
import { getFaq, faqToCsv } from "@/lib/sheet";
import { askGemini, DEFAULT_REPLY } from "@/lib/gemini";
import { isTextMessageEvent, type LineWebhookEvent, type LineTextMessage } from "@/lib/types";

export const runtime = "nodejs";

type TextMessageEvent = LineWebhookEvent & { replyToken: string; message: LineTextMessage };

async function handleTextEvent(event: TextMessageEvent) {
  const { replyToken } = event;
  const userText = event.message.text;

  let faqCsv: string;
  try {
    const faqItems = await getFaq();
    faqCsv = faqToCsv(faqItems);
  } catch (err) {
    // No sheet data at all (fetch failed and no stale cache) — skip Gemini entirely.
    console.error("[webhook] getFaq failed with no cache available:", err);
    await replyMessage(replyToken, DEFAULT_REPLY);
    return;
  }

  let replyText = DEFAULT_REPLY;
  try {
    const result = await askGemini(userText, faqCsv);
    replyText = result.text;
  } catch (err) {
    console.error("[webhook] askGemini failed:", err);
    replyText = DEFAULT_REPLY;
  }

  await replyMessage(replyToken, replyText);
}

export async function POST(req: NextRequest) {
  try {
    // Must read as raw text (not parsed JSON) to verify the HMAC signature correctly.
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");

    if (!verifySignature(rawBody, signature)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    let events: LineWebhookEvent[] = [];
    try {
      const parsed = JSON.parse(rawBody);
      events = Array.isArray(parsed.events) ? parsed.events : [];
    } catch (err) {
      console.error("[webhook] failed to parse body:", err);
      return NextResponse.json({ ok: true });
    }

    await Promise.all(
      events.map(async (event) => {
        try {
          if (!isTextMessageEvent(event)) return;
          await handleTextEvent(event);
        } catch (err) {
          console.error("[webhook] error handling event:", err);
        }
      })
    );

    // Always 200 (success or failure) so LINE doesn't retry the same webhook.
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[webhook] unhandled error:", err);
    return NextResponse.json({ ok: true });
  }
}
