# Plan: POI Ingestion, Normalization & De-duplication Pipeline

> **Goal:** Collect all the world's interesting places, one category at a time, and display
> them on a map. To do that we need a repeatable way to ingest messy raw data from many
> sources into a single, clean, de-duplicated set of canonical POIs — and to keep doing it
> as sources change and new sources arrive.

This is both the **design spec** for the database/architecture changes and the **operating
guideline** the team (and AI agents) follow every time a new data dump arrives. The two
dumps in `docs/poi/botanical_gardens_data/` and `docs/poi/rv_campgrounds_data/` are used
throughout as the worked examples.

---

## Table of Contents

0. [Resolved product decisions & operating constraints](#0-resolved-product-decisions--operating-constraints)
1. [The problem with what we have today](#1-the-problem-with-what-we-have-today)
2. [Core idea: two layers — raw research vs. canonical](#2-core-idea-two-layers--raw-research-vs-canonical)
3. [Industry context: this is "conflation" / entity resolution](#3-industry-context-this-is-conflation--entity-resolution)
4. [Target database schema](#4-target-database-schema)
5. [The ingestion pipeline (stage by stage)](#5-the-ingestion-pipeline-stage-by-stage)
6. [De-duplication algorithm in detail](#6-de-duplication-algorithm-in-detail)
7. [Categories, taxonomy & aliases](#7-categories-taxonomy--aliases)
8. [Continuous / repeated ingestion & popularity](#8-continuous--repeated-ingestion--popularity)
9. [Scripts & utilities to build and maintain](#9-scripts--utilities-to-build-and-maintain)
10. [Worked examples (gardens + RV campgrounds)](#10-worked-examples-gardens--rv-campgrounds)
11. [Things we should plan for now](#11-things-we-should-plan-for-now)
12. [Phased rollout](#12-phased-rollout)
13. [Product decisions (resolved)](#13-product-decisions-resolved)
14. [Implementation risks & refinements to watch](#14-implementation-risks--refinements-to-watch)
15. [Lessons from real source data (validity, value-checking, event POIs)](#15-lessons-from-real-source-data-validity-value-checking-event-pois)

---

## 0. Resolved product decisions & operating constraints

These five decisions were made by the product owner and are now **binding** for the POC. The
rest of the plan reflects them; this section is the single place to read them quickly.

1. **Licensing — ignore for the POC.** Do **not** gate ingestion or display on licensing.
   Use the best available data and **publish source content verbatim**. Copyrighted content
   will be reviewed/rewritten later, *per category, per source*, once we know which sources
   permit redistribution. → We still **store** `license`/`attribution` on `research_sources` as
   metadata to fill in later, but nothing enforces it now. No "enrichment-only" source class.

2. **Global from day one, ingested in chunks.** Coverage is worldwide, but we never ingest
   the whole planet at once — ingestion happens **one category × one source at a time**.
   Therefore every script must be a **resumable, long-running process** that handles each POI
   **one at a time**: analyze a record → compare it against what's already in the database →
   aggregate & save → move to the next. No giant all-at-once batch is required, and a run can
   stop and resume without losing or double-counting work. See the
   [execution model](#execution-model-long-running--resumable).

3. **LLM always auto-decides — no human review.** We have no resources for a human review
   queue. The gray-zone tie-breaker is the LLM, and it is **forced to a binary answer**
   (same → merge, otherwise → new POI). There is no `review` state and no review UI. (An
   optional developer-only `research_match_overrides` escape hatch remains, for correcting a wrong
   merge in code/SQL after the fact — it is *not* a review workflow.)

4. **Prefer verbatim text; aggregate with AI only when sources disagree.** Keep the best
   *original* data. If a place has **one source**, publish that source's text verbatim. If
   **multiple sources** carry **different** substantive content, use generative AI to fuse
   them into one output. Never rewrite good single-source prose just to "AI-ify" it.

5. **Category taxonomy is code-owned.** Slugs, parents, and aliases live in a committed seed
   file edited **only by the developer in source**, because they are tightly coupled to the
   generative-AI prompts and matching code. **No in-app/admin editing of categories.**

---

## 1. The problem with what we have today

Current state (verified in the repo):

- **One flat table** `pois` (`lib/db-map/migrations/202605241200__baseline.sql`): `name`,
  `category` (a free-text string), `lng`, `lat`, plus a few optional text columns. (This table
  is renamed to `canonical_pois` in §4.3; a new `research_pois` staging table is added for raw
  source data.)
- **Category is a single string column** with a btree index — no way to put one place in
  multiple categories, no way to rename a category without rewriting every row, no
  synonyms.
- **De-duplication is coordinate-exact only**: `UNIQUE (lng, lat)` + `ON CONFLICT (lng, lat)
  DO UPDATE` in `insertPois()` (`lib/db-map/sql/pois.ts`). Two sources that list the *same*
  garden 40m apart become **two POIs**; the same source re-imported with a nudged coordinate
  also duplicates.
- **No provenance**: nothing records which source a row came from, so we cannot compute
  "appears in N sources", cannot re-ingest a source without duplicating, and cannot honor
  per-source licensing.
- **Import is direct-to-display**: `db:import:json` / `db:import:kml` write straight into the
  table the app serves. There is no staging area to compare/clean against.

The raw dumps make the gap obvious. Botanical gardens alone are **~20,720 records across 8
sources** with massive overlap; RV campgrounds are **~284,345 records across 4 sources**.
The same Kew Gardens / same KOA appears in many of them, each with a slightly different name,
slightly different coordinates, and a different subset of fields. Loading these as-is would
produce a map that is mostly duplicates.

**What we need:** a pipeline that turns "many noisy rows about the same place" into "one
clean canonical place with merged attributes, every contributing source remembered, and a
popularity score" — and that is safe to re-run forever.

---

## 2. Core idea: two layers — raw research vs. canonical

This is the single most important decision, and it matches the user's instinct exactly.

```
                 EXTRACT          NORMALIZE / GEOCODE        MATCH / MERGE          PUBLISH
  raw files  ───────────▶  research_pois  ───────────▶  (conflation)  ───────▶  canonical_pois
 (CSV/JSON/                (one row per source           clustering of          (one row per real
  JSONL/KML)               record, kept forever)         duplicates              place; the only
                                                                                  table the app reads)
```

- **Raw / research layer — `research_pois`**: one row per record **per source**, kept
  forever, never shown on the map. This is the data-science workspace where we compare,
  normalize, and de-duplicate. Re-ingesting a source updates these rows in place (keyed by
  the source's own id), so the same source never inflates anything.
- **Canonical / validated layer — `canonical_pois`**: one row per **real place**, built by
  merging a cluster of `research_pois` rows. This is the *only* table the map API reads. It
  carries the merged/best attributes, the multi-category memberships, the popularity score,
  and the per-field provenance (which source each published field came from).

**Source attribution runs through both layers (see [§4.4](#44-attribution--provenance)):**

- Every `research_pois` row is attributed to exactly one source via `source_id`
  (+ `source_record_id` = the source's own id for that record).
- Each `research_pois` row points at its merged place via the `canonical_poi_id` foreign key —
  so the full set of sources behind any canonical POI is a single join, popularity is a
  `COUNT(DISTINCT source_id)` over that set, and `canonical_pois.field_provenance` records
  *which* source supplied each individual published field. That last part is what the future
  per-source licensing review will need to edit/omit content source by source.

Why two layers (vs. trying to dedupe in place):

- We can **re-run matching from scratch** any time we improve the algorithm, without having
  lost the original inputs.
- A bad merge is **reversible** — the raw rows are intact; we just recompute the clusters.
- **Provenance & licensing** are first-class: we always know who said what.
- The app stays **fast and simple** — it reads a clean table, never the 300k-row swamp.

---

## 3. Industry context: this is "conflation" / entity resolution

What the user is describing is a well-studied problem. Naming it helps us reuse known
techniques instead of inventing them.

- **Entity resolution / record linkage / deduplication** — deciding when two records refer
  to the same real-world entity. Classic Fellegi–Sunter probabilistic linkage, modern ML
  variants (e.g. Zingg, Dedupe.io, Splink).
- **Conflation** — the geospatial flavor: merging POI/feature datasets (OSM + government +
  commercial). This is exactly what Overture Maps, Foursquare/Factual ("Crosswalk"),
  Placekey, and SafeGraph do to build a unified places graph.

The universally-used shape of the solution (and what we adopt):

1. **Blocking** — never compare all pairs (200k² is 40 billion comparisons). Generate
   *candidate* pairs cheaply, almost always by **geography** ("only compare places within
   X meters"). This directly answers the user's concern: embeddings alone match "Riverside
   Park, NY" with "Riverside Park, CA" because the *text* is identical. Geographic blocking
   makes that impossible — we only ever compare nearby things.
2. **Scoring** — within a block, compute a similarity score per pair from multiple signals
   (name, distance, embeddings, shared strong IDs).
3. **Decision** — threshold the score: auto-merge / auto-separate / send the gray zone to an
   **LLM tie-breaker that always returns a decision** (no human review — see Decision 3 in §0).
4. **Clustering & merge** — group all "same" records into one cluster and synthesize the
   canonical record (field precedence + verbatim-preferred text, LLM summary only when
   multiple sources disagree — see Decision 4 in §0).

The LLM is used **only as a bounded tie-breaker in the ambiguous middle band**, not as the
primary matcher — which neatly sidesteps the user's "LLM is hard to quantify" and "embeddings
ignore distance" problems. Cheap deterministic signals decide the easy ~90%; the LLM
adjudicates the expensive ~10% and is **forced to a binary same/new answer** so the pipeline
never blocks on a human.

**Definitive identifiers short-circuit the fuzzy work.** If two records share a *globally
unique* id — a Wikidata QID or an OSM `(type,id)` — they are the same entity by definition:
merge immediately, skip scoring. The dumps are full of these (`wikidata`/`wikipedia` cross-refs
in OSM, `wikidata_id`, BGCI ids, etc.). **Website domain and phone are strong _signals_, not
definitive:** `koa.com` is shared by hundreds of KOAs and `nps.gov` by every national park, so
they add weight during scoring (§6) but must never trigger an automatic merge on their own
(see the chain/portal guard in §6, Steps B & D).

---

## 4. Target database schema

All changes ship as timestamped migrations in `lib/db-map/migrations/`, followed by
`cd lib/db-map && pnpm db:sync` to refresh `schema/current.sql`, generated types, and
contracts (per `AGENTS.md`).

### Naming convention & the "do we duplicate everything?" question

Tables are prefixed by the stage they belong to:

- **`research_*`** — the internal working set used to compare and combine raw data. Not shown
  to users. (These tables persist — `research_pois` is kept forever — but they're back-of-house
  machinery, not the published product.)
- **`canonical_*`** — the final, user-facing dataset the map app reads.

**Only POIs need both a `research_` and a `canonical_` copy.** That duality exists *solely*
because POIs are the one thing we de-duplicate (many raw rows → one merged place). Every other
table exists **once**, on whichever side it serves — we do **not** create a research+canonical
pair for sources, categories, etc.

### Schema at a glance

| Table | Stage | One row per… | Purpose | Key relationships |
|---|---|---|---|---|
| `research_sources` | research | data source | Registry of every source (slug, license, attribution, `trust` weight). Where raw data comes from; also the target of canonical attribution. | referenced by `research_pois.source_id`; surfaced for `canonical_pois` credits |
| `research_pois` | research | **(source, record)** | Raw, normalized, geocoded, embedded staging rows. The de-dup workspace; kept forever. | `source_id → research_sources`; `canonical_poi_id → canonical_pois` (its match result) |
| `research_category_aliases` | research | raw string → category | Maps messy source category strings (`caravan`, `garden:type=botanical`) to a canonical category during normalization. | `category_id → canonical_categories` |
| `research_geocode_cache` | research | geocoded query | Cached forward-geocoding results (incl. remembered misses) so identical queries dedupe, re-runs are free, and unresolvable addresses aren't retried. | standalone cache |
| `research_match_decisions` | research | match decision | Audit log of every merge/new decision (score, signals, LLM reason) for tuning & explainability. | `research_id → research_pois`; `candidate_poi_id → canonical_pois` |
| `research_match_overrides` | research | corrected pair | Developer force-same / force-different rules the matcher must always obey. | references two `research_pois` rows |
| `canonical_pois` | canonical | **real place** | The merged, best-of POIs the app shows. Carries merged fields, `attributes`, `field_provenance`, `popularity`. | parent of `canonical_poi_categories`; pointed at by `research_pois.canonical_poi_id` |
| `canonical_categories` | canonical | category | The taxonomy the app filters by (stable slug, display name, `parent_id` hierarchy). Code-owned seed. | self-ref `parent_id`; linked via `canonical_poi_categories` |
| `canonical_poi_categories` | canonical | (place, category) | Many-to-many: a place can be in multiple categories. | `poi_id → canonical_pois`; `category_id → canonical_categories` |

```
        research (back-of-house)                         canonical (user-facing)
  ┌───────────────────┐                            ┌──────────────────────────┐
  │ research_sources  │◀─ source_id ──┐            │ canonical_categories      │◀─┐
  └───────────────────┘               │            │  (taxonomy, parent_id)    │  │ category_id
            ▲ category attribution    │            └──────────────────────────┘  │
            │ (join via research_pois)│                        ▲ poi_id           │
  ┌───────────────────┐               │            ┌──────────────────────────┐  │
  │ research_pois      │── canonical_poi_id ──────▶ │ canonical_pois            │──┘
  │ (raw, per source)  │   (the match link)         │ (merged real places)      │
  └───────────────────┘                            └──────────────────────────┘
     ▲          ▲                                     via canonical_poi_categories (M:N)
     │          │ category_id
     │   ┌──────────────────────────┐
     │   │ research_category_aliases │── category_id ─▶ canonical_categories
     │   └──────────────────────────┘
     │ research_id / record_a,b
  ┌───────────────────────────┐   ┌───────────────────────────┐   ┌────────────────────────┐
  │ research_match_decisions   │   │ research_match_overrides   │   │ research_geocode_cache │
  └───────────────────────────┘   └───────────────────────────┘   └────────────────────────┘
```

Sections 4.1–4.6 below define each table in detail.

### 4.0 Extensions

```sql
CREATE EXTENSION IF NOT EXISTS postgis;     -- KNN distance search for blocking
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram name similarity
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector, embedding similarity
```

> **Decision — adopt PostGIS now.** The baseline deliberately avoided PostGIS, but
> distance-blocking 200k+ points needs a real spatial index (`GiST` + `ST_DWithin` /
> `<->` KNN). Railway Postgres supports the PostGIS image. The app's read path can keep using
> plain `lng`/`lat` columns (kept alongside `geom`), so `listPoisGeoJson` barely changes.

### 4.1 `research_sources` — source registry, provenance & licensing

```sql
CREATE TABLE research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,        -- 'osm', 'bgci', 'wikidata', 'thedyrt', 'ridb'
  name          text NOT NULL,
  homepage      text,
  license       text,                        -- 'ODbL', 'CC0', 'CC-BY-SA', 'proprietary', ... (metadata only for now)
  attribution   text,                        -- exact text to display, if known (metadata only for now)
  trust         integer NOT NULL DEFAULT 50, -- 0-100, field-precedence weight
  last_ingested_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

> **Licensing is not enforced in the POC (Decision 1).** `license`/`attribution` are recorded
> as *metadata* so we can act on them later, per category/source — but every source is
> display-eligible now and source content is published verbatim. There is no "enrichment-only"
> class of source.

`trust` orders field precedence during merge (government/official > Wikidata > OSM > scrape).

### 4.2 `research_pois` — the raw research layer

> The raw research layer. One row per **(source, record)**; this is where source attribution
> begins — `source_id` ties every research row to exactly one entry in `research_sources`, and
> `source_record_id` preserves that source's own id for the record.

```sql
CREATE TABLE research_pois (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES research_sources(id),  -- ← attribution: which source this row came from
  source_record_id text NOT NULL,            -- the source's OWN id (osm_id, wikidata_id, bgci_id, dyrt id)
  ingest_category text,                       -- which dump/run this came from, e.g. 'botanical_garden'

  -- normalized common fields (best-effort, nullable)
  name            text,
  name_normalized text,                       -- NULL ⇒ needs normalize
  description     text,
  website         text,                       -- the place's OFFICIAL site (not a directory/listing page)
  website_domain  text,                       -- normalized eTLD+1, a strong-ID signal
  source_url      text,                       -- the listing/detail page on the SOURCE (provenance, ≠ website)
  phone           text,                       -- E.164 where possible, a strong-ID signal
  email           text,
  address         text,
  city            text,
  region          text,                       -- state/province
  country_code    text,                       -- ISO-2
  lat             double precision,           -- NULL ⇒ needs geocoding
  lng             double precision,
  geom            geography(Point,4326)
                  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED,

  raw_category    text,                       -- the source's category string, pre-mapping
  raw             jsonb NOT NULL,             -- the full original record, verbatim
  attributes      jsonb,                      -- extracted structured attrs (hookups, area_ha, ...)

  content_embedding vector(384),              -- NULL ⇒ needs embed
  content_hash    text,                       -- version of the input; if it changes, derived cols are reset to NULL

  canonical_poi_id uuid REFERENCES canonical_pois(id) ON DELETE SET NULL, -- NULL ⇒ needs match; else the match/attribution link

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_id, source_record_id)        -- ← idempotency anchor
);

CREATE INDEX research_pois_geom_gix  ON research_pois USING gist (geom);
CREATE INDEX research_pois_name_trgm ON research_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX research_pois_canon_idx ON research_pois (canonical_poi_id); -- "all sources for this POI"
-- "needs work" = a derived column IS NULL; partial indexes keep those resumable scans cheap:
CREATE INDEX research_pois_todo_normalize ON research_pois (id) WHERE name_normalized   IS NULL;
CREATE INDEX research_pois_todo_geocode   ON research_pois (id) WHERE lat               IS NULL;
CREATE INDEX research_pois_todo_embed     ON research_pois (id) WHERE content_embedding IS NULL;
CREATE INDEX research_pois_todo_match     ON research_pois (id) WHERE canonical_poi_id  IS NULL;
```

The `UNIQUE (source_id, source_record_id)` constraint is what makes re-ingestion safe: the
same record from the same source always lands on the same row (upsert), so nothing
duplicates and popularity never double-counts.

> **No status columns — state is the NULL-ness of derived columns.** A record "needs" a stage
> exactly when that stage's output is missing: `name_normalized IS NULL` → normalize,
> `lat IS NULL` → geocode, `content_embedding IS NULL` → embed, `canonical_poi_id IS NULL` →
> match. `content_hash` versions the input; when an upsert changes it, the derived columns are
> reset to NULL so the record flows through the stages again. This removes any `geocode_status` /
> `match_status` bookkeeping: there is no "incomplete/parked" state to track — a record is simply
> either done (column set) or not (column NULL). Match score/method live only in the
> `research_match_decisions` audit (§4.6).
>
> **The HNSW embedding index is omitted** — matching blocks by geography first (§6), so embedding
> cosine is computed only against the handful of nearby candidates, never the whole table.

### 4.3 `canonical_pois` — the canonical / validated layer (revised)

> The canonical / validated layer (today's `pois` table). Migration path: `ALTER TABLE pois
> RENAME TO canonical_pois`, then add the new columns below. (The existing rows are also seeded
> into `research_pois` under a `manual`/`legacy` source so today's data keeps its attribution —
> see Phase 0.)

```sql
CREATE TABLE canonical_pois (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  photo_url     text,
  address       text,
  website       text,
  hours         text,
  phone         text,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  geom          geography(Point, 4326) NOT NULL,
  attributes    jsonb NOT NULL DEFAULT '{}', -- category-specific structured fields (see below)
  field_provenance jsonb NOT NULL DEFAULT '{}', -- per-field source attribution (see §4.4)
  popularity    integer NOT NULL DEFAULT 1,  -- COUNT(DISTINCT source_id) over research_pois for this POI
  status        text NOT NULL DEFAULT 'published', -- 'published' | 'draft' | 'hidden'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canonical_pois_geom_gix  ON canonical_pois USING gist (geom);
CREATE INDEX canonical_pois_name_trgm ON canonical_pois USING gin ((lower(name)) gin_trgm_ops);
```

> **Drop `UNIQUE (lng, lat)`.** Distinct real places can legitimately be a few meters apart
> (two adjacent campsites, a garden next to its visitor center), and canonical coordinates
> are chosen by precedence — uniqueness on raw coords is wrong now. De-duplication moves into
> the matching stage, not a DB constraint. Migrate `insertPois`'s `ON CONFLICT (lng,lat)`
> path accordingly (legacy direct-import becomes a staging write — see §9).

> **Category leaves the table** entirely (see §7). The old `pois.category` string column is
> replaced by the `canonical_poi_categories` join.

**Why `attributes jsonb` instead of more columns:** gardens carry `area_ha`,
`accreditation_level`, `visitors_annual`; campgrounds carry `electric`, `sewer`,
`max_rig_length_ft`, `pull_through`. Adding a typed column per attribute across every future
category is unsustainable. Keep **universal** fields typed (name/description/website/phone/
address/hours/photo) and put **category-specific** fields in `attributes` (optionally
validated per-category by a JSON schema we keep in `lib/db-map/contracts/`).

### 4.4 Attribution & provenance

Source attribution is a first-class concern (it drives popularity, the displayed "data from…"
credit, and the future per-source licensing review). It works at two levels and needs **no
extra link table** — the `research_pois.canonical_poi_id` foreign key already records exactly
which raw rows compose each canonical POI.

**Set-level attribution (which sources contributed at all).** A single join answers it:

```sql
-- every source behind a canonical POI, and the popularity count
SELECT s.slug, s.name, s.license, s.attribution
FROM research_pois r
JOIN research_sources s ON s.id = r.source_id
WHERE r.canonical_poi_id = $poi_id
GROUP BY s.id;

-- popularity (recomputed on every merge; same source twice ≠ +1)
UPDATE canonical_pois p
SET popularity = (
  SELECT COUNT(DISTINCT r.source_id)
  FROM research_pois r WHERE r.canonical_poi_id = p.id
)
WHERE p.id = $poi_id;
```

**Field-level attribution (which source supplied each published value).** Stored on
`canonical_pois.field_provenance` as JSON mapping each merged field to the winning source and
the exact research row it came from:

```jsonc
{
  "name":        { "source": "wikidata", "research_id": "…" },
  "description": { "source": "bgci",     "research_id": "…" },
  "website":     { "source": "osm",      "research_id": "…" },
  "coordinates": { "source": "ridb",     "research_id": "…" },
  "hours":       { "source": "osm",      "research_id": "…" }
}
```

This is what makes the deferred licensing pass tractable: to review/edit/omit content from one
source, query `field_provenance` for that source's slug (or `research_pois.source_id`) and you
get every canonical field — and every raw row — that depends on it, without re-running the
pipeline. The app's POI-detail read path can also use it (plus `research_sources.attribution`) to render
the correct credits.

### 4.5 Categories (see §7 for the model)

`canonical_categories`, `research_category_aliases`, `canonical_poi_categories` (the last links
`canonical_pois` ↔ `canonical_categories`).

### 4.6 Audit & override tables (reproducibility + correcting AI mistakes)

```sql
-- every match decision, so we can tune thresholds and explain merges
CREATE TABLE research_match_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id   uuid NOT NULL REFERENCES research_pois(id) ON DELETE CASCADE,
  candidate_poi_id uuid REFERENCES canonical_pois(id) ON DELETE SET NULL,
  score         real,
  signals       jsonb,        -- {name_sim, distance_m, embed_cos, shared_ids:[...]}
  decision      text NOT NULL,-- 'merge' | 'new'  (LLM is forced binary — Decision 3)
  method        text NOT NULL,-- 'strong_id' | 'auto' | 'llm' | 'override'
  llm_reason    text,         -- one-line rationale when method='llm', for later audit
  decided_at    timestamptz NOT NULL DEFAULT now()
);

-- OPTIONAL developer-only overrides the algorithm must ALWAYS respect (not a review queue)
CREATE TABLE research_match_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_a      uuid NOT NULL REFERENCES research_pois(id) ON DELETE CASCADE,
  record_b      uuid REFERENCES research_pois(id) ON DELETE CASCADE,
  rule          text NOT NULL,  -- 'force_same' | 'force_different'
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- geocode cache (cost & rate-limit control; also remembers misses so we never re-spend
-- budget on the same unresolvable address). A row with NULL lat/lng = a remembered miss.
CREATE TABLE research_geocode_cache (
  query_norm    text PRIMARY KEY,  -- normalized "name, city, region, country"
  lat           double precision,  -- NULL ⇒ remembered miss (query did not resolve)
  lng           double precision,
  precision     text,              -- 'rooftop' | 'city' | 'region' | 'none'
  provider      text,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
```

`research_match_overrides` is essential: when the AI inevitably merges two distinct places or splits
one, an operator records a `force_same`/`force_different` pair and every future run honors it.

---

## 5. The ingestion pipeline (stage by stage)

Each stage is an idempotent, re-runnable step with its own CLI. A new dump flows through all
of them; a re-pull of an existing source flows through the same steps and self-heals.

### Stage 1 — Extract (`ingest:extract <source> <file>`)

- One **adapter per source** implementing a common interface
  (`Extractor: (file) => RawRecord[]`). Adapters live in
  `lib/db-map/scripts/ingest/extractors/` (e.g. `osm.ts`, `bgci.ts`, `wikidata.ts`,
  `wikipedia.ts`, `arbnet.ts`, `ridb.ts`, `thedyrt.ts`, `uscampgrounds.ts`).
- **Stream-parse** large files — several inputs are 11–78 MB (`csv-parse` streaming, `ndjson`
  for JSONL). Never `JSON.parse` a 78 MB file into memory.
- Map each record to the common `research_pois` shape; keep the entire original row in
  `raw` (jsonb) for later re-derivation.
- **Upsert by `(source_id, source_record_id)`**: insert new rows; on existing rows update the
  source fields and bump `last_seen_at`.
- Compute `content_hash`. If it is **unchanged**, skip the row entirely (no downstream work). If it
  **changed**, reset the derived columns (`name_normalized`, `lat`/`lng`, `content_embedding`,
  `canonical_poi_id`) to NULL so the record re-flows through the stages.
- *(Deletion detection — marking rows that vanished from a re-pull — is deferred; for the
  "haphazard, add-more-data" POC we only ever add/update, never prune.)*

### Stage 2 — Normalize & categorize (`ingest:normalize`)

- **Validity gate (is this even a POI we want?).** A source dump routinely contains records that
  are *not* the place type we're collecting. Each source has a small **inclusion predicate**; rows
  that fail it stay in `research_pois` (for provenance) but are **never matched or published**.
  Real examples from the music-festivals dump (§15): the EDM Dance directory has `is_festival=true`
  on only 55 of 9,901 rows (the rest are club nights); Festivalando rows are editorial blog posts,
  not events. **Never promote non-POI rows.**
- **Names:** lowercase, strip diacritics, drop stopwords ("the", "el", "le"), expand/normalize
  abbreviations ("Bot. Gard." → "botanical garden", "Mt" → "mount"), strip legal suffixes →
  `name_normalized`.
- **Coordinates:** parse strings → numbers; detect & fix swapped lat/lng (the existing skill
  already documents this heuristic); range-check; set `geom`.
- **Value validation, not just presence (don't trust a field because it's non-empty).** Validate
  and sanitize each mapped value: normalize `country` (a value like "Bavaria" → "Germany"); confirm
  a `date` is an *event* date, not a publish/scrape timestamp; reject obviously-bad coordinates.
  A field being populated does not mean it's correct or means what its name says.
- **`website` vs `source_url`:** the place's **official** site goes in `website`; the source's own
  listing/detail page (MFW/Resident Advisor/FestivalAtlas URLs, etc.) goes in `source_url`. Never
  copy a directory/listing URL into `website` — that pollutes the canonical record and hides the
  fact that an official site is still missing.
- **Address:** split into city/region/country_code where possible.
- **website_domain / phone:** normalize to comparable forms (strong-ID signals).
- **Category mapping:** map `raw_category` → canonical category via `research_category_aliases`
  (§7). Unmapped raw categories are reported, not guessed, so the **developer** can extend the
  code-owned alias seed (Decision 5).
- **Coverage report, measured not assumed:** `ingest:normalize --report-coverage` prints the
  *actual* per-field fill rate per source (don't plan enrichment off guessed yields — §15).

### Stage 3 — Geocode the gaps (`ingest:geocode`)

- **Automatic & conditional** — the step processes exactly the rows where `lat IS NULL` (e.g.
  ArbNet captured only name+URL; Wikipedia tables give city not lat/lng). Records that already
  carry coordinates are never touched, so there's no flag and zero spend; we assume existing
  coordinates are correct.
- Forward-geocode `"name, city, region, country"` via **LocationIQ** (`docs/search/location-api.md`:
  5,000 req/day free, Nominatim-compatible, commercial-OK with attribution; pluggable provider).
  A success sets `lat`/`lng` (so the row is no longer selected next time).
- **Cache every lookup** in `research_geocode_cache` keyed by the normalized query — including
  **misses** (a cached row with NULL coords means "we tried this query and it didn't resolve").
  This dedupes identical queries across records and, crucially, stops us from re-spending budget
  retrying the same unresolvable addresses. A record whose query is a known miss simply stays
  coordinate-less and is never matched/published — no per-record status needed.
- **Budgeted, and it just stops** — geocoding is the only metered resource (LocationIQ free =
  5,000/day). `--geocode-limit` (default ~4,500) caps API calls per run; when the cap is reached
  the step **stops**. Nothing partial is recorded — rows that weren't reached still have
  `lat IS NULL`, so the next run simply continues with them. A large source is geocoded across as
  many days as it takes by re-running the same command.

### Stage 4 — Embed (`ingest:embed`)

- Compute `content_embedding` from `name_normalized + city + region + canonical category`.
- Only embed rows whose `content_hash` changed (incremental, cost-bounded).
- Model: a small, cheap text-embedding model (e.g. 384-dim like `bge-small`/`all-MiniLM`, or
  a hosted embeddings endpoint). Dimension is fixed in the column type; pick once.

### Stage 5+6 — Match & merge, one record at a time (`ingest:match`)

The de-duplication core — full detail in §6. Per Decision 2, this runs as a **resumable loop
that processes a single `source_record` at a time** rather than a giant batch: for each
`pending` record it blocks → scores → (LLM-)decides → attaches to an existing canonical POI or
creates a new one → **immediately recomputes that one canonical POI** from its cluster, then
moves to the next record. Match and merge are fused per record so the database is always in a
consistent, publishable state and a run can stop/resume at any point (see
[execution model](#execution-model-long-running--resumable)).

When a record attaches to (or creates) a canonical POI, that POI is rebuilt from all
`research_pois` rows that share its `canonical_poi_id`, and `field_provenance` is updated to
record which source won each field (§4.4):

- **Field precedence by source `trust`** for structured fields (coords, name, website,
  phone, hours, address). Government/official sources win coordinates; Wikidata/Wikipedia
  win names; etc.
- **Description / prose (Decision 4):** if only **one** source has content, publish it
  **verbatim**. If **multiple** sources have **differing** substantive content, use an
  **LLM to aggregate** them into one output (small cluster, merge time only — never for
  matching, and never to rewrite good single-source text).
- **attributes:** union/merge category-specific fields (e.g. OR the campground hookup
  booleans across sources; keep max `area_ha`).
- **categories:** union of all sources' mapped categories.
- **popularity:** `COUNT(DISTINCT source_id)`.

### Stage 7 — Report (`ingest:report`)

- Canonical POIs are `published` once they pass QA (have coordinates and ≥1 category); there
  is no licensing gate (Decision 1) and no human-review gate (Decision 3).
- Emit a **reconciliation report** (like the current import script does, but richer):
  records in, new vs. updated, matched-to-existing, new canonical created, LLM-adjudicated
  count, geocode failures, unmapped categories, popularity distribution.

### Orchestration

`ingest:run <source> <file>` chains the stages with flags (`--dry-run`, `--auto-threshold`,
`--geocode-limit N` (default ~4,500), `--no-llm`, `--limit N`). The **same command works for
every source** — geocoding fires automatically only for rows missing coordinates. Designed to be
run by hand today and by a scheduler later (§8). Because ingestion is chunked **per category × per
source**, a typical invocation processes one such chunk end to end.

```
extract → normalize → geocode → embed → [ match+merge per record ] → report
   ▲                                                  │
   └──────────────  safe to re-run any stage  ────────┘
```

### Execution model: long-running & resumable

Per Decision 2, the heavy stages (geocode, embed, match+merge) are built as **incremental,
checkpointed loops**, not one-shot batch jobs:

- **Work is a queue, defined by NULL-ness.** Each stage selects rows whose output column is still
  NULL (`name_normalized IS NULL` → normalize, `lat IS NULL` → geocode, `content_embedding IS
  NULL` → embed, `canonical_poi_id IS NULL` → match) and processes them one by one. No status
  columns; a changed `content_hash` resets those columns so the row re-flows.
- **Each record is its own transaction.** Block → score → decide → attach/create → recompute
  that canonical POI → commit. If the process dies, completed records are already saved and
  `pending` ones are simply picked up on the next run — no double-counting (popularity is a
  recomputed `COUNT(DISTINCT source_id)`, never an increment).
- **Bounded memory & API use.** Streaming reads, per-record commits, cached geocoding, and
  incremental embeddings keep a worldwide source from ever needing to fit in memory or hit an
  API twice.
- **`--limit` / `--resume`** let an operator (or scheduler) run a chunk, pause, and continue,
  which is exactly how we'll grind through large categories like the 284k campgrounds.

---

## 6. De-duplication algorithm in detail

For each `source_record` not yet confidently matched:

**Step A — Overrides first.** If a `research_match_overrides` rule touches this record, obey it
absolutely (force_same → that cluster; force_different → never merge those).

**Step B — Definitive-ID match.** If the record shares a *globally unique* id with an existing
canonical POI — a Wikidata QID or an OSM `(type,id)` — merge into that cluster immediately.
`method = 'strong_id'`, done (distance irrelevant; identity is proven). **Website domain and
phone are deliberately _not_ used as definitive keys here:** they are shared by chains,
reservation call centers, and government/social portals (`koa.com`, `recreation.gov`,
`facebook.com`), so treating them as definitive would collapse every KOA — or every national
park — into one POI. They instead feed Step D as weighted signals, and only when the
domain/phone is **not** on a maintained denylist of known multi-location operators.

**Step C — Spatial blocking.** Otherwise, fetch candidate canonical POIs within a
category-tuned radius using PostGIS:

```sql
SELECT id, name, geom, ... 
FROM canonical_pois
WHERE ST_DWithin(geom, $rec_geom, $radius_m)
ORDER BY geom <-> $rec_geom
LIMIT 25;
```

Radius is per-category (campsites cluster tightly → ~150 m; large gardens/parks → ~400–600 m).
**This is what stops embeddings from matching far-apart same-named places** — only nearby
candidates are ever scored.

**Step D — Pairwise score.** For each candidate compute a weighted composite:

| Signal | Source | Weight (starting point) |
|---|---|---|
| Name similarity | `pg_trgm` similarity + token-set / Jaro-Winkler on `name_normalized` | high |
| Embedding cosine | `content_embedding <=> candidate` | medium |
| Distance decay | `1 - dist/radius` | medium |
| City/region match | exact city or region equality | small boost |
| Website / phone | matching `website_domain` or `phone`, **excluding** denylisted chains/portals | medium boost |
| Soft-ID partial | same Wikipedia title, overlapping address tokens | small boost |

`score = Σ wᵢ·sᵢ`, normalized to 0–1.

**Step E — Decide by band.**

- `score ≥ T_high` (e.g. 0.85) → **auto-merge** into best candidate. `method = 'auto'`.
- `score ≤ T_low` (e.g. 0.55) → **new canonical POI**. `method = 'new'`.
- `T_low < score < T_high` → **gray zone → LLM (Decision 3)**: send both records' salient
  fields (names, address, distance, category, websites) and ask for a **binary** "same place?
  {yes|no} + one-line reason". `yes` → merge; `no` → new. The LLM is **forced to choose** —
  there is no `unsure`/review state and **no human queue**. `method = 'llm'`; the rationale is
  stored in `research_match_decisions.llm_reason`.
- LLM usage is **capped to the gray band only** → bounded cost (the deterministic bands and
  strong-ID shortcut handle the vast majority), and it avoids the "LLM is hard to quantify"
  problem because the model never decides the easy cases.

**Step F — Record** the decision + all signals in `research_match_decisions` (tuning + explainability).

**Tuning loop (now our primary safety net).** With no human review, the **golden set** is how
we keep quality honest. Maintain a small set of hand-labeled same/different pairs drawn from
the real dumps (e.g. the obvious Kew duplicates across BGCI/OSM/Wikidata/Wikipedia) and re-run
matching against it to measure **precision/recall** whenever we change weights, thresholds, or
the LLM prompt. This turns "is the matcher good?" into a number — essential because the LLM is
the last line of defense. When it gets something wrong in production, fix it with a
`research_match_overrides` rule (developer, in code/SQL) and, ideally, add the pair to the golden set.

**Cluster transitivity.** Matches are pairwise; collapse them with union-find so A≡B and
B≡C ⇒ one cluster {A,B,C} → one canonical POI.

**Recurring events collapse to one canonical (don't duplicate per edition).** For event-type
POIs (festivals), sources list multiple **editions** of the same festival (2024, 2025, 2026) and
multiple sources list the same edition. All of these must merge into **one** canonical festival —
not one POI per year. Same-venue + same-name editions merge naturally (high name similarity, ~0 m
distance). The merge keeps the festival as the entity and stores edition dates in `attributes`
(§15). Edge case to watch: a festival that **changes city/venue** between years may not block
together geographically — flag for the golden set.

---

## 7. Categories, taxonomy & aliases

The user gave three concrete requirements; this model satisfies all of them.

> **Taxonomy is code-owned (Decision 5).** Categories, slugs, parents, and aliases are defined
> in a **committed seed file** in the repo (e.g. `lib/db-map/scripts/ingest/taxonomy.ts` →
> seeded into the tables below) and edited **only by the developer in source**, because they
> are tightly coupled to the generative-AI prompts and matching code. There is **no in-app or
> admin-UI editing**. The tables below are the runtime projection of that seed; changing the
> taxonomy means editing the seed file and re-running the seed migration in a PR.

### Schema

```sql
CREATE TABLE canonical_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,     -- STABLE id, never changes: 'free_flight', 'rv'
  display_name  text NOT NULL,            -- shown in UI, freely renamable
  parent_id     uuid REFERENCES canonical_categories(id), -- hierarchy (campground → rv/tent/backpacker)
  description   text,
  icon          text,
  color         text,
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- raw source strings → canonical category (drives Stage-2 categorization)
CREATE TABLE research_category_aliases (
  alias         text NOT NULL,            -- 'garden:type=botanical', 'caravan', 'paragliding'
  category_id   uuid NOT NULL REFERENCES canonical_categories(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES research_sources(id), -- NULL = applies to all sources
  PRIMARY KEY (alias, category_id, source_id)
);

-- a place can be in many categories
CREATE TABLE canonical_poi_categories (
  poi_id        uuid NOT NULL REFERENCES canonical_pois(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES canonical_categories(id) ON DELETE CASCADE,
  is_primary    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (poi_id, category_id)
);
```

### How it satisfies each requirement

- **Multiple categories per place** → `canonical_poi_categories` many-to-many. A flying site row can be
  linked to `free_flight`, `hang_gliding`, `paragliding`, and `gliderport` simultaneously.
- **Rename a category** ("flying site" → "free flight") → update `categories.display_name`.
  The **slug stays `free_flight`**, so every link and alias keeps working; nothing else
  changes. (If we want the old name to keep mapping incoming data, add it to
  `research_category_aliases`.)
- **Similar-but-distinct + overlap** (garden / arboretum / sculpture park; indoor/outdoor;
  public/private) → model each as its own category, use `parent_id` for grouping (e.g.
  `arboretum` and `botanical_garden` under a `gardens` parent), and let a place hold multiple
  memberships. The UI can offer "show all gardens" (parent) or each leaf separately.
- **Overlapping function** (campground → backpacker / tent / rv / airstream; all still
  "campground") → `campground` is the parent; the specific types are children; a site that is
  both RV and tent gets both child links **and** inherits the parent at query time.
- **Locale naming** ("RV" vs "caravan") → store one canonical slug (`rv`); the front-end maps
  slug → localized label. Source strings like `caravan_site`/`tourism=caravan_site` are just
  aliases pointing at `rv`.

### Query-time category expansion

The map filter takes a category slug; the API expands it to itself + descendants so picking
"campground" returns RV + tent + backpacker sites. Store the closure or compute it with a
recursive CTE.

### Unmapped-category report

Stage 2 emits any `raw_category` that has no alias, so the team continuously extends
`research_category_aliases` instead of silently dropping or misfiling data.

---

## 8. Continuous / repeated ingestion & popularity

Data changes; we will re-run the same sources forever and add new ones. The design makes
this safe by construction.

- **Same source, re-pulled:** Stage 1 upserts by `(source_id, source_record_id)`. Existing rows
  update (and bump `last_seen_at`); unchanged rows (same `content_hash`) are skipped entirely.
  **Popularity does not move** because it counts *distinct sources*, and this is the same source.
  (Detecting places *removed* from a source is deferred — we only add/update for now.)
- **New source, same place:** a new `source_record` matches an existing canonical POI during
  match+merge (its `canonical_poi_id` points at that POI), and `popularity` increments by one (new distinct
  source). Exactly the user's definition: *popularity = how many sources it appears in*,
  un-normalized, used only to sort search results.
- **Re-merge after algorithm/threshold/prompt improvements:** because raw rows are intact,
  re-run match+merge to rebuild canonical POIs without re-fetching anything. `research_match_overrides`
  keep developer corrections sticky across re-runs.
- **Scheduling (later):** wrap `ingest:run` in a cron/worker (Railway scheduled job or GitHub
  Action) per source on its own cadence. Incremental `content_hash` checks keep repeat runs
  cheap.

---

## 9. Scripts & utilities to build and maintain

New package area: `lib/db-map/scripts/ingest/` (or a dedicated `lib/ingest` workspace package
if it grows). Proposed `package.json` scripts (mirroring existing `db:import:*` style):

| Command | Purpose |
|---|---|
| `ingest:extract <source> <file>` | Adapter → upsert `research_pois` (streamed, idempotent) |
| `ingest:normalize [--source S]` | Clean names/coords/address, map categories |
| `ingest:geocode [--limit N]` | Fill missing coords via LocationIQ + cache |
| `ingest:embed` | Compute embeddings for changed rows |
| `ingest:match [--dry-run] [--auto-threshold] [--limit N] [--resume] [--no-llm]` | Per-record conflation **and** canonical rebuild (Stage 5+6); LLM auto-decides the gray zone |
| `ingest:report` | Reconciliation + QA stats |
| `ingest:run <source> <file>` | Orchestrate all of the above for one category × source chunk |
| `ingest:override <a> <b> same\|different` | Developer-only: write a `research_match_overrides` rule (not a review queue) |
| `ingest:taxonomy:seed` | Seed/refresh `canonical_categories` + `research_category_aliases` from the committed taxonomy source file |

Shared building blocks to maintain:

- **`extractors/`** — one file per source; a registry mapping `slug → Extractor`. Each new
  data dump = one new small adapter, nothing else.
- **`normalize/`** — name/address/phone/coord normalizers (shared, unit-tested).
- **`match/`** — per-record loop: blocking, scoring, thresholds, strong-ID shortcut,
  union-find clustering, the **binary LLM adjudicator**, and the golden-set evaluator.
- **`merge/`** — field-precedence resolver + **conditional** description aggregator (verbatim
  for single-source; LLM fusion only when multiple sources disagree — Decision 4).
- **`geocode/`** — pluggable provider client + cache.
- **`taxonomy.ts`** — the committed, code-owned category/alias seed (Decision 5).
- **Migrate the existing skill/scripts:** `db:import:json` / `db:import:kml` become thin
  adapters that write into **`research_pois`** (source `slug` from a flag) instead of
  straight into `canonical_pois`. Update `.cursor/skills/import-pois/SKILL.md` and
  `lib/db-map/IMPORTING.md` to the new staging-first flow. The old direct-to-`canonical_pois`
  behavior is retired so we never bypass dedup again.

Testing utilities (so we can trust the pipeline):

- Unit tests for each extractor (sample fixture rows → expected `research_pois`).
- Unit tests for normalizers (swapped coords, accents, abbreviations).
- A **golden-set** harness reporting matcher precision/recall on labeled real pairs.
- `--dry-run` everywhere, and a `pnpm ingest:run … --dry-run` that prints the full
  reconciliation without writing.

---

## 10. Worked examples (gardens + RV campgrounds)

### Botanical gardens (8 sources, ~20,720 rows, heavy overlap)

- **Strong-ID heaven:** OSM rows carry `wikidata`/`wikipedia`; Wikidata rows carry QIDs;
  BGCI/ArbNet carry their own ids. Step B merges most cross-source duplicates *deterministically*
  before any fuzzy scoring — e.g. Kew appears in BGCI + OSM + Wikidata + Wikipedia and collapses
  via shared QID/website.
- **Geocode the coordinate-less:** ArbNet captured only name+URL; Wikipedia/Gardenology give
  city not lat/lng → Stage 3 geocodes "name, city, state, country".
- **Categories:** alias `garden:type=botanical` (OSM), "botanical garden"/"arboretum"
  (Wikipedia/ArbNet) → canonical `botanical_garden` / `arboretum`, both under a `gardens`
  parent. A place in both lists ends with both leaf links.
- **Field precedence:** BGCI ("MOST COMPLETE", official network) wins area/accreditation
  attributes; Wikidata wins canonical name; OSM wins coordinates when present.
- **Popularity:** Kew links ~5–6 sources → high popularity; an obscure ArbNet-only arboretum
  → popularity 1.

### RV / caravan campgrounds (4 sources, ~284,345 rows)

- **Scale:** spatial blocking + `content_hash` skipping are mandatory at this size; this is
  why PostGIS + streaming parse are in the plan.
- **RIDB facilities vs. campsites:** map each **facility** to one POI; aggregate the
  121,876 child campsites' hookup attributes up to the facility's `attributes` (e.g.
  `has_electric`, `has_sewer`, `max_rig_length_ft`). Don't create a POI per campsite.
- **OSM as location-only:** the dump notes OSM hookup tags are sparse — treat OSM as
  coordinate truth and enrich hookups from The Dyrt/RIDB/uscampgrounds.
- **Licensing (deferred — Decision 1):** all four sources, including the proprietary The Dyrt
  scrape, are **display-eligible** in the POC and their content can be published verbatim. We
  record each source's `license`/`attribution` as metadata to revisit per source later, but
  nothing is gated now.
- **Categories:** `tourism=caravan_site` / `caravans=yes` / `rv_hookup` → `rv`; tent-only →
  `tent`; all under `campground` parent. "Caravan" is just an alias for the `rv` slug.
- **Staleness:** uscampgrounds.info is 2014 data — ingest as seed, let newer sources override
  fields; if a 2014-only site never reappears, it stays (popularity 1) but is flagged old via
  `last_seen_at`.

---

## 11. Things we should plan for now

Beyond the explicit requirements, decide these up front so we don't repaint later:

1. **Licensing — recorded, not enforced (Decision 1).** Keep `research_sources.license` /
   `attribution` as metadata to revisit later *per category, per source*, but do **not** gate
   ingestion or display in the POC. Capturing the metadata now is cheap and avoids a re-scrape
   when we do the legal pass.
2. **Long-running, resumable processing (Decision 2)** — heavy stages are checkpointed
   per-record loops, not all-at-once batches; ingestion is chunked per category × source. See
   the [execution model](#execution-model-long-running--resumable).
3. **PostGIS adoption + dropping `UNIQUE(lng,lat)`** — required for blocking and for allowing
   genuinely-near distinct places.
4. **Flexible `attributes jsonb`** + optional per-category JSON-schema validation — so each
   new category's fields don't require a migration.
5. **Reversibility & overrides** (`research_match_overrides`, `research_match_decisions`) — the AI *will* make
   mistakes; since there's no human review (Decision 3), we need to correct them in code
   stickily and explain every merge.
6. **Golden-set evaluation — the primary quality gate** — quantify matcher precision/recall
   before trusting the LLM-auto-decide pipeline on 284k rows; re-check on every threshold/prompt
   change.
7. **Geocode cost/rate control** (`research_geocode_cache`, provider abstraction) — per the
   `location-api.md` research; start LocationIQ free tier, keep a self-host-Nominatim path.
8. **Data-quality QA gates** — reject/flag coords in the ocean, country-vs-coordinate
   mismatches, obviously swapped lat/lng, empty names.
9. **Photos & media** — today `photo_url` hotlinks; decide on storage (R2/Supabase) later
   (media rights ride along with the deferred licensing pass — Decision 1).
10. **Observability** — an `ingest_runs` metrics row per execution (counts, durations, failure
    rates) for dashboards and regression alerts.
11. **Coordinate precision/privacy** — round published coords to ~6 dp.
12. **Canonical-ID stability** — never churn `canonical_pois.id` on re-merge (the app/users
    may reference it); update in place.
13. **Scale path** — indexes above handle low millions; revisit partitioning/tiling beyond
    that.

---

## 12. Phased rollout

Each phase is independently shippable and leaves the app working.

- **Phase 0 — Schema foundations.** Migrations for extensions, `research_sources`,
  `research_pois`, the renamed + revised `canonical_pois` (`ALTER TABLE pois RENAME TO
  canonical_pois`, then +`geom`, `attributes`, `field_provenance`, `popularity`, drop
  `UNIQUE(lng,lat)`), the category tables (`canonical_categories`,
  `canonical_poi_categories`, `research_category_aliases`), and the
  `research_match_decisions` / `research_match_overrides` / `research_geocode_cache` tooling
  tables. Run `pnpm db:sync`, commit generated artifacts. Seed the existing canonical rows into
  `research_pois` under a `manual`/`legacy` source (with `canonical_poi_id` pointing back at
  themselves) so today's data keeps its attribution and nothing is lost.
- **Phase 1 — Extractors + staging.** Common `Extractor` interface, `research_sources` registry,
  `ingest:extract`, streaming parsers. Adapters for the 12 example sources. Land both example
  dumps into `research_pois` (no publishing yet).
- **Phase 2 — Normalize + categorize.** Normalizers, `research_category_aliases` seed for gardens &
  campgrounds, unmapped-category report.
- **Phase 3 — Geocode.** LocationIQ client + `research_geocode_cache`; fill coordinate gaps.
- **Phase 4 — Embed + match/merge.** pgvector embeddings; the **per-record, resumable**
  match+merge loop: blocking, scoring, thresholds, strong-ID shortcut, **binary LLM
  adjudicator**, union-find, per-record canonical rebuild, field precedence, conditional
  (verbatim-vs-LLM) description, popularity, `canonical_poi_categories`, `research_match_decisions`, and the
  golden-set harness. Publish gate = coords + category only (no licensing/review gate).
- **Phase 5 — App read path.** Update `listPoisGeoJson` / detail / categories endpoints for
  the new category model + popularity sort; category expansion; keep the GeoJSON shape stable.
- **Phase 6 — Automation & ops.** `ingest:run` orchestrator with `--resume`/`--limit`,
  scheduling, `ingest_runs` metrics, `ingest:override` for corrections, retire direct
  `db:import:*`-to-`canonical_pois`; update skill + docs.

---

## 13. Product decisions (resolved)

These were open questions in the first draft; the product owner has now answered them. They
are restated here (and drive §0) so the document is self-contained.

| # | Question | Decision |
|---|---|---|
| 1 | Licensing — gate display on it? | **No.** Ignore licensing for the POC; use the best data; publish source content verbatim. Store `license`/`attribution` as metadata to revisit later *per category, per source*. No "enrichment-only" sources. |
| 2 | Global from day one? | **Yes, but chunked.** Worldwide coverage, ingested one **category × source** at a time. Scripts must be **long-running, resumable, one-record-at-a-time** processes. |
| 3 | Human review appetite? | **None.** The LLM **always auto-decides** the gray zone (forced binary). No review queue/UI. Optional developer-only `research_match_overrides` for after-the-fact corrections in code. |
| 4 | AI-written descriptions? | **Verbatim first.** One source → publish its text as-is. Multiple sources with differing content → LLM aggregates. Never rewrite good single-source prose. |
| 5 | Category taxonomy ownership? | **Code-owned.** Slugs/parents/aliases live in a committed seed file edited only by the developer (coupled to the AI prompts/matching code). No in-app/admin editing. |

---

## 14. Implementation risks & refinements to watch

A skeptical-engineer pass over the design. None of these change the architecture — they sharpen
it — but each is a trap that would otherwise surface mid-build or in production. Capturing them
now so they're not rediscovered the hard way.

1. **Incremental matching is order-dependent.** Matching one record at a time against
   *already-merged* canonical POIs can produce different clusters depending on ingestion order,
   and can leave two canonical POIs un-merged because neither existed when the other was
   created. Mitigation: (a) a periodic **full re-cluster** pass (safe — raw rows are intact),
   and (b) a **canonical-vs-canonical merge** check after each chunk that looks for near-duplicate
   canonical rows.

2. **Not every source has a stable record id.** `UNIQUE(source_id, source_record_id)` is the
   idempotency anchor, but Wikipedia-table / Gardenology rows have no natural id. The extractor
   must **synthesize a deterministic id** (e.g. a hash of source + normalized name + locality)
   so re-pulls land on the same row instead of duplicating inside the research layer.

3. **Website/phone are not safe merge keys** (already corrected in §6). Only Wikidata/OSM ids
   are definitive; domain/phone need a chain/portal denylist and act only as scoring signals.

4. **Attribute vocabulary needs aliasing too.** Sources name the same attribute differently
   (`electric_hookups` vs `Electricity Hookup` vs `E`). Define a **canonical attribute key set
   per category** in the code-owned taxonomy and map source attrs → canonical keys during
   normalize — exactly like category aliases — or the `attributes` jsonb merge becomes an
   inconsistent grab-bag.

5. **Garbage-collect orphaned canonicals.** Re-clustering or an override can leave a
   `canonical_pois` row with zero linked `research_pois`. Sweep these to `status='hidden'` (or
   delete) so the map never shows an empty merge.

6. **Geocode precision should gate match confidence.** A city/region-centroid geocode is not a
   real location. When a candidate's coordinates came from a low-`precision` geocode, the
   matcher should widen the radius / lower confidence / refuse auto-merge, so we never merge two
   places onto the same fuzzy centroid.

7. **Deletion detection is deferred (no `is_stale`).** For the POC we only add/update; a place
   removed from a source is *not* pruned. If/when this matters, add deletion detection via
   `last_seen_at` (e.g. stop counting a source that has dropped a place for N consecutive full
   re-pulls) rather than re-introducing a per-row status flag.

8. **Single-writer matching (concurrency).** The "find-nearby-or-create" step races if
   parallelized — two workers could create two canonical POIs for one place. Keep matching
   single-writer (per region) or use advisory locks / a unique guard before scaling out.

9. **Embedding model is pinned by the column type.** `vector(384)` hard-codes the model's
   dimension; switching models means a migration + full re-embed. Record the model name/version
   in config and treat a model change as a deliberate, planned re-embed.

10. **Keep `geom` in lockstep with `lat`/`lng`.** Simplest is a generated column
    (`GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography) STORED`) so the
    spatial column can never drift from the raw coordinates.

11. **Confirm pgvector on the host.** Same caveat as PostGIS — verify the Railway Postgres
    image ships the `vector` extension (or switch images) before Phase 4.

---

## 15. Lessons from real source data (validity, value-checking, event POIs)

The music-festivals dump (`docs/poi/music-festivals/`, see its `GAP_ANALYSIS.md` and the review on
PR #12) stress-tested this plan against 35 messy sources and surfaced concrete pitfalls. Each maps
to a rule the pipeline must enforce. These generalize to **every** future category.

### 15.1 A source dump is not a POI list — gate validity per source

Many rows in a "festivals" dump are not festivals: the EDM Dance directory marks only **55 of
9,901** rows `is_festival=true` (the rest are club nights); Festivalando rows are **editorial blog
posts**, not events. → Stage 2's **inclusion predicate** (per source) decides what is promotable;
failing rows stay in `research_pois` for provenance but never reach `canonical_pois`. Without this
we'd import club nights and blog articles as map POIs.

### 15.2 Listing/source URLs are not official websites

Several sources expose a `url`/`source_url` that is their **own listing page** (Music Festival
Wizard has an official `website` on 1 of 10,800 rows but an MFW `url` on all of them; Resident
Advisor and FestivalAtlas have **zero** official sites but a source page each). Counting those as
"website covered" both hides the real gap and risks publishing a directory page as the festival's
site. → Keep `website` (official) and `source_url` (provenance/listing) **separate** (schema +
normalize rule, §4.2 / §5). Detail-page enrichment (below) is what actually fills `website`.

### 15.3 Validate values, don't trust field presence

A populated field can be wrong or mean something else:

- **`country` holding sub-national regions** — Festival Alarm stores "Bavaria" etc. instead of
  "Germany". Normalize regions → country (lookup table).
- **publish/scrape timestamps masquerading as event dates** — Festivalando `date` is the article's
  publish time; using it would put non-festival articles on the map with bogus dates.
- **misread yields** — MusicBrainz location/website live nested in `relations[]`; coordinates are
  present on only ~15.7k of 30.3k rows and `country` on ~123, far below an eyeballed "99%".
  → Stage 2 **validates/sanitizes** values, and `--report-coverage` measures *actual* per-field
  fill rates so we never plan enrichment off phantom data.

### 15.4 Status/recency is computed from dates, never stored as a frozen flag

This is the same principle that removed our status columns (§4.2). A festival's
upcoming/active/past state depends on its dates **vs. the current date**: hard-coding "max year ≥
2025 = active" (on a 2026 run) or "all Resident Advisor rows are active" (3,202 of 3,525 are
already past) is wrong. MusicBrainz `life_span.ended=true` is set on 29,887 of 30,276 rows
including future events, so it is **not** an active flag either. → For event POIs, store
`start_date`/`end_date` in `attributes` and **derive** status at read/query time from those dates;
store no `active` boolean.

### 15.5 Time-bound / event POIs (festivals) are a new POI shape

Gardens and campgrounds are permanent places; festivals are **events**. The model already handles
them, with these specifics:

- **Dates in `attributes`** (`start_date`, `end_date`, recurrence) — typed core columns stay
  place-generic; event specifics live in the per-category `attributes` jsonb.
- **One canonical per festival, not per edition** — sources list 2024/2025/2026 editions of the
  same festival; they merge into one canonical (§6 "Recurring events collapse"). Keep the
  next/most-recent edition's dates; optionally keep an edition history in `attributes`.
- **Status derived at read time** (15.4). The map/search can then filter "upcoming this season"
  without any stored, staleness-prone flag.
- **Geocoding by text location is fine** — festivals rarely ship coordinates, but they have
  city/country/venue. Our Stage 3 already geocodes `"name, city, region, country"`; the festivals
  data simply leans on it more heavily than gardens/campgrounds did.

### 15.6 Detail-page enrichment is a legitimate stage — with one guardrail

The festivals plan fills gaps (official `website`, dates, venue) by fetching each record's **own
detail page** (JSON-LD `Event` schema / Wikidata via `wikipedia_url`). This is a reasonable
optional **enrichment stage** between geocode and embed — but only when the stored URL is **truly
per-record**: Festival Alarm's `source_url` has just **27 distinct values across 5,104 rows**
(category/listing pages), so crawling it as if it were per-festival would fetch the same listing
repeatedly and fill nothing. → If we add enrichment, gate it on "URL is unique per record," cache
fetched pages, and obey the same budget/robots discipline as geocoding. (Public Nominatim's
bulk-use limits, flagged in the review, are already why we use LocationIQ + cache, §5/§14.)

### 15.7 Net effect on the plan

No architectural change — the two-layer model, NULL-ness processing, and conflation all hold. The
additions are: a per-source **validity predicate** and **value validation** in Stage 2, the
`source_url`/`website` split, **measured** coverage reporting, **read-time status** for event
POIs, **recurring-edition** dedup in matching, and an optional **detail-page enrichment** stage
with a per-record-URL guardrail.
