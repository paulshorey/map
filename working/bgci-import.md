# BGCI gardens full import — 2026-11-05

Owner-authorized full import of `data/poi/botanical_gardens_data/bgci_gardens_full.json`
(3,649 records, `botanical_garden`) after the [Biennial Foundation import](biennial-foundation-import.md).
Run `a08422b3-7696-4baa-9451-1f3f21f83bb1`, managed with `--unlimited`, monitored by a cheap
subagent. **Status: paused, about 170 records left**, waiting for the LocationIQ daily quota.

## Executions

| Job | Revision | Outcome | Cause and fix |
| --- | --- | --- | --- |
| `75a53d05…` | `40cbd08` | stage error after 30 min | Record 28: 209-character query got HTTP 400 "Invalid Request". Fixed in `7fb89f7`: fit queries under the limit; a 400 is a record-level miss. |
| `193067c1…` | `70a74f5` | stage error after 8 min | Transient: database connection and embedding fetches failed together at 05:13 UTC (host network). Resumed unchanged. |
| `6994a79e…` | `70a74f5` | stage error near the end | Record 7120: a 188-character Cyrillic query is 280 bytes (400); the uncached 400 left `geocode_query_norm` pointing at no cache row (FK). Fixed: limit measured in UTF-8 bytes (`81152ed`); 400s are cached as invalid requests (`086c0b4`). |
| `07b65e64…` | `81152ed` | stopped by operator | LocationIQ HTTP 429 "Rate Limited Day": 4,999 successful calls today on the 5,000/day plan. Resume is scheduled after 00:00 UTC. |

Resume: `pnpm --silent --filter @lib/db-map ingest:supervise start --local-only -- --resume a08422b3-7696-4baa-9451-1f3f21f83bb1 --unlimited`

## Interim data (3,484 of 3,649 linked)

| Measure | Count |
| --- | --- |
| Supplied source points | 3,390 (3,386 `point`, 4 detected country centroids) |
| Geocoded | 206: 117 `point`, 59 `city`, 8 `region`, 22 `country` |
| Published canonicals | 3,434: 3,340 `precise`, 93 `general` |
| Non-POI (organisations, programmes) | 23, e.g. American Orchid Society, City of Yarra Parks Division |
| Normalization failed / degraded | 6 (completion truncated by `max_tokens`) / 10 |
| No website / no description | 804 / 2,423 |
| Within-BGCI merges | 48 canonicals; no cross-source merges (no other garden source imported yet) |

Geocode paths exercised: 137 address lookups, 23 venue results rejected for a city conflict
and replaced by the city lookup, 20 city fallbacks after a miss, 11 name results rejected
(`name_result_mismatch`) then replaced by a fallback, 14 accepted name lookups.

### Findings

1. **LocationIQ's free quota (5,000/day) is the binding constraint.** BGCI alone used
   most of a day: reverse lookups for records without full locality, plus forward lookups.
   Re-importing every source after the planned database reset will take many days at this
   rate. Before that run, either upgrade the plan or skip reverse lookups for fields the
   capture already supplies (the BGCI capture has structured city/state/country for most
   records).
2. **Overseas territories raise false country conflicts.** 20 `coordinate_country_conflict`
   warnings: most are Réunion, Martinique, Guadeloupe and French Guiana (reverse result FR)
   and Puerto Rico and the US Virgin Islands (reverse US). Those reverse fields are then
   discarded. A territory/parent-country equivalence would keep them. A few are real data
   conflicts: a `DZ` "Jardin Botanique" whose point is in Guadeloupe, and a Sharjah garden
   whose point is in Saudi Arabia.
3. **Stacked supplied points not covered by the centroid table.** 18 records share supplied
   points across different cities; the largest group is 6 Mexican gardens at
   `19.3253, -99.6045` (Chapingo, Coyoacán, Cuautitlán Izcalli, …). A data-driven rule
   (one exact supplied point used by three or more records in different cities is coarse)
   would flag them `general`. Seven Australian gardens at `-24.7761, 134.7550` are
   LocationIQ's own Australia centroid from country fallbacks and are already `general`.
4. **Within-source merges are mostly the intended aggressive conflation** of co-located
   institutions (Christy Woods + Rinard Orchid Greenhouse, Newfields + Indianapolis Museum
   of Art, Saskatoon Civic Conservatory + Mendel Gallery). Some are doubtful and need
   review: Dushanbe's Academy of Sciences garden + Tajik State University garden; Fujian
   Subtropical Economic Plant Institute + Xiamen Overseas Chinese Subtropical Plant
   Introduction Garden.
5. **Category question:** 39 CWGC war cemeteries (Rangoon, Rome, Thiepval…) are BGCI
   members. They publish as botanical gardens; the owner should decide whether they belong.
6. **Six normalizations truncated by `max_tokens`** on long records. Retry with a larger
   output allowance or a trimmed description input (`--retry-failed` selection).
7. Domain sharing is now harmless: `nationaltrust.org.uk` (71), `cwgc.org` (39) and state
   government domains compare by full URL under `matcher-v4`.

## Next steps

1. Resume after the quota reset (scheduled), then record final counts here.
2. Decide on the CWGC cemeteries and review the doubtful merges above.
3. Before the full reset/re-import: address the LocationIQ quota, add territory/parent
   country equivalence, and add stacked-supplied-point detection.
