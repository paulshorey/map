import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway((ctx) => {
  const production = ctx.isEnvironment("production");
  const map = service(production ? "map" : "apps/map", {
    source: {
      repo: "paulshorey/map",
      branch: production ? "prod" : "main",
    },
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm --filter ./apps/map build",
      watchPatterns: [
        "apps/map/**",
        "lib/db-map/**",
        "lib/config/**",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ],
    },
    deploy: {
      startCommand: "pnpm --filter ./apps/map start",
      healthcheckPath: "/api/health",
      healthcheckTimeout: 30,
    },
    env: {
      // The value stays in Railway and is inherited by PR environments.
      DB_MAP_URL: preserve(),
    },
  });

  return project(ctx.projectName ?? "World", { resources: [map] });
});
