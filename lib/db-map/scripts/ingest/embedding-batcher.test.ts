import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTexts } from "./providers/jina.js";
import { ingestConfig } from "./config.js";
test("embedding vectors are reordered and duplicate/malformed vectors are refused", async () => {
  const fetchOriginal = globalThis.fetch,
    key = process.env.JINA_API_KEY;
  process.env.JINA_API_KEY = "test";
  const vector = () =>
    Array.from({ length: ingestConfig.embeddings.dim }, () => 0.1);
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: vector() },
            { index: 0, embedding: vector() },
          ],
        }),
        { status: 200 },
      );
    assert.equal((await embedTexts(["a", "b"])).length, 2);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: vector() },
            { index: 0, embedding: vector() },
          ],
        }),
        { status: 200 },
      );
    await assert.rejects(embedTexts(["a", "b"]), /Invalid embedding index/);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [null] }] }),
        { status: 200 },
      );
    await assert.rejects(embedTexts(["a"]), /length/);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (key === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = key;
  }
});
