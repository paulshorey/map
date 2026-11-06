# Data reset and re-import — 2026-11-05

Owner decision: data produced by older pipeline logic is purged and re-ingested from the raw
captures, never upgraded in place ([runbook](../data/poi-ingestion.md#outdated-data-re-ingest-never-upgrade)).

## What was done

- `ingest:purge` removed 1,622,551 rows from 33 import/run/canonical tables. Kept: the geocode
  query cache (7,155 entries: 4,268 forward, 2,884 reverse), 21 categories, 11 source
  registrations, the 251-file capture inventory, controls, users.
- Old job journals and logs: `lib/db-map/.ingest-archive/pre-purge-20261105/` (private, ignored).
- `ingest:staleness` now reports all sources current. New runs refuse sources with outdated
  records; the in-place upgrade code was removed.

## Re-import, one file at a time

Only one full import runs at once. Each command detaches; check it with
`pnpm --silent --filter @lib/db-map ingest:supervise status --job <job-id>`, and confirm the
outcome before starting the next one.

```bash
cd ~/git/map
python3 scripts/coordinator-ingestion.py snapshot   # quiescent, no claims
start() { pnpm --silent --filter @lib/db-map ingest:supervise start --local-only -- "$1" --category "$2" --unlimited; }

# Small sources first (minutes each)
start data/poi/art-fairs/biennials/biennale_com.json            art_fair          # 43
start data/poi/art-fairs/biennials/biennial_association.json    art_fair          # ~41
start data/poi/art-fairs/biennials/biennial_foundation.json     art_fair          # 304
start data/poi/art-parades/street-arts/aurillac_festival.json   art_parade        # 6
start data/poi/hostels/california-hostels.json                  hostel            # 52
start data/poi/music-festivals/apis/jambase_festivals.json      music_festival    # ~1,260
start data/poi/music-festivals/directories/thatfestivalsite_festivals.json music_festival  # ~1,420
start data/poi/botanical_gardens_data/bgci_gardens_full.json    botanical_garden  # 3,649 (~3 h)
# Last, and only after the reverse-lookup budget is addressed (see below):
start data/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv   campground        # 43,272
```

RIDB `facilities.csv` stays deferred (see [source readiness](source-ingestion-readiness.md)).

## Quota

LocationIQ's free plan allows 5,000 calls a day. The Dyrt has 43,272 rows with coordinates,
but only 18,311 addresses and 24,377 cities, so roughly 25,000 reverse lookups are needed
(the cache holds 2,884). Before importing it, upgrade the plan or stop calling reverse
lookups for address-only gaps.
