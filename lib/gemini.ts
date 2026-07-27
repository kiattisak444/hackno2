import { GoogleGenAI } from "@google/genai";
import type { GeminiResult } from "./types";

const MODEL = "gemini-3.5-flash";
const TEMPERATURE = 1.0; // do not lower — required by brief
const MAX_OUTPUT_TOKENS = 1024; // counts thinking + output combined

// Retries share one deadline instead of stacking: the webhook still has to run
// replyMessage() afterwards inside the same invocation, so TOTAL_BUDGET_MS caps
// askGemini end-to-end no matter how many attempts it burns through.
const TOTAL_BUDGET_MS = 7_000;
const ATTEMPT_TIMEOUT_MS = 4_000; // further capped by whatever budget is left
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MIN_RETRY_BUDGET_MS = 800; // below this a retry can't realistically land

// Single source of truth: used both as the in-prompt instruction and as the
// JS fallback when finishReason === "MAX_TOKENS". Update the phone/LINE ID
// here before deploying to production.
export const DEFAULT_REPLY =
  "ขออภัยผู้ใช้บัญชีนี้กำลังนอนหลับอยู่ รบกวนติดต่อกลับอีกที 365 วันหลังจากวันนี้ห่ะ 🫪";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function buildPrompt(question: string, faqCsv: string): string {
  // FAQ block placed before the question (long-context-first per Gemini guidance).
  return `<role>
คุณคือพนักงานร้านพิซซ่าบี กำลังตอบแชทลูกค้าทาง LINE
</role>

<constraints>
- ตอบโดยใช้ข้อมูลใน <faq> เท่านั้น ห้ามแต่งราคา เวลา ที่ตั้ง หรือโปรโมชั่นที่ไม่มีใน <faq>
- ถ้าคำถามไม่มีคำตอบใน <faq> ให้ตอบด้วยข้อความนี้เท่านั้น: "${DEFAULT_REPLY}"
- โทนสุภาพ มีระยะห่างพอเหมาะแบบพนักงานร้าน ไม่สนิทเกินไป
- ใส่ emoji ได้เล็กน้อย (1 ตัวพอ) ไม่ใส่พร่ำเพรื่อ
- ความยาวคำตอบ 1-3 ประโยค กระชับ ตรงประเด็น
</constraints>

<output_format>
ตอบเป็นภาษาไทย ห้ามใช้ markdown (ห้าม **, #, bullet, numbered list)
</output_format>

<faq>
${faqCsv}
</faq>

<question>
${question}
</question>`;
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`Gemini request timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// The SDK's thrown-error shape has moved around between versions, so probe the
// usual spots and fall back to scraping the message rather than trusting one.
function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as Record<string, unknown>;
  const nested = e.error as Record<string, unknown> | undefined;
  const response = e.response as Record<string, unknown> | undefined;

  for (const candidate of [e.status, e.code, nested?.code, nested?.status, response?.status]) {
    if (typeof candidate === "number") return candidate;
  }
  const message = typeof e.message === "string" ? e.message : "";
  if (/RESOURCE_EXHAUSTED/.test(message)) return 429;
  if (/UNAVAILABLE/.test(message)) return 503;
  const match = message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : null;
}

// 429/5xx and timeouts are worth another shot; 400/401/403 are our own bug or a
// bad key and will fail identically every time.
function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const status = statusOf(err);
  if (status === null) return true; // network-level failure, no status attached
  return RETRYABLE_STATUS.has(status);
}

function backoffFor(attempt: number): number {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return ceiling / 2 + Math.random() * (ceiling / 2); // equal jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askGemini(question: string, faqCsv: string): Promise<GeminiResult> {
  const prompt = buildPrompt(question, faqCsv);
  const ai = getClient();

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError: unknown;
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: {
            temperature: TEMPERATURE,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        }),
        Math.min(ATTEMPT_TIMEOUT_MS, remaining)
      );
      break;
    } catch (err) {
      lastError = err;
      const status = statusOf(err);
      console.warn("[gemini] attempt failed", { attempt, status, message: String(err) });

      if (attempt === MAX_ATTEMPTS || !isRetryable(err)) throw err;

      const backoff = backoffFor(attempt);
      // Leave room for the retry itself, not just the wait before it.
      if (deadline - Date.now() - backoff < MIN_RETRY_BUDGET_MS) throw err;
      await sleep(backoff);
    }
  }

  if (!response) throw lastError ?? new Error("Gemini budget exhausted before any attempt ran");

  const finishReason = response.candidates?.[0]?.finishReason ?? "UNKNOWN";
  const thoughtsTokenCount = response.usageMetadata?.thoughtsTokenCount ?? 0;
  const candidatesTokenCount = response.usageMetadata?.candidatesTokenCount ?? 0;

  console.log("[gemini]", { finishReason, thoughtsTokenCount, candidatesTokenCount });

  // Truncated output (thinking + output hit the cap) — never send a half-cut reply.
  let text = finishReason === "MAX_TOKENS" ? DEFAULT_REPLY : response.text ?? DEFAULT_REPLY;

  return { text, finishReason, thoughtsTokenCount, candidatesTokenCount };
}
