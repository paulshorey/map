# Global Music Festival Data

Comprehensive data dump of music festivals worldwide, sourced from 20+ directories, APIs, and specialized databases. Extracted June 2026.

**Total records across all files: ~93,400** (before deduplication)

---

## Folder Structure

### `apis/` — Structured API Sources
| File | Records | Source | Notes |
|------|--------:|--------|-------|
| `musicbrainz_festivals_01_of_16.json` – `_16_of_16.json` | 30,276 total | [MusicBrainz](https://musicbrainz.org) | Official June 17 2026 dump; events back to 1873; includes MBID, venue & artist relations |
| `viberate_festivals.json` | 8,584 | [Viberate](https://viberate.com/festival-finder/) | GPS coords, capacity tier (Mega/Large/Medium/Small), subgenres, rank |
| `ticketmaster_festivals_full.json` | 4,109 | [Ticketmaster Discovery API](https://developer.ticketmaster.com) | Venue lat/lon, price ranges, genre/subgenre hierarchy |
| `resident_advisor_festivals.json` | 3,525 | [RA.co](https://ra.co) GraphQL | Electronic music; 100% date/country coverage; top countries: UK, DE, US, NL, FR |
| `edm_dance_directory.json` | 9,901 | [EDM Dance Directory](https://edmdancedirectory.com) | REST API; 291 cities; DJs + venues |
| `songkick_festivals.json` | 75 | [Songkick](https://songkick.com) | Public browse (full API requires paid key) |
| `jambase_festivals.json` | 24 | [JamBase](https://data.jambase.com) | Public page only (full API: free 14-day trial at data.jambase.com) |

### `directories/` — Curated Web Directories
| File | Records | Source | Notes |
|------|--------:|--------|-------|
| `musicfestivalwizard_festivals.json` | 9,800 | [Music Festival Wizard](https://musicfestivalwizard.com) | US/Canada/Europe guides |
| `festivism_festivals.json` | 5,206 | [Festivism](https://festivism.com) | 127 countries, 68 genres, founded years back to 1778 |
| `festival_alarm_festivals.json` | 5,104 | [Festival Alarm](https://festival-alarm.com) | 2022–2026; **includes ticket prices + visitor counts** |
| `festivalabroad_festivals.json` | 3,380 | [Festival Abroad](https://festivalabroad.com) | 92 countries; 90% with dates via JSON-LD |
| `festivalando_festivals.json` | 1,800 | [Festivalando](https://festivalando.com.br) | Latin America focus |
| `festapp_festivals.json` | 1,796 | [FestApp](https://festapp.io) | 72 countries; JSON-LD structured data |
| `songkick_browse_festivals.json` | 1,734 | [Songkick](https://songkick.com/festivals/countries/world) | 15 countries browsed |
| `festivalatlas_festivals.json` | 1,690 | [FestivalAtlas](https://festivalatlas.io) | Europe only; 100% have start_date + location |
| `thatfestivalsite_festivals.json` | 1,415 | [That Festival Site](https://thatfestivalsite.com) | 95% have full artist lineups (10–50+ artists each) |
| `festivalfinder_eu.json` | 551 | [FestivalFinder.eu / EFA](https://festivalfinder.eu) | European Festivals Association members; 45 countries |
| `efestivals_uk.json` | 342 | [eFestivals](https://efestivals.co.uk) | UK-focused with lineup info |
| `skiddle_festivals.json` | 323 | [Skiddle](https://skiddle.com/festivals/) | UK + Europe |
| `festivals_directory.json` | 85 | [Festivals.directory](https://festivals.directory) | Global curated descriptions |

### `genres/` — Genre-Specialist Sources
| File | Records | Genre | Source |
|------|--------:|-------|--------|
| `concerts_metal_festivals.json` | 590 | Metal | [Concerts-Metal.com](https://en.concerts-metal.com/festivals.html) |
| `bluegrass_festivals.json` | 374 | Bluegrass/Folk/Roots | [Bluegrass Country](https://bluegrasscountry.org); 19 countries |
| `festifeed_festivals.json` | 254 | Electronic | [Festifeed](https://festifeed.com); festivals + club nights |
| `smoothjazz_festivals.json` | 158 | Jazz | [SmoothJazz.com](https://smoothjazz.com/festivals) |
| `downbeat_jazz_festivals.json` | 142 | Jazz | DownBeat + IJFO + SmoothJazz combined |
| `metal_travels_festivals.json` | 93 | Metal | [Metal Travels](https://metaltravels.com/festivals/); 27 countries |
| `world_music_central_festivals.json` | 78 | World Music | [World Music Central](https://worldmusiccentral.org); 30 countries |

### `wikipedia/` — Wikipedia Category Trees
| File | Records | Notes |
|------|--------:|-------|
| `wikipedia_festivals.json` | 830 | Structured: country, genre, founded year, capacity, status |
| `wikipedia_festival_names.json` | 830 | Name index with Wikipedia categories |
| `wikipedia_country_music_festivals.json` | 42 | Country music by continent (Oceania, Europe, Americas) |

### `regional/` — Regional Directories
| File | Records | Region | Source |
|------|--------:|--------|--------|
| `world_festival_directory.json` | 103 | Global (A-Z) | [World Festival Directory](http://worldfestivaldirectory.com) |
| `getfestiwise_festivals_full.json` | 103 | Global by genre | [GetFestiWise](https://getfestiwise.com) |
| `bandwagon_asia_full.json` | 41 | Southeast Asia | [Bandwagon Asia](https://bandwagon.asia) |

### `other/` — Other Sources
| File | Records | Source | Notes |
|------|--------:|--------|-------|
| `bandsintown_festivals.json` | 29 | [Bandsintown](https://bandsintown.com) | Partial — API fully blocked |
| `setlistfm_festivals.json` | 26 | [Setlist.fm](https://setlist.fm) | Top 26 by setlist count; API requires key |

---

## Known Gaps / Limitations
- **JazzFestivalsWorldwide.com** — domain parked/sold, no longer active
- **FindYourFest** — data embedded in Power BI dashboard, not accessible programmatically
- **Ticketmaster, Songkick, PredictHQ, Setlist.fm** — full bulk access requires paid/registered API keys
- **Africa & South/Southeast Asia** — underrepresented in most directories; best covered by MusicBrainz + Festivism

## Deduplication Keys
When merging across sources, use:
- **MusicBrainz MBID** (`mbid` field) — open, stable, cross-referenced by Wikidata, Setlist.fm, JamBase
- **Viberate UUID** (`uuid` field)
- **Ticketmaster ID** (`id` field)
