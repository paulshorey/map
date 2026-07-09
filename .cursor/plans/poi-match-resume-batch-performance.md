# Plan: Safer, More Observable, Faster `ingest:match`

> Companion to `poi-ingestion-pipeline.md` and `poi-conflation-aggressive-merge.md`.
> This plan follows the first destructive recluster/consolidation run, where the process
> was stopped part-way through at roughly 6.3k linked rows and 3.3k pending rows.

---

## 1. Current behavior

`ingest:match` is already resumable in the important sense: committed progress lives in
`research_pois.canonical_poi_id`, and the row loop selects only matchable rows where that
column is `NULL`.

The confusing part is operational:

- `--recluster` intentionally wipes the checkpoint by nulling all `canonical_poi_id` values,
  deleting match decisions, and deleting canonicals.
- The script does not print a startup snapshot, so a user cannot immediately tell whether a
  run is resuming or starting over.
- `Ctrl-C` relies on process termination and Postgres rollback semantics. Committed rows are
  safe, but the script does not explain what happened or how to continue.
- There is no explicit `--consolidate-only` alias; the current workaround is
  `--consolidate --limit 0`.
- The safe, simple per-row implementation rebuilds each touched canonical immediately. This
  preserves a continuously publishable database, but it is slow against a remote database.

The log from the interrupted run showed that match-adjudication LLM calls were not the main
cost: only about 5.4% of completed rows used `method='llm'`. The bigger cost is thousands of
remote DB round trips and repeated full canonical rebuilds.

---

## 2. Goals

1. Make the resume/start-over mode obvious before work begins.
2. Make interruption graceful: finish or roll back the current unit, then print exactly how
   to resume.
3. Add an ergonomic `--consolidate-only` mode.
4. Improve throughput by batching deterministic decisions and rebuilding each touched
   canonical once per batch rather than after every linked row.
5. Preserve the current correctness properties:
   - `canonical_poi_id` remains the durable checkpoint.
   - Every non-dry-run match still writes a `research_match_decisions` audit row.
   - Candidate lookup still sees newly created/updated canonicals soon enough to avoid
     duplicate chains.
   - `--recluster` remains explicitly destructive and never runs accidentally.

Non-goals:

- Do not add a human review queue.
- Do not change match thresholds or proximity semantics in this plan.
- Do not require new infrastructure such as PostGIS, pgvector, or a queue worker.

---

## 3. User-facing safety and resume UX

### 3.1 Startup banner

Add a small snapshot helper in `scripts/ingest/match.ts`:

```ts
interface MatchSnapshot {
  linked: number;
  pending: number;
  skippedNoCoords: number;
  skippedNoName: number;
  canonicals: number;
  decisionsByMethod: Record<string, number>;
}
```

Print it after argument parsing and around advisory-lock acquisition, before any reset or
long-running matching work:

```txt
ingest:match
mode: resume
source: all
llm: enabled
linked: 6,365
pending: 3,366
canonicals: 5,033
previous decisions: auto=5,390 strong_id=437 proximity=193 llm=345
resume command: pnpm --filter @lib/db-map ingest:match --consolidate
```

When `--recluster` is present, print a loud warning to stderr:

```txt
WARNING: --recluster starts over.
It will unlink 6,365 research rows, delete match decisions, and delete 5,033 canonicals.
Use normal resume instead: pnpm --filter @lib/db-map ingest:match --consolidate
```

Keep the current behavior for now, but make the plan-compatible extension obvious: a later
hardening pass can require `--confirm-recluster` if accidental reclusters remain a risk.

### 3.2 Graceful `Ctrl-C`

Install a `SIGINT` handler in `main()` / `runMatch()`:

- First `Ctrl-C`: set `shutdownRequested = true`, print "Stopping after current row/batch".
- The row loop checks the flag after each commit/rollback and before starting the next row.
- The batch code checks it between chunks.
- Consolidation checks it between target groups or iterations.
- Second `Ctrl-C`: exit immediately with the current Node default behavior.

On graceful stop, query a fresh snapshot and print:

```txt
Stopped ingest:match.
This run processed 500 rows: merged=312 created=188 llm=21.
Current database: linked=6,865 pending=2,866 canonicals=5,421.
Resume with:
  pnpm --filter @lib/db-map ingest:match --consolidate
```

If the stop happens during an open transaction, roll that transaction back before printing.

### 3.3 `--consolidate-only`

Add a `consolidateOnly` CLI option:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate-only
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run
pnpm --filter @lib/db-map ingest:match --consolidate-only --no-llm
```

Behavior:

- Skip the research row match loop entirely.
- Run the canonical-vs-canonical consolidation sweep once to fixpoint.
- Reuse the same implementation path as `--consolidate --limit 0`.
- Reject combinations that imply row matching scope, such as `--source`.
- Reject `--recluster --consolidate-only`; recluster is a full rebuild mode.

---

## 4. Throughput improvements

### 4.1 Keep match-facing state fresh while deferring expensive publication rebuilds

The tricky part of deferred rebuilds is that candidate lookup depends on canonical rows and
category links. If we simply skip `rebuildCanonicalPoi()` after creating a canonical, later
rows cannot see that canonical because it may not yet have category rows.

Split the current rebuild responsibility into two layers:

1. **Lightweight match index maintenance** after each linked row:
   - Ensure `canonical_poi_categories` contains the row's category slugs.
   - Ensure `primary_category_id` is present when possible.
   - Keep `canonical_pois.name`, `lat`, `lng`, and `status` usable for matching.
   - For candidate anchor decisions, compute live popularity from linked `research_pois`
     in the candidate query rather than trusting possibly stale `canonical_pois.popularity`.

2. **Full publication rebuild** batched:
   - `rebuildCanonicalPoi()` remains the single source of truth for user-facing fields,
     provenance, occurrences, descriptions, contained features, popularity, and final status.
   - Queue touched canonical IDs and rebuild each unique ID once per flush.

Introduce a `RebuildQueue`:

```ts
class RebuildQueue {
  add(canonicalId: string): void;
  size(): number;
  async flush(client: PoolClient, opts: RebuildOptions): Promise<number>;
}
```

Default flush policy:

- `--rebuild-batch-size N`, default `500`.
- Flush at batch boundaries.
- Flush before consolidation.
- Flush before graceful shutdown completes.
- Flush at normal process end.

This alone should remove a large amount of repeated work, especially for clusters where
many research rows attach to the same canonical.

### 4.2 Deterministic batch passes before the row loop

Add optional batch passes that process easy decisions in chunks before falling back to the
existing one-row decision engine.

New option:

```bash
pnpm --filter @lib/db-map ingest:match --batch-size 500
```

Default to enabled with a conservative chunk size once tests are in place. During rollout,
allow `--batch-size 1` or `--no-batch` to force the old path.

Batch passes, in order:

1. **Overrides**
   - Apply force-same and force-new decisions for unmatched rows where the target is
     already known.
   - Keep manual intent ahead of all other deterministic logic.

2. **Strong IDs**
   - Find unmatched research rows whose strong IDs match a linked research row's strong IDs.
   - Use a set-based `UPDATE ... FROM ... RETURNING` to assign `canonical_poi_id`.
   - Insert one `research_match_decisions` row per updated research row with
     `method='strong_id'`.
   - Queue touched canonicals.

3. **Exact-name proximity / distinctive name block**
   - Batch the deterministic cases currently decided in `decideRow` without LLM:
     exact normalized name within proximity, and distinctive exact name inside the wide
     name block.
   - Exclude date conflicts and coarse-coordinate cases.
   - Insert `method='auto'` decisions with the same signal shape as the row path where
     practical.

4. **Satellite -> anchor proximity**
   - Batch the aggressive proximity rule where an unmatched satellite-like research row is
     inside the proximity box of an existing anchor.
   - Insert `method='proximity'` decisions.
   - Use live aggregate anchor metadata so deferred publication rebuilds do not hide newly
     promoted anchors.

After each pass/chunk:

- Commit the chunk.
- Flush the rebuild queue if it reaches `--rebuild-batch-size`.
- Print one summary line instead of one line per row:

```txt
Batch strong_id: linked=437 touched_canonicals=421
Batch proximity: linked=193 touched_canonicals=88
```

The existing row loop remains responsible for ambiguous, LLM-routed, and edge-case rows.

### 4.3 Batch-aware row loop

Change `applyDecision()` into two layers:

- `applyDecisionLinksOnly()`:
  - create canonical if needed
  - collapse duplicate canonicals if requested
  - update `research_pois.canonical_poi_id`
  - write the match decision
  - maintain lightweight match-facing state
  - enqueue the canonical for rebuild

- `flushRebuilds()`:
  - calls `rebuildCanonicalPoi()` once per unique canonical ID

For safety, the row loop can initially flush every row when `--rebuild-batch-size 1`, which
preserves old behavior and gives an easy debugging mode.

### 4.4 Consolidation batching

`runConsolidation()` already groups duplicate canonicals by target. Keep that shape, but
route rebuilt targets through the same `RebuildQueue`:

- Collapse all duplicate canonicals for a target in one transaction.
- Queue the target.
- Flush per consolidation iteration or when the queue hits the batch threshold.
- Re-plan after each iteration, as today, so transitive effects still settle to a fixpoint.

---

## 5. CLI shape after implementation

Common safe commands:

```bash
# Resume matching all pending rows, then run consolidation
pnpm --filter @lib/db-map ingest:match --consolidate

# Resume in bounded chunks
pnpm --filter @lib/db-map ingest:match --limit 500

# Consolidate existing canonicals only
pnpm --filter @lib/db-map ingest:match --consolidate-only

# Preview consolidation only
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run

# Deliberately start over from raw research rows
pnpm --filter @lib/db-map ingest:match --recluster --consolidate
```

Performance controls:

```bash
pnpm --filter @lib/db-map ingest:match --batch-size 500 --rebuild-batch-size 500
pnpm --filter @lib/db-map ingest:match --no-batch --rebuild-batch-size 1
```

---

## 6. Tests and verification

Unit tests:

- CLI parsing:
  - `--consolidate-only`
  - invalid combinations
  - `--batch-size` and `--rebuild-batch-size`
- Snapshot formatting:
  - resume banner
  - recluster warning
  - graceful stop summary
- `RebuildQueue` uniqueness and flush behavior.

Golden / integration tests:

- Existing `ingest:match:golden --no-llm` remains green.
- A small fixture where two rows for the same new place are processed with deferred
  rebuilds; the second row must see the first row's canonical.
- Batch strong-id output equals the row-loop strong-id output.
- Batch exact-name/proximity output equals the row-loop output for deterministic cases.
- `--consolidate-only --dry-run` reports plans without changing row links.
- Interrupt after a chunk leaves committed rows linked and pending rows still selectable.

Manual verification on the live/staging DB:

1. Record startup snapshot.
2. Run `ingest:match --limit 100 --no-llm`.
3. Confirm linked increases by 100 and pending decreases by 100.
4. Run the same command again; it starts at the next pending row.
5. Run `ingest:match --consolidate-only --dry-run`.
6. Run `ingest:match --recluster --consolidate --no-llm` only on a disposable/staging DB
   or after explicitly accepting the warning.

---

## 7. Rollout order

1. **Docs and startup visibility**
   - Add the startup snapshot helper and banner.
   - Add the `--recluster` warning.
   - Update README usage examples.

2. **Graceful shutdown**
   - Add the `SIGINT` handler.
   - Print stop/resume summary.
   - Verify no open transaction is left hanging.

3. **`--consolidate-only`**
   - Add CLI option.
   - Wire it to the current `--consolidate --limit 0` behavior.
   - Add dry-run test.

4. **Deferred rebuild queue**
   - Add `RebuildQueue`.
   - Keep default `--rebuild-batch-size 1` for the first PR if desired.
   - Raise default after fixtures prove candidate visibility is preserved.

5. **Deterministic batch passes**
   - Strong ID batch first.
   - Exact-name/name-block batch second.
   - Satellite-anchor proximity batch third.
   - Compare batch decisions against a dry-run row-loop sample before enabling by default.

6. **Consolidation batching**
   - Reuse `RebuildQueue`.
   - Keep fixpoint iteration semantics unchanged.
