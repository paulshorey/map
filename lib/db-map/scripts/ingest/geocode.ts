import { pathToFileURL } from "node:url";
/** Resolve missing coordinates and enrich administrative fields with versioned provenance.
 * Valid source points never move; supplied addresses win over approximate reverse addresses.
 * Optional misses are cached and reported; transport/auth failures retain provider recovery.
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
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
  LOCATION_GEOCODER_VERSION,
  locationReadySql,
  resolveLocation,
  textValue,
  type ReverseLocation,
} from "./location.js";
import { countryToCode } from "./normalize/country.js";
import { stableHash } from "./hash.js";

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
function buildQuery(
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCache(
  db: Pool,
  norm: string,
): Promise<
  | {
      lat: number | null;
      lng: number | null;
      precision: GeocodeHit["precision"] | null;
    }
  | undefined
> {
  const { rows } = await db.query<{
    lat: number | null;
    lng: number | null;
    precision: GeocodeHit["precision"] | null;
  }>(
    `SELECT lat, lng, precision FROM research_geocode_cache WHERE query_norm = $1`,
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
    `INSERT INTO research_geocode_cache (query_norm, lat, lng, precision, provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (query_norm) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       precision = EXCLUDED.precision, provider = EXCLUDED.provider,
       fetched_at = now()`,
    [
      norm,
      hit?.lat ?? null,
      hit?.lng ?? null,
      hit?.precision ?? null,
      hit?.provider ?? "locationiq",
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

async function runForwardGeocode(
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
  let where = `(lat IS NULL OR lng IS NULL) AND is_poi`;
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }
  if (opts.recordId) {
    params.push(opts.recordId);
    where += ` AND id = $${params.length}`;
  }
  where += " AND retired_at IS NULL";
  let limitClause = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limitClause = ` LIMIT $${params.length}`;
  }

  const { rows } = await db.query<GeoRow>(
    `SELECT id, name, attributes->>'venue' AS venue, address, city, region, country_code,
            attributes->>'country_name' AS country_name, category_slugs
     FROM research_pois
     WHERE ${where}
     ORDER BY first_seen_at${limitClause}`,
    params,
  );
  stats.selected = rows.length;

  const { rows: temporalRows } = await db.query<{ slug: string }>(
    `SELECT slug FROM canonical_categories WHERE is_temporal`,
  );
  const temporalSlugs = new Set(temporalRows.map((r) => r.slug));

  for (const row of rows) {
    const q = buildQuery(row, temporalSlugs);
    if (!q) {
      stats.noQuery++;
      console.warn(
        `Skipped - ${row.name ?? `(id ${row.id})`} - unable to parse location (no locality fields)`,
      );
      continue;
    }

    const cached = await readCache(db, q.norm);
    if (cached) {
      if (cached.lat !== null && cached.lng !== null) {
        if (!opts.dryRun) {
          await writeRowCoords(
            db,
            row.id,
            cached.lat,
            cached.lng,
            cached.precision ?? "point",
            q.norm,
          );
        }
        stats.cacheHits++;
        stats.resolved++;
        console.log(`✓ ${row.name} (cache: ${cached.lat}, ${cached.lng})`);
      } else {
        stats.knownMisses++;
        console.warn(
          `Skipped - ${row.name} - unable to parse location (known geocode miss)`,
        );
      }
      continue;
    }

    // Cache miss → an API call is required.
    if (
      opts.geocodeLimit !== undefined &&
      stats.apiCalls >= opts.geocodeLimit
    ) {
      stats.budgetHit = true;
      break;
    }

    if (opts.dryRun) {
      // Count as an intended call but do not hit the network.
      stats.apiCalls++;
      continue;
    }

    await sleep(opts.throttleMs);
    let hit: GeocodeHit | null;
    try {
      hit = await geocode(q.display);
    } catch (err) {
      throw err;
    }
    stats.apiCalls++;

    await writeCache(db, q.norm, hit);
    if (hit) {
      await writeRowCoords(db, row.id, hit.lat, hit.lng, hit.precision, q.norm);
      stats.resolved++;
      console.log(`✓ ${row.name} (${hit.lat}, ${hit.lng}, ${hit.precision})`);
    } else {
      stats.unresolved++;
      console.warn(
        `Skipped - ${row.name} - unable to parse location (geocoder found no match)`,
      );
    }
  }

  return stats;
}

/** Forward-resolve missing points, then source-first administrative enrichment. */
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
    params.push(opts.source);
    where += ` AND rs.slug=$${params.length}`;
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
    let point = (
      await db.query("SELECT lat,lng FROM research_pois WHERE id=$1", [
        selected.id,
      ])
    ).rows[0];
    if (point.lat === null || point.lng === null) {
      const forward = await runForwardGeocode(db, {
        ...opts,
        recordId: selected.id,
        limit: 1,
        geocodeLimit: remaining(),
      });
      for (const key of [
        "apiCalls",
        "cacheHits",
        "knownMisses",
        "noQuery",
      ] as const)
        stats[key] += forward[key];
      if (forward.budgetHit) {
        stats.budgetHit = true;
        break;
      }
      point = (
        await db.query("SELECT lat,lng FROM research_pois WHERE id=$1", [
          selected.id,
        ])
      ).rows[0];
      if (point.lat === null || point.lng === null) {
        stats.unresolved++;
        continue;
      }
    }
    if (opts.dryRun) {
      stats.apiCalls++;
      continue;
    }
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
    const queryNorm = `${LOCATION_VERSION}:reverse:${row.lat}:${row.lng}`;
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
        hit = await reverseGeocode(row.lat, row.lng);
        stats.apiCalls++;
        await db.query(
          `INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider,payload) VALUES($1,$2,$3,'point','locationiq',$4::jsonb)
          ON CONFLICT(query_norm) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now()`,
          [queryNorm, row.lat, row.lng, JSON.stringify({ hit })],
        );
      }
    }
    const resolved = resolveLocation(
      source,
      hit && row.coordinate_precision !== "point"
        ? { ...hit, address: null }
        : hit,
    );
    if (!hit && Object.values(source).some((value) => !value))
      resolved.warnings.push("reverse_location_incomplete");
    if (Object.values(resolved.fields).some((value) => !value))
      resolved.warnings.push("location_fields_incomplete");
    const metadata = {
      version: LOCATION_VERSION,
      normalization_id: row.active_normalization_id,
      point: { lat: row.lat, lng: row.lng },
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
      version: LOCATION_VERSION,
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
              row.lat,
              row.lng,
              row.coordinate_precision ?? "point",
              JSON.stringify(metadata),
            ],
          )
        ).rows[0];
        // This artifact certifies enrichment of the original point; it never substitutes a nearby object's point.
        const activated = await client.query(
          `UPDATE research_pois SET country_code=$2,city=$3,region=$4,address=$5,active_geocode_id=$6,
        attributes=COALESCE(attributes,'{}'::jsonb)||jsonb_build_object('location_enrichment',$7::jsonb),
        content_embedding=CASE WHEN city IS DISTINCT FROM $3 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE content_embedding END,
        active_embedding_id=CASE WHEN city IS DISTINCT FROM $3 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE active_embedding_id END
        WHERE id=$1 AND active_normalization_id=$8 AND lat=$9 AND lng=$10`,
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
