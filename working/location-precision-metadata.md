# Precision metadata and Biennale.com refresh

Owner direction on 2026-10-26 CT: implement the precision-metadata follow-up and
other next steps; explicitly include a new whole-file refresh of the 43
Biennale.com records after validation. Keep both ingestion heartbeats paused.
No other file, global consolidation, source correction, or backlog drain is selected.

## Implementation

1. Retain the complete selected LocationIQ forward-response row in the paid
   query cache and immutable geocode input snapshot. Preserve bounding boxes,
   identifiers, classification, address parts, and other returned fields rather
   than reducing the evidence to a coordinate. No new request parameters are added.
2. Add versioned `precision_evidence`: operational value, derivation, provider
   class/type, and warnings. Keep the existing precision classifier; its point
   default becomes explicit. Do not infer venue accuracy from a coordinate pair.
3. Carry compact evidence through inferred slots, canonical selection, and the
   API contract. Keep the full response in ingestion artifacts, outside map slots.
4. Replay old paid caches unchanged and without HTTP. Missing derivation is
   explicitly `legacy_cache`; read-only diagnostics describe existing artifacts
   as `legacy_artifact`. Never reconstruct an unavailable historical response.
5. Label Fireworks description fusion as `description_fusion`, retaining actual
   stage/attempt ownership. Provider requests, prompts, budgets, and admission
   behavior are unchanged.

No schema migration, assessment-policy change, coordinate correction, cache-key
invalidation, pipeline-version bump, or historical sweep is required. Current
artifacts remain reusable even if their older response metadata is absent.

The [LocationIQ response documentation](https://docs.locationiq.com/docs/search-forward-geocoding)
lists classification, bounding boxes and address fields, and notes that some
identifiers are absent for non-OSM sources. We preserve fields actually returned;
neither missing fields nor the existing operational point fallback prove accuracy.

## Regression and readiness checks

- Saved São Paulo parsed result: missing class/type, `precision=point`, no original
  provider row. This fixture is explicitly parsed evidence, not a fabricated raw response.
- Fresh mocked response: exact selected row survives cache/artifact capture, compact
  metadata survives slots, and no request URL/credential enters the captured result.
- Provider-free cache replay: no HTTP, no cache mutation, unchanged source/inferred
  coordinates, and explicit legacy derivation.
- Real disposable PostgreSQL: cache -> geocode -> matching -> publication -> API
  preserves raw/compact evidence and publishes conflicting candidates. Equal
  coordinates retain both evidence records and one marker. Lineage checks pass.
- LLM purpose label and actual attempt links agree; inference request bodies are unchanged.
- Existing 94-case assessment packet, location/resume/provider regressions,
  package and map-app types, generated contract, and current-head CI/review.

Read-only shared baseline: all 43 source records have usable source coordinates,
city/country/address, venue, dates, edition year, and website. All are normalized
and linked; only two have current location enrichment/v7 builds. The file SHA-256
remains `76608f73a5c939b187638d92a076975e84f473fdae1fff0e900d25066c2706a7`.
Existing Venice/São Paulo results stay reusable; missing historical metadata is
reported honestly rather than forcing another paid lookup.

## Launch and completion

Merge the independently reviewed implementation and fast-forward the clean
primary checkout. Reconcile a fresh coordinator snapshot, jobs, claims, workers,
locks, maintenance ownership, source readiness, and current queue. Reopen only
this task's maintenance gate. Use the configured low-cost ingestion runner and
verified parent notification for one detached managed launch:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise start \
  --notify-thread "$CODEX_THREAD_ID" -- \
  data/poi/art-fairs/biennials/biennale_com.json --category art_fair --unlimited
```

This creates a whole-file cohort, not a resume of
`4dcf935e-4bf6-4af9-bed5-004dcaef0398`. No `--limit`, global consolidation,
overall deadline, or provider cap is added. Ordinary Node owns waiting and hourly
checks; the coding/launch agents return after the launch receipt.

The callback probe found current CLI 0.164.0 / running daemon 0.163.0 mismatch.
The already-installed 0.163.0 binary passed the same probe. For this launch only,
prefix with `CODEX_INGEST_CLI=/Users/pshorey/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/codex`.
This does not change the managed installation, daemon, or global configuration.

At terminal completion, pin job/run/execution IDs and verify all 43 cohort
records, `verified_at`, stage attempts, current build-input lineage, both-point
API behavior, cache reuse, and the complete provider ledger including unknown
costs and any failures. Assessments remain advisory. Confirm process/lock exit
before considering another scope. Stop and diagnose a failed terminal result;
do not automatically retry or advance to another file. Both heartbeats stay paused.

Private baseline, test logs, and later launch receipts belong under the primary
checkout's ignored `.ingest-jobs/precision-metadata-20261026/` and the actual
supervised job/run directories. This document is a plan, not a completion receipt.
