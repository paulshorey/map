# Implementation Plan: POI Ingestion Pipeline (execution steps)

> **Companion to [`poi-ingestion-pipeline.md`](./poi-ingestion-pipeline.md)** — that document is
> the design/goal; this one is the **ordered, do-this-then-that build plan** grounded in the
> current codebase, the current database, and the example dumps in `docs/poi/` (gardens,
> campgrounds, and now music festivals — whose `GAP_ANALYSIS.md` + PR #12 review drove the
> data-quality rules in overview §15).
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
| M10 | End-to-end validation | Gardens + campgrounds + festivals proven on the map | after |

---

## Ingestion is incremental and budgeted (one source at a time)

**You never ingest everything at once.** The pipeline is built around the overview's Decision 2:
the unit of work is **one source × one category**, and you can go smaller still within a source
via `--limit`. After ingesting a *single* source you already have a usable, viewable map; each
additional source (run on a later day) merges into and enriches what's already there. A
comfortable cadence is therefore "one source per day → review → adjust → repeat."

What this means concretely:

- **Pick a category, then ingest its sources one by one.** Gardens, say: day 1 BGCI, day 2
  Wikidata, day 3 OSM, … Each `ingest:run <source> <file>` is independent and idempotent — you do
  **not** need all sources loaded for the plan to work.
- **A single source is fully useful on its own.** Its records become `canonical_pois` (each new
  place = popularity 1). When you add the next source, matching merges duplicates into the
  existing canonicals and bumps popularity — nothing already done is repeated.
- **The same command works for every source — no flags to remember.** Geocoding is **automatic
  and conditional**: a record is sent to the API **only if `lat IS NULL`**. Records that already
  carry coordinates (BGCI ~93%, Wikidata, OSM, RIDB, The Dyrt) are never selected, so they cost
  **zero** LocationIQ calls — automatically. (Existing coordinates are assumed correct; we don't
  re-fetch them. There is **no `--no-geocode` flag** to maintain — see "What we deliberately do
  NOT track" below.)
- **Geocoding is the only metered resource** (LocationIQ free tier = **5,000 lookups/day**);
  extract / normalize / embed / match run locally with no per-day cap. The geocode step is capped
  by `--geocode-limit N`, which **defaults to ~4,500** (safely under 5k) so even the cap is
  optional. When the cap is hit, the step simply **stops** — nothing partial is written; rows it
  didn't reach still have `lat IS NULL` and are picked up by the next run.

### How re-runs skip already-done work (the hash you asked about)

Re-running the *same* data must not redo anything or spend budget twice. The state that drives
this is **implicit** — there are no status columns to maintain (see the next subsection):

1. **Per-record content hash (primary skip).** At extract, each record gets a `content_hash` over
   its normalizable fields, stored on its `research_pois` row (keyed by
   `(source_id, source_record_id)`). On any later run, a record whose hash is unchanged is
   **skipped at every stage** — no re-normalize, no re-embed, no re-geocode, no re-match. Only
   **new or changed** records do work. (A changed hash resets the row's derived columns to NULL so
   it re-flows the stages.) This is exactly your "hash the input and ignore unchanged objects" idea.
2. **Resume the over-budget tail via plain NULL-ness.** "Still needs geocoding" is just
   `lat IS NULL`. The cap stops the step; un-reached rows stay `lat IS NULL`; the next run
   continues with them. A huge coordinate-less source is geocoded across as many days as it takes
   by re-running the **same command** — it never restarts, and we store nothing extra to know
   "where we were."
3. **Geocode query cache (dedupe + remembered misses).** `research_geocode_cache` stores results
   keyed by the normalized query string — including **misses** (NULL coords = "tried, didn't
   resolve"). So identical queries across records resolve to one API call, cache hits don't count
   against the budget, and a permanently-unresolvable address is never retried (it just stays
   coordinate-less and is never mapped). This is the *only* place a "we tried" fact lives — at the
   query level, not per record.

### What we deliberately do NOT track (kept simple on purpose)

- **No `geocode_status` column.** "Needs geocoding" = `lat IS NULL`; "done" = it has coordinates.
  Failed/unresolvable addresses are remembered once in the query cache (#3 above), not as
  per-record state. When the daily budget is hit the script **stops** rather than writing an
  "incomplete" marker.
- **No `match_status` / `match_score` / `match_method` columns on `research_pois`.** "Needs
  matching" = `canonical_poi_id IS NULL`; once matched it points at its canonical POI. The score,
  method, and LLM reason for each decision live only in the `research_match_decisions` audit table.
- **No `is_stale` column.** We only add/update data; detecting places *removed* from a source is
  deferred (see M-notes). This avoids diffing an entire source on every run.

**Recommended low-cost, test-as-you-go loop — one command per source, re-runnable:**

```bash
# Same command for EVERY source. Geocoding fires automatically only for records with lat IS NULL,
# capped at the default daily budget (~4,500). Re-run any time: unchanged records are skipped via
# their content hash; the geocode tail resumes because un-reached rows still have lat IS NULL.
pnpm --filter @lib/db-map ingest:run bgci \
  docs/poi/botanical_gardens_data/bgci_gardens_full.json
#   → BGCI rows have coords, so this spends 0 geocode calls. Review the map, adjust, repeat.

pnpm --filter @lib/db-map ingest:run arbnet \
  docs/poi/botanical_gardens_data/arbnet_morton_register.json
#   → ArbNet lacks coords. If it has >~4,500 records, the first run resolves ~4,500 and stops;
#     run the SAME command tomorrow to resolve the next ~4,500. Done rows have coordinates and are
#     skipped; nothing restarts. Override the cap with --geocode-limit N.
```

If you prefer, run the stages separately — `ingest:extract` everything now, then
`ingest:geocode` (auto-capped) and `ingest:match` in daily slices.

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

  -- processing state is the NULL-ness of derived columns (no status columns):
  name             text,
  name_normalized  text,              -- NULL ⇒ needs normalize
  description      text,
  website          text,             -- the place's OFFICIAL site (never a directory/listing page)
  website_domain   text,
  source_url       text,             -- the listing/detail page on the SOURCE (provenance, ≠ website)
  phone            text,
  email            text,
  address          text,
  city             text,
  region           text,
  country_code     text,
  lng              double precision,  -- NULL ⇒ needs geocode
  lat              double precision,
  geom             geography(Point,4326)
                   GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,

  raw_category     text,
  raw              jsonb NOT NULL,
  attributes       jsonb,

  content_embedding vector(384),      -- N MUST equal EMBEDDINGS_DIM (M0.2). NULL ⇒ needs embed
  content_hash     text,              -- version of the input; change ⇒ reset derived cols to NULL

  canonical_poi_id uuid REFERENCES public.canonical_pois(id) ON DELETE SET NULL, -- NULL ⇒ needs match

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, source_record_id)
);
CREATE INDEX research_pois_geom_gix   ON public.research_pois USING gist (geom);
CREATE INDEX research_pois_name_trgm  ON public.research_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX research_pois_canon_idx  ON public.research_pois (canonical_poi_id);
-- "needs work" = a derived column IS NULL; partial indexes keep those resumable scans cheap:
CREATE INDEX research_pois_todo_normalize ON public.research_pois (id) WHERE name_normalized   IS NULL;
CREATE INDEX research_pois_todo_geocode   ON public.research_pois (id) WHERE lat               IS NULL;
CREATE INDEX research_pois_todo_embed     ON public.research_pois (id) WHERE content_embedding IS NULL;
CREATE INDEX research_pois_todo_match     ON public.research_pois (id) WHERE canonical_poi_id  IS NULL;
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

-- ── research_geocode_cache (dedupe identical queries; remember misses) ─
CREATE TABLE public.research_geocode_cache (
  query_norm text PRIMARY KEY,       -- normalized "name, city, region, country"
  lat        double precision,       -- NULL ⇒ remembered miss (query did not resolve)
  lng        double precision,
  precision  text,                   -- 'rooftop' | 'city' | 'region' | 'none'
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
- **Event status is derived here, never stored (overview §15.4).** For event POIs (festivals),
  compute `upcoming`/`active`/`past` at read time from `attributes.start_date`/`end_date` vs.
  `now()` — there is no stored `active` flag to go stale. (A future map filter like "upcoming this
  season" is a `WHERE` on those dates, evaluated per request.)
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
    website?: string;          // OFFICIAL site only — leave undefined if the source has only a listing URL
    source_url?: string;       // the source's own listing/detail page (provenance, ≠ website)
    phone?: string; email?: string; address?: string;
    city?: string; region?: string; country_code?: string;
    lat?: number; lng?: number; raw_category?: string;
    attributes?: Record<string, unknown>; // event POIs put start_date/end_date here
    raw: unknown;
  }
  export interface Extractor {
    slug: string;
    parse(file: string): AsyncIterable<RawRecord>;
    // Optional per-source inclusion predicate — return false to keep a row in research_pois
    // for provenance but NEVER promote it (e.g. EDM rows with is_festival=false; blog posts).
    isPoi?(raw: unknown): boolean;
  }
  ```
- `ingest/sources.ts` — registry mapping `slug → { meta, extractor }` and a `research_sources`
  upsert/seed (slug, name, homepage, license, attribution, trust). Seed the example sources:
  gardens (`bgci`, `wikidata`, `osm`, `arbnet`, `iabg`, `gardenology`, `wikipedia_us`,
  `wikipedia_intl`), campgrounds (`ridb`, `thedyrt`, `osm_camp`, `uscampgrounds`), and the ~35
  music-festival sources (`musicbrainz`, `ticketmaster`, `resident_advisor`, `musicfestivalwizard`,
  `edm_dance_directory`, `jambase`, … — see `docs/poi/music-festivals/GAP_ANALYSIS.md`). The
  festivals dump is the proving ground for per-source `isPoi` predicates and `source_url`/`website`
  separation (M5, overview §15).
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
  `(source_id, source_record_id)`:
  - **New row** → insert (all derived columns start NULL, so it flows through every stage).
  - **Existing row, unchanged hash** → touch `last_seen_at` only; **do nothing else** (it's already done).
  - **Existing row, changed hash** → update the source fields and **reset the derived columns to
    NULL** (`name_normalized`, `lng`/`lat`, `content_embedding`, `canonical_poi_id`) so the record
    re-flows the stages with its new content.
- Batch inserts (~500) for throughput; keep `raw` (full original record) verbatim.
- *(No deletion detection: we do not mark rows missing from a re-pull. Add/update only — see the
  "What we deliberately do NOT track" note above.)*

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
- Festivals (events): one extractor per source. These are where the overview §15 rules bite —
  e.g. `edm_dance_directory.ts` sets `isPoi = raw.is_festival === true` (only 55/9,901 are real
  festivals); `musicbrainz.ts` flattens nested `relations[]` for location/`website` and must
  **not** map `life_span.ended` to a status; MFW/Resident Advisor/FestivalAtlas put their listing
  URL in `source_url`, never `website`; date fields go to `attributes.start_date`/`end_date`
  (rejecting publish-timestamps like Festivalando's). Keep coordinates if a source has them; most
  don't and rely on Stage 3 geocoding by city/venue/country.

Map raw fields → `RawRecord`; stash source-specific extras (hookups, area_ha, QID, osm id,
start/end dates) in `attributes` and keep everything in `raw`.

> **Acceptance (M4):**
> - `pnpm --filter @lib/db-map ingest:extract bgci /workspace/docs/poi/botanical_gardens_data/bgci_gardens_full.json --limit 50 --dry-run` prints a sane preview.
> - A real run populates `research_pois` (`SELECT source_id, count(*) FROM research_pois GROUP BY 1`).
> - Re-running the **same** file inserts 0 new rows (idempotent; `last_seen_at` bumped).
> - Unit tests: feed each extractor a small fixture, assert the produced `RawRecord`s.

---

## M5 — Normalize + categorize

`ingest/normalize.ts` + `"ingest:normalize"`. Resumable loop over `research_pois` where
`name_normalized IS NULL` (set NULL on first insert and whenever the `content_hash` changes).

- **Validity gate (overview §15.1)** → apply the source's `isPoi` predicate. Rows that fail stay
  in `research_pois` (provenance) but are flagged non-promotable (e.g. set `canonical_poi_id` to a
  sentinel/skip so the matcher never picks them up — simplest is to just not normalize them, so
  they never become matchable). Catches club nights in the EDM dump, blog posts in Festivalando, etc.
- **Names** → `name_normalized` (lowercase, strip diacritics, drop stopwords, expand
  abbreviations, strip legal suffixes).
- **Coordinates** → parse the source's lat/lng strings to numbers, detect/fix swapped lat/lng
  (reuse the heuristic in `.cursor/skills/import-pois/SKILL.md`), range-check, and write
  `lng`/`lat`. (`geom` updates automatically via the generated column.) If the source had no
  coordinates, leave `lat`/`lng` NULL — that NULL is exactly what tells the geocode step (M6) to
  resolve it; no status flag needed.
- **Value validation, not presence (overview §15.3)** → sanitize mapped values: normalize
  `country` (sub-national regions like "Bavaria" → "Germany"); confirm a date is an *event* date,
  not a publish/scrape timestamp, before writing `attributes.start_date`/`end_date`; drop
  implausible coordinates. A non-empty field is not assumed correct.
- **`website` vs `source_url` (overview §15.2)** → only an **official** site goes in `website`
  (and `website_domain`); a source's own listing/detail URL goes in `source_url`. Never promote a
  listing URL to `website`.
- **phone** (E.164) normalized for matching signals.
- **Address** → city/region/country_code where parseable.
- **Category mapping** → look up `raw_category` (and source-specific tag) in
  `research_category_aliases`; on no match, do **not** guess — emit to the **unmapped-category
  report** so the developer extends `taxonomy.ts` (M2) and re-seeds.
- **Attribute normalization** → map source attribute keys to a **canonical per-category attribute
  vocabulary** defined in `taxonomy.ts`/code (e.g. `electric_hookups|Electricity Hookup|E` →
  `has_electric`; festival `start_date`/`end_date`), so `attributes` merges are consistent later
  (overview §14.4).
- **Coverage report (overview §15.3)** → `ingest:normalize --report-coverage` prints the *actual*
  per-field fill rate per source, so enrichment is planned off real numbers, not guesses.

> **Acceptance (M5):** after running, `research_pois` rows have `name_normalized`, parsed
> `lng`/`lat` where the source provided coordinates (NULL otherwise), and a resolved category
> alias where one exists; `ingest:normalize --report-unmapped` lists any raw categories still
> needing an alias.

---

## M6 — Geocode the gaps

`ingest/geocode.ts` + `"ingest:geocode"`. **Automatic and conditional** — the loop selects only
`research_pois` rows where **`lat IS NULL`** (i.e. the source had no coordinates). Records that
already carry coordinates are never selected, so there's **no flag** and zero API spend; existing
coordinates are trusted as correct.

- For each selected row, build `query_norm` = normalized `"name, city, region, country"` and check
  `research_geocode_cache` first:
  - **Cache hit with coords** → write `lng`/`lat` to the row (no API call). The row now has
    coordinates, so it won't be selected again.
  - **Cache hit that is a miss** (NULL coords) → skip; the address is known-unresolvable, so the
    row stays coordinate-less (and is simply never mapped). No API call, no per-row flag.
  - **Cache miss** → call LocationIQ (counts against the budget); store the result **including a
    miss** (NULL coords) in the cache; on success also write `lng`/`lat` to the row.
- Respect rate limits (throttle). Low-`precision` (city/region centroid) results are flagged in the
  cache so M8 can down-weight them (overview §14.6).
- **Daily budget (LocationIQ free = 5,000/day), default-capped.** `--geocode-limit N` **defaults to
  ~4,500** (override to raise/lower); only **API calls** (cache misses) count. When the cap is
  reached the step **just stops** — it writes nothing partial. Rows it didn't reach still have
  `lat IS NULL`, so re-running the **same command** continues with them. A large coordinate-less
  source is geocoded across several days, never restarting.
- **Unchanged records never reach this stage** — `content_hash` (M4) means a re-ingest of identical
  data does no geocoding at all.

> **Acceptance (M6):** coordinate-less rows (e.g. ArbNet) get `lng`/`lat` or stay NULL when their
> address can't be resolved; rows that already had coordinates are never sent to the API (no flag
> needed); the default `--geocode-limit` stops at the cap and a same-command re-run continues from
> where it left off; a second pass over already-resolved rows, unchanged rows, or known-miss
> addresses makes **zero** new API calls.

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
`canonical_poi_id IS NULL` **and** `lat IS NOT NULL` (a row needs matching when it has no
canonical yet; it must have coordinates to be blockable/mappable), one row per transaction. When a
row is matched/created, set its `canonical_poi_id` — which removes it from the queue. The score,
method, and LLM reason go to `research_match_decisions` (not onto the row).

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
6. **Attach/create** the `canonical_pois` row, set `research_pois.canonical_poi_id`, then
   **rebuild that one canonical** from all its `research_pois` (field precedence by source
   `trust`; verbatim description for single-source, LLM fusion when multiple disagree;
   union `attributes`; union categories into `canonical_poi_categories`; recompute
   `popularity = COUNT(DISTINCT source_id)`; write `field_provenance`).
7. **Transitivity**: union-find across pairwise matches.
8. **Recurring events collapse to one canonical (overview §6, §15.5).** For festivals, different
   *editions* (2024/2025/2026) of the same festival share name + venue, so they block and merge
   into one canonical — **not** one POI per year. On merge, fold edition dates into
   `attributes` (keep the next/most-recent `start_date`/`end_date`, optionally an edition history);
   never store an `active` flag (status is derived at read time from those dates — see M3).

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
  embed → match. **Geocoding is automatic/conditional** (only rows with `lat IS NULL` call the API)
  and **`--geocode-limit` defaults to ~4,500**, so the *same command works for every source* with
  no flags. Optional flags: `--dry-run`, `--limit`, `--geocode-limit N`, `--no-llm`. One invocation
  = one **category × source** chunk (overview Decision 2). See "Ingestion is incremental and
  budgeted" above for the re-run/skip mechanics.
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

## M10 — End-to-end validation (gardens, campgrounds, festivals)

1. Ingest a coherent chunk per category × source, e.g.:
   ```bash
   # Gardens
   pnpm --filter @lib/db-map ingest:run bgci      docs/poi/botanical_gardens_data/bgci_gardens_full.json
   pnpm --filter @lib/db-map ingest:run wikidata  docs/poi/botanical_gardens_data/wikidata_botanical_gardens.json
   pnpm --filter @lib/db-map ingest:run osm       docs/poi/botanical_gardens_data/osm_botanical_gardens.csv
   # Campgrounds (chunked; large)
   pnpm --filter @lib/db-map ingest:run ridb      docs/poi/rv_campgrounds_data/ridb/facilities.csv --limit 2000
   # Festivals (events — exercises §15: isPoi filter, source_url vs website, read-time status)
   pnpm --filter @lib/db-map ingest:run resident_advisor docs/poi/music-festivals/apis/resident_advisor_festivals.json
   pnpm --filter @lib/db-map ingest:run edm_dance_directory docs/poi/music-festivals/...   # only 55/9,901 promote
   ```
2. Verify in SQL: duplicate gardens collapsed; popularity reflects source count; campgrounds
   carry hookup `attributes`; `field_provenance` populated. **For festivals also confirm:**
   non-festival rows (EDM club nights, Festivalando blog posts) did **not** create canonical POIs;
   `website` is never a directory/listing URL (those are in `source_url`); recurring editions
   collapsed to one canonical; status is computed from dates at read time (no stored flag).
3. **Manual GUI test:** `pnpm dev`, pan to a dense region, confirm clustered POIs render, the
   category filter (Botanical Garden / RV Park / Music Festival) works, and the detail drawer shows
   merged data. Capture a screenshot + short screen recording for the walkthrough.

> **Acceptance (M10):** the map shows de-duplicated, categorized, attributed POIs from multiple
> sources across all three categories; non-POI rows are excluded; re-running any chunk changes
> nothing (idempotent).

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
- **Idempotency is the contract, and state is implicit** — `(source_id, source_record_id)`
  uniqueness + per-record `content_hash` (skip unchanged; reset derived cols on change) +
  NULL-ness of derived columns (`lat IS NULL` = needs geocode, `canonical_poi_id IS NULL` = needs
  match) + recomputed popularity mean every stage is safe to re-run and never restarts or
  double-spends — **with no status columns to maintain**. Preserve this in every extractor
  (synthesize stable ids where the source lacks them; hash the same normalizable fields every time).
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
