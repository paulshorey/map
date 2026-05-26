# @lib/config

Shared TypeScript compiler presets for the monorepo. No runtime code — JSON configs only.

## Exports

| Path | Used by |
| --- | --- |
| `typescript/base.json` | Strict shared defaults (extended by nextjs preset) |
| `typescript/nextjs.json` | Next.js apps — bundler resolution, JSX preserve, Next plugin |

## Usage

In an app's `tsconfig.json`:

```json
{
  "extends": "@lib/config/typescript/nextjs.json",
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  }
}
```

`@lib/db-map` extends `base.json` directly (no Next.js).

## When to change

- Adjust `base.json` for repo-wide strictness or module settings.
- Adjust `nextjs.json` for Next-specific compiler options shared across apps.
- App-specific paths, includes, and excludes stay in each app's own `tsconfig.json`.
