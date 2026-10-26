# Ingestion next decision — 2026-10-25, revised

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
