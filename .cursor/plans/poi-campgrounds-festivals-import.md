# Runbook: Campground and Music Festival Ingestion

> Companion to `.cursor/plans/poi-ingestion-unfinished-work.md` (Workstream E). Concrete
> per-source files, commands, and gotchas for the next two categories. Everything here uses
> the standard staged pipeline; see `docs/poi-ingestion.md` for stage semantics and
> `docs/poi-research/capture-spec.md` for the raw-file shape the generic extractor reads.

## Pre-flight (once per session)

```bash
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter @lib/db-map ingest:report          # snapshot the before state
```

Standard per-source sequence (until `ingest:run` exists):

```bash
pnpm --filter @lib/db-map ingest:extract <slug> <absolute-file> --category <cat> [--limit N] [--dry-run]
pnpm --filter @lib/db-map ingest:normalize --source <slug>
pnpm --filter @lib/db-map ingest:geocode  --source <slug> --geocode-limit 4500
pnpm --filter @lib/db-map ingest:embed    --source <slug>
pnpm --filter @lib/db-map ingest:match    --source <slug>
pnpm --filter @lib/db-map ingest:match    --consolidate-only
pnpm --filter @lib/db-map ingest:report   --source <slug>
```

Always dry-run extract with `--limit 5` first and eyeball the preview JSON: id stability,
name, coordinates, website vs source_url.

Note: `ingest:extract` resolves relative file paths against `lib/db-map/`, so pass
absolute paths (e.g. `/workspace/docs/poi/...`) or paths relative to that package.

---

## Campgrounds (`--category campground`, or `rv`/`tent` when a file is specifically that)

Volumes are large (~284k records across sources; ~206k RV-relevant). Ingest in this order;
each later source mostly enriches/merges into the earlier ones.

### 1. `ridb` — RIDB federal facilities (trust 90) — custom extractor needed

- File: `docs/poi/rv_campgrounds_data/ridb/facilities.csv` (~6k facilities).
- **Never ingest** `campsites_rv_hookup.csv` / campsite-level files as POIs — 122k
  individual campsite pads would flood the map. If campsite data is wanted later,
  aggregate it into per-facility attributes (hookup counts) in the extractor.
- Custom extractor because: `FacilityDescription` is HTML (strip tags, keep text),
  `FacilityReservationURL`/`Keywords`/`Activities` should become attributes,
  `FacilityEmail` has trailing whitespace, and `FacilityID` is the stable id.
- `FacilityTypeDescription == "Campground"` filter via `isPoi` (the dump may include other
  facility types).
- Has point coordinates → zero geocoder spend.

### 2. `uscampgrounds` — uscampgrounds.info (trust 55) — generic extractor works

- File: `docs/poi/rv_campgrounds_data/uscampgrounds/all_campgrounds_combined.csv` (13k).
- Columns `lon`/`lat`/`name`/`phone`/`region` map automatically; `code` is NOT globally
  unique on its own — verify `(code)` uniqueness first; if duplicated, add a tiny custom
  extractor keyed on `code + state` (or pre-process the CSV adding `source_record_id`).
- 2014-era data: treat as seed/corroboration; its role is boosting popularity and
  cross-checking coordinates, not authoritative contact info (trust 55 already encodes
  this).
- `amenities`/`hookup_type` codes (E/WE/WES/NH…) land in attributes as-is; decode later in
  the app or triage stage if ever needed.

### 3. `thedyrt` — The Dyrt (trust 50) — generic extractor works

- File: `docs/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv` (43k RV-relevant).
- `id` column is The Dyrt's numeric id (stable), `lat`/`lon` present, `website` is the
  campground's own site (correct for `website`), rich RV attribute columns
  (electric_hookups, big_rig_friendly, max_vehicle_length_ft…) flow into attributes
  automatically.
- Largest single source — consider `--limit` slices for the first run and watch
  `ingest:report` between slices.

### 4. `osm_camp` — OpenStreetMap caravan sites (trust 70) — small custom extractor

- File: `docs/poi/rv_campgrounds_data/osm/caravan_sites.csv` (36k caravan_site + camp_site).
- Needs a custom extractor for one reason: `source_record_id` must be `"{osm_type}/{osm_id}"`
  (same convention as the garden `osm` extractor) so cross-source strong-ID matching works,
  and `all_tags` JSON should be parsed into attributes.
- OSM hookup data is sparse; treat as global coordinate/coverage data (per the folder
  AGENTS.md), especially for Europe where US sources have nothing.
- Category note: rows are `caravan_site` vs `camp_site` — map to `rv` vs `campground` by
  running two extract passes with a `--category` each and an `isPoi`-style filter, or
  ingest all as `campground` first (simpler; sub-categorization can come later).

---

## Music festivals (`--category music_festival`)

Temporal POIs: expect one research row per edition; the matcher collapses editions
(`recurringEventLikely`) into one canonical with `canonical_poi_occurrences`.

**Blocker to decide first**: city-precision publish policy (see main plan, Workstream E).
Festivals are geocoded locality-only; without venue coordinates most will land on city
centroids, which `rebuildCanonicalPoi` currently hides.

### 1. `resident_advisor` — RA.co (trust 70) — needs unwrap (custom or pre-process)

- File: `docs/poi/music-festivals/apis/resident_advisor_festivals.json` (3.5k).
- Wrapper object `{ source, url, ..., festivals: [...] }` → either a 20-line custom
  extractor or a one-off `jq '.festivals'` to a spec-conformant file.
- Per record: `ra_event_id` = stable id, ISO `start_date`/`end_date`, `venue` + `city` +
  `country` (100% coverage), no coordinates → geocoder (venue+city queries work well).
- Electronic-music skew; fine, it exercises the temporal path best.

### 2. `musicfestivalwizard` — MFW (trust 65) — generic extractor works (verified)

- File: `docs/poi/music-festivals/directories/musicfestivalwizard_festivals.json` (10.8k).
- `url` becomes the stable id + source_url automatically; `start_date`/`end_date` are
  `YYYYMMDD`, which the deterministic date parser already handles (no LLM cost).
- Names embed edition years ("110 Above Festival 2026") — this is the main test case for
  edition collapsing / the triage name-canonicalization workstream.
- `website` field is the festival's official site when present; `url` is the listing.

### 3. `viberate` (trust 70) and `ticketmaster` (trust 75) — have coordinates

- `viberate_festivals.json` (8.6k): top-level array, `coordinates` object needs flattening
  to lat/lng (custom extractor or pre-process), `uuid`/`slug` stable ids, capacity tier +
  genres into attributes. Coordinates → no geocoding.
- `ticketmaster_festivals_full.json` (4.1k): wrapper `{metadata, events}`; venue object
  contains lat/lon; `id` stable; ISO dates. Custom extractor recommended (nested venue).
- These two give festivals venue-level coordinates, which matters if the city-precision
  policy stays strict.

### 4. `musicbrainz` (trust 85) — largest, needs strict filtering

- Files: `musicbrainz_festivals_01_of_16.json` … `_16_of_16.json` (30k events total,
  ~450MB). Includes events back to 1873 and many non-festival event types.
- Custom extractor required: filter to festival-type events, keep MBID as stable id +
  strong-ish identifier attribute, extract venue/place relations for coordinates.
- Ingest last: highest volume, most filtering risk; by then dedup behavior against the
  directory sources is well understood.

### 5. Rest of the backlog

`edm_dance_directory.json` (10k; has `is_festival` flag — use it as the `isPoi` gate so
clubs/venues never become festivals), `songkick`, `jambase`, `festivism`,
`festivalatlas`, plus the `directories/`, `genres/`, `regional/`, `wikipedia/` folders.
Register slugs + trust in `sources.ts` and prefer converting files to the capture spec over
writing extractors.

---

## Carnivals / art fairs backlog note

`docs/poi/carnival/` already has two implemented extractors (`global_carnivalist`,
`rough_guides`). The strongest unimported files there:
`wikidata_carnivals.json` (851 rows, top-level array, `wikidata_id` strong IDs — near
spec-conformant) and `fecc_carnivalcities_events.json` (wrapper object but has lat/lon +
ISO dates). Same playbook applies.

---

## After each source

1. `ingest:report --source <slug>` — check pending=0, not-ready counts explained.
2. Spot-check 5 canonicals in the app (dense region + detail drawer).
3. Re-run the full sequence once — every stage should report ~0 new work (idempotency).
4. Record counts + anomalies in `docs/poi-ingestion-validation.md`.
