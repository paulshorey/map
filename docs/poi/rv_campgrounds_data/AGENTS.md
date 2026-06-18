# RV / Caravan Campground Data Dump
Generated: 2026-06-18

## Summary

| Source | Records | RV/Hookup Records | Format | Notes |
|--------|---------|-------------------|--------|-------|
| RIDB (Federal) | 5,979 facilities + 134,891 campsites | 121,876 hookup-relevant | JSON + CSV | US federal lands (NPS, BLM, USFS, Army Corps) |
| The Dyrt | 74,307 campgrounds | 43,272 with RV data | JSONL + CSV | Largest US private+public campground DB |
| OpenStreetMap | 56,157 sites | 36,239 caravan_site | JSON + CSV | Global coverage, all continents |
| uscampgrounds.info | 13,011 campgrounds | 4,742 with hookups | CSV | US+Canada, 2014 data but good seed list |
| **TOTAL** | **284,345** | **~206,000+** | | |

## Files

### RIDB (US Federal Campgrounds)
- `ridb/facilities.json` — 5,979 campground facilities with full metadata (35MB JSON)
- `ridb/facilities.csv` — Same, flat CSV format
- `ridb/campsites.jsonl` — 134,891 individual campsites with attributes (335MB JSONL, one record per line)
- `ridb/campsites_rv_hookup.csv` — 121,876 campsites filtered to RV/electric/hookup types (CSV)

**RIDB Campsite Types with counts:**
- STANDARD NONELECTRIC: 61,719
- STANDARD ELECTRIC: 33,455
- TENT ONLY NONELECTRIC: 9,622
- RV NONELECTRIC: 3,328
- RV ELECTRIC: 3,127

**RIDB Hookup Attributes:**
- Water Hookup: 47,152 sites
- Electricity Hookup: 44,523 sites
- Sewer Hookup: 11,646 sites
- Full Hookup: 1,777 sites

**API Key used:** `a7416471-1b5d-4a64-ad3d-a233e7cb5c44` (from camply library, public)

### The Dyrt (Private + Public Campgrounds)
- `thedyrt/campgrounds.jsonl` — 74,307 campgrounds, full detail (563MB JSONL)
- `thedyrt/rv_campgrounds.csv` — 43,272 RV-relevant campgrounds filtered (CSV)

**Key RV fields in The Dyrt data:**
- `electric-hookups` (bool): 25,947 campgrounds
- `water-hookups` (bool): 24,068
- `sewer-hookups` (bool): 19,122
- `thirty-amp-hookups` (bool): 9,349
- `fifty-amp-hookups` (bool): 14,960
- `max-vehicle-length-ft` (int)
- `big-rig-friendly` (bool): 23,121
- `driveway-pull-through` / `driveway-back-in`
- `sanitary-dump` (bool)

**API endpoint:** `https://thedyrt.com/api/v5/campgrounds?page[number]=N&page[size]=100` (no auth)

### OpenStreetMap (Global)
- `osm/osm_caravan_sites.json` — 56,157 elements (21MB JSON)
- `osm/caravan_sites.csv` — Same, flat CSV format

**Coverage by region:**
- Europe: 34,539 (most comprehensive, especially France, Germany, Netherlands)
- North America: 13,751
- Oceania (Australia/NZ): 4,406
- Africa: 1,539
- Asia: 1,327
- South America: 595

**Key OSM tags:** `tourism=caravan_site` (36,239), `tourism=camp_site` with `caravans=yes` or `motorhome=yes` (19,918)

**Note:** OSM hookup data is sparse — only ~150 elements have electric tags. Treat OSM as location/coordinate data and enrich with other sources.

**Query used:** Overpass API, all continents, bbox-split to avoid timeout

### uscampgrounds.info (US+Canada seed list)
- `uscampgrounds/all_campgrounds_combined.csv` — 13,011 campgrounds (all regions)
- `uscampgrounds/rv_hookup_campgrounds.json` — 4,742 with E/WE/WES hookups

**Amenity codes:**
- `E` = Electric only (3,106 sites)
- `WE` = Water + Electric (837 sites)
- `WES` = Water + Electric + Sewer (799 sites)
- `DW` = Drinking water, `SH` = Showers, `NH` = No hookups, etc.

**Note:** Data is from 2014 — use as seed/bootstrap list, not as live ground truth.

## Sources NOT Obtained (and Why)

- **iOverlander** — Requires account login for export. Has ~76k global overlanding spots. Sign up at ioverlander.com and use `/export/places?countries[]=ID&xformat=json`
- **Campendium/Roadtrippers** — Data stored in private Mapbox tilesets, no public API
- **Active Network / ReserveAmerica** — API access requires application approval
- **Campflare** — Invite-only API

## How to Use

### Filter The Dyrt for full hookup RV parks (Python):
```python
import json
rv_parks = []
with open('thedyrt/campgrounds.jsonl') as f:
    for line in f:
        r = json.loads(line)
        a = r['attributes']
        if a.get('electric-hookups') and a.get('water-hookups') and a.get('sewer-hookups'):
            rv_parks.append(a)
print(f"{len(rv_parks)} full-hookup RV parks")
```

### Filter RIDB for electric campsites:
```python
import json
electric = []
with open('ridb/campsites.jsonl') as f:
    for line in f:
        cs = json.loads(line)
        if 'ELECTRIC' in cs.get('CampsiteType','').upper():
            electric.append(cs)
```

### Query OSM caravan sites by country (Python):
```python
import json
with open('osm/osm_caravan_sites.json') as f:
    data = json.load(f)
france = [e for e in data['elements'] if e.get('tags',{}).get('addr:country') == 'FR']
```
