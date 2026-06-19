## SQL DB BACKUP/RESTORE

Generic PostgreSQL backup/restore for the `public` schema. Requires `psql` and
`pg_dump` on PATH with a major version matching the server (see
`sql-check-postgres-client-version.sh`).

Backup schema and data:

```
./scripts/sql-backup-schema.sh --db-url 'postgresql://...'
./scripts/sql-backup-data.sh --db-url 'postgresql://...'
```

Restore schema and data:

```
./scripts/sql-restore-schema.sh --db-url 'postgresql://...' scripts/backups/public-schema-YYYYMMDD-HHMMSS.sql
./scripts/sql-restore-data.sh --db-url 'postgresql://...' scripts/backups/public-data-YYYYMMDD-HHMMSS.sql
```

Use `-y` on restore scripts to skip the confirmation prompt.
