#!/usr/bin/env python3
"""Build regions.json.gz: the boundary file the offline reverse lookup reads.

Input: Natural Earth 1:10m "admin 1 states and provinces" GeoJSON (public domain), from
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson
plus cities500.txt and admin1CodesASCII.txt in this folder (GeoNames, CC BY 4.0).

Natural Earth units are states in some countries and counties or municipalities in others.
Each unit is therefore labelled with the GeoNames country and first-level region that most
of the GeoNames places inside it belong to, so "region" means the same level everywhere
(Paris -> Ile-de-France, Wyoming -> Wyoming). The country is taken from those places too,
because Natural Earth gives a dependent territory its sovereign's code (Mayotte is FR there,
YT in GeoNames and ISO 3166-1). Units with no place inside keep Natural Earth's country only.

Natural Earth 5.1.2 predates some region splits (Indonesia's Papua provinces, Kazakhstan's
Abai). Where under 80% of a unit's places share one region, the unit gets no region and the
lookup decides from the places around the point instead.

Usage: python3 build-regions.py /path/to/ne_10m_admin_1_states_provinces.geojson
"""
import gzip
import json
import math
import os
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SCALE = 1000  # coordinates are stored as integers in thousandths of a degree (~110 m)


def rings_of(geometry):
    """Yield polygons as lists of rings (outer first), each ring a list of (lng, lat)."""
    if geometry["type"] == "Polygon":
        yield geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        yield from geometry["coordinates"]


def simplify(ring):
    out = []
    for lng, lat in ring:
        point = (round(lng * SCALE), round(lat * SCALE))
        if not out or out[-1] != point:
            out.append(point)
    return out if len(out) >= 4 else None


def inside(ring, x, y):
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def main():
    features = json.load(open(sys.argv[1], encoding="utf-8"))["features"]
    units = []
    grid = defaultdict(list)  # whole-degree cell -> [(unit index, polygon)]
    for feature in features:
        country = feature["properties"].get("iso_a2")
        if not country or len(country) != 2 or not country.isalpha():
            country = None
        polygons = []
        for polygon in rings_of(feature["geometry"]):
            rings = [r for r in (simplify(ring) for ring in polygon) if r]
            if rings and len(rings[0]) >= 4:
                polygons.append(rings)
        if not polygons:
            continue
        index = len(units)
        units.append({"c": country, "p": polygons, "votes": Counter()})
        for rings in polygons:
            xs = [x for x, _ in rings[0]]
            ys = [y for _, y in rings[0]]
            for cx in range(math.floor(min(xs) / SCALE), math.floor(max(xs) / SCALE) + 1):
                for cy in range(math.floor(min(ys) / SCALE), math.floor(max(ys) / SCALE) + 1):
                    grid[(cx, cy)].append((index, rings))

    for line in open(os.path.join(HERE, "cities500.txt"), encoding="utf-8"):
        f = line.split("\t")
        if len(f) < 11 or not f[10]:
            continue
        x, y = float(f[5]) * SCALE, float(f[4]) * SCALE
        for index, rings in grid.get((math.floor(x / SCALE), math.floor(y / SCALE)), ()):
            if inside(rings[0], x, y) and not any(inside(h, x, y) for h in rings[1:]):
                units[index]["votes"][(f[8], f[10])] += 1
                break

    names = {}
    for line in open(os.path.join(HERE, "admin1CodesASCII.txt"), encoding="utf-8"):
        code, name = line.split("\t")[:2]
        names[code] = name

    out = []
    labelled = 0
    split = 0
    for unit in units:
        admin1 = None
        if unit["votes"]:
            by_country = Counter()
            for (country, _), count in unit["votes"].items():
                by_country[country] += count
            unit["c"] = by_country.most_common(1)[0][0]
            regions = Counter(
                {a1: n for (country, a1), n in unit["votes"].items() if country == unit["c"]}
            )
            top, count = regions.most_common(1)[0]
            # A unit since split into several regions cannot be labelled as one of them.
            admin1 = top if count >= 0.8 * sum(regions.values()) else None
            split += admin1 is None
        region = names.get(f"{unit['c']}.{admin1}") if admin1 else None
        labelled += bool(region)
        out.append(
            {
                "c": unit["c"],
                "r": region,
                # GeoNames admin-1 code, so a town can be required to lie in the same region.
                "a": admin1 if region else None,
                # GeoNames uses ISO 3166-2 letter codes for some countries (US.WY) only.
                "rc": f"{unit['c']}-{admin1}" if region and admin1.isalpha() else None,
                "p": [[[v for point in ring for v in point] for ring in rings] for rings in unit["p"]],
            }
        )
    payload = {
        "version": "regions-v1",
        "scale": SCALE,
        "sources": "Natural Earth 1:10m admin-1 v5.1.2 (public domain); GeoNames (CC BY 4.0)",
        "units": out,
    }
    target = os.path.join(HERE, "regions.json.gz")
    with gzip.GzipFile(target, "wb", mtime=0) as handle:
        handle.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    print(f"{len(out)} units, {labelled} with a region, {split} split, {os.path.getsize(target)} bytes")


if __name__ == "__main__":
    main()
