/**
 * Backfill coordinates on research rows that lack lat/lng but share a Wikidata QID
 * with a sibling row that already has point coordinates.
 *
 * This addresses the OSM relation/way export gap: many OSM rows carry wikidata=Q…
 * tags but no lat/lon in the CSV. Copying from the loaded wikidata research row is
 * free (no geocoder API) and enables strong-id matching.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:backfill:wikidata-coords [--dry-run]
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { extractStrongIds } from "./match/ids.js";

interface CliOptions {
  dryRun: boolean;
}

interface BackfillRow {
  id: string;
  name: string | null;
  source_slug: string;
  qid: string;
  donor_id: string;
  donor_name: string | null;
  donor_lat: number;
  donor_lng: number;
  donor_precision: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  return { dryRun: argv.includes("--dry-run") };
}

async function findBackfillCandidates(db: Pool): Promise<BackfillRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    source_slug: string;
    source_record_id: string;
    attributes: unknown;
    raw: unknown;
  }>(
    `SELECT rp.id, rp.name, rs.slug AS source_slug, rp.source_record_id,
            rp.attributes, rp.raw
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rp.lat IS NULL AND rp.is_poi`,
  );

  const { rows: donors } = await db.query<{
    id: string;
    name: string | null;
    source_record_id: string;
    lat: number;
    lng: number;
    coordinate_precision: string | null;
  }>(
    `SELECT rp.id, rp.name, rp.source_record_id, rp.lat, rp.lng, rp.coordinate_precision
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rs.slug = 'wikidata' AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL`,
  );

  const donorByQid = new Map(
    donors.map((d) => [d.source_record_id.toUpperCase(), d]),
  );

  const candidates: BackfillRow[] = [];
  for (const row of rows) {
    const { wikidata } = extractStrongIds(row);
    for (const qid of wikidata) {
      const donor = donorByQid.get(qid);
      if (!donor) continue;
      candidates.push({
        id: row.id,
        name: row.name,
        source_slug: row.source_slug,
        qid,
        donor_id: donor.id,
        donor_name: donor.name,
        donor_lat: donor.lat,
        donor_lng: donor.lng,
        donor_precision: donor.coordinate_precision,
      });
      break;
    }
  }

  return candidates;
}

async function applyBackfill(db: Pool, row: BackfillRow, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await db.query(
    `UPDATE research_pois SET
       lat = $2,
       lng = $3,
       coordinate_source = 'source',
       coordinate_precision = COALESCE($4, 'point'),
       attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object('coords_from_wikidata', $5::text)
     WHERE id = $1`,
    [row.id, row.donor_lat, row.donor_lng, row.donor_precision, row.qid],
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const candidates = await findBackfillCandidates(db);

  let applied = 0;
  for (const row of candidates) {
    await applyBackfill(db, row, opts.dryRun);
    applied++;
    console.log(
      `✓ ${row.name ?? row.id} (${row.source_slug}) ← wikidata:${row.qid} ` +
        `(${row.donor_lat}, ${row.donor_lng})`,
    );
  }

  await db.end();
  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(`Backfill wikidata coords${mode}: candidates=${candidates.length} applied=${applied}`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
