# Music Festival Data — Gap Analysis & Enrichment Plan

_Updated June 20, 2026. Revised to reflect:_
- _JamBase API key now available (trial key in use)_
- _Geocoding (GPS lat/lng) deferred — will be done at app ingestion time via Google Maps API_
- _Focus: ensuring each record has good **text location** (city + country + venue name/address) and **dates**_
- _Skiddle API key pending — skipped for now_

---

## Revised Priority: What We Need Per Record

For map plotting at ingestion time, each festival needs:
1. **Location text** — city + country minimum; venue name or street address preferred (Google Maps Geocoding API will convert to GPS later)
2. **Start date** — ISO date (YYYY-MM-DD) preferred; month + year acceptable as fallback
3. **End date** — nice to have; duration in days also acceptable
4. **Status** — `active` / `inactive` boolean or string (is the festival still running?)
5. **Official website** — for further enrichment and user linking

GPS coordinates are NOT needed now — skip all geocoding passes.

---

## Field Coverage Matrix (Pre-Enrichment)

| Source | Records | City+Country | Venue Name | Start Date | End Date | Status | Website |
|--------|--------:|:------------:|:----------:|:----------:|:--------:|:------:|:-------:|
| **APIs** | | | | | | | |
| musicbrainz (×16) | 30,276 | ❌ 0%* | ❌ 0%* | ✅ 99% | ✅ 99% | ❌ 0%* | ❌ 8%* |
| viberate | 8,584 | ⚠️ country only | ❌ 0% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0%† |
| edm_dance_directory | 9,901 | ✅ 99% | ✅ 100% | ✅ 100% | ❌ 1% | ❌ 0% | ✅ 98% |
| ticketmaster | 4,109 | ✅ 99% | ✅ 97% | ✅ 100% | ❌ 9% | ✅ 100% | ✅ 100% |
| resident_advisor | 3,525 | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0%‡ | ✅ 100% |
| jambase | 24→TBD | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | 
| songkick | 75 | ✅ country | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% |
| **Directories** | | | | | | | |
| musicfestivalwizard | 10,800 | ✅ city / ⚠️ 61% country | ✅ 98% | ✅ 96% | ✅ 96% | ❌ 0% | ✅ 100% |
| festivism | 5,206 | ⚠️ 48% city / 99% country | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% |
| festival_alarm | 5,104 | ⚠️ 16% city / ⚠️ 83%§ country | ✅ 100% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% |
| festivalabroad | 3,380 | ✅ 95% city / 97% country | ❌ 4% | ✅ 89% | ✅ 64% | ❌ 0% | ✅ 100% |
| festivalando | 1,800 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% |
| festapp | 1,796 | ❌ city / ⚠️ 58% country | ❌ 0% | ⚠️ 58% | ⚠️ 58% | ❌ 0% | ✅ 100% |
| songkick_browse | 1,734 | ✅ 100% | ✅ 100% | ✅ 100% | ✅ 100% | ❌ 0%‡ | ❌ 0% |
| festivalatlas | 1,690 | ❌ 0% city / ✅ 100% country | ❌ 0% | ✅ 100% | ✅ 100% | ❌ 0% | ✅ 100% |
| thatfestivalsite | 1,415 | ✅ 100% city / ⚠️ 91% country | ❌ 0% | ⚠️ 34% | ❌ 0% | ❌ 0% | ✅ 100% |
| festivalfinder_eu | 551 | ✅ 100% | ❌ 0% | ✅ 100% | ✅ 97% | ❌ 0% | ✅ 100% |
| efestivals_uk | 342 | ✅ 97% | ❌ 0% | ✅ 97% | ✅ 72% | ❌ 0% | ✅ 100% |
| skiddle | 323 | ❌ 0% | ❌ 0% | ❌ 2% | ❌ 0% | ❌ 0% | ✅ 100% |
| festivals_directory | 85 | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% |
| **Genres** | | | | | | | |
| concerts_metal | 590 | ❌ 0% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% |
| bluegrass | 374 | ✅ 99% | ❌ 0% | ⚠️ text only | ❌ 0% | ❌ 0% | ❌ 0% |
| festifeed | 254 | ✅ 98% | ✅ 98% | ✅ 100% | ✅ 100% | ❌ 0% | ✅ 87% |
| downbeat_jazz | 142 | ✅ 80% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| metal_travels | 93 | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| smoothjazz | 158 | ✅ 96% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 98% |
| world_music_central | 78 | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% |
| **Wikipedia** | | | | | | | |
| wikipedia_festivals | 830 | ✅ 99% city / 100% country | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 58% | ❌ 0% |
| wikipedia_names | 830 | ✅ country | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ wiki |
| **Regional** | | | | | | | |
| bandwagon_asia | 41 | ✅ 100% | ❌ 0% | ✅ 100% | ❌ 0% | ❌ 0% | ✅ 100% |
| getfestiwise | 103 | ❌ 0% | ❌ 0% | ⚠️ month | ❌ 0% | ❌ 0% | ❌ 0% |
| world_festival_dir | 103 | ✅ 100% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% |
| **Other** | | | | | | | |
| bandsintown | 29 | ✅ country | ✅ 79% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% |
| setlistfm | 26 | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ❌ 0% | ✅ 100% |

_* MusicBrainz location/website IS in the data but nested inside `relations[]` — needs script to flatten._
_† Viberate URL is their own profile page, not the official festival website._
_‡ These sources only list future events — all records are implicitly active._
_§ Festival Alarm `country` field often stores German federal states (Bavaria, etc.) instead of "Germany"._

---

## Per-Source Enrichment Plan

### Priority A — Script only (no crawling, immediate, free)

#### 1. MusicBrainz — Flatten nested relations
**Gap:** Location (city, country) and website are deeply nested in `relations[]`, not top-level.
**Fix:** One-time Python script across all 16 files:
- Extract `relations[].place.coordinates` → `lat`, `lng`
- Walk `relations[].place.area` chain → `city`, `country`  
- Extract `relations[].url.resource` where `type == "official homepage"` → `website`
- Map `life_span.ended: true` → `status: "inactive"`, else `"active"`
- **Estimated gain:** city/country for ~69% of 30,276 records (~20,900); website for ~8% (~2,400); status for 100%
- **Effort:** 1 script, 30 min runtime across 16 files

#### 2. Music Festival Wizard — Infer missing country
**Gap:** 4,209 of 10,800 records have state/region but no country.
**Fix:** Lookup table: US state names/abbreviations → "United States", Canadian provinces → "Canada", etc. Also check `festival_guide_region` field and `location` field suffix.
- **Estimated gain:** country for ~4,000 records
- **Effort:** 30 min script

#### 3. ThatFestivalSite — Parse dates_text
**Gap:** 921 records have `dates_text` (e.g., "July 4-6 2026") but no ISO `start_date`.
**Fix:** dateparser + regex to convert text → `start_date`, `end_date`. Parse `years_active` → `status`.
- **Estimated gain:** start_date for ~800 records; status for all 1,415
- **Effort:** 30 min script

#### 4. Festival Alarm — Compute end_date + normalize country
**Gap:** end_date missing for all 5,104 records; `duration` field (e.g., "3 days") is present. Country field stores German states.
**Fix:** `date` + `year` + `duration` → compute `end_date`. Lookup table to normalize German states → "Germany", French regions → "France", etc.
- **Estimated gain:** end_date for all 5,104; corrected country for ~2,000
- **Effort:** 30 min script

#### 5. Bluegrass — Parse date text
**Gap:** `dates` field has text like "June 3-6"; `year` is "2026". No ISO dates.
**Fix:** Parse text → `start_date`, `end_date`. Set `status: "active"` for all (current year).
- **Estimated gain:** start/end dates for all 374
- **Effort:** 20 min script

#### 6. Resident Advisor — Set implicit status
All records are upcoming events → set `status: "active"` globally. Already has city/country/dates/venue.
- **Effort:** 5 min script

#### 7. Songkick Browse — Set implicit status
All records are upcoming events → set `status: "active"` globally.
- **Effort:** 5 min script

---

### Priority B — Crawl existing source URLs (medium effort, no new API keys)

#### 8. Festivism — Fetch 5,206 individual pages ⭐ Highest ROI
**Gap:** Dates (99% missing), city (52% missing), official website (100% missing), venue (100% missing)
**Method:** Each record has `url` (festivism.com page). Visit each for JSON-LD `Event` schema or HTML parsing.
- Fields gained per page: `start_date`, `end_date` or `month`, `city`, `venue`, `website`
- Rate: 1-2 req/sec, 4 workers → ~45 min for all 5,206 pages
- **Expected gain:** dates for ~60%, city for ~40%, website for ~70%

#### 9. Festival Alarm — Fetch detail pages for missing city ⭐
**Gap:** City missing for 4,237 records. Every record has `source_url`.
**Method:** Fetch source_url, extract city from the detail page info table.
- Rate: 1 req/sec → ~70 min for 4,237 pages
- **Expected gain:** city for ~90% of missing records

#### 10. FestivalAtlas — Fetch 1,690 pages for city + venue
**Gap:** City 0%, venue 0%. Every record has `url`.
**Method:** Fetch each festivalatlas.io page, extract city and venue name.
- Rate: 1 req/sec → ~28 min
- **Expected gain:** city + venue for ~95%

#### 11. ThatFestivalSite — Fetch pages for venue + official website
**Gap:** Venue 0%, official website not stored (only thatfestivalsite.com URL), country 9% missing.
**Method:** Fetch each thatfestivalsite.com page, extract venue and external website link.
- **Expected gain:** venue + official website for majority

#### 12. Songkick Browse — Fetch Songkick pages for official website
**Gap:** Official website 0%. Every record has `songkick_url`.
**Method:** Fetch each Songkick page, extract "Official Website" link.
- **Expected gain:** official website for ~80%

#### 13. Concerts-Metal — Re-extract with location from map JSON
**Gap:** City 0%, country 0%, website 0%. Source page has an interactive map.
**Method:** Fetch `https://en.concerts-metal.com/festivals.html` and look for embedded JSON data layer used by the map.
- **Expected gain:** country + possibly city for all 590

#### 14. Wikipedia — Wikidata API for website + location
**Gap:** Official website 0%, GPS (deferred). 
**Method:** For each `wikipedia_url`, look up QID via Wikipedia API → fetch Wikidata entity → extract P856 (website), P276 (venue), P571 (inception).
- **Expected gain:** official website for ~70% of 830; venue for ~50%

#### 15. Metal Travels — Fetch detail pages
**Gap:** City 0%, dates 0%, website 0%.
**Method:** Each record's `source` field links to a metaltravels.com page. Fetch it.
- **Expected gain:** city + dates + website for ~90% of 93

#### 16. SmoothJazz — Fetch festival websites for dates
**Gap:** Dates 0%. Has `website` field (98%).
**Method:** Fetch each festival's homepage, look for JSON-LD Event schema with `startDate`.
- **Expected gain:** dates for ~60%

#### 17. World Music Central — Fetch for city + dates + website
**Gap:** City 0%, dates 0%, website 0%. Source URLs available.
**Method:** Fetch each worldmusiccentral.org page.
- **Expected gain:** city + dates + website for ~70% of 78

#### 18. Festivalando — Fetch pages for city + country
**Gap:** City 0%, country 0%. Has post URL (1,800 records).
**Method:** Fetch each post page — Latin American festival articles include location in text/schema.
- **Expected gain:** city + country for ~70% of 1,800

---

### Priority C — API-based enrichment (requires keys)

#### 19. JamBase API ⭐ NEW — Full festival dataset
**Key:** `jbd_trial_ChVhVJ32yC7U_2rPApgkwqWMDMxoCsR8dCB27DKOnr1Mh`
**Auth:** `Authorization: Bearer <key>`
**Endpoints to hit:**
- `GET /events?eventType=festival` — all festival events (paginated)
- `GET /genres` — genre taxonomy
- `GET /geographies/countries` — country list
- `GET /artists` — artist catalog (useful for lineup enrichment)
**Data quality:** JamBase is Google's music data provider. Expect: venue name, address, city, state, country, lat/lng, start/end date, ticket URL, artist lineup.
**Note:** `api.jambase.com` is blocked from the sandbox (connection reset at network level). Workaround: use browser_task or fetch_url with proper headers to reach the API. **This is the highest-value single source to unlock.**

#### 20. Skiddle API — PENDING
API key application submitted. Will unlock 1,000+ UK/European festivals with full structured data (venue, address, postcode, dates, GPS). Revisit when key arrives.

---

### Priority D — Cross-reference enrichment (name-matching across sources)

Once all crawling is done, cross-reference by festival name to fill remaining gaps:

1. Match Downbeat Jazz / SmoothJazz records against MusicBrainz by name → get dates, website
2. Match Concerts-Metal records against Wikipedia festivals by name → get country/city
3. Match Metal Travels against MusicBrainz by name → get location, dates
4. Match Festivism records (still missing dates after crawl) against Festival Abroad / FestApp by name → get dates

This is a pure data joining task — no fetching needed.

---

## Current Enrichment Progress

| Task | Status | Method |
|------|--------|--------|
| MusicBrainz flatten | 🔄 Running | Script |
| MFW country inference | 🔄 Running | Script |
| ThatFestivalSite date parse | 🔄 Running | Script |
| Festival Alarm end_date compute | 🔄 Running | Script |
| Bluegrass date parse | 🔄 Running | Script |
| Festivism crawl (5,206 pages) | 🔄 Running | Crawl |
| Festival Alarm city crawl | 🔄 Running | Crawl |
| FestivalAtlas city/venue crawl | 🔄 Running | Crawl |
| Concerts-Metal location | 🔄 Running | Crawl |
| ThatFestivalSite venue/website | 🔄 Running | Crawl |
| Songkick official website | 🔄 Running | Crawl |
| Wikipedia → Wikidata | 🔄 Running | API |
| JamBase API full extract | 🔄 Running | API |
| Metal Travels crawl | 🔄 Running | Crawl |
| SmoothJazz dates | 🔄 Running | Crawl |
| World Music Central | 🔄 Running | Crawl |
| FestApp city/country | ⏳ Pending | Crawl |
| Festivalando city/country | ⏳ Pending | Crawl |
| Downbeat Jazz cross-ref | ⏳ Pending | Join |
| Skiddle | ⏳ Waiting for API key | API |

---

## Accounts & API Keys Summary

| Service | Status | Purpose | How to Get |
|---------|--------|---------|------------|
| **JamBase** | ✅ Trial key active | Full festival dataset, artist/venue data | Already have key |
| **Skiddle** | ⏳ Pending | 1,000+ UK/EU festivals | Applied, waiting |
| **Wikidata API** | ✅ No key needed | Website + venue from Wikipedia festival articles | Free, open |
| **MusicBrainz API** | ✅ No key needed | Supplement missing relations | Free, open |
| **Google Maps Geocoding** | 🔜 Use at ingestion | Convert city+venue → GPS coordinates | Get key when ingesting |
| **Songkick API** | ⚠️ Requires application | 6M+ events | Apply at songkick.com/developer |
| **Ticketmaster API** | ✅ Key from existing scrape | Re-use for end_date enrichment | Already have key |
| **Nominatim / OSM** | Not needed | Geocoding deferred to ingestion | N/A |

---

## After All Enrichment: Expected Coverage

| Field | Before | After All Steps |
|-------|--------|----------------|
| City + Country (any) | ~65% | ~92% |
| Venue name | ~30% | ~65% |
| Start date | ~72% | ~90% |
| End date | ~35% | ~65% |
| Status active/inactive | ~15% | ~85% |
| Official website | ~55% | ~78% |

_Remaining gaps (~8-10%) will be festivals with no digital footprint — typically small local or historical events._
