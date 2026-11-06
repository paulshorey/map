# RIDB facility addresses (2026-11-06)

Owner decision 2026-11-06: recapture addresses for RIDB
`data/poi/rv_campgrounds_data/ridb/facilities.csv` where possible, still map and save facilities
that have no address (flagged `missing_address`), and do not import RIDB campsites as campgrounds.

## Sources

| Option | Key | Limits | Addresses |
| --- | --- | --- | --- |
| **Full export** `https://ridb.recreation.gov/downloads/RIDBFullExport_V1_CSV.zip` (linked from [RIDB Data Download](https://ridb.recreation.gov/download)) | None | One 248 MB download, refreshed daily (the copy used was modified 2026-11-04 18:47 UTC) | `FacilityAddresses_API_v1.csv`, every facility address row |
| API `GET /api/v1/facilities/{id}/facilityaddresses` or `/facilityaddresses` ([docs](https://ridb.recreation.gov/docs)) | `apikey` header, from a free RIDB account | 50 requests/second per the OpenAPI spec | Same rows, paged |

The export needs no key and is a single request, so it is the one to use. The API is only worth
it for a record-level refresh between exports. Terms: [RIDB access agreement](https://ridb.recreation.gov/access-agreement-ridb);
attribution "Data Source: Recreation.gov". (The key in `rv_campgrounds_data/AGENTS.md` is
a third-party library's public key and is not needed.)

Capture used: `RIDBFullExport_V1_CSV.zip`, sha256
`8639d1daf988b8f5cb57e4f1d1683f5a9a709ea562eb7d1d1adb80e86c21612d`, downloaded 2026-11-05 14:42 UTC.

## What was in the repository

`ridb/facilities.csv` (2026-06-18, 5,979 FacilityIDs, 14 API columns) and
`ridb/campsites_rv_hookup.csv`. The `facilities.json` / `campsites.jsonl` files listed in
`rv_campgrounds_data/AGENTS.md` were never committed. No RIDB rows existed in the dev database
on 2026-11-06.

## Coverage (5,979 captured facilities)

- 5,974 are in the export; 5 are no longer in it (kept with `export_status = missing_from_export`).
- 5,706 have at least one export address row (Default 4,357 alone; Mailing 604 alone;
  Physical 87 alone; the rest have a mix of types); 273 have none.
- After selection (below): **1,839 get a street address**, 2,355 a city, 2,379 a street
  address or city, 1,836 a ZIP code, and 5,032 a state (`region`) plus `country_code = US`.
  4,140 have no street address and will carry `missing_address`.
- 434 have `(0,0)` sentinel coordinates (1 is fixed in the export). 41 of those get a street
  address and 54 a city, so forward geocoding can now place them. The rest fall back to the
  pipeline's normal general-location handling.
- 4,929 get a longer (untruncated) description from the export.
- Coordinates: 2,607 are identical, 3,361 differ only by the export's 6-decimal rounding (the
  original 8-decimal value is kept), and 6 moved (the export value is used).

## Address selection (`scripts/ridb-facility-addresses.py`)

RIDB address quality is mixed. Default rows are often the managing office, and the street
line is often a PO box, an agency name ("U.S. ARMY CORPS OF ENGINEERS") or a ranger district.
The rules are deterministic:

1. Use only Physical rows, then Default rows. Mailing rows are where the agency gets its mail,
   so they are kept verbatim but never used.
2. Accept a street line only if it starts with a house number or names a numbered/named road,
   and contains no PO box, office, district, ranger/guard station, work center,
   headquarters, c/o or mailing wording.
3. A row whose street line is rejected contributes only its state; its city and ZIP are the
   office's. City and ZIP come from rows whose street is accepted or empty.
4. States are normalized to USPS codes (122 full names and blanks are fixed). `country_code` is
   `US` when a state code exists (`AddressCountryCode` contains noise such as `1`).
5. ALL-CAPS values are title-cased for display. Every export address row is kept verbatim as
   JSON in `facility_addresses`, and rejection reasons are kept in `address_selection`.

Known residual risk: a numbered office street address (e.g. a BLM field office in Moab listed
as the Default address) passes rule 2. The pipeline forward-geocodes listed addresses
separately from the source point (`inferred_coordinates`), and the location assessment
reports far-apart pairs. Review those in the location review workflow, not by hand here.

## Capture and code changes

- New capture `ridb/facilities_with_addresses.csv`: one row per original FacilityID (same
  order). It has the original 14 columns refreshed from the export, plus `LegacyFacilityID`,
  `OrgFacilityID`, `ParentOrgID`, `ParentRecAreaID`, `FacilityUseFeeDescription`,
  `FacilityDirections`, `FacilityMapURL`, `FacilityAdaAccess`, `Enabled`, `address`, `city`,
  `region`, `postal_code`, `country_code`, `address_type`, `address_selection`,
  `export_status` and `facility_addresses`. `facilities.csv` is unchanged.
- `sources.ts`: the `ridb` source now registers the new file (extractor version 3). The
  extractor maps the address fields and parses `facility_addresses` into attributes.
- `expected-captures.json`: new file `import` (required); `facilities.csv` becomes `alternate`
  (superseded, kept for provenance); `campsites_rv_hookup.csv` becomes `supporting` (child
  campsite data, never imported as campgrounds).
- Review flag `missing_address` (`lib/db-map/sql/review-flags.ts`): no active member has a
  non-empty source address. An address filled in by reverse geocoding
  (`location_enrichment.provenance.address = 'reverse_geocode'`) does not count. Map label "No address".
  No backfill migration (it would hard-code the flag list and race the parallel
  `generated_name` flag); run `ingest:review-flags --refresh` after merge instead.

## Rebuild the capture from a newer export

Keep downloads in their own directory and run the script with `python3 -I`:

```sh
mkdir -p /tmp/ridb-export/x
curl -fsS -o /tmp/ridb-export/RIDBFullExport_V1_CSV.zip \
  https://ridb.recreation.gov/downloads/RIDBFullExport_V1_CSV.zip
unzip -o /tmp/ridb-export/RIDBFullExport_V1_CSV.zip \
  Facilities_API_v1.csv FacilityAddresses_API_v1.csv -d /tmp/ridb-export/x
python3 -I scripts/ridb-facility-addresses.py \
  data/poi/rv_campgrounds_data/ridb/facilities.csv \
  /tmp/ridb-export/x/Facilities_API_v1.csv /tmp/ridb-export/x/FacilityAddresses_API_v1.csv \
  data/poi/rv_campgrounds_data/ridb/facilities_with_addresses.csv
```

A changed file is a new file version, so it needs a new run, not a resume.

## Re-import (owner, after merge, from the primary checkout)

See the PR for the smoke-run evidence. The geocoding cost is about one reverse lookup per
facility with a point and one forward lookup per listed address. That is roughly 7,500
LocationIQ requests, more than one day's 5,000 quota; the pipeline waits for the
quota reset by itself.

```sh
cd ~/git/map && git pull
python3 scripts/coordinator-ingestion.py snapshot           # nothing else on ridb
pnpm --filter @lib/db-map ingest:inventory --refresh        # pick up the new file/dispositions
pnpm --filter @lib/db-map ingest:quota
pnpm --filter @lib/db-map ingest:run data/poi/rv_campgrounds_data/ridb/facilities_with_addresses.csv \
  --category campground --unlimited
pnpm --filter @lib/db-map ingest:review-flags --refresh     # backfill missing_address on existing POIs
pnpm --filter @lib/db-map ingest:review-flags               # counts per flag
```

For a supervised launch, use the coordinator from the primary checkout instead of the
`ingest:run` line ([agent operations](../data/ingestion-agents.md)):

```sh
python3 scripts/coordinator-ingestion.py start -- \
  data/poi/rv_campgrounds_data/ridb/facilities_with_addresses.csv --category campground --unlimited
```

## Validation (2026-11-06, dev database)

Three single-record managed runs (record limit 1, `--max-llm-requests 3 --max-cost-usd 0.05
--geocode-limit 4`), each `requested_scope_verified` in about 24 s. They used 7 LocationIQ
requests and cost $0.0035 in normalization in total:

| Record | Case | Run | Result |
| --- | --- | --- | --- |
| 261822 White Sandy Campground | Point + street address | `7254453c-848e-4ebc-a696-8ef914348e0e` | Published at source point; address/city/region `source`; flags `{}` |
| 10054711 Cove Creek (AR) | `(0,0)` + street address | `5cf641e2-c61c-4010-b8fa-aac42ae48744` | Forward-geocoded to a point from `734 Cove Creek Road, Quitman, AR`; flags `{}` |
| 236553 Moore Campground | `(0,0)`, state only | `28163199-ff98-4f2d-b315-5092fd6f8873` | Published at the US country fallback; flags `{general_location, missing_address}` |

Static checks: `pnpm --filter @lib/db-map check-types`, `tsc --noEmit` for `apps/map`, and
`tsx --test` on `registered-captures`, `discovery` and `source-file` tests.

## Follow-up

The location pipeline falls back from a rejected venue lookup to a city, then to a country;
there is no state/region level. About 380 `(0,0)` facilities have a state but no city, so they
land on the US centroid (still flagged `general_location` and `missing_address`). A
region-level fallback would place them in the right state. It is a pipeline-wide change, so
it is left for a separate task.
