# Unfinished captures and review status — 2026-11-06

Owner request: list what is still unfinished and cannot produce final canonical records, and
make anything that did reach the canonical table filterable for later review.

## Where things stand

The 2026-11-05 purge removed every imported record, so **no capture currently has canonical
POIs**: all 251 inventoried files are unfinished (`ingest:queue`: 155 `start`, 17 `review`,
79 `blocked`, 0 `complete`). By disposition: 157 import, 17 needs_review, 64 supporting,
7 alternate, 6 ignored. Supporting/alternate/ignored files are not meant to become POIs on
their own.

Canonical POIs created from a capture that is still `needs_review` now carry the review flag
`source_needs_review` (`/api/pois?review=source_needs_review`, the map's review dropdown,
`ingest:review-flags`). Reclassifying a capture and running
`ingest:review-flags --refresh` clears or sets the flag for existing POIs.

## The 17 captures marked `needs_review`

### Never classified (no category yet) — the "10 captures"

| Capture | What it is | Blocker |
| --- | --- | --- |
| `music-festivals/other/bandsintown_festivals.json` | Bandsintown "top festivals 2025" API extract | No category/disposition decided; small curated list |
| `music-festivals/other/setlistfm_festivals.json` | setlist.fm festival list with metadata | Same |
| `music-festivals/regional/bandwagon_asia_full.json` | Bandwagon Asia festival directory | Same; region-scoped |
| `music-festivals/regional/getfestiwise_festivals_full.json` | GetFestiwise directory | Same |
| `music-festivals/regional/world_festival_directory.json` | World festival directory | Same |
| `music-festivals/ticketmaster_art_events.json` | Ticketmaster arts events | Mixed event types; may not be festivals |
| `music-festivals/wikipedia/wikipedia_country_music_festivals.json` | Wikipedia list (name, city/venue, country) | Same; no coordinates |
| `music-festivals/wikipedia/wikipedia_festival_names.json` | ~830 Wikipedia festival names | Names only: likely `supporting` (enrichment), not POIs |
| `music-festivals/wikipedia/wikipedia_festivals.json` | ~830 Wikipedia festivals with countries | Overlaps the names file; pick one as import, the other alternate |
| `rv_campgrounds_data/ridb/campsites_rv_hookup.csv` | RIDB individual campsites (81 MB) | Child data of RIDB facilities: should be `supporting`, joined to facilities, never imported as campgrounds |

Likely decision: the nine music-festival files → `import` / `music_festival` after a 1–5
record smoke each (Wikipedia names → `supporting` or `alternate`); RIDB campsites →
`supporting`. Set them in the dashboard file drawer (disposition/category) or
`ingest:inventory`.

### Classified but held by a source-readiness review (2026-10-15)

| Capture | Category | Blocker |
| --- | --- | --- |
| `art-fairs/regional/ireland_events.json` (475) | art_fair | 423 generic "Event" rows (cinema, video art): needs a category filter policy |
| `botanical_gardens_data/bgci_gardens_full.json` (3,649) | botanical_garden | Readiness concern fixed since (geocoder fallbacks); already in the re-import plan. **Reclassify to `import`** before importing, or its POIs get `source_needs_review` |
| `botanical_gardens_data/osm_botanical_gardens.csv` (3,421) | botanical_garden | Only 827 valid coordinates: recapture Overpass way/relation centers |
| `botanical_gardens_data/wikidata_botanical_gardens.json` (3,665 QIDs) | botanical_garden | Duplicate SPARQL rows need per-entity aggregation; 510 missing names |
| `rv_campgrounds_data/osm/caravan_sites.csv` (56,157) | campground | 9,665 unnamed: **decided 2026-11-06** — generate a name, flag `generated_name` (separate task) |
| `rv_campgrounds_data/ridb/facilities.csv` (5,979) | campground | No address/locality columns: **decided 2026-11-06** — recapture addresses if the API has them, else flag `missing_address` (separate task) |
| `rv_campgrounds_data/uscampgrounds/all_campgrounds_combined.csv` (13,011) | campground | 2014 historical data; field semantics (nearest_town, region) need review |

## Other unfinished work

- 155 `start` files are intended imports never run since the purge; the
  [re-import plan](../data/import-plans/reset-20261105.json) covers the nine reviewed ones.
- 79 `blocked` files are mostly supporting/alternate/ignored exports, plus captures without a
  category; they are not expected to produce POIs.
