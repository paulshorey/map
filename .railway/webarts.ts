import { defineRailway, preserve, project, service } from "railway/iac";

// The same repository also deploys to World using railway.ts.
export const partial = "map";

export default defineRailway((ctx) => {
  if (ctx.projectId !== "c6260c51-8b01-4934-8ccb-9cf32456744c") {
    throw new Error("webarts.ts must target the WebArts Railway project.");
  }
  const branch = ctx.environmentId === "4e7d33aa-1de0-441f-a105-352bbe3b6697"
    ? "main" : process.env.RAILWAY_IAC_BRANCH;
  if (!branch) throw new Error("Set RAILWAY_IAC_BRANCH to the existing preview branch.");
  return project("WebArts", {
    resources: [service("apps/map", {
      source: { repo: "paulshorey/map", branch },
      build: {
        builder: "RAILPACK",
        buildCommand: "pnpm --filter ./apps/map build",
        watchPatterns: ["apps/map/**", "lib/db-map/**", "lib/config/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"],
      },
      deploy: {
        startCommand: "pnpm --filter ./apps/map start",
        healthcheckPath: "/api/health",
        healthcheckTimeout: 30,
      },
      env: { DB_MAP_URL: preserve() },
    })],
  });
});
