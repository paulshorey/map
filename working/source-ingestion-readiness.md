# Source readiness and the next POI import

Owner: chat `01a139a6-1dec-73e3-a8fa-46d8c4e14a56`. Reviewed 2026-10-15.
The human authorized another background import, continued source-by-source assessment,
necessary adapters/repairs, and supervision that stops ingestion on serious failures.

## Initial selection

Use one compatible full capture next, after the source preflight below. Keeping one file active initially makes it
easier to diagnose geocoding and merging with the completed Dyrt capture. Source locks
prevent duplicate sources; canonical writes are serialized globally, so adding processes
does not automatically increase throughput. Consider parallel independent sources only
after measured benefit and after each passes its own readiness checks.

The next full candidate is `data/poi/art-fairs/biennials/biennale_com.json`, category
`art_fair`: 43 named art-biennale records, every record with valid coordinates,
country/locality, venue, official website and edition dates; no repeated name/locality
identities. A two-record supervised sample is the launch gate. These are captured
historical/future editions, not a claim that every event is currently happening.

| Capture | Local findings | Decision |
| --- | --- | --- |
| RIDB `ridb/facilities.csv` | 5,979 unique FacilityIDs; all names present; 435 `(0,0)` sentinel pairs. 4,590 rows labelled Campground, 1,382 Facility, and seven other types. | Deferred: after the activation fix, Wetmore correctly reaches geocoding and reports no match. CSV lacks address/locality columns and truncates descriptions. Recapture full facility location/address data or supply reviewed enrichment before full import. |
| OSM `osm/caravan_sites.csv` | 56,157 rows with coordinates; 9,665 blank/placeholder names. Existing adapter retains node/way/relation identity and separates export region from administrative state. | Defer until unnamed-place policy and representative normalization samples are reviewed. Do not invent names or silently drop records. |
| USCampgrounds `uscampgrounds/all_campgrounds_combined.csv` | 13,011 named rows; longitude column is `lon`; codes and export-region fields need identity/locality review. `nearest_town` contains distances in inspected records, with town text in `extra`. Source notes date the underlying data to 2014. | Historical seed/enrichment candidate. Review age, field semantics and conflicts with current sources before import. |
| RIDB `campsites_rv_hookup.csv` | Individual campsite inventory, separate from campground facilities. | Supporting child data; do not import every campsite as an independent campground. Join by facility identity in a separately reviewed enrichment task. |

These findings concern the local captures, not claims about current external availability.
Supporting/alternate exports are not additional independent sources.

## Preflight defect and repair

The first two real one-record samples reached structural verification, but inspection
showed Wetmore Campground (`10367801`) still projected `(0,0)`. Deterministic normalization
had correctly warned `invalid_source_coordinates`; activation passed null coordinate
parameters into `COALESCE`, retaining the raw zeros and bypassing geocoding. This is why
exit zero alone is insufficient for source acceptance.

Activation now writes validated deterministic source/URL coordinates, including nulls,
and retains an existing geocode only for the same normalization and matching geocode
artifact. Position changes retire stale memberships and require matching again. The
exact active-normalization cache checks the coordinate projection; the immutable cached
normalization can repair a bad projection without another LLM request. Existing valid
positions and normalizer/prompt cache identities remain reusable.

RIDB also encodes `Reservable` as CSV strings (`True`: 4,006; `False`: 1,973), which
the current immutable capture retains as strings. A future typed adapter needs explicit
capture/cache migration validation: changing an extractor mapping alone does not replace
an existing observation with the same raw-content hash. Preserve old observations and
prove that revised captured fields become active before claiming a typing repair.

Additional candidates: Wikidata gardens has 3,916 rows but only 3,665 distinct QIDs,
510 missing/QID-only labels and 439 missing/invalid coordinate pairs; it needs explicit
entity-level aggregation of SPARQL duplicates. The OSM garden CSV has 3,421 distinct
typed IDs and names, but only 827 valid coordinate pairs: capture way/relation centers
instead of relying only on node lat/lon. Source notes overstate its coordinate coverage.
BGCI has 3,649 unique IDs and names, 3,400 supplied coordinate pairs, and structured
address/city/country data for most records. A two-record live preflight accepted both
normalizations and verified the coordinate-bearing record, but the first missing-coordinate
record received a geocoder miss despite its structured locality. Defer its full import
until the geocoder query/fallback path is validated. This alone does not justify rewriting
the BGCI capture; its nested format is already handled by an adapter.

Ireland's `art-fairs/regional/ireland_events.json` also needs category review: the 475
records include 423 generic events, 51 festivals and one market; inspected examples
include a cinema screening. Existing inventory notes calling all rows art-fair events
are not sufficient evidence to import them as `art_fair`.

Validation: focused coordinate/registered-capture tests, package types/contracts, and a
real PostgreSQL activation regression that rolls back all writes and blocks provider
calls. The integration requires the owned quiescent maintenance token and the initial
RIDB Wetmore preflight artifact; run `ingest:test-coordinates:integration <token>`.
Fresh live validation and the full launch receipt are recorded in the private job
journals and coordinator memory. A sample is not proof of whole-file completion.

## Capture format recommendations

Existing captures generally need small deterministic adapters, not wholesale rewriting.
Keep originals immutable and retain their source IDs, licensing/attribution, capture time,
and source update time. Prefer the existing [capture specification](../data/poi-research/capture-spec.md)
for new captures:

- A JSON array, JSONL, or consistently headed CSV, with one entity per record and a stable
  source ID. Separate campground facilities from campsite children and annual event editions.
- Explicit `name`, `lat`, `lng`, `city`, `region`, and country code when supplied. Use null
  or empty fields for missing coordinates rather than `(0,0)`. Keep export region separate.
- Keep the source listing URL separate from the official POI website. Never derive one
  from a similarly named record without evidence.
- Preserve booleans/numbers as native scalars in JSON. For CSV, document each field's
  scalar or enum encoding so adapters can parse false/zero without LLM interpretation.
- Preserve complete descriptions rather than truncating them, and include address/locality
  fields when available. These make missing-coordinate geocoding safer and more useful.

Reject or defer a capture with unresolved identity collisions, unclear entity granularity,
unusable location evidence, or systematic bad output. Save the evidence and concrete
recapture requirements; do not quietly exclude it or repeatedly retry an unchanged failure.
