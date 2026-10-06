import { getDb } from "../../lib/db/postgres.js";
import { refreshInventory } from "../../lib/ingestion/inventory-scan.js";
import {
  getInventory,
  getInventoryDetail,
  editInventory,
} from "../../sql/ingestion-inventory.js";
const args = process.argv.slice(2);
let scan = false,
  json = false,
  file: string | undefined,
  editFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--refresh") scan = true;
  else if (args[i] === "--json") json = true;
  else if (args[i] === "--file" && args[i + 1]) file = args[++i];
  else if (args[i] === "--edit-file" && args[i + 1]) editFile = args[++i];
  else
    throw new Error(
      "Usage: ingest:inventory [--refresh] [--json] [--file data/poi/... [--edit-file /path/to/edit.json]]",
    );
}
if (editFile && (!file || scan))
  throw new Error(
    "--edit-file requires --file and cannot combine with --refresh",
  );
const db = getDb();
try {
  const refresh = scan ? await refreshInventory(db) : undefined;
  let result = await getInventory(db);
  let selected = file
    ? result.files.find((f) => f.logical_path === file || f.id === file)
    : undefined;
  if (file && !selected)
    throw new Error("File not found in inventory; run with --refresh first");
  if (editFile && selected) {
    await editInventory(
      db,
      selected.id,
      JSON.parse(await readFile(editFile, "utf8")),
    );
    result = await getInventory(db);
    selected = result.files.find(
      (f) => f.logical_path === file || f.id === file,
    );
  }
  if (json)
    console.log(
      JSON.stringify(
        {
          ...result,
          refresh,
          files: selected ? [selected] : result.files,
          detail: selected
            ? await getInventoryDetail(db, selected.id)
            : undefined,
        },
        null,
        2,
      ),
    );
  else {
    if (refresh)
      console.log(
        `Discovered ${refresh.discovered}; missing ${refresh.missing}; scan errors ${refresh.errors.length}`,
      );
    console.log(
      "COVERAGE          VERIFIED / TOTAL    EXECUTION                 FILE",
    );
    for (const f of selected ? [selected] : result.files)
      console.log(
        `${f.coverage.padEnd(18)}${`${f.verified} / ${f.total ?? "?"}`.padEnd(20)}${f.execution.padEnd(26)}${f.logical_path}\n  ${f.freshness} · ${f.disposition} · ${f.next}`,
      );
    if (!result.files.length)
      console.log("No inventory yet. Run ingest:inventory --refresh");
    if (selected) console.log(JSON.stringify(selected.commands, null, 2));
  }
} finally {
  await db.end();
}
import { readFile } from "node:fs/promises";
