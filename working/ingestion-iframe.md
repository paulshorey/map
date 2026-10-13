# Ingestion dashboard iframe previews

The dashboard's `frame-ancestors 'none'` response policy prevented iframe navigation.
The local-dev catalog also configured Map ingestion as `tabOnly: true`, which displayed
the new-tab fallback before attempting to load a frame.

Remove the dashboard's frame-ancestor restriction while retaining the rest of its CSP,
loopback binding, Host/origin checks and JSON/client-header mutation requirements.
Enable previews for only the `map-ingestion` web service in local-dev's `config.json`.
Its service stays local-only (`publish: false`). Restart only the dashboard server and
reload the parent dashboard to pick up both policies. Ingestion workers, maintenance,
schema and data do not require changes.

Completed October 13, 2026. App typecheck, all 3 request tests, all 12 shared inventory
tests, and `git diff --check` passed. The paired local-dev change passed its 110-test
suite. After the dashboard restart, live response headers and the launcher snapshot
reported no framing restriction and `tabOnly: false`. A browser iframe on another local
port displayed the dashboard with live inventory and worker evidence. The ingestion
worker continued running and maintenance remained open.

Handoffs: [map #41](https://github.com/paulshorey/map/pull/41) and
[local-dev #4](https://github.com/paulshorey/local-dev/pull/4). Isolated feature branches
hold the committed changes; applied copies remain in the busy primary checkouts so
the local dashboard works immediately without changing their existing branch histories.
