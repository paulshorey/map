# Festival Data Gap Analysis — Post-Enrichment Report

**Updated**: June 21, 2026  
**Enrichment branch**: `feat/music-festivals-enrichment`  
**Total records**: ~93,400 across 35+ sources (before deduplication)

---

## Summary

This document tracks data quality (location, dates, status, website) across all festival sources after the enrichment pass. Gaps that remain are noted with their root cause and recommended next steps.

---

## Coverage by Source

### APIs

| Source | Records | City | Country | Lat/Lng | Start Date | End Date | Status | Website |
|--------|--------:|------|---------|---------|------------|----------|--------|---------|
| **MusicBrainz** (16 files) | 30,276 | 81% | 78% | 52% | via `life_span.begin` | via `life_span.end` | 100% | 9% |
| **Viberate** | 8,584 | — | 100% | 100% GPS | 100% | 100% | 100% | — |
| **EDM Dance Directory** | 9,901 | 100% | 100% | — | 100% | — | — | 100% |
| **Ticketmaster** | 4,109 | 99% | 99% | 99% | 100% | 10% | 100% | 100% |
| **Resident Advisor** | 3,525 | 100% | 100% | — | 100% | 100% | implicit active | — |
| **JamBase** | 1,257 | 100% | 100% | 100% | 100% | 100% | via `eventStatus` | — |
| **Songkick (API)** | 75 | 100% | 100% | — | 100% | — | — | — |

**Notes:**
- MusicBrainz: city/country flattened from nested `area` relations via 4-pass city lookup; lat/lng from venue coordinates. Dates in `life_span.begin`/`life_span.end`. Website from `url` relations (only 9% have one — MusicBrainz rarely stores official festival websites).
- Viberate: GPS present for 100%; city requires reverse geocoding at ingestion (not done here per user instructions). Website not available from Viberate API.
- EDM Dance Directory: end_date not available from source.
- Ticketmaster: location nested under `venue` dict. End dates mostly missing from API response.
- JamBase: venue city/state/country/lat/lng/address all flattened as top-level fields.

---

### Directories

| Source | Records | City | Country | Venue | Start Date | End Date | Status | Website |
|--------|--------:|------|---------|-------|------------|----------|--------|---------|
| **Music Festival Wizard** | 10,800 | 99% | 100% | — | 97% | 97% | — | — |
| **Festivism** | 5,206 | 84% | 99% | 100% | — | — | 100% | — |
| **Festival Alarm** | 5,104 | 100% | 83% | 100% | 89% | 89% | — | — |
| **FestivalAbroad** | 3,380 | 96% | 98% | — | 90% | 65% | — | — |
| **Festivalando** | 1,800 | 24% | 42% | — | 0% | — | — | — |
| **FestApp** | 1,796 | 100% | 100% | — | 100% | 100% | — | — |
| **Songkick Browse** | 1,734 | 100% | 100% | 100% | 100% | 100% | — | 37% |
| **FestivalAtlas** | 1,690 | 100% | 100% | — | 100% | 100% | — | — |
| **ThatFestivalSite** | 1,415 | 100% | 100% | 99% | 100% | 65% | 100% | 41% |
| **FestivalFinder EU** | 551 | 100% | 100% | — | 100% | 100% | — | — |
| **eFestivals UK** | 342 | 97% | implicit UK | — | 97% | — | — | — |
| **Skiddle** | 323 | — | — | — | — | — | — | — |
| **Festivals.directory** | 85 | 100% | 100% | — | 100% | 100% | — | — |

**Notes:**
- Festivism: date data intentionally not stored by source for historical festivals. Official website field not available from Festivism. City reached 84% via page crawl.
- Festival Alarm: `country_original` field preserved; German states normalized → "Germany", etc. End date computed from `date + duration + year` fields (89% computed). Country 83% (many entries list region only).
- Festivalando: WordPress blog articles, not structured event pages. Very limited metadata extraction possible. Start dates are relative text strings, not parseable.
- Songkick Browse: official_website 37% via Wikipedia/Wikidata cross-reference (Wikipedia lacks entries for most).
- Skiddle: API key applied for but not received — **skip entirely for now**.

---

### Genres

| Source | Records | City | Country | Start Date | End Date | Website |
|--------|--------:|------|---------|------------|----------|---------|
| **Concerts Metal** | 590 | 93% | 96% | 0% | — | — |
| **Bluegrass** | 374 | 99% | 100% | 100% | 100% | — |
| **Festifeed** | 254 | 98% | 98% | 100% | 100% | 87% |
| **Downbeat Jazz** | 142 | 80% | 98% | 0% | — | 31% |
| **Metal Travels** | 93 | 0% | 100% | 0% | — | 23% |
| **SmoothJazz** | 158 | 96% | 100% | 5% | — | — |
| **World Music Central** | 78 | 100% | 100% | 0% | — | 55% |

**Notes:**
- Concerts Metal: start_date not available from source listing pages. Enriched via Wayback Machine cached pages.
- Downbeat Jazz, Metal Travels, SmoothJazz, World Music Central: source pages do not expose JSON-LD structured data. Dates would require individual festival website crawl.
- Metal Travels: city not available from source listing (only country).

---

### Wikipedia

| Source | Records | City | Country | Status | Wikidata QID | Website |
|--------|--------:|------|---------|--------|-------------|---------|
| **Wikipedia Festivals** | 830 | 100% | 100% | 58% | 57% | 41% |
| **Wikipedia Country Music** | 42 | 99% | 100% | — | — | — |

**Notes:**
- Official website sourced from Wikidata P856 property (41% of records have one).
- Wikidata QID (57%) enables future enrichment from any Wikidata property.

---

### Regional

| Source | Records | City | Country | Start Date | End Date |
|--------|--------:|------|---------|------------|----------|
| **World Festival Directory** | 103 | 100% | 100% | — | — |
| **GetFestiWise** | 103 | 0% | 0% | 0% | — |
| **Bandwagon Asia** | 41 | 100% | 100% | 100% | 100% |

**Notes:**
- GetFestiWise: needs full enrichment — location and dates not yet extracted.

---

### Other

| Source | Records | Notes |
|--------|--------:|-------|
| **Bandsintown** | 29 | API fully blocked; partial scrape only |
| **Setlist.fm** | 26 | Top 26 by setlist count; API requires key |

---

## Remaining Gaps & Root Causes

| Gap | Affected Sources | Root Cause | Recommended Fix |
|-----|-----------------|------------|-----------------|
| Festivalando city/country (24%/42%) | Festivalando | WordPress blog format, no structured data | Manual curation or skip |
| SmoothJazz dates (5%) | SmoothJazz | Festival homepages don't expose JSON-LD | Individual page crawl |
| Downbeat Jazz dates (0%) | Downbeat Jazz | No structured date data on source pages | Individual page crawl |
| Metal Travels city (0%) | Metal Travels | Source only shows country | Cross-reference with MusicBrainz/Wikipedia |
| Metal Travels dates (0%) | Metal Travels | No structured date data on source | Individual page crawl |
| World Music Central dates (0%) | WMC | Source does not list dates | Individual festival site crawl |
| Concerts Metal dates (0%) | Concerts Metal | Source lists past festivals without dates | Wayback Machine date parsing |
| MusicBrainz website (9%) | MusicBrainz | MusicBrainz rarely stores official websites | Cross-reference with Wikipedia/Wikidata |
| MusicBrainz lat/lng (52%) | MusicBrainz | Many events lack venue coordinates in MB | Geocode city+country at ingestion |
| Viberate city (0%) | Viberate | Source only provides GPS + country | Reverse geocode at ingestion |
| Ticketmaster end_date (10%) | Ticketmaster | API response rarely includes end date | Parse `dates.end` when present |
| Songkick website (37%) | Songkick Browse | Wikipedia/Wikidata lacks entries for most | Remaining 63% needs direct web search |
| ThatFestivalSite end_date (65%) | ThatFestivalSite | Not all festival pages list end date | Crawl individual festival pages |
| Skiddle (all fields) | Skiddle | API key not yet received | Revisit when key arrives |
| GetFestiWise (all fields) | GetFestiWise | Not yet enriched | Crawl individual pages |

---

## Deduplication Keys

When merging across sources at ingestion, use:

1. **MusicBrainz MBID** (`mbid`) — stable cross-referenced ID used by Wikidata, Setlist.fm, JamBase
2. **Wikidata QID** (`wikidata_qid`) — available for 57% of Wikipedia entries
3. **Festival name + year + country** — fuzzy match for sources without structured IDs
4. **Lat/lng + date** — spatial-temporal dedup for GPS-equipped sources (Viberate, JamBase, Ticketmaster)

---

## Data Volume Summary

| Folder | Files | Records |
|--------|-------|--------:|
| apis/ | 19 | ~57,746 |
| directories/ | 14 | ~35,162 |
| genres/ | 7 | ~1,789 |
| wikipedia/ | 3 | ~1,702 |
| regional/ | 3 | ~247 |
| other/ | 2 | ~55 |
| **Total** | **48** | **~96,701** |

*Note: JamBase genres (20 records) and countries (255 records) are reference files, not festival records.*
