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
- Version the normalizer/prompt as hybrid-v6 / poi-normalize-v4 after Dyrt validation completed
  the known-scalar type map. Exact previous v3/v2, v4/v3 and v5/v4 pairs can resume
  with every other pipeline version unchanged.
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
fixtures were unavailable in this database (all 13 skipped); the live checks below
provide downstream coverage. Shell syntax and diff whitespace checks passed.

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

The initial handoff left the full import paused because callback preflight reported
a Codex CLI/server version mismatch (0.162.1 / 0.155.1). After Paul upgraded both
and explicitly requested continuation, a fresh probe on 2026-10-13 returned `ready`.
Fresh discovery confirmed maintenance off, no workers/locks or unresolved claims,
and the source checksum still matched the original run. Non-secret LLM overrides
were unset, so the tested GLM defaults apply.

The configured `ingestion-runner` / GPT-5.6 Luna low launcher resumed the same run
from the primary checkout at 2026-10-13 19:40:59 UTC:

- Supervisor job: `fcdb4393-9d18-432b-aec7-8e8bfcd6ef5d`
- Execution: `0b8c933e-4188-45a3-81ad-557e29378195`
- Parent callback: this chat, `01a1361f-f97f-7b42-b1c0-d1c0f7f8f37c`
- Frozen cohort: 43,272 records; original observations/checkpoints preserved.
- Provider stages: `--unlimited`; no overall deadline or global consolidation.
- Health checks: hourly ordinary Node supervision; no AI monitoring loop.

Recorded launch command:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise start \
  --notify-thread 01a1361f-f97f-7b42-b1c0-d1c0f7f8f37c -- \
  --resume 4dda8606-9c20-4275-bae6-c14cdea9e38c --unlimited
```

Bounded startup verification confirmed exactly one worker with verified process
identity and its source lock, a current heartbeat, maintenance off, and the exact
reviewed pipeline-version upgrade in execution options. At 19:42:15 UTC, 73
canonical checks and reused match attempts had committed, with 72 record
verifications complete. No new provider calls were recorded at that point;
the scheduler was reusing existing downstream artifacts. This is launch/progress
evidence, not full-file completion or proof of terminal callback delivery.

The Node supervisor owns continued waiting and durable results in the job's private
`.ingest-jobs` directory. Terminal notification is configured for the parent chat;
the callback probe proves transport readiness, and the terminal queue receipt will
record acceptance when delivery is attempted. Reconcile the existing job and
current workers/claims before any further launch. Preserve completed old artifacts;
the two smoke records have fresh verified downstream output.

No schema migration or credential change is needed. The primary checkout's
unrelated dashboard and generated Next.js edits are preserved.

## PR cleanup and output repair — 2026-10-14

The full execution stopped at 08:58 UTC: record `124071` returned malformed matching JSON.
Attempt `5680110e-14c0-4e54-ae17-010e19585065` failed after an HTTP 200 response; five earlier
matches were quarantined after output truncation. Completed normalizations and record proofs
remain intact; this is not whole-file completion. Raw evidence stays in the private journals.

The PR review repair gives matching a strict two-field output contract, deterministic validation,
and exactly one contextual output repair with a larger bound. Normalization also repairs an
empty/truncated final answer once. Invalid responses remain auditable; auth/database/transport
errors are not mistaken for malformed-output repairs. Provider defaults and concurrency remain
the reviewed GLM settings; model replacement is a separate quality decision.

Successful final verification now records its effective version in `counters.verification`,
so inventory and the queue can recognize a compatible resumed full run while retaining its
original version provenance. The focused provider-free integration asserts completion and
unchanged artifact/cohort IDs, and the mocked repair tests forbid a third request.

No full import was restarted during PR cleanup. The five existing quarantines need audited
retry after matching is validated; ordinary resume only requeues the paused terminal record.

Final review also separated safe extra-attribute drops from unsupported core fields. A discarded
invented amenity retains an `attribute_dropped_*` warning while the valid record remains accepted;
unsupported city/name evidence still degrades it. The resolver regression covers both outcomes.
Existing cached artifacts were not invalidated or rewritten.

Output repair also retains `json_object` after an explicit schema-unsupported compatibility
fallback. Mocked malformed, empty and truncated fallback replies verify the repair wire format,
audit linkage and absence of a second repair, for both successful and failed repair output.

Extra attributes now require key-scoped evidence; generic attributes evidence cannot donate an
unrelated scalar. Resolver/prompt versions advance to hybrid-v5/poi-normalize-v4, invalidating
looser pending cache hits. Exact reviewed v3/v2 and interim v4/v3 resumes preserve completed
checkpoints; unrelated stage-version changes remain rejected. Existing data is not rewritten.

Inventory shares that exact compatibility list for record/exclusion proofs, and accepts older
proofs only after the same run succeeds with current audited verification. The two-record
integration also checks an interim-v4 exclusion, the missing-current-audit guard and rejection
of an unreviewed prior version.

## Dyrt live validation — 2026-10-14

GLM remains the selected model. Final review found that generic errors from a second invalid
normalization reply could stop the full run. Exhausted output validation now becomes an explicit
quarantinable LLM validation error, while repair-time provider and audit/database failures keep
their original behavior. Mocked tests verify both paths and forbid another output repair.

Live Dyrt validation passed with three distinct records: `124071` (Lone Mountain Camping,
the original matching failure), `0` (Hocking Hills Camping), and `2` (Point Beach State Forest).
The original full run, five quarantines, artifacts and private failure evidence remain intact.

The initial three-record validation passed full scope and lineage verification. It exposed
safe but incomplete typing for known Dyrt hookup/site/vehicle attributes. Those booleans and
numbers are now formatted by code, while opaque IDs remain text. Resolver v6 gives pending
work a fresh cache identity; reviewed previous checkpoints remain compatible. The same three
records were revalidated after the correction without expanding the sample or draining work.

Final resolver-v6 receipts:

| Records | Job | Run | Execution | Result / elapsed |
| --- | --- | --- | --- | --- |
| 124071 | d86eb581-b0e1-4063-a66a-c01d8cde2bb8 | 2d310c98-a447-4257-90a3-dc4e816109f4 | a3775e98-30de-4997-83a7-a87bcee0a0f3 | succeeded / 25.169s |
| 0, 2 | 39a2d70e-1894-4f29-bffc-b2b222893036 | b8f82353-911f-46fa-903e-014e1b176ac9 | d7259aae-5603-4eb3-84e4-b55114a822de | succeeded / 34.121s |

Both new smoke cohorts had 60-second deadlines, finite normalization budgets and zero geocoder
budget; no consolidation or full resume. Each record made one fresh GLM/256 normalization
request with valid schema output and no repair. Latencies were 6.540s, 6.298s and 5.165s.
All stages, global lineage checks and selected-record verification passed. Original observations,
coordinates and old normalization/embedding artifacts were retained. All 21/21/18 captured
attributes survived with the documented types; zero ratings/reviews/prices and false flags passed.
Country codes remain null on the three normalization artifacts because that field is missing
from the capture; no geocoder was called. Lone Mountain retains an informational
`country_code_missing` warning. Sample quality review `99c52cb8-2ab9-4d08-9879-5de9b420b352`
accepted the inspected record fidelity/formatting, separately from whole-file/category completion.

Across the initial and final passes, all seven Fireworks calls and six Jina embedding calls
succeeded. Recorded Fireworks estimate: $0.00473655; embedding costs were not supplied.
The isolated two-record database test also passed current-version resume, original/interim
exclusion proofs, missing-audit and incompatible-version guards with no repeated normalization
or provider requests; its fixtures were removed. Static validation passed 13 repair tests,
10 normalization/version tests, 17 scheduler/concurrency tests, types/contracts and golden checks.

The 43,272-record capture's complete extraction proof is unchanged. Full Dyrt run
`4dda8606-9c20-4275-bae6-c14cdea9e38c` remains failed/stopped, with five existing issues open.
Before full recovery, inspect and audit retries of those issues through the runbook's maintenance
procedure; then the exact original-scope command is:

```sh
pnpm --filter @lib/db-map ingest:run --resume 4dda8606-9c20-4275-bae6-c14cdea9e38c --unlimited
```

Raw jobs, provider/attempt journals and quality-review evidence remain private in the ignored
runtime directories. No full import or existing issue retry was launched by this validation task.
