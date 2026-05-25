---
name: import-pois
description: Import points of interest into the map database from a JSON file. Use when the user provides JSON data with places to add to the map, mentions importing POIs, or gives a JSON array of locations.
---

# Import POIs

Import a JSON array of POI objects into the PostgreSQL `pois` table.

## Workflow

1. Receive JSON data from the user
2. Validate and fix the JSON so it's well-formed
3. Write to `docs/import-data/<descriptive-name>.json`
4. Dry-run: `pnpm db:import:json /workspace/docs/import-data/<file>.json --dry-run`
5. If valid, run the actual import
6. Verify the reconciliation report — confirm all items were inserted

## Step 1: Validate and Fix the JSON

The user's JSON will often have issues. Before writing it to a file, check for and fix:

- **Missing array brackets** — the data must be wrapped in `[ ... ]`
- **Trailing commas** — remove commas after the last item in arrays/objects
- **Unquoted property names** — all keys must be double-quoted
- **Single quotes** — JSON requires double quotes
- **Missing commas** between objects in the array
- **Comments** — JSON doesn't allow `//` or `/* */` comments
- **Invalid numbers** — coordinates must be plain numbers, not strings like `"-122.4"`
- **Swapped lat/lng** — `lat` must be -90 to 90, `lng` must be -180 to 180. If a "lat" value is like -122, it's actually a longitude.

## Step 2: Check Required Fields

Every object in the array needs at minimum:

```json
{
  "name": "Place Name",
  "category": "Hostel",
  "lng": -122.4194,
  "lat": 37.7749
}
```

**Required:** `name` (string), `category` (string), `lng` (number), `lat` (number)
**Optional:** `description` (string), `address` (string), `website` (string), `hours` (string), `photo_url` (string)

If `category` is missing from all items, the `--category` CLI flag can supply it.

### Categories

Known categories: `Park`, `Historic Site`, `Museum`, `Viewpoint`, `Restaurant`, `Shop`, `Cafe`, `Beach`, `Trail`, `Flying Site`, `Hostel`

New categories are allowed when none of these fit.

## Step 3: Write the File and Run

Save the validated JSON to `docs/import-data/` using a descriptive kebab-case filename:

```
docs/import-data/<region-or-topic>-<category>.json
```

Examples: `colorado-hostels.json`, `nyc-cafes.json`, `ushpa-flying-sites.json`

```bash
mkdir -p docs/import-data
```

Then run:

```bash
# Always dry-run first:
pnpm db:import:json /workspace/docs/import-data/<file>.json --category "Hostel" --dry-run

# If dry-run passes, run for real:
pnpm db:import:json /workspace/docs/import-data/<file>.json --category "Hostel"
```

**Important:** Use absolute paths (starting with `/workspace/`). Relative paths resolve from `lib/db-map/`, not the repo root.

## Step 4: Read the Reconciliation Report

The script outputs a reconciliation table like:

```
══════════════════════════════════════
  IMPORT RESULTS
══════════════════════════════════════
  Total in file:        52
  Passed validation:    52
  Failed validation:    0
  Inserted to DB:       52
  Failed DB insert:     0
══════════════════════════════════════

✓ All 52 valid POIs were successfully inserted.
```

**You must check these numbers.** If any items failed:
- Report to the user which items failed and why
- The script lists each failure by index and name
- Common DB failures: duplicate entries, encoding issues, overly long text fields

If `Failed validation` > 0, the script lists each invalid item with specific reasons (missing name, bad coordinates, etc.). Fix the JSON and re-run.

## CLI Options

| Flag | Effect |
|------|--------|
| `--category "Name"` | Default category for items missing one. Useful when all items share a category. |
| `--dry-run` | Validate and preview without writing to DB |
| `--replace` | Delete ALL existing POIs first. Only use if user explicitly asks. |

## KML Import (alternative)

For `.kml` files from Google Maps "My Maps":

```bash
pnpm db:import:kml /workspace/path/to/file.kml --category "Flying Site" --dry-run
```

## Reference Files

- `lib/db-map/sql/pois.ts` — `NewPoi` type and `insertPois` helper
- `lib/db-map/scripts/import-json.ts` — JSON import script source
- `lib/db-map/scripts/import-kml.ts` — KML import script source
- `lib/db-map/IMPORTING.md` — Full documentation
