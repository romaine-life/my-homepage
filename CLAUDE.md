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

Primary navigation is a fzt WASM terminal rendered in a `<pre>` element. The Go TUI runs in-browser via WebAssembly — all scoring, filtering, and rendering happens in Go; the JS side is stateless (forwards keyboard events, parses ANSI output, renders styled spans, handles row clicks).

- **Layout**: Single-panel — fzt terminal fills the main content area. No side rail. The HTML tree only appears during edit mode (full-width). The old two-panel side-rail layout was removed.
- **Unified tree+search**: fzt starts in tree view mode (`fzt.init`). The tree is the single navigation surface. Two modes: search mode (typing drives cursor to top match) and nav mode (arrow keys / Shift+HJKL). Enter on a folder pushes scope; Left/Right expand/collapse visually.
- **Scope as breadcrumb**: Enter, Tab, or Space on a folder pushes scope. The folder name appears as greyed-out locked text in the prompt. Backspace/Escape on empty query pops scope. The tree expands the scoped folder in place — full hierarchy stays visible.
- **Clipboard commands**: fzt's `:` command palette has a "tree edit" folder with "copy yaml" (copies bookmark tree to clipboard) and "paste yaml" (reads YAML from clipboard, saves via API). Replaces the old Monaco YAML editor.
- **Click support**: Row `<div>` click handlers call `fzt.clickRow(row)` — fzt maps the visual row to a tree item. Folders push scope, leaves return URLs for navigation.
- **Data flow**: `bookmarks JSON → bookmarksToYaml() → fzt.loadYAML() → fzt.init(cols, rows)` — returns ANSI frames; `fzt.handleKey()` on each keystroke; `fzt.clickRow()` on mouse clicks
- **Keyboard routing**: All keys forwarded to fzt by default. Forwarding stops when `editMode` is active or focus is in an input/textarea/select.
- **Edit mode**: Swaps from fzt terminal to HTML tree editor (existing click-based UI, full-width). Save/cancel returns to fzt.
- **Shared assets**: `fzt.wasm`, `fzt-terminal.js`, `fzt-terminal.css`, `fzt-web.js` — all downloaded from fzt releases at deploy time (gitignored). `fzt-web.js` provides built-in Catppuccin Mocha palette, DOS font stack, and cursor config. `fzh-terminal.js` is a thin app-specific wrapper that only overrides `containerPadding` and `defaultCursorPos`.
- **CRT visual style**: Shared `fzt-terminal.css` provides scanlines, vignette, rounded corners, and cursor blink. CSS variables `--fzt-bg: #181825` and `--fzt-fg: #cdd6f4` override the defaults for Catppuccin theming. DOS font (Perfect DOS VGA 437) with font-smoothing disabled.
- **Fonts**: `PerfectDOSVGA437.ttf` (primary terminal font), `SymbolsNerdFontMono-Regular.ttf` (nerd font icons)
- **Script load order**: MSAL CDN → `wasm_exec.js` → `script.js` (module). `wasm_exec.js` must load before ES modules since it defines the global `Go` constructor.
- **Local dev**: `cd D:\repos\fzt && $env:GOOS="js"; $env:GOARCH="wasm"; go build -o D:\repos\my-homepage\frontend\fzt.wasm ./cmd/wasm`. Also copy `web/fzt-terminal.js`, `web/fzt-terminal.css`, `web/fzt-web.js` to `frontend/`.

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
