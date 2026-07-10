import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { listSourceDefinitions } from "./sources.js";
import type { SourceDefinition, SourceFileDefinition } from "./types.js";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const POI_ROOT = resolve(REPO_ROOT, "docs/poi");

export interface ResolvedSourceFile {
  absolutePath: string;
  logicalPath: string;
  source: SourceDefinition;
  file: Required<Pick<SourceFileDefinition, "pattern" | "category">> & SourceFileDefinition;
  format: "json" | "jsonl" | "csv";
  mode: "snapshot" | "incremental";
  extractorVersion: string;
}

function normalizePath(value: string): string {
  return value.split(sep).join("/");
}

function patternRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function extensionFormat(path: string): "json" | "jsonl" | "csv" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  throw new Error(`Unsupported source file: ${path} (expected .json, .jsonl, or .csv)`);
}

export function normalizationProfileForCategory(category: string): string {
  if (["music_festival", "carnival", "art_fair", "art_parade"].includes(category)) return "event";
  if (category === "campground") return "campground";
  if (category === "botanical_garden" || category === "arboretum") return "garden";
  return "place";
}

function inferredSource(logicalPath: string, category: string): SourceDefinition {
  const filename = basename(logicalPath).replace(/\.(jsonl|json|csv)$/i, "");
  const genericNames = new Set(["facilities", "events", "records", "data", "places"]);
  const parent = basename(dirname(logicalPath));
  const seed = genericNames.has(filename.toLowerCase()) ? parent : filename;
  const slug = seed
    .replace(/_(festivals|events|places|full|data)$/i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!slug) throw new Error(`Unable to infer source slug from ${logicalPath}`);
  return {
    meta: { slug, name: slug.replace(/_/g, " "), trust: 50 },
    normalizationProfile: normalizationProfileForCategory(category),
  };
}

export async function resolveSourceFile(
  inputPath: string,
  category: string,
): Promise<ResolvedSourceFile> {
  // Category always comes from the CLI. The source registry may document an expected slug,
  // but ingestion never infers category from path, filename, or raw record fields.
  const absolutePath = resolve(REPO_ROOT, inputPath);
  const poiRelative = relative(POI_ROOT, absolutePath);
  if (
    poiRelative === "" ||
    poiRelative.startsWith(`..${sep}`) ||
    poiRelative === ".." ||
    poiRelative.startsWith("/")
  ) {
    throw new Error(`Source file must be under ${POI_ROOT}: ${absolutePath}`);
  }

  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Source path is not a file: ${absolutePath}`);

  const logicalPath = normalizePath(relative(REPO_ROOT, absolutePath));
  const matches: Array<{ source: SourceDefinition; file: SourceFileDefinition }> = [];
  for (const source of listSourceDefinitions()) {
    for (const file of source.files ?? []) {
      if (patternRegex(file.pattern).test(logicalPath)) matches.push({ source, file });
    }
  }
  if (matches.length === 0) {
    const source = inferredSource(logicalPath, category);
    const file: SourceFileDefinition = { pattern: logicalPath, category };
    return {
      absolutePath,
      logicalPath,
      source,
      file,
      format: extensionFormat(logicalPath),
      mode: "snapshot",
      extractorVersion: "generic-v1",
    };
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous source file ${logicalPath}: ${matches.map((m) => m.source.meta.slug).join(", ")}`,
    );
  }

  const match = matches[0]!;
  const actualFormat = extensionFormat(logicalPath);
  if (match.file.format && match.file.format !== actualFormat) {
    throw new Error(
      `Registered format ${match.file.format} does not match ${actualFormat} for ${logicalPath}`,
    );
  }

  return {
    absolutePath,
    logicalPath,
    source: {
      ...match.source,
      normalizationProfile:
        match.source.normalizationProfile ?? normalizationProfileForCategory(category),
    },
    file: { ...match.file, category },
    format: actualFormat,
    mode: match.file.mode ?? "snapshot",
    extractorVersion: match.file.extractorVersion ?? "1",
  };
}

export async function hashSourceFile(
  absolutePath: string,
): Promise<{ sha256: string; byteSize: number }> {
  const info = await stat(absolutePath);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return { sha256: hash.digest("hex"), byteSize: info.size };
}
