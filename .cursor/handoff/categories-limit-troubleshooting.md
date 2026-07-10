# Handoff: artfairslist `--limit` ingest — only last record saved / prior canonicals hidden

**Date:** 2026-07-10  
**Status:** Root cause identified; fix not yet implemented  
**Related work:** Multi-category ingest (`--category art_fair --category craft_fair`) was implemented and verified separately; this issue is unrelated to multi-category logic.

---

## Summary

A pilot `ingest:run` on `docs/poi/art-fairs/craft-shows/artfairslist.json` with `--limit 3` or `--limit 5` appeared to process multiple records but only persisted **one** research row and **one** published canonical — always the **last** record in the limit window. Re-running with a higher limit overwrote that row with a new fair and **hid** the previous canonical. This is **not** a `--limit` bug and **not** a multi-category bug. The generic extractor assigns the **same `source_record_id`** to every record in the file because they share one listing-page `source_url`.

---

## Commands the user ran

```bash
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/artfairslist.json \
  --category art_fair --category craft_fair --limit 3
```

Later:

```bash
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/artfairslist.json \
  --category art_fair --category craft_fair --limit 5
```

Multi-category flags worked as designed (dry-run showed `category: art_fair (+craft_fair)`; DB rows that did persist had `ingest_categories = {art_fair,craft_fair}` and `category_slugs = {art_fair,craft_fair}` after normalization).

---

## Reported symptoms

### Run 1 (`--limit 3`)

Expected: first three fairs in the JSON file saved.

Observed:

- Only **one** row in `research_pois` and **one** in `canonical_pois`.
- That row was **"Art New York"** — the **3rd** record in the file, not the 1st or 2nd.
- **"Accessible Art Fair NY"** and **"PHOTOFAIRS San Francisco"** had **no** `research_pois` rows.

First three records in the file (all share the same `source_url`):

| # | name | start_date | city | source_url |
|---|------|------------|------|------------|
| 1 | Accessible Art Fair NY | 2016-11-01 | New York | `https://artfairslist.eu` |
| 2 | PHOTOFAIRS San Francisco | 2017-01-27 | San Francisco | `https://artfairslist.eu` |
| 3 | Art New York | 2019-05-02 | New York | `https://artfairslist.eu` |

### Run 2 (`--limit 5`)

Expected: up to five fairs saved.

Observed:

- Again only **one** research row — the **5th** record: **"American Indian Art Show San Francisco"**.
- **"Art New York"** (from run 1) still existed as a canonical but `status` became **`hidden`**.
- After manually setting Art New York to `status: published`, it appeared on the map again.
- Map showed two places only after that manual fix: Art New York + American Indian Art Show.

Records 4–5 from the second run (same shared `source_url`):

| # | name | start_date | city |
|---|------|------------|------|
| 4 | Art Los Angeles Contemporary — ALAC | 2020-02-13 | Los Angeles |
| 5 | American Indian Art Show San Francisco | 2020-02-21 | San Francisco |

### Exit code / run status

The pipeline ended with:

```
Run bb35108e-6687-4e2e-8191-6a90e1bce3fc: partial
Exit status 2
```

**This is expected** when `--limit` is set: orchestrator marks the run `partial` and sets `process.exitCode = 2` so automation can distinguish “pilot / incomplete” from full success (`succeeded`, exit 0). Not a failure of extract/normalize/match themselves.

Relevant code:

- `lib/db-map/scripts/ingest/orchestrator.ts` — `partial ||= … || opts.limit !== undefined`
- Final: `if (partial) process.exitCode = 2`

---

## Investigation findings

### Database state (after user’s runs)

Query pattern:

```sql
SELECT rp.source_record_id, rp.name, rp.canonical_poi_id, cp.name, cp.status
FROM research_pois rp
JOIN research_sources rs ON rs.id = rp.source_id
LEFT JOIN canonical_pois cp ON cp.id = rp.canonical_poi_id
WHERE rs.slug = 'artfairslist';
```

At one point only **one** research row:

- `source_record_id`: `https://artfairslist.eu`
- `name`: American Indian Art Show San Francisco
- canonical `status`: `published`

Two canonicals existed (orphan + current):

- Art New York — `hidden` (orphaned after research row moved to a new match)
- American Indian Art Show San Francisco — `published`

### Root cause: duplicate `source_record_id`

Generic extractor identity resolution (`lib/db-map/scripts/ingest/extractors/generic.ts`):

```typescript
const sourceUrl = str(r.source_url) ?? str(r.url);
const id = str(r.source_record_id) ?? str(r.id) ?? sourceUrl;
```

`artfairslist.json` records have:

- **No** `source_record_id` or `id` field
- **Same** `source_url` on every row: `https://artfairslist.eu` (listing site homepage, not per-fair detail URL)

Therefore every record gets `source_record_id = "https://artfairslist.eu"`.

`research_pois` is unique on `(source_id, source_record_id)`. Each extract **upserts the same row**, overwriting name/raw/etc. Only the **last** record within the `--limit` window remains.

Flow with `--limit 3`:

1. Record 1 → upsert row id `https://artfairslist.eu` as "Accessible Art Fair NY"
2. Record 2 → **overwrite** same row as "PHOTOFAIRS San Francisco"
3. Record 3 → **overwrite** same row as "Art New York"
4. Normalize/match/merge see **one** research row → one canonical

### Why prior canonical became `hidden`

When run 2 changed the shared research row from "Art New York" to "American Indian Art Show San Francisco", matching linked that row to a **new** canonical. The old "Art New York" canonical had **no** linked `research_pois` rows left.

`rebuildCanonicalPoi` in `lib/db-map/scripts/ingest/merge.ts`:

```typescript
if (rows.length === 0) {
  await client.query(`UPDATE canonical_pois SET status = 'hidden', ... WHERE id = $1`, [canonicalId]);
  return;
}
```

So the previous canonical was hidden by design (orphan cleanup), not corruption. Data remained; `status` was wrong for display until manually set back to `published`.

### Secondary issue: field aliases

The file uses `website_url`, `street_address`, and `state`. Generic extractor maps:

- `street_address` → `address` ✓
- `state` → `region` ✓
- `website_url` → **not** mapped to `website` (only `website` / `official_website`)

Official sites are likely landing in `attributes` only, not the `website` column.

---

## What is **not** the cause

| Ruled out | Notes |
|-----------|--------|
| Multi-category `--category` flags | Verified working; arrays stored correctly when rows persist |
| `--limit` only processing one row | Limit processes N records; they collide on one DB key |
| Snapshot retire deleting rows | Would not explain “always the last in window” pattern |
| LLM normalization dropping rows | Extract stage never creates separate rows |

---

## File / source context

- **Path:** `docs/poi/art-fairs/craft-shows/artfairslist.json`
- **Format:** Top-level JSON array (~1964 lines); conforms to generic extractor shape except stable ids
- **Source slug (inferred):** `artfairslist` (from filename/path via `source-file.ts`)
- **Ingest categories used:** `art_fair` (primary), `craft_fair` (secondary)
- **Capture spec:** `docs/poi-research/capture-spec.md` requires stable `source_record_id` (source id, detail URL, or deterministic slug — **not** array index)

---

## Recommended fixes (not implemented)

Pick one or combine:

1. **Fix source data (preferred for capture spec compliance)**  
   Add per-record `source_record_id` or unique detail `source_url` when scraping/exporting (e.g. hash of name + start_date + city, or real fair permalink).

2. **Harden generic extractor**  
   - Do **not** use a shared listing homepage as `source_record_id` when multiple records share it.  
   - Fallback order could be: explicit id → unique detail URL → deterministic slug from `name` + `start_date` + `city` (document in capture spec).  
   - Map `website_url` → `website`.

3. **Reject or warn at extract**  
   If `source_record_id` would duplicate within a file run, log/reject instead of silent overwrite (orchestrator already logs `extract ok` per ordinal — user may see 3 “ok” lines but one DB row).

4. **Re-ingest after fix**  
   - Clean up orphan/hidden canonicals for artfairslist if desired.  
   - Full run without `--limit` once ids are stable.  
   - Consider `ingest:match --consolidate-only` / manual review for duplicate canonicals created during testing.

---

## Useful commands for follow-up

```bash
# Dry-run (no DB writes)
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/artfairslist.json \
  --category art_fair --category craft_fair --dry-run

# Inspect research rows for this source
psql "$DB_MAP_URL" -c "
  SELECT source_record_id, name, ingest_categories, category_slugs, canonical_poi_id
  FROM research_pois rp
  JOIN research_sources rs ON rs.id = rp.source_id
  WHERE rs.slug = 'artfairslist';
"

# Inspect canonicals tied to artfairslist research
psql "$DB_MAP_URL" -c "
  SELECT cp.id, cp.name, cp.status, cp.updated_at
  FROM canonical_pois cp
  JOIN research_pois rp ON rp.canonical_poi_id = cp.id
  JOIN research_sources rs ON rs.id = rp.source_id
  WHERE rs.slug = 'artfairslist';
"

# Read-only pipeline report
pnpm --filter @lib/db-map ingest:report --source artfairslist --category art_fair
```

---

## Key code references

| Area | Path |
|------|------|
| Generic id fallback | `lib/db-map/scripts/ingest/extractors/generic.ts` (`mapGenericRecord`) |
| Extract upsert key | `lib/db-map/scripts/ingest/extract.ts`, `lib/db-map/scripts/ingest/orchestrator.ts` (`observeRecord`) |
| Partial run / exit 2 | `lib/db-map/scripts/ingest/orchestrator.ts` |
| Hide orphan canonical | `lib/db-map/scripts/ingest/merge.ts` (`rebuildCanonicalPoi`) |
| Capture spec (stable id) | `docs/poi-research/capture-spec.md` |
| Multi-category ingest | `lib/db-map/migrations/202607100300__multi_category_ingest.sql`, CLI `--category` repeat |

---

## Open questions for next engineer

1. Should deterministic ids (name + date + city) be **hashed** (fixed length) or human-readable slugs?
2. Should duplicate `source_record_id` within one file be a **hard error** at extract vs. last-write-wins?
3. Should orphan canonicals be **merged** into the new match instead of hidden when the research row “moves”?
4. Re-scrape `artfairslist.json` with proper ids vs. patch extractor only?

---

## Prior verification (same session, different source)

Multi-category pipeline was verified on `thedyrt/rv_campgrounds.csv` with `--category campground --category rv`:

- `ingest_categories = {campground,rv}`
- After LLM normalize: `category_slugs = {campground,rv}`

That path is healthy; this handoff is specific to **unstable duplicate ids** in `artfairslist.json`.
