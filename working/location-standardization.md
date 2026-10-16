# Location standardization and rollout

## Post-merge checkpoint repair — 2026-10-16

PR #47 merged as `20ec60a3222ffeceb8a25ac974f561e98f4c15a9`. Two subsequent review
findings were confirmed against that main revision:

- Compatible older-geocoder resumes could seed only geocode pending while completed
  downstream checkpoints still matched the old artifacts. Geocode activation then changed
  the embedding/build without requeueing those checkpoints. Successful/reused managed geocode
  completion now requeues only later completed tasks in the same fenced transaction as
  activation. Unchanged artifacts remain reusable; earlier normalization is left completed.
- Region-only enrichment changed `buildEmbedText` but retained the old vector and active
  embedding ID. Both are now invalidated for region changes, as for city/country changes.
  Address-only changes and unchanged locality retain the embedding.

Database-free regressions exercise the real scheduler, activation transaction and task
completion against an in-memory database boundary, plus cached `runGeocode` activation.
The original implementation fails both targeted cases. The repaired suite checks completion
order, fresh build input IDs, preservation of prior attempt evidence and address/point
preservation. These mocked checks are not live PostgreSQL or provider validation.

The follow-up branch is `codex/location-downstream-requeue`, based on fetched main, separate
from the completed location branch and the diagnostic branch. PR #48's diagnostic patch
remains independent. It still targets `codex/location-standardization`; retarget it to main
and synchronize main into its own branch before merge. A read-only trial merge reports a
conflict in `providers/locationiq.ts` caused by the squash ancestry. At this inspection,
main's file is identical to the old location branch's file, so resolution must preserve the
diagnostic changes, including error origins and provider phases; review/retest the actual
resolved head. Do not modify or force-push that separately owned branch from this task.

The serious operational hold remains. Fresh control at 2026-10-16T09:05:26Z was quiescent
with no workers/source locks/admitted scripts/claims. The gate belongs to the completed
diagnosis; it was not reopened or replaced here. Both ingestion heartbeats remain paused.
No full restart is authorized.
Historical baseline and rollout notes below describe the earlier investigation; subsequent
diagnosis supplied successful Taipei/JamBase sample receipts but did not prove the cause of
the intermittent DB connection failure. This repair requires later controlled integration
validation when the human authorizes restarting; no database rollback test was run here.

Owner chat: `01a139a6-1dec-73e3-a8fa-46d8c4e14a56`. Human request: 2026-10-15.

## Baseline audit

Read-only repeatable-read audit at 15:45 UTC, before repairs:

| Scope | Records | Missing street address | Missing structured country code | Missing city | Missing region |
| --- | ---: | ---: | ---: | ---: | ---: |
| All canonical POIs | 38,471 | 21,016 | 38,471 | 38,471 | 38,471 |
| Dyrt linked research rows | 43,100 | 24,844 | 43,072 | 18,791 | 0 |
| Biennale.com research rows | 43 | 0 | 8 | 0 | 43 |
| Biennial Association research rows | 41 | 41 | 8 | 0 | 41 |

38,464 canonical POIs were published. The sole invalid `(0,0)` canonical was the already
hidden Wetmore artifact with no active memberships; it remains as historical evidence,
not a published point. Source country/city/region columns were not selected by the builder,
so canonical attributes did not receive them. The finite country-name lookup omitted
several valid countries and accepted arbitrary two-letter strings.

Private audit/maintenance evidence is under the primary ignored
`.ingest-jobs/location-standardization-20261015/`. Use `ingest:location-audit --json` for
repeatable current counts by canonical publication status and research source, including
missing fields, enrichment coverage, conflicts, remembered misses and inferred addresses.
No external calls or writes are performed by that audit.

## Location contract

1. **A validated coordinate pair is the spatial anchor.** Reject the zero sentinel and
   invalid ranges; retain supplied valid points. A reverse result's nearby object coordinate
   never replaces that anchor. Record source precision, and never attach an inferred street
   address to a city/region centroid.
2. **Official/source text wins.** Preserve supplied street/postal address, city and region.
   JamBase's flat `venue_address` is source address evidence too. Normalize country names,
   alpha-2, alpha-3 and numeric codes using pinned ISO data plus explicit aliases. Do not
   infer a country from an ambiguous state/city label alone.
3. **Fill gaps with the existing LocationIQ service.** The managed geocode stage first
   forward-resolves a missing point; a valid point can then receive administrative/address
   enrichment. Fully supplied records need no reverse request. Reverse streets are approximate
   and labelled `reverse_geocode`, never official. House/road fields are used instead of a
   fabricated full display address. Region code and postcode are retained when supplied by
   the provider; region display text stays source-first.
4. **Make uncertainty explicit.** Preserve country/region conflicts, distant-result warnings,
   misses, provider attribution, selected values and per-field derivation in the immutable
   geocode artifact and active `location_enrichment` projection. A result more than 1km away
   supplies no missing fields. An optional miss does not discard a POI that has valid coordinates.
   Transport/auth/service failures remain provider errors, never cached as misses.
5. **Cache and invalidate deliberately.** Reverse keys use exact coordinates and policy version.
   Active enrichment also binds normalization ID and point; changing either requires reassessment.
   Normalization caches include their deterministic packet, so changed country/date facts cannot
   hide behind a previous hash. New geocoder/build versions identify this contract. Reviewed compatibility preserves old
   structural proofs; the location audit separately identifies missing enrichment, and a deliberate
   resume rechecks location readiness rather than blindly adopting coordinate-only checkpoints. Preserve old observations, artifacts, attempts and memberships.
6. **Publish selected location fields with provenance.** Canonical `attributes.country_code`,
   `attributes.city` and `attributes.region` follow the elected point's neighbourhood and country.
   Source addresses outrank reverse addresses. Canonical field provenance identifies the member
   and derivation; the active build records the location artifact ID.

LocationIQ's normalized reverse schema exposes country/state/city/address components;
Nominatim documents that reverse results identify the closest suitable map object rather
than calculating an exact address. See [LocationIQ reverse API](https://docs.locationiq.com/reference/reverse-api)
and [Nominatim reverse semantics](https://nominatim.org/release-docs/latest/api/Reverse/).
Country data uses pinned [i18n-iso-countries](https://github.com/michaelwittig/node-i18n-iso-countries).

## Rollout and historical repair plan

- Apply the additive reverse-cache payload migration under owned quiescent maintenance.
- Run country/conflict/address/coordinate/cache and source-wrapper tests, types/contracts,
  then a real PostgreSQL activation/canonical test with all writes rolled back and mocked provider.
- Validate 1–5 real records, covering an old missing country and the two new source formats.
  Compare original points/addresses, canonical fields/provenance, provider calls and lineage.
- Review/publish the change, synchronize compatible code and dependencies to primary,
  and run two distinct approved sources under their own detached supervisors. Keep GLM
  Priority/256. Shared DB canonical serialization and normal provider recovery remain in force.
- Historical 38k canonical records are **not** mass-enriched by deploying this code. Rebuilds
  publish their available member fields; missing research fields require managed, source-scoped
  location work. Preserve completed cohort receipts. Plan a separate staged backfill, beginning
  with deterministic source-country repair and bounded existing-record checks; do not restart
  Dyrt or issue tens of thousands of reverse requests implicitly during this rollout.
- The two-hour coordinator runs the location audit and monitors newly processed sources:
  unchanged valid points, retained official addresses, canonical administrative fields, conflict
  rates, missing-field rates, cache reuse, misses, provider errors/latency/quota and known/unknown cost.
  Diagnose any sample conflict before full admission; widespread incorrect enrichment or a
  systemic fault stops all ingestion under maintenance and pauses the coordinator for human review.

## Selected next sources

JamBase: 1,257 unique natural event IDs, all names/cities/countries and valid coordinates;
1,233 supplied venue addresses, 644 missing regions. That Festival Site: 1,415 unique IDs,
all names/cities/countries/valid coordinates, no supplied region values. Both wrap records
in `festivals`; explicit registered wrappers and camel-case JamBase date aliases avoid
rewriting the original captures. Capture dates/edition status are historical evidence, not
current event availability. Source listing URLs remain separate from official websites.

Carnifest's supposed art-fair file mixes carnivals and music festivals. Defer unchanged
full admission until category routing is reviewed. Existing RIDB/BGCI/OSM/Wikidata/USCampgrounds/
Ireland source holds remain; this administrative enrichment does not cure their distinct issues.


## Current hold and review handoff

The first bounded live validation (Taipei only) failed on `database_pool_checkout_timeout`
at 2026-10-15T16:07:14Z, after successful fresh GLM normalization. Its pool evidence was
max16/total3/idle1/waiting0 with only the source-lock holder recorded. Three subsequent
read-only fresh-connection probes succeeded in190–271ms; server reported9connections
against max500. This does not prove the network/proxy root cause or justify an unchanged
resume. The exact provider ledger records an attempted reverse request aborted with the database error before any HTTP status or usable cache entry was recorded. This does not establish reverse-provider health or a successful live location validation.

Per the human's serious-stop instruction, all ingestion is stopped, admission is held
under owned maintenance, and the two-hour heartbeat is PAUSED pending human restart/review.
The code remains on a reviewable feature branch; new full imports have NOT been launched.
JamBase and That Festival Site are prepared candidates, not validated full scopes. Exact
hold token, partial sample IDs, logs and next commands are in private receipts/automation
memory. Do not bypass the hold or substitute a new full run for the selected sample.

The partial test run `327fc664-1bf1-4e73-b807-7feb78d47f8b` is a SINGLE Taipei record,
not the completed41-record original run. Its accepted country normalization is retained;
geocode, embedding, matching/canonical and verification remain incomplete. Original source
observations and prior artifacts are preserved; no raw file was rewritten. Historical
repair remains deliberately staged, not a claim of mass backfill.
