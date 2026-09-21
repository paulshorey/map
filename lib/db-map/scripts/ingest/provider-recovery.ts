import { LlmError } from "./providers/deepinfra.js";

export interface RecoveryEvent {
  state: "cooldown" | "recovered" | "settled" | "exhausted" | "paused";
  retry: number;
  executionRetries: number;
  delayMs?: number;
  retryAt?: string;
  reason?: string;
  error?: { message: string; status?: number; retryAfterMs?: number };
}

export class ProviderRecoveryExhausted extends Error {
  readonly code = "provider_recovery_exhausted";
  constructor(
    readonly providerError: LlmError,
    readonly reason: string,
  ) {
    super(`Provider recovery exhausted (${reason}): ${providerError.message}`, {
      cause: providerError,
    });
    this.name = "ProviderRecoveryExhausted";
  }
}

// Only transport/capacity failures qualify. Invalid/empty/truncated model output does not.
export function isTransientProviderError(error: unknown): error is LlmError {
  return (
    error instanceof LlmError &&
    error.retryable &&
    (error.status === 429 ||
      (error.status !== undefined && error.status >= 500) ||
      error.message === "Request timed out" ||
      error.message.startsWith("Network error:"))
  );
}

/** One instance per managed execution; ordinary timers, no agent/model monitoring. */
export class ProviderRecovery {
  private executionRetries = 0;
  constructor(
    private readonly clock = {
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      random: () => Math.random(),
    },
  ) {}

  async run<T>(options: {
    attempt: () => Promise<T>;
    stopped: () => boolean;
    paused: () => T;
    event: (event: RecoveryEvent) => Promise<void>;
    resultStatus?: (result: T) => string;
  }): Promise<T> {
    const started = this.clock.now();
    const deadline = started + 15 * 60_000;
    let retry = 0;
    let lastError: LlmError | undefined;
    const emit = (event: Omit<RecoveryEvent, "retry" | "executionRetries">) =>
      options.event({
        ...event,
        retry,
        executionRetries: this.executionRetries,
      });
    const exhausted = async (reason: string): Promise<never> => {
      await emit({
        state: "exhausted",
        reason,
        error: lastError && {
          message: lastError.message,
          status: lastError.status,
          retryAfterMs: lastError.retryAfterMs,
        },
      });
      throw new ProviderRecoveryExhausted(lastError!, reason);
    };
    for (;;) {
      if (options.stopped()) {
        if (retry) await emit({ state: "paused" });
        return options.paused();
      }
      if (retry && this.clock.now() >= deadline)
        return exhausted("record_deadline");
      try {
        const result = await options.attempt();
        if (retry) {
          const status = options.resultStatus?.(result) ?? "succeeded";
          await emit({
            state: ["succeeded", "reused", "skipped"].includes(status)
              ? "recovered"
              : "settled",
            reason: status,
          });
        }
        return result;
      } catch (error) {
        if (!isTransientProviderError(error)) {
          if (retry)
            await emit({
              state: "settled",
              reason: "terminal_error",
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            });
          throw error;
        }
        lastError = error;
        if (options.stopped()) continue;
        if (retry >= 5) return exhausted("record_retry_limit");
        if (this.executionRetries >= 100)
          return exhausted("execution_retry_limit");
        const backoff =
          Math.min(300_000, 30_000 * 2 ** retry) +
          Math.floor(this.clock.random() * 1_000);
        // Retry-After is a minimum: never truncate it to retry sooner than requested.
        const delayMs = Math.max(backoff, error.retryAfterMs ?? 0);
        if (this.clock.now() + delayMs >= deadline)
          return exhausted("record_deadline");
        retry++;
        this.executionRetries++;
        const until = this.clock.now() + delayMs;
        await emit({
          state: "cooldown",
          delayMs,
          retryAt: new Date(until).toISOString(),
          error: {
            message: error.message,
            status: error.status,
            retryAfterMs: error.retryAfterMs,
          },
        });
        while (this.clock.now() < until && !options.stopped()) {
          await this.clock.sleep(Math.min(1_000, until - this.clock.now()));
        }
      }
    }
  }
}
