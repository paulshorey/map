#!/usr/bin/env python3
"""Extract Wikipedia Category:Carnivals_in_Europe - full recursive fetch."""

import requests
import json
import time

BASE_URL = "https://en.wikipedia.org/w/api.php"
OUT_DIR = "/home/user/workspace/map-repo/docs/poi/carnival/"

HEADERS = {
    "User-Agent": "CarnivalMapBot/1.0 (research project; contact: research@example.com)"
}


def get_category_members(cat_title, cmtype="page", limit=500):
    """Fetch all members (pages or subcats) with continuation."""
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": cat_title,
        "cmlimit": str(limit),
        "cmtype": cmtype,
        "format": "json",
    }

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
        time.sleep(0.2)

    return all_members


def main():
    all_articles = {}   # pageid -> article dict
    category_tree = {}  # cat title -> list of article titles
    all_subcats = {}    # cat title -> list of subcat titles

    def process_category(cat_title, depth=0):
        """Recursively process a category."""
        if cat_title in category_tree:
            return  # already processed
        indent = "  " * depth
        print(f"{indent}Processing: {cat_title}")

        # Get pages
        pages = get_category_members(cat_title, cmtype="page", limit=500)
        time.sleep(0.3)

        article_titles = []
        for p in pages:
            pid = p.get("pageid")
            title = p.get("title", "")
            if pid and title:
                article_titles.append(title)
                if pid not in all_articles:
                    all_articles[pid] = {
                        "pageid": pid,
                        "title": title,
                        "url": f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
                        "categories": [cat_title],
                    }
                else:
                    if cat_title not in all_articles[pid]["categories"]:
                        all_articles[pid]["categories"].append(cat_title)

        category_tree[cat_title] = article_titles
        print(f"{indent}  {len(pages)} articles")

        # Get subcategories
        subcats = get_category_members(cat_title, cmtype="subcat", limit=100)
        time.sleep(0.3)

        subcat_titles = [s["title"] for s in subcats]
        all_subcats[cat_title] = subcat_titles

        if subcats:
            print(f"{indent}  {len(subcats)} subcats: {subcat_titles}")

        # Recurse (limit depth to avoid infinite loops)
        if depth < 3:
            for subcat in subcats:
                process_category(subcat["title"], depth + 1)

    # Start from root
    process_category("Category:Carnivals_in_Europe")

    # Also process "Carnivals in Europe by country" subcats directly
    by_country_subcats = get_category_members(
        "Category:Carnivals in Europe by country", cmtype="subcat", limit=100
    )
    time.sleep(0.3)
    for subcat in by_country_subcats:
        process_category(subcat["title"])

    # Build sorted article list
    article_list = sorted(all_articles.values(), key=lambda x: x["title"])

    output = {
        "source_category": "Category:Carnivals_in_Europe",
        "api_url": "https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Carnivals_in_Europe&cmlimit=500&format=json",
        "total_articles": len(article_list),
        "category_tree": {
            cat: {
                "articles": articles,
                "subcategories": all_subcats.get(cat, []),
            }
            for cat, articles in category_tree.items()
        },
        "articles": article_list,
    }

    out_path = OUT_DIR + "wikipedia_carnivals_category.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nTotal unique articles: {len(article_list)}")
    print(f"Saved to {out_path}")

    # Print summary by country category
    print("\nArticles per country category:")
    for cat, articles in sorted(category_tree.items()):
        if "by country" not in cat and cat != "Category:Carnivals_in_Europe":
            print(f"  {cat}: {len(articles)} articles")
            for title in articles[:5]:
                print(f"    - {title}")


if __name__ == "__main__":
    main()
