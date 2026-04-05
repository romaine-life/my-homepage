// ── fzt terminal integration for my-homepage ──────────────────
// Thin wrapper around the shared fzt-terminal.js component.
// Handles bookmark serialization and edit mode integration.

import { createFztWeb } from './fzt-web.js';

let _term = null;
let _onAction = null;

// ── Bookmarks → YAML serializer ────────────────────────────────
function bookmarksToYaml(items, indent) {
  indent = indent || 0;
  const pad = "  ".repeat(indent);
  let out = "";
  for (const item of items) {
    out += pad + "- name: " + item.name + "\n";
    if (item.url) out += pad + "  url: " + item.url + "\n";
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
    onAction: (action, url) => {
      if (_onAction) _onAction(action, url);
    },
  });

  await _term.initWasm();
}

export function loadBookmarks(bookmarks) {
  if (!_term || !_term.isReady()) return;
  if (!bookmarks || bookmarks.length === 0) return;

  const yaml = bookmarksToYaml(bookmarks);
  if (!_term.loadYAML(yaml)) return;
  _term.initSession();
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

export function sendKey(key, ctrlKey, shiftKey) {
  if (_term) _term.sendKey(key, ctrlKey, shiftKey);
}

export function isTerminalReady() {
  return _term ? _term.isReady() : false;
}
