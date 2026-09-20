import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, resolve, relative } from "node:path";
import type { Pool } from "pg";
import {
  REPO_ROOT,
  resolveSourceFile,
} from "../../scripts/ingest/source-file.js";

export interface DiscoveredFile {
  path: string;
  format: string;
  sha256: string | null;
  size: number;
  modified: Date;
  source: string | null;
  category: string | null;
  extractor: string | null;
  error: string | null;
}
export async function discoverFiles(
  root = REPO_ROOT,
): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  async function walk(directory: string) {
    // Do not follow symlinks outside the capture tree. A failed traversal aborts the scan.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(json|jsonl|csv|kml|kmz)$/i.test(entry.name))
        continue;
      const path = relative(root, absolute).split("\\").join("/");
      const before = await stat(absolute);
      const item: DiscoveredFile = {
        path,
        format: extname(path).slice(1).toLowerCase(),
        sha256: null,
        size: before.size,
        modified: before.mtime,
        source: null,
        category: null,
        extractor: null,
        error: null,
      };
      try {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute))
          hash.update(chunk);
        const after = await stat(absolute);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("File changed during scan; refresh inventory again");
        item.sha256 = hash.digest("hex");
        if (
          root === REPO_ROOT &&
          ["json", "jsonl", "csv"].includes(item.format)
        ) {
          const source = await resolveSourceFile(path);
          item.source = source.source.meta.slug;
          item.category = source.file.category || null;
          item.extractor = source.extractorVersion;
        }
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
      files.push(item);
    }
  }
  await walk(resolve(root, "docs/poi"));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Commit discovery only after a complete traversal; notes/classification are operator-owned. */
export async function refreshInventory(db: Pool, root = REPO_ROOT) {
  const client = await db.connect();
  let locked = false;
  try {
    locked = (
      await client.query("SELECT pg_try_advisory_lock(91832,1) AS locked")
    ).rows[0].locked;
    if (!locked) throw new Error("Inventory refresh already running");
    const files = await discoverFiles(root);
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='15s'");
    for (const file of files) {
      const history = (
        await client.query(
          `SELECT f.category_slug,s.slug FROM research_source_files f
        JOIN research_sources s ON s.id=f.source_id WHERE f.logical_path=$1 ORDER BY f.last_seen_at DESC LIMIT 1`,
          [file.path],
        )
      ).rows[0];
      const { rows } = await client.query(
        `INSERT INTO research_ingest_inventory
        (logical_path,format,file_sha256,byte_size,modified_at,source_slug,category_slug,extractor_version,disposition,scan_error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(logical_path) DO UPDATE SET format=EXCLUDED.format,file_sha256=EXCLUDED.file_sha256,
          byte_size=EXCLUDED.byte_size,modified_at=EXCLUDED.modified_at,
          source_slug=EXCLUDED.source_slug,extractor_version=EXCLUDED.extractor_version,
          last_seen_at=now(),scanned_at=now(),missing_at=NULL,scan_error=EXCLUDED.scan_error
        RETURNING id`,
        [
          file.path,
          file.format,
          file.sha256,
          file.size,
          file.modified,
          file.source ?? history?.slug ?? null,
          history?.category_slug ?? file.category,
          file.extractor,
          history || file.category ? "import" : "needs_review",
          file.error,
        ],
      );
      if (file.sha256)
        await client.query(
          `INSERT INTO research_ingest_inventory_versions(inventory_id,file_sha256,byte_size)
        VALUES($1,$2,$3) ON CONFLICT(inventory_id,file_sha256) DO UPDATE SET last_seen_at=now()`,
          [rows[0].id, file.sha256, file.size],
        );
    }
    const missing = await client.query(
      `UPDATE research_ingest_inventory SET missing_at=COALESCE(missing_at,now()),scanned_at=now()
      WHERE NOT(logical_path=ANY($1::text[]))`,
      [files.map((f) => f.path)],
    );
    await client.query("COMMIT");
    return {
      discovered: files.length,
      missing: missing.rowCount,
      errors: files
        .filter((f) => f.error)
        .map((f) => ({ path: f.path, error: f.error })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock(91832,1)")
        .catch(() => undefined);
    client.release();
  }
}
