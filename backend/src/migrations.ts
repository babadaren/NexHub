import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export class MigrationChecksumError extends Error {
  constructor(readonly version: string) {
    super(
      `Migration checksum changed for ${version}. Published migration files must not be edited in place. Stop the app, restore the last good backup, or upgrade with a compensating migration from a fixed release.`
    );
    this.name = "MigrationChecksumError";
  }
}

export async function runMigrations(pool: Pool, migrationsDir = path.resolve(process.cwd(), "backend", "migrations")) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = await readFile(fullPath, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = $1", [file]);

    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new MigrationChecksumError(file);
      }
      continue;
    }

    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations(version, checksum) VALUES($1, $2)", [file, checksum]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
