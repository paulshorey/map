# Importing POI Data

This guide covers two workflows for adding points of interest to the database.

## Data Schema

Every POI must conform to the `NewPoi` interface (defined in `lib/db-map/sql/pois.ts`):

```typescript
interface NewPoi {
  name: string;            // required - display name
  category: string;        // required - e.g. "Park", "Flying Site", "Restaurant"
  lng: number;             // required - longitude (-180 to 180)
  lat: number;             // required - latitude (-90 to 90)
  description?: string;    // optional - longer text about the place
  address?: string;        // optional - human-readable address
  website?: string;        // optional - URL
  hours?: string;          // optional - opening hours as free text
  photo_url?: string;      // optional - URL to a photo
}
```

The database auto-generates `id` (UUID) and `created_at` (timestamp) on insert.

---

## Method 1: Import from KML

Use this when you have a `.kml` file exported from Google Maps "My Maps", Google Earth, or any other geo tool.

### Command

```bash
# From the repo root:
pnpm db:import:kml path/to/file.kml --category "Flying Site"

# Or from the lib/db-map directory:
pnpm db:import:kml ../../docs/poi-usa/ushpa-sites.kml --category "Flying Site"
```

### Options

| Flag | Description |
|------|-------------|
| `--category <name>` | Override category for all POIs (default: uses KML folder name) |
| `--replace` | Delete all existing POIs before importing |
| `--dry-run` | Parse and preview without writing to the database |

### How it works

1. Parses KML XML using `fast-xml-parser`
2. Finds all `<Placemark>` elements with `<Point>` coordinates
3. Extracts name, description, coordinates, and any ExtendedData fields
4. Maps ExtendedData fields like "Chapter Website" → `website`, "Location City"/"Location State" → `address`
5. Inserts valid POIs in batches of 500

### Example

```bash
# Preview what will be imported:
pnpm db:import:kml docs/poi-usa/ushpa-sites.kml --category "Flying Site" --dry-run

# Import, appending to existing data:
pnpm db:import:kml docs/poi-usa/ushpa-sites.kml --category "Flying Site"

# Import, replacing all existing POIs:
pnpm db:import:kml docs/poi-usa/ushpa-sites.kml --category "Flying Site" --replace
```

---

## Method 2: Import from JSON (AI Agent Workflow)

Use this when you have unstructured text (notes, lists, web scrapes) and want an AI agent to convert it to structured data.

### The JSON format

The file must be a JSON array of `NewPoi` objects:

```json
[
  {
    "name": "Tiger Mountain State Forest",
    "category": "Flying Site",
    "lng": -121.9975,
    "lat": 47.4628,
    "description": "Paragliding and hang gliding launch. West-facing. 1500ft AGL. Requires USHPA H3+ rating.",
    "address": "Issaquah, WA",
    "website": "https://nwparagliding.com/tiger",
    "hours": "Sunrise to sunset"
  },
  {
    "name": "Blanchard Mountain",
    "category": "Flying Site",
    "lng": -122.4125,
    "lat": 48.5850,
    "description": "Ridge soaring site. South-facing launch. Best in spring/summer thermals.",
    "address": "Burlington, WA"
  }
]
```

### Command

```bash
# Validate and import:
pnpm db:import:json path/to/pois.json

# Specify category for all items (items can omit "category" in the JSON):
pnpm db:import:json path/to/pois.json --category "Flying Site"

# Preview only (no database write):
pnpm db:import:json path/to/pois.json --dry-run

# Replace all existing data:
pnpm db:import:json path/to/pois.json --replace
```

### How to use with an AI coding agent

The best workflow is:

1. **Provide the unstructured text** to the AI agent (paste it or point to a file)
2. **Ask the agent to output a JSON file** matching the schema above
3. **Run the import script** on the resulting file

Here's a prompt template you can give an AI agent:

---

> Read the document at `docs/my-notes.txt`. It contains a list of places with descriptions.
>
> Convert each place into a JSON object matching this exact TypeScript schema:
>
> ```typescript
> interface NewPoi {
>   name: string;        // required
>   category: string;    // required (pick the best fit from: Park, Historic Site, Museum, Viewpoint, Restaurant, Shop, Cafe, Beach, Trail, Flying Site)
>   lng: number;         // required, longitude
>   lat: number;         // required, latitude
>   description?: string;
>   address?: string;
>   website?: string;
>   hours?: string;
>   photo_url?: string;
> }
> ```
>
> If coordinates aren't in the text, look them up based on the place name and address.
>
> Write the full array to `docs/import-data/my-import.json`.
>
> Then run: `pnpm db:import:json docs/import-data/my-import.json --dry-run`
>
> If all items share the same category, you can omit `category` from the JSON and use the flag instead:
> `pnpm db:import:json docs/import-data/my-import.json --category "Flying Site" --dry-run`
>
> If the dry-run looks correct, run without `--dry-run` to save to the database.

---

### Tips for the AI agent workflow

- **Category consistency**: Give the agent a list of existing categories to choose from so your data stays filterable. Current categories in use: `Park`, `Historic Site`, `Museum`, `Viewpoint`, `Restaurant`, `Shop`, `Cafe`, `Beach`, `Trail`.
- **Coordinates**: If your source text doesn't include lat/lng, the AI can look them up by place name. Tell it to be precise (6 decimal places).
- **Validation**: The import script validates every entry. If coordinates are missing or names are empty, those entries are skipped with a clear error message. Always use `--dry-run` first.
- **Incremental imports**: By default, new POIs are *appended* (no `--replace`). You can safely import multiple batches without losing existing data.
- **Deduplication**: The import scripts do not deduplicate by name. If you import the same file twice, you'll get duplicate entries. Use `--replace` if you need a clean slate.

---

## Programmatic usage

Both scripts use the shared `insertPois` function, which you can also call directly from any TypeScript/Node.js code:

```typescript
import { getDb, insertPois } from "@lib/db-map";
import type { NewPoi } from "@lib/db-map";

const pois: NewPoi[] = [
  { name: "My Place", category: "Park", lng: -122.4, lat: 37.8, description: "A nice park" },
];

const count = await insertPois(getDb(), pois);
console.log(`Inserted ${count} POIs`);
```

---

## Environment setup

Both import scripts require the `DB_MAP_URL` environment variable:

```bash
export DB_MAP_URL="postgresql://postgres:postgres@localhost:5432/poi_map"
```

Make sure migrations have been applied first: `pnpm db:migrate`
