import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parse } from "csv-parse";
import chain from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/stream-array.js";

/** Stream rows from a CSV file (first row = headers). */
export async function* streamCsv(file: string): AsyncIterable<Record<string, string>> {
  const stream = createReadStream(file, { encoding: "utf8" }).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );
  for await (const row of stream) {
    yield row as Record<string, string>;
  }
}

/** Stream elements from a top-level JSON array without loading the whole file. */
export async function* streamJsonArray(file: string): AsyncIterable<unknown> {
  const pipeline = chain([
    createReadStream(file),
    parser(),
    streamArray(),
  ]);

  for await (const chunk of pipeline) {
    const { value } = chunk as { key: number; value: unknown };
    yield value;
  }
}

/** Stream one JSON object per line (.jsonl). */
export async function* streamJsonl(file: string): AsyncIterable<unknown> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as unknown;
  }
}

/** Pick the right streaming reader from file extension. */
export async function* streamRecords(file: string): AsyncIterable<unknown> {
  const lower = file.toLowerCase();
  if (lower.endsWith(".csv")) {
    yield* streamCsv(file);
    return;
  }
  if (lower.endsWith(".jsonl")) {
    yield* streamJsonl(file);
    return;
  }
  if (lower.endsWith(".json")) {
    yield* streamJsonArray(file);
    return;
  }
  throw new Error(`Unsupported file format: ${file} (expected .csv, .json, or .jsonl)`);
}
