# hackno2 — LINE Bot ร้านพิซซ่า (Gemini)

Next.js 14 (App Router) + TypeScript. รับ LINE webhook, ตอบคำถามลูกค้าด้วย Gemini
โดยอิงข้อมูลจาก FAQ ใน Google Sheet เท่านั้น. Deploy บน Vercel.

## โครงสร้าง

```
app/api/line-webhook/route.ts   # webhook endpoint (POST) — จุดเข้าเดียว
lib/sheet.ts                    # ดึง+parse FAQ CSV, cache 60s in memory, stale-if-error
lib/gemini.ts                   # system prompt + เรียก Gemini + จัดการ finishReason
lib/line.ts                     # verify signature, reply message helper
lib/types.ts                    # FaqItem, GeminiResult, LINE webhook types
```

## ติดตั้ง (local)

```bash
npm install
cp .env.example .env.local   # แล้วกรอกค่าจริง
npm run dev
```

### Env vars

| ตัวแปร | คำอธิบาย |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | จาก LINE Developers Console |
| `LINE_CHANNEL_SECRET` | จาก LINE Developers Console (ใช้ verify signature) |
| `GEMINI_API_KEY` | Google AI Studio / Gemini API key |
| `SHEET_CSV_URL` | Google Sheet publish-to-web CSV URL (ดูด้านล่าง) |

### Google Sheet (FAQ)

คอลัมน์: `category`, `question`, `answer` (แถวแรกเป็น header). File → Share →
**Publish to web** → เลือกชีต → format **CSV** → ใช้ลิงก์นั้นเป็น `SHEET_CSV_URL`.

⚠️ **ก่อน deploy จริง**: เช็คเบอร์โทร/LINE ID ใน default reply ที่
[lib/gemini.ts](lib/gemini.ts) (`DEFAULT_REPLY`) ว่าเป็นข้อมูลจริงของร้าน.

## Deploy checklist

1. `git add . && git commit -m "..." && git push`
2. ตั้ง env vars ทั้ง 4 ตัวใน Vercel project settings
3. รอ Vercel auto-deploy → เช็ค deployment สำเร็จใน dashboard
4. LINE Developers Console → Webhook settings → ใส่
   `https://<domain>/api/line-webhook` → กด **Verify**
5. ทดสอบส่งข้อความจริงจาก LINE + เช็ค Vercel logs ว่ามี `finishReason` /
   token counts ครบทุก request
