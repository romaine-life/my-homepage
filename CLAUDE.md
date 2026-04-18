# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Auth

Terminal-minted JWTs — no browser-side auth UI. The `at` command (`homepagelogin`) reads a profile-specific identity config (`${PROFILE_DIR}/config/homepage-{identity}.yaml`), fetches the JWT signing secret (KWallet on Linux, macOS Keychain on Mac, Azure Key Vault on Windows), mints a 30-day JWT, exchanges it for a one-time code via the API, and opens the browser at the callback URL to set an HttpOnly cookie. No MSAL, no OAuth, no login forms.

- **Three identities**: `nelson` (personal, all profiles), `nelson-ea` (Engineered Arts, profile 2), `nelson-r1` (R1, profile 3). Each gets separate bookmark sets. The profile config YAML determines which identity to use.
- **JWT claims**: `{ sub, email, name, role, iat, exp }` — signed with `api-jwt-signing-secret` from Key Vault. The API's `requireAuth` middleware verifies the signature and extracts `sub` for user identification.
- **No browser auth fallback** — if the token is missing or expired, the app shows playground mode with sample bookmarks.
- **Local dev port 3001** — the frontend dev server runs on port 3001 (`npx serve`). The shared API runs on port 3000.

## Routes Package (`packages/routes/`)

Published as `@nelsong6/my-homepage-routes` to GitHub Packages. Contains settings CRUD (`HomepageDB.userdata`) and bookmarks CRUD (`HomepageDB.fzt-frontend-data`). Receives `requireAuth`, `container` (userdata), and `bookmarksContainer` (fzt-frontend-data) via dependency injection from the shared API. Peer dep: `@azure/cosmos`. All bookmark-related data migrated off Azure Blob Storage on 2026-04-18 in favor of Cosmos-backed append-only versioned docs — same pattern as the AT menu.

## fzt Terminal Integration

Primary navigation is a fzt WASM terminal rendered in a `<pre>` element. The Go TUI runs in-browser via WebAssembly — all scoring, filtering, and rendering happens in Go; the JS side is stateless (forwards keyboard events, parses ANSI output, renders styled spans, handles row clicks).

Cross-repo references: scoring engine in `fzt/core/scorer.go` and `fzt/core/tree.go`; WASM bridge API in `fzt-terminal/cmd/wasm/main.go`; ancestor matching design (why bookmark names in different folders don't collide) in `fzt/CLAUDE.md` "Ancestor matching eliminates name collisions".

- **Layout**: Single-panel — fzt terminal fills the main content area. No side rail. The HTML tree only appears during edit mode (full-width). The old two-panel side-rail layout was removed.
- **Unified tree+search**: fzt starts in tree view mode (`fzt.init`). The tree is the single navigation surface. Two modes: search mode (typing drives cursor to top match) and nav mode (arrow keys / Shift+HJKL). Enter, Right, and Space on a folder all push scope — unified behavior regardless of input mode.
- **Scope as breadcrumb**: Enter, Right, Tab, or Space on a folder pushes scope. The folder name appears as greyed-out locked text in the prompt. Backspace/Escape on empty query pops scope. The tree expands the scoped folder in place — full hierarchy stays visible.
- **Unified prompt rendering**: Within `drawUnified`, `navMode` affects ONLY the prompt icon (arrow vs magnifying glass). All other rendering — breadcrumb, content area, cursor visibility, top match highlighting — is mode-independent, driven by `treeCursor`, `query`, `scope`, and `searchActive` state.
- **Clipboard commands** (legacy, pending removal): The homepage frontend registers "copy yaml" and "paste yaml" commands in fzt's `:` palette via `fzt.addCommands()`. Copy exports the bookmark tree to clipboard; paste reads YAML from clipboard and saves via API. Not preferred — use the API directly (`GET /homepage/api/bookmarks`, `PUT /homepage/api/bookmarks`) for programmatic edits.
- **Click support**: Row `<div>` click handlers call `fzt.clickRow(row)` — fzt maps the visual row to a tree item. Folders push scope, leaves return URLs for navigation.
- **Data flow**: `bookmarks JSON → bookmarksToYaml() → fzt.loadYAML() → fzt.init(cols, rows)` — returns ANSI frames; `fzt.handleKey()` on each keystroke; `fzt.clickRow()` on mouse clicks
- **Keyboard routing**: All keys forwarded to fzt by default. Forwarding stops when `editMode` is active or focus is in an input/textarea/select.
- **Edit mode**: Swaps from fzt terminal to HTML tree editor (existing click-based UI, full-width). Save/cancel returns to fzt.
- **Shared assets**: `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, `fzt-web.js` — all downloaded from fzt-browser releases at deploy time (gitignored). `fzt-web.js` provides built-in Catppuccin Mocha palette, DOS font stack, and cursor config. `fzh-terminal.js` is a thin app-specific wrapper that only overrides `containerPadding` and `defaultCursorPos`.
- **CRT visual style**: Shared `fzt-terminal.css` provides scanlines, vignette, rounded corners, and cursor blink. CSS variables `--fzt-bg: #181825` and `--fzt-fg: #cdd6f4` override the defaults for Catppuccin theming. DOS font (Perfect DOS VGA 437) with font-smoothing disabled.
- **Fonts**: `PerfectDOSVGA437.ttf` (primary terminal font), `SymbolsNerdFontMono-Regular.ttf` (nerd font icons)
- **Script load order**: `wasm_exec.js` → `script.js` (module). `wasm_exec.js` must load before ES modules since it defines the global `Go` constructor.
- **Local dev**: `cd D:\repos\fzt && $env:GOOS="js"; $env:GOARCH="wasm"; go build -o D:\repos\my-homepage\frontend\fzt.wasm ./cmd/wasm`. Also copy `web/fzt-terminal.js`, `web/fzt-terminal.css`, `web/fzt-web.js` to `frontend/`.

## Storage

All user-facing data lives in Azure Cosmos DB — the `HomepageDB.fzt-frontend-data` container (partition key `/userId`), append-only versioned documents:

| `type` | `id` format | Partition (userId) | Notes |
|---|---|---|---|
| `bookmarks` | `bookmarks_<userId>_v<N>` | user's JWT `sub` | Per-user bookmark tree |
| `bookmarks-shared` | `bookmarks-shared_<name>_v<N>` | `shared:<name>` | Cross-identity shared refs |

Each save bumps `N`; GET returns the latest `N` per user. Version numbers replace blob-era `lastModified` timestamps for conflict detection. Pre-2026-04-18 state lived in Azure Blob Storage (`homepageprofilepics/bookmarks`, `<userId>.yaml` + `shared-<name>.yaml`); migrated and retired.

Settings still live in `HomepageDB.userdata` as `type='settings'` docs (separate container). The `backgroundUrl` field in settings controls the page background image.

## Bookmark Ref System

Refs enable shared bookmarks across identities. A bookmark entry can be `{ ref: "<name>" }` — a pointer to a `type='bookmarks-shared'` doc of that name. Schema rule: if `ref` is present, no other non-metadata properties allowed. The ref doc owns its own `name` on the outermost node.

### Read flow (GET /api/bookmarks)

1. `getLatestBookmarks(userId)` queries Cosmos for the latest `bookmarks` doc
2. `resolveRefs()` walks the tree — each `{ ref }` node is replaced with the referenced `bookmarks-shared` doc's contents, tagged with `_ref` and `_refVersion` (integer version, not timestamp)
3. Recursive: refs within ref contents are resolved (visited set prevents cycles, max depth 10)
4. Frontend receives fully expanded tree; `_ref`/`_refVersion` enable round-trip preservation

### Write flow (PUT /api/bookmarks)

1. Conflict check: `lastKnownVersion` (version number or updatedAt string) compared against latest doc; 409 with current if mismatch
2. `decomposeRefs()` extracts nodes with `_ref` metadata — subtree (minus metadata) becomes a new `bookmarks-shared` version, node reverts to `{ ref }`
3. Shared-ref version conflict: if client's `_refVersion` ≠ current shared doc version, 409 returned
4. User's tree (with `{ ref }` pointers) saved as a new `bookmarks` version doc
5. Response re-resolves refs for fresh `_refVersion` values

### Frontend ref handling

- `script.js` `bookmarksToYaml()`: `_ref` nodes serialize as `- ref: "name"` (compact form). `fzh-terminal.js` copy does NOT handle refs — it only sees resolved bookmarks.
- `script.js` `cleanBookmarks()`: preserves `_ref` and `_refVersion` metadata through edits
- `script.js` `yamlToBookmarks()`: parses `- ref: "name"` lines
- HTML tree editor: ref folders shown with green linked-folder icon (`.ref-node` CSS class)

## Background Fetch Model

Cache-first rendering with non-blocking background sync. The user sees bookmarks instantly from localStorage; fresh data loads silently.

1. Load `cached_bookmarks` from localStorage, render immediately in fzt
2. `fetchBookmarks()` fires as a detached promise (non-blocking)
3. If fresh data differs from cache: stash in `pendingBookmarks`, show green sync indicator (bottom-right dot)
4. User clicks indicator -> `applySyncedBookmarks()` swaps in fresh data
5. First-time users (no cache): background fetch applies directly
6. Offline: catch swallows the error, cache is fine

After a save, `pendingBookmarks` is cleared and the indicator hidden to prevent stale state.

## AT (fzt-automate) Convergence

The `fzt-automate` binary and the homepage web app both consume fzt-terminal. AT reads local YAML menus + cloud-synced bookmarks (via file reference to a cache populated by `syncbookmarks`). The homepage reads from the API. Both share the same bookmark data in Azure Blob Storage — the ref system means shared folders (like a Google folder) appear in both AT and the browser. AT identity management (`:load`, `:setsecret`, `:syncbookmarks`, `:whoami`) lives in fzt's command palette, not the menu tree.

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

Three identities with clean sub values (migrated from legacy OAuth IDs):

- `nelson` — personal (`nelson-devops-project@outlook.com`), all profiles
- `nelson-ea` — Engineered Arts (`n.romaine@engineeredarts.com`), profile 2
- `nelson-r1` — R1 (`gromaine@r1rcm.com`), profile 3

Blob filenames match: `nelson.yaml`, `nelson-ea.yaml`, `nelson-r1.yaml`. Legacy Google OAuth accounts remain in Cosmos DB but are unused.

## Publish Pipeline

Triggers on push to `packages/routes/**` (path-based, same pattern as kill-me/plant-agent). Auto-bumps patch version from registry, publishes, then dispatches `dependency-updated` to the API repo. After dispatch, the API lockfile must be updated locally before the API build will pick up the new version — `npm ci` uses the lockfile.

## fzt Deploy Pipeline

The deploy workflow (`full-stack-deploy.yml`) downloads `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, and `fzt-web.js` from the latest fzt-browser GitHub release at deploy time — none committed to git. Triggered by `repository_dispatch` (`fzt-updated`) from fzt-browser's release pipeline, in addition to `frontend/**` pushes and manual dispatch. This means pushing a new fzt-browser version automatically redeploys both the showcase and this app.

After deploy, the workflow writes `version.json` (containing the fzt-browser release version used), verifies it's live on CDN, then POSTs to `api.romaine.life/ci/deployed` so the CI dashboard can show which version is running in production.

## Change Log

### 2026-04-18

- **Bookmarks migrated off Azure Blob Storage** — all bookmark data (per-user `bookmarks` + cross-identity `bookmarks-shared`) now lives in a new Cosmos container `HomepageDB.fzt-frontend-data` as append-only versioned docs. Route package signature: `bookmarksContainerClient` → `bookmarksContainer` (Cosmos). Same storage pattern as the AT menu. Blob container `homepageprofilepics/bookmarks` kept allocated as safety net pending verification, then torn down. Motivation: enable cross-service refs — the AT menu can now contain `{ ref: "bookmarks" }` that resolves at read time to the caller's homepage bookmarks (see fzt-terminal-routes ref resolver). Blob-backed isolation prevented that.
- **Ref convention** — shared refs in stored trees drop the `shared-` prefix (was `{ ref: "shared-google" }` in blob era, now `{ ref: "google" }`). The `shared-` marker was redundant — doc `type='bookmarks-shared'` already distinguishes.
- **Version conflict** — `_refVersion` is now an integer version number from the Cosmos doc, not a `lastModified` ISO string. Client/server compare by equality.

### 2026-04-05

- **Terminal-minted JWT auth** — eliminated all browser-side authentication (MSAL.js CDN, Microsoft login button, local username/password form, account dropdown, display toggle, logout button, avatar, Gravatar). Auth now happens entirely via the `at` command (`homepagelogin`), which reads identity config from `${PROFILE_DIR}/config/homepage.yaml`, fetches the JWT signing secret from macOS Keychain or Azure Key Vault, mints a 30-day JWT, and injects it into the browser. Frontend shows bookmarks if token exists, playground mode if not.
- **Cookie auth via one-time code exchange** — terminal mints JWT, exchanges it for a one-time code via `POST /auth/code`, opens browser at `/auth/callback?code=...` which sets an HttpOnly 30-day cookie and redirects to the frontend. No sensitive values in clipboard, localStorage, or visible URLs. Frontend uses `credentials: include` on all API calls. Added `/auth/logout` endpoint.
- **Bookmarks migrated to Azure Blob Storage** — bookmarks moved from Cosmos DB to a versioned blob container (`bookmarks`) on the existing `homepageprofilepics` storage account. The API routes package now reads/writes JSON blobs using `@azure/storage-blob` SDK via managed identity. Conflict detection uses blob `lastModified` timestamps. Blob versioning provides automatic history of every save.
- **Settings remain in Cosmos DB** — settings (background image URL, future customizations) stay in Cosmos DB (`HomepageDB`/`userdata` container). Background image applied on load via `document.body.style.backgroundImage`.
- **homectl folder** — moved Edit and Sync from green toolbar buttons into fzt bookmark actions (`homectl:edit`, `homectl:logout`). Toolbar buttons removed from HTML. Edit/save/cancel buttons remain hidden until edit mode activates.
- **YAML quoting** — `bookmarksToYaml()` now quotes `name` and `url` values to handle protocol URIs like `spotify:` that break unquoted YAML.
- **Bookmark name normalization** — spaces replaced with hyphens in `cleanBookmarks()` and the inline editor. Default new bookmark name changed from "New bookmark" to "new-bookmark". Space is reserved for scope-locking behavior.
- **Spotify control** — custom `spotify-ctl:` protocol handler using `Windows.Media.Control` API (Python `winrt` package) targets Spotify's media session specifically. Supports toggle, play, pause, next, prev. Registry protocol handler + Chrome/Edge `AutoLaunchProtocolsFromOrigins` policy configured via `init.ps1`.
- **desktop folder** — new top-level bookmark folder with `spotify/` subfolder (open, toggle, next, prev commands).
- **Cosmos DB direct access documented** — Claude can query Cosmos directly via `az cli` + HMAC-SHA256 auth headers. Resource group is `infra` (from `infra-bootstrap/tofu/main.tf`). `az cosmosdb sql query` subcommand does not exist — must use REST data plane. Nelson's primary userId identified and documented. Stale duplicate account deleted.
- **fzt nav/search unification** — Space on a folder in nav mode now pushes scope (was broken — typed space character). Right on a folder pushes scope (was expand-only). Enter, Right, Space all call `pushScope` on folders. Prompt bar rendering unified: `navMode` affects only the icon, not breadcrumb/content/cursor/highlighting. Removed italic name echo and `HideCursor` in nav mode.
- **Node icon spacing** — added 6px `margin-right` to `.node-icon` for clear separation between folder/file icons and labels in the HTML tree editor.
- **Notification hooks** — `Stop` and `PermissionRequest` hooks in `~/.claude/settings.json` play notification sound via PowerShell on every response and plan presentation. Removed manual notification instruction from Profile 1 CLAUDE.md.
- **fzt self-update** — added `fzt update` subcommand that downloads the latest release binary from GitHub for the current OS/arch and replaces the running executable.
- **Fixed "Loading fzt..." hang on empty/missing bookmarks** — `loadBookmarks()` in `fzh-terminal.js` checked `bookmarks.length === 0` and returned early, preventing fzt from ever initializing when the user had no saved bookmarks (empty blob container) or when the API returned a non-array. Removed the length guard, added `Array.isArray` coercion for object responses, and removed the `loadYAML` falsy early return so fzt always renders (empty tree is valid).

#### Resolved

- **Cookie auth endpoints** — `/auth/code`, `/auth/callback`, `/auth/whoami`, `/auth/logout` are live on the API. The publish → API lockfile gap was fixed with a new `dispatch.yml` speculative build workflow in the API repo.
- **Pipeline dependency diagram** — `/pipelines` route in infra-diagram shows the cross-repo pipeline dependency chain (fzt-terminal → my-homepage/fzt-showcase → api).

### 2026-04-06

- **Browser extension for Ctrl+T homepage** — New `extension/` directory containing a minimal Manifest V3 Chrome extension (`manifest.json` + `background.js`). Registers `Ctrl+Shift+H` as a keyboard shortcut via `chrome.commands` that opens `homepage.romaine.life` in a new tab. Works identically across Chrome, Chromium, and Firefox (WebExtensions API). Loaded as an unpacked extension in Chrome at `chrome://extensions`. Paired with an AutoHotkey script in `shell-config-profile-1` that remaps `Ctrl+T` → `Ctrl+Shift+H` in browser windows, so the net effect is `Ctrl+T` opens the homepage instead of a blank new tab. Solves the longstanding problem of Chrome's reserved `Ctrl+T` shortcut — browsers don't allow extensions to override it, so the OS-level remap intercepts the keypress before Chrome sees it.
- **Frontend-registered `:` commands** — Homepage commands (edit, logout, copy yaml, paste yaml) moved from fzt's hardcoded `commands.go` to `fzh-terminal.js` via `fzt.addCommands()`. Called after WASM init but before session start. Core fzt commands (version, update) are now nested behind `::` in the palette. This is the first use of fzt-core's new `FrontendCommands` API — each frontend owns its command list.

### 2026-04-08

- **Bookmark ref system** — cross-user shared bookmarks via blob storage pointers. A bookmark entry `{ ref: "shared-google" }` points to a separate blob. API resolves refs on GET (expands inline with `_ref`/`_refVersion` metadata), decomposes on PUT (writes edits back to source blobs, stores pointer in user blob). Version conflict detection on ref blobs. Schema rule: if `ref` present, no other properties allowed. Motivated by wanting the same Google bookmarks folder across nelson, nelson-ea, nelson-r1 identities.
- **Background fetch model** — cache-first rendering with non-blocking background sync. Page loads from localStorage cache instantly (works offline). `fetchBookmarks()` fires as a detached promise. If fresh data differs from cache, stashed in `pendingBookmarks` with green sync indicator (bottom-right dot). Click applies. Motivated by keeping fzt startup snappy — no network call blocks the first render.
- **YAML parser stripQuotes** — `yamlToBookmarks()` now strips surrounding quotes and unescapes backslash/quote sequences. Fixes round-trip corruption for protocol URIs like `spotify:`.
- **Ref-aware serialization** — `bookmarksToYaml()` serializes `_ref` nodes as `- ref: "name"` (compact form). `cleanBookmarks()` preserves `_ref`/`_refVersion` metadata through edits. `yamlToBookmarks()` parses `- ref:` lines. HTML tree shows ref folders with green linked-folder nerd font icon (`.ref-node` CSS class).
- **AT convergence** — documented plan for fzt-automate to share bookmark data via blob storage. AT's `syncbookmarks` fetches from the homepage API and writes to a local cache file referenced by root.yaml's `children:` file pointer mechanism.
