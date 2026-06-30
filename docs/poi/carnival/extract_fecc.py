#!/usr/bin/env python3
"""Extract FECC convention table from Wikipedia."""

import requests
import json
import time
import re
from html.parser import HTMLParser

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
    """Remove all HTML tags from a string."""
    return re.sub(r"<[^>]+>", "", html_str)


def clean(text):
    return re.sub(r"\s+", " ", strip_tags(text)).strip()


def parse_fecc_table(html):
    """Parse the FECC convention host table."""
    # Find all <table> blocks
    # The convention table has year, city, country columns
    records = []

    # Extract table rows with year pattern
    # Look for rows containing a 4-digit year
    # Pattern: <tr>...<td>YEAR</td>...<td>CITY</td>...<td>COUNTRY</td>...
    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
    cell_pattern = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)

    for row_m in row_pattern.finditer(html):
        row_html = row_m.group(1)
        cells = [clean(c.group(1)) for c in cell_pattern.finditer(row_html)]
        if not cells:
            continue

        # Look for a row where first cell is a 4-digit year 1981-2030
        if cells and re.match(r"^(198|199|200|201|202)\d$", cells[0]):
            year = cells[0]
            city = cells[1] if len(cells) > 1 else ""
            country = cells[2] if len(cells) > 2 else ""
            theme = cells[3] if len(cells) > 3 else ""
            records.append(
                {
                    "year": year,
                    "city": city,
                    "country": country,
                    "theme": theme,
                }
            )

    return records


def main():
    print("Fetching FECC article...")
    html = fetch_article_html("Federation_of_European_Carnival_Cities")
    time.sleep(0.5)

    records = parse_fecc_table(html)
    print(f"Found {len(records)} convention records")

    # Also extract intro text / general info
    # Get the page text without tables for intro
    intro_match = re.search(r"<p>(.*?)</p>", html, re.DOTALL)
    intro = clean(intro_match.group(1)) if intro_match else ""

    # Get member cities section
    # Look for list items
    li_pattern = re.compile(r"<li[^>]*>(.*?)</li>", re.DOTALL | re.IGNORECASE)
    members = []
    # Find all list items that look like city entries
    for li_m in li_pattern.finditer(html):
        text = clean(li_m.group(1))
        if text and len(text) < 200 and not text.startswith("^"):
            members.append(text)

    output = {
        "source": "https://en.wikipedia.org/wiki/Federation_of_European_Carnival_Cities",
        "api_url": "https://en.wikipedia.org/w/api.php?action=parse&page=Federation_of_European_Carnival_Cities&prop=text&format=json",
        "description": intro,
        "conventions": records,
        "member_cities_raw": members[:100],  # cap to avoid noise
    }

    out_path = OUT_DIR + "fecc_wikipedia.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Saved to {out_path}")
    print(f"Conventions: {len(records)}, Members raw: {len(members[:100])}")


if __name__ == "__main__":
    main()
