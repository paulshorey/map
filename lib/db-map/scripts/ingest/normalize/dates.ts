/**
 * Event-date parsing for the normalize stage (data-quality contract, Dates rules).
 *
 * Deterministic parsing first (reject-don't-guess: garbage → null). When that
 * fails and the string looks like prose ("every February", "February 11–13"),
 * an LLM fallback converts it — with the year re-derived by structured logic
 * (never trusted from the model): a month already passed this year → next year.
 */
import { chat, LlmError } from "../providers/deepinfra.js";

export type DatePrecision = "day" | "month" | "year";

export interface ParsedDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  precision: DatePrecision;
}

export interface EventDates {
  starts_at: string | null; // ISO date (YYYY-MM-DD)
  ends_at: string | null;
  date_precision: DatePrecision | null;
  swapped: boolean;
  /** 'parsed' = deterministic; 'llm' = prose conversion; null = no dates. */
  date_source: "parsed" | "llm" | null;
}

const NO_DATES: EventDates = {
  starts_at: null,
  ends_at: null,
  date_precision: null,
  swapped: false,
  date_source: null,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

const PLACEHOLDER_RE = /^(cancelled|canceled|tbd|tba|unknown|n\/a|none|-*)$/i;

function yearPlausible(y: number): boolean {
  const now = new Date().getUTCFullYear();
  return y >= 1900 && y <= now + 5;
}

function clampDay(y: number, m: number, d: number): number {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(Math.max(d, 1), last);
}

function iso(p: ParsedDate): string {
  return `${p.y.toString().padStart(4, "0")}-${p.m.toString().padStart(2, "0")}-${clampDay(p.y, p.m, p.d).toString().padStart(2, "0")}`;
}

function cmp(a: ParsedDate, b: ParsedDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/**
 * Deterministic single-date parser. Returns null for anything it cannot parse
 * with full confidence (prose goes to the LLM path instead).
 */
export function parseOneDate(raw: string | null | undefined): ParsedDate | null {
  if (!raw) return null;
  const s = String(raw).trim();
  // Field-leak guard: sentence text in a date field (eFestivals) → reject.
  if (s.length === 0 || s.length > 40 || PLACEHOLDER_RE.test(s)) return null;

  let m: RegExpExecArray | null;

  // ISO: 2026-06-19 (optionally with time suffix)
  if ((m = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!yearPlausible(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y === 1970 && mo === 1 && d === 1) return null; // epoch placeholder
    return { y, m: mo, d, precision: "day" };
  }

  // Compact: 20260820 (MusicFestivalWizard)
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!yearPlausible(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d, precision: "day" };
  }

  // "January 1, 2026" / "Nov 6, 2026"
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    const [d, y] = [Number(m[2]), Number(m[3])];
    if (!mo || !yearPlausible(y) || d < 1 || d > 31) return null;
    return { y, m: mo, d, precision: "day" };
  }

  // "22 Aug 2026" / "6 November 2026"
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    const [d, y] = [Number(m[1]), Number(m[3])];
    if (!mo || !yearPlausible(y) || d < 1 || d > 31) return null;
    return { y, m: mo, d, precision: "day" };
  }

  // "July 2026" (month precision)
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s))) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    const y = Number(m[2]);
    if (!mo || !yearPlausible(y)) return null;
    return { y, m: mo, d: 1, precision: "month" };
  }

  // "1982" (year precision)
  if ((m = /^(\d{4})$/.exec(s))) {
    const y = Number(m[1]);
    if (!yearPlausible(y)) return null;
    return { y, m: 1, d: 1, precision: "year" };
  }

  return null;
}

/** Does the string carry enough signal to be worth an LLM prose-date call? */
export function looksLikeProseDate(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = String(raw).trim();
  if (s.length < 3 || s.length > 120 || PLACEHOLDER_RE.test(s)) return false;
  const lower = s.toLowerCase();
  if (Object.keys(MONTHS).some((mo) => lower.includes(mo))) return true;
  return /\b(easter|lent|solstice|weekend|annual|every|spring|summer|autumn|fall|winter|season)\b/.test(
    lower,
  );
}

/**
 * Re-derive the year for LLM-returned dates (product decision): the model's
 * year is ignored. If the start month has already passed this year → next
 * year, otherwise → the current year. The end date follows the start, rolling
 * into the following year when the range crosses a year boundary.
 */
export function rederiveYears(
  start: { m: number; d: number },
  end: { m: number; d: number } | null,
  now = new Date(),
): { start: ParsedDate; end: ParsedDate | null } {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const startYear = start.m < currentMonth ? currentYear + 1 : currentYear;
  const s: ParsedDate = { y: startYear, m: start.m, d: start.d, precision: "day" };
  if (!end) return { start: s, end: null };
  const endYear = end.m < start.m ? startYear + 1 : startYear;
  return { start: s, end: { y: endYear, m: end.m, d: end.d, precision: "day" } };
}

const DATE_IN_TEXT_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/g;

/** Parse the LLM response: regex out all ISO-shaped dates, keep the first two. */
export function datesFromLlmResponse(text: string): { m: number; d: number }[] {
  const found: { m: number; d: number }[] = [];
  for (const m of text.matchAll(DATE_IN_TEXT_RE)) {
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) found.push({ m: mo, d });
    if (found.length === 2) break;
  }
  return found;
}

const llmMemo = new Map<string, { m: number; d: number }[]>();

async function proseDatesViaLlm(prose: string): Promise<{ m: number; d: number }[]> {
  const key = prose.toLowerCase().replace(/\s+/g, " ").trim();
  const cached = llmMemo.get(key);
  if (cached) return cached;

  const currentYear = new Date().getUTCFullYear();
  let dates: { m: number; d: number }[] = [];
  try {
    const response = await chat({
      system:
        "You convert prose descriptions of event dates into concrete calendar dates. " +
        "Reply with ONLY the start and end date in YYYY-MM-DD format, separated by ' -> '. " +
        "If only one date can be determined, reply with just that date. " +
        "If no date can be determined, reply with 'none'.",
      user: `The current year is ${currentYear}. Convert this event date description to start and end dates: "${prose}"`,
      maxTokens: 64,
    });
    dates = datesFromLlmResponse(response);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    dates = []; // conservative: dates stay NULL (undated is allowed)
  }
  llmMemo.set(key, dates);
  return dates;
}

export interface ParseEventDatesInput {
  start?: string | null;
  end?: string | null;
  /** Prose fallback, e.g. a combined "dates" string ("February 11–13", "every February"). */
  text?: string | null;
  /** Set false to skip the LLM fallback (e.g. --no-llm runs / tests). */
  allowLlm?: boolean;
}

/**
 * Full event-date resolution: deterministic parse of start/end, swap repair,
 * LLM prose fallback with structured year re-derivation.
 */
export async function parseEventDates(input: ParseEventDatesInput): Promise<EventDates> {
  let start = parseOneDate(input.start);
  let end = parseOneDate(input.end);
  let source: "parsed" | "llm" | null = start || end ? "parsed" : null;

  if (!start && !end) {
    // Prose fallback: prefer the combined text, else the raw start string.
    const prose = [input.text, input.start, input.end].find((t) => looksLikeProseDate(t));
    if (prose && input.allowLlm !== false) {
      const found = await proseDatesViaLlm(String(prose));
      if (found.length > 0) {
        const re = rederiveYears(found[0]!, found[1] ?? null);
        start = re.start;
        end = re.end;
        source = "llm";
      }
    }
  }

  if (!start && !end) return NO_DATES;

  // A lone end date becomes the start (single known date).
  if (!start && end) {
    start = end;
    end = null;
  }

  // Swap repair (product decision): store min as start, max as end.
  let swapped = false;
  if (start && end && cmp(start, end) > 0) {
    [start, end] = [end, start];
    swapped = true;
  }

  return {
    starts_at: start ? iso(start) : null,
    ends_at: end ? iso(end) : null,
    date_precision: start?.precision ?? null,
    swapped,
    date_source: source,
  };
}
