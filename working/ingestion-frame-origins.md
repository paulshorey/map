# Ingestion dashboard framing repair

The unrestricted framing change in PRs #41 and #42 permits clickjacking of the local
operations UI. The replacement policy trusts same-origin and HTTP loopback controllers
(`127.0.0.1` / `localhost`, any port), with exact additional parents supplied through
`INGESTION_FRAME_ORIGINS`. API Host/origin checks and JSON mutation requirements remain.

This independent dashboard branch is based on PR #40 at `a923e54`. It changes no ingestion
runtime, providers, schema, data or lifecycle state. When integrating with PR #41 or #42,
retain the restricted policy rather than their removal of `frame-ancestors`.

The current local-dev controller uses port 8000. Its probe regards a frame policy without
any wildcard as tab-only, so flexible **loopback ports** preserve the existing preview
without granting a public-site wildcard. The private controller is
`https://pauls-macbook-pro.taila9173b.ts.net:8000`; ingestion currently has `publish: false`
and no private URL. An explicit parent allowlist does not create private proxy access or
relax API admission. Setup details belong in [the dashboard README](../apps/ingestion/README.md).

Validation on 2026-10-14:

- Dashboard typecheck and four tests passed; shared inventory suite: 14 passed.
- Read-only browser inspection of the isolated worktree dashboard on port 5101 rendered
  live inventory and intervention evidence inside local-dev's exact iframe sandbox.
- Both `127.0.0.1` and `localhost` controller parents rendered the dashboard.
- `evil.localhost` reached the same test parent server but the browser blocked its child
  dashboard, demonstrating that loopback resolution alone grants no framing permission.
- The actual local-dev `probe()` returned HTTP 200, the restricted policy and `tabOnly: false`.
- Primary checkout, its dashboard/controller processes and ingestion admission were untouched.

Operational rollout remains pending: integrate the PR and coordinate a dashboard-only restart
with the owner. No production service or primary checkout was changed by this repair.
