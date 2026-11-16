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

Use the import queue. It runs the plan's files in order, starts the next only after the
previous one is verified complete, and waits out the daily geocoding quota.

```bash
cd ~/git/map
pnpm --silent --filter @lib/db-map ingest:overview --json          # quiescent, not in maintenance
pnpm --silent --filter @lib/db-map ingest:inventory --refresh
pnpm --silent --filter @lib/db-map ingest:import-queue start --plan data/import-plans/reset-20261105.json
pnpm --silent --filter @lib/db-map ingest:import-queue status
```

The plan lists nine files, small sources first: `biennale_com` (43), `biennial_association`
(~41), `biennial_foundation` (304), `aurillac_festival` (6), `california-hostels` (52),
`jambase_festivals` (~1,260), `thatfestivalsite_festivals` (~1,420), `bgci_gardens_full`
(3,649) and The Dyrt (43,272). The queue refuses to start while BGCI is `needs_review` in the
inventory, so the first seven were started on 2026-11-16 with the ad hoc form
(`start -- <file>=<category> …`). The rest of the backlog is
`data/import-plans/backlog-20261116.json`.

RIDB `facilities.csv` stays deferred (see [source readiness](source-ingestion-readiness.md)).

## Quota

LocationIQ's free plan allows 5,000 calls a day. The Dyrt has 43,272 rows with coordinates,
but only 18,311 addresses and 24,377 cities, so roughly 25,000 reverse lookups are needed
(the cache holds 2,884). Before importing it, upgrade the plan or stop calling reverse
lookups for address-only gaps.

## Multi-location storage — before any re-import

`claude/multi-location` adds `research_poi_locations` and `canonical_poi_locations` (migration
`202611051600__multi_location_storage.sql`, applied on dev). Every known location of a record is
stored, every accepted location of a canonical is mapped, and the drawer lists them all. A
5-record `biennale_com` smoke confirmed the path end to end and was cleaned afterwards; the dev
database is empty again. Re-import with the commands above once that branch is merged or
checked out.
