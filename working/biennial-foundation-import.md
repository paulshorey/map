# Biennial Foundation full import — 2026-11-05

The owner authorized the full 304-record import of
`data/poi/art-fairs/biennials/biennial_foundation.json` (`art_fair`) after the
[location fixes](location-quality-fixes.md) and asked for an evaluation of the
handling of bad and missing data. Country/region/city POIs publish as `general`.

## First full run (revision `cb72ce2`, PR #77)

Job `1f011508…`, run `08f089a2-a514-40fa-a5e9-7e6b8d57feee`, 02:40–03:29 UTC,
`requested_scope_verified`, all eight verify checks ok. 301 normalizations
(3 reused), about $0.17; one recovered provider retry in matching.

| Measure | Count |
| --- | --- |
| Research records | 304, all active and linked |
| Supplied source points | 100 (99 `point`, Adelaide `country`) |
| Geocoded | 204: 193 `country`, 6 `point`, 5 `city` |
| Published canonicals touched | 297: 199 `general`, 98 `precise` |
| Records with no city / venue / address / coordinates | 204 (name + country only) |
| Merged with biennale_com / Biennial Association | 36 three-source, 7 two-source |

### Findings

1. **The capture lacks location for two thirds of the file.** 204 records carry only a
   name and country, so 193 sit on country centroids and stack (17 US biennials at the
   US centroid, 9 in Germany, 8 in China and Japan). Listing pages hold the official
   website (for example `hpb.fi`) and the host city in the description. A recapture of the
   listing pages is the main fix; see next steps.
2. **The source's own listing page was the `website`** for 204 records. It published as
   the official website and made every pair of them a "same website" match signal, which
   the LLM adjudicator cited ("same biennialfoundation.org website"). Within-source false
   merges followed: Shenzhen Sculpture Biennale + Shenzhen Biennale, Klima Biennale Wien +
   Vienna Biennale (both on the Austria centroid), ARS + Biennale Warszawa.
3. **Domain-level website matching is wrong everywhere.** The matcher compared domains:
   `usda.gov` is the website of 3,357 distinct Dyrt campgrounds, `blm.gov` 611, `ca.gov`
   225, `mn.us` 211. Any two of them counted as the same website.
4. **Implausible geocodes.** Locality-only queries of non-city text returned venues: "East
   Africa" → a Göteborg restaurant, "BAVIC" → a Lebanese tattoo shop, "USA / Mexico" →
   Mexico, Missouri. Name-only lookups returned Ray-Ban for "RAY Fotografieprojekte" and a
   Dnipro "Biennale" for "Online Biennale". The precision classifier called every
   administrative boundary a `city` (England, Cyprus) and Great Britain (an island) a
   `point`, and the reverse lookup then filled villages (Sapcote, Redmire, Πάνω Πλάτρες).
5. **Stale snapshot after a lost location.** When a record ends with no plottable point,
   its old canonical kept serving the wrong point with no members.
6. **Country text gaps:** `Korea` and `Brasil` did not resolve; `Chechnya` is a region.
7. **Venue misses** for mixed text ("Cockatoo Island & various, Sydney", "Various venues,
   Greater Cleveland") preserved supplied points; no action needed.
8. **Dates:** the capture has frequency text only; 43 of 302 art-fair canonicals have
   dates (from other sources).

## Fixes (`claude/biennial-import-fixes`, commit `1585256`)

- `forwardImplausible`: region/country-only lookups may return only a region or country;
  name-only lookups must return a place whose name agrees. Rejected hits stay as evidence;
  the lookup falls back to the recognized listed country.
- Precision classifier `geocode-precision-v3` reads a boundary's precision from its address.
- Geocoding an unlocatable record releases its held snapshot (`releaseLocationHold`).
- Normalization profile `event-v2` drops self-listing websites; `matcher-v4` compares
  websites by full URL identity and shows the adjudicator full URLs.
- Country aliases `korea`, `brasil`. `LOCATION_VERSION` is `location-v6`.

A replay of the new checks against stored provider rows predicted 5 unlocated records
(all previously on wrong points) and 6 corrected to `region`. Bounded live runs on five
records confirmed it: Klima Biennale Wien split from Vienna Biennale; Border, East Africa
and RAY became unlocated, their stale canonicals hidden after an issue retry.

## Re-run

Job `4b8d01a4-13e4-4d6b-82ac-2ffd466b36cc` at `1585256` (results to be recorded below).

## Next steps

1. **Recapture Biennial Foundation listing pages** (304 pages; a new capture version per
   [capture conventions](../data/AGENTS.md)) to extract official website and host city/venue.
   That moves most of the 199 general records to city or venue precision and gives the
   matcher real websites.
2. Unlocated records (no recognized country or locality): leave unpublished and flagged
   until the recapture supplies a city; do not invent a point.
3. Consider a name-derived city hint (for example "Helsinki Photography Biennial") only as
   a labelled `general` inferred point after the recapture, if pages still lack a city.
