# Map app

It shows a world map with many points of interest. User clicks a point to see more information about that POI.

Front-end - NextJS React, renders the map and UI
Back-end - NextJS app router API, connects to the database and fetches points of interest

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map/ - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map/ - database migrations, contracts, and types

## Documentation

- .cursor/plans/ - save any implementation plans here (for new features, fixes, or research)
- docs/ - save random other documentation here (as .md files)
- docs/pois/{category}/ - information about points of interest, sources, and downloaded .kml files

## Database

PostgreSQL 18. Connection via `DB_MAP_URL` env var.

After making a change requiring database migration, run the sync pipeline and commit the generated files in the same PR:

```bash
cd lib/db-map && pnpm db:sync
```

This migrates the database, snapshots the schema, and regenerates TypeScript types and contracts. The updated files in `schema/` and `generated/` must be committed alongside the migration.
