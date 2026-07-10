# Handoff: Multi-Category POI Ingest

## Summary

The database always supported multiple categories per canonical POI via `canonical_poi_categories` (M:N with `is_primary`) and `research_pois.category_slugs` (`text[]`). The ingest pipeline previously forced a single category per file/row. This change lets developers tag every record in a source file with **one primary plus zero or more secondary categories** by repeating `--category` on the CLI.

Category assignment remains **developer-controlled only** — never inferred from file path, folder name, or raw record fields.

## CLI usage

At least one `--category` is required. Repeat the flag for additional categories. The **first flag is primary**; later flags are secondary.

```bash
# Art fair + craft fair
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/artfairslist.json \
  --category art_fair --category craft_fair

# Three event subtypes
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/festivalnet.json \
  --category art_fair --category craft_fair --category renaissance_fair

# Launch site shared across disciplines
pnpm --filter @lib/db-map ingest:run \
  docs/poi/flying_site_data/some_sites.json \
  --category free_flight --category hang_gliding --category paragliding
```

The same semantics apply to `ingest:extract`:

```bash
pnpm --filter @lib/db-map ingest:extract thedyrt docs/poi/.../rv_campgrounds.csv \
  --category campground --category rv
```

Duplicate slugs are deduplicated while preserving order. Resume commands stored in `research_ingest_runs.resume_command` emit all `--category` flags.

## Data flow

```text
--category art_fair --category craft_fair
        │
        ▼
ingest_category = 'art_fair'          (scalar primary, backward compat)
ingest_categories = ['art_fair','craft_fair']
        │
        ▼ normalize (resolveCategorySlugs)
category_slugs = ['art_fair','craft_fair']
        │
        ▼ match (candidate overlap via ANY(slugs))
        ▼ merge.syncCategories (union from linked research rows)
canonical_poi_categories: two rows, one is_primary
canonical_pois.primary_category_id → art_fair
```

## What changed

### Taxonomy ([`lib/db-map/scripts/ingest/taxonomy.ts`](../../lib/db-map/scripts/ingest/taxonomy.ts))

New niche slugs under existing parents:

| Parent | New children |
| --- | --- |
| `art_fair` | `fine_art`, `craft_fair`, `renaissance_fair` |
| `free_flight` | `hang_gliding`, `paragliding`, `sailplane` |

Added helpers:

- `isTemporalCategory(slug)` — walks parent chain for event categories
- `normalizationProfileForCategory(slug)` — now taxonomy-driven (temporal → event, campground/gardens families → dedicated profiles)

After editing taxonomy: `pnpm --filter @lib/db-map ingest:taxonomy:seed`

### Schema ([`lib/db-map/migrations/202607100300__multi_category_ingest.sql`](../../lib/db-map/migrations/202607100300__multi_category_ingest.sql))

| Table | New column | Purpose |
| --- | --- | --- |
| `research_pois` | `ingest_categories text[]` | Full developer-declared set per row |
| `research_source_files` | `category_slugs text[]` | Full set for the registered file |
| `research_ingest_runs` | `category_slugs text[]` | Full set for the run |

Existing scalar columns kept for backward-compatible reads:

- `research_pois.ingest_category` — primary (first CLI flag)
- `research_source_files.category_slug` — primary
- `research_ingest_runs.category_slug` — primary

Existing rows backfilled: `ARRAY[scalar_column]`.

GIN index on `research_pois.ingest_categories`.

### CLI ([`run.ts`](../../lib/db-map/scripts/ingest/run.ts), [`extract.ts`](../../lib/db-map/scripts/ingest/extract.ts))

- `OrchestratorOptions.categories: string[]` (was single `category`)
- `--category` accumulates; validates each slug; dedupes in order
- `resolveSourceFile(file, categories)` — primary = `categories[0]`

### Extract / orchestrator ([`orchestrator.ts`](../../lib/db-map/scripts/ingest/orchestrator.ts), [`extract.ts`](../../lib/db-map/scripts/ingest/extract.ts))

- Writes both `ingest_category` (primary) and `ingest_categories` (full set)
- Idempotency: unchanged detection compares **full category array**, not just primary — adding/removing a secondary category triggers re-normalization
- Run and source-file metadata store `category_slugs` array plus scalar primary

### Normalize ([`normalize/category.ts`](../../lib/db-map/scripts/ingest/normalize/category.ts), [`normalize/resolve.ts`](../../lib/db-map/scripts/ingest/normalize/resolve.ts), [`normalize/runner.ts`](../../lib/db-map/scripts/ingest/normalize/runner.ts))

- `resolveCategorySlugs()` validates the full declared set against seeded `canonical_categories`
- `category_slugs` on activation = full ingest set (not `[ingestCategory]` only)
- LLM packet `allowed_category_slugs` = full declared set (still developer-supplied, not LLM-invented)
- Normalization **profile** selection uses **primary only** (`ingest_category` / first slug)

### Unchanged (already multi-category-ready)

- **Match** — candidate blocking uses `ANY(category_slugs)` overlap
- **Merge** — `syncCategories()` unions slugs from all linked research rows into `canonical_poi_categories`
- **Map API** — detail already returns `categories: string[]`; filter matches any linked category

## Map behavior

- **Filter**: POI appears when any of its linked categories (or descendants) match the selected filter
- **Primary display**: marker color and detail drawer `category` use the primary (`is_primary` / `primary_category_id`)
- **Secondary categories**: stored in DB and returned on detail API as `categories[]`; drawer UI still shows primary only (future work)

## Documentation updated

- [`AGENTS.md`](../../AGENTS.md)
- [`README.md`](../../README.md)
- [`docs/poi-ingestion.md`](../../docs/poi-ingestion.md)
- [`docs/AGENTS.md`](../../docs/AGENTS.md)
- [`lib/db-map/README.md`](../../lib/db-map/README.md)
- [`lib/db-map/AGENTS.md`](../../lib/db-map/AGENTS.md)
- [`docs/poi-research/capture-spec.md`](../../docs/poi-research/capture-spec.md)

## Out of scope (not implemented)

- Per-record category inference from raw fields or LLM
- Auto-expanding parent taxonomy (e.g. `campground` does not implicitly add `rv`)
- Map UI rendering of all secondary categories in the drawer

## Verification

```bash
# Dry-run with multiple categories
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/artfairslist.json \
  --category art_fair --category craft_fair --dry-run

# Typecheck
cd lib/db-map && pnpm check-types
```

After a real import, confirm in the report:

```bash
pnpm --filter @lib/db-map ingest:report --category craft_fair
```

Check `research_pois.ingest_categories` and `category_slugs` contain the full set; after match/merge, `canonical_poi_categories` should have one row per slug with a single `is_primary = true`.
