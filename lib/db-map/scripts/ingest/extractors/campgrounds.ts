import { streamCsv } from "../io.js";
import type { Extractor } from "../types.js";
import { mapGenericRecord } from "./generic.js";

/**
 * RIDB's facility CSV uses API field names, not capture-spec column aliases. The
 * `facilities_with_addresses.csv` capture adds `address`/`city`/`region`/`country_code`
 * (chosen by `scripts/ridb-facility-addresses.py`) and the verbatim export address rows
 * as JSON in `facility_addresses`; the older `facilities.csv` has neither.
 */
export const ridbFacilitiesExtractor: Extractor = {
  slug: "ridb",
  async *parse(file) {
    for await (const raw of streamCsv(file)) {
      const { facility_addresses: addressRows, ...fields } = raw;
      const record = mapGenericRecord(
        {
          ...fields,
          source_record_id: raw.FacilityID,
          name: raw.FacilityName,
          description: raw.FacilityDescription,
          lat: raw.FacilityLatitude,
          lng: raw.FacilityLongitude,
          phone: raw.FacilityPhone,
          email: raw.FacilityEmail,
          raw_category: raw.FacilityTypeDescription,
          attributes: {
            reservation_url: raw.FacilityReservationURL,
            facility_addresses: addressRows
              ? JSON.parse(addressRows)
              : undefined,
          },
        },
        { sourceSlug: "ridb" },
      );
      if (record) yield { ...record, raw };
    }
  },
};

/** OSM node/way/relation IDs occupy separate namespaces; retain their natural identity. */
export const osmCampgroundsExtractor: Extractor = {
  slug: "osm_camp",
  async *parse(file) {
    for await (const raw of streamCsv(file)) {
      if (
        !raw.osm_id ||
        !["node", "way", "relation"].includes(raw.osm_type ?? "")
      )
        throw new Error("OSM campground capture requires osm_type and osm_id");
      const tags = raw.all_tags ? JSON.parse(raw.all_tags) : {};
      const record = mapGenericRecord(
        {
          ...raw,
          source_record_id: `${raw.osm_type}/${raw.osm_id}`,
          city: raw.addr_city || tags["addr:city"],
          // The CSV region is a continent/export region, not an administrative state.
          region: tags["addr:state"],
          country: raw.country || tags["addr:country"],
          attributes: { source_region: raw.region, osm_tags: tags },
        },
        { sourceSlug: "osm_camp" },
      );
      if (record) yield { ...record, raw };
    }
  },
};
