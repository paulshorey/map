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
