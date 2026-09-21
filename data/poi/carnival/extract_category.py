#!/usr/bin/env python3
"""Extract Wikipedia Category:Carnivals_in_Europe members and subcategories."""

import requests
import json
import time

BASE_URL = "https://en.wikipedia.org/w/api.php"
OUT_DIR = "/home/user/workspace/map-repo/docs/poi/carnival/"

HEADERS = {
    "User-Agent": "CarnivalMapBot/1.0 (research project; contact: research@example.com)"
}


def get_category_members(cat_title, cmtype=None, limit=500):
    """Fetch all members of a category, handling continuation."""
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": cat_title,
        "cmlimit": str(limit),
        "format": "json",
    }
    if cmtype:
        params["cmtype"] = cmtype

    all_members = []
    while True:
        r = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
        members = data.get("query", {}).get("categorymembers", [])
        all_members.extend(members)

        if "continue" in data:
            params.update(data["continue"])
        else:
            break
        time.sleep(0.3)

    return all_members


def main():
    print("Fetching Category:Carnivals_in_Europe articles...")
    articles = get_category_members("Category:Carnivals_in_Europe", cmtype=None, limit=500)
    time.sleep(0.5)

    print(f"  Found {len(articles)} articles")

    print("Fetching subcategories...")
    subcats = get_category_members("Category:Carnivals_in_Europe", cmtype="subcat", limit=100)
    time.sleep(0.5)

    print(f"  Found {len(subcats)} subcategories: {[s['title'] for s in subcats]}")

    # For each subcategory, get its members
    subcat_members = {}
    for subcat in subcats:
        cat_title = subcat["title"]
        print(f"  Fetching members of: {cat_title}")
        members = get_category_members(cat_title, limit=500)
        subcat_members[cat_title] = members
        print(f"    Found {len(members)} members")
        time.sleep(0.5)

    # Build unified article list (deduplicated by pageid)
    seen_ids = set()
    all_articles = []

    def add_articles(article_list, source_category):
        for a in article_list:
            pid = a.get("pageid")
            title = a.get("title", "")
            if pid and pid not in seen_ids and not title.startswith("Category:"):
                seen_ids.add(pid)
                all_articles.append(
                    {
                        "pageid": pid,
                        "title": title,
                        "url": f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
                        "source_category": source_category,
                    }
                )

    add_articles(articles, "Category:Carnivals_in_Europe")
    for cat_title, members in subcat_members.items():
        add_articles(members, cat_title)

    output = {
        "source_category": "Category:Carnivals_in_Europe",
        "api_url": "https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Carnivals_in_Europe&cmlimit=500&format=json",
        "total_articles": len(all_articles),
        "subcategories": [
            {
                "title": s["title"],
                "pageid": s.get("pageid"),
                "member_count": len(subcat_members.get(s["title"], [])),
            }
            for s in subcats
        ],
        "articles": all_articles,
    }

    out_path = OUT_DIR + "wikipedia_carnivals_category.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nSaved {len(all_articles)} unique articles to {out_path}")


if __name__ == "__main__":
    main()
