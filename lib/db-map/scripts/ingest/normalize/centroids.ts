import type { Pool } from "pg";
import { ingestConfig } from "../config.js";
import { bboxAround, haversineMeters } from "../match/geo.js";

interface CentroidRow {
  id: string;
  kind: "city" | "country";
  name: string;
  admin1: string | null;
  country_code: string | null;
  population: string | null;
  lat: number;
  lng: number;
}

export interface CentroidInput {
  id: string;
  name: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  lat: number | null;
  lng: number | null;
  coordinate_source: string | null;
  coordinate_precision: string | null;
}

export interface CentroidResult {
  city: string | null;
  region: string | null;
  country_code: string | null;
  coordinate_precision: string | null;
  attributes: Record<string, unknown>;
  centroidKind: "city" | "country" | null;
  reverseCity: boolean;
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1] ?? 10);
  const idx = text.indexOf(".");
  return idx === -1 ? 0 : text.length - idx - 1;
}

function suspiciouslyRound(lat: number, lng: number): boolean {
  if (decimalPlaces(lat) <= 3 && decimalPlaces(lng) <= 3) return true;
  const quarterish = (value: number) => Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
  return quarterish(lat) && quarterish(lng);
}

async function exactCoordinateStacked(db: Pool, input: CentroidInput): Promise<boolean> {
  if (input.lat === null || input.lng === null) return false;
  const { rows } = await db.query<{ distinct_names: string }>(
    `SELECT count(DISTINCT normalize_key)::text AS distinct_names
     FROM (
       SELECT COALESCE(name_normalized, lower(name), id::text) AS normalize_key
       FROM research_pois
       WHERE is_poi
         AND lat = $1
         AND lng = $2
     ) s`,
    [input.lat, input.lng],
  );
  return Number(rows[0]?.distinct_names ?? 0) >= 3;
}

async function nearestCentroid(
  db: Pool,
  kind: "city" | "country",
  lat: number,
  lng: number,
  radiusM: number,
): Promise<{ row: CentroidRow; distanceM: number } | null> {
  const bbox = bboxAround({ lat, lng }, radiusM);
  const { rows } = await db.query<CentroidRow>(
    `SELECT id::text, kind, name, admin1, country_code, population::text, lat, lng
     FROM geo_centroids
     WHERE kind = $1
       AND lat BETWEEN $2 AND $3
       AND lng BETWEEN $4 AND $5
     LIMIT 1000`,
    [kind, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng],
  );

  return rows
    .map((row) => ({
      row,
      distanceM: haversineMeters({ lat, lng }, { lat: row.lat, lng: row.lng }),
    }))
    .filter((hit) => hit.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM || Number(b.row.population ?? 0) - Number(a.row.population ?? 0))[0] ?? null;
}

export async function applyCentroidRules(
  db: Pool,
  input: CentroidInput,
): Promise<CentroidResult> {
  const result: CentroidResult = {
    city: input.city,
    region: input.region,
    country_code: input.country_code,
    coordinate_precision: input.coordinate_precision,
    attributes: {},
    centroidKind: null,
    reverseCity: false,
  };

  if (input.lat === null || input.lng === null) return result;

  const canDowngrade = input.coordinate_source === "source" || input.coordinate_source === "url";
  if (canDowngrade) {
    const country = await nearestCentroid(
      db,
      "country",
      input.lat,
      input.lng,
      ingestConfig.match.centroidCountryM,
    );
    if (country) {
      result.coordinate_precision = "region";
      result.attributes.centroid_hit = `country:${country.row.name}`;
      result.centroidKind = "country";
    } else {
      const cityTight = await nearestCentroid(
        db,
        "city",
        input.lat,
        input.lng,
        ingestConfig.match.centroidCityM,
      );
      if (cityTight) {
        result.coordinate_precision = "city";
        result.attributes.centroid_hit = `city:${cityTight.row.id}`;
        result.centroidKind = "city";
      } else {
        const cityBand = await nearestCentroid(
          db,
          "city",
          input.lat,
          input.lng,
          ingestConfig.match.centroidCityBandM,
        );
        if (
          cityBand &&
          (suspiciouslyRound(input.lat, input.lng) || (await exactCoordinateStacked(db, input)))
        ) {
          result.coordinate_precision = "city";
          result.attributes.centroid_hit = `city:${cityBand.row.id}`;
          result.centroidKind = "city";
        }
      }
    }
  }

  if (!result.city || !result.region || !result.country_code) {
    const reverseCity = await nearestCentroid(
      db,
      "city",
      input.lat,
      input.lng,
      ingestConfig.match.reverseCityKm * 1000,
    );
    if (reverseCity) {
      result.city = result.city ?? reverseCity.row.name;
      result.region = result.region ?? reverseCity.row.admin1;
      result.country_code = result.country_code ?? reverseCity.row.country_code;
      result.attributes.city_source = "nearest_centroid";
      result.reverseCity = true;
    }
  }

  return result;
}
