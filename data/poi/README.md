# Raw POI captures

Use [agent status triage](../ingestion-agents.md#inspect-ingestion-status) to inspect
active work. Run `ingest:inventory --json` to read indexed files and coverage, and
`ingest:queue --json` to see recommended actions. Use `ingest:import-queue status --json`
for the actual import sequence. The [local dashboard](../../apps/ingestion/README.md) shows
the same inventory and execution evidence.

Refresh inventory from the primary checkout after adding or changing captures. A scan
writes discovery metadata and retains historical missing paths, including temporary test
captures seen by a scan. Check the path and scan commit before restoring a missing file.
Keep originals and record supporting or alternate dispositions with reasons. Use inventory and the
[capture catalog](../poi-research/expected-captures.json) to assess what is present and expected.

Before marking a file `import`, review its category, shape, record identity and granularity.
Flat JSON arrays/JSONL/CSV use the generic extractor. Object-wrapped arrays need a registered
`wrapperPath` or structural extractor; extract the intended array, retaining source provenance.
Do not assume every file in a category folder contains that category. Festival dumps include
lookup tables, articles, venues and historical editions. Unknown captures stay `needs_review`.
Use the CLI's `--edit-file` or the dashboard to save classifications, reasons and priorities.

| Capture                                                                                      | Handling                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rv_campgrounds_data/thedyrt/rv_campgrounds.csv`                                             | Check current inventory for a compatible run. Plan forward-geocoding demand before a whole-file import.                                |
| `rv_campgrounds_data/ridb/facilities_with_addresses.csv`                                     | Registered campground facilities capture (RIDB adapter), with addresses from the RIDB full export.                                                          |
| `rv_campgrounds_data/ridb/facilities.csv`                                                    | Alternate (superseded, kept for provenance): the earlier API capture without addresses; not registered.                                                                                       |
| `rv_campgrounds_data/ridb/campsites_rv_hookup.csv`                                           | Supporting campsite records. Facility enrichment requires a capture with a verified facility key and a separate review of aggregation.                                            |
| `rv_campgrounds_data/osm/caravan_sites.csv` and `uscampgrounds/all_campgrounds_combined.csv` | Registered flat captures; OSM retains `node/way/relation` identity. Preserve source identity and review overlap through matching.                           |
| `rv_campgrounds_data/analysis_summary.json`, `carnival/_extraction_summary.json`             | Supporting analysis, not POI records.                                                                                                                       |
| `music-festivals/apis/jambase_countries.json` and `jambase_genres.json`                      | Supporting API lookup lists, not festivals.                                                                                                                 |
| Empty arrays                                                                                 | No importable records; document the missing capture instead of treating empty extraction as success.                                                        |
| Wrapped festival/carnival exports                                                            | Inspect the actual array and mappings. Registered Songkick and Festival Atlas captures now declare `festivals`; other unregistered wrappers require review. |

The source registry explicitly assigns categories only to reviewed captures. New files retain
`needs_review` until an operator or bot records a decision. Some source notes describe older
exports that are absent from this checkout; the refreshed inventory lists actual files.
Success on one sample does not finish its file or category. After full processing, review
degraded/excluded records, event dates, location quality and duplicates separately.
