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
13. [Open product questions](#13-open-product-questions)

---

## 1. The problem with what we have today

Current state (verified in the repo):

- **One flat table** `pois` (`lib/db-map/migrations/202605241200__baseline.sql`): `name`,
  `category` (a free-text string), `lng`, `lat`, plus a few optional text columns.
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
                 EXTRACT          NORMALIZE / GEOCODE        MATCH / MERGE         PUBLISH
  raw files  ─────────────▶  source_records  ───────────▶  (conflation)  ─────▶   pois
 (CSV/JSON/                  (one row per source           clustering of      (one row per real
  JSONL/KML)                  record, kept forever)         duplicates          place; the only
                                                                                table the app reads)
```

- **Raw / research layer — `source_records`**: one row per record **per source**, kept
  forever, never shown on the map. This is the data-science workspace where we compare,
  normalize, and de-duplicate. Re-ingesting a source updates these rows in place (keyed by
  the source's own id), so the same source never inflates anything.
- **Canonical / validated layer — `pois`**: one row per **real place**, built by merging a
  cluster of `source_records`. This is the *only* table the map API reads. It carries the
  merged/best attributes, the multi-category memberships, and the popularity score.

A link table (`poi_source_records`) records exactly which raw records compose each canonical
POI. Everything downstream — popularity, attribution, "where did this name come from",
re-merging after a fix — derives from that link.

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
3. **Decision** — threshold the score: auto-merge / auto-separate / send the gray zone to a
   tie-breaker (LLM and/or human).
4. **Clustering & merge** — group all "same" records into one cluster and synthesize the
   canonical record (field precedence + LLM summary for prose).

The LLM is used **only as a bounded tie-breaker in the ambiguous middle band**, not as the
primary matcher — which neatly sidesteps the user's "LLM is hard to quantify" and "embeddings
ignore distance" problems. Cheap deterministic signals decide the easy 90%; the LLM adjudicates
the expensive 10%.

**Strong identifiers short-circuit everything.** If two records share a Wikidata QID, an OSM
`(type,id)`, the same website domain, or the same phone number, they are the same place by
definition — merge immediately, skip scoring. The dumps are full of these
(`wikidata`/`wikipedia` cross-refs in OSM, `wikidata_id`, BGCI ids, etc.).

---

## 4. Target database schema

All changes ship as timestamped migrations in `lib/db-map/migrations/`, followed by
`cd lib/db-map && pnpm db:sync` to refresh `schema/current.sql`, generated types, and
contracts (per `AGENTS.md`).

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

### 4.1 `sources` — provenance & licensing

```sql
CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,        -- 'osm', 'bgci', 'wikidata', 'thedyrt', 'ridb'
  name          text NOT NULL,
  homepage      text,
  license       text,                        -- 'ODbL', 'CC0', 'CC-BY-SA', 'proprietary', ...
  attribution   text,                        -- exact text we must display, if any
  display_allowed boolean NOT NULL DEFAULT true,  -- false = use for dedupe only, never show
  trust         integer NOT NULL DEFAULT 50, -- 0-100, field-precedence weight
  last_ingested_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

`display_allowed` is the legal kill-switch: e.g. proprietary scrapes (The Dyrt) may only be
allowed to *boost popularity / fill blanks*, never to be the displayed source of truth.
`trust` orders field precedence during merge (government/official > Wikidata > OSM > scrape).

### 4.2 `source_records` — the raw research layer

```sql
CREATE TABLE source_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES sources(id),
  source_record_id text NOT NULL,            -- the source's OWN id (osm_id, wikidata_id, bgci_id, dyrt id)
  ingest_category text,                       -- which dump/run this came from, e.g. 'botanical_garden'

  -- normalized common fields (best-effort, nullable)
  name            text,
  name_normalized text,                       -- lowercased, de-accented, de-noised (for trgm)
  description     text,
  website         text,
  website_domain  text,                       -- normalized eTLD+1, a strong-ID signal
  phone           text,                       -- E.164 where possible, a strong-ID signal
  email           text,
  address         text,
  city            text,
  region          text,                       -- state/province
  country_code    text,                       -- ISO-2
  lat             double precision,
  lng             double precision,
  geom            geography(Point, 4326),     -- set from lat/lng (NULL until geocoded)
  geocode_status  text NOT NULL DEFAULT 'unknown', -- 'present' | 'geocoded' | 'failed' | 'unknown'

  raw_category    text,                       -- the source's category string, pre-mapping
  raw             jsonb NOT NULL,             -- the full original record, verbatim
  attributes      jsonb,                      -- extracted structured attrs (hookups, area_ha, ...)

  content_embedding vector(384),              -- name + locality + category embedding
  content_hash    text,                       -- hash of normalized fields; skip work if unchanged

  canonical_poi_id uuid REFERENCES pois(id) ON DELETE SET NULL, -- match result
  match_status    text NOT NULL DEFAULT 'pending', -- pending|matched|new|review|rejected
  match_score     real,
  match_method    text,                       -- 'strong_id'|'auto'|'llm'|'human'|'new'

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  is_stale        boolean NOT NULL DEFAULT false,  -- vanished from latest pull

  UNIQUE (source_id, source_record_id)        -- ← idempotency anchor
);

CREATE INDEX source_records_geom_gix   ON source_records USING gist (geom);
CREATE INDEX source_records_name_trgm  ON source_records USING gin (name_normalized gin_trgm_ops);
CREATE INDEX source_records_embed_hnsw ON source_records USING hnsw (content_embedding vector_cosine_ops);
CREATE INDEX source_records_canon_idx  ON source_records (canonical_poi_id);
CREATE INDEX source_records_status_idx ON source_records (match_status);
```

The `UNIQUE (source_id, source_record_id)` constraint is what makes re-ingestion safe: the
same record from the same source always lands on the same row (upsert), so nothing
duplicates and popularity never double-counts.

### 4.3 `pois` — the canonical / validated layer (revised)

```sql
CREATE TABLE pois (
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
  popularity    integer NOT NULL DEFAULT 1,  -- COUNT(DISTINCT source_id) among linked records
  status        text NOT NULL DEFAULT 'published', -- 'published' | 'draft' | 'hidden'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pois_geom_gix     ON pois USING gist (geom);
CREATE INDEX pois_name_trgm    ON pois USING gin ((lower(name)) gin_trgm_ops);
```

> **Drop `UNIQUE (lng, lat)`.** Distinct real places can legitimately be a few meters apart
> (two adjacent campsites, a garden next to its visitor center), and canonical coordinates
> are chosen by precedence — uniqueness on raw coords is wrong now. De-duplication moves into
> the matching stage, not a DB constraint. Migrate `insertPois`'s `ON CONFLICT (lng,lat)`
> path accordingly (legacy direct-import becomes a staging write — see §9).

> **Category leaves the `pois` table** entirely (see §7). The `pois.category` string column
> is replaced by the `poi_categories` join.

**Why `attributes jsonb` instead of more columns:** gardens carry `area_ha`,
`accreditation_level`, `visitors_annual`; campgrounds carry `electric`, `sewer`,
`max_rig_length_ft`, `pull_through`. Adding a typed column per attribute across every future
category is unsustainable. Keep **universal** fields typed (name/description/website/phone/
address/hours/photo) and put **category-specific** fields in `attributes` (optionally
validated per-category by a JSON schema we keep in `lib/db-map/contracts/`).

### 4.4 `poi_source_records` — link / provenance

```sql
CREATE TABLE poi_source_records (
  poi_id           uuid NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  PRIMARY KEY (poi_id, source_record_id)
);
```

`popularity = COUNT(DISTINCT sr.source_id)` over the linked records — recomputed on every
merge. Appearing again in the *same* source does not change it; appearing in a *new* source
increments it.

### 4.5 Categories (see §7 for the model)

`categories`, `category_aliases`, `poi_categories`.

### 4.6 Audit & override tables (reproducibility + correcting AI mistakes)

```sql
-- every match decision, so we can tune thresholds and explain merges
CREATE TABLE match_decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  candidate_poi_id uuid REFERENCES pois(id) ON DELETE SET NULL,
  score         real,
  signals       jsonb,        -- {name_sim, distance_m, embed_cos, shared_ids:[...]}
  decision      text NOT NULL,-- 'merge' | 'new' | 'review' | 'reject'
  method        text NOT NULL,-- 'strong_id' | 'auto' | 'llm' | 'human'
  decided_at    timestamptz NOT NULL DEFAULT now()
);

-- human/operator overrides the algorithm must ALWAYS respect
CREATE TABLE match_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_a      uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  record_b      uuid REFERENCES source_records(id) ON DELETE CASCADE,
  rule          text NOT NULL,  -- 'force_same' | 'force_different'
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- geocode cache (cost & rate-limit control)
CREATE TABLE geocode_cache (
  query_norm    text PRIMARY KEY,  -- normalized "name, city, region, country"
  lat           double precision,
  lng           double precision,
  precision     text,              -- 'rooftop' | 'city' | 'region' | 'none'
  provider      text,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
```

`match_overrides` is essential: when the AI inevitably merges two distinct places or splits
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
- Map each record to the common `source_records` shape; keep the entire original row in
  `raw` (jsonb) for later re-derivation.
- **Upsert by `(source_id, source_record_id)`**: insert new, update `last_seen_at` +
  changed fields on existing, set `is_stale = true` for rows not present in this pull.
- Compute `content_hash`; if unchanged, skip the expensive downstream work for that row.

### Stage 2 — Normalize & categorize (`ingest:normalize`)

- **Names:** lowercase, strip diacritics, drop stopwords ("the", "el", "le"), expand/normalize
  abbreviations ("Bot. Gard." → "botanical garden", "Mt" → "mount"), strip legal suffixes →
  `name_normalized`.
- **Coordinates:** parse strings → numbers; detect & fix swapped lat/lng (the existing skill
  already documents this heuristic); range-check; set `geom`.
- **Address:** split into city/region/country_code where possible.
- **website_domain / phone:** normalize to comparable forms (strong-ID signals).
- **Category mapping:** map `raw_category` → canonical category via `category_aliases`
  (§7). Unmapped raw categories are reported, not guessed, so a human can extend the alias
  table.

### Stage 3 — Geocode the gaps (`ingest:geocode`)

- For rows with no usable coordinates (e.g. ArbNet captured only name+URL; Wikipedia tables
  give city not lat/lng), forward-geocode `"name, city, region, country"`.
- Use **LocationIQ** (recommended in `docs/search/location-api.md`: 5,000 req/day free,
  Nominatim-compatible, commercial-OK with attribution). Provider is pluggable.
- **Cache every lookup** in `geocode_cache` keyed by normalized query — re-runs cost nothing,
  and we respect rate limits.
- Records that can't be geocoded get `geocode_status = 'failed'` and are **parked** (not
  matched, not published) until coordinates appear. They still count as research data.

### Stage 4 — Embed (`ingest:embed`)

- Compute `content_embedding` from `name_normalized + city + region + canonical category`.
- Only embed rows whose `content_hash` changed (incremental, cost-bounded).
- Model: a small, cheap text-embedding model (e.g. 384-dim like `bge-small`/`all-MiniLM`, or
  a hosted embeddings endpoint). Dimension is fixed in the column type; pick once.

### Stage 5 — Match / conflate (`ingest:match`)

The de-duplication core — full detail in §6. Produces, for each `source_record`: a
`canonical_poi_id` (existing or newly created), a `match_status`, a `match_score`, and an
audit row in `match_decisions`.

### Stage 6 — Merge / promote (`ingest:merge`)

- For each canonical cluster, (re)build the `pois` row from its linked `source_records`:
  - **Field precedence by source `trust`** for structured fields (coords, name, website,
    phone, hours, address). Government/official sources win coordinates; Wikidata/Wikipedia
    win names; etc.
  - **Description:** either longest non-empty, or an **LLM-aggregated summary** that fuses the
    prose from all sources into one neutral blurb (this is the user's "use LLM to aggregate
    text content" idea — applied at merge time, on a small cluster, not for matching).
  - **attributes:** union/merge category-specific fields (e.g. OR the campground hookup
    booleans across sources; keep max `area_ha`).
  - **categories:** union of all sources' mapped categories.
  - **popularity:** `COUNT(DISTINCT source_id)`.
- Respect `display_allowed`: never let a display-forbidden source be the *only* basis for a
  published field; it can fill blanks / boost popularity only.

### Stage 7 — Publish & report (`ingest:report`)

- Set `status = 'published'` for canonical POIs that pass QA (have coords, ≥1 display-allowed
  source, a category).
- Emit a **reconciliation report** (like the current import script does, but richer):
  records in, new vs. updated, matched-to-existing, new canonical created, sent to review,
  geocode failures, unmapped categories, popularity distribution.

### Orchestration

`ingest:run <source> <file>` chains Stages 1–7 with flags (`--dry-run`,
`--auto-threshold`, `--review-band`, `--no-geocode`, `--no-llm`). Designed to be run by hand
today and by a scheduler later (§8).

```
extract → normalize → geocode → embed → match → merge → publish/report
   ▲                                                  │
   └──────────────  safe to re-run any stage  ────────┘
```

---

## 6. De-duplication algorithm in detail

For each `source_record` not yet confidently matched:

**Step A — Overrides first.** If a `match_overrides` rule touches this record, obey it
absolutely (force_same → that cluster; force_different → never merge those).

**Step B — Strong-ID match.** If the record shares any strong identifier with an existing
canonical POI or another record — Wikidata QID, OSM `(type,id)`, normalized
`website_domain`, or `phone` — merge into that cluster immediately. `method = 'strong_id'`,
done. (Distance is irrelevant here; identity is proven.)

**Step C — Spatial blocking.** Otherwise, fetch candidate canonical POIs within a
category-tuned radius using PostGIS:

```sql
SELECT id, name, geom, ... 
FROM pois
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
| Soft-ID partial | same Wikipedia title, overlapping address tokens | small boost |

`score = Σ wᵢ·sᵢ`, normalized to 0–1.

**Step E — Decide by band.**

- `score ≥ T_high` (e.g. 0.85) → **auto-merge** into best candidate. `method = 'auto'`.
- `score ≤ T_low` (e.g. 0.55) → **new canonical POI**. `method = 'new'`.
- `T_low < score < T_high` → **gray zone**:
  1. **LLM adjudication** — send both records' salient fields (names, address, distance,
     category, websites) and ask a structured "same place? {yes|no|unsure} + confidence +
     one-line reason". Yes(high) → merge; No(high) → new; unsure → **human review queue**
     (`match_status = 'review'`). `method = 'llm'`.
  2. Cap LLM usage to the gray band only → bounded cost, and avoids the "LLM is hard to
     quantify" problem because it never decides the easy cases.

**Step F — Record** the decision + all signals in `match_decisions` (tuning + explainability).

**Tuning loop.** Maintain a small **golden set** of hand-labeled same/different pairs drawn
from the real dumps (e.g. the obvious Kew duplicates across BGCI/OSM/Wikidata/Wikipedia).
Re-run matching against it to measure **precision/recall** whenever we change weights or
thresholds. This turns "is the matcher good?" into a number.

**Cluster transitivity.** Matches are pairwise; collapse them with union-find so A≡B and
B≡C ⇒ one cluster {A,B,C} → one canonical POI.

---

## 7. Categories, taxonomy & aliases

The user gave three concrete requirements; this model satisfies all of them.

### Schema

```sql
CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,     -- STABLE id, never changes: 'free_flight', 'rv'
  display_name  text NOT NULL,            -- shown in UI, freely renamable
  parent_id     uuid REFERENCES categories(id), -- hierarchy (campground → rv/tent/backpacker)
  description   text,
  icon          text,
  color         text,
  sort_order    integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- raw source strings → canonical category (drives Stage-2 categorization)
CREATE TABLE category_aliases (
  alias         text NOT NULL,            -- 'garden:type=botanical', 'caravan', 'paragliding'
  category_id   uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES sources(id), -- NULL = applies to all sources
  PRIMARY KEY (alias, category_id, source_id)
);

-- a place can be in many categories
CREATE TABLE poi_categories (
  poi_id        uuid NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  is_primary    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (poi_id, category_id)
);
```

### How it satisfies each requirement

- **Multiple categories per place** → `poi_categories` many-to-many. A flying site row can be
  linked to `free_flight`, `hang_gliding`, `paragliding`, and `gliderport` simultaneously.
- **Rename a category** ("flying site" → "free flight") → update `categories.display_name`.
  The **slug stays `free_flight`**, so every link and alias keeps working; nothing else
  changes. (If we want the old name to keep mapping incoming data, add it to
  `category_aliases`.)
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
`category_aliases` instead of silently dropping or misfiling data.

---

## 8. Continuous / repeated ingestion & popularity

Data changes; we will re-run the same sources forever and add new ones. The design makes
this safe by construction.

- **Same source, re-pulled:** Stage 1 upserts by `(source_id, source_record_id)`. Existing
  rows update (and bump `last_seen_at`); rows missing from the new pull get `is_stale = true`
  (soft delete — we keep history and don't thrash canonical IDs). **Popularity does not move**
  because it counts *distinct sources*, and this is the same source.
- **New source, same place:** a new `source_record` matches an existing canonical POI in
  Stage 5, links via `poi_source_records`, and `popularity` increments by one (new distinct
  source). Exactly the user's definition: *popularity = how many sources it appears in*,
  un-normalized, used only to sort search results.
- **Re-merge after algorithm/threshold improvements:** because raw rows are intact, re-run
  Stages 5–6 to rebuild canonical POIs without re-fetching anything. `match_overrides` keep
  human corrections sticky across re-runs.
- **Scheduling (later):** wrap `ingest:run` in a cron/worker (Railway scheduled job or GitHub
  Action) per source on its own cadence. Incremental `content_hash` checks keep repeat runs
  cheap.

---

## 9. Scripts & utilities to build and maintain

New package area: `lib/db-map/scripts/ingest/` (or a dedicated `lib/ingest` workspace package
if it grows). Proposed `package.json` scripts (mirroring existing `db:import:*` style):

| Command | Purpose |
|---|---|
| `ingest:extract <source> <file>` | Adapter → upsert `source_records` (streamed, idempotent) |
| `ingest:normalize [--source S]` | Clean names/coords/address, map categories |
| `ingest:geocode [--limit N]` | Fill missing coords via LocationIQ + cache |
| `ingest:embed` | Compute embeddings for changed rows |
| `ingest:match [--dry-run] [--auto-threshold] [--review-band]` | Conflation → decisions |
| `ingest:merge` | Build/refresh canonical `pois` from clusters |
| `ingest:report` | Reconciliation + QA stats |
| `ingest:run <source> <file>` | Orchestrate all of the above |
| `ingest:review` | List/resolve the gray-zone review queue (CLI; later a tiny admin page) |
| `ingest:override <a> <b> same|different` | Write a `match_overrides` rule |

Shared building blocks to maintain:

- **`extractors/`** — one file per source; a registry mapping `slug → Extractor`. Each new
  data dump = one new small adapter, nothing else.
- **`normalize/`** — name/address/phone/coord normalizers (shared, unit-tested).
- **`match/`** — blocking, scoring, thresholds, union-find clustering, LLM adjudicator,
  golden-set evaluator.
- **`merge/`** — field-precedence resolver + LLM description aggregator.
- **`geocode/`** — pluggable provider client + cache.
- **Migrate the existing skill/scripts:** `db:import:json` / `db:import:kml` become thin
  adapters that write into **`source_records`** (source `slug` from a flag) instead of
  straight into `pois`. Update `.cursor/skills/import-pois/SKILL.md` and
  `lib/db-map/IMPORTING.md` to the new staging-first flow. The old direct-to-`pois` behavior
  is retired so we never bypass dedup again.

Testing utilities (so we can trust the pipeline):

- Unit tests for each extractor (sample fixture rows → expected `source_records`).
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
- **Licensing gate:** The Dyrt is a proprietary scrape → set `display_allowed = false`; use
  it to **boost popularity and fill missing hookup flags**, but never publish it as the
  visible source. OSM (ODbL, attribution) and RIDB (US gov, public domain) are display-OK.
- **Categories:** `tourism=caravan_site` / `caravans=yes` / `rv_hookup` → `rv`; tent-only →
  `tent`; all under `campground` parent. "Caravan" is just an alias for the `rv` slug.
- **Staleness:** uscampgrounds.info is 2014 data — ingest as seed, let newer sources override
  fields; if a 2014-only site never reappears, it stays (popularity 1) but is flagged old via
  `last_seen_at`.

---

## 11. Things we should plan for now

Beyond the explicit requirements, decide these up front so we don't repaint later:

1. **Licensing / attribution per source** (`sources.license`, `attribution`,
   `display_allowed`). Some dumps (The Dyrt, possibly BGCI) are ToS-restricted — we must be
   able to use them for dedup/enrichment without publishing them. This is a legal must-have,
   not a nice-to-have.
2. **PostGIS adoption + dropping `UNIQUE(lng,lat)`** — required for blocking and for allowing
   genuinely-near distinct places.
3. **Flexible `attributes jsonb`** + optional per-category JSON-schema validation — so each
   new category's fields don't require a migration.
4. **Reversibility & overrides** (`match_overrides`, `match_decisions`) — the AI *will* make
   mistakes; we need to correct them stickily and explain merges.
5. **Golden-set evaluation** — quantify matcher precision/recall before trusting it on 284k
   rows.
6. **Geocode cost/rate control** (`geocode_cache`, provider abstraction) — per the
   `location-api.md` research; start LocationIQ free tier, keep a self-host-Nominatim path.
7. **Data-quality QA gates** — reject/flag coords in the ocean, country-vs-coordinate
   mismatches, obviously swapped lat/lng, empty names.
8. **Photos & media rights** — today `photo_url` hotlinks; decide on storage (R2/Supabase) and
   per-source image rights before bulk-importing images.
9. **Observability** — a `ingest_runs` metrics row per execution (counts, durations, failure
   rates) for dashboards and regression alerts.
10. **Coordinate precision/privacy** — round published coords to ~6 dp.
11. **Canonical-ID stability** — never churn `pois.id` on re-merge (the app/users may
    reference it); update in place.
12. **Scale path** — indexes above handle low millions; revisit partitioning/tiling beyond
    that.

---

## 12. Phased rollout

Each phase is independently shippable and leaves the app working.

- **Phase 0 — Schema foundations.** Migrations for extensions, `sources`, `source_records`,
  revised `pois` (+`geom`, `attributes`, `popularity`, drop `UNIQUE(lng,lat)`),
  `poi_source_records`, categories trio, audit/override/geocode tables. Run `pnpm db:sync`,
  commit generated artifacts. Backfill existing `pois` into a `manual`/`legacy` source so we
  lose nothing.
- **Phase 1 — Extractors + staging.** Common `Extractor` interface, `sources` registry,
  `ingest:extract`, streaming parsers. Adapters for the 12 example sources. Land both example
  dumps into `source_records` (no publishing yet).
- **Phase 2 — Normalize + categorize.** Normalizers, `category_aliases` seed for gardens &
  campgrounds, unmapped-category report.
- **Phase 3 — Geocode.** LocationIQ client + `geocode_cache`; fill coordinate gaps.
- **Phase 4 — Embed + match.** pgvector embeddings, blocking, scoring, thresholds, strong-ID
  shortcut, union-find, `match_decisions`, golden-set harness.
- **Phase 5 — Merge + publish.** Field precedence, LLM description aggregation, popularity,
  `poi_categories`, publish gating, `ingest:report`.
- **Phase 6 — App read path.** Update `listPoisGeoJson` / detail / categories endpoints for
  the new category model + popularity sort; category expansion; keep the GeoJSON shape stable.
- **Phase 7 — Review tooling + overrides.** Gray-zone queue CLI (then minimal admin UI),
  `ingest:override`.
- **Phase 8 — Automation.** `ingest:run` orchestrator, scheduling, `ingest_runs` metrics,
  retire direct `db:import:*`-to-`pois`; update skill + docs.

---

## 13. Open product questions

Best-judgement defaults are chosen above; these are genuine product calls worth your
confirmation (not blockers):

1. **Display vs. enrichment licensing:** OK to treat proprietary scrapes (e.g. The Dyrt) as
   *enrichment/popularity only* and never display them? (Assumed yes.)
2. **Global from day one?** The dumps are global; matcher radii and geocoding are tuned for
   worldwide coverage. Confirm we're not US-first.
3. **Human review appetite:** how big a gray-zone review queue is acceptable vs. letting the
   LLM auto-decide more aggressively (precision vs. recall trade-off)?
4. **LLM-written descriptions:** OK to publish AI-aggregated description prose (with source
   attribution retained), or keep verbatim source text only?
5. **Category taxonomy ownership:** should the canonical taxonomy (slugs, parents) be a
   committed seed file in the repo (versioned, PR-reviewed) — recommended — or editable live
   in an admin UI?
```

