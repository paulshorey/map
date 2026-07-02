#!/usr/bin/env python3
"""Fetch and parse 8 carnival Wikipedia articles to extract named carnivals, locations, dates."""

import requests
import json
import time
import re

BASE_URL = "https://en.wikipedia.org/w/api.php"
OUT_DIR = "/home/user/workspace/map-repo/docs/poi/carnival/"

HEADERS = {
    "User-Agent": "CarnivalMapBot/1.0 (research project; contact: research@example.com)"
}

ARTICLES = [
    {
        "title": "Carnival_in_Italy",
        "url": "https://en.wikipedia.org/wiki/Carnival_in_Italy",
        "country": "Italy",
    },
    {
        "title": "Carnival_in_the_Netherlands",
        "url": "https://en.wikipedia.org/wiki/Carnival_in_the_Netherlands",
        "country": "Netherlands",
    },
    {
        "title": "Patras_Carnival",
        "url": "https://en.wikipedia.org/wiki/Patras_Carnival",
        "country": "Greece",
    },
    {
        "title": "Kukeri",
        "url": "https://en.wikipedia.org/wiki/Kukeri",
        "country": "Bulgaria",
    },
    {
        "title": "Busójárás",
        "url": "https://en.wikipedia.org/wiki/Busójárás",
        "country": "Hungary",
    },
    {
        "title": "Fastelavn",
        "url": "https://en.wikipedia.org/wiki/Fastelavn",
        "country": "Denmark/Nordic",
    },
    {
        "title": "Notting_Hill_Carnival",
        "url": "https://en.wikipedia.org/wiki/Notting_Hill_Carnival",
        "country": "United Kingdom",
    },
    {
        "title": "Carnival_in_Germany",
        "url": "https://en.wikipedia.org/wiki/Carnival_in_Germany",
        "country": "Germany",
    },
]


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
    if "error" in data:
        raise ValueError(f"API error for {page_title}: {data['error']}")
    return data["parse"]["text"]["*"]


def strip_tags(html_str):
    return re.sub(r"<[^>]+>", "", html_str)


def clean(text):
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&#[0-9]+;", "", text)
    text = re.sub(r"&[a-zA-Z]+;", "", text)
    text = re.sub(r"\s+", " ", strip_tags(text)).strip()
    return text


def extract_paragraphs(html):
    """Extract text from <p> tags."""
    paras = []
    for m in re.finditer(r"<p[^>]*>(.*?)</p>", html, re.DOTALL | re.IGNORECASE):
        text = clean(m.group(1))
        if text and len(text) > 20:
            paras.append(text)
    return paras


def extract_headings(html):
    """Extract all headings."""
    headings = []
    for m in re.finditer(r"<h[2-4][^>]*>.*?<span[^>]*class=\"mw-headline\"[^>]*>(.*?)</span>", html, re.DOTALL | re.IGNORECASE):
        headings.append(clean(m.group(1)))
    return headings


def extract_list_items(html):
    """Extract <li> items."""
    items = []
    for m in re.finditer(r"<li[^>]*>(.*?)</li>", html, re.DOTALL | re.IGNORECASE):
        text = clean(m.group(1))
        if text and len(text) > 3 and not text.startswith("^"):
            items.append(text)
    return items


def extract_table_rows(html):
    """Extract rows from wikitables."""
    rows = []
    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
    cell_pattern = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)

    for row_m in row_pattern.finditer(html):
        row_html = row_m.group(1)
        cells = [clean(c.group(1)) for c in cell_pattern.finditer(row_html)]
        if cells and any(c for c in cells):
            rows.append(cells)
    return rows


def extract_infobox(html):
    """Try to extract infobox key-value pairs."""
    infobox = {}
    # Find infobox table
    ib_match = re.search(r'<table[^>]*class="[^"]*infobox[^"]*"[^>]*>(.*?)</table>', html, re.DOTALL | re.IGNORECASE)
    if not ib_match:
        return infobox

    ib_html = ib_match.group(1)
    row_pattern = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
    for row_m in row_pattern.finditer(ib_html):
        row_html = row_m.group(1)
        th_m = re.search(r"<th[^>]*>(.*?)</th>", row_html, re.DOTALL | re.IGNORECASE)
        td_m = re.search(r"<td[^>]*>(.*?)</td>", row_html, re.DOTALL | re.IGNORECASE)
        if th_m and td_m:
            key = clean(th_m.group(1))
            val = clean(td_m.group(1))
            if key and val:
                infobox[key] = val
    return infobox


# ---- Article-specific parsers ----

def parse_italy(html, article):
    """Extract Italian carnivals - look for named carnivals in headings and text."""
    records = []
    italian_carnivals = [
        ("Venice Carnival", "Venice", "Italy"),
        ("Viareggio Carnival", "Viareggio", "Italy"),
        ("Carnival of Ivrea", "Ivrea", "Italy"),
        ("Carnival of Cento", "Cento", "Italy"),
        ("Putignano Carnival", "Putignano", "Italy"),
        ("Acireale Carnival", "Acireale", "Italy"),
        ("Carnival of Sciacca", "Sciacca", "Italy"),
        ("Ambrosian Carnival", "Milan", "Italy"),
        ("Sardinian Carrasecare", "Sardinia", "Italy"),
    ]

    paras = extract_paragraphs(html)
    headings = extract_headings(html)
    full_text = " ".join(paras)

    for name, city, country in italian_carnivals:
        # Find relevant description from paragraphs
        desc = ""
        for para in paras:
            if city.lower() in para.lower() or name.lower() in para.lower():
                desc = para[:500]
                break

        # Try to find dates
        dates = ""
        date_patterns = [
            r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}",
            r"(Fat Tuesday|Mardi Gras|Shrove Tuesday|Ash Wednesday)",
            r"(pre-Lent|Lent|before Lent)",
        ]
        for dp in date_patterns:
            dm = re.search(dp, desc, re.IGNORECASE)
            if dm:
                dates = dm.group(0)
                break

        records.append({
            "name": name,
            "city": city,
            "country": country,
            "description": desc,
            "dates": dates,
            "source_article": article["title"],
            "source_url": article["url"],
        })

    return records


def parse_netherlands(html, article):
    """Extract Dutch carnivals from the article."""
    records = []
    paras = extract_paragraphs(html)
    rows = extract_table_rows(html)

    # Known major cities
    nl_cities = [
        ("Bergen op Zoom Carnival", "Bergen op Zoom", "Netherlands"),
        ("Eindhoven Carnival", "Eindhoven", "Netherlands"),
        ("Den Bosch Carnival", "'s-Hertogenbosch", "Netherlands"),
        ("Breda Carnival", "Breda", "Netherlands"),
        ("Tilburg Carnival", "Tilburg", "Netherlands"),
        ("Maastricht Carnival", "Maastricht", "Netherlands"),
    ]

    full_text = " ".join(paras)

    for name, city, country in nl_cities:
        desc = ""
        for para in paras:
            if city.lower() in para.lower():
                desc = para[:500]
                break
        records.append({
            "name": name,
            "city": city,
            "country": country,
            "description": desc,
            "dates": "Three days before Ash Wednesday",
            "source_article": article["title"],
            "source_url": article["url"],
        })

    # Also extract from table rows - rows with city names
    for row in rows:
        if len(row) >= 2:
            city_cell = row[0]
            desc_cell = row[1] if len(row) > 1 else ""
            # Check if it looks like a city entry (not a header)
            if city_cell and len(city_cell) < 80 and city_cell not in ["City", "Name", "Region", "Province"]:
                # Check it's not already in our list
                already = any(r["city"] == city_cell for r in records)
                if not already and re.search(r"[A-Z]", city_cell):
                    records.append({
                        "name": f"{city_cell} Carnival",
                        "city": city_cell,
                        "country": "Netherlands",
                        "description": desc_cell[:300],
                        "dates": "Three days before Ash Wednesday",
                        "source_article": article["title"],
                        "source_url": article["url"],
                    })

    return records


def parse_generic_with_infobox(html, article):
    """Generic parser: use infobox + paragraphs to create a single record."""
    infobox = extract_infobox(html)
    paras = extract_paragraphs(html)
    headings = extract_headings(html)

    name = clean(article["title"].replace("_", " "))
    city = infobox.get("Location", infobox.get("City", infobox.get("Venue", "")))
    country = article["country"]
    description = paras[0][:600] if paras else ""

    # Extract dates from infobox or paragraphs
    dates = infobox.get("Date", infobox.get("Dates", infobox.get("Frequency", "")))
    if not dates:
        for para in paras[:3]:
            dm = re.search(
                r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}|"
                r"(pre-Lent|Lent|Shrove Tuesday|Mardi Gras|Fat Tuesday|Easter|August|annual)",
                para, re.IGNORECASE
            )
            if dm:
                dates = dm.group(0)
                break

    records = [{
        "name": name,
        "city": city,
        "country": country,
        "description": description,
        "dates": dates,
        "infobox": infobox,
        "headings": headings,
        "source_article": article["title"],
        "source_url": article["url"],
    }]

    return records


def parse_kukeri(html, article):
    """Extract village-by-village Kukeri locations across Bulgaria."""
    records = []
    paras = extract_paragraphs(html)
    list_items = extract_list_items(html)
    infobox = extract_infobox(html)

    # Main Kukeri record
    records.append({
        "name": "Kukeri",
        "city": "Various villages",
        "country": "Bulgaria",
        "description": paras[0][:600] if paras else "",
        "dates": "Late January to early March (before Lent)",
        "infobox": infobox,
        "source_article": article["title"],
        "source_url": article["url"],
    })

    # Extract individual village locations from list items
    for item in list_items:
        # Look for items that mention specific towns/villages
        if len(item) > 5 and len(item) < 200:
            # Try to identify place names - items that look like "Pernik - ..."  or just city names
            loc_match = re.match(r"^([A-Z][a-zA-Zàáâãäåæçèéêëìíîïðñòóôõöøùúûüý\-\s]+?)[\s\-–—,:]", item)
            if loc_match:
                loc = loc_match.group(1).strip()
                if len(loc) < 50 and loc not in ["The", "In", "It", "This", "These", "A ", "An "]:
                    records.append({
                        "name": f"Kukeri in {loc}",
                        "city": loc,
                        "country": "Bulgaria",
                        "description": item[:300],
                        "dates": "",
                        "source_article": article["title"],
                        "source_url": article["url"],
                    })

    return records


def parse_fastelavn(html, article):
    """Extract Fastelavn across Nordic/Baltic countries."""
    records = []
    paras = extract_paragraphs(html)
    infobox = extract_infobox(html)
    headings = extract_headings(html)

    countries = ["Denmark", "Norway", "Sweden", "Latvia", "Estonia", "Iceland", "Finland"]

    # Main record
    records.append({
        "name": "Fastelavn",
        "city": "Various",
        "country": "Denmark/Nordic/Baltic",
        "description": paras[0][:600] if paras else "",
        "dates": "7 weeks before Easter (February/March)",
        "infobox": infobox,
        "headings": headings,
        "source_article": article["title"],
        "source_url": article["url"],
    })

    # Country-specific records
    for country in countries:
        desc = ""
        for para in paras:
            if country.lower() in para.lower():
                desc = para[:500]
                break
        if desc:
            records.append({
                "name": f"Fastelavn in {country}",
                "city": "",
                "country": country,
                "description": desc,
                "dates": "7 weeks before Easter",
                "source_article": article["title"],
                "source_url": article["url"],
            })

    return records


def parse_germany(html, article):
    """Extract German carnivals."""
    records = []
    paras = extract_paragraphs(html)
    infobox = extract_infobox(html)
    headings = extract_headings(html)

    german_carnivals = [
        ("Cologne Carnival (Kölner Karneval)", "Cologne", "Germany"),
        ("Düsseldorf Carnival", "Düsseldorf", "Germany"),
        ("Mainz Carnival", "Mainz", "Germany"),
        ("Munich Fasching", "Munich", "Germany"),
        ("Rottweil Narrensprung", "Rottweil", "Germany"),
    ]

    for name, city, country in german_carnivals:
        desc = ""
        for para in paras:
            if city.lower() in para.lower():
                desc = para[:500]
                break
        records.append({
            "name": name,
            "city": city,
            "country": country,
            "description": desc,
            "dates": "November 11 start, peak in February/March before Lent",
            "source_article": article["title"],
            "source_url": article["url"],
        })

    # Also add general record
    records.insert(0, {
        "name": "Carnival in Germany (Karneval/Fasching/Fastnacht)",
        "city": "Various",
        "country": "Germany",
        "description": paras[0][:600] if paras else "",
        "dates": "November 11 - Ash Wednesday",
        "infobox": infobox,
        "headings": headings,
        "source_article": article["title"],
        "source_url": article["url"],
    })

    return records


ARTICLE_PARSERS = {
    "Carnival_in_Italy": parse_italy,
    "Carnival_in_the_Netherlands": parse_netherlands,
    "Patras_Carnival": parse_generic_with_infobox,
    "Kukeri": parse_kukeri,
    "Busójárás": parse_generic_with_infobox,
    "Fastelavn": parse_fastelavn,
    "Notting_Hill_Carnival": parse_generic_with_infobox,
    "Carnival_in_Germany": parse_germany,
}


def main():
    all_records = []
    article_summaries = []

    for article in ARTICLES:
        print(f"Fetching: {article['title']}")
        try:
            html = fetch_article_html(article["title"])
            time.sleep(0.5)

            parser = ARTICLE_PARSERS.get(article["title"], parse_generic_with_infobox)
            records = parser(html, article)
            all_records.extend(records)

            article_summaries.append({
                "title": article["title"],
                "url": article["url"],
                "country": article["country"],
                "records_extracted": len(records),
                "record_names": [r["name"] for r in records],
            })
            print(f"  Extracted {len(records)} records")

        except Exception as e:
            print(f"  ERROR: {e}")
            article_summaries.append({
                "title": article["title"],
                "url": article["url"],
                "country": article["country"],
                "records_extracted": 0,
                "error": str(e),
            })

    output = {
        "source_articles": article_summaries,
        "total_records": len(all_records),
        "records": all_records,
    }

    out_path = OUT_DIR + "wikipedia_carnivals_articles.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nSaved {len(all_records)} records to {out_path}")


if __name__ == "__main__":
    main()
