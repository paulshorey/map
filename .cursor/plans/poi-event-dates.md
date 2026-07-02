# Plan: Event POIs — start/end dates & date filtering

> **Companions:** [`poi-ingestion-pipeline.md`](./poi-ingestion-pipeline.md) (design) and
> [`poi-ingestion-implementation.md`](./poi-ingestion-implementation.md) (build steps). This doc
> adds **temporal POIs** to that model and is the plan for letting users eventually **filter the
> map by event date**.
>
> **Relationship to the overview:** this **refines overview §15.5**. There, festival dates lived
> only inside `attributes` (jsonb). To support an **indexed, user-facing date filter**, we promote
> start/end to **first-class, nullable, typed columns** (and add an occurrences table for
> recurring events). `attributes` may still hold extra temporal metadata (recurrence text, edition
> history), but the queryable truth is the typed columns.

---

## 1. Goal & scope

- **Most POIs are permanent** (gardens, campgrounds, viewpoints) — they have **no** dates and must
  keep behaving exactly as today.
- **Some POIs are events** (music festivals, and future event categories) — they have a **start**
  and **end**, may **recur** annually, and users will want to filter the map to "what's on" in a
  date window.
- Deliverables:
  1. Schema to store optional start/end (and recurrence) on a POI.
  2. Ingestion that populates those fields (building on the festival work in overview §15).
  3. Read path + contracts exposing dates and a derived status.
  4. A future user-facing **date-range filter** (UI + API), shipped last.

**Non-goals (now):** ticketing, per-day schedules/line-ups, RSVPs. Just plottable date ranges and
filtering.

---

## 2. Design decisions

1. **Typed nullable columns, not jsonb, for the queryable dates.** `starts_at` / `ends_at` on the
   canonical POI. NULL = "not an event" (permanent POI). Indexable for range filters; jsonb is not
   a good fit for an indexed user filter.
2. **`timestamptz`, plus a `date_precision` marker.** Sources vary: some give a full datetime
   (concerts), most give day-level (festivals), some only month or year. Store `timestamptz`
   (UTC) and record how precisely it's known so the UI renders "Jul 2027" vs "Jul 4, 2027, 6pm".
3. **Status is derived at read time, never stored.** `upcoming` / `ongoing` / `past` is computed
   from `starts_at`/`ends_at` vs. `now()` — consistent with the rest of the plan (no frozen flags
   that go stale; overview §15.4).
4. **Categories know if they're temporal.** A boolean `is_temporal` on `canonical_categories`
   (code-owned taxonomy) marks event categories (e.g. `music_festival`). The app uses it to decide
   when to show the date filter and a status badge. Permanent categories never expose date UI.
5. **Recurrence via an occurrences child table.** A festival recurs (2025, 2026, 2027). Editions
   already merge into **one** canonical POI (overview §15.5). Each edition's dates become a row in
   `canonical_poi_occurrences`. The canonical's own `starts_at`/`ends_at` is the **representative
   occurrence** (next upcoming, else most recent) — a denormalized convenience for fast default
   rendering and simple filters; the occurrences table is the source of truth for accurate
   date-range filtering across editions.
6. **Permanent POIs are unaffected.** All new columns are nullable / default-empty; existing
   queries that don't ask about dates behave identically.

---

## 3. Schema changes

Ships as a migration in `lib/db-map/migrations/` (either folded into the fresh baseline from
implementation-plan **M1**, or as an additive follow-on migration if the baseline already ran),
then `cd lib/db-map && pnpm db:sync` + commit generated artifacts.

### 3.1 `canonical_pois` — representative dates

```sql
ALTER TABLE public.canonical_pois
  ADD COLUMN starts_at      timestamptz,                 -- NULL ⇒ not an event (permanent POI)
  ADD COLUMN ends_at        timestamptz,                 -- NULL ok (single-instant or unknown end)
  ADD COLUMN date_precision text                         -- 'datetime' | 'day' | 'month' | 'year'
                            CHECK (date_precision IN ('datetime','day','month','year'));

-- Range-overlap filtering. Generated tstzrange + GiST = efficient "events overlapping [from,to]".
ALTER TABLE public.canonical_pois
  ADD COLUMN event_range tstzrange
  GENERATED ALWAYS AS (
    CASE WHEN starts_at IS NULL THEN NULL
         ELSE tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]') END
  ) STORED;
CREATE INDEX canonical_pois_event_range_gix ON public.canonical_pois USING gist (event_range);
CREATE INDEX canonical_pois_starts_idx      ON public.canonical_pois (starts_at);  -- sorting / simple filters
```

> If the generated `tstzrange` expression is rejected by the Postgres version, fall back to a
> plain `tstzrange` column maintained by the same trigger pattern used for `geom` (see
> implementation-plan M1.2), or skip the range column and filter with `starts_at <= :to AND
> COALESCE(ends_at, starts_at) >= :from` on the btree indexes.

### 3.2 `canonical_categories` — mark temporal categories

```sql
ALTER TABLE public.canonical_categories
  ADD COLUMN is_temporal boolean NOT NULL DEFAULT false;  -- true for event categories (festivals)
```

Set in the code-owned taxonomy seed (`taxonomy.ts`): `music_festival` → `is_temporal: true`;
gardens/campgrounds stay `false`.

### 3.3 `canonical_poi_occurrences` — recurring editions (source of truth for filtering)

```sql
CREATE TABLE public.canonical_poi_occurrences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_id         uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  date_precision text CHECK (date_precision IN ('datetime','day','month','year')),
  occurrence_range tstzrange
    GENERATED ALWAYS AS (tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]')) STORED,
  UNIQUE (poi_id, starts_at)
);
CREATE INDEX canonical_poi_occurrences_poi_idx   ON public.canonical_poi_occurrences (poi_id);
CREATE INDEX canonical_poi_occurrences_range_gix ON public.canonical_poi_occurrences USING gist (occurrence_range);
```

A one-off event = exactly one occurrence. An annual festival = one row per known edition. The
canonical's `starts_at`/`ends_at` (3.1) is derived from these (next upcoming, else latest).

### 3.4 `research_pois` — parsed dates on the raw side

```sql
ALTER TABLE public.research_pois
  ADD COLUMN starts_at      timestamptz,
  ADD COLUMN ends_at        timestamptz,
  ADD COLUMN date_precision text
                            CHECK (date_precision IN ('datetime','day','month','year'));
```

Normalize parses each source's date(s) into these (validated as real event dates — overview
§15.3); merge reads them to build occurrences and the representative dates. The raw source strings
stay in `attributes`/`raw`.

---

## 4. Ingestion integration (builds on §15 / implementation M4–M8)

- **Extract (M4):** extractors already place `start_date`/`end_date` into `RawRecord.attributes`
  (overview §15.5). No change beyond ensuring date strings are carried through.
- **Normalize (M5):** parse `attributes.start_date`/`end_date` (and month/year fallbacks) into
  `research_pois.starts_at` / `ends_at` / `date_precision`. Apply the §15.3 validation: it must be
  a real **event** date, not a publish/scrape timestamp (e.g. reject Festivalando article dates).
  Records with no parseable event date keep `starts_at` NULL (they're treated as undated — see §6).
- **Merge (M8):** when rebuilding a canonical from its `research_pois` cluster:
  1. Collect each contributing row's `(starts_at, ends_at, date_precision)`; dedupe by
     `(starts_at::date)`; upsert into `canonical_poi_occurrences`.
  2. Set the canonical's representative `starts_at`/`ends_at`/`date_precision` = the **next
     upcoming** occurrence (min `starts_at >= now()`); if none upcoming, the **most recent** past
     one. Recompute on every merge (cheap, deterministic).
  3. Recurring editions already collapse to one canonical (overview §15.5), so this naturally
     yields one POI with many occurrences — not duplicates per year.
- **Recompute job (optional, later):** because "next upcoming" drifts as time passes, a lightweight
  scheduled task can refresh `canonical_pois.starts_at/ends_at` from occurrences (or compute it
  purely in the read query — see §5, which avoids needing the job at all for filtering).

---

## 5. Read path & API

Touch points: `lib/db-map/sql/pois.ts`, `lib/db-map/contracts/map-app.ts`,
`apps/map/src/app/api/pois/route.ts`, `apps/map/src/app/api/pois/[id]/route.ts`.

### 5.1 Expose dates + derived status

- **`listPoisGeoJson`** — add `starts_at`, `ends_at`, `date_precision` to each feature's
  `properties` (NULL for permanent POIs). The client can render the date and compute status, so
  status need not be stored or even computed server-side for the list.
- **`getPoiById`** — return `starts_at`, `ends_at`, `date_precision`, a derived `status`
  (`upcoming`/`ongoing`/`past`, computed from `now()`), and `occurrences` (array of
  `{starts_at, ends_at, date_precision}`) for recurring events.

### 5.2 Optional date-range filter on `/api/pois`

Add optional query params `from` and `to` (ISO dates):

- **No `from`/`to`** → current behavior (return everything; events shown regardless of date).
- **`from`/`to` provided** → return permanent POIs **plus** events whose dates overlap `[from,to]`:
  ```sql
  WHERE (
    p.starts_at IS NULL                                   -- permanent POIs always shown
    OR EXISTS (                                           -- any edition overlaps the window
      SELECT 1 FROM canonical_poi_occurrences o
      WHERE o.poi_id = p.id AND o.occurrence_range && tstzrange($from, $to, '[]')
    )
    OR p.event_range && tstzrange($from, $to, '[]')       -- fallback when no occurrences rows
  )
  ```
- Add `events_only=true` to drop permanent POIs (for an "events in this window" view).
- Keep the bbox + category filters; these compose with the date filter.

### 5.3 Contracts

Extend `contracts/map-app.ts` (additive — keeps the app compiling):

```ts
export interface PoiFeatureProperties {
  id: string; name: string; category: string | null; photo_url: string | null;
  popularity: number;
  starts_at: string | null;     // ISO; null for permanent POIs
  ends_at: string | null;
  date_precision: string | null;
}

export interface PoiOccurrence { starts_at: string; ends_at: string | null; date_precision: string | null; }

export interface PoiDetailRecord {
  // ...existing fields...
  starts_at: string | null;
  ends_at: string | null;
  date_precision: string | null;
  status: string | null;        // 'upcoming' | 'ongoing' | 'past' | null (permanent)
  occurrences: Array<PoiOccurrence>;
}
```

Run `pnpm --filter @lib/db-map app:contract:generate` and commit the regenerated JSON.

---

## 6. Status semantics (computed, never stored)

Given `now`, `starts_at` (`s`), `ends_at` (`e`, default `s` if null):

- `s > now` → **upcoming**
- `s <= now <= e` → **ongoing**
- `e < now` → **past**
- `s IS NULL` → not an event (no status / no badge)

Computed client-side from feature properties for the map, and server-side in `getPoiById` for the
drawer. For recurring events, status reflects the **representative** (next/most-recent) occurrence.

---

## 7. Frontend (the user-facing filter — shipped last)

Touch points: `apps/map/src/map/PoiDrawer.tsx`, `apps/map/src/map/PoiLayer.tsx`,
`apps/map/src/map/MapView.tsx`, plus new `useEventDateFilter.ts` (mirrors `usePoiCategory.ts`).

1. **Detail drawer (early, no filtering yet):** when `starts_at` is present, show a formatted date
   range (respecting `date_precision`) and a status badge (`Upcoming` / `Ongoing` / `Ended`).
2. **Date-range control:** a small popover (presets: "This weekend", "This month", "Custom
   range") that sets `from`/`to`. Persist like the category filter (localStorage). Only surface it
   when the active category `is_temporal` (or always, with events-only as an option).
3. **Wire into the POI query:** `PoiLayer` adds `from`/`to` (and optional `events_only`) to the
   `/api/pois` request; `MapView` owns the filter state alongside `category`.
4. **Marker affordance (optional):** dim/grey `past` events vs. highlight `upcoming` via a
   data-driven paint expression on `starts_at`/now (feature-state or a precomputed `status`
   property).

---

## 8. Phased rollout

- **Phase A — Storage + ingestion + display (no filtering).**
  Schema 3.1–3.4; `taxonomy.ts` `is_temporal`; normalize parses dates; merge writes representative
  dates + occurrences; read path returns dates; drawer shows date + status badge.
  *Acceptance:* a festival POI shows "Jul 3–6, 2027 · Upcoming" in the drawer; a garden shows no
  date UI; `SELECT count(*) FROM canonical_pois WHERE starts_at IS NOT NULL` > 0 after a festival
  ingest; recurring festival has multiple `canonical_poi_occurrences` but one `canonical_pois` row.
- **Phase B — Occurrence-accurate data.**
  Backfill/verify `canonical_poi_occurrences` for recurring festivals; representative-date refresh
  (query-time or scheduled).
  *Acceptance:* querying occurrences returns each known edition; representative date is the next
  upcoming edition.
- **Phase C — User date filter.**
  `/api/pois` `from`/`to`/`events_only`; `useEventDateFilter` + UI control; markers reflect status.
  *Acceptance:* selecting "This month" shows only events overlapping the month (plus permanent POIs
  unless events-only); permanent POIs unaffected when no date filter is set.

---

## 9. Edge cases & considerations

- **Undated events.** A festival with no parseable date keeps `starts_at` NULL. Decide UX: treat
  as "date unknown" (still plotted, excluded from date-filtered views) — recommended — vs. hidden.
- **Date precision in the UI.** Render by `date_precision`: `year` → "2027"; `month` →
  "July 2027"; `day` → "Jul 4, 2027"; `datetime` → include time. Don't show fake precision.
- **Timezones.** Store UTC. Festivals are day-level so DST rarely matters; for datetime-precision
  events, consider storing the event's local timezone (or deriving from coordinates) for correct
  local display. Acceptable to defer until we ingest time-precise events.
- **"Next upcoming" drift.** The representative date goes stale as time passes. Two options:
  compute it in the read query from occurrences (no job needed), or a periodic refresh. Prefer
  query-time for correctness; denormalized column is just a cache/sort key.
- **All-past festivals (discontinued).** No upcoming occurrence → representative = most recent
  past; status `past`. Default map view may choose to de-emphasize or hide these.
- **Sorting.** Search/list can sort events by `starts_at` (soonest first) and break ties by
  `popularity`.
- **Performance.** The GiST range indexes (3.1, 3.3) keep date-overlap filters fast even at
  millions of rows; bbox + date + category filters compose in one query.

---

## 10. Summary of changes

| Area | Change |
|---|---|
| `canonical_pois` | `+ starts_at, ends_at, date_precision, event_range` (+ GiST/btree indexes) |
| `canonical_categories` | `+ is_temporal` (set in `taxonomy.ts`) |
| `canonical_poi_occurrences` | new table — one row per edition; source of truth for recurring events |
| `research_pois` | `+ starts_at, ends_at, date_precision` (parsed in normalize) |
| Ingestion | normalize parses/validates event dates; merge builds occurrences + representative dates |
| API / contracts | dates + derived `status` + `occurrences`; optional `from`/`to`/`events_only` on `/api/pois` |
| Frontend | drawer date + status badge; later a date-range filter control + query wiring |

No change to permanent POIs, the two-layer model, NULL-ness processing, or conflation — this is
purely additive temporal support.
