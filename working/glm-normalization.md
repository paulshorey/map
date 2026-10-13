# GLM normalization rollout

Requested 2026-10-13: replace Fireworks DeepSeek with GLM 5.3 Flash after the bounded
comparison showed lower normalization latency and cost. The implementation branch
is `codex/glm-normalization`, based on the active scheduler fixes in PR #40.

## Implementation

- Shared Fireworks model: `accounts/fireworks/models/glm-5p3-flash`.
- Thinking cap: 256 tokens; normalization final allowance: 1800 (2056 total).
- Keep strict structured output, bounded repair/fallback, provider recovery,
  cancellation, request journaling and shared concurrency controls.
- Source primitive attributes survive omissions and conflicting model output.
  Known numeric and campground boolean fields are typed safely. Additional model
  attributes require matching scalar evidence. Opaque IDs and text remain intact.
- Version the normalizer/prompt as hybrid-v4 / poi-normalize-v3. Only the exact
  previous v3/v2 pair can resume with every other pipeline version unchanged.
  Execution options audit the upgrade; completed outputs keep their provenance.
- GLM standard rates are used only for that exact model. Explicit DeepSeek
  overrides retain model-specific thinking requirements and prices.
- Update the shared runbook, configuration catalog and agent setup defaults.

## Evidence and validation

The earlier two-record GLM comparison averaged 4.80 seconds per call, compared
with 10.75 seconds for the same records under DeepSeek. Estimated mean cost was
$0.000457 versus $0.001825. This is a small sample, not a throughput guarantee.
The provider rejected disabled thinking; a 256-token cap retained complete output.

Static validation: 33 mocked provider, recovery, attribute and version tests passed.
Normalization golden checks and database types/contracts passed. Match golden
fixtures were unavailable in this database (all 13 skipped); live downstream
validation is still required. Shell syntax and diff whitespace checks passed.

The dedicated `ingest:test-normalization:integration` passed: the reviewed upgrade
retained the one-record cohort, observation/normalization IDs and original run
versions, recorded both version sets on the new execution, made no second
normalization attempt, and rejected incompatible schema versions and changed bytes.
Its isolated source/database data was removed after validation.

Live managed smoke results with the implemented prompt/settings:

| Record | Normalization latency | Estimated normalization cost | Captured attributes retained |
| --- | ---: | ---: | ---: |
| Forest Creek Forest Camp (58814) | 5.471 seconds | $0.0005612 | 8/8 |
| Windermere Baptist Conference Center (58815) | 7.639 seconds | $0.0006516 | 15/15 |

Both normalized artifacts were accepted without warnings, repair or JSON fallback.
Zero rating/reviews survived as numbers; amenities became booleans; prices remained
accurate. Mean latency was 6.555 seconds and mean estimated normalization cost
$0.0006064. These two calls were slower than the earlier narrow benchmark and still
form a small sample; do not promise a whole-file ETA from them.

Forest Creek reached `succeeded` with `verified_at` through Jina embedding, a GLM
match adjudication, canonical checks and global lineage verification:

- Job `3f676b0f-9df7-418d-8d6c-c3f18f5a9dd2`
- Run `d5547b5f-8a86-4d70-92fb-542bda3972af`
- Execution `d3a42cd2-1ae4-4cec-9755-2840a1b2a0f9`

Windermere first stopped deliberately after normalization (not a failed provider
call), then a new bounded cohort reused that normalization with zero additional
normalization requests/cost and reached `succeeded` with `verified_at`:

- Normalize-only job `138bed12-6ac1-46bf-aacf-09e91a046f11`, run
  `e1e8429d-4fc9-4e4d-b9b2-387a73616a3d`, execution
  `a23bf707-42ce-4283-8268-44344a8a83f9`
- Verified job `604ecf2b-4dbc-4d19-856d-4713e57faf03`, run
  `6c3a5d9d-923f-4f90-9a49-901e0da52ba6`, execution
  `fbb84923-6144-49e7-98c0-8ed6ffdb6587`

Geocoding reused valid source coordinates; no geocoder API call was required.
Description fusion and prose-date inference were not exercised live. Requests,
provider telemetry, artifacts and supervisor results are retained privately in the
normal runtime journals. No full-file completion is claimed.

The broader pre-existing `ingest:test-recovery` harness failed on its old scheduler
expectation (`normalization_required` now becomes a durable record intervention)
and its incomplete cleanup order for the new task/verification tables. That harness
is unchanged in this PR. Failure evidence was saved privately and only its isolated
fixture was removed. The dedicated GLM integration test supplies the scoped resume
coverage required here; do not report the broader suite as passing.

## Operational handoff

Original Dyrt run: `4dda8606-9c20-4275-bae6-c14cdea9e38c`.
The previous execution `af084e7a-6d8d-49f7-a358-b2cce7eb3100` and supervisor job
`5f64b03f-125a-4276-a3aa-a64b42f8fcc4` stopped gracefully for maintenance, with
paused outcome, exit 2, no forced kill, and no remaining worker/source lock.
Its frozen cohort has 43,272 records; 16,872 normalization tasks were checkpointed
and 26,400 pending at the stop. Raw evidence remains in the private runtime journals.

The tested GLM branch is active in the primary checkout. Maintenance is off and
there are no remaining ingestion workers or source locks. The original full Dyrt
run remains paused. Its callback probe returned `unavailable`: Codex CLI/server
version mismatch (0.162.1 / 0.155.1), so an unattended ordinary-agent launch cannot
meet the verified-delivery rule in [agent operations](../data/ingestion-agents.md).
No CLI/server upgrade or unrelated full import was attempted.

Manual foreground resume from the primary checkout (same frozen cohort, unlimited
provider stages, no global consolidation or overall deadline):

```sh
pnpm --filter @lib/db-map ingest:run --resume 4dda8606-9c20-4275-bae6-c14cdea9e38c --unlimited
```

Before any alternative background launch, reconcile current workers/claims again.
For a verified parent callback, fix the local version mismatch and follow the
cheap-runner workflow; the native scheduled coordinator can reconcile under its
existing authorized workflow. Preserve completed old artifacts; the two smoke
records were intentionally reprocessed and have fresh verified downstream output.

No schema migration or credential change is needed. The primary checkout's
unrelated dashboard and generated Next.js edits are preserved.
