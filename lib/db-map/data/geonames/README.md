Reference geography for the POI ingestion pipeline. The geocode stage reads these files in
process for its offline reverse lookup (`scripts/ingest/offline-reverse.ts`): a point's
country, region and nearest town, with no provider call.

| File | Contents | Source and licence |
| --- | --- | --- |
| `cities500.txt`, `cities500-readme.txt` | Places with a population of 500 or more | GeoNames, CC BY 4.0 |
| `admin1CodesASCII.txt` | Names of first-level regions (`US.TX` → Texas) | GeoNames, CC BY 4.0, downloaded 2026-11-15 from <https://download.geonames.org/export/dump/> |
| `countries360-2024.csv` | Country centroids | GeoNames-derived reference set |
| `regions.json.gz` | Region boundaries, each with its country and GeoNames region name | Built by `build-regions.py` from Natural Earth 1:10m admin-1 v5.1.2 (public domain) |

`regions.json.gz` is generated. To rebuild it after replacing `cities500.txt` or the Natural
Earth file, download the GeoJSON named at the top of `build-regions.py` and run:

```sh
python3 lib/db-map/data/geonames/build-regions.py /path/to/ne_10m_admin_1_states_provinces.geojson
```

Natural Earth units are states in some countries and counties in others, so the script labels
each one with the GeoNames region that most places inside it belong to. Coordinates are stored
in thousandths of a degree (about 110 m).

`cities500.txt` and `countries360-2024.csv` also seed the `geo_centroids` table
(`ingest:seed:centroids`).
