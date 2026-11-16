/**
 * Offline reverse lookup: country, region and nearest town for a point. No provider call
 * and no quota. Data is vendored in data/geonames (see its README for sources and licences).
 *
 *  - Country and region come from the boundary that contains the point (regions.json.gz).
 *  - City is the largest place whose built-up area plausibly covers the point (so central
 *    Paris is "Paris", not an arrondissement), otherwise the nearest place within CITY_KM
 *    (cities500.txt). Either way it lies in the point's country.
 *  - A point outside every boundary (a pier, a small island, a simplified coastline) takes
 *    its country and region from nearby places, only when every place around it agrees.
 *    Without an agreed country it gets no result at all, so no town from across a border.
 *  - A street address or postcode is never supplied.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { haversineMeters } from "./match/geo.js";
import { countryToCode } from "./normalize/country.js";
import type { ReverseLocation } from "./location.js";

export const OFFLINE_REVERSE_PROVIDER = "geonames";
const ATTRIBUTION =
  "GeoNames (geonames.org), CC BY 4.0; Natural Earth (naturalearthdata.com)";
const CITY_KM = 15;
/** Without a containing boundary, nearby places may name the area only within this range. */
const COAST_KM = 25;
const KM_PER_DEGREE = 111.32;
/** People per square kilometre assumed when estimating how far a place's built-up area reaches. */
const URBAN_DENSITY = 10000;

interface Place {
  name: string;
  lat: number;
  lng: number;
  country: string;
  admin1: string;
  /** Estimated radius of the built-up area, in metres, from the population. */
  extentM: number;
}
/** One boundary polygon: rings of flat [lng, lat, ...] integers; the first ring is the outline. */
interface Area {
  country: string | null;
  region: string | null;
  regionCode: string | null;
  rings: number[][];
}
export interface Gazetteer {
  /** Places by whole-degree cell, keyed `${floor(lat)}:${floor(lng)}`. */
  places: Map<string, Place[]>;
  /** Boundary polygons by the whole-degree cells their outline's bounding box touches. */
  areas: Map<string, Area[]>;
  /** Boundary coordinates are integers at this many units per degree. */
  scale: number;
  /** `${country}.${admin1}` → region name, for the nearby-places fallback. */
  regionNames: Map<string, string>;
}
export interface RegionsFile {
  scale: number;
  units: Array<{
    c: string | null;
    r: string | null;
    rc: string | null;
    p: number[][][];
  }>;
}

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/geonames",
);
let loaded: Gazetteer | undefined;

/** Build the lookup grids from GeoNames `cities500`/`admin1CodesASCII` text and the regions file. */
export function buildGazetteer(
  cities: string,
  admin1: string,
  regions: RegionsFile,
): Gazetteer {
  const places = new Map<string, Place[]>();
  for (const line of cities.split("\n")) {
    const f = line.split("\t");
    const lat = Number(f[4]),
      lng = Number(f[5]);
    if (!f[1] || !f[8] || !Number.isFinite(lat) || !Number.isFinite(lng))
      continue;
    // Not towns: sections of a city (Paris 04), and historical, abandoned or destroyed places.
    if (["PPLX", "PPLH", "PPLQ", "PPLW"].includes(f[7]!)) continue;
    const key = `${Math.floor(lat)}:${Math.floor(lng)}`;
    const place = {
      name: f[1],
      lat,
      lng,
      country: f[8],
      admin1: f[10] ?? "",
      extentM:
        Math.sqrt((Number(f[14]) || 0) / (URBAN_DENSITY * Math.PI)) * 1000,
    };
    const cell = places.get(key);
    if (cell) cell.push(place);
    else places.set(key, [place]);
  }
  const regionNames = new Map<string, string>();
  for (const line of admin1.split("\n")) {
    const [code, name] = line.split("\t");
    if (code && name) regionNames.set(code, name);
  }
  const areas = new Map<string, Area[]>();
  const { scale } = regions;
  for (const unit of regions.units)
    for (const rings of unit.p) {
      const area: Area = {
        country: unit.c,
        region: unit.r,
        regionCode: unit.rc,
        rings,
      };
      const outline = rings[0]!;
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (let i = 0; i < outline.length; i += 2) {
        minX = Math.min(minX, outline[i]!);
        maxX = Math.max(maxX, outline[i]!);
        minY = Math.min(minY, outline[i + 1]!);
        maxY = Math.max(maxY, outline[i + 1]!);
      }
      for (let x = Math.floor(minX / scale); x <= Math.floor(maxX / scale); x++)
        for (
          let y = Math.floor(minY / scale);
          y <= Math.floor(maxY / scale);
          y++
        ) {
          const key = `${y}:${x}`;
          const cell = areas.get(key);
          if (cell) cell.push(area);
          else areas.set(key, [area]);
        }
    }
  return { places, areas, scale, regionNames };
}

function gazetteer(): Gazetteer {
  loaded ??= buildGazetteer(
    fs.readFileSync(path.join(DATA_DIR, "cities500.txt"), "utf8"),
    fs.readFileSync(path.join(DATA_DIR, "admin1CodesASCII.txt"), "utf8"),
    JSON.parse(
      zlib
        .gunzipSync(fs.readFileSync(path.join(DATA_DIR, "regions.json.gz")))
        .toString("utf8"),
    ) as RegionsFile,
  );
  return loaded;
}

/** Even-odd ray casting over a flat [x, y, ...] ring. */
function inRing(ring: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!,
      yi = ring[i + 1]!,
      xj = ring[j]!,
      yj = ring[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      hit = !hit;
  }
  return hit;
}

function containingArea(data: Gazetteer, lat: number, lng: number) {
  const x = lng * data.scale,
    y = lat * data.scale;
  for (const area of data.areas.get(`${Math.floor(lat)}:${Math.floor(lng)}`) ??
    [])
    if (
      inRing(area.rings[0]!, x, y) &&
      !area.rings.slice(1).some((hole) => inRing(hole, x, y))
    )
      return area;
  return null;
}

/** Places within `km` of the point, nearest first. */
function placesNear(data: Gazetteer, lat: number, lng: number, km: number) {
  const latSpan = km / KM_PER_DEGREE;
  // A degree of longitude shrinks toward the poles; near them, scan every longitude.
  const shrink = Math.cos((lat * Math.PI) / 180);
  const lngSpan = shrink > 0.01 ? Math.min(180, latSpan / shrink) : 180;
  const near: Array<{ place: Place; m: number }> = [];
  for (
    let cellLat = Math.floor(lat - latSpan);
    cellLat <= Math.floor(lat + latSpan);
    cellLat++
  )
    for (
      let cellLng = Math.floor(lng - lngSpan);
      cellLng <= Math.floor(lng + lngSpan);
      cellLng++
    ) {
      // Wrap across the antimeridian.
      const wrapped = ((((cellLng + 180) % 360) + 360) % 360) - 180;
      for (const place of data.places.get(`${cellLat}:${wrapped}`) ?? []) {
        const m = haversineMeters({ lat, lng }, place);
        if (m <= km * 1000) near.push({ place, m });
      }
    }
  return near.sort((a, b) => a.m - b.m);
}

/** Country, region and nearest town for a point; null when nothing names the area. */
export function offlineReverse(
  lat: number,
  lng: number,
  data: Gazetteer = gazetteer(),
): ReverseLocation | null {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    throw new Error("Invalid reverse lookup point");
  const area = containingArea(data, lat, lng);
  const near = placesNear(data, lat, lng, Math.max(CITY_KM, COAST_KM));
  let country: string | null,
    region: string | null,
    regionCode: string | null,
    basis: ReverseLocation["basis"];
  if (area) {
    country = countryToCode(area.country) ?? null;
    region = country ? area.region : null;
    regionCode = region ? area.regionCode : null;
    basis = "containing_area";
  } else {
    // Outside every boundary: nearby places name the area only when all of them agree.
    if (!near.length) return null;
    const first = near[0]!.place;
    const sameCountry = near.every((n) => n.place.country === first.country);
    const sameRegion =
      sameCountry && near.every((n) => n.place.admin1 === first.admin1);
    country = sameCountry ? (countryToCode(first.country) ?? null) : null;
    region =
      country && sameRegion
        ? (data.regionNames.get(`${first.country}.${first.admin1}`) ?? null)
        : null;
    regionCode =
      region && /^[A-Z]{2,3}$/.test(first.admin1)
        ? `${country}-${first.admin1}`
        : null;
    basis = "nearby_places";
  }
  // Without an agreed country nothing is named: a town could be on either side of a border.
  if (!country) return null;
  // The town must lie in the same country; across a border it is another country's town.
  const towns = near.filter(
    (n) => n.m <= CITY_KM * 1000 && n.place.country === country,
  );
  const town =
    towns
      .filter((n) => n.m <= n.place.extentM)
      .sort((a, b) => b.place.extentM - a.place.extentM)[0] ?? towns[0];
  return {
    country_code: country,
    region,
    region_code: regionCode,
    city: town?.place.name ?? null,
    address: null,
    postcode: null,
    distance_m: town?.m ?? 0,
    basis,
    provider: OFFLINE_REVERSE_PROVIDER,
    attribution: ATTRIBUTION,
  };
}
