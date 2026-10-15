import type { Pool } from "pg";
/** Read-only completeness audit. No coordinate lookup or repair is implied. */
export async function auditLocations(db: Pool) {
  const client = await db.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const canonical = (
      await client.query(`SELECT status,count(*)::int records,
 count(*) FILTER(WHERE abs(lat)>90 OR abs(lng)>180 OR (lat=0 AND lng=0))::int invalid_coordinates,
 count(*) FILTER(WHERE nullif(trim(address),'') IS NULL)::int missing_address,
 count(*) FILTER(WHERE nullif(trim(attributes->>'country_code'),'') IS NULL)::int missing_country_code,
 count(*) FILTER(WHERE nullif(trim(attributes->>'city'),'') IS NULL)::int missing_city,
 count(*) FILTER(WHERE nullif(trim(attributes->>'region'),'') IS NULL)::int missing_region FROM canonical_pois GROUP BY status ORDER BY status`)
    ).rows;
    const source = (
      await client.query(`SELECT rs.slug,count(*)::int records,
 count(*) FILTER(WHERE rp.lat IS NULL OR rp.lng IS NULL)::int missing_coordinates,
 count(*) FILTER(WHERE nullif(trim(rp.country_code),'') IS NULL)::int missing_country_code,
 count(*) FILTER(WHERE nullif(trim(rp.city),'') IS NULL)::int missing_city,
 count(*) FILTER(WHERE nullif(trim(rp.region),'') IS NULL)::int missing_region,
 count(*) FILTER(WHERE nullif(trim(rp.address),'') IS NULL)::int missing_address,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->'warnings' ? 'coordinate_country_conflict')::int country_conflicts,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->'warnings' ? 'location_fields_incomplete')::int incomplete_lookups,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->'warnings' ? 'coordinate_region_conflict')::int region_conflicts,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->'warnings' ? 'reverse_result_too_distant')::int distant_results,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->>'version'='location-v1')::int enriched,
 count(*) FILTER(WHERE rp.attributes->'location_enrichment'->'provenance'->>'address'='reverse_geocode')::int inferred_addresses
 FROM research_pois rp JOIN research_sources rs ON rs.id=rp.source_id WHERE rp.is_poi AND rp.retired_at IS NULL GROUP BY rs.slug ORDER BY records DESC`)
    ).rows;
    await client.query("COMMIT");
    return {
      observed_at: new Date().toISOString(),
      canonical,
      source,
      interpretation:
        "Missing optional administrative/address fields are quality gaps, not proof that coordinates are missing. Reverse addresses are approximate. Inspect conflicts and source provenance; never overwrite official addresses.",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
