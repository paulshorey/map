# POI capture specification

Generic ingestion accepts a JSON array, JSONL, or CSV of flat records. Keep the source's
verbatim fields; `name` (or `title`) is required for records without a natural id.

- Provide `source_record_id` whenever the source has a stable natural key. Common aliases
  (`id`, `slug`, `mbid`, `wikidata_qid`, `wikidata_id`, `artsy_id`, and `ra_event_id`) are
  recognized automatically.
- `website`/`website_url` is the POI's official site. `source_url`/`detail_url` is the source
  listing or detail page. They are not interchangeable.
- Include locality (`city`, `region`/`state`, `country`/`country_code`) or coordinates when
  there is no natural id. The generic extractor derives a deterministic key from name and
  locality. A singleton detail URL is used only when it is unique within the file.
- For a feed with one row per annual edition, configure the source as `identity.editioned` and
  include `start_date` or `starts_at`; edition is then part of the synthetic identity. Series
  sources must not set that flag.

Do not use a shared homepage or a full-record hash as an identifier. The extractor rejects
different records that resolve to the same identity rather than overwriting one silently.

## Coordinate provenance

Keep original source coordinates in the usual numeric `lat`/`lng` fields (aliases
`latitude`, `lon`, `longitude` remain supported). Supply the listing's country,
region, city and address text separately; do not pre-geocode or overwrite the source
point just to conform to the capture format.

Ingestion produces two named evidence slots, independently:

```json
{
  "source_coordinates": { "lat": 46.5, "lng": 7.5 },
  "inferred_coordinates": { "lat": 46.49, "lng": 7.51 }
}
```

`source_coordinates` comes from validated extracted source/URL coordinates;
`inferred_coordinates` comes from forward-geocoding the captured listing text.
Either slot may be null. A generated point must never fill the source slot. Both
values remain stored even when identical, with source/artifact/query provenance.
The map may render one or both; identical coordinates produce one marker.

Roles such as launch, landing or entrance are not required or inferred. Additional
source-native coordinates, arrays and role labels remain immutable raw evidence;
they do not take the inferred slot. A source with multiple candidate source points
needs a deterministic adapter/preflight to select its one source-coordinate value.
A richer physical-location model can be designed separately later. See
[location enrichment](../poi-ingestion.md#standardized-location-enrichment).
