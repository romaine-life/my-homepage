// ── fzt terminal integration for my-homepage ──────────────────
// Thin wrapper around the shared fzt-terminal.js component.
// Handles bookmark serialization and edit mode integration.

import { createFztWeb } from './fzt-web.js';
import { CONFIG } from './config.js';

let _term = null;
let _onAction = null;

// ── Bookmarks → YAML serializer (for fzt WASM loading) ────────
// NOTE: This copy does NOT handle ref nodes (_ref, ref) — it only
// sees fully resolved bookmarks. The script.js copy handles ref
// serialization for clipboard export and cloud save. Both must
// stay in sync on the base format (name, url, children, escaping).
function bookmarksToYaml(items, indent) {
  indent = indent || 0;
  const pad = "  ".repeat(indent);
  let out = "";
  for (const item of items) {
    out += pad + "- name: \"" + item.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"\n";
    if (item.description) out += pad + "  description: \"" + item.description.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"\n";
    if (item.url) out += pad + "  url: \"" + item.url.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"\n";
    if (Array.isArray(item.children) && item.children.length > 0) {
      out += pad + "  children:\n";
      out += bookmarksToYaml(item.children, indent + 2);
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────

export async function initFzhTerminal(containerEl) {
  _term = createFztWeb(containerEl, {
    containerPadding: 8,
    defaultCursorPos: null,
    onAction: (action, url, event) => {
      if (_onAction) _onAction(action, url, event);
    },
  });

  await _term.initWasm();

  // Register frontend identity and commands for the : palette.
  // All registered commands assume an authenticated session (edit/logout
  // are useless without one; copy/paste are scoped to the current user's
  // tree). script.js gates addCommands on auth; playground visitors call
  // hidePalette() instead so no `:` row shows at root.
  _term.setFrontend({ name: "homepage", version: CONFIG.homepageVersion || "dev" });
}

export function registerCommands() {
  if (!_term || !_term.isReady()) return;
  _term.addCommands([
    { name: "ambience mode", description: "Hide homepage and show ambience", action: "ambience-mode" },
    { name: "sync", description: "Check cloud for new bookmarks", action: "refresh" },
    { name: "edit", description: "Edit bookmark tree", action: "edit" },
    { name: "logout", description: "Log out", action: "logout" },
    { name: "copy yaml", description: "Copy bookmark tree to clipboard", action: "copy-yaml" },
    { name: "paste yaml", description: "Save clipboard YAML as bookmarks", action: "paste-yaml" },
  ]);
}

export function registerPublicCommands() {
  if (!_term || !_term.isReady()) return;
  _term.addCommands([
    { name: "ambience mode", description: "Hide homepage and show ambience", action: "ambience-mode" },
  ]);
}

export function hidePalette() {
  if (!_term || !_term.isReady()) return;
  _term.hidePalette();
}

// Write to the fzt title status bar. style maps to core.State.TitleStyle
// (0=default cyan, 1=green success, 2=red error, 3=neutral slate).
// Requires an active session — call after loadBookmarks has fired init.
export function setStatus(msg, style = 0) {
  if (!_term || !_term.isReady()) return;
  _term.setStatus(msg, style);
}

export function clearStatus() {
  if (!_term || !_term.isReady()) return;
  _term.clearStatus();
}

export function setIdentity(identity) {
  if (_term && _term.isReady()) _term.setIdentity(identity);
}

export function loadBookmarks(bookmarks) {
  if (!_term || !_term.isReady()) return;
  if (!bookmarks) return;
  if (!Array.isArray(bookmarks)) bookmarks = [];
  if (bookmarks.length === 0) return;

  const yaml = bookmarksToYaml(bookmarks);
  if (!_term.loadYAML(yaml)) return;
  _term.init();
}

export function setEditMode(val) {
  if (_term) _term.setEditMode(val);
}

export function setActive(val) {
  if (_term) _term.setActive(val);
}

export function onAction(callback) {
  _onAction = callback;
}

export function sendKey(key, ctrlKey, shiftKey, altKey = false, metaKey = false) {
  if (_term) _term.handleKey(key, ctrlKey, shiftKey, altKey, metaKey);
}

export function isTerminalReady() {
  return _term ? _term.isReady() : false;
}
