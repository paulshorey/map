import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  deriveForwardPrecision,
  storedPrecisionEvidence,
} from "../../lib/ingestion/geocode-precision.js";
import { readCoordinateEvidence } from "../../lib/ingestion/location-points.js";
import { geocode } from "./providers/locationiq.js";
import { precisionDiagnostics } from "./precision-diagnostics.js";

const sao = JSON.parse(
  readFileSync(
    new URL("./fixtures/locationiq-sao-paulo.json", import.meta.url),
    "utf8",
  ),
);
const originalFetch = globalThis.fetch,
  originalKey = process.env.LOCATIONIQ_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = originalKey;
});

test("missing and unclassified provider granularity explain the existing point fallback", () => {
  const missing = deriveForwardPrecision({});
  assert.equal(missing.value, "point");
  assert.equal(missing.derivation, "fallback");
  assert.deepEqual(missing.warnings, [
    "point_precision_default",
    "provider_granularity_missing",
  ]);
  const unclassified = deriveForwardPrecision({
    class: "tourism",
    type: "attraction",
  });
  assert.equal(unclassified.value, "point");
  assert.equal(unclassified.derivation, "fallback");
  assert.deepEqual(unclassified.warnings, ["point_precision_default"]);
  assert.equal(unclassified.provider_type, "attraction");
  for (const [row, value, derivation] of [
    [{ type: "city", class: "place" }, "city", "provider_type"],
    [{ type: "state" }, "region", "provider_type"],
    [{ class: "boundary" }, "region", "provider_class"],
  ] as const)
    assert.deepEqual(
      [
        deriveForwardPrecision(row).value,
        deriveForwardPrecision(row).derivation,
      ],
      [value, derivation],
    );
});

test("saved Sao Paulo artifact is diagnostic evidence, with no reconstructed raw provider response", () => {
  const before = structuredClone(sao.forward.result);
  const evidence = storedPrecisionEvidence(
    sao.forward.result,
    "legacy_artifact",
  );
  assert.equal(evidence.value, "point");
  assert.equal(evidence.derivation, "legacy_artifact");
  assert.deepEqual(evidence.warnings, [
    "precision_derivation_not_recorded",
    "provider_granularity_missing",
  ]);
  const diagnostics = precisionDiagnostics({
    validation: { forward: sao.forward },
  } as any);
  assert.equal(diagnostics?.raw_response_available, false);
  assert.deepEqual(sao.forward.result, before);
  assert.equal(precisionDiagnostics(null), null);
  assert.equal(
    precisionDiagnostics({
      validation: { forward: { state: "miss", result: null } },
    } as any),
    null,
  );
});

test("fresh response preserves complete selected provider row and carries compact evidence through slots", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture-only";
  const row = {
    lat: String(sao.forward.result.lat),
    lon: String(sao.forward.result.lng),
    display_name: sao.forward.result.label,
    // A street keeps this granularity-free row on the point fallback (v4 reads addresses).
    address: { country_code: "br", city: "São Paulo", road: "Avenida Pedro Álvares Cabral" },
    boundingbox: ["-23.58", "-23.56", "-46.67", "-46.65"],
    place_id: "fixture",
    extra_provider_field: { observed: true },
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json([row]);
  };
  const hit = await geocode(sao.forward.query, "BR");
  assert.equal(calls, 1);
  assert.deepEqual(hit?.raw_response, row);
  assert.equal(hit?.precision, "point");
  assert.equal(hit?.precision_evidence?.derivation, "fallback");
  assert.ok(!JSON.stringify(hit).includes("fixture-only"));
  const cached = {
    ...hit!,
    precision_evidence: structuredClone(hit!.precision_evidence),
  };
  assert.deepEqual(
    storedPrecisionEvidence(cached, "legacy_cache"),
    hit?.precision_evidence,
  );
  const slots = readCoordinateEvidence({
    source_coordinates: null,
    inferred_coordinates: {
      lat: hit!.lat,
      lng: hit!.lng,
      precision: hit!.precision,
      precision_evidence: hit!.precision_evidence,
      kind: "inferred",
      origin: "listed_address_geocode",
      query: sao.forward.query,
      label: hit!.label,
    },
  });
  assert.deepEqual(
    slots.inferred_coordinates?.precision_evidence,
    hit?.precision_evidence,
  );
  assert.equal(slots.source_coordinates, null);
  assert.equal((slots.inferred_coordinates as any).raw_response, undefined);
});

test("v3 boundaries take their precision from their own address", () => {
  const row = (type: string, cls: string, address: Record<string, string>) =>
    deriveForwardPrecision({ type, class: cls, address });
  // "England" is a state boundary, not a city; Missouri's Mexico is a city.
  assert.equal(row("administrative", "boundary", { state: "England", country: "United Kingdom", country_code: "gb" }).value, "region");
  assert.equal(row("administrative", "boundary", { city: "Mexico", county: "Audrain County", state: "Missouri", country_code: "us" }).value, "city");
  assert.equal(row("administrative", "boundary", { state: "Κύπρος", country: "Κύπρος - Kıbrıs", country_code: "cy" }).value, "region");
  assert.equal(row("island", "place", { island: "Great Britain", country_code: "gb" }).value, "region");
  assert.equal(row("county", "boundary", { county: "Kent", country_code: "gb" }).value, "region");
  assert.equal(row("administrative", "boundary", { country: "Nigeria", country_code: "ng" }).value, "country");
});

test("v4 rows without class/type take precision from their address fields", () => {
  const zongolica = deriveForwardPrecision({
    address: { city: "Zongolica", county: "Zongolica", state: "Veracruz", country: "Mexico", country_code: "mx" },
  });
  assert.equal(zongolica.value, "city");
  assert.equal(zongolica.derivation, "provider_address");
  assert.ok(zongolica.warnings.includes("provider_granularity_missing"));
  assert.equal(deriveForwardPrecision({ address: { state: "Yucatán", country_code: "mx" } }).value, "region");
  assert.equal(deriveForwardPrecision({ address: { road: "Calle 43", city: "Mérida" } }).value, "point");
  assert.equal(deriveForwardPrecision({ address: { name: "Ray-Ban", city: "Frankfurt" } }).value, "point");
});

test("an untyped postcode-only row is a city-sized area, not a country", () => {
  assert.equal(deriveForwardPrecision({ address: { postcode: "62210", country_code: "mx" } }).value, "city");
});

test("typed postcode rows are city-sized", () => {
  assert.equal(deriveForwardPrecision({ class: "place", type: "postcode", address: { postcode: "75001" } }).value, "city");
  assert.equal(deriveForwardPrecision({ addresstype: "postcode", address: { postcode: "75001" } }).value, "city");
});
