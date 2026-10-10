# Private local development through Tailscale

Run this project's web app on the desktop and open it in the registered phone's
browser at https://pauls-macbook-pro.taila9173b.ts.net:4200/.

The shared tool source is saved in the private
[paulshorey/tailscale-dev repository](https://github.com/paulshorey/tailscale-dev).
Clone it to `~/git/tailscale-dev` when recreating this setup on another Mac;
ordinary app builds and deployments do not require it.

From the repository root:

```bash
pnpm dev:tailscale --background
pnpm dev:tailscale:status
pnpm dev:tailscale:stop
```

Omit `--background` for terminal output and Ctrl+C cleanup. Keep the Mac awake,
online, and connected to Tailscale, and connect Tailscale on the S26 Ultra.

Ordinary `pnpm dev` and Tailscale mode both use local port 4200. The Next.js
server serves both UI and API; `/api/health` is the read-only readiness probe.
No ingestion, migration, or native build is started.

The shared tool is installed at `~/git/tailscale-dev`. Set `TAILSCALE_DEV_HOME`
if it is installed elsewhere. Its README owns the full operating procedure,
architecture, security boundary, and future-project recipe. The local
`tailscale.dev.json` profile owns this project's commands, ports, probes, and
optional services; `scripts/tailscale-dev.mjs` is a small version-1 wrapper.
There is no shared-tool dependency in ordinary app builds, tests, or deployments.

All existing app environment files remain unchanged. The launcher adds
development networking metadata without replacing application values. Remote HTTP and WebSocket requests pass through
the common phone guard. All servers bind to loopback; private Serve handles TLS.
OpenClaw and other project routes are preserved. Runtime state and logs live
under `~/.local/state/tailscale-dev/projects/map`, outside this repository.

Private Serve sessions expire when their owning processes end, Tailscale
restarts, or the Mac reboots. Restart this project after a reboot. The tool keeps
its filtering gateway alive while removing routes after a manager crash. Stop removes only owned routes and verified process groups. Existing
unmanaged processes are preserved. Application actions use the same database
and external services selected by ordinary local development. Installed native
apps keep their compiled configuration.
