---
name: railway-iac
description: Configure, inspect, repair, and automate Railway deployments with the Railway CLI, railway/iac TypeScript definitions, railwayapp/config CI plans, and PR environments. Use for Railway service settings, deployment failures, environment drift, IaC plans/applies, project tokens, or preview deployment setup.
---

# Railway Infrastructure as Code

Use the repository's `.railway/railway.ts` as the deployment source of truth. Read
the root `AGENTS.md` and `.railway/README.md` before acting; they contain project
IDs, scripts, CI behavior, current environments, and local authorization rules.

## Keep the two Railway systems distinct

- Infrastructure as Code is `.railway/railway.ts`, evaluated by Railway CLI
  `config plan` / `config apply` or `railwayapp/config` in CI.
- The dashboard **Railway Config File** field is only for deprecated
  `railway.json` / `railway.toml`. Leave it unset for IaC services.
- Applied IaC values appear as populated service Settings fields. Do not clear
  them; they are Railway's live representation of the desired configuration.
- A Git push deploys source using the already applied settings. It does not
  evaluate `.railway/railway.ts` by itself.

## Establish the exact target

Inspect before mutating:

```bash
pnpm install --frozen-lockfile
pnpm railway:config:check
pnpm railway:status
pnpm railway:config:export
```

`config:export` uses `railway config pull --json` so it cannot overwrite the
authored file. Avoid `config pull --force` during normal work. Confirm the project,
environment, service name, connected repository/branch, existing variables,
domains, volumes, databases, and current deployment failure.

Do not assume a service has the same name in every environment. If live environments
use distinct service resources, encode both the service name and source branch through
`ctx.isEnvironment(name)` and verify the plan maps to the existing resources rather
than creating replacements.

On Paul’s Mac, local agents use `RAILWAY_API_TOKEN` exported from `~/.secrets.sh`.
`~/.shortcuts.sh` contains helpers, not Railway credentials. Clean noninteractive
shells must receive the token explicitly. Unset `RAILWAY_TOKEN`, require a nonempty
API token, and select exact `RAILWAY_PROJECT_ID` / `RAILWAY_ENVIRONMENT_ID` values.
Workspace tokens can fail `whoami` or `link` despite valid project access; verify a
scoped read before declaring authentication broken:

```bash
(
  unset RAILWAY_TOKEN
  test -n "${RAILWAY_API_TOKEN:-}" || exit 1
  export RAILWAY_PROJECT_ID=d25b93f2-bea9-4f05-a6c0-4a045e8b18ac
  export RAILWAY_ENVIRONMENT_ID=01e37c22-5804-4b63-80a3-5d00255951e4
  pnpm exec railway api 'query($id:String!){project(id:$id){id name workspaceId}}' \
    --raw-var id="$RAILWAY_PROJECT_ID"
  pnpm railway:config:plan
)
```

This definition targets **Map**. Experimental is a different project
(`c6260c51-8b01-4934-8ccb-9cf32456744c`), managed here only by the `map` partial in
`.railway/webarts.ts`; pass that file explicitly with its dev environment ID.
Never point the whole Map definition at Experimental.

Cloud agents and CI receive only the intended environment’s project token as
`RAILWAY_TOKEN`, with `RAILWAY_API_TOKEN` unset. Verify its scope with
`railway api 'query{projectToken{projectId environmentId}}'` before use. Never
persist control-plane tokens in `agent.env` or copy the local workspace credential
to CI. Interactive login is an alternative when no token is supplied. Never print
or commit tokens or variable values.

## Author complete desired state

Treat a whole-project definition as complete for the selected environment:
omitted managed resources or variables can be deleted. Import live variable names
with `preserve()` so Railway retains values without putting secrets in source.
Generated Railway domains and platform defaults may remain omitted when Railway's
importer omits them.

Use `ctx.isEnvironment(name)` for intentional differences. Keep shared behavior in
one definition and vary only the required property, for example:

```ts
source: {
  repo: "owner/repo",
  branch: ctx.isEnvironment("production") ? "prod" : "main",
},
```

For this monorepo, build from the repository root so pnpm workspace packages are
available. Declare explicit filtered build/start commands; a package-level `start`
script is not discoverable by Railpack when the service builds from the monorepo
root.

## Plan, apply, and verify

After edits:

```bash
pnpm railway:config:check
pnpm railway:config:plan
```

Read the entire plan. Verify the environment, branch, commands, preserved
variables, and all creates/updates/deletes. Stop on an unexpected deletion, missing
resource, wrong target, provider error, or ambiguous drift. Fix the definition;
do not repeatedly apply or redeploy around an unresolved cause.

Normal IaC changes go through the `railwayapp/config` pull-request workflow. It
pins the change set, environment etag, and `.railway/` tree; merge applies that
exact artifact. Fork PRs cannot receive the Railway secret. Direct apply is for an
explicit bootstrap or recovery:

Automatic applies disable destructive confirmation. The current default Map/dev
graph proposes deleting its database and backup bucket; reconcile ownership and
service identity before merging or applying it. Read `.railway/README.md` for the
current blocker. A successful authenticated plan is not approval to apply it.

```bash
pnpm railway:config:apply
pnpm railway:config:plan
```

The second plan must converge to no changes. Then verify the deployment reaches a
terminal Active/Online state, inspect build and deploy logs, and call the configured
health endpoint through the Railway domain and important custom domains. Exit zero
alone is not sufficient. Railway's healthcheck gates a new deployment but is not
continuous monitoring.

If a service is already down and IaC authentication is unavailable, an explicitly
authorized bootstrap may set the exact desired build/start/health values in the
dashboard to restore service. Make the same IaC edit, record the temporary bootstrap,
and reconcile with a plan as soon as credentials are available.

## PR environments

PR environments clone their configured base environment; they do not apply proposed
IaC changes before merge. Source changes deploy from the PR branch. Use focused PR
environments with service watch paths in monorepos, and enable bot PR environments
only when AI-authored previews are intended. Sync or recreate an existing preview
after its base environment configuration changes.

Use Railway's current official documentation when CLI flags, action inputs, or UI
behavior may have changed:

- https://docs.railway.com/infrastructure-as-code
- https://docs.railway.com/cli/config
- https://github.com/railwayapp/config
- https://docs.railway.com/guides/preview-deployments-with-pr-environments
- https://docs.railway.com/deployments/healthchecks
