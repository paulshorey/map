# Biennial Foundation preflight — 2026-10-29

The human explicitly selected the three-record preflight from the
[Biennale completion receipt](biennale-refresh-receipt.md). It ran once on merged
main `7a4b552` and stopped at its documented 45-second deadline before downstream
validation. The human then approved the foreground continuation below, which
completed the same frozen cohort. **Structural acceptance passed; location quality
did not.** The full 304-record file stays on hold. Both ingestion heartbeats remain
paused.

## Continuation result — 2026-10-29

| Item      | Value                                                                       |
| --------- | --------------------------------------------------------------------------- |
| Code      | main `4c70d9f` (PR #68 merged)                                              |
| Command   | `ingest:run --resume ccb63ce7-… --max-llm-requests 2 --max-cost-usd 0.0994` |
| Execution | `63e9aeb6-23ad-4740-9556-414870335ec2`                                      |
| Interval  | `20:07:23Z`–`20:08:01Z` (about 40 s), exit 0                                |
| Result    | run `succeeded`, `requested_scope_verified`; all eight verify checks ok     |

The pre-launch control snapshot was quiescent with no claims; a `--dry-run` showed
the saved `limit: 3`, `geocodeLimit: 6` and the same file SHA. Final control is
quiescent with no workers or locks and maintenance off.

**What passed.** All three raw observations deep-equal their source objects.
Adelaide reused its first-execution normalization (`b4d3823a…`, no new request).
AFiRIperFOMA has `source_coordinates: null`; no source point was invented. Each
canonical keeps source and inferred values in separate slots with research,
normalization and geocode IDs, and every rendered location returns its marker.
Matching created Adelaide (`a522e1be…`) and AFiRIperFOMA (`b8335f0b…`) and merged
Aichi into the existing three-source canonical `7b37309b…` at 0.958 (correct).
The run ledger has 12 successful calls: 3 normalizations, 3 forward and 2 reverse
geocodes, 3 embeddings and 1 description fusion; estimated priced cost
$0.0020305 (geocode/embedding unpriced). The continuation normalizations took
4.5 s and 4.8 s, so the first execution's 41 s was a one-off, not a trend.

**What failed: every inferred point in the sample is wrong or coarse, and all
of them publish.** Each assessment is correctly `needs_review`, but assessments
are advisory and do not gate publication or canonical slot selection.

| Record       | Published markers                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adelaide     | Source `-25.2744, 133.7751` is Australia's country centroid, labelled `point` despite the model's `coordinates_country_centroid` warning. Inferred query `Various venues, Various, Australia` hit "Various Restaurants, Mill Park" (Melbourne), `point`. Neither is in Adelaide; 1,742 km apart. |
| AFiRIperFOMA | Only marker is Nigeria's country centroid from query `Nigeria`, labelled `city` (provider `administrative`/`boundary`).                                                                                                                                                                          |
| Aichi        | Query `Aichi Arts Center, Nagoya, Japan` hit "Center Street, Urayasu, Chiba", 274 km away, labelled `point`.                                                                                                                                                                                     |

**Regression on an existing POI.** Before this run, Aichi canonical build
`8af72e4f…` (2026-10-27) published biennale_com's inferred point from its street
address `1-13-2 Higashisakura, Nagoya` (`35.171876, 136.916736`, the arts center).
This run's build `096444bc…` replaced that inferred slot with Biennial
Foundation's Urayasu point. Per-slot canonical selection preferred the new
venue-name geocode over an existing street-address geocode.

No code reads the model's placeholder or centroid warnings
(`city_placeholder_value`, `coordinates_country_centroid`); they are stored only.
`captured_attributes_restored` put `Various` back into the forward query.
AFiRIperFOMA's `website_url` is the Biennial Foundation listing URL, not the
event's own site.

## Scope and identities

| Item              | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| File              | `data/poi/art-fairs/biennials/biennial_foundation.json`                                   |
| File SHA-256      | `b50165b2efa0342a24e264c8e647439cf0393955a6e8839ebc9b82d7d6df1e3c`                        |
| Category          | `art_fair`                                                                                |
| Frozen cohort     | Adelaide Biennial of Australian Art; AFiRIperFOMA Biennial; Aichi Triennale               |
| Job               | `e57b81bc-e394-46c4-9afe-af3899cdd73c`                                                    |
| Run               | `ccb63ce7-7c5b-45bb-a9a8-c612bde43879`                                                    |
| Execution         | `6cc254e9-def7-4c7a-860f-98a9001c5f14`                                                    |
| Interval          | `2026-10-29T19:22:09.147Z`–`19:23:04.478Z`                                                |
| Supervisor result | `needs_attention`, `wall_clock_limit`, exit 2; no forced kill                             |
| Database result   | `paused`, `SIGTERM`, current stage `normalize`, no fatal/execution error, no verification |

The pre-launch primary snapshot was quiescent, with maintenance off and no workers,
locks, admissions, local ingestion scripts, claims, or launch intents. The input
has 304 named records and 304 unique listing URLs. Those URLs supply stable record
identities through the existing generic extractor; no adapter change was needed
for this sample. Only three records were extracted into this run. The database's
partial file record count of three is not the physical file's total of 304.

The exact documented command was:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennial_foundation.json --category art_fair --limit 3 \
  --max-llm-requests 3 --max-cost-usd 0.10 --geocode-limit 6
```

## What completed

All three raw observations match their source objects exactly, including empty
fields, missing coordinate pairs, and the original country/locality text. The
three record identities match their distinct listing URLs. Adelaide's normalization
committed successfully. AFiRIperFOMA and Aichi remain pending normalization.

Adelaide's supplied `-25.2744, 133.7751` pair is preserved. The model returned
`city: null` and warnings `city_placeholder_value` and
`coordinates_country_centroid`. The existing resolver's captured-text fallback
retained `city: Various`; the research projection currently labels the supplied
pair as source/point. These are intermediate normalization observations, not a
verified venue point or a demonstrated final map result. Preserve the original
evidence and inspect how the warnings, coarse location, and placeholder text flow
through geocoding and publication before judging this source ready.

AFiRIperFOMA still has no supplied coordinates; none were fabricated. Aichi retains
its supplied point and `Nagoya` text. None of the three has a geocode, embedding,
active membership, or canonical publication from this source. No downstream,
map-marker, cache-resume, or lineage acceptance was established by this attempt.

## Timing, providers, and stopping

One Fireworks normalization request succeeded with HTTP 200. Its ledger call
`c141d4d2-ce80-4dc4-a2f6-9dc4c13df752` matches the execution journal and attempt.
The model remained `accounts/fireworks/models/glm-5p3-flash`, requested service tier
`priority`, with 256 reasoning tokens. Recorded provider latency was 40,965 ms;
the whole normalization attempt took about 47.35 seconds, including other work.
Usage: 1,404 prompt tokens, 540 completion tokens (including reasoning), estimated
cost **$0.00060075**. No geocoder, embedding, matching, or description-fusion call
was made. No call remains started or failed. One successful slow request does not
establish a systemic provider outage or support a whole-file cost/time estimate.

The supervisor sent SIGTERM at `19:22:54.293Z`, its 45-second deadline. The in-flight
normalization finished and committed during the grace interval; the execution
recorded `paused` at `19:23:03.100Z`. No forced termination or process-level retry
occurred. The supervisor and worker PIDs were absent afterward. Standard controls
at `19:23:38.418Z` confirmed quiescence, maintenance off, and zero workers, source
locks, admissions, and local scripts. No schedule or model changed.

## Decision before the full file

**Still hold the 304-record launch** (updated after the continuation). The file
has 204 records without coordinates and 13 with street addresses, so most of its
markers would be venue/city/country forward geocodes like the three above, and
merges can overwrite better inferred points already published by other sources.
Fix location handling first, then reprocess these three records and confirm the
Aichi canonical's Nagoya inferred point is restored:

1. Canonical inferred-slot selection must not replace a street-address or
   assessment-accepted candidate with a weaker `needs_review` one.
2. Forward queries must drop placeholder locality text (`Various`, `Various venues`).
3. A forward result whose city or region contradicts the listed city should be
   rejected or retried with a locality-only query (`Nagoya, Japan`).
4. Country-only results and known country-centroid source points need a `country`
   precision, and the product must decide whether country-precision points publish.

The original 2026-10-29 analysis follows; its continuation recipe is now done.

**Hold the 304-record launch.** The timing boundary prevented the intended semantic
and downstream checks; it did not demonstrate a failing provider response. The
file contains 100 supplied coordinate pairs, 204 missing pairs, 98 concrete city
values, two `Various` values, and only 13 populated street addresses. The two
unprocessed sample records are therefore important coverage, not optional extras.

The recommended next operational decision is an explicitly supervised continuation
of **this same frozen three-record run**, reusing Adelaide's successful artifact,
with a completion strategy that accommodates the observed provider latency. The
smoke interface rejects resumes; do not simply repeat its original new-run command
or increase its maximum deadline beyond project policy. No continuation has been
launched. The generated remaining-normalization-budget foreground recipe is:

```sh
pnpm --filter @lib/db-map ingest:run \
  --resume ccb63ce7-7c5b-45bb-a9a8-c612bde43879 \
  --max-llm-requests 2 --max-cost-usd 0.09939925
```

This is a resume of three records only. The geocoder cap and original cohort stay
in the saved run options. Request/cost flags constrain normalization, not all
provider purposes. A background continuation must use the project's approved
supervisor/ownership/completion workflow from the runbook; the foreground recipe
alone is not an unattended completion strategy. Reconcile fresh jobs, workers,
locks, and launch intents before any continuation.

Before choosing a new whole-file cohort, verify missing/coarse location semantics,
no fabricated source point, provenance of each displayed point, advisory assessments,
matching/publication, cache reuse, lineage, full provider accounting, and process
exit. Assess Adelaide's placeholder/centroid handling separately from preserving
its captured evidence. If those checks pass, select a **new 304-record run** with
`--unlimited`, one file at a time; resuming this smoke can never expand its cohort.
Keep geographic truth/filtering decisions separate from structural acceptance.

Private evidence: primary checkout
`lib/db-map/.ingest-jobs/biennial-foundation-preflight-20261029/` holds the source
baseline, launch intent, status/control/process receipts, and read-only audit.
The authoritative job/result and execution journal remain under their UUID paths.
Raw provider responses and diagnostic traces are not committed.
