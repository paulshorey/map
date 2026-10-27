# Biennale.com 43-record refresh receipt

Completed on 2026-10-26 CT using merged PR #66, commit
`32af110dec0e9dc8c0e99f587028b5ceb35d6a87`. This closes the single-file
authorization in [the precision metadata plan](location-precision-metadata.md).
Both ingestion heartbeats remain paused. No additional import or retry was launched.

## Identity and terminal evidence

| Receipt      | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| Job          | `48fc0682-b833-401a-ab42-792e6195f93c`                                                  |
| Run          | `6c4a2c29-06c5-4f3a-8d76-405c9d85253c`                                                  |
| Execution    | `f0ec6b8d-7fea-4fda-b072-790cf7c27d1b`                                                  |
| Scope        | All 43 records in `data/poi/art-fairs/biennials/biennale_com.json`, category `art_fair` |
| File SHA-256 | `76608f73a5c939b187638d92a076975e84f473fdae1fff0e900d25066c2706a7`                      |
| Interval     | `2026-10-27T04:45:39.815Z` to `04:49:15.447Z`                                           |
| Terminal     | `succeeded`, exit 0, no signal or forced termination                                    |
| Verification | `requested_scope_verified`, `verified_at=2026-10-27T04:49:13.701Z`                      |

This was a new whole-file cohort, not a resume of the earlier two-record smoke.
An earlier chat/PR launch summary transcribed the run ID incorrectly; the value
above matches the durable job, terminal result, database, and execution journal.
The callback was received and reconciled with a fresh primary-checkout coordinator
snapshot. Maintenance is off; workers, source locks, admitted workers, local ingestion
processes, and claims were empty. Recorded supervisor and child PIDs had exited.

## Capture, artifacts, and publication

The saved 43-record baseline and current database were compared in a repeatable-read,
read-only transaction. All captured objects, observation IDs, research source points,
and canonical identities were preserved. Eleven normalizations changed; 41 geocode
artifacts, 36 embeddings, and 41 active canonical builds changed. All 43 active builds
use `canonical-build-v7`, including the two reusable builds.

| Stage     | Reused | Succeeded |
| --------- | -----: | --------: |
| Normalize |     32 |        11 |
| Geocode   |      2 |        41 |
| Embed     |      7 |        36 |
| Match     |     35 |         8 |
| Canonical |      0 |        43 |
| Verify    |      0 |        43 |

All 43 POIs are published and expose two distinct markers each: 86 cohort markers.
Detail-query evidence and every marker were checked against their owning active
build inputs. Legacy source-only members correctly supply source slots from their
captured coordinates without requiring a geocode artifact. Inferred slots retain
their independent owners and precision metadata. All eight global lineage checks pass.

The local HTTP list endpoint returned all 86 markers; detail endpoints for Venice,
São Paulo, Aichi, and Performa returned HTTP 200 and agreed with the SQL API helpers.
This receipt validates current data and API output; it adds no new browser visual check.
Equal-point and missing/legacy cases remain covered by the preceding regression suite.

Assessments are advisory: 39 `needs_review`, four `accepted`, zero `unlocated`.
None of those labels suppresses either candidate. Venue and edition claims remain
unverified; pipeline consistency is not geographic or editorial acceptance.

## Precision evidence and review cases

All 41 newly processed forward results retain their selected raw provider response;
the cache and immutable artifact copies agree. Thirty-nine use the existing `point`
fallback with an explicit warning. Performa and Prospect New Orleans are classified
as `city` from provider type. Venice and São Paulo reuse their exact prior geocode
IDs; their missing historical raw response/precision derivation stays explicitly legacy.
No metadata backfill or provider replay was forced for those two records.

The private `review-43.csv` contains source text, venue/edition claims, both displayed
points, ownership, query/result labels, separation, precision derivation, raw-response
availability, advisory reasons, and independent human review columns. Start with these
cases alongside an ordinary close pair:

| POI                             | Separation | Observation to examine                                |
| ------------------------------- | ---------: | ----------------------------------------------------- |
| Athens Biennale                 |  80.334 km | Forward provider type `rest_area`; fallback `point`   |
| Incheon Women Artists' Biennale |  30.678 km | Missing provider type, retained raw response          |
| Documenta                       |  18.899 km | Missing provider type, retained raw response          |
| Momenta Biennale                |  16.831 km | Forward provider type `hotel`; fallback `point`       |
| São Paulo Biennial              |   1.976 km | Reused legacy result; historical response unavailable |
| Venice Biennale                 |   0.710 km | Reused legacy result; both candidates still published |

No new capture, provenance, lineage, cache-reuse, or publication defect was demonstrated.
The separations and coarse/defaulted precision remain data-quality evidence. Review each
source point and inferred point independently, then venue and edition separately. Do not
convert those judgments into an ingestion/publication gate or silently correct source data.

## Complete provider ledger

| Provider / purpose             | Successful calls | Known estimated cost | Unknown-cost calls |
| ------------------------------ | ---------------: | -------------------: | -----------------: |
| LocationIQ forward (`geocode`) |               41 |                    — |                 41 |
| LocationIQ reverse             |               41 |                    — |                 41 |
| Jina embedding                 |               36 |                    — |                 36 |
| Fireworks normalization        |               11 |        $0.0078621875 |                  0 |
| Fireworks description fusion   |                7 |        $0.0012972500 |                  0 |
| Total                          |              136 |        $0.0091594375 |                118 |

Every call has HTTP 200, terminal success, attempt ownership, and matching journal
preflight/result IDs. No call remains started or failed. The known estimate is not
a total bill; the callback's normalization estimate excludes all other purposes.

## Decision and next candidate

Accept this file's structural completion. Keep imports and both heartbeats idle;
the owner authorized this file only. The queue now reports 43/43 normalized,
linked, verified, and complete. Historical operator notes saying “not yet imported”
are stale and do not override computed coverage.

The queue's first item is a historical Dyrt inspection, not a safe resume recipe.
Its pinned continuation failed with “Model busy, retry later” on 2026-09-20, uses
`hybrid-v3` / `locationiq-v1` / `matcher-v1` / `canonical-build-v1`, and references
the old `docs/poi` path. No worker remains. Preserve that separate repair scope;
do not blindly resume it. Biennial Association's 41 records are already normalized
and linked; 40 share current v7 builds, but only one has its own geocode artifact.
Its report-only queue action does not fill missing enrichment, nor do the missing
artifacts alone prove incorrect source-only output.

The proposed next ingestion scope is a three-record preflight of
`data/poi/art-fairs/biennials/biennial_foundation.json`. It is currently unstarted,
has 304 records, 100 supplied coordinate pairs, 98 concrete city values and two
`Various` city values; only 13 street addresses are populated. It exercises useful
missing/coarse evidence cases without confusing an old import with new work.
The first three records are Adelaide Biennial of Australian Art (`Various` city,
source point), AFiRIperFOMA Biennial (country only, no source point), and Aichi
Triennale (concrete city and source point).

After a fresh snapshot and explicit selection, the bounded candidate command is:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennial_foundation.json --category art_fair --limit 3 \
  --max-llm-requests 3 --max-cost-usd 0.10 --geocode-limit 6
```

This is a proposal, not a launched job or authorization for the remaining file.
Check source identity, retained empty fields, no fabricated source point, explicit
granularity of any country/city inference, independent marker ownership, cache
reuse, lineage, and the full provider ledger. A timeout requires diagnosis, not
chained samples. Decide on a new 304-record cohort only after that receipt.

Private evidence is retained in the primary checkout under
`lib/db-map/.ingest-jobs/precision-metadata-20261026/`: baseline, terminal audit,
43-row CSV, HTTP responses, queue/status snapshots, and the Dyrt inspection.
The actual job/result and execution journal remain in their UUID directories.
No raw diagnostic packet, provider response, or credential is committed.
