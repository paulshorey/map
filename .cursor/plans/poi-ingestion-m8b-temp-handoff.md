# Temporary Handoff: POI Ingestion M8b

Created: 2026-07-04

This is a continuation note for finishing M8b after the remote database/schema reset and partial real-data validation. Use the remote database from `DB_MAP_URL`; do not print the connection string.

## What Was Done

- Switched work to the remote Postgres database in `DB_MAP_URL`.
- Wiped/rebuilt the remote `public` schema as a greenfield database.
- Consolidated migrations back to one baseline migration:
  - Kept `lib/db-map/migrations/202606300400__baseline.sql`.
  - Deleted `lib/db-map/migrations/202607040900__strict_categories_coordinate_precision.sql`.
  - Baseline now includes `coordinate_source`, `coordinate_precision`, `geocode_query_norm`.
  - Baseline no longer creates `research_category_aliases`.
- Ran `pnpm --filter @lib/db-map db:sync`.
- Seeded taxonomy: `pnpm --filter @lib/db-map ingest:taxonomy:seed`.
- Verified generated contracts/types with `pnpm --filter @lib/db-map check-types` at that point.
- Implemented M8b scripts and package commands:
  - `lib/db-map/scripts/ingest/match.ts`
  - `lib/db-map/scripts/ingest/merge.ts`
  - `lib/db-map/scripts/ingest/override.ts`
  - `lib/db-map/scripts/ingest/match/*`
  - `lib/db-map/package.json` scripts for `ingest:match`, `ingest:match:golden`, `ingest:override`.
- Fixed a real extract idempotency bug in `lib/db-map/scripts/ingest/extract.ts`:
  - `UPDATE_CHANGED_SQL` placeholders now align correctly.
  - Unchanged row touch uses `WHERE id = $1::uuid`.
- Added extraction retry/reconnect support for transient remote Postgres disconnects:
  - `lib/db-map/lib/db/postgres.ts` exports `closeDb()`.
  - `lib/db-map/scripts/ingest/extract.ts` retries a record upsert up to 3 times after transient connection errors.
- Updated docs/plans:
  - `.cursor/plans/poi-ingestion-implementation.md`
  - `.cursor/plans/poi-ingestion-pipeline.md`
  - `lib/db-map/AGENTS.md`
- Updated golden-set behavior:
  - `lib/db-map/scripts/ingest/match/golden.ts` now allows multiple candidate refs for a pair.
  - Garden same-pairs try OSM first, then BGCI, because some OSM relation/way rows have no point coordinates.

## Remote DB State When Paused

Verified directly against `DB_MAP_URL`:

- Applied migrations: only `202606300400__baseline.sql`.
- `research_category_aliases` does not exist.
- Counts:
  - `osm`: 3,421 rows, 3,421 normalized, 827 with coordinates.
  - `wikidata`: 2,802 rows, 2,802 normalized, 2,464 with coordinates.
  - `bgci`: 2,603 rows, 0 normalized, 2,579 with coordinates.
- BGCI source file has 3,649 JSON rows, so BGCI extract is incomplete.
- The active BGCI extract was stopped intentionally with Ctrl-C to pause work. No long-running shell session should remain.

## Why BGCI Is Incomplete

The first full BGCI extract was interrupted manually after 2,603 inserted rows. A silent rerun then hit `Connection terminated unexpectedly` before reaching new rows. After adding retry/reconnect logic, another silent rerun was started, but it was also stopped manually because the user asked for a handoff. The next agent should rerun the same extract command; it is idempotent and will replay existing rows as `unchanged` before inserting the remaining rows.

## Current Git Status

Expected changed/untracked files:

- Modified:
  - `.cursor/plans/poi-ingestion-implementation.md`
  - `.cursor/plans/poi-ingestion-pipeline.md`
  - `lib/db-map/AGENTS.md`
  - `lib/db-map/lib/db/postgres.ts`
  - `lib/db-map/migrations/202606300400__baseline.sql`
  - `lib/db-map/package.json`
  - `lib/db-map/scripts/ingest/extract.ts`
- Deleted:
  - `lib/db-map/migrations/202607040900__strict_categories_coordinate_precision.sql`
- Untracked:
  - `lib/db-map/scripts/ingest/match.ts`
  - `lib/db-map/scripts/ingest/match/`
  - `lib/db-map/scripts/ingest/merge.ts`
  - `lib/db-map/scripts/ingest/override.ts`
  - `.cursor/plans/poi-ingestion-m8b-temp-handoff.md`

## Finish Steps For Next Agent

1. Confirm environment and no stale process:

```bash
cd /Users/pshorey/git/map
test -n "$DB_MAP_URL"
```

2. Complete BGCI extract. Redirect output; the script logs every row.

```bash
pnpm --filter @lib/db-map ingest:extract bgci \
  /Users/pshorey/git/map/docs/poi/botanical_gardens_data/bgci_gardens_full.json \
  --category botanical_garden > /tmp/bgci-extract.log 2>&1
```

Expected final summary should be around `seen=3649`, with a mix of `unchanged` and remaining `inserted`. If a remote disconnect happens, the new retry logic should reconnect. If it still fails, inspect `/tmp/bgci-extract.log`, rerun the same command, and keep going; the import is keyed by `(source_id, source_record_id)`.

3. Normalize BGCI:

```bash
pnpm --filter @lib/db-map ingest:normalize --source bgci --no-llm > /tmp/bgci-normalize.log 2>&1
```

4. Validate counts:

```bash
cd /Users/pshorey/git/map/lib/db-map
node --input-type=module <<'NODE'
import { Client } from 'pg';
const client = new Client({ connectionString: process.env.DB_MAP_URL });
await client.connect();
console.table((await client.query(`
select rs.slug,
       count(*)::int as total,
       count(*) filter (where rp.name_normalized is not null and rp.category_slugs is not null)::int as normalized,
       count(*) filter (where rp.lat is not null and rp.lng is not null)::int as with_coords
from research_pois rp
join research_sources rs on rs.id=rp.source_id
group by rs.slug
order by rs.slug
`)).rows);
await client.end();
NODE
```

Expected after BGCI completion: `bgci.total = 3649`, `bgci.normalized = 3649` unless some rows are intentionally skipped by normalize.

5. Run type/contract validation:

```bash
cd /Users/pshorey/git/map
pnpm --filter @lib/db-map check-types
```

6. Run golden-set evaluator:

```bash
pnpm --filter @lib/db-map ingest:match:golden
```

Garden pairs should evaluate now. Festival pairs may still skip unless festival fixture rows are loaded; that is acceptable unless the M8b acceptance criteria are expanded to require loading festival source fixtures now.

7. Run matcher smoke checks on the remote DB:

```bash
pnpm --filter @lib/db-map ingest:match --dry-run --no-llm --limit 10
pnpm --filter @lib/db-map ingest:match --dry-run --no-llm --source wikidata --limit 10
```

If dry runs are clean, run a small real match batch:

```bash
pnpm --filter @lib/db-map ingest:match --no-llm --limit 25
```

Then inspect Kew/New York/Missouri canonicals and `research_match_decisions`.

8. Optional but recommended before finalizing M8b:

```bash
pnpm --filter @lib/db-map ingest:match --gc-orphans
pnpm --filter @lib/db-map ingest:match:golden
git status --short
```

## Important Notes

- Do not restore `research_category_aliases`; categories are canonical-only by product decision.
- The database is greenfield; destructive DB resets are allowed by the user, but should not be necessary from here.
- The OSM garden export contains many relation/way rows without `lat/lng`; that is why golden fixtures can fall back to BGCI.
- The extractor retry patch was added because the remote DB can terminate long-running connections. Keep it unless a better shared retry strategy is added.
- If `ingest:match:golden` fails one of the BGCI fallback garden pairs, first inspect score reasons and coordinates before changing thresholds. The matcher should keep the coarse-coordinate guard intact.
