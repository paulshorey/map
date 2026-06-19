# Implementation Plan: POI Ingestion Pipeline (execution steps)

> **Companion to [`poi-ingestion-pipeline.md`](./poi-ingestion-pipeline.md)** — that document is
> the design/goal; this one is the **ordered, do-this-then-that build plan** grounded in the
> current codebase, the current database, and the two example dumps in `docs/poi/`.
>
> **Decision taken (per product owner):** the current data is experimental, so we **start from
> a fresh database** and **rewrite the baseline migration + contracts**. This is far cleaner
> than `ALTER TABLE`-ing the old single `pois` table into the new shape. Nothing in the current
> DB is preserved.

---

## How to use this document

- Work **top to bottom**. Milestones are dependency-ordered; do not start a milestone until the
  previous one's **Acceptance** checks pass.
- Milestones **M0–M3** are the priority the product owner called out ("set up the database
  schema and architecture first"). After M3 the app runs on the new schema with an empty map.
  M4–M10 build the ingestion pipeline that fills it.
- Each step lists **files to touch**, the **exact commands**, and **acceptance criteria**.
- The overview doc owns the *why*; this doc owns the *how* and the *order*. Where they differ,
  this doc wins for execution details.

### Milestone map

| # | Milestone | Outcome | Priority |
|---|---|---|---|
| M0 | Prerequisites & decisions | Extensions + env + model choices confirmed | **first** |
| M1 | Fresh DB schema (baseline + tooling) | New `research_*` / `canonical_*` schema live | **first** |
| M2 | Code-owned taxonomy seed | Categories + aliases in the DB | **first** |
| M3 | Data-access layer + app read path | App runs on new schema (empty map) | **first** |
| M4 | Ingestion framework + extractors | Raw dumps land in `research_pois` | next |
| M5 | Normalize + categorize | Clean, categorized research rows | next |
| M6 | Geocode | Missing coordinates filled | next |
| M7 | Embed | `content_embedding` populated | next |
| M8 | Match + merge (the core) | `canonical_pois` built & de-duplicated | next |
| M9 | Orchestrate + report + ops | `ingest:run`, metrics, migrate old importers | after |
| M10 | End-to-end validation | Gardens + campgrounds proven on the map | after |

---

## M0 — Prerequisites & decisions

Do these before touching the schema; they determine column types and dependencies.

### M0.1 Confirm PostGIS + pgvector are available

The schema depends on three extensions. Verify the dev database (and later Railway) can create
them.

```bash
psql "$DB_MAP_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;  SELECT postgis_full_version();"
psql "$DB_MAP_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;  SELECT 1;"
psql "$DB_MAP_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;   SELECT 1;"
```

- **If `vector` is missing:** the dev Postgres image lacks pgvector. Switch the local DB to an
  image that bundles it (e.g. `pgvector/pgvector:pg16` or Supabase's image) **before M1**, and
  flag that the Railway Postgres plugin must also provide it. Embeddings (M7) and the
  `content_embedding` column block on this.
- **If `postgis` is missing:** same — use a PostGIS-enabled image. Blocking/distance search
  (M8) depends on it.

> Acceptance: all three `CREATE EXTENSION` statements succeed on `$DB_MAP_URL`.

### M0.2 Choose the embedding model + dimension (locks a column type)

`research_pois.content_embedding` is typed `vector(N)`; **N is fixed at migration time**.
Changing models later = migration + full re-embed (overview §14.9).

- Recommended default: a 384-dim small model (`bge-small-en-v1.5` / `all-MiniLM-L6-v2`) — cheap,
  good enough for name+locality similarity. If using a hosted API (e.g. OpenAI
  `text-embedding-3-small` = 1536), set N accordingly.
- Record the choice in env (below) and in `lib/db-map/scripts/ingest/config.ts` (created in M4).

### M0.3 Choose geocoder + LLM provider

- **Geocoder:** LocationIQ (per `docs/search/location-api.md`; 5k/day free, commercial-OK). Key
  in env. Provider is abstracted so we can swap to self-hosted Nominatim later.
- **LLM (gray-zone adjudication + description fusion):** pick a provider/model; key in env. Used
  only in M8 (matching) and M8 (merge prose) — not required to stand up the schema.

### M0.4 Add environment variables

Append to `.env.example` (the repo uses shell env, not `.env` — these document required vars):

```bash
# ── Ingestion pipeline ───────────────────────────────────────
# Geocoding (forward geocode for records missing coordinates)
GEOCODER_PROVIDER=locationiq
LOCATIONIQ_API_KEY=

# Embeddings (dimension MUST match research_pois.content_embedding vector(N))
EMBEDDINGS_PROVIDER=local        # local | openai | ...
EMBEDDINGS_MODEL=bge-small-en-v1.5
EMBEDDINGS_DIM=384

# LLM for gray-zone match adjudication and multi-source description fusion
LLM_PROVIDER=openai              # openai | anthropic | ...
LLM_MODEL=
LLM_API_KEY=

# Optional matcher tuning overrides (defaults live in code)
INGEST_MATCH_T_HIGH=0.85
INGEST_MATCH_T_LOW=0.55
```

> Acceptance: `.env.example` updated and committed; the actual secrets are set in the shell /
> Cursor Cloud secrets (not committed).

---

## M1 — Fresh database schema (baseline migration + tooling)

This is the foundation. We **replace** the two existing migrations with one new baseline that
defines the full target schema, wipe the DB, and regenerate all artifacts.

### M1.1 Remove the old migrations

Delete (data is disposable, fresh start):

- `lib/db-map/migrations/202605241200__baseline.sql`
- `lib/db-map/migrations/202605250130__pois_unique_coords.sql`

### M1.2 Write the new baseline migration

Create `lib/db-map/migrations/<UTCstamp>__baseline.sql` (generate the stamp with
`pnpm --filter @lib/db-map db:migration:new -- baseline`, then paste the body). Full content:

```sql
-- <stamp>__baseline.sql
-- Fresh baseline for the POI ingestion pipeline.
-- Layers: extensions · auth/app · research_* (raw) · canonical_* (published).
-- migrate.mjs wraps this file in a transaction; do not add BEGIN/COMMIT.

-- ── Extensions ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Auth / app (carried over from the old baseline) ───────────
CREATE TABLE public.users (
  id           text PRIMARY KEY,
  display_name text NOT NULL DEFAULT 'Guest',
  tier         text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','premium')),
  is_guest     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_preferences (
  user_id         text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  basemap_id      text,
  last_center_lng double precision,
  last_center_lat double precision,
  last_zoom       double precision,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.users (id, display_name, tier, is_guest)
VALUES ('guest','Guest','free',true) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_preferences (user_id)
VALUES ('guest') ON CONFLICT (user_id) DO NOTHING;

-- ── research_sources (source registry) ────────────────────────
CREATE TABLE public.research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  homepage      text,
  license       text,
  attribution   text,
  trust         integer NOT NULL DEFAULT 50,
  last_ingested_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── canonical_categories (taxonomy; seeded from code in M2) ────
CREATE TABLE public.canonical_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  display_name text NOT NULL,
  parent_id    uuid REFERENCES public.canonical_categories(id),
  description  text,
  icon         text,
  color        text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canonical_categories_parent_idx ON public.canonical_categories (parent_id);

-- ── canonical_pois (the published, user-facing places) ────────
CREATE TABLE public.canonical_pois (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  photo_url     text,
  address       text,
  website       text,
  hours         text,
  phone         text,
  lng           double precision NOT NULL,
  lat           double precision NOT NULL,
  geom          geography(Point,4326)
                GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  attributes    jsonb NOT NULL DEFAULT '{}',
  field_provenance jsonb NOT NULL DEFAULT '{}',
  popularity    integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft','hidden')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canonical_pois_geom_gix  ON public.canonical_pois USING gist (geom);
CREATE INDEX canonical_pois_name_trgm ON public.canonical_pois USING gin ((lower(name)) gin_trgm_ops);
CREATE INDEX canonical_pois_status_idx ON public.canonical_pois (status);

-- ── research_pois (raw, one row per (source, record)) ─────────
CREATE TABLE public.research_pois (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES public.research_sources(id),
  source_record_id text NOT NULL,
  ingest_category  text,

  name             text,
  name_normalized  text,
  description      text,
  website          text,
  website_domain   text,
  phone            text,
  email            text,
  address          text,
  city             text,
  region           text,
  country_code     text,
  lng              double precision,
  lat              double precision,
  geom             geography(Point,4326)
                   GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,
  geocode_status   text NOT NULL DEFAULT 'unknown'
                   CHECK (geocode_status IN ('unknown','present','geocoded','failed')),

  raw_category     text,
  raw              jsonb NOT NULL,
  attributes       jsonb,

  content_embedding vector(384),     -- N MUST equal EMBEDDINGS_DIM (M0.2)
  content_hash     text,

  canonical_poi_id uuid REFERENCES public.canonical_pois(id) ON DELETE SET NULL,
  match_status     text NOT NULL DEFAULT 'pending'
                   CHECK (match_status IN ('pending','matched','new')),
  match_score      real,
  match_method     text CHECK (match_method IN ('strong_id','auto','llm','override','new')),

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  is_stale         boolean NOT NULL DEFAULT false,

  UNIQUE (source_id, source_record_id)
);
CREATE INDEX research_pois_geom_gix   ON public.research_pois USING gist (geom);
CREATE INDEX research_pois_name_trgm  ON public.research_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX research_pois_canon_idx  ON public.research_pois (canonical_poi_id);
CREATE INDEX research_pois_status_idx ON public.research_pois (match_status);
CREATE INDEX research_pois_geocode_idx ON public.research_pois (geocode_status);
-- NOTE: HNSW index on content_embedding is intentionally omitted — matching blocks by
-- geography first, so cosine is computed only on nearby candidates (overview §4.2).

-- ── canonical_poi_categories (M:N place ↔ category) ───────────
CREATE TABLE public.canonical_poi_categories (
  poi_id      uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.canonical_categories(id) ON DELETE CASCADE,
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (poi_id, category_id)
);
CREATE INDEX canonical_poi_categories_cat_idx ON public.canonical_poi_categories (category_id);

-- ── research_category_aliases (raw string → canonical category) ─
CREATE TABLE public.research_category_aliases (
  alias       text NOT NULL,
  category_id uuid NOT NULL REFERENCES public.canonical_categories(id) ON DELETE CASCADE,
  source_id   uuid REFERENCES public.research_sources(id),
  PRIMARY KEY (alias, category_id, source_id)
);

-- ── research_match_decisions (audit) ──────────────────────────
CREATE TABLE public.research_match_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id      uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  candidate_poi_id uuid REFERENCES public.canonical_pois(id) ON DELETE SET NULL,
  score            real,
  signals          jsonb,
  decision         text NOT NULL CHECK (decision IN ('merge','new')),
  method           text NOT NULL CHECK (method IN ('strong_id','auto','llm','override')),
  llm_reason       text,
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_match_decisions_research_idx ON public.research_match_decisions (research_id);

-- ── research_match_overrides (developer corrections) ──────────
CREATE TABLE public.research_match_overrides (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_a   uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  record_b   uuid REFERENCES public.research_pois(id) ON DELETE CASCADE,
  rule       text NOT NULL CHECK (rule IN ('force_same','force_different')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── research_geocode_cache ────────────────────────────────────
CREATE TABLE public.research_geocode_cache (
  query_norm text PRIMARY KEY,
  lat        double precision,
  lng        double precision,
  precision  text,
  provider   text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
```

> **Generated-column fallback.** If your PostGIS build rejects the `GENERATED ALWAYS AS … STORED`
> geography expression (older versions can), replace each `geom … GENERATED …` line with a plain
> `geom geography(Point,4326)` column and add this trigger after the table:
> ```sql
> CREATE OR REPLACE FUNCTION public.set_geom() RETURNS trigger AS $$
> BEGIN NEW.geom := CASE WHEN NEW.lng IS NULL OR NEW.lat IS NULL THEN NULL
>   ELSE ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat),4326)::geography END; RETURN NEW; END $$ LANGUAGE plpgsql;
> CREATE TRIGGER trg_set_geom BEFORE INSERT OR UPDATE ON public.<table>
>   FOR EACH ROW EXECUTE FUNCTION public.set_geom();
> ```

### M1.3 Fix `generate-types.mjs` so PostGIS tables don't pollute generated types

PostGIS adds `spatial_ref_sys` (table) and `geometry_columns` / `geography_columns` (views) to
`public`. The current typegen query would emit junk row types for them. Edit
`lib/db-map/scripts/generate-types.mjs` — change the columns query `WHERE` clause to:

```sql
WHERE table_schema = 'public'
  AND table_name NOT IN ('schema_migrations_cursor','spatial_ref_sys','geometry_columns','geography_columns')
  AND table_name IN (SELECT table_name FROM information_schema.tables
                     WHERE table_schema='public' AND table_type='BASE TABLE')
```

(The existing `geography`/`vector` → `unknown`/`string` mappings already work; `jsonb` → `unknown`.)

### M1.4 Wipe the database and apply the fresh baseline

```bash
# DESTRUCTIVE — only because all data is experimental:
psql "$DB_MAP_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

cd lib/db-map && pnpm db:sync   # migrate → schema snapshot → typegen → contract JSON
```

`db:sync` runs `db:migrate` (applies the new baseline), `db:schema:snapshot` (writes
`schema/current.sql`), `db:types:generate`, and `app:contract:generate`.

> **pg_dump note:** `schema/current.sql` will now contain `CREATE EXTENSION postgis/…`. That's
> expected; it's a snapshot artifact, never re-executed.

### M1.5 Update `lib/db-map/contracts/map-app.ts` (additive, keeps app working)

Keep the existing shapes and **add** the new optional/feature fields so the read path can grow
without breaking the frontend (which still consumes `category: string`). Edit:

```ts
export interface PoiFeatureProperties {
  id: string;
  name: string;
  category: string | null;   // primary category display name
  photo_url: string | null;
  popularity: number;
}

export interface CategoryOption {
  slug: string;
  label: string;
  parentSlug: string | null;
}

export interface PoiDetailRecord {
  id: string;
  name: string;
  category: string | null;        // primary category display name (drawer chip)
  categories: Array<string>;      // all category display names
  description: string | null;
  address: string | null;
  website: string | null;
  hours: string | null;
  photo_url: string | null;
  attributes: unknown;            // jsonb
  popularity: number;
  sources: Array<string>;         // attribution text/slugs for credits
  lng: number;
  lat: number;
  geometry: unknown;
}

// PoiCategoriesResponse stays { categories: Array<string> } for now (display names) so the
// frontend needs no change in M3. A future step can switch to Array<CategoryOption>.
```

Then re-run `pnpm --filter @lib/db-map app:contract:generate` and commit
`generated/contracts/map-app.json`.

> **Acceptance (M1):**
> - `pnpm db:verify` passes; `schema/current.sql`, `generated/typescript/db-types.ts`,
>   `generated/contracts/*` regenerated and contain `CanonicalPoisRow`, `ResearchPoisRow`, etc.
> - `psql "$DB_MAP_URL" -c "\dt public.*"` lists all 9 new tables + `users` + `user_preferences`.
> - Generated types contain **no** `SpatialRefSysRow` / `GeographyColumnsRow`.
> - All M1 files committed (deleted old migrations, new baseline, regenerated artifacts).

---

## M2 — Code-owned taxonomy seed

Categories/aliases live in source (overview Decision 5) and are seeded into the DB.

### M2.1 Author the taxonomy seed

Create `lib/db-map/scripts/ingest/taxonomy.ts` exporting a typed structure:

```ts
export interface CategorySeed { slug: string; display_name: string; parent?: string;
  sort_order?: number; aliases?: string[]; }
export const TAXONOMY: CategorySeed[] = [
  // gardens
  { slug: 'gardens', display_name: 'Gardens', sort_order: 10 },
  { slug: 'botanical_garden', display_name: 'Botanical Garden', parent: 'gardens',
    aliases: ['botanical garden','garden:type=botanical','jardin botanique'] },
  { slug: 'arboretum', display_name: 'Arboretum', parent: 'gardens',
    aliases: ['arboretum','arboreta'] },
  // campgrounds
  { slug: 'campground', display_name: 'Campground', sort_order: 20 },
  { slug: 'rv', display_name: 'RV Park', parent: 'campground',
    aliases: ['rv','caravan','caravan_site','tourism=caravan_site','motorhome','rv_hookup'] },
  { slug: 'tent', display_name: 'Tent Camping', parent: 'campground',
    aliases: ['tent','tent_only'] },
  // flying (already in the app)
  { slug: 'free_flight', display_name: 'Free Flight', sort_order: 30,
    aliases: ['flying site','paragliding','hang gliding','gliderport'] },
];
```

### M2.2 Seed script + npm script

- Create `lib/db-map/scripts/ingest/seed-taxonomy.ts` — upserts `canonical_categories`
  (by `slug`, resolving `parent` to `parent_id` in a second pass) and `research_category_aliases`
  (alias → category, `source_id = NULL`). Idempotent.
- Add to `lib/db-map/package.json` scripts: `"ingest:taxonomy:seed": "tsx scripts/ingest/seed-taxonomy.ts"`.
- Run: `pnpm --filter @lib/db-map ingest:taxonomy:seed`.

> **Acceptance (M2):** `SELECT slug, display_name, parent_id FROM canonical_categories` shows the
> tree; `SELECT count(*) FROM research_category_aliases` > 0; re-running the seed makes no
> duplicates.

---

## M3 — Data-access layer + app read path (app runs on the new schema)

Goal: the app boots, the map renders (empty), the category switcher lists the seeded categories,
and a POI detail would render if one existed. **No frontend file changes needed** because we keep
`/api/pois/categories` returning `string[]` of display names and the `category` filter as a
display-name string.

### M3.1 Rewrite `lib/db-map/sql/pois.ts` read functions

Point all reads at `canonical_pois` and the category join. Keep function names/signatures stable.

- **`listPoisGeoJson`** — `FROM canonical_pois p`, `WHERE status='published'`, keep bbox/world
  logic, but resolve the optional category filter via display name expanded to descendants:
  ```sql
  -- category filter (param = display name): match POIs in that category OR any descendant
  AND ($cat::text IS NULL OR EXISTS (
    SELECT 1 FROM canonical_poi_categories pc
    JOIN canonical_categories c ON c.id = pc.category_id
    WHERE pc.poi_id = p.id AND c.id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM canonical_categories WHERE display_name = $cat
        UNION ALL SELECT cc.id FROM canonical_categories cc JOIN sub ON cc.parent_id = sub.id
      ) SELECT id FROM sub)
  ))
  ```
  Feature `properties` gain `popularity` and a **primary** category display name via a lateral
  subquery (the `is_primary` row, else any):
  ```sql
  'category', (SELECT c.display_name FROM canonical_poi_categories pc
               JOIN canonical_categories c ON c.id = pc.category_id
               WHERE pc.poi_id = p.id ORDER BY pc.is_primary DESC, c.sort_order LIMIT 1)
  ```
- **`getPoiById`** — return the canonical row plus `categories` (array of display names),
  primary `category`, `attributes`, `popularity`, and `sources` (distinct
  `research_sources.attribution`/`slug` via `research_pois` join on `canonical_poi_id`). Keep
  `geometry`, `lng`, `lat`.
- **`listPoiCategories`** — `SELECT display_name FROM canonical_categories WHERE is_active ORDER BY
  sort_order, display_name`. Returns `string[]` (unchanged shape).
- **`insertPois` / `NewPoi`** — remove the direct-to-canonical insert (the `ON CONFLICT (lng,lat)`
  upsert no longer applies — that column/constraint is gone). It is replaced by the staging
  writer in M4/M9. Keep a thin deprecated export only if needed to avoid breaking imports; the
  import scripts move to staging in M9.

### M3.2 Update `index.ts` exports

Export any new sql modules (e.g. `sql/categories.ts` if you split category queries out). Ensure
`getPoiById`, `listPoisGeoJson`, `listPoiCategories` still exported. Add new generated row types
(`CanonicalPoisRow`, `ResearchPoisRow`, `CanonicalCategoriesRow`, …) to the type re-exports.

### M3.3 API routes

- `/api/pois`, `/api/pois/[id]`, `/api/pois/categories` — **no signature change**; they already
  call the helpers above. Confirm they compile against the new return shapes.
- Contract check runs in the app build (`contracts:check`) — keep `map-app.ts` in sync.

### M3.4 Verify the app

```bash
pnpm dev        # port 3000
```

- Map loads (empty — no canonical POIs yet).
- Category switcher lists seeded display names ("Botanical Garden", "RV Park", …).
- `curl "http://localhost:3000/api/pois?bbox=-180,-90,180,90&zoom=2"` → empty FeatureCollection.
- `curl "http://localhost:3000/api/pois/categories"` → the seeded display names.

> **Acceptance (M3):** `pnpm verify` passes (db contracts + app typecheck/build); dev server
> renders the map and category list with zero console errors; APIs return valid (empty) data.
> **Manual GUI test required** here (UI change to the data source) — capture a screenshot of the
> running app on the new schema.

---

## M4 — Ingestion framework + extractors (raw → `research_pois`)

Now fill the research layer. New code area: `lib/db-map/scripts/ingest/`.

### M4.1 Shared scaffolding

- `ingest/config.ts` — reads env (embedding dim/model, geocoder, LLM, thresholds).
- `ingest/types.ts` — `RawRecord` (the normalized staging shape) and `Extractor` interface:
  ```ts
  export interface RawRecord {
    source_record_id: string; name?: string; description?: string;
    website?: string; phone?: string; email?: string; address?: string;
    city?: string; region?: string; country_code?: string;
    lat?: number; lng?: number; raw_category?: string;
    attributes?: Record<string, unknown>; raw: unknown;
  }
  export interface Extractor { slug: string; parse(file: string): AsyncIterable<RawRecord>; }
  ```
- `ingest/sources.ts` — registry mapping `slug → { meta, extractor }` and a `research_sources`
  upsert/seed (slug, name, homepage, license, attribution, trust). Seed the example sources:
  `osm`, `bgci`, `wikidata`, `wikipedia_us`, `wikipedia_intl`, `arbnet`, `iabg`, `gardenology`,
  `ridb`, `thedyrt`, `osm_camp`, `uscampgrounds`.
- `ingest/io.ts` — **streaming** parsers: `csv-parse` (stream) for CSV, a JSONL line reader for
  `.jsonl`, and a streaming JSON-array reader for large `.json` (e.g. `stream-json`). Never load
  a 78 MB file fully into memory (overview §10).

> Add deps: `pnpm --filter @lib/db-map add csv-parse stream-json` (and the chosen embedding/LLM/
> http clients in later milestones).

### M4.2 `ingest:extract` CLI

Create `ingest/extract.ts` + script `"ingest:extract": "tsx scripts/ingest/extract.ts"`.
Behavior:

- Args: `<source-slug> <file> [--limit N] [--dry-run]`.
- Resolve `source_id` from `research_sources` (create from registry meta if missing).
- Stream records; for each, compute a **stable `source_record_id`** — use the source's own id
  when present (osm_id, wikidata_id, bgci_id, dyrt id); **synthesize deterministically** when the
  source has none (Wikipedia/Gardenology): `sha1(slug + '|' + normName + '|' + city)` (overview
  §14.2).
- Compute `content_hash` over the normalizable fields; **upsert** on
  `(source_id, source_record_id)`: insert new, update changed + bump `last_seen_at`, set
  `is_stale=false`. After the run, mark rows of this source not seen in this file `is_stale=true`.
- Batch inserts (~500) for throughput; keep `raw` (full original record) verbatim.

### M4.3 Per-source extractors

One file per source in `ingest/extractors/`, each implementing `Extractor.parse`. Start with the
gardens set (smaller), then campgrounds:

- `bgci.ts` (JSON, richest — coords, website, area, accreditation), `wikidata.ts` (string
  lat/lng, QID → keep as strong id), `osm.ts` (CSV; `wikidata`/`wikipedia` cross-refs →
  strong ids; map `garden:type`/`tourism` tags to `raw_category`), `arbnet.ts` (name+URL only →
  no coords, will geocode), `wikipedia_us.ts` / `wikipedia_intl.ts` / `gardenology.ts` /
  `iabg.ts` (city-level, synth ids).
- Campgrounds: `ridb.ts` (**facilities → one record each**; carry hookup attrs; do not emit a
  record per campsite — see M5.4), `thedyrt.ts` (CSV; hookup booleans → `attributes`),
  `osm_camp.ts` (caravan sites), `uscampgrounds.ts` (amenity codes → `attributes`).

Map raw fields → `RawRecord`; stash source-specific extras (hookups, area_ha, QID, osm id) in
`attributes` and keep everything in `raw`.

> **Acceptance (M4):**
> - `pnpm --filter @lib/db-map ingest:extract bgci /workspace/docs/poi/botanical_gardens_data/bgci_gardens_full.json --limit 50 --dry-run` prints a sane preview.
> - A real run populates `research_pois` (`SELECT source_id, count(*) FROM research_pois GROUP BY 1`).
> - Re-running the **same** file inserts 0 new rows (idempotent; `last_seen_at` bumped).
> - Unit tests: feed each extractor a small fixture, assert the produced `RawRecord`s.

---

## M5 — Normalize + categorize

`ingest/normalize.ts` + `"ingest:normalize"`. Operates on `research_pois` in a resumable loop
(rows whose `content_hash` changed since last normalize, or `name_normalized IS NULL`).

- **Names** → `name_normalized` (lowercase, strip diacritics, drop stopwords, expand
  abbreviations, strip legal suffixes).
- **Coordinates** → parse strings to numbers, detect/fix swapped lat/lng (reuse the heuristic in
  `.cursor/skills/import-pois/SKILL.md`), range-check; if present set `geocode_status='present'`.
  (`geom` updates automatically via the generated column.)
- **website_domain** (eTLD+1) and **phone** (E.164) normalized for matching signals.
- **Address** → city/region/country_code where parseable.
- **Category mapping** → look up `raw_category` (and source-specific tag) in
  `research_category_aliases`; on no match, do **not** guess — emit to the **unmapped-category
  report** so the developer extends `taxonomy.ts` (M2) and re-seeds.
- **Attribute normalization** → map source attribute keys to a **canonical per-category attribute
  vocabulary** defined in `taxonomy.ts`/code (e.g. `electric_hookups|Electricity Hookup|E` →
  `has_electric`), so `attributes` merges are consistent later (overview §14.4).

> **Acceptance (M5):** after running, `research_pois` rows have `name_normalized`, parsed
> coords/`geocode_status`, and a resolved category alias where one exists; `ingest:normalize
> --report-unmapped` lists any raw categories still needing an alias.

---

## M6 — Geocode the gaps

`ingest/geocode.ts` + `"ingest:geocode"`. Resumable loop over `research_pois` where
`geocode_status IN ('unknown')` and coords are null but an address/name exists.

- Build `query_norm` = normalized `"name, city, region, country"`; check `research_geocode_cache`
  first; only call LocationIQ on a miss; write the result (lat/lng, `precision`, `provider`) back
  to the cache and the row; set `geocode_status='geocoded'` or `'failed'`.
- Respect rate limits (throttle; `--limit N`). Low-`precision` (city/region centroid) results are
  flagged so M8 can down-weight them (overview §14.6).

> **Acceptance (M6):** coordinate-less rows (e.g. ArbNet) get coordinates or `geocode_status=
> 'failed'`; a second run makes **zero** new API calls (cache hits).

---

## M7 — Embed

`ingest/embed.ts` + `"ingest:embed"`. Resumable loop over rows whose `content_hash` changed since
last embed (or `content_embedding IS NULL`).

- Compose the embed text: `name_normalized + ' ' + city + ' ' + region + ' ' + <canonical
  category>`; call the configured embedder; write `content_embedding` (dimension must equal the
  column's `vector(N)`).
- Batch requests; skip unchanged rows (cost control, overview §5 Stage 4).

> **Acceptance (M7):** `SELECT count(*) FROM research_pois WHERE content_embedding IS NOT NULL`
> matches the number of normalized rows; a no-op re-run embeds nothing.

---

## M8 — Match + merge (the de-duplication core)

`ingest/match/` + `"ingest:match"`. This is the heart; build it as the **resumable, one-record-
at-a-time** loop from overview §5 (Stage 5+6) and §6. Process `research_pois` where
`match_status='pending'`, one row per transaction.

### M8.1 Per-record algorithm (overview §6)

1. **Overrides** (`research_match_overrides`) win absolutely.
2. **Definitive-ID** match (Wikidata QID / OSM `(type,id)` from `attributes`/`raw`) → merge,
   `method='strong_id'`. **Do not** use website/phone as definitive (chain/portal denylist —
   overview §6 Step B).
3. **Spatial block**: `ST_DWithin(canonical_pois.geom, $geom, $radius)` ordered by `<->`, radius
   per-category (campsites ~150 m, gardens ~400–600 m). Requires a non-null geom (geocoded rows
   only).
4. **Score** candidates: `pg_trgm`/Jaro-Winkler name sim + embedding cosine + distance decay +
   city/region + website/phone signal (denylist-guarded).
5. **Decide**: `≥ T_high` auto-merge; `≤ T_low` new; gray zone → **LLM binary** (merge/new,
   `llm_reason` stored). Record everything in `research_match_decisions`.
6. **Attach/create** the `canonical_pois` row, set `research_pois.canonical_poi_id` + status,
   then **rebuild that one canonical** from all its `research_pois` (field precedence by source
   `trust`; verbatim description for single-source, LLM fusion when multiple disagree;
   union `attributes`; union categories into `canonical_poi_categories`; recompute
   `popularity = COUNT(DISTINCT source_id)`; write `field_provenance`).
7. **Transitivity**: union-find across pairwise matches.

### M8.2 Supporting pieces

- `ingest/match/denylist.ts` — known multi-location domains/phones (`koa.com`, `recreation.gov`,
  `nps.gov`, `facebook.com`, …).
- `ingest/match/llm.ts` — the binary adjudicator (structured yes/no + reason).
- `ingest/merge.ts` — field-precedence resolver + conditional description fuser.
- `ingest:override <a> <b> same|different` CLI → writes `research_match_overrides`.
- **Golden-set harness** (`ingest/match/golden.ts` + a small labeled fixture of known
  same/different pairs, e.g. Kew across BGCI/OSM/Wikidata) reporting precision/recall — the
  primary quality gate since there's no human review (overview §6, §14.6).
- **Orphan GC + periodic full re-cluster** hooks (overview §14.1, §14.5): a `--recluster` mode
  and a sweep that hides `canonical_pois` with zero linked research rows.
- **Single-writer**: run matching as one process (advisory lock) to avoid duplicate-canonical
  races (overview §14.8).

> **Acceptance (M8):**
> - Running match on the extracted+normalized+geocoded+embedded gardens produces
>   `canonical_pois` with sensible `popularity` (Kew links several sources; obscure ones = 1).
> - `field_provenance` is populated and points at real sources.
> - Golden-set harness prints precision/recall; obvious duplicates collapse; obvious non-dupes
>   stay separate.
> - Re-running match is idempotent (no new canonicals, popularity stable).

---

## M9 — Orchestrate, report & migrate old tooling

- `ingest/run.ts` + `"ingest:run <source> <file>"` — chains extract → normalize → geocode →
  embed → match, with `--dry-run`, `--limit`, `--resume`, `--no-geocode`, `--no-llm`. One
  invocation = one **category × source** chunk (overview Decision 2).
- `ingest:report` — reconciliation stats (in, new vs updated, matched, new canonicals, LLM count,
  geocode failures, unmapped categories, popularity distribution).
- `ingest_runs` metrics table (optional, overview §14/§11.10) — one row per run for observability.
- **Migrate legacy importers**: repoint `db:import:json` / `db:import:kml` to write into
  `research_pois` (require a `--source <slug>` flag) instead of the old `pois` table; update
  `.cursor/skills/import-pois/SKILL.md`, `lib/db-map/IMPORTING.md`, and `docs/AGENTS.md` to the
  staging-first flow. Delete the obsolete `scripts/seed.ts` (or convert it to seed `research_pois`
  under a `manual` source).

> **Acceptance (M9):** `pnpm --filter @lib/db-map ingest:run bgci <file> --limit 200` runs the
> whole chain and prints a reconciliation report; legacy import commands no longer touch
> `canonical_pois` directly.

---

## M10 — End-to-end validation (the two example dumps)

1. Ingest a coherent chunk per category × source, e.g.:
   ```bash
   # Gardens
   pnpm --filter @lib/db-map ingest:run bgci      docs/poi/botanical_gardens_data/bgci_gardens_full.json
   pnpm --filter @lib/db-map ingest:run wikidata  docs/poi/botanical_gardens_data/wikidata_botanical_gardens.json
   pnpm --filter @lib/db-map ingest:run osm       docs/poi/botanical_gardens_data/osm_botanical_gardens.csv
   # Campgrounds (chunked; large)
   pnpm --filter @lib/db-map ingest:run ridb      docs/poi/rv_campgrounds_data/ridb/facilities.csv --limit 2000
   ```
2. Verify in SQL: duplicate gardens collapsed; popularity reflects source count; campgrounds
   carry hookup `attributes`; `field_provenance` populated.
3. **Manual GUI test:** `pnpm dev`, pan to a dense region, confirm clustered POIs render, the
   category filter (Botanical Garden / RV Park) works, and the detail drawer shows merged data.
   Capture a screenshot + short screen recording for the walkthrough.

> **Acceptance (M10):** the map shows de-duplicated, categorized, attributed POIs from multiple
> sources; re-running any chunk changes nothing (idempotent).

---

## Cross-cutting execution gotchas (read before starting)

- **Extensions first or everything fails** — `postgis`/`vector` must exist before the baseline
  applies (M0.1). On Railway, confirm the Postgres plugin/image provides both.
- **Embedding dimension is load-bearing** — `vector(N)` in the baseline must equal
  `EMBEDDINGS_DIM`. Decide in M0.2; changing later is a migration + full re-embed.
- **Generated `geom`** — if PostGIS rejects the generated column, use the trigger fallback in
  M1.2; do not leave `geom` unpopulated (blocking depends on it).
- **Typegen noise** — apply the M1.3 filter or `db:sync` will emit junk PostGIS row types and the
  contract check may churn.
- **Streaming, always** — the campground CSV/JSON files are tens to hundreds of MB; never
  `JSON.parse`/`readFileSync` them whole (M4.1).
- **Idempotency is the contract** — `(source_id, source_record_id)` uniqueness + recomputed
  popularity mean every stage is safe to re-run; preserve this in every extractor (synthesize
  stable ids where the source lacks them).
- **Commit generated artifacts with each schema change** — after any migration: `cd lib/db-map &&
  pnpm db:sync` and commit `schema/`, `generated/` (per root `AGENTS.md`).
- **Keep the read contract additive** — M3 deliberately avoids frontend changes; only revisit the
  category-slug API (`CategoryOption`) as a separate, later enhancement once the pipeline is
  proven.

---

## Suggested commit/PR sequence

Each milestone is its own PR-sized unit, in order: M0+M1 (schema + tooling, the big one) → M2
(taxonomy) → M3 (read path, includes a UI screenshot) → M4 → M5 → M6 → M7 → M8 → M9 → M10. Do
**not** bundle the schema rewrite with the ingestion code; land the foundation first and verify
the app runs on it before building the pipeline on top.
