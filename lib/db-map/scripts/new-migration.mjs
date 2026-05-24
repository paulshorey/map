import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rawName = process.argv.slice(2).join(" ").trim();
if (!rawName) {
  throw new Error(
    "Usage: pnpm --filter @lib/db-map db:migration:new -- <name>",
  );
}

const safeName = rawName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = [
  now.getUTCFullYear(),
  pad(now.getUTCMonth() + 1),
  pad(now.getUTCDate()),
  pad(now.getUTCHours()),
  pad(now.getUTCMinutes()),
].join("");

const file = `${stamp}__${safeName}.sql`;
const fullPath = path.resolve("migrations", file);

const template = `-- ${file}
-- Write forward-only SQL migration statements below.
-- scripts/migrate.mjs wraps each file in a transaction, so do not add BEGIN/COMMIT here.
--
-- For operations that cannot run inside a transaction (for example
-- CREATE INDEX CONCURRENTLY), add this line at the top of the file:
-- -- cursor:no-transaction
`;

await fs.writeFile(fullPath, template, { flag: "wx" });
console.log(`Created ${path.relative(process.cwd(), fullPath)}`);
