import { readFile } from "node:fs/promises";
export async function expectedCaptures() {
  const catalog = JSON.parse(
    await readFile(
      new URL(
        "../../../../data/poi-research/expected-captures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.captures))
    throw new Error("Unsupported expected-capture catalog");
  const seen = new Set<string>();
  for (const c of catalog.captures) {
    if (
      typeof c.file !== "string" ||
      !c.file.startsWith("data/poi/") ||
      c.file.split("/").includes("..") ||
      seen.has(c.file) ||
      typeof c.required !== "boolean"
    )
      throw new Error("Invalid or duplicate expected capture");
    seen.add(c.file);
  }
  return catalog.captures as Array<{
    file: string;
    source: string | null;
    category: string | null;
    required: boolean;
    disposition: string;
    reason: string;
  }>;
}
