# Ingestion next decision — 2026-10-25, revised

## Current decision — 2026-10-26 CT

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

## Current contract

`source_coordinates` and `inferred_coordinates` stay the two provenance slots.
Assessments stay immutable and advisory. `evidence.distance_m` is stored
whenever both points exist. `matcher-v3` uses the stored research point.
`canonical-build-v7` publishes both markers when the points differ, keeps both
evidence records when they are equal, and does not block a usable source point
for missing inferred, reverse, or country text. A record with no plottable
point remains unpublished, with assessment status `unlocated` and its raw text
intact.

## Next run

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
