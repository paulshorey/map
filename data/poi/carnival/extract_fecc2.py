#!/usr/bin/env python3
"""Extract FECC convention table from Wikipedia - corrected parser."""

import requests
import json
import time
import re

BASE_URL = "https://en.wikipedia.org/w/api.php"
OUT_DIR = "/home/user/workspace/map-repo/docs/poi/carnival/"

HEADERS = {
    "User-Agent": "CarnivalMapBot/1.0 (research project; contact: research@example.com)"
}


def fetch_article_html(page_title):
    params = {
        "action": "parse",
        "page": page_title,
        "prop": "text",
        "format": "json",
    }
    r = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data["parse"]["text"]["*"]


def strip_tags(html_str):
    return re.sub(r"<[^>]+>", "", html_str)


def clean(text):
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&#\d+;", "", text)
    text = re.sub(r"&[a-zA-Z]+;", " ", text)
    text = re.sub(r"\s+", " ", strip_tags(text)).strip()
    return text


def parse_fecc_table(html):
    """
    The FECC wikitable has 3 columns:
      - Year (e.g. "1981, 1st")
      - City/Country (e.g. "Patras Carnival (Greece)")
      - Participants (number)
    """
    records = []

    # Find the wikitable
    wt_match = re.search(
        r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>(.*?)</table>',
        html, re.DOTALL | re.IGNORECASE
    )
    if not wt_match:
        print("  WARNING: No wikitable found")
        return records

    table_html = wt_match.group(1)

    # Extract rows
    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
    cell_pattern = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)

    for row_m in row_pattern.finditer(table_html):
        row_html = row_m.group(1)
        cells = [clean(c.group(1)) for c in cell_pattern.finditer(row_html)]

        if len(cells) < 2:
            continue

        year_raw = cells[0]
        city_country_raw = cells[1]
        participants = cells[2] if len(cells) > 2 else ""

        # Year cell: "1981, 1st" or "1981"
        year_match = re.match(r"(\d{4})", year_raw)
        if not year_match:
            continue

        year = year_match.group(1)
        edition_match = re.search(r",\s*(\d+\w+)", year_raw)
        edition = edition_match.group(1) if edition_match else ""

        # City/Country: "Patras Carnival (Greece)" or "Aalborg (Denmark)"
        # Extract country from parentheses
        country_match = re.search(r"\(([^)]+)\)\s*$", city_country_raw)
        country = country_match.group(1).strip() if country_match else ""

        # City is everything before the parentheses
        if country_match:
            city = city_country_raw[:city_country_raw.rfind("(")].strip()
        else:
            city = city_country_raw

        records.append({
            "year": year,
            "edition": edition,
            "city": city,
            "country": country,
            "participants": participants,
            "raw": city_country_raw,
        })

    return records


def extract_member_cities(html):
    """Extract member city list items."""
    members = []
    li_pattern = re.compile(r"<li[^>]*>(.*?)</li>", re.DOTALL | re.IGNORECASE)
    for li_m in li_pattern.finditer(html):
        text = clean(li_m.group(1))
        if text and len(text) < 150 and not text.startswith("^") and not text.startswith("This"):
            members.append(text)
    return members


def extract_intro(html):
    """Get first few paragraphs."""
    paras = []
    for m in re.finditer(r"<p[^>]*>(.*?)</p>", html, re.DOTALL | re.IGNORECASE):
        text = clean(m.group(1))
        if text and len(text) > 30:
            paras.append(text)
        if len(paras) >= 3:
            break
    return " ".join(paras)


def main():
    print("Fetching FECC article...")
    html = fetch_article_html("Federation_of_European_Carnival_Cities")
    time.sleep(0.5)

    records = parse_fecc_table(html)
    print(f"Found {len(records)} convention records")

    intro = extract_intro(html)
    members = extract_member_cities(html)

    output = {
        "source": "https://en.wikipedia.org/wiki/Federation_of_European_Carnival_Cities",
        "api_url": "https://en.wikipedia.org/w/api.php?action=parse&page=Federation_of_European_Carnival_Cities&prop=text&format=json",
        "description": intro,
        "total_conventions": len(records),
        "conventions": records,
        "member_cities_raw": members,
    }

    out_path = OUT_DIR + "fecc_wikipedia.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Saved to {out_path}")
    print(f"Conventions: {len(records)}, Members: {len(members)}")
    if records:
        print(f"First: {records[0]}")
        print(f"Last: {records[-1]}")


if __name__ == "__main__":
    main()
