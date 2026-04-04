// ── fzt terminal integration for my-homepage ──────────────────
// Thin wrapper around the shared fzt-terminal.js component.
// Handles bookmark serialization and edit mode integration.

import { createFztTerminal } from './fzt-terminal.js';

// Catppuccin Mocha 16-color palette
const PALETTE = [
  "#1e1e2e", "#f38ba8", "#a6e3a1", "#f9e2af",
  "#89b4fa", "#cba6f7", "#94e2d5", "#bac2de",
  "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
  "#89b4fa", "#cba6f7", "#94e2d5", "#cdd6f4",
];

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
  _term = createFztTerminal(containerEl, {
    palette: PALETTE,
    fontFamily: '"Cascadia Code","Fira Code","JetBrains Mono","Consolas",monospace',
    nerdFontFamily: "'Symbols Nerd Font Mono','Cascadia Code',monospace",
    cursorClass: "fzh-cursor",
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
