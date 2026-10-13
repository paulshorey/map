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

Validation: app typecheck and request tests, shared inventory tests, response headers,
and an actual browser iframe loading the dashboard across local ports.
