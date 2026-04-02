# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Auth

Frontend uses MSAL.js (CDN) for Microsoft login and a local username/password form for restricted environments (corporate firewalls that block Microsoft). Both flows POST credentials to the shared API which returns a 7-day JWT.

- **MSAL.js CDN script must load before Monaco loader.js** — Monaco's AMD `define()` hijacks MSAL's UMD export, leaving `window.msal` undefined
- `prompt: 'select_account'` forces the Microsoft account picker
- Local auth route: `POST /homepage/auth/local/login` (bcrypt, in routes package)
- Microsoft `sub` claim is pairwise per app registration — the same user gets different `sub` values from different apps

## Routes Package (`packages/routes/`)

Published as `@nelsong6/my-homepage-routes` to GitHub Packages. Contains bookmarks/settings CRUD and local login. Receives `requireAuth`, `container`, and `jwtSecret` via dependency injection from the shared API. Dependencies: `bcryptjs`, `jsonwebtoken`. Peer: `express`.

## Publish Pipeline

Triggers on push to `packages/routes/**` (path-based, same pattern as kill-me/plant-agent). Auto-bumps patch version from registry, publishes, then dispatches `dependency-updated` to the API repo. After dispatch, the API lockfile must be updated locally before the API build will pick up the new version — `npm ci` uses the lockfile.

## Change Log

### 2026-03-26

- **Replaced multi-provider OAuth with MSAL.js Microsoft auth** — eliminated passport.js and all server-side OAuth (GitHub, Google, Apple, Auth0) in favor of client-side MSAL.js redirect flow, matching kill-me and plant-agent auth pattern. Routes package stripped to CRUD + local auth only, now receives `requireAuth` and `jwtSecret` via dependency injection from the shared API. Deleted `packages/routes/auth/` and `packages/routes/middleware/`. Removed all auth dependencies except `bcryptjs` and `jsonwebtoken`.
- **Re-added local username/password login** — for work environments that block Microsoft login (corporate admin approval required). Simple bcrypt-based route in the routes package with a frontend form below the Microsoft button.
- **Standardized publish-routes trigger** — switched from Infrastructure-chained `workflow_run` with shasum check to direct path-based trigger on `packages/routes/**`, matching kill-me and plant-agent.
- **Fixed MSAL CDN load order** — MSAL UMD bundle must load before Monaco's `loader.js` or the AMD `define()` hijacks the global export.
- **Added `prompt: 'select_account'` to MSAL login** — forces Microsoft account picker instead of auto-selecting the last-used account.

### 2026-03-23

- **Migrated backend to shared API** — extracted all backend routes into `@nelsong6/my-homepage-routes` npm package (`packages/routes/`). Routes mounted at `/homepage` prefix in the shared API at `api.romaine.life`. Deleted `backend/` directory and all backend CI/CD workflows. Old `homepage-api` Container App destroyed.

### 2026-03-25

- **Restored bypass-mode auth for auto-generated SWA URL** — SWA default hostname stored in Azure App Configuration via tofu, read by the shared API, passed through to homepage routes for redirect URI allowlisting.

### 2026-04-01

- **Expanded scope-mode fuzzy finder to search nested folders** — pressing `/` previously only searched items in the current folder level. Now when typing a query, all nested items (folders and leaves) are included in results with a depth penalty (5 points per level) so top-level items rank higher by default, but typing more of a nested item's name guarantees reaching it. Added `flattenScopeItems` helper, path breadcrumbs for nested results, and full ancestry push onto scope stack when selecting a nested folder.

### 2026-03-15

- Added `ensureAbsoluteUrl()` helper in `frontend/script.js` to fix bare-domain bookmarks being treated as relative URLs.
