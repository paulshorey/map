/**
 * Developer override writer for M8 matching.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:override <record-a> <record-b> same|different [--note "..."]
 *   pnpm --filter @lib/db-map ingest:override <record-a> new different [--note "..."]
 *
 * Record refs can be research_pois UUIDs or source-qualified ids: source_slug:source_record_id.
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";

interface CliOptions {
  recordA: string;
  recordB: string | null;
  rule: "force_same" | "force_different";
  note: string | null;
}

interface ResearchRef {
  id: string;
  source_slug: string;
  source_record_id: string;
  name: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): never {
  throw new Error(
    "Usage: ingest:override <record-a> <record-b|new> same|different [--note \"...\"]",
  );
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 3) usage();
  const [recordA, recordBRaw, relation, ...rest] = argv;
  if (!recordA || !recordBRaw || (relation !== "same" && relation !== "different")) usage();

  let note: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--note" && rest[i + 1]) {
      note = rest[++i]!;
    } else {
      usage();
    }
  }

  const recordB =
    relation === "different" && ["new", "none", "all"].includes(recordBRaw.toLowerCase())
      ? null
      : recordBRaw;
  if (relation === "same" && recordB === null) {
    throw new Error("A force-same override requires two concrete research records.");
  }

  return {
    recordA,
    recordB,
    rule: relation === "same" ? "force_same" : "force_different",
    note,
  };
}

async function resolveRef(db: Pool, ref: string): Promise<ResearchRef> {
  if (UUID_RE.test(ref)) {
    const { rows } = await db.query<ResearchRef>(
      `SELECT rp.id, rs.slug AS source_slug, rp.source_record_id, rp.name
       FROM research_pois rp
       JOIN research_sources rs ON rs.id = rp.source_id
       WHERE rp.id = $1`,
      [ref],
    );
    if (rows[0]) return rows[0];
    throw new Error(`No research_pois row found for UUID: ${ref}`);
  }

  const splitAt = ref.indexOf(":");
  if (splitAt <= 0 || splitAt === ref.length - 1) {
    throw new Error(`Invalid record ref "${ref}". Use a UUID or source_slug:source_record_id.`);
  }
  const sourceSlug = ref.slice(0, splitAt);
  const sourceRecordId = ref.slice(splitAt + 1);
  const { rows } = await db.query<ResearchRef>(
    `SELECT rp.id, rs.slug AS source_slug, rp.source_record_id, rp.name
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rs.slug = $1 AND rp.source_record_id = $2`,
    [sourceSlug, sourceRecordId],
  );
  if (rows[0]) return rows[0];
  throw new Error(`No research_pois row found for ref: ${ref}`);
}

function describeRef(row: ResearchRef): string {
  return `${row.name ?? row.id} (${row.source_slug}:${row.source_record_id})`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  try {
    const a = await resolveRef(db, opts.recordA);
    const b = opts.recordB ? await resolveRef(db, opts.recordB) : null;
    if (b && a.id === b.id) throw new Error("Override records must be different rows.");

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO research_match_overrides (record_a, record_b, rule, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [a.id, b?.id ?? null, opts.rule, opts.note],
    );

    console.log(
      `Override ${rows[0]!.id}: ${opts.rule} ${describeRef(a)}` +
        `${b ? ` <-> ${describeRef(b)}` : " from all current candidates"}`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Override failed:", err);
  process.exit(1);
});
