#!/usr/bin/env python3
"""Build the RIDB facility capture with addresses from an official RIDB full export.

Keeps the facility cohort of the original capture (one row per FacilityID in
``facilities.csv``), refreshes its fields from the export's ``Facilities_API_v1.csv``
(full descriptions, directions, coordinates) and adds address/locality columns chosen
deterministically from ``FacilityAddresses_API_v1.csv``. Every export address row of a
facility is kept verbatim in ``facility_addresses`` (JSON). Rows missing from the export
keep their original values with ``export_status = missing_from_export``.

Usage (run with -I; the export is downloaded data, keep it in its own directory):

    curl -fsS -o /tmp/ridb-export/RIDBFullExport_V1_CSV.zip \\
      https://ridb.recreation.gov/downloads/RIDBFullExport_V1_CSV.zip
    unzip -o /tmp/ridb-export/RIDBFullExport_V1_CSV.zip \\
      Facilities_API_v1.csv FacilityAddresses_API_v1.csv -d /tmp/ridb-export/x
    python3 -I scripts/ridb-facility-addresses.py \\
      data/poi/rv_campgrounds_data/ridb/facilities.csv \\
      /tmp/ridb-export/x/Facilities_API_v1.csv \\
      /tmp/ridb-export/x/FacilityAddresses_API_v1.csv \\
      data/poi/rv_campgrounds_data/ridb/facilities_with_addresses.csv

Prints a JSON coverage summary on stderr.
"""

import csv
import json
import re
import sys
from collections import Counter, defaultdict

csv.field_size_limit(sys.maxsize)

# Physical first; a mailing address is where the agency gets mail, often a distant office.
TYPE_RANK = {"Physical": 0, "Default": 1}

US_STATES = {
    "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR",
    "CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT", "DELAWARE": "DE",
    "DISTRICT OF COLUMBIA": "DC", "FLORIDA": "FL", "GEORGIA": "GA", "HAWAII": "HI",
    "IDAHO": "ID", "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS",
    "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD",
    "MASSACHUSETTS": "MA", "MICHIGAN": "MI", "MINNESOTA": "MN", "MISSISSIPPI": "MS",
    "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
    "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK",
    "OREGON": "OR", "PENNSYLVANIA": "PA", "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX",
    "UTAH": "UT", "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY", "PUERTO RICO": "PR",
    "GUAM": "GU", "AMERICAN SAMOA": "AS", "VIRGIN ISLANDS": "VI",
    "NORTHERN MARIANA ISLANDS": "MP",
}
STATE_CODES = set(US_STATES.values())
TERRITORIES = {"PR", "GU", "AS", "VI", "MP"}
US_COUNTRY = {"USA", "US", "UNITED STATES"}

# An administrative or mail-only line, not where the facility is.
NOT_PHYSICAL = re.compile(
    r"\b(P\.?\s*O\.?\s*BOX|BOX\s+\d|OFFICE|RANGER\s+DISTRICT|DISTRICT|HEADQUARTERS|"
    r"C/O|MAILING|CORPS\s+OF\s+ENGINEERS|NATIONAL\s+FOREST|FIELD\s+STATION|"
    r"RANGER\s+STATION|GUARD\s+STATION|WORK\s+CENTER|ADMINISTRATIVE|ADMIN\s+SITE)\b",
    re.I,
)
ROAD = re.compile(
    r"\b(ROAD|RD|STREET|ST|AVENUE|AVE|DRIVE|DR|LANE|LN|HIGHWAY|HWY|ROUTE|RTE|"
    r"PARKWAY|PKWY|BOULEVARD|BLVD|WAY|TRAIL|TRL|PIKE|CIRCLE|CIR|COURT|CT|PLACE|"
    r"LOOP|SPUR|FR|FS|CR|SR|US|I)\b\.?\s*-?\s*\d|\b\d+\s+\S+.*\b(ROAD|RD|STREET|ST|"
    r"AVENUE|AVE|DRIVE|DR|LANE|LN|HIGHWAY|HWY|ROUTE|RTE|PARKWAY|PKWY|BOULEVARD|BLVD|"
    r"WAY|TRAIL|TRL|PIKE|CIRCLE|CIR|COURT|CT|PLACE|PL|LOOP|SPUR)\b",
    re.I,
)
KEEP_UPPER = {"NE", "NW", "SE", "SW", "N", "S", "E", "W", "US", "FS", "FR", "SR", "CR",
              "HC", "NF", "PO", "II", "III", "IV"}


def clean(value):
    return re.sub(r"\s+", " ", (value or "")).strip()


def display_case(value):
    """Title-case an all-caps value for display; mixed-case text is kept verbatim."""
    if not value or value != value.upper() or not re.search(r"[A-Z]", value):
        return value

    def word(m):
        w = m.group(0)
        if any(c.isdigit() for c in w) or w in KEEP_UPPER:
            return w
        return w[0] + w[1:].lower()

    return re.sub(r"[A-Za-z0-9']+", word, value)


def street_of(row):
    return clean(", ".join(
        clean(row.get(f"FacilityStreetAddress{i}")) for i in (1, 2, 3)
        if clean(row.get(f"FacilityStreetAddress{i}"))
    ))


def physical_street(street):
    """A street line that locates the facility: a house number or a numbered/named road."""
    if not street or NOT_PHYSICAL.search(street):
        return False
    return bool(re.match(r"^#?\d+[A-Za-z]?\s+\S", street) or ROAD.search(street))


def state_code(value):
    v = clean(value).upper()
    if v in STATE_CODES:
        return v
    return US_STATES.get(v, "")


def select_address(rows):
    """Return (fields, selection) for one facility's export address rows."""
    usable = sorted(
        (r for r in rows if r.get("FacilityAddressType") in TYPE_RANK),
        key=lambda r: (TYPE_RANK[r["FacilityAddressType"]], r.get("FacilityAddressID", "")),
    )
    fields = {"address": "", "city": "", "region": "", "postal_code": "", "country_code": "",
              "address_type": ""}
    reasons = []
    for r in usable:
        street = street_of(r)
        if street and not physical_street(street):
            reasons.append(f"{r['FacilityAddressType']}:street_not_physical")
            # An office/PO-box row describes the managing office, which can be in another
            # state; none of its locality is used.
            continue
        if street and not fields["address"]:
            fields["address"] = display_case(street)
            fields["address_type"] = r["FacilityAddressType"]
        if clean(r.get("City")) and not fields["city"]:
            fields["city"] = display_case(clean(r["City"]))
            fields["address_type"] = fields["address_type"] or r["FacilityAddressType"]
            postal = clean(r.get("PostalCode"))
            if re.fullmatch(r"\d{5}(-\d{4})?", postal):
                fields["postal_code"] = postal
        fields["region"] = fields["region"] or state_code(r.get("AddressStateCode"))
    # Only US state/territory codes survive state_code(); AddressCountryCode is noisy ("1").
    # Territories carry their own ISO code, which equals their USPS code.
    countries = {clean(r.get("AddressCountryCode")).upper() for r in usable} - {""}
    if fields["region"] in TERRITORIES:
        fields["country_code"] = fields["region"]
    elif fields["region"] or (fields["city"] and countries & US_COUNTRY):
        fields["country_code"] = "US"
    if not usable:
        reasons.append("mailing_only" if rows else "no_address_rows")
    return fields, ";".join(dict.fromkeys(reasons))


def main(argv):
    if len(argv) != 5:
        sys.exit(__doc__)
    cohort_path, facilities_path, addresses_path, out_path = argv[1:]
    with open(cohort_path, encoding="utf-8", newline="") as f:
        cohort = list(csv.DictReader(f))
    with open(facilities_path, encoding="utf-8-sig", newline="") as f:
        export = {r["FacilityID"]: r for r in csv.DictReader(f)}
    addresses = defaultdict(list)
    with open(addresses_path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            addresses[r["FacilityID"]].append(r)

    export_columns = [
        "LegacyFacilityID", "OrgFacilityID", "ParentOrgID", "ParentRecAreaID",
        "FacilityUseFeeDescription", "FacilityDirections", "FacilityMapURL",
        "FacilityAdaAccess", "Enabled",
    ]
    columns = list(cohort[0].keys()) + export_columns + [
        "address", "city", "region", "postal_code", "country_code", "address_type",
        "address_selection", "export_status", "facility_addresses",
    ]
    stats = Counter()
    out = []
    for old in cohort:
        fid = old["FacilityID"]
        row = {c: old.get(c, "") for c in columns}
        current = export.get(fid)
        if current:
            row["export_status"] = "current"
            for c in columns:
                if c in current and c != "Activities":
                    row[c] = current[c]
            # The export rounds to 6 decimals: keep the more precise captured point unless the
            # export moved it, and never replace a captured point with a blank or (0,0) one.
            def num(r, c):
                try:
                    return float(clean(r.get(c)) or 0)
                except ValueError:
                    return 0.0
            moved = max(abs(num(old, c) - num(current, c))
                        for c in ("FacilityLatitude", "FacilityLongitude")) > 1e-6
            blank = num(current, "FacilityLatitude") == 0 and num(current, "FacilityLongitude") == 0
            if blank or not moved:
                row["FacilityLatitude"] = old["FacilityLatitude"]
                row["FacilityLongitude"] = old["FacilityLongitude"]
            else:
                stats["coordinates_moved"] += 1
        else:
            row["export_status"] = "missing_from_export"
        rows = sorted(addresses.get(fid, []), key=lambda r: r.get("FacilityAddressID", ""))
        fields, selection = select_address(rows)
        row.update(fields)
        sentinel = all(float(row[c] or 0) == 0 for c in ("FacilityLatitude", "FacilityLongitude"))
        if sentinel and not row["country_code"]:
            # RIDB lists only US federal recreation sites; without a point or usable locality
            # the country is the one location fact left, so the POI can still be mapped.
            row["country_code"] = "US"
            selection = ";".join(filter(None, [selection, "country_assumed_us"]))
            stats["sentinel_country_assumed_us"] += 1
        row["address_selection"] = selection
        row["facility_addresses"] = json.dumps(rows, ensure_ascii=False) if rows else ""
        out.append(row)
        stats["facilities"] += 1
        stats[f"export_{row['export_status']}"] += 1
        for k in ("address", "city", "region", "postal_code"):
            stats[f"with_{k}"] += bool(row[k])
        stats["with_city_or_address"] += bool(row["address"] or row["city"])
        stats["without_address"] += not row["address"]
        if sentinel:
            stats["sentinel_coordinates"] += 1
            stats["sentinel_with_address"] += bool(row["address"])
            stats["sentinel_with_city"] += bool(row["city"])
            stats["sentinel_with_region"] += bool(row["region"])
        if len(row["FacilityDescription"]) > len(old["FacilityDescription"]):
            stats["longer_description"] += 1
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, lineterminator="\n")
        w.writeheader()
        w.writerows(out)
    print(json.dumps(dict(sorted(stats.items())), indent=2), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
