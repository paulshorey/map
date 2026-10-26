# Biennale.com location preflight — 2026-10-26 UTC

The advisory correction is integrated, the additive migration is applied, and
the Venice / São Paulo smoke succeeded. Full imports and both scheduled ingestion
heartbeats remain held. The primary checkout is clean on main `1d5e7e8`.

## Code, migration, and scope

#64 merged into #63 as `4ee2088`; #63 merged into main as
`1d5e7e8f4511450da387130a0e473903ab3adc2a`. Fresh PostgreSQL 18 migrations,
package types/generated API contract, and 166 regression tests passed, with
one optional legacy SQL sampling test skipped. Providers are forbidden in the
integration fixture. Location CI, both previews, and exact-head Codex reviews
passed. The regression covers conflicting/equal points, legacy source-only
publication, unlocated records, cache ownership, and completed-rematch cleanup.

Applied `202610252200__versioned_location_assessments.sql` at
`2026-10-26T04:01:09.057Z` under owned, quiescent maintenance. It was the only
pending migration; no checksum mismatch existed. Immediately afterward there
were zero assessments, 46,090 research records, and 40,898 published canonicals.
The migration changed neither POI count and performed no historical backfill.

The post-migration coordinator snapshot reconciled 54 terminal jobs, zero
claims, workers, source locks, admitted workers, or local ingestion processes.
The owned maintenance gate was released for this exact smoke:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennale_com.json --category art_fair --limit 2 \
  --max-llm-requests 2 --max-cost-usd 0.10 --geocode-limit 4
```

| Receipt | Value |
| --- | --- |
| Job | `d0fb5b62-e856-46cb-acce-7765c08cc607` |
| Run | `4dcf935e-4bf6-4af9-bed5-004dcaef0398` |
| Execution | `e95ded29-1d30-465d-b147-05c906b11681` |
| Interval | `04:02:07.777Z`–`04:02:34.866Z`, about 27 seconds |
| Terminal result | `succeeded`, exit 0, no signal/forced termination |
| Verification | `requested_scope_verified`, `verified_at=04:02:33.234Z` |

The file has 43 records. Exactly its first two records were frozen into the new
cohort. Final control confirmed quiescence with maintenance off; the recorded
supervisor/child PIDs had exited. Both heartbeat automations remain `PAUSED`.

## Evidence and output

| Check | Venice Biennale | São Paulo Biennial |
| --- | --- | --- |
| Research ID | `f96b855c-cb8f-4566-903b-cc5d1c41a525` | `0f4d6d6c-43da-4a96-8b36-765c8a2859fa` |
| Canonical ID | `9ee28140-a256-4981-94a5-9cc8c5b61fc5` | `529fe6b2-b1d1-4669-a6cd-7749d8d78bcd` |
| Source lat/lng | `45.433, 12.3597` | `-23.5874, -46.6576` |
| Inferred lat/lng | `45.4346809, 12.3509152` | `-23.570533, -46.663713` |
| Separation | `710.495 m` | `1,976.285 m` |
| Assessment | `needs_review`, candidates disagree | `needs_review`, candidates disagree |
| Geocode / embedding | Both reused unchanged | New geocode and replacement embedding |
| Normalization | Reused unchanged | Reused unchanged |
| Canonical | Published, `canonical-build-v7` | Published, `canonical-build-v7` |
| Actual HTTP list/detail output | Two markers, one POI identity | Two markers, one POI identity |

Raw captured objects were deep-equal before/after. Observation, normalization,
and canonical identities stayed unchanged. Original address/country text,
venue names, dates, and edition years remain in the observations: Venice lists
Giardini and Arsenale / 2024; São Paulo lists Ciccillo Matarazzo Pavilion / 2023.
These remain source claims, with venue and edition explicitly unverified.

Canonical source slots belong to the existing `biennial_association` members;
inferred slots belong to `biennale_com`. This is the existing independent
selection per slot across members. Both sources retain their observations.
All four member assessment IDs and exact normalization/geocode identities
appear in the two active builds' input rows. Every displayed evidence owner matches
those inputs. Both named-slot candidates remain accessible; none was corrected.

Local HTTP detail and bbox endpoints returned 200, with distinct `:source` /
`:inferred` marker IDs sharing a canonical ID. SQL API helpers agreed. All eight
lineage checks passed. Browser inspection also showed São Paulo's separate
markers; clicking either retained the same POI drawer with both labeled locations.
Equal/missing/legacy cases are isolated regression
evidence, not additional live-provider cases or a historical database backfill.

## Provider ledger

| Provider / purpose | Calls | Record | Recorded cost estimate |
| --- | --- | --- | --- |
| LocationIQ forward | 1 | São Paulo | Unknown |
| LocationIQ reverse | 1 | São Paulo | Unknown |
| Jina embedding | 1 | São Paulo | Unknown |
| Fireworks description fusion | 1 | Venice | `$0.0002111875` |

All four calls have terminal success, HTTP 200, and attempt ownership. Their IDs
exactly match lifecycle-journal preflight/result records; no call remains started.
The Fireworks operation is named `match` because its containing attempt rebuilt
the canonical. This was description fusion, not a new LLM match decision. Both
match tasks reused memberships. Normalization made zero requests. Its budget
flags do not cap other provider paths. The known estimate is not a total bill.

## Evaluation and next scope

Compare source text and each point independently, following query/result and
build ownership. Keep venue, entrance, recurring event, and edition judgments
separate. Pipeline consistency does not establish geographic truth or require
either point to be accepted before ingestion/publication continues.

São Paulo's forward query was `Av. Pedro Álvares Cabral - Ibirapuera Park,
São Paulo, Brazil`, filtered to BR. The result label is `São Paulo, Sao Paulo,
Sao Paulo, Brazil`; provider class/type are null, while the parser defaults to
`precision=point`. The 1.98 km separation and generic label warrant examination.
A narrow next engineering scope is explicit precision-derivation provenance /
missing-metadata diagnostics with a saved-response regression. Preserve both
points and existing paid query caches; introduce no acceptance gate. This is a
metadata gap, not proof that either coordinate is wrong. Purpose-specific LLM
operation labels would also make future provider ledgers easier to interpret.

The queue already has all 43 Biennale.com records normalized and linked; its
“not yet imported” operator note is stale. After the metadata follow-up, the next
useful ingestion scope is a deliberately selected whole-file refresh of these
existing 43 records, reusing exact caches and filling missing/stale artifacts.
The queue's report-only recipe does not populate current geocoding on the other
41 records. Reconcile jobs/claims/workers/locks and current queue again before
launch. Use a whole-file cohort; never resume this two-record cohort as the rest
of the file. No full-file launch or schedule restart is authorized by this receipt.

Private evidence remains in the primary checkout's ignored
`lib/db-map/.ingest-jobs/biennale-preflight-20261026/`, the job UUID directory,
and the execution journal. It includes captures, before/after counts, prelaunch
snapshot, complete validation JSON, HTTP responses, provider reconciliation,
terminal result, logs, and final control. No raw diagnostic packet is committed.
