import { pathToFileURL } from "node:url";
/** Collect source and listed-text coordinates plus administrative evidence with versioned provenance.
 * Valid source points never move; supplied addresses win over approximate reverse addresses.
 * Optional misses are cached and reported; transport/auth failures retain provider recovery.
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import {
  deriveForwardPrecision,
  storedPrecisionEvidence,
} from "../../lib/ingestion/geocode-precision.js";
import {
  geocode,
  reverseGeocode,
  GeocodeError,
  type GeocodeHit,
} from "./providers/locationiq.js";
import { artifactTransaction } from "./execution.js";
import { canonicalLane } from "./concurrency.js";
import { CANONICAL_WRITER_LOCK } from "../../lib/ingestion/locks.js";
import { rebuildCanonicalPoi } from "./merge.js";
import {
  LOCATION_VERSION,
  LOCATION_CACHE_VERSION,
  LOCATION_GEOCODER_VERSION,
  LOCATION_QUERY_VERSION,
  LOCALITY_CONFLICT_M,
  forwardLocalityConflict,
  localityValue,
  locationReadySql,
  resolveLocation,
  textValue,
  type ReverseLocation,
} from "./location.js";
import { countryToCode } from "./normalize/country.js";
import { stableHash } from "./hash.js";
import { haversineMeters } from "./match/geo.js";
import {
  validPoint,
  type CoordinateEvidence,
  type MapLocation,
} from "../../lib/ingestion/location-points.js";

const DEFAULT_GEOCODE_LIMIT = 4500;
const DEFAULT_THROTTLE_MS = 1000; // LocationIQ free tier: stay comfortably under 2 req/s.

export interface CliOptions {
  recordId?: string;
  runId?: string;
  source?: string;
  limit?: number;
  // Undefined means no call cap for managed runs; standalone CLI retains its default.
  geocodeLimit?: number;
  throttleMs: number;
  dryRun: boolean;
}

interface GeocodeStats {
  selected: number;
  cacheHits: number;
  knownMisses: number;
  apiCalls: number;
  resolved: number;
  unresolved: number;
  noQuery: number;
  budgetHit: boolean;
}

interface GeoRow {
  id: string;
  name: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  country_name: string | null;
  category_slugs: string[] | null;
  lat?: number | null;
  lng?: number | null;
  coordinate_source?: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let geocodeLimit = DEFAULT_GEOCODE_LIMIT;
  let throttleMs = DEFAULT_THROTTLE_MS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--geocode-limit" && argv[i + 1])
      geocodeLimit = Number(argv[++i]);
    else if (a === "--throttle-ms" && argv[i + 1])
      throttleMs = Number(argv[++i]);
  }

  for (const [name, val] of [
    ["--limit", limit],
    ["--geocode-limit", geocodeLimit],
    ["--throttle-ms", throttleMs],
  ] as const) {
    if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
      throw new Error(`Invalid ${name}: ${val}`);
    }
  }

  return { source, limit, geocodeLimit, throttleMs, dryRun };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/**
 * Build the geocode query text + a normalized cache key from a row's locality.
 * Optimistic (product decision): any of venue/address/city/region/country is
 * enough to attempt a lookup; everything available goes into the query.
 *
 * Event records (temporal categories) are geocoded by locality only — an event
 * *name* ("Cayman Batabano 2026") is not a place name and steers the geocoder
 * to wrong matches. Place records (gardens, campgrounds) keep the name: it IS
 * the place name and is often the only usable signal (e.g. ArbNet).
 */
export function buildQuery(
  row: GeoRow,
  temporalSlugs: Set<string>,
): { display: string; norm: string } | null {
  if (/^q\d+$/i.test(row.name?.trim() ?? "")) return null;
  const isEvent = (row.category_slugs ?? []).some((s) => temporalSlugs.has(s));
  const locality = [
    row.venue,
    row.address,
    row.city,
    row.region,
    row.country_name ?? row.country_code,
  ]
    .map((p) => (p ? p.trim() : ""))
    .filter((p) => p.length > 0);

  // Locality-only for events; name + locality for places. A record with no
  // locality at all falls back to its name either way (optimistic).
  const parts =
    isEvent && locality.length > 0
      ? locality
      : [row.name?.trim() ?? "", ...locality].filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const display = parts.join(", ");
  const norm = display
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^q\d+(,|$)/i.test(norm)) return null;
  return { display, norm };
}

/** Captured listing text for lookup; placeholder locality such as "Various venues" is dropped. */
export function listedLocality(row: GeoRow, captured: Record<string, any>) {
  const attrs = captured.attributes ?? {};
  const hints = attrs.source_location_hints ?? {};
  return {
    ...row,
    name: textValue(captured.name),
    venue:
      localityValue(attrs.venue) ??
      localityValue(attrs.venue_name) ??
      localityValue(hints.venue),
    address:
      localityValue(captured.address) ??
      localityValue(attrs.venue_address) ??
      localityValue(attrs.street_address) ??
      localityValue(hints.location),
    city: localityValue(captured.city) ?? localityValue(hints.city),
    region: localityValue(captured.region) ?? localityValue(hints.region),
    country_code: textValue(captured.country_code),
    country_name: textValue(attrs.country_name) ?? textValue(hints.country),
  };
}

/** The address candidate must be independent of reverse enrichment and LLM guesses. */
export function listedQuery(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
) {
  const queryRow = listedLocality(row, captured);
  if (
    validPoint(row) &&
    ![
      queryRow.venue,
      queryRow.address,
      queryRow.city,
      queryRow.region,
      queryRow.country_code,
      queryRow.country_name,
    ].some(Boolean)
  )
    return null;
  // Multiple venue names can steer free-form lookup to an unrelated business.
  // A supplied address/locality is the better query when available.
  const q = buildQuery(
    queryRow.address ? { ...queryRow, name: null, venue: null } : queryRow,
    temporal,
  );
  // A country-only lookup beside a supplied point adds a centroid marker, not evidence.
  const country = (queryRow.country_name ?? queryRow.country_code)?.trim();
  if (
    q &&
    validPoint(row) &&
    ["source", "url"].includes(row.coordinate_source ?? "") &&
    country &&
    q.display === country
  )
    return null;
  return q;
}

export type QueryBasis = "address" | "venue" | "name" | "locality";

/** The most specific listing text in `listedQuery`'s lookup. `locality` means only
 * city/region/country text, so its result is a general location, never a venue or address. */
export function listedQueryBasis(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
): QueryBasis {
  const r = listedLocality(row, captured);
  if (r.address) return "address";
  if (r.venue) return "venue";
  const isEvent = (row.category_slugs ?? []).some((s) => temporal.has(s));
  const locality = [r.city, r.region, r.country_name ?? r.country_code].some(
    Boolean,
  );
  // buildQuery adds the name for places, and for events only when nothing else is listed.
  return r.name && (!isEvent || !locality) ? "name" : "locality";
}

/** Locality-only retry when a venue/address lookup lands in another city. */
export function listedCityQuery(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
) {
  const queryRow = listedLocality(row, captured);
  if (!queryRow.city) return null;
  return buildQuery(
    { ...queryRow, name: null, venue: null, address: null },
    temporal,
  );
}

export const forwardCacheKey = (norm: string, country: string | null) =>
  `${LOCATION_CACHE_VERSION}:forward:${LOCATION_QUERY_VERSION}:${country ?? "any"}:${norm}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCache(
  db: Pool,
  norm: string,
): Promise<
  | {
      lat: number | null;
      lng: number | null;
      precision: GeocodeHit["precision"] | null;
      payload?: { hit?: GeocodeHit | null };
    }
  | undefined
> {
  const { rows } = await db.query<{
    lat: number | null;
    lng: number | null;
    precision: GeocodeHit["precision"] | null;
    payload?: { hit?: GeocodeHit | null };
  }>(
    `SELECT lat, lng, precision, payload FROM research_geocode_cache WHERE query_norm = $1`,
    [norm],
  );
  return rows[0];
}

async function writeCache(
  db: Pool,
  norm: string,
  hit: GeocodeHit | null,
): Promise<void> {
  await db.query(
    `INSERT INTO research_geocode_cache (query_norm, lat, lng, precision, provider, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (query_norm) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       precision = EXCLUDED.precision, provider = EXCLUDED.provider, payload = EXCLUDED.payload,
       fetched_at = now()`,
    [
      norm,
      hit?.lat ?? null,
      hit?.lng ?? null,
      hit?.precision ?? null,
      hit?.provider ?? "locationiq",
      JSON.stringify({ hit }),
    ],
  );
}

export async function writeRowCoords(
  db: Pool,
  id: string,
  lat: number,
  lng: number,
  precision: GeocodeHit["precision"],
  queryNorm: string,
): Promise<void> {
  const inputHash = stableHash({
    queryNorm,
    provider: "locationiq",
    version: "locationiq-v1",
  });
  const linked = (
    await db.query("SELECT canonical_poi_id FROM research_pois WHERE id=$1", [
      id,
    ])
  ).rows[0]?.canonical_poi_id;
  const activate = () =>
    artifactTransaction(db, async (client) => {
      if (linked)
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          CANONICAL_WRITER_LOCK,
        ]);
      const { rows } = await client.query(
        `WITH artifact AS (
       INSERT INTO research_poi_geocodes (
       normalization_id, input_hash, query_norm, provider, provider_version,
       lat, lng, precision, status, activated_at
       )
       SELECT active_normalization_id, $2, $3, 'locationiq', 'locationiq-v1',
              $4, $5, $6, 'resolved', now()
       FROM research_pois
       WHERE id = $1 AND active_normalization_id IS NOT NULL
       ON CONFLICT (normalization_id, input_hash) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, precision = EXCLUDED.precision,
       status = EXCLUDED.status, activated_at = now()
       RETURNING id
     )
     UPDATE research_pois SET
       lat = $4, lng = $5, coordinate_source = 'geocode', coordinate_precision = $6,
       geocode_query_norm = $3,
       active_geocode_id = (SELECT id FROM artifact)
     WHERE id = $1 RETURNING active_geocode_id,canonical_poi_id`,
        [id, inputHash, queryNorm, lat, lng, precision],
      );
      if (rows[0]?.canonical_poi_id) {
        if (!linked)
          throw Object.assign(
            new Error("Canonical link changed during artifact activation"),
            { code: "lineage_invalid" },
          );
        await rebuildCanonicalPoi(client, rows[0].canonical_poi_id, {
          noLlm: true,
        });
      }
      return {
        value: undefined,
        output: { status: "succeeded", geocode_id: rows[0].active_geocode_id },
      };
    });
  await (linked ? canonicalLane.run(activate) : activate());
}

/** Collect an independent listed-location candidate, then source-first reverse enrichment. */
export async function runGeocode(
  db: Pool,
  opts: CliOptions,
): Promise<GeocodeStats> {
  const stats: GeocodeStats = {
    selected: 0,
    cacheHits: 0,
    knownMisses: 0,
    apiCalls: 0,
    resolved: 0,
    unresolved: 0,
    noQuery: 0,
    budgetHit: false,
  };
  const params: unknown[] = [];
  let where =
    "rp.is_poi AND rp.retired_at IS NULL AND rp.active_normalization_id IS NOT NULL";
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND rp.source_id=$${params.length}`;
  }
  if (opts.recordId) {
    params.push(opts.recordId);
    where += ` AND rp.id=$${params.length}`;
  }
  where += ` AND NOT COALESCE(${locationReadySql()},false)`;
  if (opts.limit !== undefined) params.push(opts.limit);
  const rows = (
    await db.query(
      `SELECT rp.id FROM research_pois rp JOIN research_sources rs ON rs.id=rp.source_id WHERE ${where} ORDER BY rp.first_seen_at${opts.limit !== undefined ? ` LIMIT $${params.length}` : ""}`,
      params,
    )
  ).rows;
  stats.selected = rows.length;
  for (const selected of rows) {
    const remaining = () =>
      opts.geocodeLimit === undefined
        ? undefined
        : Math.max(0, opts.geocodeLimit - stats.apiCalls);
    const row = (
      await db.query(
        `SELECT rp.*,o.captured
      FROM research_pois rp JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id JOIN research_poi_observations o ON o.id=rp.active_observation_id WHERE rp.id=$1`,
        [selected.id],
      )
    ).rows[0];
    const captured = row.captured ?? {},
      attrs = captured.attributes ?? {};
    const source = {
      country_code:
        countryToCode(captured.country_code) ??
        countryToCode(attrs.country_name) ??
        null,
      address:
        textValue(captured.address) ??
        textValue(attrs.venue_address) ??
        textValue(attrs.street_address),
      city: textValue(captured.city),
      region: textValue(captured.region),
    };
    let lat: number | null = row.lat,
      lng: number | null = row.lng;
    let coordinateSource = row.coordinate_source,
      coordinatePrecision = row.coordinate_precision;
    const temporal = new Set<string>(
      (
        await db.query(
          "SELECT slug FROM canonical_categories WHERE is_temporal",
        )
      ).rows.map((r) => r.slug),
    );
    const q = listedQuery(row, captured, temporal);
    const forwardCountry =
      source.country_code ??
      countryToCode(textValue(attrs.source_location_hints?.country)) ??
      null;
    // Separate policy namespace; do not reuse historical name/reverse-derived queries.
    const lookup = async (query: { display: string; norm: string }) => {
      const key = forwardCacheKey(query.norm, forwardCountry);
      const cached = await readCache(db, key);
      if (cached) {
        stats.cacheHits++;
        const hit: GeocodeHit | null = validPoint(cached)
          ? {
              ...cached.payload?.hit,
              lat: cached.lat!,
              lng: cached.lng!,
              precision: cached.precision ?? "point",
              provider: "locationiq",
            }
          : null;
        if (!hit) stats.knownMisses++;
        else if (hit.raw_response) {
          // The saved provider row reproduces the current classifier without a paid refetch.
          hit.precision_evidence = deriveForwardPrecision(hit.raw_response);
          hit.precision = hit.precision_evidence
            .value as GeocodeHit["precision"];
        } else
          hit.precision_evidence = storedPrecisionEvidence(hit, "legacy_cache");
        return { key, hit, stop: null };
      }
      if (remaining() === 0) return { key, hit: null, stop: "budget" as const };
      if (opts.dryRun) {
        stats.apiCalls++;
        return { key, hit: null, stop: "dry_run" as const };
      }
      if (opts.throttleMs > 0) await sleep(opts.throttleMs);
      const hit = await geocode(query.display, forwardCountry);
      stats.apiCalls++;
      await writeCache(db, key, hit);
      return { key, hit, stop: null };
    };
    let forward: GeocodeHit | null = null;
    let forwardQueryNorm: string | null = null;
    let forwardQuery = q;
    let forwardBasis: QueryBasis | null = q
      ? listedQueryBasis(row, captured, temporal)
      : null;
    let rejected: Record<string, unknown> | null = null;
    let cityConfirmation: {
      query: string;
      query_norm: string;
      result: GeocodeHit;
    } | null = null;
    if (q) {
      const first = await lookup(q);
      if (first.stop === "budget") {
        stats.budgetHit = true;
        break;
      }
      if (first.stop) continue;
      forwardQueryNorm = first.key;
      forward = first.hit ?? null;
      const cityQuery = listedCityQuery(row, captured, temporal);
      const sourcePoint =
        validPoint({ lat: row.lat, lng: row.lng }) &&
        ["source", "url"].includes(row.coordinate_source)
          ? { lat: row.lat as number, lng: row.lng as number }
          : null;
      if (
        forward &&
        cityQuery &&
        cityQuery.norm !== q.norm &&
        forwardLocalityConflict(
          listedLocality(row, captured).city,
          forward,
          sourcePoint,
        )
      ) {
        const retry = await lookup(cityQuery);
        if (retry.stop === "budget") {
          stats.budgetHit = true;
          break;
        }
        if (retry.stop) continue;
        // The listed city's own lookup confirms a nearby result (another spelling of that city).
        const confirmed =
          retry.hit &&
          haversineMeters(retry.hit, forward) <= LOCALITY_CONFLICT_M;
        if (confirmed && retry.hit) {
          cityConfirmation = {
            query: cityQuery.display,
            query_norm: retry.key,
            result: retry.hit,
          };
        } else {
          // Keep the rejected paid result as evidence; it never occupies the inferred slot.
          rejected = {
            reason: "forward_locality_conflict",
            query: q.display,
            query_norm: first.key,
            result: forward,
          };
          forwardQuery = cityQuery;
          forwardBasis = "locality";
          forwardQueryNorm = retry.key;
          forward = retry.hit ?? null;
        }
      }
    } else stats.noQuery++;
    if (!validPoint({ lat, lng })) {
      if (!forward) {
        stats.unresolved++;
        continue;
      }
      lat = forward.lat;
      lng = forward.lng;
      coordinateSource = "geocode";
      coordinatePrecision = forward.precision;
    }
    if (opts.dryRun) continue;
    const coordinateEvidence: CoordinateEvidence = {
      source_coordinates:
        validPoint({ lat: row.lat, lng: row.lng }) &&
        ["source", "url"].includes(row.coordinate_source)
          ? {
              lat: row.lat,
              lng: row.lng,
              kind: "source",
              origin: "source_coordinates",
              precision: row.coordinate_precision ?? "point",
              label: null,
              query: null,
            }
          : null,
      inferred_coordinates: forward
        ? {
            lat: forward.lat,
            lng: forward.lng,
            kind: "inferred",
            origin: "listed_address_geocode",
            precision: forward.precision,
            label: forward.label ?? null,
            query: forwardQuery?.display ?? null,
            precision_evidence: forward.precision_evidence,
          }
        : null,
    };
    const queryNorm = `${LOCATION_CACHE_VERSION}:reverse:${lat}:${lng}`;
    let hit: ReverseLocation | null = null;
    if (Object.values(source).some((value) => !value)) {
      const cache = (
        await db.query(
          "SELECT payload FROM research_geocode_cache WHERE query_norm=$1",
          [queryNorm],
        )
      ).rows[0];
      if (cache?.payload) {
        hit = cache.payload.hit;
        stats.cacheHits++;
        if (!hit) stats.knownMisses++;
      } else {
        if (remaining() === 0) {
          stats.budgetHit = true;
          break;
        }
        if (opts.throttleMs > 0) await sleep(opts.throttleMs);
        hit = await reverseGeocode(lat!, lng!);
        stats.apiCalls++;
        await db.query(
          `INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider,payload) VALUES($1,$2,$3,'point','locationiq',$4::jsonb)
          ON CONFLICT(query_norm) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now()`,
          [queryNorm, lat, lng, JSON.stringify({ hit })],
        );
      }
    }
    const resolved = resolveLocation(
      source,
      hit && coordinatePrecision !== "point" ? { ...hit, address: null } : hit,
    );
    if (
      forwardCountry &&
      forward?.country_code &&
      forwardCountry !== forward.country_code
    )
      resolved.warnings.push("forward_country_conflict");
    if (!hit && Object.values(source).some((value) => !value))
      resolved.warnings.push("reverse_location_incomplete");
    if (Object.values(resolved.fields).some((value) => !value))
      resolved.warnings.push("location_fields_incomplete");
    const metadata = {
      version: LOCATION_VERSION,
      normalization_id: row.active_normalization_id,
      point: { lat, lng },
      forward_query_norm: forwardQueryNorm,
      listed: { ...source, hints: attrs.source_location_hints ?? null },
      forward: {
        query_version: LOCATION_QUERY_VERSION,
        country_filter: forwardCountry,
        query: forwardQuery?.display ?? null,
        query_basis: forwardBasis,
        query_norm: forwardQueryNorm,
        state: !q ? "no_query" : forward ? "resolved" : "miss",
        result: forward,
        ...(rejected ? { rejected } : {}),
        ...(cityConfirmation ? { city_confirmation: cityConfirmation } : {}),
      },
      coordinate_evidence: coordinateEvidence,
      ...resolved,
      reverse: hit,
      lookup_state: hit
        ? "resolved"
        : Object.values(source).some((value) => !value)
          ? "miss"
          : "not_needed",
      assessed_at: new Date().toISOString(),
    };
    const inputHash = stableHash({
      normalization: row.active_normalization_id,
      point: metadata.point,
      coordinate_source: coordinateSource,
      forward_query_norm: forwardQueryNorm,
      // Bind any newly captured response metadata to this artifact without changing query-cache identity.
      forward_result: forward,
      ...(rejected ? { forward_rejected: rejected } : {}),
      ...(cityConfirmation
        ? { forward_city_confirmation: cityConfirmation }
        : {}),
      version: LOCATION_VERSION,
      coordinate_evidence: coordinateEvidence,
    });
    await canonicalLane.run(() =>
      artifactTransaction(db, async (client) => {
        if (row.canonical_poi_id)
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
            CANONICAL_WRITER_LOCK,
          ]);
        const artifact = (
          await client.query(
            `INSERT INTO research_poi_geocodes(normalization_id,input_hash,query_norm,provider,provider_version,lat,lng,precision,status,validation,activated_at)
        VALUES($1,$2,$3,'locationiq',$4,$5,$6,$7,'resolved',$8::jsonb,now()) ON CONFLICT(normalization_id,input_hash) DO UPDATE SET activated_at=now() RETURNING id`,
            [
              row.active_normalization_id,
              inputHash,
              queryNorm,
              LOCATION_GEOCODER_VERSION,
              lat,
              lng,
              coordinatePrecision ?? "point",
              JSON.stringify(metadata),
            ],
          )
        ).rows[0];
        // This artifact certifies enrichment of the original point; it never substitutes a nearby object's point.
        const activated = await client.query(
          `UPDATE research_pois SET lat=$11,lng=$12,coordinate_source=$13,coordinate_precision=$14,geocode_query_norm=$15,country_code=$2,city=$3,region=$4,address=$5,active_geocode_id=$6,
        attributes=COALESCE(attributes,'{}'::jsonb)||jsonb_build_object('location_enrichment',$7::jsonb),
        content_embedding=CASE WHEN city IS DISTINCT FROM $3 OR region IS DISTINCT FROM $4 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE content_embedding END,
        active_embedding_id=CASE WHEN city IS DISTINCT FROM $3 OR region IS DISTINCT FROM $4 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE active_embedding_id END
        WHERE id=$1 AND active_normalization_id=$8 AND lat IS NOT DISTINCT FROM $9::float8 AND lng IS NOT DISTINCT FROM $10::float8`,
          [
            row.id,
            resolved.fields.country_code,
            resolved.fields.city,
            resolved.fields.region,
            resolved.fields.address,
            artifact.id,
            JSON.stringify(metadata),
            row.active_normalization_id,
            row.lat,
            row.lng,
            lat,
            lng,
            coordinateSource,
            coordinatePrecision,
            forwardQueryNorm,
          ],
        );
        if (activated.rowCount !== 1)
          throw Object.assign(
            new Error("Location input changed during activation"),
            { code: "lineage_invalid" },
          );
        if (row.canonical_poi_id)
          await rebuildCanonicalPoi(client, row.canonical_poi_id, {
            noLlm: true,
          });
        return {
          value: undefined,
          output: {
            status: "succeeded",
            geocode_id: artifact.id,
            location_warnings: resolved.warnings,
            coordinate_kinds: Object.values(coordinateEvidence)
              .filter(Boolean)
              .map((p) => p!.kind),
            forward_lookup_state: metadata.forward.state,
          },
        };
      }),
    );
    stats.resolved++;
  }
  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const stats = await runGeocode(db, opts);
  await db.end();

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Geocode${mode}${opts.source ? ` ${opts.source}` : ""}: selected=${stats.selected} ` +
      `cache_hits=${stats.cacheHits} known_misses=${stats.knownMisses} ` +
      `api_calls=${stats.apiCalls} resolved=${stats.resolved} unresolved=${stats.unresolved} ` +
      `no_query=${stats.noQuery}${stats.budgetHit ? " [budget reached — re-run to continue]" : ""}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error("Geocode failed:", err);
    process.exit(1);
  });
