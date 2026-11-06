/**
 * Daily provider quota (LocationIQ). Requests are reserved in `research_provider_daily_usage`
 * before they are sent; once the local limit or the provider's "Rate Limited Day" answer is
 * reached, lookups stop with `ProviderQuotaExhausted` and the geocode stage reports
 * `waiting_budget`, which pauses the run gracefully. Resume it after `resetsAt`.
 *
 * The ledger is opt-in (`useProviderQuotaLedger`) so unit tests with fake databases never
 * touch it; the CLI entrypoints enable it. The in-process "Rate Limited Day" flag always works.
 */
import type { Pool } from "pg";

export const LOCATIONIQ = "locationiq";

/** LocationIQ resets daily limits at 00:00 UTC. */
export function nextUtcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Local daily limit: `LOCATIONIQ_DAILY_LIMIT` (default 5000, the free plan). 0 disables it. */
export function dailyLimit(provider: string): number | null {
  if (provider !== LOCATIONIQ) return null;
  const raw = process.env.LOCATIONIQ_DAILY_LIMIT;
  const value = raw === undefined || raw === "" ? 5000 : Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid LOCATIONIQ_DAILY_LIMIT: ${raw}`);
  return value === 0 ? null : Math.floor(value);
}

export class ProviderQuotaExhausted extends Error {
  readonly code = "provider_quota_exhausted";
  constructor(
    readonly provider: string,
    readonly reason: "local_daily_limit" | "provider_rate_limited_day",
    readonly resetsAt: Date,
    readonly used: number | null,
    readonly limit: number | null,
  ) {
    super(
      `${provider} daily quota reached (${reason}${used !== null ? `, ${used}${limit ? `/${limit}` : ""} requests today` : ""}); ` +
        `resets at ${resetsAt.toISOString()}`,
    );
    this.name = "ProviderQuotaExhausted";
  }
  toJSON() {
    return {
      provider: this.provider,
      reason: this.reason,
      resets_at: this.resetsAt.toISOString(),
      used: this.used,
      limit: this.limit,
    };
  }
}

let ledger: Pick<Pool, "query"> | null = null;
/** Per-process memory of a provider "Rate Limited Day" answer, keyed by provider and UTC day. */
const rateLimitedDay = new Map<string, string>();

export function useProviderQuotaLedger(db: Pick<Pool, "query"> | null) {
  ledger = db;
}

/** Test hook. */
export function resetProviderQuotaState() {
  rateLimitedDay.clear();
  ledger = null;
}

/**
 * Reserve one request for today, or throw `ProviderQuotaExhausted` without sending it.
 * Returns a release function for requests the provider does not charge (network errors,
 * per-second limits, server errors).
 */
export async function reserveProviderRequest(provider: string): Promise<() => Promise<void>> {
  const now = new Date();
  const limit = dailyLimit(provider);
  if (rateLimitedDay.get(provider) === utcDay(now))
    throw new ProviderQuotaExhausted(provider, "provider_rate_limited_day", nextUtcMidnight(now), null, limit);
  if (!ledger) return async () => {};
  const db = ledger;
  const { rows } = await db.query(
    `INSERT INTO research_provider_daily_usage AS u (provider, usage_day, requests)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (provider, usage_day) DO UPDATE SET requests = u.requests + 1, updated_at = now()
     WHERE u.rate_limited_at IS NULL AND ($2::int IS NULL OR u.requests < $2)
     RETURNING usage_day::text AS day, requests`,
    [provider, limit],
  );
  if (!rows.length) {
    const current = (
      await db.query(
        `SELECT requests, rate_limited_at FROM research_provider_daily_usage
         WHERE provider=$1 AND usage_day=(now() AT TIME ZONE 'UTC')::date`,
        [provider],
      )
    ).rows[0];
    throw new ProviderQuotaExhausted(
      provider,
      current?.rate_limited_at ? "provider_rate_limited_day" : "local_daily_limit",
      nextUtcMidnight(now),
      current ? Number(current.requests) : null,
      limit,
    );
  }
  const day = rows[0].day as string;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await db.query(
      `UPDATE research_provider_daily_usage SET requests = GREATEST(requests - 1, 0), updated_at = now()
       WHERE provider=$1 AND usage_day=$2::date`,
      [provider, day],
    );
  };
}

/** The provider answered "Rate Limited Day": stop every later lookup until the reset. */
export async function markProviderRateLimitedDay(provider: string): Promise<ProviderQuotaExhausted> {
  const now = new Date();
  rateLimitedDay.set(provider, utcDay(now));
  let used: number | null = null;
  if (ledger) {
    const { rows } = await ledger.query(
      `INSERT INTO research_provider_daily_usage AS u (provider, usage_day, rate_limited_at)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, now())
       ON CONFLICT (provider, usage_day) DO UPDATE SET rate_limited_at = COALESCE(u.rate_limited_at, now()), updated_at = now()
       RETURNING requests`,
      [provider],
    );
    used = rows[0] ? Number(rows[0].requests) : null;
  }
  return new ProviderQuotaExhausted(provider, "provider_rate_limited_day", nextUtcMidnight(now), used, dailyLimit(provider));
}

export interface ProviderUsageToday {
  provider: string;
  day: string;
  requests: number;
  limit: number | null;
  remaining: number | null;
  rate_limited_at: string | null;
  exhausted: boolean;
  resets_at: string;
}

export async function providerUsageToday(
  db: Pick<Pool, "query">,
  provider = LOCATIONIQ,
): Promise<ProviderUsageToday> {
  const { rows } = await db.query(
    `SELECT (now() AT TIME ZONE 'UTC')::date::text AS day, u.requests, u.rate_limited_at
     FROM (SELECT 1) one LEFT JOIN research_provider_daily_usage u
       ON u.provider=$1 AND u.usage_day=(now() AT TIME ZONE 'UTC')::date`,
    [provider],
  );
  const limit = dailyLimit(provider);
  const requests = Number(rows[0]?.requests ?? 0);
  const rateLimitedAt = rows[0]?.rate_limited_at ? new Date(rows[0].rate_limited_at).toISOString() : null;
  return {
    provider,
    day: rows[0]?.day ?? utcDay(),
    requests,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - requests),
    rate_limited_at: rateLimitedAt,
    exhausted: !!rateLimitedAt || (limit !== null && requests >= limit),
    resets_at: nextUtcMidnight().toISOString(),
  };
}

/** After a plan upgrade: forget today's "Rate Limited Day" answer (the count stays). */
export async function clearProviderRateLimit(db: Pick<Pool, "query">, provider = LOCATIONIQ) {
  rateLimitedDay.delete(provider);
  await db.query(
    `UPDATE research_provider_daily_usage SET rate_limited_at=NULL, updated_at=now()
     WHERE provider=$1 AND usage_day=(now() AT TIME ZONE 'UTC')::date`,
    [provider],
  );
}
