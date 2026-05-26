# docs/

Research notes, POI source files, and staged import data. Not loaded by the app at runtime — used by humans and import scripts.

## Layout

| Path | Purpose |
| --- | --- |
| `pois/{category}/` | Source KML/KMZ files and notes per POI category |
| `import-data/` | JSON arrays ready for `pnpm db:import:json` |
| `search/` | Feature research (e.g. geocoding API options) |

## POI sources (`pois/`)

Organize by category folder (e.g. `pois/flying site/`). Typical contents:

- `.kml` / `.kmz` — original downloads from external sources
- `README.md` — source URLs, licensing notes, import commands used

Import KML into the database:

```bash
pnpm db:import:kml docs/pois/flying\ site/ushpa-sites.kml --category "Flying Site"
```

See `lib/db-map/IMPORTING.md` for flags (`--dry-run`, `--replace`).

## JSON imports (`import-data/`)

Validated `NewPoi[]` files staged before database import. AI agents should write here first, dry-run, then import. Schema matches `lib/db-map/sql/pois.ts` (`name`, `category`, `lng`, `lat`, optional fields).

Workflow documented in `.cursor/skills/import-pois/SKILL.md`.

## Research notes (`search/`)

Exploratory docs for planned features — not implementation specs. Check here before designing search, geocoding, or new data sources.

## Conventions

- Keep raw source files committed; do not duplicate POI data already in PostgreSQL unless it's the canonical import source.
- Use descriptive JSON filenames (`california-hostels.json`, not `data.json`).
- Category strings should match what the map UI expects (consistent casing across imports).
