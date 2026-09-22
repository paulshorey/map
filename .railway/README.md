# Railway Infrastructure as Code

[`railway.ts`](railway.ts) is the source of truth for the map deployments in project
**World**. It owns the GitHub source, Railpack commands, watch paths, healthcheck, and
the names of variables whose values remain stored in Railway with `preserve()`.

| Environment  | Service    | Git branch | Environment ID                         |
| ------------ | ---------- | ---------- | -------------------------------------- |
| `dev`        | `apps/map` | `main`     | `01e37c22-5804-4b63-80a3-5d00255951e4` |
| `production` | `map`      | `prod`     | `a77c64bc-8e82-46b7-8634-7b72453ebfd8` |

The definition uses `ctx.isEnvironment("production")` for the service name and
branch. All other declared behavior is shared.

Railway Infrastructure as Code (IaC) is applied configuration. Railway does not
load this TypeScript file as part of an ordinary GitHub deployment. The Railway CLI
or the official [`railwayapp/config`](https://github.com/railwayapp/config) action
evaluates it and writes the resulting configuration to the selected environment.
The populated fields in the service Settings page are therefore expected: they show
the live state produced by IaC. Do not clear them.

The dashboard's **Railway Config File** field belongs to deprecated Config as Code
(`railway.json` / `railway.toml`) and must remain unset. New services cannot opt into
that system.

## Repository tooling

The root package pins:

- `railway`: the TypeScript `railway/iac` SDK;
- `@railway/cli`: the CLI used locally and pinned in CI; and
- a pnpm build allowlist entry for the CLI's official native-binary installer.

Use Node.js 22.6 or newer when evaluating IaC. The official action uses Node 24.
Application builds remain compatible with the version selected by Railpack.

Install and validate without contacting Railway:

```bash
pnpm install --frozen-lockfile
pnpm railway:config:check
```

## Local setup for humans and interactive agents

Each developer authenticates into their own Railway account. Login credentials are
stored by the Railway CLI outside the repository.

```bash
pnpm railway:login
pnpm railway:link:dev
pnpm railway:status
```

For production work, replace the link step with:

```bash
pnpm railway:link:production
```

Before planning, confirm status identifies project `World` and the intended
environment. The link commands use fixed IDs so similarly named projects cannot be
selected by mistake. Linking changes the local target for subsequent export, plan,
apply, and service commands.

Inspect the live graph without overwriting the authoring file:

```bash
pnpm railway:config:export
```

Avoid `railway config pull --force` during normal development because it replaces
the authoring file. If a new resource was created outside IaC and must be imported,
first preserve the current file, inspect the live JSON export, then reconcile all
resources and variables. A whole-project IaC apply treats an omitted managed resource
or variable as a deletion.

Plan and apply:

```bash
pnpm railway:config:check
pnpm railway:config:plan
pnpm railway:config:apply
pnpm railway:config:plan
```

The first plan is read-only. Review the target environment, every change, and all
destructive operations before applying. The final plan must report that Railway is
already up to date. Then verify the new deployment and:

```bash
curl --fail --show-error https://appsmap-dev-cb30.up.railway.app/api/health
```

Direct local apply is reserved for the initial CI bootstrap and deliberate recovery.
Normal IaC changes use the pull-request workflow below.

## Cloud agents

Cloud agents cannot complete an interactive browser login. Give an authorized agent
a Railway project token scoped to the one intended environment as the secret
environment variable `RAILWAY_TOKEN`. A project token selects its project and
environment, so the agent can run the check, export, and plan commands without
`railway link`. Use separate credentials for dev and production; never reuse an
environment token to imply a different target.

Never place a token in `.env`, source files, command output, prompts, issue comments,
or artifacts. An agent may plan without changing Railway. It should apply only for an
explicit bootstrap/recovery task; routine application belongs to reviewed CI.

## Pull-request plans and merge applies

`.github/workflows/railway-config.yml` uses the official
`railwayapp/config@v1` action and CLI version `5.59.0`.

For same-repository pull requests that affect IaC or its tooling, the workflow:

1. evaluates the proposed `.railway/` tree against `World/dev`;
2. posts the plan on the pull request;
3. stores a pinned artifact containing the exact change set, environment etag, and
   `.railway/` Git tree; and
4. after merge, applies that artifact without replanning.

If the environment drifts, merge resolution changes `.railway/`, or no matching plan
artifact exists, apply fails. Refresh the pull request plan rather than bypassing the
guard. Merging a plan that visibly contains destructive operations is the approval
for the workflow's `confirm-destructive: true` apply.

Fork pull requests are skipped because GitHub does not expose repository secrets to
fork workflows. The Railway GitHub App and `id-token: write` let plans post under the
Railway identity; the action falls back to `github-actions` if that identity is not
available.

CI currently targets only `dev`. It requires a Railway project token for `dev` stored
as the GitHub Actions repository secret `RAILWAY_TOKEN`. Rotate the project token and
replace the GitHub secret together. Never reuse a personal account token. Production
plans and applies are manual until a separately scoped production workflow and secret
are deliberately added.

The first workflow merge cannot apply itself because no workflow on the default branch
created its pinned artifact. Bootstrap once with a reviewed local
`pnpm railway:config:apply`; subsequent IaC changes use pull requests.

## Preview deployments

Railway project settings currently use:

| Setting                 | Value   |
| ----------------------- | ------- |
| PR Environments         | Enabled |
| Base environment        | `dev`   |
| Focused PR Environments | Enabled |
| Bot PR Environments     | Enabled |

Opening an eligible PR clones `dev`, including its preserved variables, and creates
an isolated environment. Watch paths in `railway.ts` limit the `apps/map` preview to
changes affecting the app, its shared libraries, or workspace configuration. Railway
deletes the environment when the PR closes.

PR environments clone the _already applied_ base configuration. A change to
`railway.ts` receives a plan but is not applied to the ephemeral preview before merge.
If the base configuration changes while a preview exists, sync the preview from `dev`
in Railway or recreate it. Source-code changes still build from the PR branch.

Railway refuses to deploy a PR branch from a contributor outside the Railway workspace
unless that contributor's GitHub account is invited to the project. Bot previews apply
only to Railway's supported bot identities.

## Live service contract

| Setting            | Dev                                   | Production                            |
| ------------------ | ------------------------------------- | ------------------------------------- |
| Service            | `apps/map`                            | `map`                                 |
| Source             | `paulshorey/map`, branch `main`       | `paulshorey/map`, branch `prod`       |
| Root directory     | unset; build from monorepo root       | unset; build from monorepo root       |
| Builder            | Railpack                              | Railpack                              |
| Build              | `pnpm --filter ./apps/map build`      | `pnpm --filter ./apps/map build`      |
| Start              | `pnpm --filter ./apps/map start`      | `pnpm --filter ./apps/map start`      |
| Watch paths        | app, shared libs, workspace manifests | app, shared libs, workspace manifests |
| Healthcheck        | `/api/health`, 30 seconds             | `/api/health`, 30 seconds             |
| Preserved variable | `DB_MAP_URL`                          | `DB_MAP_URL`                          |

Health endpoints:

- dev: `https://appsmap-dev-cb30.up.railway.app/api/health`
- production: `https://map-production-5966.up.railway.app/api/health`

The app start script binds to Railway's `PORT`. Generated Railway domains and platform
defaults are omitted from the authoring file as recommended by Railway's importer.

References: [Railway IaC](https://docs.railway.com/infrastructure-as-code),
[Railway config CLI](https://docs.railway.com/cli/config),
[official config action](https://github.com/railwayapp/config), and
[PR Environments](https://docs.railway.com/guides/preview-deployments-with-pr-environments).
