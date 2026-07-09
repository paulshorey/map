# Raw POI Research Capture Spec

How to save raw mined/scraped POI data so it flows through the ingestion pipeline
(`research_pois` → `canonical_pois`) with the least friction and the fewest custom
extractors.

Audience: whoever (human or agent) mines source websites/APIs and saves files under
`docs/poi/{category}/`. The mining phase usually cannot call an LLM, so this spec asks for
**verbatim capture in a consistent envelope** — all interpretation, cleanup, categorization,
geocoding, and dedup happen later in the pipeline.

## The one rule that matters most

**Save one record per source listing, as a flat JSON object, in a top-level JSON array or
JSONL file.** Files that follow the field names below need **no custom extractor code**:
`ingest:extract` falls back to the generic capture-spec extractor automatically.

Avoid wrapper objects like `{ "source": ..., "festivals": [...] }` — they require a custom
extractor to unwrap. If your scraper produces run metadata, put it in a sibling
`<file>.meta.json` or the folder README instead.

## Record shape

```jsonc
{
  // ── Identity (required) ──────────────────────────────────────────────
  // A stable id that survives re-scraping. Preference order:
  // 1. the source's own id (bgci id, osm id, MBID, ra_event_id, FacilityID…)
  // 2. the detail-page URL
  // 3. a slug you derive deterministically (never an array index!)
  "source_record_id": "257029",
  "name": "Temple Mountain Campground East",   // required, verbatim from source

  // ── Location (capture whatever the source shows; numbers preferred) ──
  "lat": 38.65677,          // number, not string, when the source has coordinates
  "lng": -110.66122,        // aliases understood: latitude / longitude / lon
  "address": "26633 Main St",
  "city": "Logan",
  "region": "Ohio",          // state/province; aliases: state, state_region
  "country": "US",           // ISO-3166 alpha-2 when known, else full name

  // ── Links (keep these two SEPARATE — this is the #1 capture mistake) ─
  "website": "https://thehockinghills.org",  // OFFICIAL site only; omit if unknown
  "source_url": "https://thedyrt.com/camping/ohio/hocking-hills",  // listing page

  // ── Contact / content (verbatim, optional) ───────────────────────────
  "phone": "435-636-3600",
  "email": "info@example.org",
  "description": "…verbatim source text; HTML is OK, do not summarize…",
  "raw_category": "caravan_site",  // the SOURCE'S label, not our taxonomy

  // ── Events only ───────────────────────────────────────────────────────
  "start_date": "2026-08-20",  // ISO YYYY-MM-DD when the source is unambiguous
  "end_date": "2026-08-22",
  "dates": "August 20-22, 2026", // free-text verbatim when ISO is not certain;
                                 // the pipeline parses it (LLM fallback included)
  "venue": "Gopsall Hall Farm",  // used to improve geocoding for events

  // ── Everything else: keep it, at the top level ───────────────────────
  // Unknown keys are preserved automatically in research_pois.attributes.
  // Do NOT discard source-specific fields, and do NOT force them into a
  // common schema — different sources having different properties is expected.
  "electric_hookups": true,
  "max_vehicle_length_ft": 50,
  "genres": ["Bluegrass", "Jam"],
  "wikidata_id": "Q123456"   // strong IDs enable exact cross-source matching
}
```

## Capture rules

1. **Do not normalize; capture.** Save what the source shows, verbatim. No title-casing, no
   deduplication, no summarizing descriptions, no guessing coordinates. The pipeline owns
   normalization (and can use the LLM there; your scraper cannot).
2. **Stable ids.** Re-scrapes must produce the same `source_record_id` for the same listing,
   or re-imports will duplicate rows. Never use array positions or run counters.
3. **`website` ≠ `source_url`.** `website` is the venue's own official site and becomes a
   match signal and a user-facing field. The directory/listing page goes in `source_url`.
   When in doubt, use `source_url` only.
4. **Coordinates as numbers.** `"lat": "38.65"` (string) works but `"lat": 38.65` is better.
   Records with source coordinates skip the geocoder entirely — capture them whenever the
   source has them, including coordinates embedded in map links (also fine to leave a
   Google-Maps-style URL in an attribute; normalization extracts URL coordinates).
5. **Dates: ISO when certain, verbatim when not.** `start_date`/`end_date` as `YYYY-MM-DD`
   when the source is explicit. Otherwise put the raw phrase in `dates` ("every February",
   "mid may–mid sep") — prose date parsing with LLM fallback exists in normalize.
6. **Strong identifiers are gold.** If the source exposes Wikidata QIDs, OSM ids
   (`osm_type` + `osm_id`), MusicBrainz MBIDs, or official registry numbers, capture them as
   attributes. They produce exact `strong_id` merges with zero LLM cost.
7. **One record per listing, even per edition.** For recurring events, a record per edition
   (with its own dates) is correct — the matcher collapses editions of the same festival
   into one canonical with multiple occurrences. Include the series/base URL as an
   attribute (e.g. `series_url`) when the source has one; it strengthens edition matching.
8. **Non-POI rows are fine, flagged later.** Directory pages sometimes list regions,
   articles, or organizations. Capture them if it is hard to filter during mining; the
   normalize/triage stage marks them `is_poi = false` instead of publishing them.
9. **Keep files raw and committed.** Original downloads (KML/CSV/API dumps) stay in
   `docs/poi/{category}/` unchanged; write the spec-conformant file next to them when the
   original shape does not conform. Never edit a raw dump in place.

## Per-folder README

Each `docs/poi/{category}/` folder (or source subfolder) should have a README/AGENTS.md
covering, per file:

- source name, homepage, and the exact API/scrape method used
- extraction date and record count
- license/attribution notes
- coordinate coverage (what % of records have lat/lng) and any known quirks
- which fields are trustworthy vs junk

The existing `docs/poi/rv_campgrounds_data/AGENTS.md` and
`docs/poi/music-festivals/README.md` are good examples.

## What happens downstream (why these rules exist)

| Capture detail | Pipeline effect |
| --- | --- |
| stable `source_record_id` | idempotent re-imports; unchanged rows keep their canonical link |
| numeric `lat`/`lng` | skips geocoder budget (~4.5k lookups/day) |
| `city`/`region`/`country` | geocode query quality; locality match signal; centroid sanity checks |
| official `website` | anchor status in conflation; same-domain merge signal |
| strong IDs in attributes | `strong_id` merges across sources with zero LLM calls |
| ISO or verbatim dates | event occurrences, date-range API filtering, edition collapsing |
| verbatim `description` | LLM description fusion for the detail drawer |
| source `raw_category` | triage/audit reporting (`ingest:normalize --report-raw-categories`) |

## Registering a new source

Even with the generic extractor, each source needs a metadata entry in
`lib/db-map/scripts/ingest/sources.ts` (slug, display name, homepage, license, attribution,
trust 0–100). That is a 8-line change. Custom extractor code is only needed when the file
shape does not conform to this spec (wrapper objects, HTML-laden CSVs, KML, etc.).
