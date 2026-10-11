# Raw POI import queue

Read [data instructions](../AGENTS.md), the [runbook](../poi-ingestion.md), and
[agent operations](../ingestion-agents.md) before operating these captures.
This tree contains downloads and research artifacts, not a list of interchangeable import jobs.
The database inventory, CLI and [local dashboard](../../apps/ingestion/README.md) share status.

```sh
pnpm --silent --filter @lib/db-map ingest:inventory --refresh
pnpm --silent --filter @lib/db-map ingest:queue --json
pnpm dev:ingestion
```

The queue recommends inspection of interrupted full runs, verification of existing outputs,
new full-file work, and classification review. It never launches work. Keep original captures
and history; exclude alternate/supporting files with audited notes rather than deleting them.
Progress is computed from file fingerprints, stage artifacts and verification in PostgreSQL.
Do not write another status JSON here: it could disagree with a resume or another checkout.

Before marking a file `import`, review its category, shape, record identity and granularity.
Flat JSON arrays/JSONL/CSV use the generic extractor. Object-wrapped arrays need a registered
`wrapperPath` or structural extractor; extract the intended array, retaining source provenance.
Do not assume every file in a category folder contains that category. Festival dumps include
lookup tables, articles, venues and historical editions. Unknown captures stay `needs_review`.
Use the CLI's `--edit-file` or the dashboard to save classifications, reasons and priorities.

| Capture                                                                                      | Handling                                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rv_campgrounds_data/thedyrt/rv_campgrounds.csv`                                             | Continue the existing fixed full cohort; inspect its latest execution first. Do not split or restart it to sidestep failure.                                |
| `rv_campgrounds_data/ridb/facilities.csv`                                                    | Registered campground facilities capture with explicit RIDB API column mappings.                                                                            |
| `rv_campgrounds_data/ridb/campsites_rv_hookup.csv`                                           | Individual campsites, not campground facilities. Review aggregation to facility identity before making map POIs.                                            |
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
