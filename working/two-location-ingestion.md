# Up to two map locations per POI

Human decision, 2026-10-17: collect a supplied point and a point resolved from listed
location text, preserving both even when they disagree. Publish one or two markers
that open the same POI. Do not average, suppress distant alternatives, or infer which
is correct. Those decisions belong to a later review workflow. Completed imports do
not need a backfill.

Implementation plan:

1. Extend the existing managed geocode stage: forward lookup of original captured
   locality even when coordinates exist, plus the existing reverse enrichment.
   Cache hits/misses, provider budgets, recovery, exact normalization binding and one
   fenced activation remain intact. Never forward-geocode reverse-generated text.
2. Preserve original listed text, reverse evidence, forward query/result and up to two
   validated points in the versioned geocode artifact. Explicit source locations
   (launch/landing/entrance) take the second slot before an address-derived candidate.
   Retain excess evidence in the observation/forward result, without extra markers.
3. Build canonical `attributes.map_locations` (one or two points) and per-point input
   provenance. Keep legacy lat/lng as the primary point. Existing JSONB storage and
   immutable build inputs suffice; no migration or historical sweep is required.
4. Emit separate Point features with unique marker IDs and a shared POI ID, filter
   each point by viewport, and show both locations in the detail drawer. Keep marker
   count distinct from entity identity. Legacy rows fall back to their existing point.
5. Validate exact duplicate collapse, launch/landing, contradictory countries, coarse
   precision, misses, budget resume, cache reuse, artifact binding and secondary-only
   viewport selection. Use offline fixtures, rolled-back SQL and a bounded live smoke.

Operational ownership: this chat 01a139a6-1dec-73e3-a8fa-46d8c4e14a56, branch
`codex/two-location-ingestion`. Before runtime edits, primary discovery found no
workers, source locks or unresolved claims. Owned maintenance entered with token
`e47135e6-4e1e-4c19-acf8-7aa700dab1b4`; quiescence confirmed. Do not restart old
completed imports or change paused supervisor schedules for this implementation.

## Validation

- 29 focused tests pass: existing location/source binding, checkpoint compatibility,
  captured launch/landing mapping, exact duplicate and range checks, canonical
  artifact binding, forward miss, partial-budget/cache resume and conflicting points.
- Real PostgreSQL rollback-only activation integration passes, including two canonical
  points with their actual mixed-source provenance, exact cache reuse, one fenced
  activation for forward/reverse, and zero global lineage violations.
- Real PostgreSQL temporary-table list/detail integration passes: separate world-view
  features, secondary-only viewport, shared detail ID, unique marker IDs, entity limits,
  legacy fallback, stale/malformed/duplicate/excess point protection. No production
  fixture rows remain.
- Database/map type and generated contract checks pass. Production Next.js build passes.

The first supervised one-record Venice Biennale smoke (job
`3bdfffb7-a765-49a2-8de6-a91a8de71cf1`, run
`3a5aa36f-9018-45da-8ad0-735936b9f685`, execution
`5a963764-3b15-486b-b21a-71f189aa4f2c`) structurally verified at
2026-10-17T16:50:02.956Z but exposed a semantic query problem: combined venue names
`Giardini and Arsenale` steered lookup to an unrelated Italian business at
44.003116,8.070929. Its immutable artifact/evidence is retained; this was not accepted
as an alternate venue. No backlog drain or unchanged retry was performed.

Repair: prefer supplied address/locality over a composite venue string; constrain
search to recognized captured country, including country hints; preserve result
country/locality, provider label/type and attribution. Cache/readiness includes the
query policy and country filter. No distance or averaging rule was introduced.

The same one-record scope then passed a new bounded smoke (job
`d804798d-6890-49cf-942f-a6fbb616f72a`, run
`80db45fc-e7d5-4008-bce4-de2b8a2d48b4`, execution
`d78de678-bec5-45f8-b173-06dda8a1b234`), verified
2026-10-17T16:52:53.129Z. Supplied point 45.433,12.3597 was preserved; the revised
`Castello, Venice, Venice, Italy` / IT-filtered lookup returned
45.4346809,12.3509152, labelled Castello/Venezia/Italia. This is locality agreement,
not proof of an exact entrance. Real API queries around each point returned the
corresponding unique marker with shared POI 9ee28140-a256-4981-94a5-9cc8c5b61fc5.
Normalization and matching reused prior accepted artifacts; GLM was not called.
Both smoke deadlines were 60 seconds; neither timed out. Other completed records
were not swept. The one tested shared canonical now has two locations.

Private original/corrected job, query and control receipts are retained in primary
`lib/db-map/.ingest-jobs/two-locations-20261017/`. No schema migration, provider/model
switch, full launch, schedule restart, historical bulk repair or global consolidation.

## Handoff

Code is on `codex/two-location-ingestion`; primary main remains unchanged pending PR
review. The old e47135e6 and b2fd004e validation gates were released by their owner.
Final implementation gate 77aafc07-99c1-4fa8-b3e3-36e402aaf696 is owned by this chat
and will be released after checks; inspect the private final receipt for actual state.
Both ingestion-specific automations stay paused. A future nonstandard gliding source
still needs its own raw-field adapter/preflight; JSON/JSONL captures already support
explicit numeric `locations` with launch/landing roles. Later review can decide
distance withholding, averaging or preferred evidence; no such policy is applied now.
