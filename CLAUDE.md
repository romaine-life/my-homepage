# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Auth

Frontend uses MSAL.js (CDN) for Microsoft login and a local username/password form for restricted environments (corporate firewalls that block Microsoft). Both flows POST credentials to the shared API which returns a 7-day JWT.

- **MSAL.js CDN script must load before Monaco loader.js** — Monaco's AMD `define()` hijacks MSAL's UMD export, leaving `window.msal` undefined
- `prompt: 'select_account'` forces the Microsoft account picker
- Local auth route: `POST /homepage/auth/local/login` (bcrypt, in routes package)
- Microsoft `sub` claim is pairwise per app registration — the same user gets different `sub` values from different apps
- **Local dev must use port 3001** — `http://localhost:3001/` is registered as a SPA redirect URI in the Azure app registration (`959bd3fa`). Microsoft login will fail on any other localhost port. The shared API runs on port 3000; the frontend dev server runs on port 3001.

## Routes Package (`packages/routes/`)

Published as `@nelsong6/my-homepage-routes` to GitHub Packages. Contains bookmarks/settings CRUD and local login. Receives `requireAuth`, `container`, and `jwtSecret` via dependency injection from the shared API. Dependencies: `bcryptjs`, `jsonwebtoken`. Peer: `express`.

## fzt Terminal Integration

Primary navigation is a fzt (fuzzy-tiered) WASM terminal rendered in a `<pre>` element. The Go TUI runs in-browser via WebAssembly — all scoring, filtering, and rendering happens in Go; the JS side is stateless (forwards keyboard events, parses ANSI output, renders styled spans).

- **Layout**: Two-panel flex — terminal panel (left, `flex: 1`) + side rail (right, 280px, collapsible) containing the existing bookmark tree for click navigation
- **Data flow**: `bookmarks JSON → bookmarksToYaml() → fzt.loadYAML() → fzt.init(cols, rows)` — returns ANSI frames; `fzt.handleKey()` on each keystroke
- **Keyboard routing**: All keys forwarded to fzt by default. Forwarding stops when `editMode` is active or focus is in an input/textarea/select.
- **WASM assets**: `fzt.wasm` (~4.6MB), `wasm_exec.js` (Go WASM runtime), `SymbolsNerdFontMono-Regular.ttf` (nerd font icons for folder/file glyphs)
- **Script load order**: MSAL CDN → `wasm_exec.js` → Monaco loader → `script.js` (module). `wasm_exec.js` must load before ES modules since it defines the global `Go` constructor.
- **fzt.wasm build**: `cd fuzzy-tiered && GOOS=js GOARCH=wasm go build -o fzt.wasm ./cmd/wasm` — copy to `frontend/fzt.wasm`
- **ANSI parser**: `fzh-terminal.js` contains a Catppuccin Mocha 16-color palette mapping, full SGR parser (16/256/RGB color, bold/italic/dim/underline), wide character detection for nerd font icons, and a grid renderer that batches adjacent same-styled cells into single spans

## Publish Pipeline

Triggers on push to `packages/routes/**` (path-based, same pattern as kill-me/plant-agent). Auto-bumps patch version from registry, publishes, then dispatches `dependency-updated` to the API repo. After dispatch, the API lockfile must be updated locally before the API build will pick up the new version — `npm ci` uses the lockfile.

## Change Log

### 2026-04-03

- **Replaced JS fuzzy finder with fzt WASM terminal** — the old modal fuzzy finder overlay (`/` for scope, `Ctrl+K` for all) was removed entirely. In its place, fzt (fuzzy-tiered) runs as an always-visible terminal panel via WebAssembly. The Go TUI handles all scoring, hierarchical drill-down, and rendering; JS just forwards keystrokes and renders ANSI output as styled HTML spans. Bookmarks are serialized to YAML and fed to `fzt.loadYAML()`.
- **Two-panel layout** — replaced the centered 720px single-column layout with a flex two-panel design: fzt terminal on the left (fills available space), collapsible side rail on the right (280px) containing the existing bookmark tree at 14px for click navigation. Toolbar spans full width above both panels.
- **Created `frontend/fzh-terminal.js`** — ES module (~280 lines) containing the ANSI parser (Catppuccin Mocha palette), grid renderer, font metrics measurement, WASM loader, keyboard forwarding, and ResizeObserver. Adapted from the fuzzy-tiers-showcase.
- **Added WASM static assets** — `fzt.wasm`, `wasm_exec.js`, `SymbolsNerdFontMono-Regular.ttf` added to `frontend/`.
- **Added `localhost:3001` as SPA redirect URI** — registered in the Azure app registration (`959bd3fa`) so Microsoft login works during local dev. Documented the port 3001 requirement in CLAUDE.md Auth section.

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

### 2026-04-02

- **Added Ctrl+Enter shortcut to save bookmark editing session** — in edit mode with no inline form open, Ctrl+Enter calls `saveEdits()`. Complements existing behavior where Enter (including Ctrl+Enter) in an inline edit form confirms the individual bookmark. Flow: Ctrl+Enter to confirm a bookmark edit, Ctrl+Enter again to save everything.

### 2026-04-01

- **Expanded scope-mode fuzzy finder to search nested folders** — pressing `/` previously only searched items in the current folder level. Now when typing a query, all nested items (folders and leaves) are included in results with a depth penalty (5 points per level) so top-level items rank higher by default, but typing more of a nested item's name guarantees reaching it. Added `flattenScopeItems` helper, path breadcrumbs for nested results, and full ancestry push onto scope stack when selecting a nested folder.

### 2026-03-15

- Added `ensureAbsoluteUrl()` helper in `frontend/script.js` to fix bare-domain bookmarks being treated as relative URLs.
