import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str, num } from "./utils.js";

interface BgciRow {
  id: number;
  organisation_name?: string;
  organisation_name_alt?: string | null;
  slug?: string;
  website?: string | null;
  phone?: string | null;
  email_public?: string | null;
  overview_statement?: string | null;
  mission_statement?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  total_area_hectares?: number | null;
  open_to_public?: boolean | null;
  year_incorporated?: number | null;
  arbnet_accredited_level?: string | null;
  botanic_garden_accredited?: boolean | null;
  location_primary?: {
    address_1?: string | null;
    address_2?: string | null;
    city?: string | null;
    state_or_province?: string | null;
    postal_code?: string | null;
    country_code?: string | null;
    country_name?: string | null;
  } | null;
}

export const bgciExtractor: Extractor = {
  slug: "bgci",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as BgciRow;
      const loc = row.location_primary;
      const description =
        str(row.overview_statement) ?? str(row.mission_statement) ?? undefined;
      const address = [str(loc?.address_1), str(loc?.address_2)]
        .filter(Boolean)
        .join(", ") || undefined;

      yield {
        source_record_id: String(row.id),
        name: str(row.organisation_name),
        description,
        website: str(row.website),
        phone: str(row.phone),
        email: str(row.email_public),
        address,
        city: str(loc?.city),
        region: str(loc?.state_or_province),
        country_code: str(loc?.country_code),
        lat: num(row.latitude),
        lng: num(row.longitude),
        raw_category: "botanical garden",
        attributes: {
          bgci_id: row.id,
          slug: str(row.slug),
          alt_name: str(row.organisation_name_alt),
          area_ha: row.total_area_hectares ?? undefined,
          open_to_public: row.open_to_public ?? undefined,
          year_incorporated: row.year_incorporated ?? undefined,
          arbnet_accredited_level: str(row.arbnet_accredited_level),
          botanic_garden_accredited: row.botanic_garden_accredited ?? undefined,
          postal_code: str(loc?.postal_code),
          country_name: str(loc?.country_name),
        },
        raw: row,
      };
    }
  },
};
