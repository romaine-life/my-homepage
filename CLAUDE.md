# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Auth

Terminal-minted JWTs — no browser-side auth UI. The `at` command (`homepagelogin`) reads a profile-specific identity config (`${PROFILE_DIR}/config/homepage.yaml`), fetches the JWT signing secret (macOS Keychain on Mac, Azure Key Vault on Windows), mints a 30-day JWT, and injects it into the browser via `osascript` (Mac) or clipboard (Windows). No MSAL, no OAuth, no login forms.

- **Three identities**: personal Microsoft (`nelson-devops-project@outlook.com`), work local (`gromaine@r1rcm.com`), and a third Microsoft account. Each gets separate bookmark sets. The profile config YAML determines which identity to use.
- **JWT claims**: `{ sub, email, name, role, iat, exp }` — signed with `api-jwt-signing-secret` from Key Vault. The API's `requireAuth` middleware verifies the signature and extracts `sub` for user identification.
- **No browser auth fallback** — if the token is missing or expired, the app shows playground mode with sample bookmarks.
- **Local dev port 3001** — the frontend dev server runs on port 3001 (`npx serve`). The shared API runs on port 3000.

## Routes Package (`packages/routes/`)

Published as `@nelsong6/my-homepage-routes` to GitHub Packages. Contains settings CRUD (Cosmos DB) and bookmarks CRUD (Azure Blob Storage). Receives `requireAuth`, `container` (Cosmos), and `bookmarksContainerClient` (Blob) via dependency injection from the shared API. Peer deps: `@azure/storage-blob`, `express`.

## fzt Terminal Integration

Primary navigation is a fzt WASM terminal rendered in a `<pre>` element. The Go TUI runs in-browser via WebAssembly — all scoring, filtering, and rendering happens in Go; the JS side is stateless (forwards keyboard events, parses ANSI output, renders styled spans, handles row clicks).

- **Layout**: Single-panel — fzt terminal fills the main content area. No side rail. The HTML tree only appears during edit mode (full-width). The old two-panel side-rail layout was removed.
- **Unified tree+search**: fzt starts in tree view mode (`fzt.init`). The tree is the single navigation surface. Two modes: search mode (typing drives cursor to top match) and nav mode (arrow keys / Shift+HJKL). Enter, Right, and Space on a folder all push scope — unified behavior regardless of input mode.
- **Scope as breadcrumb**: Enter, Right, Tab, or Space on a folder pushes scope. The folder name appears as greyed-out locked text in the prompt. Backspace/Escape on empty query pops scope. The tree expands the scoped folder in place — full hierarchy stays visible.
- **Unified prompt rendering**: Within `drawUnified`, `navMode` affects ONLY the prompt icon (arrow vs magnifying glass). All other rendering — breadcrumb, content area, cursor visibility, top match highlighting — is mode-independent, driven by `treeCursor`, `query`, `scope`, and `searchActive` state.
- **Clipboard commands**: fzt's `:` command palette has a "tree edit" folder with "copy yaml" (copies bookmark tree to clipboard) and "paste yaml" (reads YAML from clipboard, saves via API). Replaces the old Monaco YAML editor.
- **Click support**: Row `<div>` click handlers call `fzt.clickRow(row)` — fzt maps the visual row to a tree item. Folders push scope, leaves return URLs for navigation.
- **Data flow**: `bookmarks JSON → bookmarksToYaml() → fzt.loadYAML() → fzt.init(cols, rows)` — returns ANSI frames; `fzt.handleKey()` on each keystroke; `fzt.clickRow()` on mouse clicks
- **Keyboard routing**: All keys forwarded to fzt by default. Forwarding stops when `editMode` is active or focus is in an input/textarea/select.
- **Edit mode**: Swaps from fzt terminal to HTML tree editor (existing click-based UI, full-width). Save/cancel returns to fzt.
- **Shared assets**: `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, `fzt-web.js` — all downloaded from fzt releases at deploy time (gitignored). `fzt-web.js` provides built-in Catppuccin Mocha palette, DOS font stack, and cursor config. `fzh-terminal.js` is a thin app-specific wrapper that only overrides `containerPadding` and `defaultCursorPos`.
- **CRT visual style**: Shared `fzt-terminal.css` provides scanlines, vignette, rounded corners, and cursor blink. CSS variables `--fzt-bg: #181825` and `--fzt-fg: #cdd6f4` override the defaults for Catppuccin theming. DOS font (Perfect DOS VGA 437) with font-smoothing disabled.
- **Fonts**: `PerfectDOSVGA437.ttf` (primary terminal font), `SymbolsNerdFontMono-Regular.ttf` (nerd font icons)
- **Script load order**: `wasm_exec.js` → `script.js` (module). `wasm_exec.js` must load before ES modules since it defines the global `Go` constructor.
- **Local dev**: `cd D:\repos\fzt && $env:GOOS="js"; $env:GOARCH="wasm"; go build -o D:\repos\my-homepage\frontend\fzt.wasm ./cmd/wasm`. Also copy `web/fzt-terminal.js`, `web/fzt-terminal.css`, `web/fzt-web.js` to `frontend/`.

## Storage

Bookmarks live in Azure Blob Storage (`homepageprofilepics` storage account, `bookmarks` container, private, versioned). Each user's bookmarks are a JSON blob named by sanitized userId (e.g., `microsoft_AAAAAAAAAAAAAAAAAAAAAGsy_HuYRyJF8JVl7vGARBU.yaml`). Blob versioning is enabled — every save creates a new version automatically, providing diff-like history.

Settings live in Azure Cosmos DB (`HomepageDB`/`userdata` container). The `backgroundUrl` field in settings controls the page background image.

## Cosmos DB Direct Access

Settings and legacy data live in Azure Cosmos DB. Claude can query them directly via `az cli` + a read-only master key, bypassing the API's JWT auth.

- **Account**: `infra-cosmos`
- **Resource group**: `infra` (found in `infra-bootstrap/tofu/main.tf` line 15–17: `data "azurerm_resource_group" "main" { name = "infra" }`)
- **Database**: `HomepageDB` (found in `api/server.js` line 145: `cosmosClient.database('HomepageDB')`)
- **Container**: `userdata` (found in `api/server.js` line 146: `homepageDb.container('userdata')`)
- **Endpoint**: `https://infra-cosmos.documents.azure.com:443/`

### Auth flow

1. Check `az account show` — if not logged in, run `az login` (browser popup, one click)
2. Get read-only key: `az cosmosdb keys list --name infra-cosmos --resource-group infra --type read-only-keys --query "primaryReadonlyMasterKey" -o tsv`
3. Query the Cosmos data plane using the key with HMAC-SHA256 auth headers (Python `urllib` + `hmac`). The `az cosmosdb sql query` subcommand does not exist in current az CLI — must use the REST data plane directly.

### Query details

- Resource link for queries: `dbs/HomepageDB/colls/userdata`
- POST to `https://infra-cosmos.documents.azure.com/dbs/HomepageDB/colls/userdata/docs`
- Headers: `Authorization` (HMAC token), `x-ms-date`, `x-ms-version: 2018-12-31`, `Content-Type: application/query+json`, `x-ms-documentdb-isquery: True`, `x-ms-documentdb-query-enablecrosspartition: True`
- Documents are keyed by `userId` + `type` (e.g., `type: "bookmarks"`, `type: "settings"`)

### Known userIds

Multiple accounts exist in the container (legacy Google OAuth, local auth, Microsoft). Nelson's primary userId is `microsoft|AAAAAAAAAAAAAAAAAAAAAGsy_HuYRyJF8JVl7vGARBU` (the `nelson-devops-project@outlook.com` account via the current app registration `959bd3fa`).

## Publish Pipeline

Triggers on push to `packages/routes/**` (path-based, same pattern as kill-me/plant-agent). Auto-bumps patch version from registry, publishes, then dispatches `dependency-updated` to the API repo. After dispatch, the API lockfile must be updated locally before the API build will pick up the new version — `npm ci` uses the lockfile.

## fzt Deploy Pipeline

The deploy workflow (`full-stack-deploy.yml`) downloads `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, and `fzt-web.js` from the latest fzt GitHub release at deploy time — none committed to git. Triggered by `repository_dispatch` (`fzt-updated`) from fzt's release pipeline, in addition to `frontend/**` pushes and manual dispatch. This means pushing a new fzt version automatically redeploys both the showcase and this app.

## Change Log

### 2026-04-05

- **Replaced Monaco YAML editor with fzt clipboard commands** — removed the YAML button, Monaco editor, and all related code (`monaco-yaml.js`, CDN script tag, `openYamlEditor`/`closeYamlEditor` functions, `serializeBookmarks`/`deserializeBookmarks` wrappers, YAML editor CSS, `yamlExpanded`/`yamlEditorInstance` state). YAML editing now uses fzt's `:` → "tree edit" → "copy yaml" / "paste yaml" commands, which use the browser clipboard API. "copy yaml" serializes `currentBookmarks` to YAML via `bookmarksToYaml()` and writes to clipboard. "paste yaml" reads clipboard, parses with `yamlToBookmarks()`, cleans, and saves via the API (with conflict handling) or localStorage in playground mode.
- **Added `.claude/launch.json`** — preview server config for `npx serve` on port 3001.
- **Adopted shared CRT styling** — consume `fzt-terminal.css` from fzt releases for scanlines, vignette, rounded corners, and cursor underline blink. Added `fzt-terminal-window` class to `#main-panel`. Page background changed to near-black (`#050505`), terminal background to Catppuccin surface (`#181825`). Font-smoothing disabled for DOS pixel-perfect rendering.
- **Adopted shared `fzt-web.js`** — `fzh-terminal.js` now imports `createFztWeb` instead of `createFztTerminal`. Removed inline Catppuccin palette, font stack, and cursor class — all provided by the shared component's defaults. Only `containerPadding: 8` and `defaultCursorPos: null` are overridden.
- **DOS font** — added Perfect DOS VGA 437 as primary terminal font, matching fzt-showcase. Cascadia Code remains as fallback.
- **Toolbar simplified** — removed toggle-all (+) button (no longer functional). Edit and Sync buttons changed from styled boxes with emoji to plain green text labels matching fzt-showcase link style.
- **Terminal-minted JWT auth** — eliminated all browser-side authentication (MSAL.js CDN, Microsoft login button, local username/password form, account dropdown, display toggle, logout button, avatar, Gravatar). Auth now happens entirely via the `at` command (`homepagelogin`), which reads identity config from `${PROFILE_DIR}/config/homepage.yaml`, fetches the JWT signing secret from macOS Keychain or Azure Key Vault, mints a 30-day JWT, and injects it into the browser. Frontend shows bookmarks if token exists, playground mode if not. No auth UI at all.
- **Bookmarks migrated to Azure Blob Storage** — bookmarks moved from Cosmos DB to a versioned blob container (`bookmarks`) on the existing `homepageprofilepics` storage account. The API routes package now reads/writes JSON blobs using `@azure/storage-blob` SDK via managed identity. Conflict detection uses blob `lastModified` timestamps (replacing Cosmos `updatedAt`). Blob versioning provides automatic history of every save.
- **Settings remain in Cosmos DB** — settings (background image URL, future customizations) stay in Cosmos DB (`HomepageDB`/`userdata` container). Background image applied on load via `document.body.style.backgroundImage`.
- **homectl folder** — moved Edit and Sync from green toolbar buttons into fzt bookmark actions (`homectl:edit`, `homectl:logout`). Toolbar buttons removed from HTML. Edit/save/cancel buttons remain hidden until edit mode activates.
- **YAML quoting** — `bookmarksToYaml()` now quotes `name` and `url` values to handle protocol URIs like `spotify:` that break unquoted YAML.
- **Bookmark name normalization** — spaces replaced with hyphens in `cleanBookmarks()` and the inline editor. Default new bookmark name changed from "New bookmark" to "new-bookmark". Space is reserved for scope-locking behavior.
- **Spotify control** — custom `spotify-ctl:` protocol handler using `Windows.Media.Control` API (Python `winrt` package) targets Spotify's media session specifically. Supports toggle, play, pause, next, prev. Registry protocol handler + Chrome/Edge `AutoLaunchProtocolsFromOrigins` policy configured via `init.ps1`.
- **desktop folder** — new top-level bookmark folder with `spotify/` subfolder (open, toggle, next, prev commands).
- **Cosmos DB direct access documented** — Claude can query Cosmos directly via `az cli` + HMAC-SHA256 auth headers. Resource group is `infra` (from `infra-bootstrap/tofu/main.tf`). `az cosmosdb sql query` subcommand does not exist — must use REST data plane. Nelson's primary userId identified and documented. Stale duplicate account deleted.
- **fzt nav/search unification** — Space on a folder in nav mode now pushes scope (was broken — typed space character). Right on a folder pushes scope (was expand-only). Enter, Right, Space all call `pushScope` on folders. Prompt bar rendering unified: `navMode` affects only the icon, not breadcrumb/content/cursor/highlighting. Removed italic name echo and `HideCursor` in nav mode.
- **Node icon spacing** — added 6px `margin-right` to `.node-icon` for clear separation between folder/file icons and labels in the HTML tree editor.

### 2026-04-04

- **fzt WASM downloaded at deploy time** — removed `fzt.wasm` from git (gitignored). Deploy workflow now fetches the latest WASM from fzt's GitHub releases. Added `repository_dispatch` trigger (`fzt-updated`) so new fzt releases automatically redeploy the frontend. Motivated by wanting the fzt showcase and homepage to stay in sync with the fzt tool without manual WASM updates or bot commits.

### 2026-04-03

- **Unified tree+search architecture** — replaced the two-panel layout (fzt terminal + side rail) with a single-panel fzt terminal that handles both tree browsing and search. The side rail, side-rail toggle, and all visual/text mode switching JS were removed. fzt now starts in tree view mode and handles tree→search→tree transitions internally via Go. The HTML tree editor remains for edit mode only.
- **Tree view restyled to match fzt** — folder colors changed from green to teal (`#94e2d5`, matching fzt's `ColorDarkCyan`), +/- toggles replaced with nerd font icons (folder `\uF024B`, file `\uF016`), link indicator `↗` removed, hover highlight changed to dark navy (matching fzt's `ColorDarkBlue`), prompt hint added at top of tree. Tree font bumped from 14px to 16px for full-width layout.
- **Click support in fzt terminal** — row `<div>` click handlers call `fzt.clickRow(row)` which maps visual rows to tree items or results. Folders toggle expand/collapse, leaves navigate to URLs.
- **Scope as breadcrumb** — in prompt/results layers, Tab on folder result or typing folder name + Space scopes into that folder. Folder name appears as greyed-out locked text in the prompt. Backspace on empty query pops scope. Tree navigation (Enter/Right/Left) expands/collapses folders in place without leaving tree focus.
- **Three-layer focus model** — tree (arrow nav, Enter/Right expand, Left collapse), prompt (typing query, tree auto-expands), results (Tab'd into bottom list). Escape cancels from tree; clears query / pops scope / exits search from prompt.
- **Replaced JS fuzzy finder with fzt WASM terminal** — the old modal fuzzy finder overlay (`/` for scope, `Ctrl+K` for all) was removed entirely. In its place, fzt runs as an always-visible terminal panel via WebAssembly. The Go TUI handles all scoring, hierarchical drill-down, and rendering; JS just forwards keystrokes and renders ANSI output as styled HTML spans. Bookmarks are serialized to YAML and fed to `fzt.loadYAML()`.
- **Two-panel layout** — replaced the centered 720px single-column layout with a flex two-panel design: fzt terminal on the left (fills available space), collapsible side rail on the right (280px) containing the existing bookmark tree at 14px for click navigation. Toolbar spans full width above both panels.
- **Created `frontend/fzh-terminal.js`** — ES module (~280 lines) containing the ANSI parser (Catppuccin Mocha palette), grid renderer, font metrics measurement, WASM loader, keyboard forwarding, and ResizeObserver. Adapted from fzt-showcase.
- **Added WASM static assets** — `fzt.wasm`, `wasm_exec.js`, `SymbolsNerdFontMono-Regular.ttf` added to `frontend/`.
- **Added `localhost:3001` as SPA redirect URI** — registered in the Azure app registration (`959bd3fa`) so Microsoft login works during local dev. Documented the port 3001 requirement in CLAUDE.md Auth section.
- **Fixed missing file icons in fzt terminal** — BMP Private Use Area glyphs (U+E000-U+F8FF, e.g., file icon U+F016) weren't detected as wide characters by the ANSI parser, so they didn't get Symbols Nerd Font Mono styling and rendered as tofu. Expanded wide char detection to include the BMP PUA range and added the nerd font to the terminal CSS fallback stack.
- **Fixed YAML editor button** — YAML button rendered the Monaco editor into `#tree` but never swapped panel visibility (fzt terminal stayed on top). Added `showTree()`/`showTerminal()` calls so the YAML button hides the fzt terminal and shows the tree panel with the Monaco editor, and all close/save paths swap back. Affected: button click, save (playground + authenticated), and toggleAll close path.
- **YAML editor fills panel** — changed `.yaml-editor` from `height: 60vh` with resize handles to `height: 100%` so the Monaco editor fills the full `#tree` container, matching the fzt terminal's full-panel layout.
- **YAML editor renders inside fzt terminal box** — instead of swapping to the HTML tree panel, the Monaco editor now overlays inside `#main-panel` starting below the fzt search bar (row 4), respecting the terminal's drawn `│` side borders and `└───┘` bottom border. The fzt prompt stays visible above. Position is calculated dynamically from font metrics. Decided that YAML editing is a web-native concern (not a Go TUI feature) — fzt owns navigation/search, the web layer owns editing.
- **Monaco editor styled to match fzt** — changed editor background from `#1e1e2e` to `#181825` (matching terminal panel), gutter background to match, and line height from 22px to 19px (matching fzt's 1.2 ratio at 16px). Catppuccin Mocha syntax colors were already correct.
- **Cursor reworked to box-shadow underline** — the CSS cursor blink was a web-only decoration (Go reports coordinates but doesn't draw a cursor — that's the terminal emulator's job). Previous `border-bottom` approach reserved 2px of layout space even when transparent, causing a visible seam at the search box edge. Switched to `box-shadow: 0 2px 0` which paints over content without reserving space, so the blink on/off is seamless. Character text stays fully visible throughout.
- **fzt showcase: "fuzzy finder" links to junegunn/fzf** — the intro text "A fuzzy finder with hierarchical navigation" now links the words "fuzzy finder" to the original fzf project. Added inline `{text}(url)` link syntax parser to the DOS command history renderer.

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
