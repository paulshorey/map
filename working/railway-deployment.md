# Railway deployment repair — 2026-09-21

Target: World / dev / apps/map. Root cause: `.railway/railway.ts` is evaluated
by the CLI, not read during deployment. With no dashboard start override and no
root package start script, Railpack preparation failed before building.

Applied dashboard build/start commands for `./apps/map`, `/api/health`, and a
30-second healthcheck timeout. Repository root remains the build context.
Deployment `e8698043-1c5d-49e9-b7f8-d876c2d3f136` is Active/Online.
Railpack detected the custom start command; the production build succeeded.
Next.js started on port 8080 and reported ready in 413 ms.
`https://appsmap-dev-cb30.up.railway.app/api/health` returned HTTP 200 with
`{"status":"ok"}`. Verified the HTTP response directly because Chrome blocked
opening the health URL with `net::ERR_BLOCKED_BY_CLIENT`.

Corrected local IaC service name, GitHub source, and optional project-name fallback.
See [deployment instructions](../.railway/README.md) for CLI import/plan/apply.
The full live environment has not been imported or applied through IaC.
Strict standalone TypeScript checking of the corrected config and `git diff
--check` passed. Local changes are uncommitted; the live fix uses saved dashboard
settings and the existing GitHub commit.

## IaC development environment

Added pinned Railway CLI `5.59.0`, repository scripts for login/link/status/export/
plan/apply, the pnpm installer allowlist, preserved `DB_MAP_URL`, and the official
`railwayapp/config@v1` PR workflow. Updated root/app agent rules and human setup docs.

Railway PR Environments are enabled with `dev` as the base. Focused PR Environments
and Bot PR Environments are enabled. Local dependency install, IaC TypeScript check,
workflow YAML parse, CLI version check, and whitespace validation pass.

Remaining external bootstrap requires security credentials: authorize the Railway
CLI OAuth client; create a project token scoped to `dev`; store it as GitHub Actions
secret `RAILWAY_TOKEN`; inspect the live graph; plan and apply the initial IaC state;
then confirm a second plan is clean. These steps intentionally await authorization at
the OAuth/token grant because they create broad CLI access and a persistent CI
credential.

## Production repair

Target: World / production / map. The source was already connected to `prod`, but the
service had no monorepo build or start override, so deployment
`58d73e26-7419-45a9-8f49-de24a9a8b85b` failed during Railpack preparation with
`No start command detected`.

Applied the shared build/start commands, six watch paths, `/api/health`, and a
30-second healthcheck timeout through the Railway dashboard. This was an authorized
recovery bootstrap while CLI OAuth and the production project token remain unset.
Deployment `259383e0-e7d6-4790-bf63-54cd32a90eec` was started from `prod`.
It reached Active/Online, and both the Railway domain and `festivals.earth` returned
HTTP 200 with `{"status":"ok"}` from `/api/health`. Deploy logs show the filtered
workspace start script, Next.js bound to port 8080, and readiness in 325 ms.

Updated `railway.ts` to select service `apps/map` / branch `main` in dev and service
`map` / branch `prod` in production. Added the fixed-ID production link command and
repository skill `.agents/skills/railway-iac/SKILL.md`. Reconcile both live
environments with reviewed CLI plans after the corresponding environment-scoped
credentials are available.
