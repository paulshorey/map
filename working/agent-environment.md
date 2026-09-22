# Cloud AI agent environment

Portable bootstrap for a second agent host (Codex Cloud, Claude Code Cloud, and
similar). This Cursor environment already injects secrets and runs `pnpm install`;
the other service needs an explicit setup script.

## What to paste into the other service

Setup / install field (repository already checked out):

```bash
bash scripts/agent-env.sh setup
```

Optional maintenance field (cached container / resume):

```bash
bash scripts/agent-env.sh maintenance
```

Optional start field, if the host keeps processes running:

```bash
bash scripts/agent-env.sh start
```

`setup` is idempotent. It does **not** start a blocking dev server; Codex/Claude
setup scripts must exit. Use `start` only when the host has a separate start hook.

## Host configuration

Set these as environment variables that remain available after setup. On Codex,
prefer environment variables over secrets: Codex secrets are setup-only. This
script copies present values into `~/.config/poi-map/agent.env` (mode 600) and
sources that file from `~/.bashrc` / `~/.profile`.

Required:

- `DB_MAP_URL` — same shared PostgreSQL this project already uses

For ingestion work, also inject:

- `LOCATIONIQ_API_KEY`
- `JINA_API_KEY`
- `DEEPINFRA_API_KEY`

Optional:

- `RAILWAY_TOKEN` — `dev`-scoped Railway project token; never print or commit
- `THUNDERFOREST_API_KEY`
- `NEXT_PUBLIC_API_URL` — only for Capacitor/mobile builds

Allow outbound network to the database host during the agent phase. Agent-phase
internet is often off by default; a remote `DB_MAP_URL` will fail without it.

Isolated fallback when the shared database cannot be reached:

```bash
bash scripts/agent-env.sh setup --local-db
```

`--seed` is refused against a remote URL. Combine it with `--local-db` only.

## After setup

```bash
bash scripts/agent-env.sh check
pnpm --filter @lib/db-map ingest:status
pnpm dev                    # map at http://127.0.0.1:5000
pnpm dev:ingestion          # dashboard at http://127.0.0.1:5001
```

Do not launch full ingestion from an expensive model. Follow root `AGENTS.md`.

## Implementation

- [scripts/agent-env.sh](../scripts/agent-env.sh) — install, persist env, migrate, build, run
- [scripts/sql-check-postgres-client-version.sh](../scripts/sql-check-postgres-client-version.sh) — `pg_dump` must match the server major (currently 18)
