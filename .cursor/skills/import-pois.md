# Skill: Import POIs to the Map Database

This skill describes how to convert unstructured text (or any list of places) into structured POI data and save it to the PostgreSQL database.

## When to use this skill

Use this when the user provides:
- A text document listing places, locations, or points of interest
- A request to "add these places to the map" or "import these POIs"
- A file path to unstructured notes about places they want on the map
- Any list of places with names, descriptions, or coordinates

## The POI schema

Each POI must be a JSON object with these fields:

```json
{
  "name": "Place Name",
  "category": "Park",
  "lng": -122.4194,
  "lat": 37.7749,
  "description": "A longer description of the place",
  "address": "123 Main St, City, State",
  "website": "https://example.com",
  "hours": "Mon-Fri 9am-5pm",
  "photo_url": "https://example.com/photo.jpg"
}
```

**Required fields:** `name`, `category`, `lng`, `lat`
**Optional fields:** `description`, `address`, `website`, `hours`, `photo_url`

### Field details

- `name` — The display name shown on the map
- `category` — One of the existing categories: `Park`, `Historic Site`, `Museum`, `Viewpoint`, `Restaurant`, `Shop`, `Cafe`, `Beach`, `Trail`, `Flying Site`. You may also use a new category if none of these fit.
- `lng` — Longitude, a number between -180 and 180 (negative = west)
- `lat` — Latitude, a number between -90 and 90 (negative = south)
- `description` — A paragraph describing the place. Can include practical info.
- `address` — Human-readable address or city/state
- `website` — Full URL including https://
- `hours` — Free-text opening hours
- `photo_url` — URL to an image (must be publicly accessible)

## Step-by-step process

### Step 1: Parse the unstructured text

Read the user's text and extract each place. For each place, determine:
1. The name
2. A suitable category from the list above
3. Coordinates (lat/lng) — if not provided, look them up based on the name and location context
4. Any description, address, website, or hours mentioned

### Step 2: Write a JSON file

Write the array of POI objects to a file in the `docs/import-data/` directory:

```bash
# Create the directory if it doesn't exist
mkdir -p docs/import-data
```

Write the JSON file, e.g. `docs/import-data/my-import.json`:

```json
[
  {
    "name": "Tiger Mountain State Forest",
    "category": "Flying Site",
    "lng": -121.9975,
    "lat": 47.4628,
    "description": "Paragliding and hang gliding launch. West-facing with 1500ft AGL.",
    "address": "Issaquah, WA",
    "website": "https://nwparagliding.com/tiger"
  },
  {
    "name": "Blanchard Mountain",
    "category": "Flying Site",
    "lng": -122.4125,
    "lat": 48.5850,
    "description": "Ridge soaring site. South-facing launch, best in spring/summer.",
    "address": "Burlington, WA"
  }
]
```

**Important:** If all POIs share the same category, you can omit `category` from the JSON objects and specify it via the `--category` CLI flag instead (see Step 3).

### Step 3: Run the import script

Always do a dry-run first to validate:

```bash
# With category in the JSON:
pnpm db:import:json docs/import-data/my-import.json --dry-run

# Or specify category via CLI (applies to items missing a category):
pnpm db:import:json docs/import-data/my-import.json --category "Flying Site" --dry-run
```

Review the dry-run output. Check that:
- The number of valid POIs matches expectations
- No unexpected validation errors
- Categories look correct
- Coordinates are reasonable

If everything looks good, run without `--dry-run`:

```bash
pnpm db:import:json docs/import-data/my-import.json --category "Flying Site"
```

### Options

| Flag | Effect |
|------|--------|
| `--category "Name"` | Sets category for POIs that don't have one in the JSON. Also useful when all items share a category. |
| `--dry-run` | Validate and preview without writing to the database |
| `--replace` | **Dangerous!** Deletes ALL existing POIs before inserting. Only use if explicitly asked. |

## Examples

### Example: User provides a simple text list

User says: "Add these coffee shops to the map: Blue Bottle Coffee at 66 Mint St SF, Sightglass at 270 7th St SF, Ritual Coffee at 1026 Valencia SF"

You would:
1. Look up coordinates for each address
2. Write JSON:

```json
[
  {
    "name": "Blue Bottle Coffee",
    "category": "Cafe",
    "lng": -122.4024,
    "lat": 37.7821,
    "address": "66 Mint St, San Francisco, CA"
  },
  {
    "name": "Sightglass Coffee",
    "category": "Cafe",
    "lng": -122.4078,
    "lat": 37.7775,
    "address": "270 7th St, San Francisco, CA"
  },
  {
    "name": "Ritual Coffee Roasters",
    "category": "Cafe",
    "lng": -122.4212,
    "lat": 37.7566,
    "address": "1026 Valencia St, San Francisco, CA"
  }
]
```

3. Run: `pnpm db:import:json docs/import-data/sf-cafes.json --dry-run`
4. If valid: `pnpm db:import:json docs/import-data/sf-cafes.json`

### Example: User provides a document with mixed categories

User provides a file at `docs/places.txt` with a list of varied places. Parse them, assign the best-fit category to each, write to JSON, and import.

### Example: User says "all these are flying sites"

Use the `--category` flag so you don't need to repeat the category in every JSON object:

```bash
pnpm db:import:json docs/import-data/sites.json --category "Flying Site" --dry-run
```

## Environment requirement

The `DB_MAP_URL` environment variable must be set:

```bash
export DB_MAP_URL="postgresql://postgres:postgres@localhost:5432/poi_map"
```

If it's not set, the script will error with "DB_MAP_URL environment variable not set".

## Coordinate lookup guidance

When coordinates aren't in the source text:
- Use the place name + city/state/country to determine coordinates
- Be precise — use 4-6 decimal places
- Double-check that lng is negative for places in the Western Hemisphere (Americas)
- Double-check that lat is negative for places in the Southern Hemisphere
- Common mistake: swapping lat and lng. Latitude is the north-south axis (-90 to 90), longitude is east-west (-180 to 180).

## Related files

- `lib/db-map/scripts/import-json.ts` — The import script source
- `lib/db-map/scripts/import-kml.ts` — For importing from KML files instead
- `lib/db-map/sql/pois.ts` — The `NewPoi` type definition and `insertPois` helper
- `lib/db-map/IMPORTING.md` — Full documentation of both import methods
