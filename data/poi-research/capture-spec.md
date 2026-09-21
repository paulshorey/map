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
