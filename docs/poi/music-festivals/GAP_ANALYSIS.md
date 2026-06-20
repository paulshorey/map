# Music Festival Data — Gap Analysis & Enrichment Plan

_Generated June 20, 2026. Analyzes all 35 source files across 93,400 records._

---

## Quick Reference: Field Coverage Matrix

| Source | Records | GPS | City | Country | Start Date | End Date | Status | Website | Venue Name |
|--------|--------:|:---:|:----:|:-------:|:----------:|:--------:|:------:|:-------:|:----------:|
| **APIs** | | | | | | | | | |
| musicbrainz (×16) | 30,276 | ~69% | 0% | 0% | 99% | 99% | 0% | ~8% | 0% |
| viberate | 8,584 | ✅ 100% | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% | ⚠️ 100%† | ❌ 0% |
| edm_dance_directory | 9,901 | ❌ 0% | ✅ 99% | ✅ 98% | ✅ 100% | ❌ 1% | ❌ 0% | ✅ 98% | ✅ 100% |
| ticketmaster | 4,109 | ✅ 99% | ✅ 99% | ✅ 99% | ✅ 100% | ❌ 9% | ✅ 100% | ✅ 100% | ✅ 97% |
| resident_advisor | 3,525 | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0% | ✅ 100% | ✅ 100% |
| songkick | 75 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ✅ 100% |
| jambase | 24 | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| **Directories** | | | | | | | | | |
| musicfestivalwizard | 10,800 | ❌ 0% | ✅ 99% | ⚠️ 61% | ✅ 96% | ✅ 96% | ❌ 0% | ✅ 100% | ✅ 98% |
| festivism | 5,206 | ❌ 0% | ⚠️ 48% | ✅ 99% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% |
| festival_alarm | 5,104 | ❌ 0% | ⚠️ 16% | ✅ 83% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% | ✅ 100% |
| festivalabroad | 3,380 | ❌ 0% | ✅ 95% | ✅ 97% | ✅ 89% | ✅ 64% | ❌ 0% | ✅ 100% | ⚠️ 4% |
| festivalando | 1,800 | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| festapp | 1,796 | ❌ 0% | ❌ 0% | ✅ 58% | ✅ 58% | ✅ 58% | ❌ 0% | ✅ 100% | ❌ 0% |
| songkick_browse | 1,734 | ✅ 93% | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% |
| festivalatlas | 1,690 | ❌ 0% | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0% | ✅ 100% | ❌ 0% |
| thatfestivalsite | 1,415 | ❌ 0% | ✅ 100% | ⚠️ 91% | ⚠️ 34% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| festivalfinder_eu | 551 | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 97% | ❌ 0% | ✅ 100% | ❌ 0% |
| efestivals_uk | 342 | ❌ 0% | ✅ 97% | ✅ 100% | ✅ 97% | ✅ 72% | ❌ 0% | ✅ 100% | ❌ 0% |
| skiddle | 323 | ❌ 0% | ❌ 0% | ❌ 0% | ⚠️ 2% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| festivals_directory | 85 | ❌ 0% | ✅ 100% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| **Genres** | | | | | | | | | |
| concerts_metal | 590 | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| bluegrass | 374 | ❌ 0% | ✅ 99% | ✅ 100% | ❌ 0%‡ | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| festifeed | 254 | ❌ 0% | ✅ 98% | ✅ 98% | ✅ 100% | ✅ 100% | ❌ 0% | ✅ 87% | ✅ 98% |
| downbeat_jazz | 142 | ❌ 0% | ✅ 80% | ✅ 97% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| metal_travels | 93 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| smoothjazz | 158 | ❌ 0% | ✅ 96% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 98% | ❌ 0% |
| world_music_central | 78 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| **Wikipedia** | | | | | | | | | |
| wikipedia_festivals | 830 | ❌ 0% | ✅ 99% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 58% | ❌ 0% | ❌ 0% |
| wikipedia_names | 830 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| wikipedia_country_music | 42 | ❌ 0% | ❌ 0% | ⚠️ 21% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| **Regional** | | | | | | | | | |
| bandwagon_asia | 41 | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| getfestiwise | 103 | ❌ 0% | ❌ 0% | ❌ 0% | ⚠️ month | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| world_festival_dir | 103 | ❌ 0% | ✅ 100% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| **Other** | | | | | | | | | |
| bandsintown | 29 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ✅ 79% |
| setlistfm | 26 | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |

_† Viberate URL is the viberate.com page, not the official festival website. ‡ Bluegrass has month + date text (e.g. "June 3–6") but no ISO start_date field._

---

## Per-Source Gap Analysis & Enrichment Plan

---

### 1. MusicBrainz (`apis/musicbrainz_festivals_*.json`) — 30,276 records ⭐ Backbone

**What's good:** Start and end dates (99%), deep historical coverage back to 1873, stable MBIDs for cross-referencing, artist/performer relations in ~70% of records.

**Gaps:**
- **GPS / City / Country: 0% at top level** — location data lives inside `relations[].place.coordinates` (nested), not flattened. ~69% of records have a place relation with GPS already embedded; the data just needs extraction/flattening.
- **Website: ~8%** — official homepages are present only as a relation type (`"official homepage"`), not a top-level field.
- **Status: 0%** — `life_span.ended` is a boolean that effectively encodes active/inactive, but it's not surfaced as a `status` field.

**Enrichment plan:**
1. **Immediate (no API key needed, free):** Write a script to flatten the nested data — extract `relations[].place.coordinates` → `lat/lng`, `relations[].place.area.name` → `city`, `relations[].place.area.country` → `country`, `relations[].url.resource` where `type == "official homepage"` → `website`, and `life_span.ended` → `status: active/inactive`. This would give GPS to ~20,875 records and clean status to all 30,276 with zero additional fetching.
2. **Secondary:** For the ~31% without a place relation, use the `mbid` to query the MusicBrainz API (`https://musicbrainz.org/ws/2/event/{mbid}?inc=place-rels+url-rels`) at 1 req/sec to fill gaps. No key required.
3. **No account needed.** No external services needed.

---

### 2. Viberate (`apis/viberate_festivals.json`) — 8,584 records ⭐ Best GPS Source

**What's good:** 100% GPS, 100% country, 100% start/end date, 100% active/inactive status, capacity tier (Mega/Large/Medium/Small), genre + subgenre, rank.

**Gaps:**
- **City: 0%** — coordinates exist but city name is not stored. This is the biggest gap.
- **Official website: 0%** — only `viberate_url` (the Viberate profile page) is stored, not the festival's own website.
- **Venue name: 0%** — no venue name field.

**Enrichment plan:**
1. **Immediate (free, no key):** Reverse geocode GPS coordinates to get city + venue area. Use the free **OpenStreetMap Nominatim API** (`https://nominatim.openstreetmap.org/reverse?lat=X&lon=Y&format=json`) at 1 req/sec. This would give city for all 8,584 records.
2. **Secondary:** Visit each `viberate_url` page to extract the official website link and venue name from the Viberate profile. These pages are public. Would need a browser-capable fetcher since Viberate is JS-rendered.
3. **No account needed** for Nominatim. Viberate scraping is straightforward.

---

### 3. EDM Dance Directory (`apis/edm_dance_directory.json`) — 9,901 records

**What's good:** City (99%), country (98%), start date (100%), website (98%), venue name (100%).

**Gaps:**
- **GPS: 0%** — no coordinates.
- **End date: 99% missing** — nearly all records are single-day events (club nights + festivals mixed). Festivals typically span multiple days.
- **Status: 0%** — no active/inactive flag.
- **Festival filter:** The `is_festival` field exists but is `false` for most records — this source mixes club nights with festivals. Needs filtering.

**Enrichment plan:**
1. **GPS:** Forward geocode city + venue name using **Nominatim** (free) or the **Google Geocoding API** (requires key, 200/day free). Given city + venue name, Nominatim should resolve ~80%+.
2. **End date:** Visit each `website` URL and extract end date from page schema/structured data. Most RA.co links (the predominant website source) have JSON-LD event data.
3. **Festival filter:** First pass: filter `is_festival == true`. Second pass: use date span — single-day events are likely club nights, multi-day are festivals.
4. **No account needed** for Nominatim.

---

### 4. Ticketmaster (`apis/ticketmaster_festivals_full.json`) — 4,109 records ⭐ Best for GPS + Status

**What's good:** GPS (99%), city (99%), country (99%), start date (100%), status (100%), URL (100%), venue name (97%). The most complete source for current/upcoming ticketed events.

**Gaps:**
- **End date: 91% missing** — Ticketmaster often omits end dates for multi-day festivals. Only 9% have it.
- **Coverage:** Only ticketed, commercially organized festivals. Underground, free, or non-ticketed festivals are absent.

**Enrichment plan:**
1. **End date:** Visit each event's `url` (Ticketmaster event page) — end dates are usually in the page's JSON-LD `Event` schema. Can be done programmatically without an account.
2. **Keep as-is for map plotting** — this source is map-ready with no enrichment needed for location.
3. **No additional accounts needed.** The existing Ticketmaster Discovery API key can be re-used.

---

### 5. Resident Advisor (`apis/resident_advisor_festivals.json`) — 3,525 records ⭐ Best for Electronic

**What's good:** City (100%), country (100%), start date (100%), end date (100%), website (100%), venue name (100%). Excellent completeness.

**Gaps:**
- **GPS: 0%** — only city + venue name, no coordinates.
- **Status: 0%** — no active/inactive flag (RA only lists upcoming events, so all are implicitly active).

**Enrichment plan:**
1. **GPS:** Forward geocode using venue name + city + country via **Nominatim** (free). Expected hit rate: 85–90%.
2. **Status:** All records are implicitly `active` since they were scraped from upcoming event listings. Can set `status: "active"` globally.
3. **No account needed.**

---

### 6. Music Festival Wizard (`directories/musicfestivalwizard_festivals.json`) — 10,800 records ⭐ Largest Directory

**What's good:** City (99%), start date (96%), end date (96%), website (100%), venue name (98%). Rich guide-style descriptions and lineup data.

**Gaps:**
- **Country: 39% missing** — records for US festivals often have state but no country; similarly for some European festivals. Since `state_region` is present and the source is US/Canada/Europe primary, country can be inferred from state in most cases.
- **GPS: 0%** — no coordinates.
- **Status: 0%** — no active/inactive flag.

**Enrichment plan:**
1. **Country inference (immediate, free, no API):** Parse `state_region` — if it matches a US state name/abbreviation → `country = "United States"`. Run a lookup table for Canadian provinces and European regions. Should resolve ~95% of the 4,209 missing.
2. **GPS:** Forward geocode with city + venue + country via **Nominatim**.
3. **Status:** The MFW source URLs can be visited — pages for cancelled or inactive festivals often say "no longer active". Alternatively, cross-reference with Festivism's `status` field by name.
4. **No account needed.**

---

### 7. Festivism (`directories/festivism_festivals.json`) — 5,206 records

**What's good:** Status (100% — active/discontinued), country (99%), genre (82%), founded year (70%), description (100%). Excellent for historical context.

**Gaps:**
- **Dates: 99% missing** — only 26 records have a month field. No start/end dates at all.
- **City: 52% missing** — about half lack a city.
- **GPS: 0%** — no coordinates.
- **Official website: 0%** — Festivism pages link to festivals but the website URL isn't stored in our data.

**Enrichment plan:**
1. **High value target** — every record has a `url` field (the Festivism page, e.g. `https://www.festivism.com/festivals/glastonbury`). Visiting each page retrieves: dates, city, venue, official website. **5,206 pages to visit.**
2. **Method:** Fetch each `url` and parse the page's JSON-LD `Event` schema or HTML. This is the single highest-ROI enrichment task — one crawl pass fills 4 gaps simultaneously.
3. **No account needed.** Festivism is public. Recommend 1–2 req/sec to avoid rate limiting.

---

### 8. Festival Alarm (`directories/festival_alarm_festivals.json`) — 5,104 records ⭐ Only Source with Prices + Visitor Counts

**What's good:** Start date (100%), venue name (100%), visitor count (many records), ticket price (many records), genre tags, indoor/outdoor flag. Covers 2022–2026.

**Gaps:**
- **City: 84% missing** — the `country` field often stores the German federal state (e.g., "Lower Saxony") rather than a country, and city is frequently blank.
- **End date: 100% missing** — duration in days is present (e.g., "3 days") but no actual end date.
- **GPS: 0%** — no coordinates.
- **Status: 0%** — no active/inactive flag. (Year field provides implicit currency.)

**Enrichment plan:**
1. **City + GPS:** Every record has a `source_url` (the festival-alarm.com detail page) and a `website`. The source URL page has structured data with city/venue. Fetch `source_url` for the ~4,237 records missing city.
2. **End date calculation (immediate, free):** Combine `date` (e.g., "06/06") + `duration` (e.g., "3 days") + `year` to compute `end_date`. No fetching required.
3. **Country normalization:** The `country` field stores German federal states for DE festivals. Map "Bavaria", "Baden-Württemberg", etc. → "Germany" using a lookup table.
4. **No account needed.**

---

### 9. Festival Abroad (`directories/festivalabroad_festivals.json`) — 3,380 records

**What's good:** City (95%), country (97%), start date (89%), end date (64%), website (100%). Good overall completeness.

**Gaps:**
- **GPS: 0%** — no coordinates.
- **Venue/specific location: 96% missing** — city is present but venue name is almost never stored.
- **Status: 0%** — no active/inactive flag.
- **End date: 36% missing.**

**Enrichment plan:**
1. **GPS + Venue:** Each record has a `source_url` (festivalabroad.com page). These pages render JSON-LD Event schema with venue and sometimes GPS. Alternatively, forward geocode city + country via **Nominatim**.
2. **End date:** Visit source URLs for the 36% missing end dates.
3. **No account needed.**

---

### 10. That Festival Site (`directories/thatfestivalsite_festivals.json`) — 1,415 records ⭐ Best for Artist Lineups

**What's good:** City (100%), website (100%), lineup data (95% of records, averaging 10–50 artists). Best source for artist-level data.

**Gaps:**
- **Start date: 66% missing** — 921 records have `dates_text` (free text like "March" or "July 4–6 2025") but no parsed `start_date`. The text is parseable.
- **End date: 100% missing.**
- **GPS: 0%** — no coordinates.
- **Status: 0%** — but `years_active` (e.g., "2018–2023") implies inactive if end year is past.

**Enrichment plan:**
1. **Dates (immediate, free, no API):** Parse the `dates_text` field using regex/dateparser. "July 4–6 2025" → `start_date: 2025-07-04`, `end_date: 2025-07-06`. Month-only entries (e.g., "March") give at minimum a month. Should resolve 90%+ of missing dates.
2. **Status (immediate):** Parse `years_active` — if max year < 2025, set `status: inactive`. If "present" or max year ≥ 2025, set `status: active`.
3. **GPS:** Forward geocode city + country via **Nominatim**.
4. **No account needed.**

---

### 11. Festivist Atlas (`directories/festivalatlas_festivals.json`) — 1,690 records (Europe)

**What's good:** Country (100%), start date (100%), end date (100%), website (100%). Very clean. All 46 European countries.

**Gaps:**
- **City: 0%** — only country, no city.
- **GPS: 0%** — no coordinates.
- **Status: 0%** — no flag.
- **Venue: 0%** — no venue name.

**Enrichment plan:**
1. Each record has a `url` (FestivalAtlas page). Visit each to extract city, venue, description.
2. Forward geocode city + country once extracted.
3. **No account needed.**

---

### 12. FestApp (`directories/festapp_festivals.json`) — 1,796 records

**What's good:** Website (100%), genre tags.

**Gaps:**
- **City: 0%** — no city field despite having a `location` text field.
- **Country: 42% missing.**
- **Dates: 42% missing** (start and end).
- **GPS: 0%.**
- **Status: 0%.**

**Enrichment plan:**
1. Each record has a `url` (FestApp page). Visit for missing city, country, dates.
2. **No account needed.**

---

### 13. Songkick Browse (`directories/songkick_browse_festivals.json`) — 1,734 records ⭐ Has GPS

**What's good:** GPS (93%), city (100%), country (100%), start date (100%), end date (100%), venue (100%). One of the most complete sources for plotable data.

**Gaps:**
- **Website/official URL: 0%** — only the Songkick event URL is stored.
- **Status: 0%** — Songkick only lists future events, so all are implicitly active.

**Enrichment plan:**
1. **Website:** Visit each `songkick_url` page — official festival website is listed on all Songkick event pages.
2. **Status:** All records are implicitly `active` (future events only). Set globally.
3. **No account needed.**

---

### 14. Concerts Metal (`genres/concerts_metal_festivals.json`) — 590 records

**What's good:** Start date (100%).

**Gaps:**
- **City: 0%**, **Country: 0%** (country field is empty in all records), **Website: 0%**, **GPS: 0%**, **End date: 0%**, **Status: 0%.**

**Enrichment plan:**
1. Each record has a `source` URL (concerts-metal.com page). Visit for all missing fields.
2. The concerts-metal.com festival map page has a JSON data layer with coordinates — the original scraper missed it. Re-extract directly from the map endpoint.
3. **No account needed.**

---

### 15. Bluegrass (`genres/bluegrass_festivals.json`) — 374 records

**What's good:** City (99%), country (100%), `dates` text (e.g., "June 3–6"), `month` field.

**Gaps:**
- **ISO start_date: 0%** — dates exist as text only (e.g., "June 3-6").
- **End date: 0%**.
- **GPS: 0%.**
- **Website: 0%** — field is empty for all records.
- **Status: 0%.**

**Enrichment plan:**
1. **Dates (immediate, free):** Parse `dates` text field into `start_date` + `end_date` using `year` + `month` fields as context.
2. **Website + GPS:** The `source` is bluegrasscountry.org. Re-scrape the calendar page to capture website links (they exist on the original page but weren't captured in the initial scrape).
3. **No account needed.**

---

### 16. SmoothJazz (`genres/smoothjazz_festivals.json`) — 158 records

**What's good:** City (96%), country (100%), website (98%).

**Gaps:** Dates: 0%, GPS: 0%, Status: 0%, End date: 0%.

**Enrichment plan:** Visit each `website` URL — festival websites always have date information in their JSON-LD Event schema or prominently on the homepage.

---

### 17. Downbeat Jazz (`genres/downbeat_jazz_festivals.json`) — 142 records

**What's good:** City (80%), country (97%).

**Gaps:** Dates: 0%, GPS: 0%, Status: 0%, Website: 0%.

**Enrichment plan:** Visit each festival's source to extract dates and website. Cross-reference by name against MusicBrainz (which often has jazz festivals with websites and dates).

---

### 18. Metal Travels (`genres/metal_travels_festivals.json`) — 93 records

**What's good:** Country (100%).

**Gaps:** City: 0%, Dates: 0%, GPS: 0%, Website: 0%, Status: 0%.

**Enrichment plan:** Re-visit `metaltravels.com/festivals/` — the original scrape missed dates and city. Each festival has a detail page with full info.

---

### 19. Festifeed (`genres/festifeed_festivals.json`) — 254 records ✅ Nearly Complete

**What's good:** City (98%), country (98%), start date (100%), end date (100%), venue (98%), website (87%).

**Gaps:** GPS: 0%, Status: 0%, Website: 13% missing.

**Enrichment plan:** Forward geocode city + venue via Nominatim. For missing websites, visit each Festifeed event page.

---

### 20. Wikipedia Festivals (`wikipedia/wikipedia_festivals.json`) — 830 records

**What's good:** Country (100%), city (99%), status (58% — active/defunct), genre (100%), founded year (50%).

**Gaps:** Dates: 0%, GPS: 0%, Website: 0%.

**Enrichment plan:** Each record has a `wikipedia_url`. Wikipedia infoboxes contain: official website, location coordinates, annual dates (month), and status. The Wikidata API (`https://www.wikidata.org/wiki/Special:EntityData/{QID}.json`) returns structured data including coordinates, official website, and inception date for most major festivals. **No account needed.** Wikidata is fully public and has no rate limits for bulk downloads.

---

### 21. Skiddle (`directories/skiddle_festivals.json`) — 323 records

**What's good:** Website/URL (100% — skiddle.com event page).

**Gaps:** City: 0%, Country: 0%, Dates: 98% missing, GPS: 0%, Status: 0%.

**Enrichment plan:** Each record has a Skiddle `url`. Visit each page — Skiddle event pages contain full structured data (date, venue, city, postcode, GPS). Skiddle also has a public API (`skiddle.com/api/`) that returns this with an API key. **API key required** (free — register at skiddle.com/api/). Alternatively, page-scrape each URL without a key.

---

### 22. FestivalFinder EU (`directories/festivalfinder_eu.json`) — 551 records

**What's good:** City (100%), country (100%), start date (100%), end date (97%), website (100%).

**Gaps:** GPS: 0%, Status: 0%, Venue: 0%.

**Enrichment plan:** Forward geocode city + country via Nominatim. Status can be inferred from date — if end_date is in the past, consider inactive.

---

### 23. FestivalAtlas (`directories/festivalatlas_festivals.json`) — 1,690 records (Europe)

Already covered in #11 above.

---

### 24–35. Smaller Sources

| Source | Key Gaps | Enrichment |
|--------|----------|-----------|
| `efestivals_uk` (342) | GPS, end date 28% | Forward geocode; visit source_url for missing dates |
| `festivals_directory` (85) | Dates, GPS | Visit each source_url (festival detail pages) |
| `festivalando` (1,800) | City, country, end date | Visit each `url` (Festivalando detail pages) |
| `world_music_central` (78) | Dates, GPS, Website | Visit source URLs |
| `bandwagon_asia` (41) | GPS, end date | Forward geocode; visit source_url |
| `getfestiwise` (103) | City, country, dates, GPS | Visit getfestiwise.com each entry |
| `world_festival_dir` (103) | Dates, GPS | Visit each source_url |
| `bandsintown` (29) | City, dates, GPS | Visit each bandsintown.com page |
| `setlistfm` (26) | City, country, dates, GPS | Visit each setlist.fm festival page |
| `jambase` (24) | Everything | Sign up for free 14-day trial at data.jambase.com |
| `songkick` (75) | City, dates | Visit each Songkick URL |
| `world_music_central` (78) | Dates, GPS | Visit source URLs |

---

## Summary: What We Need to Build a Map

For map-plotting, the minimum per record is: **GPS (or city + country for geocoding) + at least a month + active/inactive status.**

### Sources already map-ready (no enrichment needed):
| Source | Records | Notes |
|--------|--------:|-------|
| **Ticketmaster** | 4,109 | 99% GPS, 100% dates, 100% status |
| **Viberate** | 8,584 | 100% GPS, 100% dates, 100% status — only needs city names via reverse geocode |
| **Songkick Browse** | 1,734 | 93% GPS, 100% dates |
| **Resident Advisor** | 3,525 | 100% city + country (geocodable), 100% dates |

**Immediately plottable: ~17,952 records (19% of total)**

### Sources that become map-ready with a single free enrichment pass:

| Source | Records | What's Needed | Method | Effort |
|--------|--------:|---------------|--------|--------|
| MusicBrainz | 30,276 | Flatten nested place.coordinates | Script (no API) | 1 hour |
| MFW | 10,800 | Fill country from state lookup | Script (no API) | 30 min |
| ThatFestivalSite | 1,415 | Parse dates_text field | Script (no API) | 1 hour |
| Festival Alarm | 5,104 | Compute end_date from date+duration; scrape city | Script + crawl | 2 hours |
| Festivism | 5,206 | Visit each `/festivals/*` page | Crawl 5,206 URLs | 4–6 hours |
| EDM Dance Dir | 9,901 | Forward geocode | Nominatim (free) | 2 hours |
| Wikipedia | 830 | Wikidata API fetch | Free API, no key | 1 hour |

**After these passes: ~80,000+ records become map-plottable.**

---

## Do You Need to Create Any Accounts?

| Service | Need? | Purpose | Cost |
|---------|-------|---------|------|
| **Nominatim (OpenStreetMap)** | ❌ No account | Forward + reverse geocoding for all sources lacking GPS | Free, 1 req/sec |
| **Wikidata API** | ❌ No account | Extract GPS + website + dates from Wikipedia festival articles | Free, unlimited |
| **MusicBrainz API** | ❌ No account | Fetch missing place/URL relations for the ~31% without them | Free, 1 req/sec |
| **Google Geocoding API** | ⚠️ Optional | Faster/more accurate than Nominatim; 200 free/day, then paid | Free tier available |
| **Skiddle API** | ⚠️ Optional | 1,000+ UK festivals with dates + GPS; free to register | Free |
| **Songkick API** | ⚠️ Optional | 6M+ events with `type=Festival`; richest concert DB | Requires application |
| **JamBase API** | ⚠️ Optional | 14-day free trial; Google's festival data provider | Trial free, then paid |
| **Ticketmaster API** | ✅ Already have | Re-use for end_date enrichment | Existing key |

---

## Recommended Next Steps (Priority Order)

### Step 1 — Free, no-fetch enrichment (run immediately)
Scripts only, no crawling:
1. **Flatten MusicBrainz** nested place data → add `lat`, `lng`, `city`, `country`, `website`, `status` fields
2. **Infer MFW country** from state/region lookup table
3. **Parse ThatFestivalSite dates_text** with dateparser
4. **Compute Festival Alarm end_date** from date + duration + year
5. **Set implicit status** on Songkick Browse, RA (all active), ThatFestivalSite (from years_active)

### Step 2 — Geocoding pass (Nominatim, free, ~4 hours)
Forward geocode all sources that have city + country but no GPS:
- Resident Advisor, FestivalFinder EU, Festival Abroad, Festifeed, Wikipedia, efestivals, MFW, Festival Alarm (after Step 1 fills city)

### Step 3 — Crawl enrichment (highest ROI)
Visit source URLs to fill gaps:
1. **Festivism (5,206 URLs)** — fills dates, city, venue, official website simultaneously
2. **Ticketmaster events (4,109 URLs)** — fills end dates
3. **Festival Alarm detail pages (~4,237)** — fills city + venue
4. **FestivalAtlas (1,690 URLs)** — fills city + venue + status
5. **Concerts-Metal map JSON** — re-extract with coordinates

### Step 4 — Optional API signups
- **Skiddle free API** → 1,000+ UK festivals fully structured
- **Wikidata API** → run against all 830 Wikipedia festival titles → GPS + official websites
- **JamBase 14-day trial** → normalized IDs cross-referencing Spotify/Ticketmaster

### Step 5 — Deduplication
Once all sources are enriched, merge using:
- Primary key: MusicBrainz MBID (where available)
- Fallback: fuzzy name match + country + approximate date window (±7 days)
- Secondary: Viberate UUID or Ticketmaster ID

---

## Tools Available to Do This

I can execute all of the above Steps 1–4 directly:
- **Scripts (Step 1):** Python in the sandbox — no external services needed
- **Nominatim geocoding (Step 2):** Direct HTTP calls, no account needed
- **Web crawling (Step 3):** `fetch_url` tool for JS-rendered pages, Python `requests` for static pages
- **Wikidata API (Step 4):** Direct HTTP, no account needed
- **GitHub:** Commit each enriched file as it's completed, keeping the repo up to date

The one thing that would meaningfully accelerate this: a **Google Maps Geocoding API key** (for Step 2) would improve geocoding accuracy for ambiguous venue names and non-English city names compared to Nominatim alone. But Nominatim is entirely sufficient to proceed.
