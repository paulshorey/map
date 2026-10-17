# Source-supplied and text-inferred coordinate evidence

The human's latest correction on 2026-10-17 replaces the earlier arbitrary two-point /
physical-role design. The two canonical fields have fixed meanings, independent of
whether a category knows launch, landing or entrance roles:

```json
{
  "coordinate_evidence": {
    "source_coordinates": {
      "lat": 46.5,
      "lng": 7.5,
      "kind": "source",
      "origin": "source_coordinates"
    },
    "inferred_coordinates": {
      "lat": 46.49,
      "lng": 7.51,
      "kind": "inferred",
      "origin": "listed_address_geocode"
    }
  }
}
```

Each field can be null. An inferred-only record must keep the source field null.
Equal coordinate pairs keep both observations; duplicate map markers collapse.
Different pairs map separately and open the same detail. No role assumptions,
point averaging or distance suppression are introduced. A second supplied source
point cannot replace the text-inferred value. Extra source-native points and labels
remain raw evidence; a richer physical-location model is a later design.

## Storage and selection

The managed geocode stage stores the two named values in its immutable artifact's
`validation.coordinate_evidence`, plus original listed text/hints, forward query,
country filter, result, reverse evidence and precision. Canonical builds select one
source value and one inferred value independently from linked members, with each
value's source/research/normalization/geocode IDs. A known source/URL point can retain
its source origin through legacy rebuilding; unavailable provenance stays legacy.

The reserved canonical field is `attributes.coordinate_evidence`. API detail exposes
it directly; rendered points additionally have stable source/inferred/legacy marker
IDs, shared POI ID and per-point viewport filtering. Details display the named values,
including equality, without requiring roles or array-index interpretation. The
existing primary lat/lng projection uses the source value when available, otherwise
inferred/legacy; future display preferences can select either named field at read time.

Format `location-v3`, geocoder artifact `locationiq-location-v4`, canonical builder
`canonical-build-v5`. Query semantics remain `listed-location-v1`; forward/reverse
provider cache namespace remains `location-v2` to preserve already-paid results.
New format readiness invalidates old array proofs only on a deliberate selected
run/resume. No schema migration, file-wide restart or historical mass repair.

## Integrated review fixes

PR58 (stale canonical checkpoint/cache invalidation) was independently checked and
merged into PR57, then PR57 (legacy/source/geocoded origin correction) into PR56.
Their exact combined code passed 30 tests plus type/contracts; the optional dedicated
loopback database test was skipped without its explicit URL. Neither contribution
was merged into main. This revision keeps that invalidation and legacy-origin work.

## Validation history

The earlier prototype's one-record Venice live sample exposed an unrelated Italian
business match from combined venue names. The query was repaired to prefer the
supplied address/locality and constrain a recognized listed country. Immutable bad
artifact df9bf61e-7294-4b50-9096-d0c07ca8e287 and original source point were preserved.
The corrected query returned Castello/Venezia/IT at45.4346809,12.3509152, compared with
source45.433,12.3597. That established locality agreement, not an entrance assertion.
Original receipts remain in primary `.ingest-jobs/two-locations-20261017/`.

Current revision validation covers fixed slot selection, source-only/inferred-only
records, exact equality without evidence loss, invalid origins, retained legacy geocode hit/miss attribution, additional raw source
points not displacing inference, provider budgets/cache reuse and exact artifact
binding. Real rolled-back SQL checks cover canonical activation/build provenance,
legacy fallback, stable kind IDs and inferred-only viewport retrieval. Current test
and bounded smoke receipts are recorded in the ignored operational handoff.

Current revision: 37 focused tests pass; one optional dedicated loopback cache test
is skipped without its explicit URL. Both real PostgreSQL rollback integrations,
database/map type and generated-contract checks, and production app build pass.

One new supervised 1-record smoke (jobf25d3347-a992-4058-91f1-0c0d984d8cd8,
run a9242aa0-7de9-4d47-9466-b418ab0de229, execution3965f6a0-f389-431f-9733-0aaee0cb7d74)
verified at2026-10-17T22:37:19.020Z. Its geocoder budget was0; both provider results
were reused and the provider ledger confirms0new requests of any kind. New artifact
and canonical output preserve source45.433,12.3597 and inferred45.4346809,12.3509152
in their named fields with independent provenance. Tight viewport probes return stable
`:source` and `:inferred` marker IDs with the same POI ID. Zero lineage violations;
normalization, embedding and match adjudication reused. This is one-record contract
validation, not a whole-file reimport or precise venue-quality assertion.

A bounded read-query check exposed a viewport regression from expanding all evidence
for every legacy row (5s statement deadline exceeded; estimated plan cost573848 with
JIT optimization). Candidate filtering now tests stored/named points first and
materializes the limited entity set before marker expansion. The same real viewport
returned in224ms (detail64ms), with no pool/timeout/server-setting change. SQL regression
fixtures also cover malformed and very large numeric coordinates without unsafe casts.
Original and corrected timings are retained in the private receipts.

Private current receipts: primary `.ingest-jobs/coordinate-origins-20261017/`.

## Operational ownership

Owner chat01a139a6-1dec-73e3-a8fa-46d8c4e14a56, branch codex/two-location-ingestion,
PR56. Primary main is unchanged pending independent review. Initial snapshot once
confirmed no workers/locks/claims. Owned maintenance tokenbcaa82e4-ee4e-43bb-aa0e-5df387e2048b was released for the
bounded validation and is obsolete. Final fresh control is maintenanceOFF/quiescent,
with0workers/source locks; exact smoke worker and supervisor processes have exited.
Follow-up owned gate549ee0bb-5b1c-434b-8e1d-c5d94ea941bd protected the viewport repair;
its release and fresh control are recorded in the final private receipt.
Both ingestion schedules remain paused. No full import or source-file rewrite is
part of this change. Previous role-based plan and validation are historical evidence,
not current contract or permission to restart completed sample/file scopes.
