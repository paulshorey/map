Forward-only SQL migrations. Naming: `YYYYMMDDHHMM__snake_case_description.sql`.

Each file is wrapped in a transaction by `scripts/migrate.mjs` — do not add `BEGIN`/`COMMIT`.

For `CREATE INDEX CONCURRENTLY`, add `-- cursor:no-transaction` at the top of the file.
