---
name: import-pois
description: Import points of interest into the map database from unstructured text, JSON, or KML files. Use when the user provides a list of places to add to the map, mentions importing POIs, or gives a text document with locations to convert.
---

# Import POIs

Convert places into structured data and insert them into the PostgreSQL `pois` table.

## Workflow

1. Parse the user's input (text, file, or document) into POI objects
2. Write a JSON array to `docs/import-data/<descriptive-name>.json`
3. Dry-run: `pnpm db:import:json docs/import-data/<file>.json --dry-run`
4. If valid: `pnpm db:import:json docs/import-data/<file>.json`

## POI JSON Schema

```json
[
  {
    "name": "Place Name",
    "category": "Park",
    "lng": -122.4194,
    "lat": 37.7749,
    "description": "Optional longer description",
    "address": "City, State",
    "website": "https://example.com",
    "hours": "Mon-Fri 9am-5pm",
    "photo_url": "https://example.com/photo.jpg"
  }
]
```

**Required:** `name`, `category`, `lng`, `lat`
**Optional:** `description`, `address`, `website`, `hours`, `photo_url`

### Categories

Pick the best fit: `Park`, `Historic Site`, `Museum`, `Viewpoint`, `Restaurant`, `Shop`, `Cafe`, `Beach`, `Trail`, `Flying Site`

New categories are allowed when none of these fit.

## CLI Options

```bash
pnpm db:import:json <file> [--category "Name"] [--dry-run] [--replace]
```

| Flag | Effect |
|------|--------|
| `--category "Name"` | Default category for items missing one. Use when all items share a category. |
| `--dry-run` | Validate and preview without writing to DB |
| `--replace` | Delete ALL existing POIs first. Only use if explicitly asked. |

If all items share a category, omit `category` from the JSON and pass it via CLI:

```bash
pnpm db:import:json docs/import-data/sites.json --category "Flying Site" --dry-run
```

## Coordinate Rules

- `lng` = longitude, east-west axis, range -180 to 180
- `lat` = latitude, north-south axis, range -90 to 90
- Negative `lng` = Western Hemisphere (Americas)
- Negative `lat` = Southern Hemisphere
- Use 4-6 decimal places
- If not in source text, look up by place name + location context

## Environment

Requires `DB_MAP_URL` environment variable:

```bash
export DB_MAP_URL="postgresql://postgres:postgres@localhost:5432/poi_map"
```

## KML Import (alternative)

For `.kml` files from Google Maps "My Maps":

```bash
pnpm db:import:kml path/to/file.kml --category "Flying Site" --dry-run
```

## Example

User: "Add these coffee shops: Blue Bottle at 66 Mint St SF, Sightglass at 270 7th St SF"

```bash
mkdir -p docs/import-data
```

Write `docs/import-data/sf-cafes.json`:

```json
[
  {
    "name": "Blue Bottle Coffee",
    "lng": -122.4024,
    "lat": 37.7821,
    "address": "66 Mint St, San Francisco, CA"
  },
  {
    "name": "Sightglass Coffee",
    "lng": -122.4078,
    "lat": 37.7775,
    "address": "270 7th St, San Francisco, CA"
  }
]
```

```bash
pnpm db:import:json docs/import-data/sf-cafes.json --category "Cafe" --dry-run
pnpm db:import:json docs/import-data/sf-cafes.json --category "Cafe"
```

## Reference Files

- `lib/db-map/sql/pois.ts` — `NewPoi` type and `insertPois` helper
- `lib/db-map/scripts/import-json.ts` — JSON import script source
- `lib/db-map/scripts/import-kml.ts` — KML import script source
- `lib/db-map/IMPORTING.md` — Full documentation
