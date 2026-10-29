# Location quality fixes — 2026-10-29

Follow-up to the [Biennial Foundation preflight](biennial-foundation-preflight.md)
(continuation receipt in PR #69). That run proved the pipeline structurally sound but
published wrong or coarse inferred points for all three records and replaced the
existing Aichi Triennale canonical's correct Nagoya inferred marker with a point in
Urayasu, Chiba. The human approved fixing location handling and validating on the
same three records. Runbook behavior is in
[Standardized location enrichment](../data/poi-ingestion.md#standardized-location-enrichment).

## What changed

1. **Canonical inferred-slot ranking** (`canonical-points.ts`). The source slot keeps
   anchor/trust order. Inferred candidates rank first by evidence: a lookup that
   contradicts its listed city (and lies over 50 km from its source point) ranks last,
   a supplied street address beats venue/name text, then point > city > region >
   country. Ties keep anchor/trust order. The builder version stays
   `canonical-build-v7`; existing builds are not swept and pick up the ranking at
   their next rebuild.
2. **Placeholder locality** (`location.ts`, `geocode.ts`). `Various`, `Various venues`,
   `TBA`, `Online`, `Multiple locations` and similar filler never enter a forward
   query. Captured text is unchanged. With a source point and only a country left,
   no forward lookup runs.
3. **City contradiction check** (`geocode.ts`). A venue/name/address result whose
   Latin-script locality never names the listed city, and that is over 50 km from
   the source point or has none, triggers one city-only retry. A city result within
   50 km confirms the original (exonyms such as Venice/Venezia). Otherwise the original
   is kept only as `validation.forward.rejected` and the city result is used.
4. **Country precision** (`geocode-precision.ts`, migration
   `202610292030__country_coordinate_precision.sql`). Provider `country` types and
   country-only addresses are `country` (previously `region`/`city`). Evidence version
   `geocode-precision-v2`; v1 stays readable. Cached hits that saved their provider
   row are reclassified without a refetch. The migration widens the
   `research_poi_geocodes.precision` and `research_pois.coordinate_precision` checks.

## Validation

- `check-types` and the app contract check pass. 231 location/precision/pipeline
  unit tests pass, including new Aichi/Urayasu, Venice/Venezia, Nigeria and
  placeholder cases.
- The rollback-only integration tests `two-locations`, `location`,
  `normalization-coordinates` and `location-assessment` pass under owned maintenance.
- Live bounded validation: new run `30d2f461-6f55-4a42-858f-42d6af6cf14a`
  (`--limit 3 --reprocess normalize`, smoke job `10f5ba4b…`). The first execution
  `14d6780d…` failed on the old precision check constraint, which is how the
  migration was found. After the migration, foreground resume `91610ee2…` finished
  with `requested_scope_verified`, all eight verify checks ok. The run made 4
  normalization requests (one interrupted by the stop), 3 embeddings and 1 new
  geocode call (`Nagoya, Japan`). Estimated priced cost: $0.0019.

| Record       | Before                                                                  | After                                                                                                                              |
| ------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Adelaide     | Source centroid (`point`) + "Various Restaurants", Melbourne            | Source centroid only; no placeholder or country-only lookup                                                                        |
| AFiRIperFOMA | Nigeria centroid labelled `city`                                        | Same point labelled `country`                                                                                                      |
| Aichi        | Canonical inferred marker moved to Urayasu, Chiba (Biennial Foundation) | Urayasu kept as rejected evidence; own inferred is Nagoya city; canonical inferred marker restored to biennale_com's address point |

The live run used the revision before the 50 km exonym gate was added. For these
three records the gate changes nothing: Urayasu is 274 km from Aichi's source point
and 270 km from the Nagoya city result, and the other two records have no city lookup.

## Still open

- **Adelaide's source point** is Australia's country centroid (Google's
  `-25.2744, 133.7751`) labelled `point`. Detecting supplied centroids needs a
  reference dataset: `geo_centroids` is empty and `applyCentroidRules` is unused.
- **Country-precision publication** is a product decision. AFiRIperFOMA still
  publishes a marker at Nigeria's centroid.
- **Existing canonicals** built before this change keep their inferred selection until
  rebuilt. A read-only audit for published inferred points with a listed-city conflict
  would size a targeted rebuild.
- The 304-record Biennial Foundation file remains on hold until these decisions are made.

## PR #70 review follow-up — 2026-10-29

Both Codex review findings were reproduced with regression fixtures and fixed on
`claude/location-quality-fixes`:

- A definitive city-only miss cannot confirm a conflicting venue/address result,
  including when the record has no source coordinates. With no usable point the
  record stays unresolved; the paid hit and definitive miss remain in the query
  cache, and replay makes no provider calls.
- Country-only query suppression now requires `coordinate_source=source` or `url`.
  Legacy geocoded and unclassified coordinates still allow a country query, so
  country-level inferred evidence can be acquired without inventing source evidence.

Review also found and fixed two canonical-ranking errors. A city-only fallback
no longer inherits address priority from its rejected address query. Successful
city confirmation is persisted in `validation.forward.city_confirmation` and
included in the artifact hash; canonical ranking uses that independent city point
to avoid flagging an accepted exonym such as Venice/Venezia again. Existing
artifacts remain readable; query/cache/builder versions and historical builds stay
unchanged.

Validation on the review revision:

- `pnpm --filter @lib/db-map check-types`, including the app contract check, passes.
- 204 unit tests pass with no skips: location/resume, extractor, precision,
  two-locations, assessment, pipeline versions, provider and inventory coverage.
- Five database regressions pass: `two-locations`, `location` and
  `normalization-coordinates` use the development database under owned maintenance
  and roll back every fixture; `canonical-cache` and `location-assessment` use
  disposable loopback PostgreSQL databases. The latter was migrated from this
  checkout, including the additive country-precision migration.
- Provider requests are mocked or forbidden throughout. No live reprocessing,
  historical rebuild, production migration or backlog launch was performed.

The review started with no workers, source locks, admitted workers, local ingestion
scripts or unresolved launch claims. Owned maintenance protected runtime edits and
the rollback checks; no active ingestion run needed stopping. The 304-record import
remains on hold. Final control readback confirmed maintenance off and quiescence;
all three Map coordinator/import automations remain paused. The disposable
PostgreSQL server was stopped after validation.

## Second PR #70 review — whole-name city matching — 2026-10-29

Codex found that the city check matched any single listed-city token anywhere in the
result, including state, county, country and the display label. `Kansas City` reduced
to `KANSAS`, so a Wichita, Kansas result counted as naming it and skipped verification;
any label in Mexico satisfied `Mexico City`. The human required that a city name is
never reduced this way and that the most accurate location is kept.

- `resultNamesListedCity()` now compares the listed city's **whole** folded name
  (qualifier after a comma ignored; `St`/`Saint`, `Mt`/`Mount`, `Ft`/`Fort` and a
  result's `City of` prefix normalized) for equality with city-level fields only: city,
  town, village, hamlet, municipality, suburb, city district. State, county, country
  and the label never confirm a city; a shorter name (`York`) never matches a longer
  one (`New York`).
- A result that is not name-confirmed, including one with no Latin-script city field,
  is kept only within 50 km of the source point; otherwise the city-only lookup must
  confirm it. Previously unreadable labels skipped verification entirely.
- `Multiple`, `Several` and `Many` are filler only with a noun (`Many venues`); a town
  named Many is kept. `Various`, `TBA`, `Online` etc. stay filler on their own.
- **Review flag.** `locationReviewSql()` derives `missing_location` (no plottable
  candidate) and `coarse_location_only` (every candidate is city/region/country) from
  stored evidence, with no backfill. `ingest:report` shows the counts as
  "Location review (advisory)". The live database has 3 of 45,921 research POIs
  flagged: AFiRIperFOMA (`coarse_location_only`, country) and one `missing_location`
  each from RIDB and BGCI. Supplied centroids labelled `point` (Adelaide) are not
  detected; that needs a centroid reference dataset.

Fixtures whose geocode results carried no city name now include one, because an
unverifiable result is no longer trusted without a distance check. This includes the
CI-only `location-assessment` integration fixture (an Austin record whose cached
result sat 1,100 km away with no city), which failed the `location` check at `8e65d00`.
Canonical ranking now also reads the listed city and address from
`source_location_hints` (third Codex finding), matching `listedLocality()`.
`location-assessment` and `canonical-cache` were rerun on a disposable local
PostgreSQL 18 (TCP-only, C locale, stopped afterwards). No live
reprocessing, provider call or rebuild was made for this revision.

Follow-up (separate PR): map/API filter to include, exclude or show only records
flagged for location review or missing a geocode or listed address, for debugging.
