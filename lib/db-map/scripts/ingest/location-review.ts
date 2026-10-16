import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decisionTemplate,
  makePacket,
  renderPacket,
  summarizeReviews,
  type ReviewPacket,
} from "./location-review/model.js";

const usage = `Read-only location review (zero provider calls; no repair):
  ingest:location-review export --out NEW_DIRECTORY [--run UUID] [--source SLUG] [--limit 1..100] [--seed TEXT]
  ingest:location-review summarize --packet PACKET_JSON --decisions REVIEW_JSON --out NEW_DIRECTORY
Defaults: 40 source/build pairs; seed location-review-v1. Only published build inputs whose
source/record passed verification in a succeeded/verified run are eligible. Each case
states whether that checkpoint binds its normalization, observation, or record identity only.
Output folders must be new. Preserve packet.json with dated decision revisions.`;

export function parseReviewArgs(argv: string[]) {
  const command = argv[0];
  if (command === "--help")
    return { command: "help" as const, flags: {} as Record<string, string> };
  if (command !== "export" && command !== "summarize") throw new Error(usage);
  const allowed =
    command === "export"
      ? ["out", "run", "source", "limit", "seed"]
      : ["out", "packet", "decisions"];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2),
      value = argv[i + 1];
    if (
      !argv[i]?.startsWith("--") ||
      !key ||
      !allowed.includes(key) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(flags, key)
    )
      throw new Error(
        `Unknown, duplicate or incomplete flag: ${argv[i]}\n${usage}`,
      );
    flags[key] = value;
  }
  if (
    !flags.out ||
    (command === "summarize" && (!flags.packet || !flags.decisions))
  )
    throw new Error(usage);
  if (
    flags.run &&
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(flags.run)
  )
    throw new Error("Invalid run UUID");
  if (flags.source && !/^[a-z0-9_-]{1,100}$/.test(flags.source))
    throw new Error("Invalid source slug");
  if (
    flags.limit &&
    (!/^\d+$/.test(flags.limit) ||
      Number(flags.limit) < 1 ||
      Number(flags.limit) > 100)
  )
    throw new Error("Limit must be 1–100");
  if (flags.seed && flags.seed.length > 100)
    throw new Error("Seed must be 1–100 characters");
  return { command, flags };
}

async function main() {
  const { command, flags } = parseReviewArgs(process.argv.slice(2));
  if (command === "help") {
    console.log(usage);
    return;
  }
  const out = resolve(flags.out!);
  try {
    await access(out);
    throw new Error(
      "Output already exists; use a new folder to preserve evidence",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const save = async (name: string, value: unknown) =>
    writeFile(
      join(out, name),
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  if (command === "export") {
    const selection = {
      limit: Number(flags.limit ?? 40),
      seed: flags.seed ?? "location-review-v1",
      source: flags.source,
      run: flags.run,
    };
    const { getDb, closeDb } = await import("../../lib/db/postgres.js");
    const { sampleLocationReview } =
      await import("../../sql/ingestion-location-review.js");
    let packet: ReviewPacket;
    try {
      packet = makePacket(
        await sampleLocationReview(getDb(), selection),
        selection,
      );
    } finally {
      await closeDb();
    }
    await mkdir(out, { mode: 0o700 });
    await save("packet.json", packet);
    await save("review.md", renderPacket(packet, false));
    await save("field-lineage.md", renderPacket(packet));
    await save("decisions.template.json", decisionTemplate(packet));
    console.log(
      JSON.stringify(
        {
          packet_id: packet.packet_id,
          selected: packet.cases.length,
          candidate_inconsistencies: packet.cases.filter((c) =>
            c.findings.some((f) => f.kind !== "coverage"),
          ).length,
          bound_reverse: packet.cases.filter((c) => c.reverse_comparable)
            .length,
          population: packet.population,
          out,
          database_writes: 0,
          provider_calls: 0,
        },
        null,
        2,
      ),
    );
  } else {
    const packet = JSON.parse(
      await readFile(resolve(flags.packet!), "utf8"),
    ) as ReviewPacket;
    const decisions = JSON.parse(
      await readFile(resolve(flags.decisions!), "utf8"),
    );
    const summary = summarizeReviews(packet, decisions);
    await mkdir(out, { mode: 0o700 });
    await save("summary.json", summary);
    await save("decisions.json", decisions);
    console.log(JSON.stringify({ out, ...summary }, null, 2));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error("Location review failed:", (error as Error).message);
    process.exitCode = 1;
  });
}
