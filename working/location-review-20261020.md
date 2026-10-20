# Read-only coordinate and presentation review — 2026-10-20 UTC

Baseline: merged main `0824b9db41a80bde6fb0f58475ca364048ed07b0`.
The app, POI API queries and map coordinate SQL were unchanged during validation.
Diagnostic exporter changes are on `codex/location-review-v2`.

## Evidence packet

Private primary-checkout evidence root:
`lib/db-map/.ingest-jobs/location-review-20261020-main/`.
Start with `index.html` and `REVIEW.md`; immutable final export is `packet-final/`.
Packet ID: `bc31c236-7b35-4903-b619-5fa16f95771d`.

The packet contains **80 distinct canonical POIs, 94 current build/source-member
pairs, and eight sources**. Mandatory cases are Venice Biennale, Gurtenfestival
and Big Day Out's captured Auckland edition. Source-balanced seeded comparisons
include JamBase, That Festival Site, Dyrt, RIDB, Biennale.com, Biennial Association,
California hostels and Aurillac. Ninety-one members have exact-normalization
verification; three selected members lack managed verification and say so.
Selection is diagnostic and biased toward useful cases, not a source error-rate study.

The database was available. Of 40,898 published canonicals, 38,462 use builder v1,
2,435 use v2, and one uses v5. No historical backfill was inferred or performed.
Within the selected packet, 79 unique POIs lack named coordinate slots; 43 have
no bound reverse evidence in any selected member. Thirty-five POIs have candidate
differences, including lexical/admin differences and source contradictions.

## Results and interpretation

- All 80 detail API checks and 81 tight viewport/marker checks passed. Saved name,
  description, website, address, dates, primary point and named evidence agree with
  the final database snapshot. Every coordinate owner is present in the active build.
- Browser checks opened the intended drawer in 71 of 81 live marker visits; ten
  target POIs were obstructed by co-located records. Two initial campground address
  assertions were corrected for display whitespace and passed on retry; original
  screenshots already showed the intended drawers. No application change was needed.
- Venice retains source `45.433,12.3597` from Biennial Association and inferred
  `45.4346809,12.3509152` from Biennale.com. Both markers independently open the
  same POI. This establishes provenance and locality agreement, not an entrance.
- Seven isolated SQL/browser fixtures cover distinct/equal points, either single
  slot, legacy, invalid origin and stale-primary evidence. Equal points retain both
  evidence entries and show one marker. They are fixtures, not imported examples.
- Gurtenfestival still carries JamBase's `6.9185,7.4402`, while the listing says
  Switzerland and saved reverse evidence says NG. The source-point contradiction
  survives faithfully through the old canonical/API. An edition-specific correction
  needs source evidence; changing display or globally preferring reverse country
  would address the wrong layer. Paul's prior Switzerland-only judgment stays bound
  to its original packet; no new human judgments were manufactured.
- Big Day Out's captured 2014-01-17 edition has an Auckland-area point and saved NZ
  reverse evidence; its raw Australia/country-as-city hint is retained. The old
  canonical uses NZ under its recorded coordinate-lookup policy. Event/venue accuracy
  remains uncertain without edition-specific evidence.
- Fourteen That Festival Site members contain state/region strings such as Florida,
  NSW and VIC in the raw country field. These are source-field semantics, not proof
  of a geocoder failure. Seven saved reverse results exceed the distance guard.
- Upper Little Truckee and Sitkoh Lake (west) Cabin display ranger-district mailing
  addresses supplied by the source. Whether these describe the actual POI versus an
  administrative contact remains uncertain. Do not accept them as venue entrances.

## One narrow product follow-up

**Allow choosing among overlapping POIs.** Main's click handler reads only
`e.features[0]`. At high zoom, different POIs sharing a coordinate render on top of
each other; clicking repeatedly opens one record without a way to select the others.
Ten selected POIs reproduced this interaction problem. Examples:

- Aurillac: festival `4617aaea-c786-4c52-b8a0-c19d517b93d1` and Champ Libre!
  `bcad7999-788a-4ecf-8306-d316473587d9` at `44.9286,2.4437`.
- Sail Across the Sun: 17 distinct POIs share `25.7849,-80.1896`.
- Sun, Sand and Soul: five distinct events share `30.3776,-86.3668`.

Scope: point-click handling and a compact chooser in `apps/map/src/map/`; deduplicate
clicked candidates by shared POI ID so two coordinate markers belonging to one POI
still open its single drawer. Keep existing cluster expansion and marker identities.
Show name and available captured date/category so editions can be distinguished.
Do not merge distinct records or change coordinates to work around overlap.

Acceptance: both Aurillac records and all 17 cruise records can be selected at high
zoom; a single POI opens directly; either Venice point opens the same detail; equal
evidence still renders one marker; keyboard dismissal/selection works. Validate with
saved API fixtures and browser interaction before any live data repair.

## Deliberate next ingestion scope

Recommend a **new two-record Biennale.com preflight** over the existing capture,
Venice plus São Paulo, before considering the 43-record file's current-version
repair/verification. This reuses a small, known, category-consistent source and
compares v5 evidence with a legacy example. It is not a new backlog drain.

Offline source/parser preflight found 43 records, 43 unique IDs and 43 range-valid
coordinate pairs. Current capture SHA matches inventory:
`76608f73a5c939b187638d92a076975e84f473fdae1fff0e900d25066c2706a7`.
Numeric validity does not establish venue accuracy. Exact selected IDs and the
parser-validated command are in private `next-scope.json`.

Proposed command, **not run**; it permits provider calls and therefore belongs to
a later provider-enabled step after review:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  data/poi/art-fairs/biennials/biennale_com.json --category art_fair --limit 2 \
  --max-llm-requests 2 --max-cost-usd 0.10 --geocode-limit 4
```

Require exact job/run/execution IDs, per-point source/geocoder provenance, current
canonical lineage, provider ledger accounting and released worker/locks. Inspect
partial/budget-held output instead of automatically retrying. The frozen two-record
cohort must not be resumed as though it were the remaining file.

The queue's first advisory action points at old Dyrt continuation
`6aca981a-9234-4efd-ad72-1b6585bb0784`, a failed September normalization run with old
pipeline versions. Current data exists and later source work exists; that advisory
is not authority to restart it. Whole-file/current-version verification is distinct
from historical success: queue counts are 1 inspect, 4 verify, 148 start, 17 review,
77 blocked and 0 currently complete under its assessment. No inventory refresh or
operator classification was written during this review.

New-capture notes were checked rather than trusted. Carnifest's purported art-fair
capture contains carnivals and other festivals. Two art-directory candidates have
duplicate identities, while Biennial Foundation includes an Adelaide record with
Australia's country-centroid coordinate and `Various` locality. They need readiness
work before selection; none was imported or reclassified.

## Human evaluation and operating state

1. Open `index.html`, inspect the mandatory cases, then choose ordinary cases from
   each source. Use filters to separate conflicts, missing evidence and overlaps.
2. For each field, decide source correctness, event/edition correctness and lookup
   correctness separately. Missing optional data is not automatically incorrect.
3. Use official edition-specific venue evidence when resolving uncertainty. Record
   only checked fields in a dated copy of `decisions.template.json`, retaining its
   packet ID, case ID and evidence hash. Leave other fields unreviewed.
4. Run the documented offline `summarize` command. Labels propose repairs; they do
   not authorize changing canonical trust, merging rows or rewriting captures.
5. Prioritize the overlap chooser independently of any source-coordinate repair.
   Then approve the bounded preflight if current-version data upgrade is desired.

Shared POI database writes: zero. New ingestion jobs/provider calls: zero. Browser
mutation requests were intercepted, external requests blocked and the basemap
replaced with a local blank style. Screenshots establish marker/drawer behavior,
not geographic imagery validation. Only an isolated disposable loopback PostgreSQL
database received fixture writes. Both ingestion heartbeats remain paused; no
maintenance gate, scheduler, source capture or provider setting was changed.
