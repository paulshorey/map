# Ingestion operations app

Read the root AGENTS.md, database guide, and shared ingestion runbook. This is a loopback-only
Node/TypeScript server plus a small static browser app, separate from the public map/mobile app.

- Keep completion logic in `@lib/db-map/sql/ingestion-inventory` and its shared assessment;
  do not implement a second browser-only interpretation of success.
- Use the shared `ingest:control` CLI for human/agent worker lifecycle and maintenance.
  Display the shared maintenance state; never imply that a pause request proves worker exit.
  Agents may stop/restart runs under the root authorization. Keep browser APIs typed and
  bounded; do not add arbitrary shell execution. Launch/resume remains in the terminal/CLI.
- Keep Host/origin checks, non-simple JSON mutation requests, static asset allowlist, and CSP.
  Treat raw filenames, errors, notes and provider responses as untrusted display content.
- Preserve draft edits while refreshing evidence. Keep file coverage, execution and freshness
  separate. Missing or ignored files retain history; scans must not delete ingestion data.
- Validate changes with app typecheck/tests, shared inventory tests, and live UI inspection.
  The inventory integration test uses an isolated two-record source and no paid providers.
