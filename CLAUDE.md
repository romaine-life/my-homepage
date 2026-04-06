# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Auth

Terminal-minted JWTs — no browser-side auth UI. The `at` command (`homepagelogin`) reads a profile-specific identity config (`${PROFILE_DIR}/config/homepage-{identity}.yaml`), fetches the JWT signing secret (KWallet on Linux, macOS Keychain on Mac, Azure Key Vault on Windows), mints a 30-day JWT, exchanges it for a one-time code via the API, and opens the browser at the callback URL to set an HttpOnly cookie. No MSAL, no OAuth, no login forms.

- **Three identities**: `nelson` (personal, all profiles), `nelson-ea` (Engineered Arts, profile 2), `nelson-r1` (R1, profile 3). Each gets separate bookmark sets. The profile config YAML determines which identity to use.
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

Bookmarks live in Azure Blob Storage (`homepageprofilepics` storage account, `bookmarks` container, private, versioned). Each user's bookmarks are a JSON blob named by sanitized userId (e.g., `nelson.yaml`). Blob versioning is enabled — every save creates a new version automatically, providing diff-like history.

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

Three identities with clean sub values (migrated from legacy OAuth IDs):

- `nelson` — personal (`nelson-devops-project@outlook.com`), all profiles
- `nelson-ea` — Engineered Arts (`n.romaine@engineeredarts.com`), profile 2
- `nelson-r1` — R1 (`gromaine@r1rcm.com`), profile 3

Blob filenames match: `nelson.yaml`, `nelson-ea.yaml`, `nelson-r1.yaml`. Legacy Google OAuth accounts remain in Cosmos DB but are unused.

## Publish Pipeline

Triggers on push to `packages/routes/**` (path-based, same pattern as kill-me/plant-agent). Auto-bumps patch version from registry, publishes, then dispatches `dependency-updated` to the API repo. After dispatch, the API lockfile must be updated locally before the API build will pick up the new version — `npm ci` uses the lockfile.

## fzt Deploy Pipeline

The deploy workflow (`full-stack-deploy.yml`) downloads `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, and `fzt-web.js` from the latest fzt GitHub release at deploy time — none committed to git. Triggered by `repository_dispatch` (`fzt-updated`) from fzt's release pipeline, in addition to `frontend/**` pushes and manual dispatch. This means pushing a new fzt version automatically redeploys both the showcase and this app.

## Change Log

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
- **Pipeline dependency diagram** — `/pipelines` route in infra-diagram shows the cross-repo pipeline dependency chain (fzt → my-homepage/fzt-showcase → api).

### 2026-04-06

- **Browser extension for Ctrl+T homepage** — New `extension/` directory containing a minimal Manifest V3 Chrome extension (`manifest.json` + `background.js`). Registers `Ctrl+Shift+H` as a keyboard shortcut via `chrome.commands` that opens `homepage.romaine.life` in a new tab. Works identically across Chrome, Chromium, and Firefox (WebExtensions API). Loaded as an unpacked extension in Chrome at `chrome://extensions`. Paired with an AutoHotkey script in `shell-config-profile-1` that remaps `Ctrl+T` → `Ctrl+Shift+H` in browser windows, so the net effect is `Ctrl+T` opens the homepage instead of a blank new tab. Solves the longstanding problem of Chrome's reserved `Ctrl+T` shortcut — browsers don't allow extensions to override it, so the OS-level remap intercepts the keypress before Chrome sees it.
