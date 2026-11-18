# Critical Stages extraction repair plan

## Evidence and scope

The [capture](../data/poi/art-parades/street-arts/critical_stages_festivals.json) has 241 rows.
Run `eba0d794-ef10-480f-b12f-c059d2a32e39` wrote 197 extraction rows, rejected 43 without
usable identity, and stopped on one identity collision before it froze the downstream cohort.
Keep the capture and audit trail. Recheck the pinned run and current source inventory before
implementation, since another run may have changed the source state.

Rows 149 and 182 are listings for Zagreb's International Puppet Theatre Festival in two
issues of the guide. Their month and website fields differ, and both lack edition dates.
Critical Stages revises the guide with successive issues. The festival's archive connects
the old website to the same festival series as the current site. Treat the guide issue as
listing provenance. Require explicit date evidence before creating a festival occurrence.
[Publisher's guide](https://www.critical-stages.org/28/international-theatre-and-performing-arts-festival-guide/) ·
[2007 PIF catalog](https://pif.hr/wp-content/uploads/2022/08/40PIF-2007-katalog-web.pdf) ·
[PIF organizer](https://pif.hr/en/impressum/)

All 43 rejected rows have a name and festival month but lack city, country and coordinates.
Thirty-seven have a website URL that may help recover a location. Website and name alone
need corroboration before publishing a place.

## Implementation sequence

1. **Audit identity offline.** Parse all 241 rows through the current extractor and record
   old IDs, guide issue, and proposed IDs. Check for same-issue repeats, cross-issue
   revisions, and URL reuse. Keep existing IDs wherever their meaning is unchanged.
2. **Add a Critical Stages identity rule.** Prefer a durable source listing ID or anchor.
   Otherwise use a validated guide issue and stable listing identity for the conflicting
   pair. Preserve both raw citations and original month values. Leave unresolved
   same-issue conflicts visible. Keep the generic collision guard and unrelated extractors.
   Bump this source's extractor version and record any old-to-new identity transitions.
3. **Account for missing locations.** Make a row-level disposition for all 43 rejects.
   Check organizer or authoritative program sources for the named festival. Save confirmed
   locality or venue with its citation in a versioned enrichment or recapture. Keep
   ambiguous or unresolved rows in review with the reason. Avoid guessed coordinates,
   venue addresses from unrelated editions, and dates inferred from guide issue or month.
   This audit can proceed after the identity rule is proven offline.
4. **Validate the identity and cleanup.** Add a fixture for the two PIF rows, a same-issue
   conflict and one missing-location row. Run a provider-free pass over all 241 rows,
   then repeat with a reordered input. Require stable IDs, zero unexplained collisions,
   all rows accounted for, and two surviving PIF citations. Check whether the previous
   partial extraction left active observations under displaced IDs. Use source snapshot
   retirement for superseded rows only after a complete replacement is proven.
5. **Stage the next run.** Once the active queue reaches a safe handoff and validation is
   authorized, use the audited source record IDs for separate `ingest:supervise smoke`
   runs. Pass one `--record` per run for each PIF listing and one recovered location if
   available. Check published location precision, citation lineage, and whether matching
   represents the same festival consistently. An extractor-version or capture change
   requires a fresh run. Refresh inventory and queue the whole file only after the
   sample and row dispositions pass review.

The whole-file receipt should report raw rows, accepted listings, duplicates, explicit
exclusions and unresolved rows. Confirm current coverage and sample location and
deduplication quality separately from the execution result.
