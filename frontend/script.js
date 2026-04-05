import { CONFIG } from './config.js';
import { logout, getToken, isAuthenticated, fetchSettings, putSettings } from './auth.js';
import { initFzhTerminal, loadBookmarks as loadFzhBookmarks, setEditMode, setActive as setTerminalActive, onAction as onTerminalAction, isTerminalReady } from './fzh-terminal.js';

// ── DOM references ──────────────────────────────────────────────
const tree = document.getElementById("tree");
const saveBtn = document.getElementById("save-btn");
const cancelBtn = document.getElementById("cancel-btn");
const apiError = document.getElementById("api-error");

const CACHE_KEY = "cached_bookmarks";
const PLAYGROUND_KEY = "playground_bookmarks";
const SETTINGS_CACHE_KEY = "cached_settings";

// ── Edit mode state ─────────────────────────────────────────────
let editMode = false;
let editBookmarks = null;   // deep clone used during editing
let currentBookmarks = [];  // last-fetched/rendered bookmarks
let lastFetchedVersion = null;  // timestamp of last fetched bookmarks (for conflict detection)
let originalBookmarks = [];  // original bookmarks at fetch time (for 3-way merge)
let userAuthenticated = false;
let playgroundMode = false;
let dragAllowed = false;
let dragState = null;
document.addEventListener("mouseup", () => { dragAllowed = false; });

const fzhTerminal = document.getElementById("fzh-terminal");

function showTerminal() {
  fzhTerminal.classList.remove("hidden");
  tree.classList.add("hidden");
  setTerminalActive(true);
}

function showTree() {
  fzhTerminal.classList.add("hidden");
  tree.classList.remove("hidden");
  setTerminalActive(false);
}

function ensureAbsoluteUrl(url) {
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return "https://" + url;
  return url;
}

const SAMPLE_BOOKMARKS = [
  {
    name: "Getting Started",
    children: [
      { name: "Add your own bookmarks" },
      { name: "Organize into folders" },
      { name: "Log in to save permanently" },
    ],
  },
  {
    name: "Example Links",
    children: [
      { name: "Wikipedia", url: "https://en.wikipedia.org" },
      { name: "Hacker News", url: "https://news.ycombinator.com" },
    ],
  },
];

// ── Local dev indicator ──────────────────────────────────────────

if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  document.getElementById("local-badge").classList.remove("hidden");
}

// ── App entry point ─────────────────────────────────────────────

(async function main() {
  const fzhReady = initFzhTerminal(fzhTerminal);

  tree.classList.add("hidden");
  setTerminalActive(true);

  // Wire up fzt action callback
  onTerminalAction(async (action, url) => {
    if (action.startsWith("select:") && url) {
      if (url === "homectl:edit") { enterEditMode(); return; }
      if (url === "homectl:logout") { logout(); return; }
      window.location.href = ensureAbsoluteUrl(url);
    } else if (action === "copy-yaml") {
      const yaml = bookmarksToYaml(currentBookmarks);
      await navigator.clipboard.writeText(yaml);
    } else if (action === "paste-yaml") {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text) return;
        const parsed = yamlToBookmarks(text);
        if (!Array.isArray(parsed) || parsed.length === 0) { alert("Clipboard does not contain valid bookmark YAML."); return; }
        const cleaned = cleanBookmarks(parsed);
        if (playgroundMode) {
          savePlaygroundBookmarks(cleaned);
          currentBookmarks = cleaned;
          if (isTerminalReady()) loadFzhBookmarks(currentBookmarks);
          return;
        }
        const result = await saveBookmarksWithConflictHandling(cleaned);
        if (result.success) {
          const finalBookmarks = result.merged ? result.bookmarks : cleaned;
          saveCachedBookmarks(finalBookmarks);
          currentBookmarks = finalBookmarks;
          if (isTerminalReady()) loadFzhBookmarks(currentBookmarks);
          if (result.merged) alert("Bookmarks merged with remote changes.");
        } else {
          showConflictResolutionUI(result.localBookmarks, result.serverBookmarks, result.conflicts);
        }
      } catch (err) {
        console.error("paste-yaml failed:", err);
        alert("Failed to save bookmarks from clipboard: " + err.message);
      }
    }
  });

  const cached = loadCachedBookmarks();

  if (isAuthenticated()) {
    userAuthenticated = true;
    playgroundMode = false;

    // Load cached settings and apply background
    let settings = loadCachedSettings();
    if (!settings) {
      try {
        settings = await fetchSettings();
        saveCachedSettings(settings);
      } catch { settings = {}; }
    }
    if (settings.backgroundUrl) {
      document.body.style.backgroundImage = `url(${settings.backgroundUrl})`;
    }

    // Fetch fresh bookmarks
    const cached = loadCachedBookmarks();
    if (cached) {
      currentBookmarks = cached;
      fzhReady.then(() => loadFzhBookmarks(cached));
    }
    const fresh = await fetchBookmarks();
    saveCachedBookmarks(fresh);
    currentBookmarks = fresh;
    renderBookmarks(fresh);
    fzhReady.then(() => loadFzhBookmarks(fresh));
  } else {
    // Playground mode — no auth, local-only bookmarks
    userAuthenticated = false;
    playgroundMode = true;
    const saved = loadPlaygroundBookmarks();
    currentBookmarks = (saved && saved.length > 0) ? saved : deepClone(SAMPLE_BOOKMARKS);
    savePlaygroundBookmarks(currentBookmarks);
    renderBookmarks(currentBookmarks);
    fzhReady.then(() => loadFzhBookmarks(currentBookmarks));
  }
})();

function showApiError(msg) {
  apiError.textContent = msg;
  apiError.classList.remove("hidden");
}

function hideApiError() {
  apiError.classList.add("hidden");
}

// ── localStorage helpers ────────────────────────────────────────

function loadCachedBookmarks() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedBookmarks(bookmarks) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(bookmarks));
  } catch {
    // Storage full or unavailable — non-critical
  }
}

function bookmarksEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Playground localStorage helpers ──────────────────────────────

function loadPlaygroundBookmarks() {
  try {
    const raw = localStorage.getItem(PLAYGROUND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function savePlaygroundBookmarks(bookmarks) {
  try {
    localStorage.setItem(PLAYGROUND_KEY, JSON.stringify(bookmarks));
  } catch { /* non-critical */ }
}

function clearPlaygroundBookmarks() {
  try { localStorage.removeItem(PLAYGROUND_KEY); } catch { /* non-critical */ }
}

// ── Settings localStorage helpers ────────────────────────────────

function loadCachedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch { /* non-critical */ }
}

function clearCachedSettings() {
  try { localStorage.removeItem(SETTINGS_CACHE_KEY); } catch { /* non-critical */ }
}

// ── API ─────────────────────────────────────────────────────────

async function fetchBookmarks() {
  try {
    const token = getToken();
    let res = await fetch(`${CONFIG.apiUrl}/api/bookmarks`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 503) {
      await ensureBackendReady();
      res = await fetch(`${CONFIG.apiUrl}/api/bookmarks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    // Invalid/expired token — force re-login instead of showing stale data
    if (res.status === 401) {
      logout();
      return [];
    }

    if (!res.ok) throw new Error(`API error: ${res.status}`);

    const data = await res.json();
    hideApiError();

    // Store version and original bookmarks for conflict detection
    lastFetchedVersion = data.updatedAt;
    const bookmarks = data.bookmarks || [];
    originalBookmarks = deepClone(bookmarks);

    return bookmarks;
  } catch (err) {
    console.error("Failed to fetch bookmarks:", err);
    const cached = loadCachedBookmarks();
    if (!cached) {
      showApiError(`Could not reach the API (${err.message})`);
    }
    return cached || [];
  }
}

async function putBookmarks(bookmarks) {
  const token = getToken();
  const requestBody = {
    bookmarks,
    lastKnownVersion: lastFetchedVersion  // Include version for conflict detection
  };

  let res = await fetch(`${CONFIG.apiUrl}/api/bookmarks`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (res.status === 503) {
    await ensureBackendReady();
    res = await fetch(`${CONFIG.apiUrl}/api/bookmarks`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  }

  // Invalid/expired token — force re-login
  if (res.status === 401) {
    logout();
    return;
  }

  // Handle conflict (409) specially
  if (res.status === 409) {
    const conflictData = await res.json();
    const error = new Error(conflictData.message || 'Conflict detected');
    error.isConflict = true;
    error.currentBookmarks = conflictData.currentBookmarks;
    error.currentVersion = conflictData.currentVersion;
    throw error;
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  // Update version after successful save
  lastFetchedVersion = data.updatedAt;
  originalBookmarks = deepClone(data.bookmarks);

  return data;
}

/**
 * Save bookmarks with automatic conflict resolution.
 * Attempts to merge if a conflict is detected.
 */
async function saveBookmarksWithConflictHandling(bookmarks) {
  try {
    await putBookmarks(bookmarks);
    return { success: true };
  } catch (err) {
    if (err.isConflict) {
      // Conflict detected - attempt auto-merge
      console.log('Conflict detected, attempting merge...', err);

      const mergeResult = attemptMerge(
        originalBookmarks,
        bookmarks,
        err.currentBookmarks
      );

      if (mergeResult.success) {
        // Merge succeeded - update our version and retry save
        console.log('Auto-merge successful, retrying save...');
        lastFetchedVersion = err.currentVersion;
        originalBookmarks = deepClone(err.currentBookmarks);

        try {
          await putBookmarks(mergeResult.bookmarks);
          return { success: true, merged: true, bookmarks: mergeResult.bookmarks };
        } catch (retryErr) {
          // Even merge failed to save (another conflict?)
          throw new Error('Failed to save merged bookmarks: ' + retryErr.message);
        }
      } else {
        // Merge failed - conflicts that require manual resolution
        return {
          success: false,
          conflicts: mergeResult.conflicts,
          serverBookmarks: err.currentBookmarks,
          localBookmarks: bookmarks
        };
      }
    } else {
      // Not a conflict error, rethrow
      throw err;
    }
  }
}

// ── 3-way merge for conflict resolution ─────────────────────────

/**
 * Attempts to merge local and server bookmarks using 3-way merge.
 * @param {Array} original - Original bookmarks (common ancestor)
 * @param {Array} local - Local bookmarks (with user's changes)
 * @param {Array} server - Server bookmarks (with remote changes)
 * @returns {{ success: boolean, bookmarks?: Array, conflicts?: Array }}
 */
function attemptMerge(original, local, server) {
  const originalJson = JSON.stringify(original);
  const localJson = JSON.stringify(local);
  const serverJson = JSON.stringify(server);

  // Fast path: if no conflict (one side unchanged)
  if (localJson === originalJson) {
    // Only server changed, use server version
    return { success: true, bookmarks: server };
  }
  if (serverJson === originalJson) {
    // Only local changed, use local version
    return { success: true, bookmarks: local };
  }
  if (localJson === serverJson) {
    // Both sides made the same changes (unlikely but possible)
    return { success: true, bookmarks: local };
  }

  // Complex case: both sides changed
  // For now, we'll use a simple strategy:
  // Try to merge by combining additions from both sides
  const merged = mergeBookmarkArrays(original, local, server);

  if (merged.conflicts.length > 0) {
    return { success: false, conflicts: merged.conflicts };
  }

  return { success: true, bookmarks: merged.result };
}

/**
 * Merge two bookmark arrays with conflict detection.
 * Simple strategy: combine unique additions, detect conflicting modifications.
 */
function mergeBookmarkArrays(original, local, server) {
  const result = [];
  const conflicts = [];

  // Build maps by bookmark path for easier comparison
  const originalMap = buildBookmarkMap(original);
  const localMap = buildBookmarkMap(local);
  const serverMap = buildBookmarkMap(server);

  const allPaths = new Set([...Object.keys(originalMap), ...Object.keys(localMap), ...Object.keys(serverMap)]);

  for (const path of allPaths) {
    const origItem = originalMap[path];
    const localItem = localMap[path];
    const serverItem = serverMap[path];

    const origJson = JSON.stringify(origItem);
    const localJson = JSON.stringify(localItem);
    const serverJson = JSON.stringify(serverItem);

    if (!localItem && !serverItem) {
      // Both deleted - OK, skip
      continue;
    } else if (!localItem && serverItem) {
      // Local deleted, server kept/modified
      if (origJson === serverJson) {
        // Local deleted, server unchanged - use local's delete
        continue;
      } else {
        // Conflict: local deleted, server modified
        conflicts.push({ path, type: 'delete-modify', local: null, server: serverItem });
      }
    } else if (localItem && !serverItem) {
      // Server deleted, local kept/modified
      if (origJson === localJson) {
        // Server deleted, local unchanged - use server's delete
        continue;
      } else {
        // Conflict: server deleted, local modified
        conflicts.push({ path, type: 'modify-delete', local: localItem, server: null });
      }
    } else if (localJson === serverJson) {
      // Both have same value - no conflict
      // (This handles both keeping original or making same change)
      continue; // Will be added during reconstruction
    } else if (localJson === origJson) {
      // Local unchanged, server changed - use server
      continue; // Will be added during reconstruction
    } else if (serverJson === origJson) {
      // Server unchanged, local changed - use local
      continue; // Will be added during reconstruction
    } else {
      // Both changed differently - conflict
      conflicts.push({ path, type: 'modify-modify', local: localItem, server: serverItem });
    }
  }

  // If conflicts detected, return early
  if (conflicts.length > 0) {
    return { result: null, conflicts };
  }

  // No conflicts - reconstruct merged bookmarks
  // Use local as base, then apply server changes
  const merged = deepClone(local);

  // This is a simplified merge - for production, you'd want more sophisticated tree merging
  // For now, if we reach here with no conflicts, we'll use local changes
  // (A more sophisticated implementation would merge the trees properly)

  return { result: merged, conflicts: [] };
}

/**
 * Build a map of bookmarks by their path for comparison.
 */
function buildBookmarkMap(bookmarks, parentPath = '') {
  const map = {};

  bookmarks.forEach((item, index) => {
    const path = parentPath ? `${parentPath}.${index}` : `${index}`;
    const key = item.name || path; // Use name as key, fallback to path

    map[key] = {
      name: item.name,
      url: item.url,
      hasChildren: !!item.children
    };

    if (item.children) {
      Object.assign(map, buildBookmarkMap(item.children, key));
    }
  });

  return map;
}

// ── SHA-256 helper (for Gravatar) ────────────────────────────────


// ── Deep clone helper ───────────────────────────────────────────

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Conflict Resolution UI ──────────────────────────────────────

function showConflictResolutionUI(localBookmarks, serverBookmarks, conflicts) {
  const message = `
Bookmark sync conflict detected!

Changes were made both here and on another device. Auto-merge failed because:
${conflicts.map(c => `- ${c.type} conflict at: ${c.path}`).join('\n')}

Choose which version to keep:
- "Keep Mine" will save your local changes (and discard remote changes)
- "Use Remote" will use the other device's changes (and discard yours)
- "Cancel" will not save anything (you keep your current local state)
  `.trim();

  const choice = confirm(message + '\n\nClick OK to keep YOUR changes, or Cancel to review options.');

  if (choice) {
    // User wants to keep their local changes
    // Force save by updating the version to match server (override)
    confirmForceSave(localBookmarks, serverBookmarks, 'local');
  } else {
    // Show second dialog for other options
    const useRemote = confirm('Use REMOTE changes instead?\n\nOK = Use remote changes\nCancel = Don\'t save anything');

    if (useRemote) {
      // Use server's bookmarks
      lastFetchedVersion = null; // Clear version to accept server's
      currentBookmarks = deepClone(serverBookmarks);
      originalBookmarks = deepClone(serverBookmarks);
      saveCachedBookmarks(serverBookmarks);
      renderBookmarks(serverBookmarks);
      alert('Remote changes have been applied. Your local changes were discarded.');
    } else {
      // Do nothing - user canceled
      alert('No changes saved. Your local edits are preserved.');
    }
  }
}

async function confirmForceSave(localBookmarks, serverBookmarks, choice) {
  try {
    if (choice === 'local') {
      // Force save local by accepting server's version first, then overwriting
      lastFetchedVersion = null; // Reset version to force accept
      await putBookmarks(localBookmarks);
      saveCachedBookmarks(localBookmarks);
      currentBookmarks = localBookmarks;
      renderBookmarks(localBookmarks);
      alert('Your local changes have been saved. Remote changes were overwritten.');
    }
  } catch (err) {
    console.error('Failed to force save:', err);
    alert('Failed to save your changes. Please try again or contact support.');
  }
}

function isDescendant(target, ancestor) {
  if (!ancestor.children) return false;
  for (const child of ancestor.children) {
    if (child === target) return true;
    if (isDescendant(target, child)) return true;
  }
  return false;
}

// ── Rendering ───────────────────────────────────────────────────

function renderBookmarks(bookmarks) {
  tree.innerHTML = "";

  if (bookmarks.length === 0 && !editMode) {
    const msg = document.createElement("div");
    msg.className = "empty-state";
    msg.textContent = 'No bookmarks yet. Click "Edit" to add some.';
    tree.appendChild(msg);
    return;
  }

  if (!editMode) {
    // Prompt hint — looks like fzt's idle prompt, hints that typing switches to search
    const prompt = document.createElement("div");
    prompt.className = "tree-prompt";
    prompt.innerHTML = '<span class="prompt-char">&gt;</span> type to search\u2026';
    tree.appendChild(prompt);

    const urlLeft = Math.ceil(calcMaxRowWidth(bookmarks, 0)) + 2;
    tree.style.setProperty("--url-left", urlLeft + "ch");
  }

  tree.appendChild(renderList(bookmarks, 0, bookmarks));

  if (editMode) {
    if (bookmarks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = "Add your first bookmark below.";
      tree.appendChild(hint);
    }
    const addBtn = document.createElement("button");
    addBtn.className = "add-root-btn";
    addBtn.textContent = "+ Add bookmark";
    addBtn.addEventListener("click", () => {
      addNode(bookmarks, bookmarks.length);
    });
    tree.appendChild(addBtn);
  }
}

// Calculate the max visual width of all tree rows (in ch units) so
// hover-revealed URLs can be aligned in a single consistent column.
function calcMaxRowWidth(items, depth) {
  let max = 0;
  items.forEach((item) => {
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    // indent (4ch per depth) + icon (2ch) + name
    const width = depth * 4 + 2 + item.name.length;
    if (width > max) max = width;
    if (hasChildren) {
      const childMax = calcMaxRowWidth(item.children, depth + 1);
      if (childMax > max) max = childMax;
    }
  });
  return max;
}

// Build DOM for a list of sibling nodes.
// `prefix` is the inherited string of "│   " / "    " segments from ancestors.
// `parentArray` is the array containing these items (needed for edit mutations).
function renderList(items, depth, parentArray) {
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;

    // Row
    const row = document.createElement("div");
    row.className = "node";

    // Drag handle (edit mode only)
    if (editMode) {
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⠿";
      handle.addEventListener("mousedown", () => { dragAllowed = true; });
      row.appendChild(handle);

      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        if (!dragAllowed) { e.preventDefault(); return; }
        dragAllowed = false;
        dragState = { item, parentArray, index: i };
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
      });

      row.addEventListener("dragend", () => {
        dragState = null;
        row.classList.remove("dragging");
        tree.querySelectorAll(".drag-over-top, .drag-over-bottom").forEach(el => {
          el.classList.remove("drag-over-top", "drag-over-bottom");
        });
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!dragState || dragState.item === item) return;
        // Prevent dropping a folder into its own descendant
        if (isDescendant(item, dragState.item)) return;
        e.dataTransfer.dropEffect = "move";
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        row.classList.remove("drag-over-top", "drag-over-bottom");
        row.classList.add(e.clientY < midY ? "drag-over-top" : "drag-over-bottom");
      });

      row.addEventListener("dragleave", (e) => {
        if (!row.contains(e.relatedTarget)) {
          row.classList.remove("drag-over-top", "drag-over-bottom");
        }
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove("drag-over-top", "drag-over-bottom");
        if (!dragState || dragState.item === item) return;
        if (isDescendant(item, dragState.item)) return;

        // Remove from source
        const srcIdx = dragState.parentArray.indexOf(dragState.item);
        if (srcIdx > -1) dragState.parentArray.splice(srcIdx, 1);

        // Insert at target position
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        let targetIdx = parentArray.indexOf(item);
        if (e.clientY >= midY) targetIdx++;
        parentArray.splice(targetIdx, 0, dragState.item);

        dragState = null;
        reRenderEdit();
      });
    }

    // Indentation
    const pre = document.createElement("span");
    pre.className = "node-prefix";
    pre.textContent = "    ".repeat(depth);
    row.appendChild(pre);

    // Nerd font icon (folder or file)
    const icon = document.createElement("span");
    icon.className = "node-icon " + (hasChildren ? "folder-icon" : "file-icon");
    icon.textContent = hasChildren ? "\uDB80\uDE4B" : "\uF016";  // nerd font folder U+F024B / file U+F016
    row.appendChild(icon);

    // Label
    const label = document.createElement("span");
    label.className = "node-label" + (hasChildren ? " folder" : "");
    if (item.url) {
      const a = document.createElement("a");
      a.href = ensureAbsoluteUrl(item.url);
      a.textContent = item.name;
      label.appendChild(a);
    } else {
      label.textContent = item.name;
    }
    row.appendChild(label);

    // URL hint shown on hover (view mode only)
    if (item.url && !editMode) {
      const urlSpan = document.createElement("span");
      urlSpan.className = "node-url";
      urlSpan.textContent = item.url;
      row.appendChild(urlSpan);
    }

    // Edit mode action buttons
    if (editMode) {
      const actions = document.createElement("span");
      actions.className = "edit-actions";

      // Edit (pencil)
      const editNodeBtn = document.createElement("button");
      editNodeBtn.textContent = "✎";
      editNodeBtn.title = "Edit";
      editNodeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startInlineEdit(row, item, parentArray);
      });
      actions.appendChild(editNodeBtn);

      // Add child
      const addChildBtn = document.createElement("button");
      addChildBtn.className = "action-add";
      addChildBtn.textContent = "+";
      addChildBtn.title = "Add child";
      addChildBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!item.children) item.children = [];
        addNode(item.children, item.children.length);
      });
      actions.appendChild(addChildBtn);

      // Move up
      if (i > 0) {
        const upBtn = document.createElement("button");
        upBtn.textContent = "↑";
        upBtn.title = "Move up";
        upBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveNode(parentArray, i, -1);
        });
        actions.appendChild(upBtn);
      }

      // Move down
      if (i < items.length - 1) {
        const downBtn = document.createElement("button");
        downBtn.textContent = "↓";
        downBtn.title = "Move down";
        downBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveNode(parentArray, i, 1);
        });
        actions.appendChild(downBtn);
      }

      // Delete
      const delBtn = document.createElement("button");
      delBtn.className = "action-delete";
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteNode(parentArray, i, hasChildren);
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
    }

    frag.appendChild(row);

    // Children
    if (hasChildren) {
      const childrenContainer = document.createElement("div");
      childrenContainer.className = "children";
      childrenContainer.appendChild(renderList(item.children, depth + 1, item.children));
      frag.appendChild(childrenContainer);

      // Wire toggle — whole row triggers expand/collapse
      row.classList.add("clickable");
      row.addEventListener("click", (e) => {
        if (editMode && e.target.closest(".edit-actions")) return;
        if (editMode && e.target.closest(".node-edit-form")) return;
        if (e.target.closest("a") && !editMode) return;
        childrenContainer.classList.toggle("open");
      });
    } else if (item.url && !editMode) {
      // Wire link — whole row navigates (view mode only, not in yaml view)
      row.classList.add("clickable");
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return;
        window.location.href = ensureAbsoluteUrl(item.url);
      });
    }
  });
  return frag;
}

// ── Edit mode: inline editing ───────────────────────────────────

function startInlineEdit(row, item, parentArray) {
  // Replace label and actions with an inline form
  const label = row.querySelector(".node-label");
  const actions = row.querySelector(".edit-actions");
  if (label) label.classList.add("hidden");
  if (actions) actions.classList.add("hidden");

  const form = document.createElement("span");
  form.className = "node-edit-form";

  const nameInput = document.createElement("input");
  nameInput.className = "edit-name";
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.placeholder = "Name";
  form.appendChild(nameInput);

  const urlInput = document.createElement("input");
  urlInput.className = "edit-url";
  urlInput.type = "text";
  urlInput.value = item.url || "";
  urlInput.placeholder = "URL (empty = folder)";
  form.appendChild(urlInput);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "edit-confirm";
  confirmBtn.textContent = "✓";
  confirmBtn.title = "Confirm";
  form.appendChild(confirmBtn);

  const cancelEditBtn = document.createElement("button");
  cancelEditBtn.className = "edit-cancel";
  cancelEditBtn.textContent = "✕";
  cancelEditBtn.title = "Cancel";
  form.appendChild(cancelEditBtn);

  row.appendChild(form);
  row.draggable = false;
  nameInput.focus();
  nameInput.select();

  function confirm() {
    const name = nameInput.value.trim().replace(/ /g, "-");
    if (!name) return; // don't allow empty name
    if (/ /.test(nameInput.value.trim())) nameInput.value = name; // show the fix
    item.name = name;
    const url = urlInput.value.trim();
    if (url) {
      item.url = url;
    } else {
      delete item.url;
    }
    row.draggable = true;
    reRenderEdit();
  }

  function cancel() {
    form.remove();
    row.draggable = true;
    if (label) label.classList.remove("hidden");
    if (actions) actions.classList.remove("hidden");
  }

  confirmBtn.addEventListener("click", (e) => { e.stopPropagation(); confirm(); });
  cancelEditBtn.addEventListener("click", (e) => { e.stopPropagation(); cancel(); });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirm(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

// ── Edit mode: mutations ────────────────────────────────────────

function addNode(parentArray, index) {
  const newItem = { name: "new-bookmark", url: "" };
  parentArray.splice(index, 0, newItem);
  reRenderEdit();

  requestAnimationFrame(() => {
    const nodes = tree.querySelectorAll(".node");
    for (const node of nodes) {
      const label = node.querySelector(".node-label");
      if (label && label.textContent.includes("new-bookmark")) {
        const editPencil = node.querySelector(".edit-actions button");
        if (editPencil) editPencil.click();
        break;
      }
    }
  });
}

function deleteNode(parentArray, index, hasChildren) {
  if (hasChildren) {
    if (!confirm("Delete this folder and all its contents?")) return;
  }
  parentArray.splice(index, 1);
  reRenderEdit();
}

function moveNode(parentArray, index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= parentArray.length) return;
  const item = parentArray.splice(index, 1)[0];
  parentArray.splice(newIndex, 0, item);
  reRenderEdit();
}

function reRenderEdit() {
  tree.classList.add("edit-mode");
  renderBookmarks(editBookmarks);
  tree.querySelectorAll(".children").forEach((c) => c.classList.add("open"));
}

// ── Edit mode: enter / save / cancel ────────────────────────────

function enterEditMode() {
  // Edit mode uses the HTML tree — hide terminal, show tree
  showTree();
  editMode = true;
  setEditMode(true);
  editBookmarks = deepClone(currentBookmarks);
  saveBtn.classList.remove("hidden");
  cancelBtn.classList.remove("hidden");
  reRenderEdit();
}

async function saveEdits() {
  const cleaned = cleanBookmarks(editBookmarks);

  if (playgroundMode) {
    savePlaygroundBookmarks(cleaned);
    currentBookmarks = cleaned;
    exitEditMode();
    renderBookmarks(currentBookmarks);
    if (isTerminalReady()) loadFzhBookmarks(currentBookmarks);
    return;
  }

  try {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const result = await saveBookmarksWithConflictHandling(cleaned);

    if (result.success) {
      const finalBookmarks = result.merged ? result.bookmarks : cleaned;
      saveCachedBookmarks(finalBookmarks);
      currentBookmarks = finalBookmarks;
      exitEditMode();
      renderBookmarks(currentBookmarks);
      if (isTerminalReady()) loadFzhBookmarks(currentBookmarks);

      if (result.merged) {
        alert('Your changes were automatically merged with remote changes.');
      }
    } else {
      // Manual conflict resolution required
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      showConflictResolutionUI(result.localBookmarks, result.serverBookmarks, result.conflicts);
    }
  } catch (err) {
    console.error("Failed to save bookmarks:", err);
    alert("Failed to save. Please try again.");
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

function cancelEdits() {
  exitEditMode();
  renderBookmarks(currentBookmarks);
}

function exitEditMode() {
  editMode = false;
  setEditMode(false);
  editBookmarks = null;
  tree.classList.remove("edit-mode");
  saveBtn.classList.add("hidden");
  cancelBtn.classList.add("hidden");
  saveBtn.disabled = false;
  saveBtn.textContent = "Save";
  // Switch back to terminal (fzt tree mode)
  showTerminal();
}

function cleanBookmarks(items) {
  return items
    .filter((item) => item.name && item.name.trim())
    .map((item) => {
      const clean = { name: item.name.trim().replace(/ /g, "-") };
      if (item.url && item.url.trim()) clean.url = item.url.trim();
      if (Array.isArray(item.children) && item.children.length > 0) {
        clean.children = cleanBookmarks(item.children);
      }
      return clean;
    });
}

// ── Sync Button ──────────────────────────────────────────────────


// ── YAML serializer ─────────────────────────────────────────────

function bookmarksToYaml(items, indent) {
  indent = indent || 0;
  const pad = "  ".repeat(indent);
  let out = "";
  for (const item of items) {
    out += pad + "- name: \"" + item.name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"\n";
    if (item.url) out += pad + "  url: \"" + item.url.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"\n";
    if (Array.isArray(item.children) && item.children.length > 0) {
      out += pad + "  children:\n";
      out += bookmarksToYaml(item.children, indent + 2);
    }
  }
  return out;
}

// ── YAML parser (minimal, for our bookmark schema only) ─────────

function yamlToBookmarks(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let pos = 0;

  function parseList(baseIndent) {
    const items = [];
    while (pos < lines.length) {
      const line = lines[pos];
      const indent = line.search(/\S/);
      if (indent < baseIndent) break;

      const nameMatch = line.match(/^(\s*)- name:\s*(.+)/);
      if (!nameMatch) break;
      if (nameMatch[1].length !== baseIndent) break;

      const item = { name: nameMatch[2].trim() };
      pos++;

      const propIndent = baseIndent + 2;
      while (pos < lines.length) {
        const propLine = lines[pos];
        const pi = propLine.search(/\S/);
        if (pi !== propIndent) break;
        const trimmed = propLine.trim();

        if (trimmed.startsWith("- ")) break;

        const urlMatch = trimmed.match(/^url:\s*(.+)/);
        if (urlMatch) {
          item.url = urlMatch[1].trim();
          pos++;
          continue;
        }

        if (trimmed === "children:") {
          pos++;
          item.children = parseList(propIndent + 2);
          continue;
        }

        pos++;
      }

      items.push(item);
    }
    return items;
  }

  return parseList(0);
}

// ── Keyboard shortcuts ──────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editMode) { e.preventDefault(); saveEdits(); return; }
});

saveBtn.addEventListener("click", saveEdits);
cancelBtn.addEventListener("click", cancelEdits);


