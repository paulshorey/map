import type { Pool } from "pg";
import { currentAttempt, withAttemptContext } from "./execution.js";
import { embedTexts } from "./providers/jina.js";
import { writeEmbedding } from "./embed.js";
type Context = NonNullable<ReturnType<typeof currentAttempt>>;
type Entry = {
  id: string;
  text: string;
  context: Context;
  resolve: () => void;
  reject: (e: unknown) => void;
};
/** Groups provider work only; every activation/checkpoint remains a fenced record transaction. */
export class EmbeddingBatcher {
  private queue: Entry[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    private db: Pool,
    private size = 32,
    private waitMs = 2000,
  ) {}
  add(id: string, text: string): Promise<void> {
    const context = currentAttempt();
    if (!context) throw new Error("Batch embedding requires a managed attempt");
    return new Promise((resolve, reject) => {
      this.queue.push({ id, text, context, resolve, reject });
      if (this.queue.length >= this.size) void this.flush();
      else if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush();
        }, this.waitMs);
    });
  }
  private async flush() {
    if (this.busy) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length) return;
    this.busy = true;
    const batch = this.queue.splice(0, this.size);
    try {
      const vectors = await embedTexts(
        batch.map((x) => x.text),
        batch.map((x) => x.context),
      );
      await Promise.all(
        batch.map(async (entry, i) => {
          try {
            await withAttemptContext(entry.context, () =>
              writeEmbedding(this.db, entry.id, entry.text, vectors[i]!),
            );
            entry.resolve();
          } catch (e) {
            entry.reject(e);
          }
        }),
      );
    } catch (e) {
      for (const entry of batch) entry.reject(e);
    } finally {
      this.busy = false;
      if (this.queue.length) void this.flush();
    }
  }
}
