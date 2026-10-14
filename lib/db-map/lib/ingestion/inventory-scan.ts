import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, resolve, relative } from "node:path";
import type { Pool } from "pg";
import { execFileSync } from "node:child_process";
import { hostInstallationId } from "../../scripts/ingest/host-installation.js";
import { INGEST_LOCK_NAMESPACE, INVENTORY_SCAN_LOCK } from "./locks.js";
import {
  POI_RELATIVE_PATH,
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
  await walk(resolve(root, POI_RELATIVE_PATH));
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Commit discovery only after a complete traversal; notes/classification are operator-owned. */
export async function refreshInventory(db: Pool, root = REPO_ROOT) {
  const client = await db.connect();
  let locked = false;
  let scanId: string | undefined;
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {}
  try {
    locked = (
      await client.query("SELECT pg_try_advisory_lock($1,$2) AS locked", [
        INGEST_LOCK_NAMESPACE,
        INVENTORY_SCAN_LOCK,
      ])
    ).rows[0].locked;
    scanId = (
      await client.query(
        `INSERT INTO research_ingest_inventory_scans(host_id,checkout,git_commit,status)
      VALUES($1,$2,$3,$4) RETURNING id`,
        [hostInstallationId(), root, commit, locked ? "running" : "busy"],
      )
    ).rows[0].id;
    if (!locked) {
      await client.query(
        "UPDATE research_ingest_inventory_scans SET finished_at=now(),error='Another inventory scanner owns the scan lock' WHERE id=$1",
        [scanId],
      );
      throw Object.assign(
        new Error(
          "Inventory refresh already running: another scanner owns the inventory lock",
        ),
        { code: "inventory_scan_busy" },
      );
    }
    const files = await discoverFiles(root);
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='15s'");
    // One metadata batch instead of three remote round trips per capture. Conflict
    // updates intentionally omit operator-owned category, disposition, notes and priority.
    await client.query(
      `WITH captured AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          path text,format text,sha256 text,size bigint,modified timestamptz,
          source text,category text,extractor text,error text)
      ) INSERT INTO research_ingest_inventory
        (logical_path,format,file_sha256,byte_size,modified_at,source_slug,category_slug,extractor_version,disposition,scan_error)
        SELECT x.path,x.format,x.sha256,x.size,x.modified,COALESCE(x.source,h.slug),
          COALESCE(h.category_slug,x.category),x.extractor,
          CASE WHEN h.slug IS NOT NULL OR x.category IS NOT NULL THEN 'import' ELSE 'needs_review' END,x.error
        FROM captured x LEFT JOIN LATERAL (
          SELECT f.category_slug,s.slug FROM research_source_files f
          JOIN research_sources s ON s.id=f.source_id WHERE f.logical_path=x.path
          ORDER BY f.last_seen_at DESC LIMIT 1
        ) h ON true
        ON CONFLICT(logical_path) DO UPDATE SET format=EXCLUDED.format,file_sha256=EXCLUDED.file_sha256,
          byte_size=EXCLUDED.byte_size,modified_at=EXCLUDED.modified_at,
          source_slug=EXCLUDED.source_slug,extractor_version=EXCLUDED.extractor_version,
          last_seen_at=now(),scanned_at=now(),missing_at=NULL,scan_error=EXCLUDED.scan_error`,
      [JSON.stringify(files)],
    );
    await client.query(
      `INSERT INTO research_ingest_inventory_versions(inventory_id,file_sha256,byte_size)
       SELECT id,file_sha256,byte_size FROM research_ingest_inventory
       WHERE logical_path=ANY($1::text[]) AND file_sha256 IS NOT NULL
       ON CONFLICT(inventory_id,file_sha256) DO UPDATE SET last_seen_at=now()`,
      [files.map((f) => f.path)],
    );
    const missing = await client.query(
      `UPDATE research_ingest_inventory SET missing_at=COALESCE(missing_at,now()),scanned_at=now()
      WHERE NOT(logical_path=ANY($1::text[]))`,
      [files.map((f) => f.path)],
    );
    await client.query(
      `UPDATE research_ingest_inventory_scans SET status='succeeded',finished_at=clock_timestamp(),discovered=$2,missing=$3,errors=$4 WHERE id=$1`,
      [
        scanId,
        files.length,
        missing.rowCount,
        JSON.stringify(
          files
            .filter((f) => f.error)
            .map((f) => ({ path: f.path, error: f.error })),
        ),
      ],
    );
    await client.query("COMMIT");
    return {
      scan_id: scanId,
      discovered: files.length,
      missing: missing.rowCount,
      errors: files
        .filter((f) => f.error)
        .map((f) => ({ path: f.path, error: f.error })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (scanId && locked)
      await client
        .query(
          "UPDATE research_ingest_inventory_scans SET status='failed',finished_at=clock_timestamp(),error=$2 WHERE id=$1",
          [scanId, error instanceof Error ? error.message : String(error)],
        )
        .catch(() => undefined);
    throw error;
  } finally {
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock($1,$2)", [
          INGEST_LOCK_NAMESPACE,
          INVENTORY_SCAN_LOCK,
        ])
        .catch(() => undefined);
    client.release();
  }
}
