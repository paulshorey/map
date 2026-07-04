export interface Point {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bboxAround(point: Point, radiusM: number): BBox {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(toRad(point.lat));
  const lngDelta =
    Math.abs(cosLat) < 0.000001
      ? 180
      : (radiusM / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);

  return {
    minLat: Math.max(-90, point.lat - latDelta),
    maxLat: Math.min(90, point.lat + latDelta),
    minLng: Math.max(-180, point.lng - lngDelta),
    maxLng: Math.min(180, point.lng + lngDelta),
  };
}

export function distanceScore(distanceM: number, radiusM: number): number {
  if (radiusM <= 0) return 0;
  return Math.max(0, 1 - distanceM / radiusM);
}

