# Versioned location assessments

## Correction — 2026-10-25

PR #62 merged the acceptance gates below into main (`88bf967`). That merge was
not a merge into PR #61; #61 is still the open decision note at `e488974`.
Relative to the clarified goal, the merge was a product mistake. Conflicting
source and address-derived locations must remain ingestible, visible, and
analyzable.

`matcher-v3` and `canonical-build-v7` keep the immutable assessment history,
including `evidence.distance_m` whenever both points exist, and remove
acceptance from matching, canonical publication, consolidation, and checkpoint
reuse. Venice's roughly 710 m split stays `needs_review` and still publishes
both markers. PR #64 fixed stale canonical retention after completed rematches,
and #63 merged the combined correction into main as `1d5e7e8`. The additive
migration is now applied; one two-record smoke succeeded. The
[preflight receipt](biennale-location-preflight.md) records exact identities,
provider accounting, evidence, and the remaining ingestion hold. Applying the
migration alone would not have removed the withdrawn gates.

The sections below describe the withdrawn gate. They are the record of what #62
shipped, not the current publication contract. The current contract is the
runbook section "Location assessment".

This implements the accepted next step after the 80-POI location review, on a feature
branch based on main `27666a5`. Imports and providers remain held. The shared database
receives no migration, assessment activation, POI repair or ingestion run during development.
Maintenance admission was closed for runtime edits; validation uses disposable local PostgreSQL.

## Decision contract

`location-assessment-v1` records immutable inputs and an explicit outcome:
`accepted`, `needs_review`, or `unlocated`. It binds the observation, normalization,
resolved geocode, original captured payload, projection point/provenance/precision/locality,
geocoder version and validation snapshot. SHA-256 input hashes include the policy
version. Repeating the same assessment reuses its ID; changed evidence appends a row.
Database updates to assessment rows are rejected; explicit POI cleanup can still cascade.
The research record points to its current assessment; accepted builds retain their own
assessment IDs. Nothing backfills historical records merely by deploying the feature.

The first policy accepts a **discovery point** when both point-precision candidates
agree within 250 metres, with a recognized listed country and no bound conflict. It
prefers the source candidate only in this agreement case. For a single candidate it
requires point precision, a reverse result bound to that same point, matching listed
country and city, and a finite reverse distance of at most 1 km. An inferred candidate
must also match the saved forward result and retain its query. Country-filtered forward
results do not count as independent country confirmation. Agreement is a consistency
signal, not verified ground truth. Venue/entrance and event-edition verification remain false.

Country/region conflicts, disagreeing points, coarse candidates and missing evidence
produce review outcomes; they never silently select whichever field seems more plausible.
Bad source points and the original listed text remain in observations/artifacts. The
assessment cannot manufacture an absent coordinate or reinterpret legacy evidence slots.

`matcher-v2` uses the accepted point for candidate generation and scoring. An unresolved
record is quarantined before a match decision or membership is written. Merging into an
existing canonical requires current accepted assessments for its members. Canonical
consolidation applies the same gate and skips unresolved records before planning.
`canonical-build-v6` requires accepted assessments for every current member, checks
cross-member point/country agreement, selects among accepted points and records assessment IDs in
build inputs/hash. Both coordinate evidence slots remain available through the API.

An uncertain refresh preserves the previous accepted serving snapshot, including its
fields, children and build pointer. A new unresolved record stays unpublished. Explicit
retirement, exclusion and cleanup still remove affected output from publication. Global
lineage verification distinguishes a retained accepted snapshot awaiting location review
from a broken membership cache; it also checks assessment lineage for new builds.
Checkpoint and batch reuse require current policy/snapshot and matching build-input
assessment IDs. The paid geocoding cache namespace stays unchanged. Future assessment
policy changes must bump the matcher/builder versions as well as the assessment version
so whole-file completion proofs also become stale.

## Regression evidence and present data

`scripts/ingest/fixtures/location-assessment-review.json` extracts location evidence from
packet `bc31c236-7b35-4903-b619-5fa16f95771d`, observed 2026-10-20. It retains all 94
research/build-member cases for 80 POIs, their source identities, original case IDs and
evidence hashes. Expected outcomes are conservative policy expectations, not new human
labels. The only previous human country label does not become coordinate acceptance.

The read-only preview on 2026-10-25 found all 94 selected research records. It produced
93 `missing_or_stale_coordinate_evidence` outcomes and one
`coordinate_candidates_disagree` outcome (Venice, about 710.5 m). All 94 need review
under the new policy; this is not a count of 94 proven wrong locations. The shared
database had zero application writes and zero provider calls for that preview. Detailed
results remain private in the primary checkout's ignored
`.ingest-jobs/location-assessments-20261025/live-preview.json`.

The suite also covers Gurtenfestival and Big Day Out contradictions, ordinary and
campground records, source-only and inferred-only cases, equal points, missing points,
stale/policy-changed inputs, immutable reuse, real matching/publication, API marker
geometry, current checkpoint reuse and record quarantine. Network access is replaced
with a throwing stub in database integration tests. CI uses its own PostgreSQL service
without repository provider secrets.

## Evaluation and rollout

1. Review the policy and its conservative acceptance/false-rejection tradeoff, especially
   the 250 m point threshold and 1 km reverse guard. A green test suite establishes
   implementation consistency, not factual venue correctness.
2. Inspect Venice's source and inferred points separately. Keep the venue/entrance and
   edition unresolved until explicit evidence supports a field-specific judgment.
   Keep Gurtenfestival's listed Switzerland country separate from its captured point;
   keep Big Day Out's country, venue and 2014 edition uncertainty separate as well.
3. Review and merge the PR, then apply the additive migration through the normal database
   rollout before running the new ingestion code. Existing serving builds require no sweep.
4. Keep the ingestion hold until a small, explicitly selected cohort has current evidence
   and reviewed expectations. Use cached evidence first; if evidence is absent, choose
   one source and authorize a bounded 1–5 record preflight with the managed interface.
   A provider-enabled preflight has **not** run as part of this change.
5. Review every new assessment reason and accepted point, compare published API/map output
   with its build inputs, and verify rejected refreshes preserve prior publication. Resolve
   one demonstrated cause at a time (capture, assessment, matching, display or missing
   historical evidence). Do not relax thresholds merely to make an import complete.
6. Retry quarantined records only after their cause changes, using the existing owned-
   maintenance `ingest:issues resolve --action retry` workflow. No unbound manual coordinate
   override or historical coordinate correction is introduced by this feature.

Provider-free commands and CI are documented in the ingestion runbook. The new
`ingest:location-assess --records <UUID,...>` command is a bounded read-only preview,
safe before the assessment migration because it queries only existing input artifacts.

## Validation completed

- Provider-free regression selection: 196 tests, 195 passed and one optional legacy
  review SQL sampling test skipped. This includes 114 assessment tests, all 94 packet cases.
- Isolated PostgreSQL integration: real assessment immutability/reuse, matching, publication,
  list/detail marker SQL, equal evidence, stale-input/policy rejection, retained serving
  snapshots, checkpoint/batch reuse, record quarantine, unlocated artifacts and cleanup passed.
- The existing canonical-cache regression passed against its named disposable database.
- The additive migration applied both through the complete migration chain and over a copy
  of merged main's schema. A published legacy row was byte-for-byte unchanged, and zero
  assessments were backfilled. `db:sync` regenerated schema/types/contracts on local PostgreSQL 18.
- Database package and map app type/contract checks passed. The CI workflow runs the packet,
  database integration and existing location/resume contracts without provider secrets.

These checks exercise the deterministic policy and real database/API helpers. They do not
establish provider availability, venue truth, deployed map behavior or acceptance of the
new policy's thresholds. The shared database migration remains unapplied pending PR rollout.
