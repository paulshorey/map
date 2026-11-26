# Ingestion next decision

## November 24 safe MusicBrainz cache refresh

[PR 106](https://github.com/paulshorey/map/pull/106) still fails Kody's check
because the Anthropic provider reports exhausted credits or a billing limit.
The merge helper also reported no qualifying review on the pushed head.
The queue is stopped and maintenance is off.

An isolated replay of the pushed head failed before extraction with
`outdated_data`: its global move from `location-v10` to `location-v11`
made the existing MusicBrainz source fail the staleness guard. A cleanup would
discard successful artifacts across the source. Keep `location-v10` for
unaffected records. The local follow-up `b352253` invalidates the old linked-venue
rejection and binds the refreshed result to a specific policy. It promotes
the confirmed point over an earlier inferred city marker. The query cache,
normalization, embedding, and existing membership remain reusable.

The follow-up replay corrected and published Hamilton in private fixture run
`12215b17-1c03-46b6-ae9a-5ab8f1440356`. A repeat run
`1ee87b5f-0762-4b08-99c9-842c7704a69e` reused the geocode and verified the
same record. Both completed with zero provider calls. The map query returned
one POI and one marker at `[175.287484, -37.792338]`. Receipts are private
under `~/.local/state/map-ingestion-diagnostics/rollout.oScgrh/`.

When review-provider access is restored, publish the scoped follow-up and land
it after review. Run the shared Hamilton smoke with the cached accepted and
rejected responses before resuming the saved whole-file queue. Retain the
paused earlier smoke journal.

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 60 -- \
  data/poi/music-festivals/apis/musicbrainz_festivals_01_of_16.json \
  --category music_festival --record 512acc4a-d123-4347-9e19-4e4d6c100a00 \
  --from geocode --max-llm-requests 0 --max-cost-usd 0 --geocode-limit 0
```

Verify the exact map marker and requested scope. Refresh inventory and confirm
shard 1 is first, then resume queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4` as
described in [agent operations](../data/ingestion-agents.md#whole-file-imports).

## November 24 held capture and queue audit

The stopped queue has 16 finished entries and 40 pending. The pending entries
account for the partial v2 MusicBrainz shard and 39 unstarted captures. The 69
ready-to-verify files are outside the remaining queue. Seven unstarted inventory
rows are also outside it. Four are missing historical test fixtures. The three
real captures are MusicBrainz shard 16, RIDB facilities with addresses, and The
Dyrt RV campgrounds. Confirm the disposition of the fixture rows before building
a follow-on plan. Recompute inventory after the queue finishes, since canonical
updates can change verification eligibility. The 79 excluded rows remain outside
the plan.

The offline review covered all 15 held captures. These are proposed treatments.
The inventory hold remains in force while their source-specific criteria are
validated.

| Held capture | Observed evidence and disposition |
| --- | --- |
| Ireland events | 475 located records include 423 generic events, 51 festivals, and one market by the source's labels. The mix includes screenings and exhibitions. Hold for an event-type filter before trying the art-fair category. |
| Critical Stages festivals | 198 of 241 have a city and country. The row review accounts for all 43 gaps, with 36 cited locality recoveries, four ambiguous records and three page elements to exclude. Validate the curated candidate and its category on a bounded sample. [Row review](../data/poi-research/reviews/critical-stages-guide.json) |
| OSM botanical gardens | 827 of 3,421 have valid coordinate pairs. Recapture way and relation centers while preserving typed OSM identity, then validate places with poor locality evidence. |
| Wikidata botanical gardens | 3,916 rows become 3,665 QIDs. 167 QIDs repeat and 59 repeated QIDs have different coordinates. Group by QID with explicit conflict handling before an import. |
| Bandsintown festivals | 29 dated 2025 occurrences have location text, 23 name a venue and 15 carry a Bandsintown ID. Candidate for a bounded historical occurrence test with attention to duplicate event names and rows without IDs. |
| Setlist.fm festivals | Only 10 of 26 supply a year and venue data. Use the other series entries as supporting evidence and test the located editions separately. |
| Bandwagon Asia | 41 rows have city and date text. 15 cite the same concerts and gigs guide, and only 14 carry venues. Filter concerts from festivals and retain the event-level citation when available. |
| GetFestiWise | All 103 have location and a recurring month. None has a dated occurrence or item-specific URL in this capture. Use it as series-level discovery evidence pending provenance and locality checks. |
| World Festival Directory | All 103 have locality, but the source mixes film, sports, cultural, music and other events. Split by supported category before a bounded validation. |
| Ticketmaster art events | 77 event IDs and 76 coordinate pairs are present. The query combines art fairs, galleries, exhibitions, festivals and general arts listings. Validate the event type from the records before admitting an art-fair subset. |
| Wikipedia country music festivals | Nine of 42 rows have structured locality and 33 use prose. Validate a structured subset against its linked entries and keep the prose as supporting evidence. |
| Wikipedia festival name index | All 830 article URLs occur in the richer Wikipedia capture. Treat the index as supporting evidence and test only the richer capture for admission. |
| Wikipedia festivals | 830 entries have article URLs, 476 have QIDs and 165 have coordinate pairs. The list calls 21 defunct and uses “Various” for 17 city fields. This is the first held music-festival candidate to pilot after checking duplicate, inactive, and non-specific locations. |
| OSM caravan sites | 56,157 typed records include 9,665 blank names. The unnamed records include private, restricted, disused and proposed examples. Test the existing eligibility policy on a bounded sample before any full file run. [Unnamed campground policy](../data/poi-ingestion.md#nameless-places) |
| US Campgrounds historical CSV | 13,011 coordinate-bearing rows have only 5,711 distinct nonempty codes and two blanks. Define source identity, distinguish the state field from export region, and validate historical access and amenities before a bulk import. |

## November 24 queue recovery and rollout checks

PR 105 review found that compact repairs rejected bracket-notation JSON paths
before resolution. Commit `ec05cc7` parses and validates both spellings, then
passes canonical paths to normalization and preserves the original response in
the audit. All 31 focused tests, the map build, Codex review, and other GitHub
checks passed. The PR remains open because Kody's configured Anthropic account
returned a credit/billing-limit error.

Shared v2 Hamilton smoke `6a660012-38d5-4dd1-b079-effa98805ebc` projected
the address and rejected 1/657 Victoria Street. It also rejected the named
Meteor Theatre point because LocationIQ used Hamilton Central for the district
and Hamilton City for the enclosing city. The record kept the city marker.
The 45-second smoke stopped after matching, with canonical and verify tasks
pending. [PR 106](https://github.com/paulshorey/map/pull/106) accepts this paired
locality evidence with the linked name and same country. Its focused tests and
a replay of the two exact recorded provider results passed. Roll out the
reviewed change under managed maintenance before the next shared check:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 60 -- \
  data/poi/music-festivals/apis/musicbrainz_festivals_01_of_16.json \
  --category music_festival --record 512acc4a-d123-4347-9e19-4e4d6c100a00 \
  --reprocess normalize --max-llm-requests 3 --max-cost-usd 0.10 --geocode-limit 4
```

Check precise named-venue coordinates and scope verification. Refresh inventory,
then resume queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4` from the primary
checkout. Its first pending entry is shard 1. It needs whole-file v2 coverage
before shard 2. Keep the v1 completion receipt. The queue had 16 finished and
40 pending entries at inspection. The dedicated PostgreSQL session held the
queue's presence lock. The journal recorded a disconnect and a timeout while
it waited for the independent worker. The 12 current read-only connectivity
trials passed. The underlying cause of the old disconnect is still unknown.

Refreshed inventory counts 42 complete, 69 ready to verify, one partial v2
shard, and 46 unstarted among 158 intended captures. Use report-only
verification for files whose artifacts are current and schedule it after
overlapping canonical rebuilds settle. Reconcile the saved queue against the
full inventory before creating a follow-on batch, and review the 15 held
captures separately from 79 intentional exclusions. Private receipts are under
`~/.local/state/map-ingestion-diagnostics/continue.MHVMXU/`.

## November 24 MusicBrainz v1 completion

Shard 1 run `0ec91c90-02ab-4b54-b9be-f0e3f1d80d63`, execution
`b16966fa-0fac-49f7-8b0d-5d67576aa9fa`, succeeded at 06:58 CST.
Inventory verified complete coverage for the 2,000-record extractor v1 file.
The saved queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4` lost its
PostgreSQL lock session while waiting for the standalone worker. Queue status
reconciled the interrupted journal to stopped at shard 1. The worker continued
to completion. No other worker or queue held admission at inspection.
The BGCI-only retry in [PR 105](https://github.com/paulshorey/map/pull/105)
was absent from the worker's checkout and was not needed for the MusicBrainz run.


[PR 104](https://github.com/paulshorey/map/pull/104) merged as `772cb89`.
The final address regression accepts house number 8 for Sala Albéniz and
rejects 99. It also covers standalone postal codes and matching long house
numbers. All 92 focused tests and the map build passed. Local `main` advanced
under owned maintenance, and admission reopened. The next v2 MusicBrainz run
needs a fresh scope. Verify the Hamilton record on the shared pipeline before
restarting the stopped full-file queue, following the rollout steps below.

## November 24 BGCI repair and publication check

At 01:37 CST, MusicBrainz shard 1 remained in normalization on execution
`b16966fa-0fac-49f7-8b0d-5d67576aa9fa` with a current heartbeat and its
source lock. Queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4` was waiting for
that worker. [PR 104](https://github.com/paulshorey/map/pull/104) is under
independent review. The primary checkout remains on v1.

[PR 105](https://github.com/paulshorey/map/pull/105) implements the BGCI retry.
One live repair each on pinned gardens 3903 and 3942 succeeded after replaying
their first-pass truncations. The prompts used 2,801 and 3,230 tokens, and all
78 model evidence paths resolved. The successful 3637 control replay used zero
network calls and produced the same 34 attributes. All six historical packets
retained their 48 mapped values in the projection. The retry omits 51–63 other
survey questions per garden, which stay in the immutable capture.

The isolated PostgreSQL run for 3903 recorded both requests and the repair link.
The first downstream match stopped because the fixture lacked taxonomy rows.
After seeding the fixture taxonomy, run `778f785f-49eb-4a13-8d43-655f37a45e69`
verified its one-record scope. The published Prague Botanical Garden has 47 hectares,
400,000 annual visitors, 105 staff and the explicit Accessibility policy topic.
Private audit evidence is in `~/.local/state/map-ingestion-diagnostics/bgci-retry-v1.BNulT5/`.
The fixture server was shut down. The six shared exclusions are still in place.

At the next verified file boundary, follow the [maintenance and admission procedure](../data/poi-ingestion.md#process-control-and-maintenance)
for reviewed worker changes. After restoring admission on the intended checkout,
start a fresh, bounded run for one excluded garden. This is a future rollout
command for the new code, distinct from resuming an old excluded run.

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/botanical_gardens_data/bgci_gardens_full.json --category botanical_garden \
  --record 3903 --reprocess normalize --stop-after normalize \
  --max-llm-requests 2 --max-cost-usd 0.04
```

Check the request linkage, source evidence and active normalization before the
downstream one-record publication check. Use the remaining five as a separately
reviewed cohort after that first shared result. Keep the older BGCI verification
backlog separate from record normalization recovery.

## November 24 venue and garden experiments

At 01:14 CST, the overview showed one confirmed v1 MusicBrainz worker holding its
source lock. The saved queue was waiting for this run. IDs and same-run recovery
details are below. The experiments used isolated storage and left admission open.

[PR 104](https://github.com/paulshorey/map/pull/104) adds MusicBrainz extractor v2.
Across 16 files and 30,276 records it preserves the event IDs and recovers addresses
for 1,682 events at 575 distinct linked places. Shard 1 accounts for 54 events.
An isolated managed run published Hamilton's Meteor Theatre about 13 m from the
pin linked by the [city council](https://hamilton.govt.nz/community-spaces/finding-and-booking-a-community-venue/detail/meteor-theatre).
The source lists 1 Victoria Street. The provider's 1/657 Victoria Street response
remains rejected evidence. The map query returned one marker; repeat verification
used zero provider calls. Private local receipts are under
`~/.local/state/map-ingestion-diagnostics/musicbrainz-venue.Wt7YMD/`.

**Rollout.** Keep the existing run and queue on v1. After the PR is reviewed, use
a verified file boundary and [managed maintenance](../data/poi-ingestion.md#process-control-and-maintenance)
to change the worker checkout. Check the active queue entry and lock ownership immediately before
rollout. A changed extractor produces a new file version. Start with a fresh
one-record v2 Hamilton run before authorizing a whole-file rerun. Retain the v1
verification evidence and check for duplicate observations and map markers.

**BGCI.** All six excluded gardens parsed on one paid shadow call each after
omitting the large raw survey dictionary. All 48 mapped fields survived and 108 of
109 evidence references resolved. A second, selective projection retained 47 hectares,
400,000 annual visitors and the accessibility policy topic on garden 3903; all 18
references resolved. On a previously successful control (3637), the selective
projection lost 20 prior attributes beyond a renamed area field. Keep the normal
success path. The next experiment is a versioned compact retry triggered only by
completion-token exhaustion, carrying selected survey evidence and validating its
references. Before reopening the six exclusions, compare each result with its
saved source evidence and account for any dropped fields. Keep the 405 stale BGCI verification proofs separate.
Private comparison receipts are under `~/.local/state/map-ingestion-diagnostics/bgci-projected.fH3XSu/`.

## November 24 recovery on the new host

The original 2,000-record MusicBrainz run `0ec91c90-02ab-4b54-b9be-f0e3f1d80d63`
resumed under job `14a0dac4-85bd-4e16-8660-f3d58336e118`, execution
`b16966fa-0fac-49f7-8b0d-5d67576aa9fa`. At handoff the reconciled overview
confirmed one worker with its source lock. Queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4`
held its presence lock and was waiting for the standalone import. It checks coverage
before advancing to shard 2. Maintenance is off. Use the [live overview and queue
triage](../data/ingestion-agents.md#inspect-ingestion-status) for subsequent status.

The capture SHA-256, extractor and checkpoint versions matched. Three one-record
smokes reached the requested stop after embedding. The Austin run
(`72ed031d-b022-4d2e-923b-36182c528ba2`) retained the venue's source coordinates.
The Hamilton run (`d1c8b785-2608-4dfd-9fed-09489e2ca6cc`) reused a city-level
forward result. Castle Ashby (`116bdc20-b22f-44d2-ac99-7bca531d4255`) exercised
live Fireworks, LocationIQ and Jina calls, all HTTP 200. The earlier scheduler
checkout failed while other acquisitions succeeded during its wait. These checks
support a supervised same-run recovery. The underlying historical connection stall
is still unexplained.

**Verification backlog.** All 70 files examined had a compatible whole-file
verification followed by newer canonical builds. None showed newer record-level
normalization, geocode or embedding artifacts. Their combined verified-record
shortfall was 2,088. A provider-free `--from report` run on the one-record NYC
Village Halloween Parade capture (`a8c85dfc-8617-4b8e-80cd-fc3b03f52940`)
restored 1/1 whole-file coverage. After the inventory refresh, the 158 intended
imports included 43 complete, 69 ready to verify, one partial and 45 unstarted.
The new RIDB address capture was indexed. Four historical test fixtures are
missing and none belongs to the saved queue.

**BGCI.** Later canonical builds account for 405 gaps among 3,649 records. Six
separate normalization exclusions each exhausted both the 2,056- and 3,856-token
completion allowances. An offline comparison of all six saved initial request
packets found that omitting only the unprojected `raw.attributes` dictionary
reduces serialized record input by 69–80% while retaining the mapped captured
attributes. Test this on one excluded garden with a shadow normalization and
compare its structured output and cited evidence before changing the profile or
reopening exclusions. Schedule wider verification after overlapping imports settle.

**MusicBrainz location precision.** Hamilton's point is labelled city-level even
though the raw venue relation has a street address. In shard 1, 54 records have
a nested place address, no top-level address and no complete top-level coordinate
pair. A source-specific extraction experiment should distinguish venue relations
from other linked places and preserve their provenance. Assess that change against
a new capture version before reprocessing the existing cohort.

## November 24 pre-recovery diagnosis

The reconciled snapshot showed zero workers and source locks, with maintenance off.
Queue `ba777d1a-c51b-4c79-8eb4-d650ba5380a4` is stopped at the first MusicBrainz
festival shard. It recorded 16 successes and has 39 entries after the blocked file.
The [backlog plan](../data/import-plans/backlog-20261116.json) is a dated source selection.
Use the saved queue and current inventory for continuation.

MusicBrainz run `0ec91c90-02ab-4b54-b9be-f0e3f1d80d63`, execution
`92d7702d-7f90-4d26-9796-ad410a066cc1`, extracted all 2,000 records and froze
that cohort. It recorded 1,172 successful normalization targets and 547 successful
verification targets before failing on a PostgreSQL pool checkout timeout. The
checkout telemetry identified a wait timeout; it does not establish pool saturation.
An embedding attempt also saw a timeout, so correlate the database and provider
events before attributing it to Jina. Follow the [connection diagnosis procedure](../data/poi-ingestion.md#database-connection-acquisition-evidence).
On the new host, all 12 acquisitions in the read-only connection probe succeeded,
including the two idle-expiry checks. The saved file hash and managed pipeline
versions match the current checkout. The probe did not exercise a long-running
import or provider traffic.

The failing checkout originated in the scheduler's run-status update
(`runRecordScheduler` in `lib/db-map/scripts/ingest/record-scheduler.ts`).
It waited 10,001 ms. The pool reported 6 total connections, 1 idle and 1 waiting
at the request, and 7 total, 5 idle and none waiting at failure, against a maximum
of 16. Use this call site and the private execution journal as the baseline for
the bounded check. The database and scheduler regression suites passed on the new host.

Prioritize a bounded scheduler check that exercises normalization, geocoding and
embedding on representative MusicBrainz records. Before a full continuation, verify
the saved capture and pipeline compatibility. The queue's continuation guard requires
an operator recovery for this failed run. Once the cause is addressed, use the
status-reported same-run command, verify current whole-file coverage, then resume
the saved queue. The review did not launch an import or change queue state.

The inventory showed 42 complete captures, 70 ready to verify, one partial and 44
unstarted among 157 intended imports. Review the cause of the verification gaps
before choosing a bulk replay. BGCI is the dashboard's highest-priority inspection
item. Keep its normalization exclusions separate from record verifications that
became stale after later canonical rebuilds.

## Follow-up from the 2026-11-18 audit

The [November 5 reset](data-reset-20261105.md) was followed by re-imports starting November 16.
The [November 16 backlog plan](../data/import-plans/backlog-20261116.json) records that day's
selection. Use [agent status triage](../data/ingestion-agents.md#inspect-ingestion-status)
for current queue, coverage and classifications.

- **Critical Stages** originally stopped at extraction. The merged repair preserves
  both Zagreb listings and records a disposition for the 43 rejected rows. Three
  later bounded runs reached requested-scope verification. The capture still needs
  category and publication review before a whole-file import. See the
  [repair plan](critical-stages-repair.md).
- **BGCI** reached run-level verification after six truncated normalizations were explicitly
  excluded. Each request hit its completion cap in both the initial call and the repair
  (2,056 and 3,856 tokens including the reasoning allowance). Try a smaller input or repair
  prompt on a bounded sample. Later shared-canonical builds separately invalidated some
  record verifications.
- **Campgrounds** need an inventory refresh to index the merged RIDB address capture.
  The Dyrt has no post-reset run in the audited inventory. [Offline reverse lookup](https://github.com/paulshorey/map/pull/89)
  has merged. Estimate remaining forward lookups before queueing it.

## Earlier decisions (superseded)

The holds and run directives below describe the October decisions. Use the current queue,
coverage and classifications for operational decisions.

### Decision — 2026-10-29, after continuation

PR #68 merged as `4c70d9f`. The human approved the foreground continuation of run
`ccb63ce7…`; execution `63e9aeb6…` finished in about 40 s with
`requested_scope_verified`. Capture fidelity, slot provenance, normalization
reuse, matching, lineage, ledger and process exit pass. Location quality fails:
all three inferred points are wrong or country-level, Adelaide's source point is
a country centroid labelled `point`, and the rebuild replaced the existing Aichi
Triennale canonical's correct Nagoya inferred marker with a point in Urayasu,
Chiba. See the [preflight receipt](biennial-foundation-preflight.md#continuation-result--2026-10-29).

Hold the 304-record import until location handling is fixed (inferred-slot
selection, placeholder queries, city-contradiction checks, country precision)
and these three records are reprocessed. Both heartbeats stay paused.

### Decision — 2026-10-29, after preflight

The human closed PR #61 without merging and explicitly selected the proposed
three-record Biennial Foundation preflight. Its one documented 45-second smoke
extracted the intended cohort, committed Adelaide's normalization, and stopped
gracefully at the deadline before geocoding or downstream validation. See the
[preflight receipt](biennial-foundation-preflight.md) for exact identities, provider
accounting, intermediate data findings, and verified process exit.

Hold the full 304-record import. The next recommended decision is a supervised
continuation of the frozen three-record run with suitable completion ownership;
no continuation or new full cohort has launched. Both ingestion heartbeats stay
paused. This section supersedes the unstarted-preflight statement below.

### Decision — 2026-10-26 CT

PR #66's precision metadata implementation and the authorized 43-record Biennale.com
refresh are complete. The fresh [terminal receipt](biennale-refresh-receipt.md)
reconciles raw captures, both-point API output, artifact ownership, lineage, cache
reuse, provider costs, and worker/lock exit. All 43 POIs publish 86 markers;
39 advisory `needs_review` assessments do not block publication. Both heartbeats
remain paused, and no further import is launched.

The next proposed source is a three-record Biennial Foundation preflight covering
supplied coordinates, `Various` city text, and country-only missing-location data.
Its 304-record file is unstarted; this proposal does not authorize a full run.
See the receipt for readiness, bounded command, and acceptance criteria. The
historical Dyrt continuation requires a separate repair decision; already-imported
Biennial Association output must not be mistaken for a new capture.

## Authorized follow-up — 2026-10-26 CT

The owner authorized implementing precision metadata and running a new 43-record
Biennale.com whole-file refresh after review/validation, with both heartbeats
remaining paused. See [implementation and launch plan](location-precision-metadata.md).
The older full-import hold below is superseded only for that single file; the
completed two-record cohort remains separate and must not be expanded.

## Completed — 2026-10-26 UTC

The preflight below is complete. PR #63, including #64's completed-rematch fix,
merged as `1d5e7e8`; the additive assessment migration is applied. Venice and
São Paulo each publish two markers while their assessments remain `needs_review`.
See the [exact receipt and next scope](biennale-location-preflight.md).
Both ingestion heartbeats remain paused and no full-file run was launched.
The queue already has all 43 Biennale.com records normalized and linked; its
old “not yet imported” note is stale. Do not resume the two-record smoke as
the rest of the file or repeat it merely because the original plan follows.

## Original preflight plan (completed)

PR #62 merged into main as `88bf967`. It did not merge into PR #61. PR #61
remains the open note at `e488974`, and its “leave publication unchanged until
after the preflight” sequence is stale.

The #62 merge was a product mistake. Its assessment history is worth keeping.
Its requirement that a location be `accepted` before matching, publication,
consolidation, or checkpoint reuse is not. Venice’s source and inferred points
are about 710 m apart, so that policy would quarantine the one live record that
already has both slots.

### Contract at the time

`source_coordinates` and `inferred_coordinates` stay the two provenance slots.
Assessments stay immutable and advisory. `evidence.distance_m` is stored
whenever both points exist. `matcher-v3` uses the stored research point.
`canonical-build-v7` publishes both markers when the points differ, keeps both
evidence records when they are equal, and does not block a usable source point
for missing inferred, reverse, or country text. A record with no plottable
point remains unpublished, with assessment status `unlocated` and its raw text
intact.

### Historical preflight command

Apply the additive assessment migration, then run the two-record Biennale.com
preflight from the primary checkout. Start with:

```sh
python3 scripts/coordinator-ingestion.py snapshot
```

Reconcile jobs, claims, workers, and locks before:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennale_com.json --category art_fair --limit 2 \
  --max-llm-requests 2 --max-cost-usd 0.10 --geocode-limit 4
```

Acceptance is capture fidelity, evidence ownership, both-point rendering,
lineage, cache reuse, a complete provider ledger, and a released worker and
lock. Unchanged geocoding and normalization should reuse their caches. A
canonical rebuild can still call description fusion, and embedding and matching
have their own provider paths. The normalization request and cost flags are not
a total spending cap. Human venue judgments are not a prerequisite. Do not
resume the two-record cohort as the rest of the file.

This cloud checkout’s coordinator snapshot still rejects the tokenized origin
URL, so the launch belongs on the primary checkout.
