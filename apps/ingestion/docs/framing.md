# Private dashboard and iframe previews

The ingestion dashboard is a private internal tool. It runs on Paul's computer, directly
on loopback or through a private Tailscale proxy restricted to approved trusted devices.
It is never intended to be a public admin service. Embedding it in local-dev is supported.

We retained a small CSP `frame-ancestors` allowlist because it requires no authentication
service, proxy changes or ongoing security machinery and preserves the existing preview:

- Same-origin parents are allowed.
- HTTP `127.0.0.1` and `localhost` parents are allowed on any port. local-dev currently uses
  port 8000; flexible ports also keep its existing framing probe from marking this app tab-only.
- Additional trusted parents can be supplied as exact HTTP(S) origins in
  `INGESTION_FRAME_ORIGINS`. Wildcards, credentials, paths, queries and fragments are rejected.

The policy is built once at startup, not inferred from request headers. Existing API
Host/origin and JSON mutation checks remain. No login flow or public-admin protection was added.
Future agents should preserve the private deployment model and working previews, and avoid
expanding security scope merely because this app has administrative controls.

At the time of this change, ingestion has `publish: false` and no private proxy URL in
local-dev. Trusting a Tailscale parent does not itself publish the app or change API admission.
If private preview access is later enabled, configure the exact trusted controller origin and
verify the existing proxy's request normalization. Do not enable public Tailscale Funnel.

The implementation was checked with HTTP response tests and actual browser allow/block checks.
See [the dashboard README](../README.md) for startup and origin configuration.
