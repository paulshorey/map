# Plan: Aggressive Conflation — Proximity Clusters & Same-Name Merging

> **Companion to** `poi-ingestion-pipeline.md` (design) and `poi-ingestion-implementation.md`
> (M0–M10 build plan). This plan refines **M8 (match + merge)** based on the first real
> category run (botanical gardens: bgci + wikidata + osm, 9,872 research rows → 7,727
> canonicals as of Jul 5 2026). It addresses two under-merging failure modes the product
> owner identified, plus the root causes found while diagnosing them.
>
> **Product stance (owner, Jul 2026): err on the side of over-grouping.** Merging two
> genuinely distinct adjacent places is an acceptable cost; showing 20 markers for one
> garden is not.

---

## 1. What the data shows today (diagnosis)

Measured against the live DB (7,727 canonicals; popularity 1/2/3 = 6,462/939/326):

| Symptom | Count | Example |
|---|---|---|
| Canonicals with a distinct neighbor within ±0.0055° lat/lng | **1,935** (7,149 pairs) | Queens Botanical Garden + 15 OSM sub-gardens |
| Same-name canonical pairs within 25 km | **113** | 2× "Houston Botanic Garden" 17.4 km apart |
| Same-name pairs within 1 km | 48 | 2× "Talbot Botanic Garden" **18 m** apart |
| OSM-only, popularity-1 canonicals near a stronger "anchor" canonical | **664** | Dallas Arboretum sub-gardens |
| OSM-only micro-features clustered together with **no** anchor nearby | **384** | Brazilian park with 37 named features (swing sets, herb mandalas…) |
| Gray-zone rows decided `new` only because a run used `--no-llm` | **208** | Talbot (score 0.826, identical name, 18 m) |
| Wikidata rows whose *name is a bare QID* (no label), published | **288** | 29 stacked at the LocationIQ Argentina country centroid |
| Rows published on `region`-precision geocodes | 111 | "q134970598, argentina, argentina" |
| Coarse city-centroid stacks of generic names | e.g. 7× "Arboretum" at one Washington-DC point | all `coordinate_precision='city'` |

### Root causes in the current matcher (`match.ts`, `score.ts`, `merge.ts`)

1. **Blocking radius is the ceiling on recall.** Candidates come only from a 600 m bbox.
   Houston's BGCI row (office address, 17 km from the garden) can never see the real
   garden. Same-name-different-coords duplicates are structurally unreachable.
2. **Score calibration makes T_high nearly unreachable.** Weights: `semantic×0.78 +
   distance×0.10 + locality×0.05 + website 0.04 + phone 0.03`. A pair with an **identical
   name at 18 m** but no shared locality/contact fields scores 0.826 < 0.85 → gray zone.
   OSM rows rarely carry city/region, so most true dupes land in the gray zone by design.
3. **Gray-zone decisions made with `--no-llm` are permanent.** The decision `new` sets
   `canonical_poi_id`, removing the row from the match queue forever. 208 duplicates were
   baked in this way; nothing ever revisits them.
4. **No concept of sub-features.** OSM maps individual named gardens *inside* a botanical
   garden (`leisure=garden` nodes: "Rose Garden", "Magnolia Walk"…). Name similarity to the
   parent is ~0, so the matcher correctly says "different place" — the gap is a product
   rule, not a scoring bug: for this app, features of one green space are one POI.
5. **Coordinate election ignores corroboration.** `chooseCoordinates` sorts by precision
   then source trust. BGCI (trust 85) beats wikidata+osm (80/70) even when wikidata and
   osm *agree with each other* and BGCI is an office address 17 km away (Houston).
6. **Trash inputs get published.** QID-named wikidata rows are geocoded as
   `"q134970598, argentina, argentina"` → country centroid → 29 fake POIs on one point.

---

## 2. Design decisions (answers to the open questions)

### 2.1 Chaining (A↔B close, B↔C close, A↔C far — who groups?)

This is the classic **single-linkage chaining problem** in entity-resolution clustering.
Best practice is to bound cluster growth by something global (complete-linkage/diameter
caps) or to cluster around **centers** (leader/canopy clustering). For an incremental,
one-record-at-a-time pipeline the center-based form is the right fit:

> **Rule: merges attach to an *anchor*, never to another satellite.**
> Pick the strongest member of a neighborhood as the anchor; everything within the radius
> **of the anchor** joins it. A satellite never recruits its own neighbors.

Consequences:
- Cluster diameter is bounded at 2R (satellites are all within R of the anchor); no chains.
- A↔B↔C: whichever of the three is the anchor (say B) absorbs A and C iff each is within R
  **of B**. If C is only within R of A (a satellite), C does *not* join — it becomes its own
  anchor or joins a different one.
- Deterministic given anchor ordering (we order by popularity → source trust → id).

### 2.2 On-the-fly or second pass? **Both.**

- **On the fly (match loop):** when a record blocks against canonicals, an existing anchor
  within the proximity radius can absorb it even at low name similarity (Case 1 rule below).
  This keeps the common path cheap and the DB continuously publishable.
- **Canonical sweep (second pass, `ingest:match --consolidate`):** incremental matching is
  order-dependent — sub-gardens ingested before their parent (OSM ran before BGCI) create
  satellite canonicals that no later per-record decision revisits; `--no-llm` decisions
  are similarly frozen. A cheap canonical-vs-canonical sweep after each source run heals
  both. This was already foreseen as "periodic canonical-vs-canonical merge" in overview
  §14.1 — this plan specifies it.

The sweep is idempotent and cheap (bbox self-join over ~10⁴ rows today; grid-bucketed when
the table grows), so run it at the end of every `ingest:run`.

### 2.3 Choosing the canonical location (Case 2's hardest sub-problem)

Priority order for electing cluster coordinates in `chooseCoordinates`:

1. **Corroboration (medoid) first.** Among members with `coordinate_precision='point'`,
   group coordinates that agree within the proximity threshold; the largest agreeing group
   wins, and within it the highest-trust member's exact coords are used. Two independent
   sources agreeing (wikidata+osm at −95.27) beat one high-trust outlier (bgci at −95.44).
   With N=2 disagreeing groups there is no majority — fall through to 2.
2. **Precision.** `point` > NULL > `city` > `region` (unchanged).
3. **Source trust** (unchanged), with one adjustment: an address-book-style source can be
   demoted per-category for *coordinates specifically* (BGCI locations are org mailing
   addresses often ≠ garden gates). Implement as an optional `coord_trust` override in
   `sources.ts` metadata rather than a schema change.

This is deliberately *not* an average: averaging two locations 17 km apart puts the pin in
a swamp. We always publish one member's real coordinates.

### 2.4 Re-ingestion safety (the "duplicate +\n\nname4 description4" worry)

Already structurally solved — and the fix for Case 1 descriptions must preserve it:

- **Same source re-imported:** `UNIQUE(source_id, source_record_id)` + `content_hash`
  short-circuit means an unchanged record is touched (`last_seen_at`) and skipped. It never
  re-enters the match queue, never bumps popularity (which is a *recomputed*
  `COUNT(DISTINCT source_id)`, not an increment).
- **Descriptions are rebuilt, never appended.** `rebuildCanonicalPoi` recomputes every
  published field *from the full set of linked research rows* on each rebuild. The Case 1
  aggregated description below is a **pure function of the cluster** (deterministically
  ordered), so re-running any stage yields byte-identical output. No append path exists.

So: no schema or bookkeeping changes needed for idempotency; we only need to keep the new
description composer deterministic.

---

## 3. The changes

### 3.1 Case 1 — proximity consolidation (same category, very close coordinates)

**New config** (env + `config.ts`):

```
INGEST_PROXIMITY_MERGE_DEG=0.0055        # default box half-width, degrees lat & lng
```

Per-category overrides live in code next to `RADIUS_BY_SLUG` (e.g. gardens 0.0055;
campgrounds/RV must be much smaller or 0 — adjacent campgrounds are usually distinct
businesses; festivals share city centroids and must not proximity-merge at all):

```ts
const PROXIMITY_MERGE_DEG: Record<string, number> = {
  gardens: 0.0055, botanical_garden: 0.0055, arboretum: 0.0055,
  campground: 0.0005, rv: 0.0005, tent: 0.0005,
  music_festival: 0, carnival: 0, art_fair: 0, art_parade: 0, // disabled
};
```

**Anchor definition** (canonical row, same primary category):

- popularity ≥ 2, **or**
- backed by a curated-registry research row (bgci/wikidata — generalize: source trust ≥ 80), **or**
- has its own official `website` or a Wikidata QID.

Everything else is a **satellite** (for gardens today: OSM-only, popularity-1, no website).

**Merge rules:**

| Pair within box | Action |
|---|---|
| satellite + anchor | **Auto-merge into anchor**, regardless of name similarity. `method='proximity'`. |
| satellite + satellite (no anchor in box) | **Leader-cluster them:** medoid member (min sum of distances) becomes the anchor; absorb all satellites within *its* box; repeat for leftovers. One canonical per leader; never chain. |
| anchor + anchor | Do **not** auto-merge on proximity alone. Route to the **LLM** with a "same place/complex?" prompt (this is how Paris's Jardin des Plantes ↔ MNHN and the Ménagerie combine, while Bremen's adjacent-but-distinct Botanika ↔ Rhododendron-Park can stay split if the LLM says so). Distance ≤ box counts as strong evidence *for* merging in the prompt. |

**Where it runs:**

1. **Match loop:** in `decideRow`, after strong-id and before scoring — if the nearest
   candidate within the proximity box is an anchor and the incoming row looks like a
   satellite (no strong id of its own that matched elsewhere, no official website OR name
   similarity < floor), merge immediately (`method='proximity'`).
2. **`ingest:match --consolidate` sweep:** bbox self-join on `canonical_pois`, apply the
   same table above, reuse `collapseDuplicateCanonicals` (repoints `research_pois`, hides
   the loser) + `rebuildCanonicalPoi` on the winner. Loop until fixpoint (rare second
   iterations when a satellite merge upgrades an anchor's box coverage).

**Canonical output of an absorbed cluster:**

- `name`, coordinates: the anchor's (per §2.3 election over the merged research rows).
- `description`: anchor's own description first, then one titled section per absorbed
  member that has a name and/or description, **sorted by normalized name** (deterministic):

  ```md
  {anchor description}

  **{member name}**
  {member description}

  **{member name 2}**
  {member description 2}
  ```

  Composed in `rebuildCanonicalPoi` from the cluster every time → idempotent (§2.4).
  Members whose name is generic ("Meadow") still get their section; the section list *is*
  the tour of the grounds and is useful content.
- `attributes.contained_features`: array of absorbed member names (search/debug aid).
- `field_provenance.description` records `source: 'proximity_aggregate'` + the research ids.

### 3.2 Case 2 — same name + same category + similar location

**Add a second blocking key.** Candidates in `fetchCandidates` become the union of:

- the existing spatial block (unchanged), and
- a **name block**: canonicals in the same category whose `lower(name)`/trgm similarity to
  the record's `name_normalized` is ≥ 0.9, within a wide radius
  (`INGEST_NAME_BLOCK_KM`, default **25 km**, from the observed pair distribution: 113 of
  124 same-name-≤100 km pairs are ≤ 25 km).

Uses the existing `canonical_pois_name_trgm` GIN index; the wide radius is a bbox.

**Scoring/decision for name-block candidates** (they are far, so distance can't help):

- Drop the distance signal (already the coarse-coordinate behavior); require the name
  similarity floor.
- **Distinctive exact name + same category → auto-merge.** "Distinctive" = normalized name
  contains at least one token that is not a category stopword (botanic/botanical, garden,
  gardens, arboretum, park, rose, jardin, jardín, botanischer, garten, 植物园, 月季园-style
  generic CJK garden words…) — i.e. "houston botanic garden" (has *houston*) merges;
  bare "rose garden"/"arboretum"/"月季园" never does.
- Anything else in the gray zone → **LLM**, prompt now including both coordinate sets, the
  km distance, and both addresses, framed as "same real-world place listed with divergent
  coordinates?".

**Coordinate election** then follows §2.3 — for Houston: wikidata+osm corroborate each
other → the garden's real location wins; BGCI's office address loses but its
description/phone/address fields still win field-precedence where they're best.

*(No reliance on popularity ordering: the medoid rule works at N=2 groups vs 1 outlier,
and at N=2 total (1 vs 1 disagreeing) we fall back to precision→trust, which is the best
available guess. Accepted residual risk, per product stance.)*

### 3.3 Score recalibration (independent of Cases 1/2 but exposed by them)

An identical name at 18 m must not be a gray-zone case. Two small changes:

- **Fast path:** name similarity = 1.0 (normalized-exact) + distance ≤ proximity box +
  same category + no date conflict → auto-merge without consulting T_high (`method='auto'`,
  `reason='exact_name_proximity'`).
- **Rebalance weights** so locality absence isn't a penalty: locality contributes only
  when *both* sides have locality fields (it already works that way — the issue is the
  0.05+0.04+0.03 dead weight when absent). Renormalize: `semantic×0.80 + distance×0.12 +
  locality×0.04 + website×0.02 + phone×0.02`, and re-run the golden set. Keep T_high=0.85.

### 3.4 Repair the frozen gray zone + hygiene gates

- **Re-adjudicate `--no-llm` casualties:** the 208 `llm_disabled_gray_zone` decisions are
  healed automatically by the `--consolidate` sweep (Talbot: two same-name canonicals 18 m
  apart → exact-name fast path). No special one-off script needed.
- **QID-named rows:** in normalize, a row whose name matches `^Q\d+$` (wikidata label
  missing) gets `is_poi = false` (never matched/published). 288 canonicals disappear on
  recluster. (Optionally a later enrichment could fetch labels; not now.)
- **Don't publish region-precision coordinates:** `rebuildCanonicalPoi` sets
  `status='hidden'` when the elected coordinates have `coordinate_precision='region'`. Kills
  the 29-deep Argentina centroid stack. (§3.6 extends this: `region` covers country-centroid
  hits from the GeoNames list, and a `city`-only precision is also gated off the map — the
  earlier "city stays visible" idea is superseded, because a city-precision coordinate is a
  centroid, not the garden.)
- **Never geocode garbage queries:** geocode stage skips rows whose query would be just a
  QID/empty name (`^q\d+,`).
- **Chain/portal denylist:** add `ivn.nl` symptom-class awareness is unnecessary —
  multi-location domains only add +0.02 now; no change needed beyond the existing list.

### 3.5 What we deliberately do NOT do

- No transitive single-link merging (chaining) — anchors only (§2.1).
- No coordinate averaging — always a real member's coordinates (§2.3).
- No description appending — full deterministic rebuild every time (§2.4).
- No proximity merging for event categories or campgrounds by default (per-category table).
- No schema migration for the matcher itself — everything rides on existing tables;
  `method='proximity'` needs a CHECK-constraint update on
  `research_match_decisions.method`… **exception**: that one small migration
  (`ALTER TABLE … DROP CONSTRAINT/ADD CHECK` including `'proximity'`) plus the new
  `geo_centroids` reference table in §3.6, followed by `pnpm db:sync`.

### 3.6 Centroid detection (city/country) — GeoNames reference data

**The problem this closes.** Our geocoder already tags its *own* output (LocationIQ returns
an OSM `class`/`type`, so a country/state/city result becomes `region`/`city` precision in
`locationiq.ts`). But **source-provided coordinates lie**: a Wikidata or BGCI row can carry
a precise-looking `(lat, lng)` that is actually the city or country centroid, and we store it
as `coordinate_source='source', coordinate_precision='point'` — fully trusted. Provider
centroids also differ (LocationIQ's country point for Argentina ≠ the geometric centroid in
`countries360`), so we cannot detect these from our geocoder alone. We need an
**independent reference list of centroids** to catch them.

**The data (already downloaded, in `scripts/`).**

- `cities500.txt` — GeoNames "cities with population ≥ 500", **234,645 rows**, tab-separated
  (columns per `cities500-readme.txt`): `geonameid, name, asciiname, alternatenames, lat,
  lng, feature_class, feature_code, country_code, …, population, …`. Feature class `P`
  (populated place); feature codes `PPL*` (138k plain `PPL`, plus `PPLA*` admin seats,
  `PPLC` national capitals, …). This is our **city-centroid + reverse-city** dictionary.
- `countries360-2024.csv` — **217 country centroids**, `iso3,name,lat,lon`. Our
  **country-centroid** dictionary.

**Measured value against the live DB** (why the tight radius matters):

| Centroid hit | canonical POIs | note |
|---|---|---|
| within 50 m of a city point | 36 | almost-certain centroid placements |
| within 120 m | 95 | of these, **~40 wikidata + ~41 bgci rows are `source/point`** — silent centroids we trust today |
| within 300 m | 353 | mixed: some real downtown POIs start appearing |
| within 1 km | 1,914 | mostly legitimate (a garden genuinely near a small-town point) — **too loose to gate on** |
| within 1 km of a *country* centroid | 4 | tiny (our geocoder already types its own country hits; the list is a backstop) |

So a **tight radius is safe; a loose one is not.** The list's real job is the ~80
`source/point` rows that are secretly city centroids, not the whole 1 km halo.

**Storage — a committed reference table `geo_centroids`.** Consistent with the rest of the
pipeline (bbox self-joins, cached lookups) and reusable by both normalize and matching:

```sql
CREATE TABLE public.geo_centroids (
  id            bigint PRIMARY KEY,       -- geonameid; synthesize negatives for countries
  kind          text NOT NULL CHECK (kind IN ('city','country')),
  name          text NOT NULL,
  admin1        text,                     -- GeoNames admin1 code (→ region)
  country_code  text,                     -- ISO-2 (cities) / mapped from ISO-3 (countries)
  population    bigint,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL
);
CREATE INDEX geo_centroids_lat_idx ON public.geo_centroids (lat);
CREATE INDEX geo_centroids_lng_idx ON public.geo_centroids (lng);
CREATE INDEX geo_centroids_kind_idx ON public.geo_centroids (kind);
```

Seed once from the two files via a new `ingest:seed:centroids` script. Move the source files
under `lib/db-map/data/geonames/` and **commit them** (30 MB total) for reproducible seeds;
document their provenance/licensing (GeoNames is CC-BY 4.0 — record in the file header, same
"metadata only for the POC" stance as `research_sources.license`).

**Detection rule (normalize stage, per row that has coordinates).** Reuse the existing
`bboxAround` + Haversine helpers (`match/geo.ts`) against `geo_centroids`:

1. **Country centroid** — nearest `kind='country'` within **~2 km** ⇒ set
   `coordinate_precision='region'`, `attributes.centroid_hit='country:<name>'`. Nothing real
   sits on a country geometric centroid, so this is safe and wide.
2. **City centroid** — nearest `kind='city'` within **~100 m** ⇒ set
   `coordinate_precision='city'`, `attributes.centroid_hit='city:<geonameid>'`. Tight radius
   keeps genuine downtown POIs safe.
3. **Corroboration band (100–400 m from a city point)** — *not* auto-downgraded on distance
   alone; only downgraded when a second signal from §2.3/§3.4 agrees: coordinates are
   suspiciously round (≤ 3 decimals or clean `.0/.25/.5`) **or** the exact `(lat,lng)` is
   shared by ≥ 3 distinct-named research rows (stacking). This is the third, strongest leg of
   the "is this a real point?" test the aggressive-merge plan already relies on.

Only source/URL coordinates are re-checked here; geocoder output is already typed. Detection
is deterministic and idempotent (a pure function of `geo_centroids` + the row's coords), so it
re-runs cleanly and is reset like any other derived column when `content_hash` changes.

**Publish gating (in `rebuildCanonicalPoi`, extends §3.4).** After coordinate election
(§2.3), gate on the elected precision:

- `region` (incl. country-centroid hits) → **never on the map**: `status='hidden'`.
- `city` as the *only* available precision → **not a map pin**: `status='hidden'` (kept in
  the DB, retained for the "unmapped in this area" UX below). If any linked research row has
  a true `point`, that always wins election and the POI publishes normally.

**Bonus — reverse-city enrichment (high value for Case 2).** OSM rows almost never carry
`city`/`region`, which is exactly why Case 2 locality scoring and the name-block are weak. In
normalize, for a row with coordinates but **missing** `city`/`region`, fill them from the
**nearest `kind='city'`** centroid within ~15 km (`attributes.city_source='nearest_centroid'`
for audit). This does not touch coordinates — it only populates locality text — so it
strengthens matching without any risk of moving a pin.

**Product/UX answer (the "show a city summary?" question).** Recommended policy — a clean map
plus a graceful off-map list, matching what tier-1 apps do (Overture/SafeGraph discard
coarse-precision POIs from the map; Yelp/TripAdvisor list "located in <city>" without a pin):

- **Region precision:** never shown, anywhere on the map.
- **City precision (no better coordinate):** excluded from map pins; surfaced in the results
  drawer under an **"Elsewhere in this area (exact location unmapped)"** section. Clicking one
  pans to the city and shows a soft area highlight rather than a false precise pin. For the
  POC this can start as simply "hidden + counted"; the drawer section is a small, later
  frontend addition (no pipeline change needed — it reads the same `canonical_pois` with a
  `precision`/`status` flag exposed in the read contract).
- These `city`-precision rows are also the natural **enrichment queue**: a later stage can
  try URL-embedded coords / detail-page scraping to promote them to real points.

---

## 4. Implementation steps (ordered)

1. **Migration:** extend `research_match_decisions.method` CHECK with `'proximity'`; add the
   `geo_centroids` reference table (§3.6); `cd lib/db-map && pnpm db:sync`; commit generated
   artifacts.
1b. **Centroid reference data (§3.6):** move `scripts/cities500.txt` +
   `scripts/countries360-2024.csv` to `lib/db-map/data/geonames/` (with a provenance/license
   header); add `ingest:seed:centroids` (streamed load into `geo_centroids`, ISO-3→ISO-2 map
   for countries, synthesize negative ids for country rows); run it. Idempotent upsert by id.
2. **`config.ts`:** add `proximityMergeDeg` (env `INGEST_PROXIMITY_MERGE_DEG`, default
   0.0055), `nameBlockKm` (env `INGEST_NAME_BLOCK_KM`, default 25), and centroid radii
   (`CENTROID_CITY_M`≈100, `CENTROID_COUNTRY_M`≈2000, `REVERSE_CITY_KM`≈15).
3. **`match/anchors.ts` (new):** `isAnchor(canonicalRowMeta)`, `PROXIMITY_MERGE_DEG`
   per-category table, distinctive-name check (category stopword list in `taxonomy.ts` or
   alongside), medoid helper.
4. **`match.ts`:**
   - `fetchCandidates`: add the name-block union query (+ carry a `via: 'spatial'|'name'`
     flag and anchor metadata: popularity, has-website, max source trust).
   - `decideRow`: proximity fast path (satellite→anchor), exact-name fast path (§3.3),
     name-block gray-zone → LLM with coordinates/addresses in the prompt (`llm.ts` prompt
     tweak), anchor+anchor proximity → LLM.
5. **`match/consolidate.ts` (new) + `--consolidate` flag:** canonical-vs-canonical sweep
   implementing the §3.1 table (satellite→anchor, leader-clustering for anchor-less
   groups, anchor+anchor→LLM), using `collapseDuplicateCanonicals` + rebuild; loop to
   fixpoint; `--dry-run` support printing planned merges.
6. **`merge.ts`:**
   - `chooseCoordinates`: corroboration groups first (§2.3), then precision, then trust
     (respect optional per-source `coord_trust`).
   - `chooseDescription` → cluster-aware composer: anchor prose + sorted titled sections
     (§3.1); `attributes.contained_features`; hide `region`-precision canonicals.
7. **`normalize.ts`:** `is_poi=false` for `^Q\d+$` names; **`geocode.ts`:** skip QID-name
   queries. **`normalize/centroids.ts` (new):** centroid detection (downgrade precision on a
   tight city/country hit + corroboration band, §3.6) and reverse-city enrichment for rows
   missing `city`/`region`; wire into the normalize loop. Add `ingest:reflow` (or documented
   SQL) so already-normalized garden rows re-run this new logic without a content change.
8. **Weights** in `score.ts` per §3.3.
9. **Golden set:** add labeled pairs — Houston (bgci vs wikidata/osm rows = same),
   Talbot (same), Queens sub-garden vs Queens Botanical Garden (same, proximity),
   Dallas "A Woman's Garden" vs Dallas Arboretum (same, proximity), Botanika Bremen vs
   Rhododendron-Park (LLM-adjudicated — assert *not* auto-merged by proximity since both
   are anchors), two distinct nearby campgrounds (different), "Rose Garden" city-centroid
   pair (different — generic name guard), McBryde vs Kahanu (NTBG shared domain,
   different). Run `ingest:match:golden`; the FP gate stays hard.
10. **`ingest:run`:** append `--consolidate` sweep as the final stage.

## 5. Validation & rollout

1. Implement; run golden set (`--no-llm` first for the deterministic subset, then full).
2. **Full recluster** with LLM enabled:
   `pnpm --filter @lib/db-map ingest:match --recluster` then `--consolidate`.
3. SQL checks (all should drop dramatically):
   - same-name pairs ≤ 25 km: 113 → expect < 20 (survivors are legit distinct or generic names);
   - canonicals with a distinct same-category neighbor within 0.0055°: 1,935 → expect only
     anchor-anchor LLM-confirmed splits to remain;
   - `^Q\d+$` canonicals: 288 → 0; region-precision published: 111 → 0.
   - centroid detection: the ~40 wikidata + ~41 bgci `source/point` rows within 120 m of a
     city point are re-flagged `city`; none of them publish as a pin unless a sibling row
     supplies a true `point`. Spot-check that a genuine downtown garden (>120 m from the
     city point) is **not** downgraded (false-positive guard).
   - reverse-city enrichment: OSM rows that had NULL `city` now carry a nearest-city value
     (`attributes.city_source='nearest_centroid'`); confirm Case 2 name-block/locality
     improves on a sample.
   - spot-check the five worked examples (Queens, Dallas, Chicago, Paris, Erhu) return 1
     published canonical each; Houston returns 1 with popularity 3, coords ≈ (29.6875, −95.27),
     BGCI description/address retained via field precedence.
4. Manual map check (pnpm dev): Queens/Dallas/Chicago show one marker; detail drawer shows
   the aggregated sections.
5. Idempotency: re-run `ingest:extract` for bgci + `ingest:match` + `--consolidate`;
   assert 0 new canonicals, popularity unchanged, description byte-identical.

## 6. Risks / watch list

- **Order dependence remains** in the on-the-fly path; the sweep is the invariant-restorer.
  Always run it after a source completes.
- **LLM cost:** anchor+anchor proximity pairs and 25 km name-block gray zones add LLM calls.
  Bounded: ~500 anchor-anchor near-pairs and ~100 name pairs today; cache decisions in
  `research_match_decisions` and skip pairs already adjudicated (store both canonical ids
  in signals; the sweep checks before re-asking).
- **Wrong-side merges we accept:** geocode errors can teleport a POI into a foreign
  cluster ("Jardin des Plantes du Mans" geocoded onto Paris) — it will be absorbed into
  the Paris anchor. Acceptable per product stance; correctable later with
  `research_match_overrides` once noticed.
- **Campground category must be re-tuned before M10** — the proximity defaults here are
  garden-calibrated; the per-category table is the knob.
