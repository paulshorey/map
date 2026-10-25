# Ingestion next decision — 2026-10-25

The two named coordinate slots stay. Storage, publication precedence, and the
map's primary latitude/longitude column stay as they are. The next ingestion
action is the two-record Biennale.com preflight already specified in the
[2026-10-20 review](location-review-20261020.md). It runs from the primary
checkout after a fresh quiescent control check. This cloud checkout confirmed
the live gap and did not launch the run.

## How the two locations are managed

Each processed record can keep two coordinate observations with independent
owners:

| Slot | Meaning | When it is empty |
| --- | --- | --- |
| `source_coordinates` | The validated pair extracted from the listing, including a source-URL coordinate | The listing had no usable pair |
| `inferred_coordinates` | The forward geocode of the captured address, locality, and country text | There was no listed-text query, or the forward lookup missed |

The scraped address text is kept as listed fields and as the forward query.
It becomes a map point only when that forward lookup resolves. A second
source-native point stays in raw evidence and cannot occupy the inferred slot.
Equal pairs keep both observations and draw one marker. Different pairs draw
two markers and open the same POI. Nothing is averaged, and a nearby reverse
result never moves a valid source point.

The published `lat`/`lng` column is the source slot when that slot exists,
otherwise the inferred slot, otherwise the retained legacy point. That column
is the compatibility point for older readers. It is not a claim that the
source pair is the true venue. Details and the `locations` array expose both
named values. Country, city, region, and street text still prefer the captured
listing; reverse text fills gaps and is labeled `reverse_geocode`.

Warnings already recorded on the geocode artifact cover a reverse country or
region that disagrees with the listing, a reverse object more than 1 km from
the queried point, and a forward result outside the listed country. Those
warnings describe the activated point. They do not choose between the two slots.

## Why this is sufficient

Venice is the live proof. Its canonical build is `canonical-build-v5`, with
source `45.433, 12.3597` from Biennial Association and inferred
`45.4346809, 12.3509152` from the Biennale.com listing text. The points are
about 710 m apart. Both markers open the same POI, and each owner is an active
build input. Gurtenfestival and Big Day Out show the two failure directions
the slots are meant to preserve: a listed country can be right while the
captured point is wrong, and a captured point plus its reverse country can be
the better event reading while the raw country text is wrong. A global rule
that always prefers coordinates, or always prefers text, would erase one of
those cases.

The expanded review already checked the read path: 80/80 detail responses and
81/81 marker queries matched the saved snapshot. Isolated fixtures cover equal
points and a single slot. The contract does not need another storage shape
before that behavior is produced for more than one live record.

## What the database still shows

Read-only checks at 2:31 PM CDT on 2026-10-25, with maintenance off and no
workers or source locks:

| Published builder | Canonicals |
| --- | ---: |
| `canonical-build-v1` | 38,462 |
| `canonical-build-v2` | 2,435 |
| `canonical-build-v5` | 1 |

40,898 published canonicals exist, and 1 has a named coordinate slot. Research
location enrichment is `location-v3` on 1 row, `location-v1` on 2,673, and
absent on 43,414. Among the Biennale.com pair the preflight would select by
file order:

| Record | Normalization | Geocode | Published builder |
| --- | --- | --- | --- |
| Venice Biennale | `hybrid-v6` accepted | `locationiq-location-v4`, both slots, forward resolved | `canonical-build-v5` |
| São Paulo Biennial | `hybrid-v6` accepted | none | `canonical-build-v1` |

São Paulo already has its source point `-23.5874, -46.6576` and no inferred
slot. Gurtenfestival and Big Day Out remain `canonical-build-v2` with no named
slots. The Gurtenfestival point is still `6.9185, 7.4402`. These counts match
the 2026-10-20 review, so the corpus has not moved since that packet.

## What stays unchanged until the preflight

- No schema migration and no third coordinate slot.
- No change to which slot becomes the primary `lat`/`lng`.
- No country-precedence or marker-rendering change for Gurtenfestival.
- No database reset, broad reimport, or restart of the old Dyrt continuation
  `6aca981a-9234-4efd-ad72-1b6585bb0784`.
- No overlapping-marker chooser in this ingestion step. That remains a map
  interaction defect, reproduced for 10 POIs, and it can ship separately
  without changing POI data.

Human field judgments are still the input for a later coordinate repair.
Gurtenfestival's replacement point is not established. Big Day Out's 2014-01-17
edition is still uncertain. The preflight does not need those judgments.

## Next run

From the primary checkout, after `ingest:control list --json` is quiescent:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennale_com.json --category art_fair --limit 2 \
  --max-llm-requests 2 --max-cost-usd 0.10 --geocode-limit 4
```

`--limit 2` freezes the first two extracted records. In
`data/poi/art-fairs/biennials/biennale_com.json` those are Venice Biennale and
São Paulo Biennial. Acceptance is a new job, run, and execution; Venice retains
both current slots with no new provider request; São Paulo gains a
`location-v3` artifact whose source slot is the captured pair and whose
inferred slot is the forward geocode of its listed address, or an explicit
forward miss; the canonical lineage matches those artifacts; the provider
ledger accounts for every call; the worker and source lock exit. Inspect a
partial or budget-held result. Do not resume that two-record cohort as the
remaining 43-record file.

The coordinator snapshot on this cloud VM refused to run because `origin`
contains an access token and fails the `paulshorey/map` checkout check. Direct
`ingest:control list --json` succeeded. Launch the smoke from the primary
checkout the coordinator accepts.

## After that preflight succeeds

1. Add a non-blocking geocode warning when the two slots are both present and
   more than 1 km apart, using the same distance guard as
   `reverse_result_too_distant`. Store it on the artifact. Leave both slots and
   the primary column unchanged. Venice at about 710 m would stay unflagged.
   A Gurtenfestival-scale source/text split would become queryable once that
   record has both slots.
2. Rebuild current sources onto `canonical-build-v5` one file at a time, only
   where the preflight's provenance checks pass. Keep completed cohorts and
   immutable artifacts.
3. Repair an individual source coordinate only with an evidence-backed
   replacement and a field judgment bound to the packet hash.
4. Reconcile queue advisories and capture-readiness notes against the files.
   The Dyrt advisory and the inaccurate readiness notes stay out of the launch
   path.
5. Ship the overlapping-record chooser as its own map change when display work
   is in scope.
