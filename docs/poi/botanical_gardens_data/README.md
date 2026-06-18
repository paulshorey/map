# Global Botanical Gardens & Arboreta — Data Dump

Extracted: June 17, 2026

## Files

| File | Source | Records | Format | Key Fields |
|------|--------|---------|--------|------------|
| `bgci_gardens_full.json` | BGCI GardenSearch | 3,649 | JSON | id, name, lat, lon, country, city, website, phone, email, open_to_public, total_area_hectares, visitors_annual, overview_statement, mission_statement, 11 network membership flags, arbnet_accredited_level, year_incorporated, social media links |
| `bgci_gardens.csv` | BGCI GardenSearch | 3,649 | CSV | Flat version of above (35 columns) |
| `arbnet_morton_register.json` | ArbNet Morton Register | 2,733 | JSON | name, url, slug, description |
| `arbnet_morton_register.csv` | ArbNet Morton Register | 2,733 | CSV | Same as above |
| `iabg_checklist_gardens.json` | IABG Global Checklist | 2,115 | JSON | region, country, name, alt_name |
| `iabg_checklist_gardens.csv` | IABG Global Checklist | 2,115 | CSV | Same as above |
| `wikidata_botanical_gardens.json` | Wikidata SPARQL | 3,916 | JSON | wikidata_id, name, country, lat, lon, website, founded, area_ha |
| `wikidata_botanical_gardens.csv` | Wikidata SPARQL | 3,916 | CSV | Same as above |
| `osm_botanical_gardens.csv` | OpenStreetMap Overpass | 3,421 | CSV | osm_id, osm_type, name, lat, lon, website, phone, email, opening_hours, operator, addr_city, addr_country, wikipedia, wikidata |
| `wikipedia_us_gardens.json` | Wikipedia (all 50 US states) | 855 | JSON | state, name, city, county, area, founded, wikipedia_url |
| `wikipedia_us_gardens.csv` | Wikipedia (all 50 US states) | 855 | CSV | Same as above |
| `wikipedia_intl_gardens.json` | Wikipedia (50+ countries) | 3,293 | JSON | country, name, city, region, notes, founded, area, wikipedia_url |
| `wikipedia_intl_gardens.csv` | Wikipedia (50+ countries) | 3,293 | CSV | Same as above |
| `gardenology_us_gardens.json` | Gardenology.org | 738 | JSON | state, name, city, gardenology_url |
| `gardenology_us_gardens.csv` | Gardenology.org | 738 | CSV | Same as above |

**Total across all sources: ~20,720 records** (with significant overlap between sources)

## Source Notes

### BGCI GardenSearch (`bgci_gardens_full.json`) — MOST COMPLETE
- API: `https://datatools.bgci.org/api/gardens/{id}` (discovered from JS bundle)
- 3,649 verified global gardens with rich metadata
- 3,400 (93%) have GPS coordinates
- Includes 11 regional network membership flags (BGCI, ABG, Caribbean/Central American, ECBG, ERA, GCC, IPEN, NANPCA, REDSAB, RNBG, SAGB)
- Accreditation: `botanic_garden_accredited`, `arbnet_accredited_level` (I–IV), `index_herbariorum_code`
- Top countries: USA (961), UK (222), Australia (160), China (143), Canada (133), India (119), France (117), Italy (108)

### ArbNet Morton Register (`arbnet_morton_register.*`)
- Source: `https://arbnet.org/wp-json/wp/v2/register` (WordPress REST API)
- 2,733 arboreta and woody-plant-focused gardens globally
- Note: Individual pages are React SPAs — detail fields (location, coordinates) not available via static extraction; only name and URL captured

### IABG Checklist (`iabg_checklist_gardens.*`)
- Source: Parsed from http://iabg.scbg.cas.cn/notice/201801/t20180131_395283.html
- 2,115 verified gardens (from initial list of 3,201, after deduplication/verification by IABG working group)
- Regional breakdown: Europe (678), North America (506), Asia (499), South America (173), Africa (131), Oceania (122)
- Top countries: USA (366), China (162), India (90), France (90), Italy (87), Germany (82)

### Wikidata (`wikidata_botanical_gardens.*`)
- SPARQL query: `wdt:P31/wdt:P279* wd:Q167346` (botanical garden) + `wd:Q1649388` (arboretum)
- 3,916 records, most with GPS coordinates and Wikidata QIDs
- Top countries: USA (828), France (395), Japan (381), Italy (246), Germany (237), Australia (201)

### OpenStreetMap (`osm_botanical_gardens.csv`)
- Overpass query: `garden:type=botanical` tag globally
- 3,421 named gardens with GPS coordinates
- Many have phone, email, opening hours, operator, Wikipedia/Wikidata cross-references
- OSM data is crowdsourced and variable in quality

### Wikipedia US (`wikipedia_us_gardens.*`)
- Extracted HTML tables from all 50 states + DC + Puerto Rico
- 855 records with structured fields (name, city, county, area, founded)
- Source pages: `en.wikipedia.org/wiki/List_of_botanical_gardens_and_arboretums_in_[State]`

### Wikipedia International (`wikipedia_intl_gardens.*`)
- 50+ country pages
- 3,293 records including Australia (380), India (624), Japan (413), Czech Republic (292), France (287)
- Note: Pakistan entry (502) likely includes erroneous links due to redirect/disambiguation pages

### Gardenology (`gardenology_us_gardens.*`)
- Source: https://gardenology.mywikis.net/wiki/List_of_botanical_gardens_in_the_United_States
- 738 US gardens with state, name, and city
