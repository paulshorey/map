# POI Ingestion and Conflation

This guide explains how raw source files become de-duplicated POIs on the map. It is the
durable reference for the implemented pipeline.

## Model

The database has two POI layers:

- `research_*`: raw and normalized source records. These rows are internal and kept for
  provenance, re-ingestion, debugging, and match audit history.
- `canonical_*`: merged, user-facing POIs served by the map app.

The important tables are:

| Table | Purpose |
| --- | --- |
| `research_sources` | Source registry, trust, licensing/attribution metadata. |
| `research_pois` | One row per source record. Pipeline progress is nullable derived fields. |
| `research_geocode_cache` | Forward-geocode cache and remembered misses. |
| `research_match_decisions` | Audit trail for match decisions. |
| `research_match_overrides` | Manual force-same / force-different corrections. |
| `canonical_pois` | One user-facing merged POI. |
| `canonical_categories` | Code-owned taxonomy. |
| `canonical_poi_categories` | Many-to-many POI/category links. |
| `canonical_poi_occurrences` | Event editions for recurring temporal POIs. |
| `geo_centroids` | Local centroid references used by normalization and coordinate checks. |

The schema intentionally avoids PostGIS and pgvector. Coordinates are plain `lng`/`lat`
doubles, embeddings are stored as `real[]`, and fuzzy name matching uses `pg_trgm`.

## Operating Principles

- Ingest one source and one category at a time.
- Keep source records forever; rebuild canonicals from linked research rows.
- Use the category taxonomy from code, not source-provided category strings.
- Prefer deterministic signals first: strong IDs, category, location, names, stored
  embeddings, dates, and source trust.
- Use the LLM only for bounded ambiguous decisions and description fusion.
- Keep scripts resumable. Normal reruns should continue missing work instead of redoing
  completed rows.
- Use `--recluster` only when intentionally starting over from raw research rows.

## Standard Pipeline

Run from the repo root.

```bash
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter @lib/db-map ingest:extract <source-slug> <file> --category <category-slug>
pnpm --filter @lib/db-map ingest:normalize [--source <source-slug>]
pnpm --filter @lib/db-map ingest:geocode [--source <source-slug>] [--geocode-limit 4500]
pnpm --filter @lib/db-map ingest:embed [--source <source-slug>]
pnpm --filter @lib/db-map ingest:match --consolidate
```

Useful supporting commands:

```bash
pnpm --filter @lib/db-map ingest:seed:centroids
pnpm --filter @lib/db-map ingest:backfill:wikidata-coords
pnpm --filter @lib/db-map ingest:reflow
pnpm --filter @lib/db-map ingest:match:golden --no-llm
```

## Stage Details

### Taxonomy

`ingest:taxonomy:seed` syncs code-owned categories into `canonical_categories`.

Source imports must specify one canonical category with `--category <slug>`. Unknown slugs
are hard errors; add new categories in code first, then seed them.

### Extract

`ingest:extract` reads a source file and upserts raw rows into `research_pois` by
`(source_id, source_record_id)`.

```bash
pnpm --filter @lib/db-map ingest:extract bgci docs/poi/botanical_gardens_data/bgci.csv --category gardens
```

Extract stores a content hash. Re-importing unchanged records updates observation metadata
without resetting downstream work. Changed records have derived columns reset so they can
flow through normalize/geocode/embed/match again.

### Normalize

`ingest:normalize` derives clean names, category slugs, source metadata, date fields, and
embedded URL coordinates when available.

```bash
pnpm --filter @lib/db-map ingest:normalize --source bgci
```

Use `--no-llm` when you want deterministic normalization only.

### Geocode

`ingest:geocode` only selects POI rows where `lat IS NULL`. Rows that already carry source
coordinates do not spend geocoder budget.

```bash
pnpm --filter @lib/db-map ingest:geocode --source bgci --geocode-limit 4500
```

Geocode results and misses are cached by normalized query in `research_geocode_cache`. When
the daily budget is hit, rerun the same command later; remaining rows still have `lat IS NULL`.

### Embed

`ingest:embed` selects normalized POI rows missing `content_embedding`.

```bash
pnpm --filter @lib/db-map ingest:embed --source bgci --batch-size 32
```

Embeddings are a scoring signal, not a hard prerequisite for matching.

### Match

`ingest:match` links matchable `research_pois` rows into `canonical_pois`.

Matchable rows have:

- `canonical_poi_id IS NULL`
- `is_poi = true`
- coordinates
- `name_normalized`
- `category_slugs`

Normal matching is resumable:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate
```

Progress is the `research_pois.canonical_poi_id` value. Completed rows are skipped on the
next run. The script prints linked/pending counts, not-ready counts, existing decision
counts, and a suggested resume command at startup.

For smaller work chunks:

```bash
pnpm --filter @lib/db-map ingest:match --limit 500
```

First `Ctrl-C` stops after the current row or consolidation group and prints a resume
command. A second `Ctrl-C` exits immediately.

## Match and Merge Rules

The matcher uses a cascade:

1. Manual overrides from `research_match_overrides`.
2. Strong IDs, such as Wikidata QIDs and OSM identifiers.
3. Aggressive proximity rules for same-category nearby features.
4. Candidate scoring from name, stored embedding similarity, distance, locality, contact
   fields, coordinate precision, and date compatibility.
5. LLM adjudication for ambiguous gray-zone pairs when LLM is enabled.

Each non-dry-run decision writes `research_match_decisions`.

When a row links to a canonical, `rebuildCanonicalPoi` recomputes the published canonical
from all linked research rows. This keeps canonical output deterministic and prevents
description text from being appended repeatedly across reruns.

## Aggressive Conflation

The implemented product stance is to prefer over-grouping for close same-category features,
especially botanical gardens and similar grounds where source data often maps sub-features
as separate POIs.

Important concepts:

- **Anchor**: a stronger canonical, such as one with multiple sources, high source trust, or
  an official website.
- **Satellite**: a weaker nearby feature, often one source and no website.
- **Satellite + anchor**: same-category satellites inside the proximity box merge into the
  anchor.
- **Satellite + satellite**: nearby satellite groups consolidate around a deterministic
  leader/medoid.
- **Anchor + anchor**: proximity alone is not enough; LLM decides when enabled.
- **Same-name block**: distinctive exact-name matches can merge even when coordinates differ
  enough that ordinary spatial blocking would miss them.

Coordinate election prefers corroborated point coordinates over a single high-trust outlier.
Canonical descriptions are rebuilt from source rows and may include contained feature
sections plus `attributes.contained_features`.

## Consolidation

Row matching is order-dependent: a satellite may be ingested before its anchor, or an earlier
run may have been executed with `--no-llm`. Consolidation is the canonical-vs-canonical
cleanup sweep that heals those cases.

Run it after matching:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate
```

Run only consolidation without processing pending research rows:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate-only
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run
```

## Full Recluster

`--recluster` is destructive. It deletes match decisions, nulls every linked
`research_pois.canonical_poi_id`, deletes canonicals, and rebuilds from raw research rows.

Use it only when intentionally starting over after matcher changes:

```bash
pnpm --filter @lib/db-map ingest:match --recluster --consolidate
```

Do not use `--recluster` to resume a stopped run.

## Event POIs

Permanent POIs have no dates. Temporal categories, such as music festivals, use typed date
columns:

- `starts_at`
- `ends_at`
- `date_precision`
- generated `event_range`
- `canonical_poi_occurrences` for recurring editions

The canonical row stores the representative occurrence: next upcoming when available,
otherwise the most recent. Status such as upcoming, ongoing, or past is derived at read time.

## Reflow and Backfills

Use `ingest:reflow` after changing normalization, embedding, geocoding, or matching rules
that should apply to existing research rows. It resets derived columns so rows flow through
the updated pipeline again.

Use `ingest:backfill:wikidata-coords` to fill coordinates from Wikidata attributes where
available without spending geocoder budget.

## Troubleshooting

Check match progress:

```bash
pnpm --filter @lib/db-map ingest:match --dry-run --limit 0 --no-llm
```

Preview consolidation:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run
```

Run deterministic match previews:

```bash
pnpm --filter @lib/db-map ingest:match --dry-run --limit 20 --no-llm
```

Run golden checks:

```bash
pnpm --filter @lib/db-map ingest:match:golden --no-llm
```

If a run is slow, first check the startup banner for pending rows and decision counts. Match
does not geocode or create embeddings; those are earlier stages. LLM calls occur only for
gray-zone match adjudication and canonical description fusion when enabled.
