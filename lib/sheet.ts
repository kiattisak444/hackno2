import type { FaqItem } from "./types";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

interface CacheEntry {
  data: FaqItem[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

// Handles quoted fields (commas/newlines inside quotes, "" escapes) the way
// Google Sheets' "Publish to web -> CSV" export produces them.
function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const text = csvText.replace(/\r\n/g, "\n");

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function toFaqItems(csvText: string): FaqItem[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const items: FaqItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = (rows[i][idx] ?? "").trim();
    });
    items.push({
      category: record.category ?? "",
      question: record.question ?? "",
      answer: record.answer ?? "",
    });
  }
  return items;
}

async function fetchCsv(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Cache (module-level, 60s) with stale-if-error: a failed refetch falls
// back to the last good data instead of breaking the bot.
export async function getFaq(): Promise<FaqItem[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    if (cache) return cache.data;
    throw new Error("SHEET_CSV_URL is not set");
  }

  try {
    const csvText = await fetchCsv(url);
    const items = toFaqItems(csvText);
    cache = { data: items, fetchedAt: now };
    return items;
  } catch (err) {
    if (cache) {
      console.error("[sheet] fetch failed, serving stale cache:", err);
      return cache.data;
    }
    throw err;
  }
}

export function faqToCsv(items: FaqItem[]): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = items.map((i) => [i.category, i.question, i.answer].map(escape).join(","));
  return ["category,question,answer", ...lines].join("\n");
}
