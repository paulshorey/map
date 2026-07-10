# Art Festival Directories & Databases: Global Mining Reference

## Overview

This document catalogs every known website, database, API, and structured data source that indexes art festivals and related events globally â€" covering commercial art fairs, craft shows, biennials, carnivals, public art installations, street festivals, performance events, Renaissance faires, puppet parades, maker festivals, and community art events. Each entry includes the URL, a characterization of its data model, and notes on scraping/API access feasibility.

***

## 1. Major Commercial Art Fair Calendars

These are the highest-signal directories for gallery-tier and institutional art fairs. Data tends to be structured, manually curated, and well-maintained.

### 1.1 General Art Fair Aggregators

| Site | URL | Coverage | Data Format / Scrape Notes |
|------|-----|----------|---------------------------|
| **ArtFairMag** | [artfairmag.com/art-fair-database](https://www.artfairmag.com/art-fair-database/) | 50+ countries | HTML tables, searchable; no API[^1] |
| **ArtFairsList.eu** | [artfairslist.eu](https://artfairslist.eu) | Global, map-based | Searchable map with date/city filters; HTML scrape[^2] |
| **ArtFairDates** | [artfairdates.com](https://artfairdates.com) | Global calendar | Minimal HTML, information-only; easy to parse[^3] |
| **Art-Fix 2026 Calendar** | [art-fix.com/city-guide/art-fairs-2026](https://art-fix.com/city-guide/art-fairs-2026/) | Global, 2026 | Structured HTML by month/region; good for seed list[^4] |
| **The Fair Guide** | [thefairguide.com](https://www.thefairguide.com) | Global calendar | Table-based HTML calendar with venue/date data[^5] |
| **ArtFairSourceBook** | [artfairsourcebook.com/directory](https://artfairsourcebook.com/directory) | USA-heavy, some global | Searchable directory with deadlines and locations[^6] |
| **ArtFairCalendar** | [artfaircalendar.com](https://artfaircalendar.com) | USA metro areas | City-based listings, HTML scrape[^7] |
| **ArtFestival.com** | [artfestival.com](https://www.artfestival.com) | USA | Calendar with art/craft festival split; download link present[^8][^9] |
| **ArtNews Art Fair Calendar** | [artnews.com â€“ 2026 Calendar](https://www.artnews.com/list/art-news/market/art-fair-calendar-1234654135/) | Global major fairs | Editorial list for 2026, good for tier-1 fairs[^10] |
| **Artsy Events** | [artsy.net/events](https://www.artsy.net/events) | Global galleries/fairs | REST + GraphQL API; **artsy.net/api** has a documented `/fairs` endpoint returning paginated JSON[^11][^12] |
| **Artnet Events** | [artnet.com/events](https://www.artnet.com/events/) | Global, curated | HTML event calendar; scrape-able[^13] |

### 1.2 Artsy Fairs API (Direct)

Artsy exposes a documented public API endpoint for art fairs[^11]:

```
GET https://api.artsy.net/api/fairs
Headers: X-XAPP-Token: <token>
Params: status=running|closed|upcoming|current
```

Pagination is standard. Requires a free XAPP token (OAuth client credentials). An Apify actor also wraps this if you prefer managed scraping[^14].

***

## 2. North American Craft Show & Art Fair Databases

The highest-density data sources for vendor-facing art/craft shows in the US and Canada. These hold 10,000â€“26,000+ events each.

| Site | URL | Events | Notes |
|------|-----|--------|-------|
| **FestivalNet** | [festivalnet.com](https://festivalnet.com) | 26,000+ NA events | Largest NA database; subscription required for full detail; no public API â€" scrape login-required pages[^15][^16] |
| **CraftersMap** | [craftersmap.com](https://craftersmap.com) | Large, map-based | Map-centric interface; JSON data likely in XHR requests[^17] |
| **TheCraftMap** | [thecraftmap.com](https://www.thecraftmap.com) | All 50 US states | Booth fees, deadlines, reviews; structured HTML[^18][^19] |
| **CraftShowConnect** | [craftshowconnect.com](https://www.craftshowconnect.com) | US/Canada | Vendor-focused; free search[^20] |
| **ArtsCraftsShowBusiness** | [artscraftsshowbusiness.com](https://www.artscraftsshowbusiness.com) | Eastern US, 26+ years | East Coast leader; subscription-gated data[^21][^22] |
| **CraftShowYellowPages** | [craftshowyellowpages.com](http://www.craftshowyellowpages.com) | Western US, 20,000+ | Sister pub to artscraftsshowbusiness.com for Western US[^23] |
| **ArtAndCrafts.com (WhereTheShowsAre)** | [artandcrafts.com](https://www.artandcrafts.com) | ~11,000 events, FL/GA/SE | Regional depth in Southeast US[^24] |
| **ArtsAndCraftsNetwork** | [artsandcraftsnetwork.com/shows](http://www.artsandcraftsnetwork.com/shows/) | US, by state | Free to list and search; simple HTML by state[^25] |
| **NationalCraftShowDirectory** | [nationalcraftshowdirectory.com/events](https://nationalcraftshowdirectory.com/events) | US | Free listing/search; zip-code search[^26] |
| **ShowLister** | [showlister.com](http://www.showlister.com) | US, street fairs | Art/craft shows + street fairs + trade shows; subscription[^27] |
| **FairsAndFestivals.net** | [fairsandfestivals.net](https://www.fairsandfestivals.net) | US/Canada | Craft show portal; regional dev ongoing[^28][^29] |

***

## 3. Biennial, Triennial & Large-Scale Public Art Exhibitions

Recurring multi-week/multi-month public art events â€" includes Venice Biennale-type formats as well as sculptural and installation-heavy temporary exhibitions.

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **Biennial Foundation â€" Map & Directory** | [biennialfoundation.org/network/biennial-map](https://biennialfoundation.org/network/biennial-map/) | Global, 100s of biennials | Best single-source map; entries linkable by name[^30] |
| **Biennale.com Overview** | [biennale.com/overview.html](https://biennale.com/overview.html) | 86 curated global events | Structured editorial; tabular HTML[^31] |
| **Biennale.com Directory** | [biennale.com/directory.html](https://biennale.com/directory.html) | 100+ editorial pages | Filterable by region/type; HTML[^32] |
| **International Biennial Association** | [biennialassociation.org/network-with-map](https://www.biennialassociation.org/network-with-map/) | Global network map | Member-submitted data; HTML map[^33] |
| **Wikipedia: List of Biennales** | [en.wikipedia.org/wiki/Biennale](https://en.wikipedia.org/wiki/Biennale) | 100+ global entries | Wikitext/API accessible; cross-links to event articles[^34] |
| **ArtFairDates.com (Biennials subset)** | [artfairdates.com](https://artfairdates.com) | Includes biennial-scale events | Calendar view overlaps biennials[^3] |
| **Mid Atlantic Arts â€" International Festival DB** | [midatlanticarts.org/resources/international-festivals](https://www.midatlanticarts.org/resources/international-festivals/) | 1,906 international festivals | Focused on performing arts context; searchable; 2000+ records[^35][^36] |

### Notable Biennials for Seed Crawling
The Wikipedia article alone lists 100+ biennials across Africa, Asia, Americas, Europe, and Oceania â€" including Venice, SÃ£o Paulo, Gwangju, Whitney, Istanbul, Sharjah, Sydney, Havana, Dakar (Dak'Art), Kochi-Muziris, Lagos, and 80+ more[^34][^37]. The Biennial Foundation map is filterable and linkable.

***

## 4. New Media, Digital & Technology Art Festivals

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **Wikipedia: List of New Media Art Festivals** | [en.wikipedia.org/wiki/List_of_new_media_art_festivals](https://en.wikipedia.org/wiki/List_of_new_media_art_festivals) | Global, ~100 events | Organized by continent; includes Ars Electronica, Transmediale, MUTEK, FILE, ISEA, etc.[^38] |
| **Whitney ArtPort Resources** | [artport.whitney.org/v2/resources/festivals.shtml](https://artport.whitney.org/v2/resources/festivals.shtml) | Digital/media art festivals | Legacy but comprehensive list of media art events worldwide[^39] |

***

## 5. Light Festivals

Light festivals are a distinct and growing category â€" large-scale temporary public light-art installations and projections.

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **ILO â€" International Light Festivals Organisation** | [internationallightfestivals.org](https://www.internationallightfestivals.org) | Global network | Worldwide network of public light festivals; member directories[^40] |
| **LUCI Association Light Festival Calendar** | [luciassociation.org/light-festival-calendar](https://www.luciassociation.org/light-festival-calendar/) | Global | Detailed calendar with descriptions; HTML scrape[^41] |

***

## 6. Theatre, Dance & Performing Arts Festivals

### 6.1 Directories

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **Wikipedia: List of Theatre Festivals** | [en.wikipedia.org/wiki/List_of_theatre_festivals](https://en.wikipedia.org/wiki/List_of_theatre_festivals) | Global, tabular | 50+ international theatre festivals in sortable table[^42] |
| **Wikipedia: Lists of Festivals (parent)** | [en.wikipedia.org/wiki/Lists_of_festivals](https://en.wikipedia.org/wiki/Lists_of_festivals) | All categories | Links to sub-lists: opera, theatre, improv, dance, folk, music, etc.[^43] |
| **Wikipedia: List of Folk Festivals** | [en.wikipedia.org/wiki/List_of_folk_festivals](https://en.wikipedia.org/wiki/List_of_folk_festivals) | Global | Includes traditional folk festivals with dance and music[^44] |
| **Wikipedia: List of Festivals in Europe** | [en.wikipedia.org/wiki/List_of_festivals_in_Europe](https://en.wikipedia.org/wiki/List_of_festivals_in_Europe) | Europe-wide | Broken down by country; arts, theater, carnival, film[^45] |
| **ITI/UNESCO Performing Arts Network** | [iti-worldwide.org](https://www.iti-worldwide.org) | International | World's largest performing arts org; World Theatre Day & International Dance Day[^46] |
| **Americans for the Arts â€" ITI Directory** | [americansforthearts.org â€“ ITI Directory](https://www.americansforthearts.org/by-program/reports-and-data/legislation-policy/naappd/international-directory-of-theatre-dance-and-folklore-festivals) | 850 festivals in 56 countries | Theatre, dance, and folklore; ITI-curated reference[^47] |
| **LARP Portal â€“ Faires & Festivals** | [larportal.com/faires-and-festivals.php](https://larportal.com/faires-and-festivals.php) | USA primarily | Renaissance/medieval/LARP events; tabular data with attendance[^48] |

### 6.2 Edinburgh Fringe â€" World's Largest Arts Festival
The Edinburgh Festival Fringe is the world's largest arts festival, held annually in August â€" includes dance, theatre, street performance, and visual arts[^49]. The Fringe has a public API: `https://api.edfringe.com` (requires registration) with JSON event data.

***

## 7. Renaissance & Medieval Faires

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **RenFaireGuide.com** | [renfaireguide.com](https://www.renfaireguide.com/) | 700+ US events | Most comprehensive US ren faire database; location search, dates, hotels[^50][^51] |
| **RenFaire.com Directory** | [renfaire.com/Sites](https://www.renfaire.com/Sites/) | US by state | Classic directory, state-by-state, with direct links[^52] |
| **TheRenList** | [therenlist.com](http://www.therenlist.com) | US map-based | Map of US ren fests; community-maintained[^53] |
| **LARP Portal** | [larportal.com/faires-and-festivals.php](https://larportal.com/faires-and-festivals.php) | US + Canada | Includes year founded, attendance, stage count[^48] |

***

## 8. Carnivals, Parades & Street Festivals

### 8.1 Carnival Directories

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **CarniFest Online** | [carnifest.com](https://www.carnifest.com) | Global | Carnivals, festivals, street parades worldwide; travel-integrated search[^54][^55] |
| **Wikipedia: List of Caribbean Carnivals** | [en.wikipedia.org/wiki/List_of_Caribbean_carnivals_around_the_world](https://en.wikipedia.org/wiki/List_of_Caribbean_carnivals_around_the_world) | Caribbean + diaspora | Global spread of Caribbean carnival format[^56] |
| **Wikipedia: Mardi Gras** | [en.wikipedia.org/wiki/Mardi_Gras](https://en.wikipedia.org/wiki/Mardi_Gras) | Global | Dates and city-by-city coverage[^57] |

### 8.2 Puppet, Giant & Art Car Parades
These are niche event types with no single dedicated global directory. Best approached via:
- **Houston Art Car Parade** ([thehoustonartcarparade.com](https://www.thehoustonartcarparade.com)) â€" anchor event; world's largest art car gathering since 1987[^58][^59]
- **New Orleans Giant Puppet Festival** ([neworleansgiantpuppetfest.com](https://www.neworleansgiantpuppetfest.com)) â€" flagship North American puppet parade event[^60]
- **FIGMENT Project** ([figmentproject.org](https://www.figmentproject.org)) â€" participatory art festival network; runs in multiple US cities[^61]
- For global coverage, use `PredictHQ` and `AllEvents.in` with keyword filters (see Section 12)

***

## 9. Busking & Street Performance Festivals

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **Busker Central** | [buskercentral.com](https://www.buskercentral.com) | Global | Non-profit; first busker calendar of worldwide festivals; busker news[^62][^63] |
| **StreetMusicMap** | [streetmusicmap.com](https://streetmusicmap.com) | Global, 178+ events mapped | Collaborative listing of street music performers; data from 2014+[^64] |
| **Wikipedia: Buskers Festival** | [en.wikipedia.org/wiki/Buskers_festival](https://en.wikipedia.org/wiki/Buskers_festival) | Links to major events | Cross-links to Busker Central and open-call festival lists[^65] |
| **Busk.co Blog Resources** | [blog.busk.co](https://blog.busk.co/busking-tips-tricks/buskers-organisations-advocates/) | Org list, not calendar | List of global busking organizations, associations, and festival networks[^66] |
| **The Street Art List** | [thestreetartlist.com](https://thestreetartlist.com) | Global | Mural/street art open calls + event calendar + global map; organizer dashboards; grown from spreadsheet since 2019[^67] |

***

## 10. Maker Faires & Community Participatory Events

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **Maker Faire** | [makerfaire.com](https://makerfaire.com) | Global | Bay Area origin (2006); global cultural movement; includes Makerspace directory and event calendar[^68] |
| **FIGMENT Project** | [figmentproject.org](https://www.figmentproject.org) | US cities | Free participatory arts festivals; blurs artist/audience line[^61] |
| **Festival of Making (UK)** | [festivalofmaking.co.uk](https://festivalofmaking.co.uk) | UK (Blackburn) | Art + manufacturing + community participation; annual[^69] |

***

## 11. Calls for Entry â€" Public Art & Festival Open Calls

These platforms are used by artists to find and apply for public art commissions and festival participation. Scraping them gives a different angle: the open call data is attached to specific events/festivals.

| Site | URL | Coverage | Notes |
|------|-----|----------|-------|
| **CaFÃ‰ â€" CallForEntry.org** | [callforentry.org](https://www.callforentry.org) | US-heavy, some global | 160,000+ artists; public art RFQs, festival calls; filterable by type, budget, location[^70][^71] |
| **Public Art Archive (PAA)** | [westaf.org â€“ PAA](https://artist.callforentry.org/festivals_unique_info.php?ID=13531) | US + abroad | ~30,000 completed public artworks; largest public art documentation database worldwide[^72][^73] |

***

## 12. Broad Event Aggregator APIs (Programmable)

These are the highest-leverage targets for programmatic data mining â€" they aggregate across all categories and expose REST APIs or structured crawl surfaces.

### 12.1 APIs with Native Festival/Art Categories

| Platform | API Endpoint / Docs | Festival Support | Auth |
|----------|--------------------|-----------------:|------|
| **Ticketmaster Discovery API** | [developer.ticketmaster.com](https://developer.ticketmaster.com) | Yes â€" `classificationName=Arts` filter; global coverage; JSON[^74][^75] | Free API key |
| **PredictHQ Events API** | [predicthq.com/events/festivals](https://www.predicthq.com/events/festivals) | Yes â€" dedicated festivals + performing arts categories; 18+ event categories; global[^76][^77] | Subscription |
| **SeatGeek API** | [platform.seatgeek.com](https://platform.seatgeek.com) | Yes â€" `eventType=festival`; concerts, sports, theater[^78][^79] | Free API key |
| **Songkick API** | [songkick.com/developer](https://www.songkick.com/developer) | Yes â€" `type=Festival` filter; 6M+ events; by artist/location[^80][^81] | API key (apply) |
| **AllEvents.in API** | [allevents.in/pages/events-api](https://allevents.in/pages/events-api) | Yes â€" world's largest live events DB claim; REST JSON; developer-first[^82] | Paid tiers |
| **AllEvents.ai** | [allevents.ai](https://www.allevents.ai) | Yes â€" API + MCP; structured feed; North America first; REST + agent tools[^83] | Paid |
| **Artsy Fairs API** | [developers.artsy.net/v2/docs/fairs](https://developers.artsy.net/v2/docs/fairs) | Art fairs specifically; status filter; paginated JSON[^11] | XAPP token (free) |
| **OpenAgenda API** | [developers.openagenda.com](https://developers.openagenda.com) | Yes â€" French-origin but global events; open license data; REST; exports in PDF/ICS/JSON/XLSX[^84][^85] | Free key required |
| **Skiddle API** | [skiddle.com/api](https://www.skiddle.com/api/) | Yes â€" `EventCode=FEST` filter; UK-focused; JSON[^86][^87][^88] | Free API key |
| **Bandsintown API** | [help.artists.bandsintown.com â€“ API](https://help.artists.bandsintown.com/en/articles/9186477-api-documentation) | Artist-centric; returns events by artist including festival appearances[^89] | Free `app_id` |
| **Eventbrite** | [eventbrite.com](https://eventbrite.com) | Yes â€" venue-based API access remains; HAR file extraction workaround for search[^90] | API key (partial) |

### 12.2 Google Events via SerpAPI

SerpAPI wraps Google's `Events` SERP, returning structured JSON with title, date, address, venue, ticket info for any keyword+location query[^91]. Useful for catching long-tail regional festivals that don't appear in ticketing APIs.

```
GET https://serpapi.com/search?engine=google_events&q=art+festival&location=Chicago
```

### 12.3 Apify Actors (Prebuilt Scrapers)

Several production-ready Apify actors exist for this problem domain:

| Actor | Source | Output |
|-------|--------|--------|
| `urban_quidnunc/music-festival-scraper` | MusicFestivalWizard.com | Festival name, location, dates, genres, headliners, ticket pricing; filter by region/month[^92] |
| `automation-lab/eventbrite-scraper` | Eventbrite | Event names, dates, venues, organizers, tags; filter by city/category[^93] |
| `amit123/allevents-in-scraper` | AllEvents.in | Titles, dates, locations, interest counts; by city/category[^94][^95] |
| `parseforge/artsy-scraper` | Artsy.net | Artworks, artists, gallery shows via GraphQL API[^14] |
| `parseforge/bandsintown-concerts-scraper` | Bandsintown/Songkick | Tour dates, venues, ticket links; fuzzy name matching[^96] |
| `ai_solutionist/seatgeek-data-api` | SeatGeek | Festival events, prices, AI demand scoring[^78] |
| `primeparse/ticketmaster-event-scraper` | Ticketmaster Discovery API | Official API wrapper; no blocks; city/category/date filters[^78] |

***

## 13. Wikidata / Wikipedia Structured Sources

Wikidata is underutilized for this problem. The SPARQL endpoint at `query.wikidata.org` can return all entities typed as `Q132241` (festival) or subtypes filtered by country/location[^97][^98]. Example SPARQL returning art festivals:

```sparql
SELECT ?festival ?festivalLabel ?location ?locationLabel ?startTime WHERE {
  ?festival wdt:P31/wdt:P279* wd:Q132241 .
  OPTIONAL { ?festival wdt:P276 ?location . }
  OPTIONAL { ?festival wdt:P580 ?startTime . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 5000
```

Wikipedia maintains a family of dedicated list articles, all parseable via the MediaWiki API:

| Article | URL |
|---------|-----|
| Lists of festivals (parent) | [/wiki/Lists_of_festivals](https://en.wikipedia.org/wiki/Lists_of_festivals)[^43] |
| List of theatre festivals | [/wiki/List_of_theatre_festivals](https://en.wikipedia.org/wiki/List_of_theatre_festivals)[^42] |
| List of new media art festivals | [/wiki/List_of_new_media_art_festivals](https://en.wikipedia.org/wiki/List_of_new_media_art_festivals)[^38] |
| List of folk festivals | [/wiki/List_of_folk_festivals](https://en.wikipedia.org/wiki/List_of_folk_festivals)[^44] |
| List of festivals in Europe | [/wiki/List_of_festivals_in_Europe](https://en.wikipedia.org/wiki/List_of_festivals_in_Europe)[^45] |
| List of electronic music festivals | [/wiki/List_of_electronic_music_festivals](https://en.wikipedia.org/wiki/List_of_electronic_music_festivals)[^99] |
| List of music festivals | [/wiki/List_of_music_festivals](https://en.wikipedia.org/wiki/List_of_music_festivals)[^100] |
| List of multinational festivals | [/wiki/List_of_multinational_festivals_and_holidays](https://en.wikipedia.org/wiki/List_of_multinational_festivals_and_holidays)[^101] |
| Biennale (with full list) | [/wiki/Biennale](https://en.wikipedia.org/wiki/Biennale)[^34] |
| List of Caribbean carnivals | [/wiki/List_of_Caribbean_carnivals_around_the_world](https://en.wikipedia.org/wiki/List_of_Caribbean_carnivals_around_the_world)[^56] |

The `wikimedia_content` API endpoint (`/w/api.php?action=parse&page=List_of_theatre_festivals&prop=wikitext`) returns raw wikitext that can be parsed for table rows with names, countries, and dates.

***

## 14. Open Data Sets & Government Portals

| Source | URL | Notes |
|--------|-----|-------|
| **Toronto Festivals & Events (JSON-LD)** | [civictechto.github.io â€“ Toronto feed](https://civictechto.github.io/toronto-opendata-festivalsandevents-jsonld-proxy/) | Schema.org Event format; daily snapshots; `all.jsonld` + `upcoming.jsonld`[^102] |
| **Brisbane Festival Open Data** | [data.brisbane.qld.gov.au](https://data.brisbane.qld.gov.au/explore/dataset/brisbane-festival-events/table/) | CSV + Trumba Calendar API XML; daily refresh[^103] |
| **FÃ¡ilte Ireland Events API** | [data.gov.ie/dataset/events](https://data.gov.ie/dataset/events) | Ireland events; CSV + REST API; daily updates[^104] |
| **OpenAgenda** | [openagenda.com](https://openagenda.com) | French-origin; open-license event data; Schema.org compliant; REST API free[^85] |
| **RenTechDigital SmartScraper** | [rentechdigital.com/smartscraper/business-listings/festivals](https://rentechdigital.com/smartscraper/business-listings/festivals) | Global festivals list; CSV/Excel/JSON download by geo hierarchy[^105] |

***

## 15. Specialty / Niche Directories

| Site | URL | Category | Notes |
|------|-----|----------|-------|
| **Artsdata.ca** | [artsdata.ca](https://artsdata.ca) | Performing arts (Canada) | Linked open data for Canadian performing arts; SPARQL queryable[^106] |
| **ArtsCalendar.com** | [artscalendar.com/directories](https://artscalendar.com/directories/) | Artist/org/venue directories | Separate artist, organization, and venue directories[^107] |
| **Mid Atlantic Arts â€" USArtists International** | [midatlanticarts.org/resources/international-festivals](https://www.midatlanticarts.org/resources/international-festivals/) | International performing arts festivals | 1,906 records; festivals outside the US; searchable[^35] |
| **Industry Mapper â€" Community Arts** | [industrymapper.com/Community-Arts-Festivals](https://www.industrymapper.com/en/ind/Community-Arts-Festivals) | Global community arts | Business directory format; community arts festival suppliers[^108] |
| **ExpoCaptive Arts & Crafts** | [expocaptive.com/arts-crafts](https://www.expocaptive.com/arts-crafts/) | Global trade shows | Verified exhibitor/attendee lists from global arts & crafts events[^109] |
| **Sachi Foundation Cultural Festival Directory** | [sachifoundation.org/cultural-festival-directory](https://www.sachifoundation.org/cultural-festival-directory) | Global cultural festivals | First directory of world cultural festival states; free[^110] |

***

## 16. Data Mining Strategy & Prioritization

### Tier 1 â€" Structured APIs (lowest friction, highest yield)

1. **Ticketmaster Discovery API** â€" filter `classificationName=Arts` + `type=Festival`; global; no scraping needed[^74]
2. **Artsy Fairs API** â€" `/api/fairs?status=upcoming`; authoritative gallery-tier data[^11]
3. **PredictHQ** â€" most comprehensive event intelligence platform; 18 categories; paid but worth it for coverage[^76]
4. **SeatGeek API** â€" free tier; `eventType=festival`[^79]
5. **Songkick API** â€" `type=Festival`; apply for key[^80]
6. **OpenAgenda API** â€" free; open-license; European depth[^84]
7. **Skiddle API** â€" free; UK festivals; `EventCode=FEST`[^86]
8. **AllEvents.in API** â€" paid; broadest single-source claim globally[^82]

### Tier 2 â€" Structured Scrape Targets (medium friction)

9. **Wikidata SPARQL** â€" `wdt:P31/wdt:P279* wd:Q132241` query; free; returns 1000s of art festival entities with geo and dates[^97]
10. **Wikipedia list articles** via MediaWiki API â€" parse wikitext tables; theater, dance, biennials, carnivals[^42][^38]
11. **Biennial Foundation map** â€" HTML + JSON backing the map; 100s of biennials[^30]
12. **FestivalNet** â€" largest NA database (26,000+); requires subscription + scrape[^15]
13. **ArtFairMag database** â€" 50-country HTML table[^1]
14. **TheCraftMap / CraftersMap** â€" US craft shows; map tiles expose JSON[^18]
15. **CaFÃ‰ (CallForEntry)** â€" public art and festival calls; HTML+JSON[^71]

### Tier 3 â€" Reference / Seed Lists (lower volume but high quality)

16. **RenFaireGuide.com** â€" 700+ ren faires[^51]
17. **Busker Central calendar** â€" busking/street festival events[^62]
18. **ILO / LUCI** â€" light festival network[^40][^41]
19. **Mid Atlantic Arts DB** â€" 1,906 international performing arts festivals[^35]
20. **Biennale.com** â€" 86 curated biennials[^31]
21. **SerpAPI Google Events** â€" catch long-tail regional events[^91]
22. **Open government portals** (Toronto, Brisbane, Ireland)[^102][^103][^104]

### Key Coverage Gaps to Note

- **European carnival circuit** (beyond Rio/Venice) has no single dedicated database; CarniFest covers some; Wikipedia's European carnival lists cover others[^54][^45]
- **Asian art festivals** outside biennials are fragmented; AllEvents.in and PredictHQ are the best bets for structural coverage
- **Puppet/animatronic parade events** require keyword-based API queries (`type=parade`, `puppet festival`) rather than dedicated directories
- **Community participatory art events** (FIGMENT-type) are self-reported; Eventbrite and AllEvents.in with category filter `community arts` are the best approaches[^61][^82]
- **Maker Faires** outside North America are listed at makerfaire.com/global[^68]

---

## References

1. [Art Fair Database](https://www.artfairmag.com/art-fair-database/)

2. [Plan Art Travel by Date and Destination](https://artfairslist.eu) - Plan art-focused travel with a searchable map of upcoming art fairs and exhibitions by date, city, c...

3. [Art Fair Calendar](https://artfairdates.com) - Simple, information-only art fair calendar with locations and dates.

4. [Art Fairs 2026 - ART FIX](https://art-fix.com/city-guide/art-fairs-2026/) - Newest Art Basel edition focused on the Middle East, North Africa, and Global South. Art Fairs 2026....

5. [The Fair Guide](https://www.thefairguide.com)

6. [Upcoming Art Fairs](https://artfairsourcebook.com/directory)

7. [Art Fair Calendar](https://artfaircalendar.com) - Find art fair, art show, craft show, art festival, art gallery, and art exhibition dates! Browse the...

8. [ArtFestival.com | Art Shows | Craft Shows | Art and Craft Festivals](https://www.artfestival.com) - ArtFestival.com for art and craft shows and festivals including popular outdoor art festivals and cr...

9. [Art Festival Calendar | ArtFestival.com](https://www.artfestival.com/calendar/art) - Art Festival Calendar. All Festivals Â· Art Festivals Â· Craft Festivals Â· Download All Art Festival E...

10. [Calendar: Every Major Art Fair Taking Place in 2026 - Art News](https://www.artnews.com/list/art-news/market/art-fair-calendar-1234654135/) - A guide to every major art fair in 2026, including Art Basel Paris, Frieze Seoul, Mexico City Art We...

11. [Fairs API](https://developers.artsy.net/v2/docs/fairs)

12. [Artsy â€" Discover and Buy Fine Art](https://www.artsy.net) - Artsy is the world's largest online art marketplace. Browse over 1 million artworks by iconic and em...

13. [Events Calendar and Featured Art Exhibitions on Artnet](https://www.artnet.com/events/) - Browse a curated selection of events from around the world, including gallery openings, upcoming auc...

14. [Artsy Scraper - Artworks, Artists, and Gallery Shows API in Python](https://apify.com/parseforge/artsy-scraper/api/python) - Learn how to interact with Artsy Scraper - Artworks, Artists & Shows API in Python. Includes an exam...

15. [FestivalNet â€" Find Craft Shows, Art Fairs & Music Festivals Near ...](https://festivalnet.com) - Search 26,000+ festivals, craft shows & art fairs across the US & Canada. Free event search â€" find y...

16. [FestivalNet(R) Updates Largest Database of Festivals and Fairs in North America](https://finance.yahoo.com/news/festivalnet-r-updates-largest-database-181500045.html) - Each year thousands of fairs and festivals take place across North America.

17. [Crafters Map - Your Craft Deserves a Crowd. We Map the Way.](https://craftersmap.com) - Join thousands of crafters and explore the best local fairs and festivals near you! Find Events From...

18. [About TheCraftMap | Find Craft Fairs Near You](https://www.thecraftmap.com/about) - Discover craft fairs, art shows, and artisan markets across all 50 states. Find booth fees, deadline...

19. [TheCraftMap - Find Craft Fairs Near You](https://www.thecraftmap.com) - Discover craft fairs, art shows, and artisan markets across all 50 states. Find booth fees, deadline...

20. [Craft Show Connect â€" Find & List Craft Shows](https://www.craftshowconnect.com) - Discover craft fairs, art shows, makers markets, and holiday markets near you. List your show and co...

21. [Craft Shows, Street Fairs, Art & Craft Festivals and More](https://www.artscraftsshowbusiness.com) - The East Coast's Leading Publication of Art & Craft Shows, Street Fairs, Festivals and More. Browse ...

22. [All States Event Listings](https://www.artscraftsshowbusiness.com/eventlistings.aspx) - All States Craft Shows, Art Shows, Festivals, Street Fairs, Home & Garden Shows, and more!

23. [About Craft Shows, Music Festivals, Craft Fairs, Fine Art Fairs](http://www.craftshowyellowpages.com/about_us.html) - About Craft Shows, Art Fairs, Music Festivals across the USA. Detailed listings on over 20,000+ even...

24. [Where The Shows Are!!! The Professional Guide to America's Art ...](https://www.artandcrafts.com) - Art & Craft shows in Florida, Georgia, Alabama, North Carolina, South Carolina, Louisiana, Virginia,...

25. [Arts and Craft Show Listings by State](http://www.artsandcraftsnetwork.com/shows/) - Search for arts and crafts show listing by state. Free to list and free to look.

26. [The United States' Events Directory](https://nationalcraftshowdirectory.com/events) - Looking for craft shows, art fairs or holiday events in your city? Visit our comprehensive listing o...

27. [Sell at Art and Craft Shows, Street Fairs and Festivals | The Authority ...](http://www.showlister.com) - Sell at Art and Craft Shows, event listings, craft fairs, festivals, street fairs, home and garden s...

28. [Craft Fair Listing Sites Comparison](https://community.etsy.com/t5/Craft-Fairs-it-s-a-living/Craft-Fair-Listing-Sites-Comparison/td-p/84466761) - Hi all, I'm new here and have been reading through the discussions on this team and have found them ...

29. [Visit the New FairsandFestivals.net!](https://www.fairsandfestivals.net/articles/view/visit_the_new_fairsandfestivals.net) - Find craft shows, art shows, fairs and festivals

30. [Directory of Biennials](https://biennialfoundation.org/network/biennial-map/) - Map of art biennials around the world

31. [Global Biennales Overview](https://biennale.com/overview.html) - Extensive guide to 86+ carefully selected international art biennales, triennales, and contemporary ...

32. [The Editorial Directory - Biennale](https://biennale.com/directory.html) - The Biennale Editorial Directory â€" 100+ editorial pages on the international biennale circuit. Filte...

33. [Network with Map - International Biennial Association](https://www.biennialassociation.org/network-with-map/)

34. [Biennale - Wikipedia](https://en.wikipedia.org/wiki/Biennale)

35. [International Festivals - Mid Atlantic Arts Foundation](https://www.midatlanticarts.org/resources/international-festivals/) - There are over 2000 Festivals! Use the search field or filters to narrow your results. Click here fo...

36. [Festival Database FAQ - Mid Atlantic Arts](https://www.midatlanticarts.org/grants-programs/festival-database-faq/) - Do I have to choose a festival from Mid Atlantic Arts' online database to be eligible for USArtists ...

37. [General Research Guide: Bienniales and Global Art Circuits](https://cortland.libguides.com/c.php?g=354000&p=2389128) - LibGuides: *Art History: General Research Guide: Bienniales and Global Art Circuits

38. [List of new media art festivals - Wikipedia](https://en.wikipedia.org/wiki/List_of_new_media_art_festivals) - The following is a list of festivals dedicated to new media art. Contents 1 International and online...

39. [Resources > Festivals](https://artport.whitney.org/v2/resources/festivals.shtml)

40. [BLIK BLIK](https://www.internationallightfestivals.org) - ILO, International Light Festivals Organisation, is a worldwide network of public light festivals, p...

41. [Light Festival Calendar - LUCI Association](https://www.luciassociation.org/light-festival-calendar/)

42. [List of theatre festivals - Wikipedia](https://en.wikipedia.org/wiki/List_of_theatre_festivals)

43. [Lists of festivals - Wikipedia](https://en.wikipedia.org/wiki/Lists_of_festivals)

44. [List of folk festivals - Wikipedia](https://en.wikipedia.org/wiki/List_of_folk_festivals)

45. [List of festivals in Europe - Wikipedia](https://en.wikipedia.org/wiki/List_of_festivals_in_Europe)

46. [About the International Theatre Institute ITI](https://www.iti-unesco-network.org/iti.html) - Joint Network of ITI & UNESCO with Higher Education & Research Institutions of the Performing Arts

47. [International Directory of Theatre, Dance and Folklore Festivals](https://www.americansforthearts.org/by-program/reports-and-data/legislation-policy/naappd/international-directory-of-theatre-dance-and-folklore-festivals)

48. [Faires & Festivals - LARP Portal](https://larportal.com/faires-and-festivals.php) - Larp Portal

49. [8 of the Best Art Festivals Across the Globe | RevArt Blog](https://revart.co/blogs/144_8_of_the_Best_Art_Festivals_Across_the_Globe) - From the vibrant displays of artistic brilliance in Europe to the captivating art fairs in New York,...

50. [About RenFaire Directory | RenFaireGuide.com - Renaissance](https://www.renfaireguide.com/about) - The #1 directory of 200+ Renaissance faires & medieval festivals & worldwide. Dates, locations, revi...

51. [Renaissance Faires Near Me 2026 - Find Ren Faires by ...](https://www.renfaireguide.com/near-me) - Find Renaissance faires near you. Browse 700+ faires with dates, locations, and nearby hotels.

52. [Renaissance, Medieval & Pirate Faire Directory](https://www.renfaire.com/Sites/)

53. [The Renlist - a new faire directory! - RenaissanceFestival.com](https://www.renaissancefestival.com/forums/index.php?topic=18054.0) - The Renlist - a new faire directory!

54. [About | Tickets Dates & Venues â€“ CarniFest.com](https://www.carnifest.com/about/) - CarniFest OnlineÂ® is the worldâ€™s most tightly knit events searching website. CarniFest Online helps ...

55. [Festivals carnivals venues and tickets worldwide | Tickets Dates & Venues â€“ CarniFest.com](https://www.carnifest.com) - Festivals carnivals, and tickets for all kinds of cultural events concerts and activities worldwide

56. [List of Caribbean carnivals around the world - Wikipedia](https://en.wikipedia.org/wiki/List_of_Caribbean_carnivals_around_the_world) - Search List of Caribbean carnivals around the world. Carnival is the cultural celebration held annua...

57. [Mardi Gras - Wikipedia](https://en.wikipedia.org/wiki/Mardi_Gras)

58. [The Orange Show's Houston Art Car Parade & Festival](https://www.thehoustonartcarparade.com) - April 9-12, 2026- Houston, TX - presented by Team Gillman - The world's largest gathering of Art Car...

59. [Art Car Parade Rolls into H-Town - Visit Houston Texas](https://www.visithoustontexas.com/blog/post/art-car-parade-rolls-into-h-town/) - You don't need a museum to see some incredible works of art during the 39th annual Houston Art Car P...

60. [The New Orleans Giant Puppet Festival](https://www.neworleansgiantpuppetfest.com)

61. [Event Details 2025 - FIGMENT Project](https://www.figmentproject.org/eventdetailsbos205) - FIGMENT is a free, participatory arts festival that invites people of all ages to play, engage, and ...

62. [BUSKER CENTRAL - Street Performers and Buskers Reference](https://www.buskercentral.com)

63. [Street Performers and Busker Gallery](https://www.buskercentral.com/busker.php)

64. [New map shows more than 170 street music festivals around the world](https://medium.com/@danielbacchieri/new-map-shows-more-than-170-street-music-festivals-around-the-world-9fbd6ec1274f) - 178 street music events have been identified around the planet in a new study led by brazilian journ...

65. [Buskers festival - Wikipedia](https://en.wikipedia.org/wiki/Buskers_festival)

66. [Resources: Buskers related organisations and advocates](https://blog.busk.co/busking-tips-tricks/buskers-organisations-advocates/) - A list of busker related organisations from all over the world, including Buskers Advocates, Playing...

67. [The Street Art List: Street Art & Mural Open Calls](https://thestreetartlist.com) - Discover global mural and street art open calls, public art RFQs, RFPs and EOIs for mural jobs aroun...

68. [Maker Faire |](https://makerfaire.com) - Upcoming events with Make: editors, makers, projects, and community Â· Makerspace Directory. A compre...

69. [National Festival of Making 2026: Open Call for Festival Workshops](https://festivalofmaking.co.uk/news/national-festival-of-making-2026-open-call-for-festival-workshops/)

70. [Public Art Calls | CaFÃ‰ - CallForEntry.org](https://www.callforentry.org/public-art/) - Access over 160,000 emerging and established artists. Build request for qualifications (RFQ) submiss...

71. [Call For Entry and Application Management for the Arts | CaFÃ‰](https://www.callforentry.org) - CaFÃ‰â„¢ is the foremost call for entries submission and online jurying solution by and for artists spe...

72. [Put Your City's Public Art on the Map with the Public Art Archive](https://www.nlc.org/article/2025/07/09/put-your-citys-public-art-on-the-map-with-the-public-art-archive/) - Co-authored by Christina Villa, Business Director, Creative West; Lori Goldstein, Public Art Archive...

73. [CaFE Event Information - Public Art Archive - Call for Artwork Submissions](https://artist.callforentry.org/festivals_unique_info.php?ID=13531) - Read more about Public Art Archive - Call for Artwork Submissions on CaFE

74. [Build Better Experiences - The Ticketmaster Developer Portal](https://developer.ticketmaster.com/products-and-docs/apis/getting-started/) - We currently offer event discovery and commerce APIs with various access tiers. allows you to create...

75. [Get started with The Discovery API](https://developer.ticketmaster.com/products-and-docs/tutorials/events-search/search_events_with_discovery_api.html) - Basic walkthrough of the Discovery API and how to get value out of it quickly.

76. [Festivals API - Ranked Event Data](https://www.predicthq.com/events/festivals) - Get an enriched global festivals API & all our categories in one data feed. Search, discover & be no...

77. [Perfoming Arts API - Ranked Event Data - PredictHQ](https://www.predicthq.com/events/performing-arts) - Our ingenious API collates and aggregates millions of scheduled and unscheduled events into one cent...

78. [SeatGeek Scraper & API](https://apify.com/ai_solutionist/seatgeek-data-api) - Extract event tickets, prices & venue data from SeatGeek. Batteries included - no API keys needed! G...

79. [SeatGeek API | Documentation & Integration Guide](https://api.matrix-db.com/api/seatgeek/) - The SeatGeek API allows you to search for live events, venues, and performers across sports, concert...

80. [The best api for live music](https://www.songkick.com/developer) - Find live music near you, track your favorite artists, get instant concert alerts and buy tickets fo...

81. [Upcoming event search](https://www.songkick.com/developer/event-search) - Find live music near you, track your favorite artists, get instant concert alerts and buy tickets fo...

82. [AllEvents Data & API â€" The world's largest live events database](https://allevents.in/pages/events-api) - Build apps with the world's largest live events data: events, venues, performers, and organizers. Fa...

83. [Live Event Data for Agents & Apps (API + MCP)](https://www.allevents.ai) - AllEvents.ai provides fresh, deduped event data for AI assistants, travel, hospitality, transportati...

84. [API OpenAgenda: Introduction](https://developers.openagenda.com) - OpenAgenda met Ã  disposition une API REST permettant de lire et d'Ã©diter des contenus Ã©vÃ©nementiels ...

85. [Create an agenda, reference and broadcast your events](https://openagenda.com/en/p/home) - OpenAgenda is a web software dedicated to promote public events. For event organizers Artists, cultu...

86. [Using the API to Retrieve Data - Skiddle/web-api GitHub Wiki](https://github-wiki-see.page/m/Skiddle/web-api/wiki/Using-the-API-to-Retrieve-Data)

87. [Skiddle - Free API Documentation - FindAPIs](https://findapis.com/fr/api/skiddle) - Skiddle.com is a whats on guide website that offers a ticket search and booking service for events, ...

88. [Skiddle API](https://www.skiddle.com/api/) - Details of how to use our API can be found on our GitHub page, along with a PHP SDK that can help in...

89. [API documentation](https://help.artists.bandsintown.com/en/articles/9186477-api-documentation)

90. [No-Code Eventbrite API Data Scraper | Legally Download to CSV](https://stevesie.com/apps/eventbrite-api) - Legally scrape Eventbrite data from the Official API for 100% accurate & legal downloads. This means...

91. [Google Events API](https://serpapi.com/google-events-api) - Use SerpApi's Google Events Engine Results API to scrape Google's Events Platform. Event titles, dat...

92. [Music Festival Scraper | Apify Actor Â· Apify](https://apify.com/urban_quidnunc/music-festival-scraper) - Scrape music festival lineups, dates, and ticket info worldwide

93. [Eventbrite Scraper - Extract Events & Conferences API in ...](https://apify.com/automation-lab/eventbrite-scraper/api/javascript) - Learn how to interact with Eventbrite Scraper API in JavaScript. Includes an example JavaScript code...

94. [AllEvents.in scraper [DEPRECATED] Â· Apify](https://apify.com/amit123/allevents-in-scraper) - Scrapes event listings from AllEvents.in by city and category, supporting pagination and structured ...

95. [AllEvents.in scraper API through CLI [DEPRECATED] Â· Apify](https://apify.com/amit123/allevents-in-scraper/api/cli) - Learn how to interact with AllEvents.in scraper API through the CLI. Includes an CLI example to help...

96. [Bandsintown Concerts Scraper | Tour Dates CSV/JSON Export API ...](https://apify.com/parseforge/bandsintown-concerts-scraper/api/cli) - Learn how to interact with Bandsintown Concerts Scraper API through the CLI. Includes an CLI example...

97. [Wikidata:SPARQL query service/Wikidata Query Help/Result Views/nl](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/Wikidata_Query_Help/Result_Views/nl)

98. [Wikidata SPARQL queries in Jupyter - Alexander Dunkel](https://ad.vgiscience.org/links/posts/2023-07-25-wikidata-sparql-query-jupyter/) - The SPARQL query (example: Events in Nevada): #title: All events in Nevada, based on distance query ...

99. [List of electronic music festivals - Wikipedia](https://en.wikipedia.org/wiki/List_of_electronic_music_festivals)

100. [List of music festivals - Wikipedia](https://en.wikipedia.org/wiki/List_of_music_festivals)

101. [List of multinational festivals and holidays - Wikipedia](https://en.wikipedia.org/wiki/List_of_multinational_festivals_and_holidays) - International Workers' Day: 1 May Â· Star Wars Day: May the 4th Â· Cinco de Mayo "May 5" Â· European Un...

102. [Toronto Festivals & Events â€" JSON-LD Feed](https://civictechto.github.io/toronto-opendata-festivalsandevents-jsonld-proxy/)

103. [Events â€" Brisbane Festival â€" Explore our Open Data](https://data.brisbane.qld.gov.au/explore/dataset/brisbane-festival-events/table/) - This Dataset contains event information for the Brisbane City Council Brisbane Festival. The festiva...

104. [Events - data.gov.ie](https://data.gov.ie/dataset/events)

105. [Complete List Of Festivals Worldwide](https://rentechdigital.com/smartscraper/business-listings/festivals) - Browse directory of Festivals by continent, subcontinent, country, state, and city. Smartscrapers of...

106. [Online Directories for Performing Arts - Digital Arts Nation](https://digitalartsnation.ca/digital-playbook/mastering-discoverability-for-the-performing-arts/online-directories-for-performing-arts/)

107. [Find](https://artscalendar.com/directories/) - DIRECTORIES Find an artist, organization, or venue. Once on a directory page, you can search using k...

108. [Community Arts Festivals Global Directory - Industry Mapper](https://www.industrymapper.com/en/ind/Community-Arts-Festivals) - Discover a global business list or directory of community arts festivals suppliers, factories, manuf...

109. [ExpoCaptive Arts & Crafts Events â€" Exhibitor & Attendee List](https://www.expocaptive.com/arts-crafts/) - Explore global Arts & Crafts events with ExpoCaptive. Access verified exhibitor and attendee lists b...

110. [Cultural Festival Directory | sachifoundation](https://www.sachifoundation.org/cultural-festival-directory) - Harvest Festivals, Self-Similar Festivals, Build Momentum Festivals, Pace maker Festivals, Coherence...
