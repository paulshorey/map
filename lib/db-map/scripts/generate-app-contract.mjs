import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const mode = process.argv[2];

if (mode !== "--check" && mode !== "--write") {
  throw new Error(
    "Usage: node scripts/generate-app-contract.mjs --check|--write",
  );
}

const sourceFiles = ["contracts/map-app.ts"];

const scalarTypes = new Set(["boolean", "false", "number", "string", "true"]);

const parseBaseType = (value) => {
  const trimmed = value.trim();
  const arrayMatch = trimmed.match(/^Array<(.+)>$/);

  if (arrayMatch) {
    return {
      kind: "array",
      items: parseBaseType(arrayMatch[1]),
    };
  }

  if (trimmed.endsWith("[]")) {
    return {
      kind: "array",
      items: parseBaseType(trimmed.slice(0, -2)),
    };
  }

  if (scalarTypes.has(trimmed)) {
    return {
      kind: "scalar",
      type: trimmed,
    };
  }

  return {
    kind: "model",
    type: trimmed,
  };
};

const parseFieldType = (rawType) => {
  const unionParts = rawType
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const nullable = unionParts.includes("null");
  const nonNullParts = unionParts.filter((part) => part !== "null");

  if (nonNullParts.length !== 1) {
    throw new Error(`Unsupported field type: ${rawType}`);
  }

  return {
    ...parseBaseType(nonNullParts[0]),
    nullable,
  };
};

const parseInterfaces = async () => {
  const models = {};

  for (const sourceFile of sourceFiles) {
    const content = await fs.readFile(path.resolve(sourceFile), "utf8");
    const matches = content.matchAll(
      /export interface\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g,
    );

    for (const match of matches) {
      const [, modelName, body] = match;
      const fields = body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const fieldMatch = line.match(/^([A-Za-z0-9_]+)(\?)?:\s*(.+);$/);

          if (!fieldMatch) {
            throw new Error(
              `Unsupported interface line in ${sourceFile}: ${line}`,
            );
          }

          const [, fieldName, optionalMarker, rawType] = fieldMatch;
          return {
            name: fieldName,
            optional: optionalMarker === "?",
            ...parseFieldType(rawType),
          };
        });

      models[modelName] = { fields };
    }
  }

  return { models };
};

const outputPath = path.resolve("generated/contracts/map-app.json");
const generated = `${JSON.stringify(await parseInterfaces(), null, 2)}\n`;

if (mode === "--write") {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, generated, "utf8");
  console.log("Wrote generated/contracts/map-app.json");
  process.exit(0);
}

const existing = await fs.readFile(outputPath, "utf8").catch(() => null);

if (existing !== generated) {
  throw new Error(
    "generated/contracts/map-app.json is out of date. Run: pnpm --filter @lib/db-map app:contract:generate",
  );
}

console.log("generated/contracts/map-app.json is up to date");
