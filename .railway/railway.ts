import { defineRailway, project, service } from "railway/iac";

export default defineRailway((ctx) => {
  const map = service("map", {
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
  });

  return project(ctx.projectName, { resources: [map] });
});
