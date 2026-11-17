/**
 * Keeps model calls out of locked database work.
 *
 * Matching and canonical rebuilds hold the canonical writer lock and a transaction. Two of
 * their steps ask a model: "are these two records the same place?" and "merge these
 * descriptions". Both answers depend only on the text sent, so they can be fetched before
 * the lock is taken and replayed inside it:
 *
 *  1. Locked work asks through `memoizedLlm`. An answer already in the memo is returned.
 *  2. Otherwise, in deferred mode, it throws `LlmDeferred`. The caller rolls back, which
 *     releases the lock, makes the call, stores the answer and runs the work again.
 *
 * The memo key is a hash of the request as serialized for the provider, so an answer is only
 * ever reused for the request it was given for. If the data changed between passes, the request differs, the
 * memo misses and the call is simply made again.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { stableHash } from "./hash.js";

export type LlmMemo = Map<string, unknown>;
const store = new AsyncLocalStorage<{ memo: LlmMemo; deferred: boolean }>();

/** A model call that locked work needs; the caller makes it after releasing the lock. */
export class LlmDeferred extends Error {
  readonly code = "llm_deferred";
  constructor(
    readonly key: string,
    readonly call: () => Promise<unknown>,
  ) {
    super("Model call deferred until the canonical lock is released");
  }
}

/** Run `fn` with a memo. With `deferred`, a missing answer throws instead of calling. */
export function withLlmMemo<T>(
  memo: LlmMemo,
  deferred: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run({ memo, deferred }, fn);
}

/** Ask a model through the active memo; without one, this is a plain call. */
export async function memoizedLlm<T>(
  purpose: string,
  request: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const active = store.getStore();
  if (!active) return call();
  // Hash the request as it is serialized for the provider: JSON turns a Date into its ISO
  // text, where hashing the object itself would see every Date as the same empty object.
  const key = stableHash(JSON.parse(JSON.stringify({ purpose, request })));
  if (active.memo.has(key)) return active.memo.get(key) as T;
  if (active.deferred) throw new LlmDeferred(key, call);
  const answer = await call();
  active.memo.set(key, answer);
  return answer;
}

/**
 * After this many rollbacks for one unit of work, the remaining model calls are made
 * inside the lock, as before. This bounds repeated database work when the data keeps
 * changing under a record.
 */
export const MAX_LLM_DEFERRALS = 3;

/**
 * Run locked work so that its model calls happen outside the lock. `locked` must take
 * and release its own lock and transaction, and must roll back when it throws.
 */
export async function withLlmOutsideLock<T>(
  locked: () => Promise<T>,
  memo: LlmMemo = new Map(),
): Promise<T> {
  for (let deferrals = 0; ; deferrals++) {
    try {
      return await withLlmMemo(memo, deferrals < MAX_LLM_DEFERRALS, locked);
    } catch (error) {
      if (!(error instanceof LlmDeferred)) throw error;
      // No lock or transaction is held here.
      memo.set(error.key, await withLlmMemo(memo, false, error.call));
    }
  }
}
