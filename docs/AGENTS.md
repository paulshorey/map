# docs/

Research notes, POI source files, ingestion references, and staged import data. Not loaded by the app at runtime — used by humans and import scripts.

## Layout

| Path                           | Purpose                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `poi-ingestion.md`             | Deep-dive guide for the implemented staged POI ingestion pipeline.                                                     |
| `poi/{category}/`              | Source files and notes per POI category.                                                                               |
| `import-data/`                 | Legacy JSON arrays ready for direct `pnpm db:import:json`.                                                             |
| `poi-research/`                | Research notes for sources and categories.                                                                             |
| `poi-research/capture-spec.md` | Required reading before mining new sources: raw data capture format that the generic extractor ingests with zero code. |

## Documentation ownership

[Root AGENTS.md](../AGENTS.md) defines agent execution budgets and the development/debugging
workflow. The [root README](../README.md#poi-ingestion) contains human full-run instructions.
The [ingestion runbook](poi-ingestion.md) owns shared pipeline behavior, bounded diagnostics,
category completeness, and troubleshooting. Read it before changing or running ingestion;
update it when behavior changes instead of duplicating recipes here or in source notes.

## POI sources (`poi/`)

Organize by category folder. Typical contents:

- `.kml` / `.kmz` / `.json` / `.csv` — original downloads from external sources
- `README.md` — source URLs, licensing notes, import commands used

When saving newly mined data, follow `poi-research/capture-spec.md`: flat records in a
top-level JSON array/JSONL/CSV with stable ids, verbatim fields, and `website` kept
separate from the listing `source_url`. Conformant files import through the generic
extractor with no code changes.

## Legacy direct imports

Direct `db:import:kml` and `db:import:json` write curated data straight to canonical tables.
Use them only for small fixtures or legacy curated imports, not bulk source ingestion.

## JSON imports (`import-data/`)

Validated `NewPoi[]` files staged before database import. AI agents should write here first, dry-run, then import. Schema matches `lib/db-map/sql/pois.ts` (`name`, `category`, `lng`, `lat`, optional fields).

## Research notes

Exploratory docs for source discovery and future data sources. Keep implementation guidance
in `docs/poi-ingestion.md` or package READMEs instead of plan files.

## Conventions

- Keep raw source files committed; do not duplicate POI data already in PostgreSQL unless it is the canonical import source.
- Use descriptive JSON filenames (`california-hostels.json`, not `data.json`).
- Category slugs for staged ingestion must exist in the code-owned taxonomy.
