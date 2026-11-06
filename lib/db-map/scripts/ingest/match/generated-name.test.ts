import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutGeneratedCandidateName, withoutGeneratedName } from "../match.js";
import { scoreCandidate } from "./score.js";
import { normalizedExactName } from "./anchors.js";

const embedding = [0.6, 0.8];
const generatedRow = {
  name: null,
  name_normalized: "caravan site near lyon france",
  content_embedding: embedding,
  attributes: { name_generated: true },
};

test("a generated name is neither name nor embedding evidence on either side", () => {
  const row = withoutGeneratedName(generatedRow as never) as unknown as typeof generatedRow;
  assert.equal(row.name_normalized, null);
  assert.equal(row.content_embedding, null);
  assert.equal(row.attributes.name_generated, true);

  const candidate = withoutGeneratedCandidateName({
    best_name_generated: true,
    best_name: null,
    best_name_normalized: "caravan site near lyon france",
    best_content_embedding: embedding,
    canonical_name: "Caravan site near Lyon, France",
  });
  assert.equal(candidate.canonical_name, "");
  assert.equal(normalizedExactName(row.name_normalized, candidate.canonical_name), false);

  const score = scoreCandidate({
    current: { ...row, website: null, phone: null, city: "Lyon", region: null, country_code: "FR", coordinate_precision: "point" },
    candidate: {
      name: candidate.best_name ?? candidate.canonical_name,
      name_normalized: candidate.best_name_normalized ?? candidate.canonical_name,
      content_embedding: candidate.best_content_embedding,
      website: null,
      phone: null,
      city: "Lyon",
      region: null,
      country_code: "FR",
      coordinate_precision: "point",
    },
    distanceM: 10,
    radiusM: 500,
  } as never);
  assert.equal(score.signals.name, 0);
  assert.equal(score.signals.embedding, null);
  assert.ok(score.score < 0.55, `two nameless neighbours stay below T_low: ${score.score}`);
});

test("named rows and candidates are untouched", () => {
  const named = { ...generatedRow, name: "Camping du Lac", attributes: {} };
  assert.equal(withoutGeneratedName(named as never), named);
  const candidate = {
    best_name_generated: false,
    best_name: "Camping du Lac",
    best_name_normalized: "camping du lac",
    best_content_embedding: embedding,
    canonical_name: "Camping du Lac",
  };
  assert.equal(withoutGeneratedCandidateName(candidate), candidate);
});
