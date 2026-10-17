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

## Multiple locations

JSON/JSONL captures may supply `locations` (also accepted inside `attributes`) as
an array of explicit coordinate objects. Use numeric `lat`/`lng`, optional `role`
(`launch`, `landing`, `entrance`, etc.), `label` and `precision` (`point`, `city`,
`region`). Preserve source order and original text. Example:

```json
{
  "source_record_id": "flying-site-123",
  "name": "Example flying site",
  "city": "Example municipality",
  "country_code": "CH",
  "locations": [
    { "lat": 46.5, "lng": 7.5, "role": "launch" },
    { "lat": 46.49, "lng": 7.51, "role": "landing" }
  ]
}
```

If top-level coordinates are absent or incomplete, the first valid pair supplies
the primary point. Never combine a latitude from one location with another's
longitude. Existing top-level `lat`/`lng` remain supported. Source adapters for
nonstandard launch/landing fields must explicitly map these pairs; the model must
not guess additional points. Complex multi-location CSVs need a deterministic
adapter or a lossless JSON/JSONL capture, not JSON strings invented by the model.

The geocode stage also resolves the original listed address/locality independently
of supplied coordinates. Up to two distinct points are published: the primary,
then an explicit second source location, otherwise the address-derived candidate.
Extra raw points and the forward lookup result remain evidence for later review.
Exact duplicate pairs collapse; nearby/distant candidates are not averaged or
automatically suppressed. See [location enrichment](../poi-ingestion.md#standardized-location-enrichment).
