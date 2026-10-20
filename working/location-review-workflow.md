# Location evidence review and calibration

The goal is a small, repeatable review of completed POIs that distinguishes a bad
source coordinate, a bad listed location, extraction/normalization loss, reverse
lookup limitations, and an incorrect canonical merge. The implementation and command
contract live in the [ingestion runbook](../data/poi-ingestion.md#reviewing-location-evidence-on-completed-records).
The existing `ingest:location-audit` remains the aggregate completeness report.

## Current review after the coordinate-model merge

The [2026-10-20 read-only review](location-review-20261020.md) covers 80 distinct
POIs and 94 source/build members from merged main. It records actual API/map
behavior, explicit legacy/missing-evidence limits, the narrow overlapping-marker
follow-up and a proposed next bounded scope. Its local searchable gallery and
immutable packet paths are listed there. New diagnostic exports use v2 evidence
fields and support a bounded canonical-ID manifest; see the runbook for syntax.
Earlier packets and their human judgments remain bound to their original hashes.

## Follow-up: complete field evidence — 2026-10-17

Verified two additional PR #53 findings against merged main after PR #54. Reverse
binding failures now cite the predicate that failed, including the artifact's own
normalization and newly exported status field; point mismatches cite both artifact
coordinates and the saved query point. Unrecognized country-name findings use the
same actual raw/captured name supplier as country conflicts. Focused fixtures first
reproduced both defects and cover each binding predicate, invalid points, multiple
failures, and absent/blank raw country-name fallbacks.

This is a read-only diagnostic repair. Original packets and human judgments are
preserved; re-export into a new directory after integration to get corrected locators.
Ingestion and its monitoring remain complete/paused for human location review. No
runtime, source, prompt, schema, data or trust-policy change is part of this repair.

Sampling and rendering must agree about reverse evidence binding. Only resolved
geocodes tied to the build's normalization and the saved valid query point can
occupy risk or baseline slots. Unbound evidence remains in the no-bound-reverse
group even when it carries old country/city warnings. Country disagreement
findings must name the actual raw or captured fallback fields used in comparison.

## What to trust before we have reviewed labels

Neither listed text nor reverse output is universal ground truth. Treat an official,
edition-specific venue address as strong event-location evidence. Organizer contact
addresses, export regions, country-as-city labels, and older venue editions require
care. Numeric range validity only establishes that a coordinate is possible.

A reverse lookup describes the neighborhood of a supplied point. It does not
independently identify the event. Nominatim's official guidance explains that reverse
lookup selects a nearby indexed object and may return another street's address.
Administrative categories can also vary by tagging and locale. LocationIQ describes
different street/rooftop coverage across regions. These support conservative comparison,
not changing all fields to either source text or geocoder output.

- [Nominatim reverse behavior and address classification](https://nominatim.org/release-docs/latest/api/Reverse/)
- [LocationIQ accuracy limitations](https://help.locationiq.com/support/solutions/articles/36000172493-what-is-the-level-of-accuracy-that-can-be-expected-)
- [LocationIQ reverse API](https://docs.locationiq.com/reference/reverse)

Gurtenfestival is a calibration example: Paul confirmed Switzerland, while the captured
JamBase point is `6.9185,7.4402` and its reverse country is NG. The source text can be
correct while its coordinates are wrong. Conversely, That Festival Site contains
Australia/country-as-city hints for a captured Auckland edition of Big Day Out. Neither
case licenses a global precedence change. Official event travel/venue information should
resolve a reviewed edition; an official contact office is not automatically its venue.

## One review round

1. Export a new frozen packet. Start with 40 source/build pairs across sources, balancing
   risk, baseline and missing-evidence strata. Use a fixed seed and retain population
   counts. A narrower source/run packet is useful for a suspected adapter. Baseline
   cases prevent reviewing only already-known failures; repeat source-specific random
   samples after the first human judgments if needed. Do not claim statistical accuracy
   from the prioritized sample.
2. Read `review.md`, beginning with country conflicts and point changes, then city/region
   and address differences. Consult `field-lineage.md` for description, source/official
   URLs, dates, original/captured values, normalized values, current canonical fields and
   coordinate owner. A canonical may have multiple source members; check their actual
   provenance rather than counting duplicates as independent confirmations.
3. Mark the fields the human actually checked. Keep "unknown" as `uncertain`; leave
   unreviewed fields out. Confirm the event edition and venue, language aliases,
   city-versus-municipality/region distinctions, entrances, and coordinate precision.
   A missing optional region/street address is a completeness gap, not a known wrong value.
4. Save a dated decision file alongside its original packet. It can be entered directly,
   or the human can supply case IDs and judgments in chat and the agent transcribes only
   those explicit judgments. Local `.ingest-jobs` is ignored, persistent, and has no
   automatic cleanup; preserve these review artifacts with the project evidence.
5. Run the offline summary. Keep results separated by source, field, stage, sampling
   stratum and correctness scope. Compare reviewed correct/incorrect counts and unknowns;
   prioritize recurring causes. Different sources can need different rules for text,
   coordinates, country, and address. Do not change a source's scalar trust score based
   on a handful of correlated or deliberately suspicious cases.
6. Propose a narrow rule change only after identifying the responsible stage. Add the
   reviewed cases as redacted regression fixtures, validate independent holdout cases,
   then follow normal owned maintenance, bounded live checks and PR workflow. Do not
   automatically repair production rows from a review label.

## Decision-file example

The generated template lists exact case IDs and hashes. Fill its reviewer/timestamp and
add only checked fields to `field_reviews` (copy actual IDs/hash from the packet):

```json
{
  "version": "location-review-v1",
  "packet_id": "COPY-PACKET-ID",
  "reviewer": "Paul",
  "reviewed_at": "2026-10-16T21:00:00Z",
  "cases": [
    {
      "case_id": "COPY-CASE-ID",
      "evidence_hash": "COPY-HASH",
      "field_reviews": [
        {
          "field_id": "listed.country",
          "scope": "event_location",
          "verdict": "correct",
          "evidence_url": "https://official-venue.example/edition-travel",
          "note": "Confirmed country for the captured edition; coordinates not reviewed."
        }
      ]
    }
  ]
}
```

Allowed field IDs and physical locations are in the packet, for example:

| Field ID                              | Owner step      | Physical field                                                      |
| ------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `listed.country` (JamBase)            | Source capture  | `research_poi_observations.raw` → `/venue/country`                  |
| `listed.lat` / `listed.lng` (JamBase) | Source capture  | Same immutable row → `/venue/lat`, `/venue/lng`                     |
| `captured.country_code`               | Extraction      | `research_poi_observations.captured` → `/country_code`              |
| `normalized.country_code`             | Normalization   | `research_poi_normalizations.country_code`                          |
| `reverse.country_code`                | Geocode         | `research_poi_geocodes.validation` → `/reverse/country_code`        |
| `canonical.country_code`              | Canonical build | `canonical_pois.attributes` → `/country_code`; packet pins build ID |
| `canonical.address`                   | Canonical build | `canonical_pois.address`                                            |

Use two separate judgments if a reverse field is correct for `coordinate_lookup` but
incorrect for `event_location`. This records a bad event point without falsely blaming
the reverse provider. Field IDs are compared only inside their packet; case IDs bind
build/source-member/artifact identity, and the evidence hash rejects stale labels if
the saved values or lineage change. Later rebuilds require a fresh packet; prior labels
remain evidence about their original snapshots.

## Findings and next actions

| Reviewed scenario                                                           | Follow-up                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct listed venue/country, wrong captured point                          | Review original capture adapter/provider; obtain an authoritative edition-specific point. Preserve immutable raw data; apply an audited mapping/override or new observation rather than guessing latitude digits.                            |
| Correct captured point, bad listed locality                                 | Keep the original text as a hint; adjust the source-specific extraction/admin policy and test independent records.                                                                                                                           |
| Raw/captured values correct, normalization wrong                            | Repair deterministic mapping/evidence validation; recompute only affected artifacts and downstream stages with reviewed cache invalidation.                                                                                                  |
| Reverse matches point but wrong event                                       | Coordinate/venue association issue. Keep both labels and evidence; do not classify it as a geocoder outage or train country precedence from it.                                                                                              |
| Reverse differs only by alias, municipality, entrance or approximate street | Mark the applicable fields correct/uncertain; improve comparison normalization or granularity, not published data by default.                                                                                                                |
| Correct normalized/enriched source, wrong canonical field/point             | Trace coordinate and field owners, linked memberships and active build inputs; review a bad merge or selection before a targeted rebuild.                                                                                                    |
| Missing reverse evidence                                                    | Remains unassessed. If it blocks the next decision, propose a separate 1–5-record managed, bounded provider-backed validation; retain exact query point/provider/time and avoid circularly treating the same lookup as independent evidence. |
| Broad wrong output or systemic failures                                     | Stop ingestion/supervisors through owned controls, retain evidence and pause the monitor under its serious-stop policy. A lexical difference alone does not trigger this.                                                                    |

## Validation and handoff

Implementation: `sql/ingestion-location-review.ts` is the only database reader;
`scripts/ingest/location-review/model.ts` classifies/renders and validates labels;
`scripts/ingest/location-review.ts` exports immutable folders or summarizes offline.
No runtime precedence, source file, schema, current worker or model/provider settings
are changed. Raw provider display-name responses were not retained historically;
the report honestly assembles reverse addresses from saved parsed components.

Focused tests cover coordinate/country contradictions and table/column/path ownership,
aliases, unavailable/unbound evidence, extraction/geocode/canonical point changes,
policy hints, stale labels, scopes, unknown/duplicate fields, strict bounds and
read-only timeout/release behavior. Package type/contract checks also apply.

Initial read-only validation and review output is retained in the primary checkout's
`lib/db-map/.ingest-jobs/location-review-20261016-*` folders. The first export exposed
a completion-binding limitation: older Dyrt normalization observations do not match
frozen cohort observation IDs. The final selector uses successful source/record verify
checkpoints and reports exact normalization/observation versus record-only binding;
it does not silently present old observations as today's verified artifacts. One
ad hoc correlated coverage query hit its 5-second statement bound; a bulk materialized
read completed instead. This was a bounded diagnostic query timeout, not evidence of
a connection checkout failure. No timeout/pool/retry setting was changed.

Final live packet: `/Users/pshorey/git/map/lib/db-map/.ingest-jobs/location-review-20261016-v2/`.
Snapshot `2026-10-16T21:13:03Z`, packet `e3f3cc8d-c2df-4b99-bccf-626bb628ac04`:
40 source/build pairs across six sources (18 JamBase, 6 Dyrt, 6 Biennale.com,
7 Biennial Association, 2 previously completed That Festival Site sample records,
1 RIDB sample record). All 40 checkpoints bind the exact normalization. Selection
contains 7 risk, 8 baseline and 25 no-bound-reverse cases. Fifteen cases have bound
reverse evidence; 11 have candidate differences, including harmless lexical variants.
Twenty-five remain unassessed for reverse consistency. These are sample findings,
not source-wide error rates or acceptance of incomplete full captures.

Export made zero database writes and zero LLM/geocoder calls. Fourteen focused tests
and package type/contract checks pass. Offline summarization also ran successfully
with `DB_MAP_URL` unset. It retained exactly one human label: Paul's explicit
confirmation that Gurtenfestival's listed Switzerland country is correct for the
event. No coordinate/address/other-field verdict was inferred. That decision is in
`decisions.20261016-country-confirmation.json`; its grouped summary is in sibling
`location-review-20261016-confirmation-summary/`. All other fields await review.
