# This is a map app

It shows a world map with many points of interest. User clicks a point to see more information about it.

Front-end - NextJS React, renders the map and UI
Back-end - NextJS app router API, connects to the database and fetches points of interest

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map - database migrations, contracts, and types
