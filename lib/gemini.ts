import { GoogleGenAI } from "@google/genai";
import type { GeminiResult } from "./types";

const MODEL = "gemini-3.5-flash";
const TEMPERATURE = 1.0; // do not lower — required by brief
const MAX_OUTPUT_TOKENS = 1024; // counts thinking + output combined
const TIMEOUT_MS = 7_000;

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gemini request timed out after ${ms}ms`)), ms);
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

export async function askGemini(question: string, faqCsv: string): Promise<GeminiResult> {
  const prompt = buildPrompt(question, faqCsv);
  const ai = getClient();

  const response = await withTimeout(
    ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
    TIMEOUT_MS
  );

  const finishReason = response.candidates?.[0]?.finishReason ?? "UNKNOWN";
  const thoughtsTokenCount = response.usageMetadata?.thoughtsTokenCount ?? 0;
  const candidatesTokenCount = response.usageMetadata?.candidatesTokenCount ?? 0;

  console.log("[gemini]", { finishReason, thoughtsTokenCount, candidatesTokenCount });

  // Truncated output (thinking + output hit the cap) — never send a half-cut reply.
  let text = finishReason === "MAX_TOKENS" ? DEFAULT_REPLY : response.text ?? DEFAULT_REPLY;

  return { text, finishReason, thoughtsTokenCount, candidatesTokenCount };
}
