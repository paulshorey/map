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

| # | Milestone | Outcome | Priority | Status |
|---|---|---|---|---|
| M0 | Prerequisites & decisions | Extensions + env + model choices confirmed | **first** | **done** |
| M1 | Fresh DB schema (baseline + tooling) | New `research_*` / `canonical_*` schema live | **first** | **done** |
| M2 | Code-owned taxonomy seed | Categories + aliases in the DB | **first** | **done** |
| M3 | Data-access layer + app read path | App runs on new schema (empty map) | **first** | **done** |
| M4 | Ingestion framework + extractors | Raw dumps land in `research_pois` | **next** | pending |
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

## M0 — Prerequisites & decisions ✅

**Status: complete.** Provider choices are locked; API keys are set in the Cursor Cloud agent
environment and verified working (July 2026).

### M0.1 Portable schema (no PostGIS / pgvector)

The deployed baseline (`lib/db-map/migrations/202606300400__baseline.sql`) deliberately avoids
PostGIS and pgvector — neither extension is available on the target Railway Postgres. Instead:

- **Coordinates:** plain `lng`/`lat` doubles + btree indexes; spatial blocking uses a bbox
  prefilter in SQL, then Haversine distance in app code (M8).
- **Embeddings:** `real[]` column; cosine similarity computed in app code on the small blocked
  candidate set (matching blocks by geography first, so no ANN index is needed).
- **Name similarity:** `pg_trgm` (available).
- **Event date filtering:** `tstzrange` GiST (core PostgreSQL, no extension).

```bash
psql "$DB_MAP_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; SELECT 1;"
```

> Acceptance: `pg_trgm` creates successfully. Baseline migration applies without PostGIS/pgvector.

### M0.2 Embedding provider — Jina AI `jina-embeddings-v3` @ 384 dims

`research_pois.content_embedding` is `real[]`; **array length is fixed at 384** (chosen via Jina's
Matryoshka Representation Learning — good quality/cost trade-off for name+locality similarity).

| Setting | Value |
|---|---|
| Provider | Jina AI |
| Model | `jina-embeddings-v3` |
| Dimension | `384` (via `dimensions` param; default is 1024) |
| Task | `text-matching` (for pairwise POI similarity) |
| Env var | `JINA_API_KEY` |

**API call** (`POST https://api.jina.ai/v1/embeddings`):

```bash
curl https://api.jina.ai/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JINA_API_KEY" \
  -d '{
    "model": "jina-embeddings-v3",
    "task": "text-matching",
    "dimensions": 384,
    "input": ["Kew Gardens, London, UK"]
  }'
```

Response: `{ "data": [{ "embedding": [0.09, -0.15, ...] }] }` — 384 floats.

Implement in M7 as `ingest/embed.ts` → `ingest/providers/jina.ts`. Batch multiple texts per
request (Jina accepts an array in `input`). Store the returned vector directly in `content_embedding`.

### M0.3 Geocoder — LocationIQ

| Setting | Value |
|---|---|
| Provider | LocationIQ |
| Free tier | 5,000 forward-geocode requests/day |
| Env var | `LOCATIONIQ_API_KEY` |

**API call** (forward search):

```bash
curl "https://us1.locationiq.com/v1/search?key=$LOCATIONIQ_API_KEY&q=Kew+Gardens+London&format=json&limit=1"
```

Response: `[{ "lat": "51.4787", "lon": "-0.2956", "display_name": "...", ... }]`.

Implement in M6 as `ingest/geocode.ts` → `ingest/providers/locationiq.ts`. Throttle to respect
rate limits; cache every query (hit or miss) in `research_geocode_cache`.

### M0.4 LLM provider — DeepInfra `deepseek-ai/DeepSeek-V4-Flash`

Used only in M8: (a) gray-zone **binary** match adjudication, (b) multi-source description
fusion when verbatim sources disagree. Not needed for M4–M7.

| Setting | Value |
|---|---|
| Provider | DeepInfra |
| Model | `deepseek-ai/DeepSeek-V4-Flash` |
| API style | **OpenAI-compatible** chat completions |
| Base URL | `https://api.deepinfra.com/v1/openai` |
| Env var | `DEEPINFRA_API_KEY` |
| Context | 1M tokens (more than enough for match prompts) |
| Cost | ~$0.09/M input, ~$0.18/M output tokens |

**API call** (`POST /v1/openai/chat/completions`):

```bash
curl "https://api.deepinfra.com/v1/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DEEPINFRA_API_KEY" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "messages": [
      {"role": "system", "content": "You are a POI deduplication judge. Reply ONLY with valid JSON."},
      {"role": "user", "content": "Are these the same place? ..."}
    ],
    "temperature": 0,
    "max_tokens": 256,
    "response_format": {"type": "json_object"}
  }'
```

**TypeScript client** (use the `openai` npm package with a custom base URL — no DeepInfra SDK
needed):

```ts
import OpenAI from "openai";

const llm = new OpenAI({
  apiKey: process.env.DEEPINFRA_API_KEY,
  baseURL: "https://api.deepinfra.com/v1/openai",
});

const res = await llm.chat.completions.create({
  model: "deepseek-ai/DeepSeek-V4-Flash",
  temperature: 0,
  max_tokens: 256,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: MATCH_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ recordA, recordB, distanceM, signals }) },
  ],
});
const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
// Expected shape: { "same_place": true|false, "reason": "one sentence" }
```

Implement in M8 as `ingest/match/llm.ts` → `ingest/providers/deepinfra.ts`.

**Match adjudication prompt contract** (forced binary, no human review):

- System: "You judge whether two POI records refer to the same real-world place. Reply with JSON:
  `{ \"same_place\": boolean, \"reason\": string }`. You must choose yes or no."
- User: both records' `name`, `address`, `city`, `region`, `country_code`, `website`, `distance_m`,
  `name_similarity`, `embedding_cosine`.
- `temperature: 0`, `response_format: { type: "json_object" }` for reliable parsing.
- On parse failure or API error: fall back to `new` (create separate canonical — conservative).

**Description fusion prompt** (only when multiple sources disagree):

- System: "Combine these source descriptions into one factual paragraph. Preserve specific facts;
  do not invent details. Reply with JSON: `{ \"description\": string }`."
- User: array of `{ source, text }` objects.
- Pick the result only if it's shorter than the concatenation and contains no hallucinated facts;
  otherwise keep the longest single-source verbatim text (Decision 4).

**Rate limits:** DeepInfra default is 200 concurrent requests per model (plenty for our
one-record-at-a-time matcher). Retry on HTTP 429 with exponential backoff.

### M0.5 Environment variables

Documented in `.env.example` (repo uses shell env, not `.env` files):

```bash
GEOCODER_PROVIDER=locationiq
LOCATIONIQ_API_KEY=
EMBEDDINGS_PROVIDER=jina
EMBEDDINGS_MODEL=jina-embeddings-v3
EMBEDDINGS_DIM=384
JINA_API_KEY=
LLM_PROVIDER=deepinfra
LLM_MODEL=deepseek-ai/DeepSeek-V4-Flash
DEEPINFRA_API_KEY=
INGEST_MATCH_T_HIGH=0.85
INGEST_MATCH_T_LOW=0.55
```

`lib/db-map/scripts/ingest/config.ts` (created in M4) reads these env vars with the defaults
above.

> Acceptance: `.env.example` committed; all three API keys verified in the shell (Jina, DeepInfra,
> LocationIQ all return HTTP 200 on a smoke-test call).

---

## M1 — Fresh database schema (baseline migration + tooling) ✅

**Status: complete.** Implemented in `lib/db-map/migrations/202606300400__baseline.sql` (portable
baseline — no PostGIS/pgvector; see M0.1). Old migrations removed; `pnpm db:sync` regenerates
`schema/`, `generated/typescript/db-types.ts`, and contracts.

The DDL below is the **original design sketch** (PostGIS/pgvector). The **shipped baseline**
differs — see the migration file for the authoritative schema. Key differences from this sketch:

- No `geom` geography columns — plain `lng`/`lat` + btree indexes instead.
- `content_embedding real[]` instead of `vector(384)`.
- Event date columns on `canonical_pois` (`starts_at`, `ends_at`, `date_precision`, `event_range`).
- `source_url` on `research_pois` (listing page ≠ `website`).
- `is_temporal` on `canonical_categories`.
- `canonical_poi_occurrences` table for recurring event editions.
- `research_category_aliases` uses partial unique indexes (not PK with nullable `source_id`).

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

## M2 — Code-owned taxonomy seed ✅

**Status: complete.** `lib/db-map/scripts/ingest/taxonomy.ts` + `seed-taxonomy.ts`; run via
`pnpm --filter @lib/db-map ingest:taxonomy:seed`.

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

## M3 — Data-access layer + app read path (app runs on the new schema) ✅

**Status: complete.** `lib/db-map/sql/pois.ts` reads `canonical_pois`; app API routes and
`PoiDrawer` display event dates; `pnpm verify` passes.

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
  compute `upcoming`/`active`/`past` at read time from the typed `starts_at`/`ends_at` columns vs.
  `now()` (per `.cursor/plans/poi-event-dates.md` these are first-class columns, no longer
  `attributes.start_date`/`end_date`) — there is no stored `active` flag to go stale. (A future
  map filter like "upcoming this season" is a `WHERE` on those dates, evaluated per request.)
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

## M5 — Normalize + categorize ✅

**Status: complete** (as originally scoped). `ingest/normalize.ts` + `"ingest:normalize"`.
Resumable loop over `research_pois` where `name_normalized IS NULL` (set NULL on first insert and
whenever the `content_hash` changes).

> **Addendum (raw-data survey, Jul 2026):** the "Data-quality contract" section (before M8)
> extends normalize with work not yet implemented: the shared **event-date parser**
> (`normalize/dates.ts` → `starts_at`/`ends_at`/`date_precision`, incl. swap repair),
> **HTML → Markdown** description conversion (`normalize/html.ts`), **field-leak/column-shift
> validation** (prose in date fields, years in country fields, venue-in-city mapping), and the
> **coords-vs-country cross-check**. Implement these alongside the first festival extractors
> (they are no-ops for the garden sources already ingested).

> **Category storage decision (implemented).** Categories are first-class columns, not JSON:
> - **`research_pois.category_slugs text[]`** (GIN-indexed) holds the resolved canonical slugs
>   (multi-valued — a record can map to several categories). It is re-derived on each normalize
>   run and reset on content change. `raw_category` (verbatim) and `ingest_category` (dump-level)
>   are kept alongside for the unmapped report and provenance.
> - **`research_pois.is_poi boolean`** is the validity gate (replaces `attributes._is_poi`), so
>   normalize simply filters `WHERE is_poi`.
> - **`canonical_pois`** keeps the **M:N junction `canonical_poi_categories`** as the source of
>   truth (FK integrity + `is_primary`), plus a denormalized **`primary_category_id`** FK column
>   for the hot map read path (marker color/label via a single join). The category filter expands
>   a selected category to its descendants via a recursive CTE and probes the composite index
>   `canonical_poi_categories(category_id, poi_id)`.
> - Rationale: `research_pois` is a high-volume, re-derivable scratch layer (arrays of code-owned
>   slugs, no FK needed); `canonical_pois` is the durable, user-facing, integrity-critical layer
>   (normalized junction with FKs). See the "Handling categories" discussion in the overview.

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
  `research_category_aliases`; write resolved slugs to **`category_slugs text[]`** (falling back to
  the code-owned `ingest_category` slug). On no alias match, do **not** guess — the unmapped
  `raw_category` surfaces in `--report-unmapped` so the developer extends `taxonomy.ts` (M2) and
  re-seeds.
- **Names are Unicode-aware** → normalization keeps letters/numbers of any script (CJK, Cyrillic,
  Arabic, …); only Latin diacritics are stripped (NFKD→strip→NFC so kana like ず stay intact).
  Essential for global coverage.
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

## M6 — Geocode the gaps ✅

**Status: complete.** `ingest/geocode.ts` + `"ingest:geocode"` with a LocationIQ provider client
(`ingest/providers/locationiq.ts`) and the `research_geocode_cache` dedupe/miss cache.

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
  category>`; call Jina (`jina-embeddings-v3`, `task: text-matching`, `dimensions: 384`); write
  the returned float array to `content_embedding` (must be length 384).
- Batch requests; skip unchanged rows (cost control, overview §5 Stage 4).

> **Acceptance (M7):** `SELECT count(*) FROM research_pois WHERE content_embedding IS NOT NULL`
> matches the number of normalized rows; a no-op re-run embeds nothing.

---

## Data-quality contract — field repair & validity rules (raw-data survey, Jul 2026)

> Grounded in a full survey of `docs/poi/` (7 category folders, ~250 files, ~700 MB: gardens,
> campgrounds, flying sites, music festivals, carnival, art-fairs, art-parades). These rules are
> cross-cutting: extractors (M4) parse and gate; normalize (M5) repairs and validates; merge (M8)
> trusts only repaired values. **Principle (overview §15.3): a non-empty field is never assumed
> correct. Every field is validated against its own type; unfixable values become NULL — never
> garbage.** NULL is safe (the record just skips that signal); garbage poisons geocoding,
> embeddings, and matching.

### Product decisions (owner, Jul 2026)

1. **Permanently closed places are skipped at extract — not recorded at all** (not even as
   `is_poi = false` provenance rows). The Dyrt `"- PERMANENTLY CLOSED"` names, RIDB
   closed-in-description, etc. never enter `research_pois`.
2. **Every `docs/poi/` folder is a top-level category**: `music_festival`, `gardens`,
   `campground`, `free_flight` (existing) + **`carnival`**, **`art_fair`**, **`art_parade`**
   (new, all temporal). Sub-categories may hang under them later; the folder→category mapping is
   the default `ingest_category` for its sources.
3. **Undated events are allowed** into both `research_pois` and `canonical_pois`. Dates are
   always optional in the database (most POIs have none). A front-end filter to
   include/exclude/only-show null-date POIs comes later — no pipeline gate on missing dates.
4. **Coordinates are required for canonical.** If a record's location cannot be resolved to
   lat/lng (source coords, URL-embedded coords, or geocoding), the record stays in
   `research_pois` but is **never promoted** to `canonical_pois` (the match queue already
   requires `lat IS NOT NULL`). Log the skip (see the logging contract below).
5. **Prose dates are converted via LLM** (see Dates rule 9) as part of cleaning.

### Dates (event POIs)

Observed in the wild: ISO (`2026-06-19`), compact `YYYYMMDD` (MusicFestivalWizard), `DD/MM/YYYY`
(Concerts-Metal), US prose (`"Nov 6, 2026"`), day-ranges without year (`"June 3-6"`), month-only
(`"July"`), year-only (`"1982"`, MusicBrainz), `"Cancelled"`/`"TBD"`/null, **whole sentences
leaked into date fields** (eFestivals: 322 of 342 rows — `start_date: "Sarum Point is a music
festival held from 29"`), **swapped ranges** (global_carnivalist St. Maarten: start
`"April 30, 2026"`, end `"April 1, 2026"`), placeholder `9999-12-31`, publish timestamps
masquerading as event dates (Festivalando), liturgical prose (`"Three days preceding Lent"`,
UNESCO), and multi-weekend `weeks[]` arrays (Viberate/Coachella).

Rules (implemented in a shared `normalize/dates.ts`; extractors pass raw strings through):

1. **One parser owns all formats** — `parseEventDate(raw, sourceHint)` with per-source format
   hints (`YYYYMMDD`, `DD/MM/YYYY`, etc.). Extractors never parse dates themselves.
2. **Reject, don't guess.** Unparseable → NULL. Value longer than ~40 chars or containing
   sentence text → NULL (catches the eFestivals leak). `"Cancelled"`/`"TBD"` → NULL.
3. **Plausibility window**: parsed year must be in `[1900, currentYear + 5]`; otherwise NULL.
   Epoch (`1970-01-01`) and far-future placeholders (`9999-*`) → NULL.
4. **Swap repair (product decision)**: if both ends parse and `start > end`, store
   `min` as `starts_at` and `max` as `ends_at`; keep the raw strings in `attributes.date_raw`;
   count swaps in the run stats. *Exception:* cross-year ranges where one side lacks a year
   ("Dec 31 – Jan 1") get year inference **before** the swap check so NYE events aren't mangled.
5. **Precision**: full date → `'day'`; month-only → `'month'` (first of month); year-only →
   `'year'`. Stored in `date_precision` so the UI and matcher know how much to trust it.
6. **Missing end** → `ends_at` NULL (single-day or unknown; Ticketmaster is 90% end-less).
7. **Edition year in the name** ("Coachella 2025") may serve as a *fallback year hint* when the
   record carries no other date — never overrides a parsed date.
8. **Multi-weekend `weeks[]`** → each week becomes a `canonical_poi_occurrences` row at merge;
   the representative `starts_at`/`ends_at` spans per the event-dates plan.
9. **Prose dates → LLM conversion (product decision).** When deterministic parsing fails but the
   string looks like a recurring/prose date (`"every February"`, `"Three days preceding Lent"`,
   `"February 11–13"` with no year), call DeepInfra `DeepSeek-V4-Flash`:
   - Prompt includes the prose string **and the current year**; ask for start and end dates.
   - Regex-extract all `YYYY-MM-DD`-shaped dates from the response; **use only the first two**.
     One date → start only, end NULL. Zero → give up (dates stay NULL; undated is allowed).
   - **Ignore the LLM's year.** Re-derive it with structured logic: if the parsed start month
     has already passed in the current year → use next year; otherwise → current year. (The end
     date follows the start; if end month < start month, the range crosses a year boundary and
     the end gets start-year + 1.)
   - Results are memoized per normalized prose string within a run (many records share
     `"every February"`); LLM-derived dates get `date_precision = 'day'` at best but are
     flagged `attributes.date_source = 'llm'` for audit. Deterministic parses always win;
     the LLM is only a fallback.
   - On API error/unparseable response: dates stay NULL (conservative; undated is allowed).

### Location

Observed: city+country concatenated in one field (`"Boom, Belgium"`, `"Detroit Lakes,
Minnesota"`), **venue in the city field** (Festival Alarm: `city: "Eichenring Scheeßel"`;
Bandwagon: `city: "Victoria Theatre"`), **columns shifted a whole field** (Concerts-Metal:
`country: "2025"`, `city: "Blind Guardian &amp; Beast In Black"`), placeholder city `"All"`
(Resident Advisor, 16%), **crawl-default wrong country** (festivalfinder_eu: `country: "Albania"`
on every record while `location_raw` = `"Iisaku, Estonia"` holds the truth), empty country
(Festival Alarm, 17%), coords `0,0` (RIDB: ~435 facilities, ~17% of campsites), coords as strings
(Ticketmaster), coords contradicting the claimed region (The Dyrt: an "Everglades" campground at
Maryland coordinates).

Rules:

1. **Field-type validation** — a `city` that parses as a pure number/year → NULL; a `city` equal
   to a known country name → moved to country; comma-split `"City, Country|Region"` when the tail
   resolves via `countryToCode`; placeholders (`"All"`, `""`, `"unknown"`) → NULL. When one field
   in a row fails type validation, treat *adjacent* fields in that row as suspect (column-shift
   corruption) — validate them all before use.
2. **Venue-vs-city** — sources known to put venues in `city` map it to `attributes.venue` in the
   extractor and leave `city` NULL; geocode composes `"name, venue, country"` instead.
3. **Per-source overrides** — when a scraped field is systematically wrong (festivalfinder_eu
   `country`), the extractor derives from the trustworthy field (`location_raw`) and ignores the
   broken one. This is extractor-level knowledge, not a generic heuristic.
4. **Coordinates** — parse strings → numbers; drop `(0,0)` and out-of-range; keep the existing
   swap heuristic; **country cross-check**: when both `country_code` and coords are present and
   the point falls far outside the country's bounding box (generous tolerance), NULL the coords
   (the row re-flows through geocode) and keep the originals in `attributes.coords_raw` for audit.
5. **URL-embedded coordinates (product decision)** — before any geocoding, scan the record's
   `website`/`source_url`/raw URLs for parseable lat/lng (Google Maps `/maps/search/34.04,-118.26`,
   `@lat,lng,zoom`, `q=lat,lng`, `!3d…!4d…`, OSM `mlat/mlon`, etc.). A valid pair (range-checked,
   not 0,0) is used directly as the row's coordinates — zero LocationIQ spend. Runs in normalize
   (`normalize/urlcoords.ts`).
6. **Optimistic geocoding (product decision)** — the geocode query composes **everything
   available**: name + venue + address + city + region + country. Any single present field is
   enough to attempt the lookup; the geocoder decides if the prose resolves. (Precision gating —
   rule 8 — protects matching from coarse results.)
7. **Coordinates are required for canonical** — a row that still has `lat IS NULL` after
   URL-extraction and geocoding stays in `research_pois` (provenance, re-tried on future runs if
   the cache allows) and is never matched/promoted. The skip is logged per record.
8. **Geocode precision gates matching** — `research_geocode_cache.precision` (`city`/`region`
   centroids vs `point`) is read by M8; see the M8 gate below.

### Text (names, descriptions)

Observed: raw HTML (`<h2>Overview</h2>` in RIDB, `<br>` in USHPA KML), HTML entities (`&amp;`,
`&#8211;`, `&#160;`), Wikipedia citation noise (`[1]`, `&#91;1&#93;`), WordPress boilerplate
(`"Powered by WordPress"`, `"Partager :"`), giant link farms (BHGC flying sites), ticket-product
names (`"Summerfest 2026 $33 One Day Pass"`), edition years baked into names
(`"Leverkusener Jazztage 2010"` / `"…2014"` as separate records), ALL-CAPS names/countries,
a **table header row ingested as a record** (`name: "EventSort descending"`, SmoothJazz),
truncated mid-word descriptions, and contact blobs/emoji in descriptions (FECC).

Rules:

1. **HTML → Markdown at normalize** (`normalize/html.ts`, e.g. `node-html-markdown`): keep links
   and basic formatting (bold, lists; headings demoted to bold); decode all entities; strip
   script/style/nav boilerplate and wiki citation markers. `research_pois.description` stores
   **Markdown only**; the M8 LLM fusion prompt receives and returns Markdown, preserving links.
2. **Description validity** — NULL it when it is boilerplate duplicated across records, shorter
   than the name, or merely a location string (per-source cleaners where systematic).
3. **Name hygiene for matching** — `name_normalized` additionally strips a *standalone*
   leading/trailing edition year (`19xx`/`20xx`) and price/product suffixes; the display `name`
   keeps the original. This is what lets per-year rows ("Hurricane Festival" ×6 in Festival
   Alarm; MusicBrainz per-edition MBIDs) block into one canonical.
4. **Field-leak detection** — prose in a date field → NULL (Dates rule 2); sentence-length text
   in a location field → NULL (raw is preserved in `raw` anyway).

### Validity gates (`is_poi`) — contamination by source

| Contamination | Where seen | Extractor gate |
|---|---|---|
| Club nights / single-DJ shows | edm_dance_directory (**99.4%** non-festival), Resident Advisor NYE/club, Festifeed Ibiza residencies | `is_festival === true` + heuristics; RA name blocklist (`NYE`, `NYD`, `Club Night`) |
| Ticket products / hotel packages | Ticketmaster (637 `segment: "Miscellaneous"`) | `segment === "Music"` AND name not matching `Hotel|Package|Pass|VIP|Camping` |
| Member/org directories | outdoorartsuk (380), ietm (428), FECC members, UNIMA national centers | `member_type` present / URL pattern → `is_poi = false` |
| Wiki link/category scrape junk | wikipedia_parades ("Circus", "magpie"), wikipedia_carnivals_category, wikidata art fairs (hymns/anthems!), wikidata parades (tugboats, ships) | QID-type validation; name blocklists; require event-like fields |
| Header rows / stubs | SmoothJazz row 1; Skiddle 316/323 name-only stubs | shape check; name-only records may ingest at low trust but never auto-merge |
| Reddit comment threads | reddit_raw_comments.json | no extractor (Tier D — skip file) |
| Org meeting history | fecc_wikipedia.json (convention list) | skip file |
| Tour legs of one production | the_herds_tour.json (53 legs, same name) | one canonical + occurrences, or skip |
| Permanently closed | The Dyrt `"- PERMANENTLY CLOSED"` (96), RIDB closed-in-description | **skip at extract — do not record** (product decision 1) |
| Wrong category in folder | rick_steves (~392 general festivals in `carnival/`), hostels (84) in `flying_site_data/` | `ingest_category` comes from the **source registry**, never the folder; gate rows or skip source |
| Empty files | artnet_events, artfairslist, streetartlist, wikidata_art_fairs (`[]`) | skip |

**Source tiers** (drives extractor build order): **A** structured/light filter (UNESCO ICH,
JamBase, Viberate, RIDB facilities, The Dyrt, OSM, thecraftmap, artfairsourcebook, Artsy);
**B** needs normalization (MusicBrainz, MFW, Festival Alarm, wikidata_* with type filters,
Ticketmaster, travel blogs); **C** needs transform (research stubs, reddit_carnivals synthesized,
tour legs); **D** excluded (comment threads, category trees, member directories as POIs,
link-scrape files, empty files, fecc_wikipedia). Build A → B; C case-by-case; D never.

### Per-item logging contract (product decision)

Ingestion scripts log **one line per record** to stdout:

- **Success** — minimal: `✓ <POI name>` (plus the stage's action where useful:
  `inserted`/`updated`/`unchanged`, `geocoded`, `embedded`).
- **Skip** — a warning explaining why:
  `Skipped - <POI name> - unable to parse location`,
  `Skipped - <POI name> - permanently closed`,
  `Skipped - <POI name> - not a POI (club night)`, etc.

Summary stats stay at the end of each run. Applies to every stage script and to `ingest:run`
(M9), which streams the per-record lines of whichever stage is running.

### Multi-file sources & re-flow

- `ingest:extract` must accept **multiple files/globs** for one source (MusicBrainz ships as 16
  parts) — same source slug, one run.
- When normalize/repair logic changes materially after rows are already processed, the affected
  sources' derived columns must be bulk-reset (`name_normalized = NULL`, `content_embedding =
  NULL`, `category_slugs = NULL` — never blanket-NULL `lat`, which may hold source-provided
  coords) so rows re-flow. A re-extract does this automatically only for rows whose
  `content_hash` changed, which repair-rule changes do not; a small `ingest:reflow --source
  <slug>` helper (or documented SQL) covers it.

---

## M8 — Match + merge (the de-duplication core)

`ingest/match/` + `"ingest:match"`. This is the heart; build it as the **resumable, one-record-
at-a-time** loop from overview §5 (Stage 5+6) and §6. Process `research_pois` where
`canonical_poi_id IS NULL` **and** `lat IS NOT NULL` (a row needs matching when it has no
canonical yet; it must have coordinates to be blockable/mappable), one row per transaction. When a
row is matched/created, set its `canonical_poi_id` — which removes it from the queue. The score,
method, and LLM reason go to `research_match_decisions` (not onto the row).

> **Merge rule (product decision, Jul 2026): proximity AND similarity are both required.**
> Two records become one canonical only when their coordinates are very close **and** their
> name/description similarity (embedding cosine + name sim) is high. Either signal alone is
> **never** sufficient: same-name places in different cities stay separate (blocking enforces
> this — far candidates are never even scored), and different places at near-identical
> coordinates stay separate (two festivals geocoded to the same city centroid, adjacent
> campgrounds, a garden inside a park). Structurally: **spatial blocking is the necessary
> proximity condition; the similarity score must then independently clear the threshold.**
> Distance decay may add confidence to a merge but must never rescue a low-similarity pair —
> cap the combined distance+city/region contribution below `T_high` so coordinates alone can
> never auto-merge. The one exception is `strong_id` (shared Wikidata QID / OSM id), where
> identity is proven outright.

### M8.1 Per-record algorithm (overview §6)

1. **Overrides** (`research_match_overrides`) win absolutely.
2. **Definitive-ID** match (Wikidata QID / OSM `(type,id)` from `attributes`/`raw`) → merge,
   `method='strong_id'`. **Do not** use website/phone as definitive (chain/portal denylist —
   overview §6 Step B).
3. **Spatial block**: bbox prefilter on `lat`/`lng` (cheap SQL), then Haversine distance in app
   code to find candidates within a category-tuned radius (campsites ~150 m, gardens ~400–600 m;
   define the slug→radius map in code with a default). Order by distance, take top 25. Requires
   non-null coordinates (geocoded rows only).
4. **Score** candidates: `pg_trgm`/Jaro-Winkler name sim + embedding cosine + distance decay +
   city/region + website/phone signal (denylist-guarded). Per the merge rule above, the
   similarity signals (name + embedding) must independently clear their own floor for any
   auto-merge; distance/locality only adds confidence. For the embedding side of a candidate
   canonical, compare against its **highest-trust linked research row's** `content_embedding`
   (embeddings live on `research_pois`, not `canonical_pois`).
5. **Geocode-precision gate (overview §14.6)**: when either side's coordinates came from a
   `city`/`region`-precision geocode (see `research_geocode_cache.precision`), distance is
   untrustworthy — **drop the distance signal entirely** (do not let a shared centroid look like
   0 m), require a higher effective similarity bar, and prefer routing the pair to the LLM
   instead of auto-merging. This is what keeps two same-city festivals geocoded to the same
   centroid from collapsing.
6. **Event-date compatibility (festivals)**: same name + same venue + different years = editions
   → merge (step 8). But near-identical dates with dissimilar names at one venue are different
   events sharing a venue → the venue/coords signal must not force a merge (covered by the AND
   rule). Undated event records match on the remaining signals; a date conflict (both dated,
   non-overlapping, name sim mediocre) pushes the pair to the LLM with dates included in the
   prompt.
7. **Decide**: `≥ T_high` auto-merge; `≤ T_low` new; gray zone → **LLM binary** (merge/new,
   `llm_reason` stored). Record everything in `research_match_decisions`.
8. **Attach/create** the `canonical_pois` row, set `research_pois.canonical_poi_id`, then
   **rebuild that one canonical** from all its `research_pois` (field precedence by source
   `trust`; description rules below; union `attributes`; union categories into
   `canonical_poi_categories`; recompute `popularity = COUNT(DISTINCT source_id)`; write
   `field_provenance`).
9. **Transitivity**: union-find across pairwise matches.
10. **Recurring events collapse to one canonical (overview §6, §15.5).** For festivals, different
    *editions* (2024/2025/2026) of the same festival share name + venue, so they block and merge
    into one canonical — **not** one POI per year. On merge, write edition rows to
    `canonical_poi_occurrences` and set the representative `starts_at`/`ends_at` on the canonical
    (per `.cursor/plans/poi-event-dates.md`, which promoted dates from `attributes` to typed
    columns); never store an `active` flag (status is derived at read time from those dates — see M3).

**Description & name synthesis (Decision 4, refined):** all descriptions are already Markdown by
M8 (HTML converted at normalize — see the data-quality contract). Single source with content →
publish verbatim. Multiple sources with *differing substantive* content → **LLM fusion via
DeepInfra `DeepSeek-V4-Flash`** with an explicit Markdown contract: "combine into one factual
Markdown paragraph(s); **preserve links and basic formatting**; do not invent details." Accept
the fused text only if it introduces no URLs/facts absent from the inputs; otherwise fall back to
the longest single-source verbatim text. Name conflicts resolve by trust precedence
(Wikidata/official > directory > scrape) — LLM name synthesis only when trust ties and strings
differ materially; prefer the version without edition years/venue suffixes.

**Prerequisite (event dates):** normalize (M5) must populate `research_pois.starts_at`/`ends_at`/
`date_precision` via the shared date parser *before* festival sources are matched — the columns
exist but are not yet written. Gardens/campgrounds do not need this and can be matched first.

### M8.2 Supporting pieces

- `ingest/match/denylist.ts` — known multi-location domains/phones (`koa.com`, `recreation.gov`,
  `nps.gov`, `facebook.com`, …).
- `ingest/match/llm.ts` — the binary adjudicator via DeepInfra OpenAI-compatible API (see M0.4).
- `ingest/merge.ts` — field-precedence resolver + conditional description fuser.
- `ingest:override <a> <b> same|different` CLI → writes `research_match_overrides`.
- **Golden-set harness** (`ingest/match/golden.ts` + a small labeled fixture of known
  same/different pairs, e.g. Kew across BGCI/OSM/Wikidata) reporting precision/recall — the
  primary quality gate since there's no human review (overview §6, §14.6).
- **Orphan GC + periodic full re-cluster** hooks (overview §14.1, §14.5): a `--recluster` mode
  and a sweep that hides `canonical_pois` with zero linked research rows.
- **Single-writer**: run matching as one process (advisory lock) to avoid duplicate-canonical
  races (overview §14.8).

### M8.3 Build order (two phases)

- **M8a — core loop, gardens first**: block → score → precision gate → decide (incl. LLM) →
  attach/create → per-canonical rebuild → decisions audit; denylist; DeepInfra provider;
  a starting golden set (~10–20 labeled pairs from the BGCI/OSM/Wikidata garden overlap, incl.
  known non-dupes). Acceptance = the garden checks below.
- **M8b — events + ops**: event-date parsing in normalize + occurrence building + representative
  dates; date-compatibility signal; override CLI; orphan GC; `--recluster`; expanded golden set
  with festival edition pairs and same-city-centroid non-dupes.

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

- **Portable schema is intentional** — no PostGIS/pgvector on the target DB. Spatial blocking
  and embedding cosine similarity happen in app code on small candidate sets (M0.1, M8).
- **Embedding dimension is load-bearing** — `content_embedding real[]` must always be length 384
  (Jina MRL). Changing models/dims means updating stored arrays + full re-embed.
- **Typegen noise** — if PostGIS is ever added later, apply the M1.3 filter in
  `generate-types.mjs` or `db:sync` will emit junk row types.
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
