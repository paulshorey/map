/** A fair semaphore; provider waiting never holds a database transaction. */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(public limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit || this.waiters.length)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }
  drain() {
    while (this.active < this.limit && this.waiters.length) {
      this.active++;
      this.waiters.shift()!();
    }
  }
  get inFlight() {
    return this.active;
  }
}

export class ProviderLimiter {
  readonly semaphore: Semaphore;
  private cooldownUntil = 0;
  private reducedAt = 0;
  private nextStart = 0;
  private spacingMs = 0;
  constructor(
    readonly target = 4,
    private clock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    },
  ) {
    this.semaphore = new Semaphore(target);
  }
  async run<T>(fn: () => Promise<T>, stopped = () => false): Promise<T> {
    return this.semaphore.run(async () => {
      for (;;) {
        if (stopped())
          throw Object.assign(new Error("Provider admission stopped"), {
            code: "ingest_paused",
          });
        const now = this.clock.now();
        const wait = Math.max(this.cooldownUntil, this.nextStart) - now;
        if (wait <= 0) {
          this.nextStart = now + this.spacingMs;
          break;
        }
        await this.clock.sleep(Math.min(1000, wait));
      }
      return fn();
    });
  }
  observe(
    headers: Headers,
    status: number,
    promptTokens: number,
    maxOutput: number,
    retryAfter = 0,
  ) {
    const now = this.clock.now();
    let spacing = 0,
      observed = false;
    const tokens = [
      ["x-ratelimit-limit-tokens-prompt", promptTokens],
      ["x-ratelimit-limit-tokens-generated", maxOutput],
      ["x-ratelimit-limit-tokens-cache-adjusted-prompt", promptTokens],
      ["x-ratelimit-limit-tokens", promptTokens + maxOutput],
    ] as const;
    for (const [key, expected] of tokens) {
      const limit = Number(headers.get(key));
      if (Number.isFinite(limit) && limit > 0) {
        spacing = Math.max(spacing, (60000 * expected) / (limit * 0.8));
        observed = true;
      }
    }
    const rpm = Number(headers.get("x-ratelimit-limit-requests"));
    if (rpm > 0) {
      spacing = Math.max(spacing, 60000 / (rpm * 0.8));
      observed = true;
    }
    if (observed) this.spacingMs = spacing;
    if (status === 429 || status === 503) {
      this.cooldownUntil = Math.max(
        this.cooldownUntil,
        now + Math.max(retryAfter, 30000),
      );
      this.semaphore.limit = Math.max(1, Math.floor(this.semaphore.limit / 2));
      this.reducedAt = now;
    } else if (
      status < 400 &&
      this.semaphore.limit < this.target &&
      now - this.reducedAt >= 900000
    ) {
      this.semaphore.limit++;
      this.reducedAt = now;
      this.semaphore.drain();
    }
  }
  snapshot() {
    return {
      target: this.target,
      effective: this.semaphore.limit,
      active: this.semaphore.inFlight,
      cooldown_until: this.cooldownUntil
        ? new Date(this.cooldownUntil).toISOString()
        : null,
      spacing_ms: Math.ceil(this.spacingMs),
    };
  }
}

export const canonicalLane = new Semaphore(1);
export let llmLimiter = new ProviderLimiter();
export function configureLlmConcurrency(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16)
    throw new Error("LLM concurrency must be an integer from 1 to 16");
  llmLimiter = new ProviderLimiter(value);
}
