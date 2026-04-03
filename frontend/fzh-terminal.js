// ── fzh WASM terminal integration ──────────────────────────────
// Loads the fzh (fuzzy hierarchical) WASM binary, parses ANSI output,
// and renders it into a <pre> element. Keyboard events are forwarded
// to the Go TUI session; the JS side is stateless.

// ── ANSI palette → CSS (Catppuccin Mocha) ──────────────────────
const PALETTE = [
  "#1e1e2e", // 0  black   (base)
  "#f38ba8", // 1  red
  "#a6e3a1", // 2  green
  "#f9e2af", // 3  yellow
  "#89b4fa", // 4  blue
  "#cba6f7", // 5  magenta
  "#94e2d5", // 6  cyan
  "#bac2de", // 7  silver  (subtext1)
  "#585b70", // 8  gray    (overlay0)
  "#f38ba8", // 9  bright red
  "#a6e3a1", // 10 bright green
  "#f9e2af", // 11 bright yellow
  "#89b4fa", // 12 bright blue
  "#cba6f7", // 13 bright magenta
  "#94e2d5", // 14 bright cyan
  "#cdd6f4", // 15 bright white (text)
];

// ── ANSI parser ────────────────────────────────────────────────
// Parses ANSI-escaped text into a 2D grid of styled cells.
function parseANSI(ansi) {
  const rows = ansi.split("\n");
  const grid = [];

  for (const row of rows) {
    const cells = [];
    let fg = null;
    let bg = null;
    let bold = false;
    let italic = false;
    let dim = false;
    let underline = false;

    let i = 0;
    while (i < row.length) {
      if (row[i] === "\x1b" && row[i + 1] === "[") {
        let j = i + 2;
        while (j < row.length && row[j] !== "m") j++;
        if (j < row.length) {
          const params = row.slice(i + 2, j).split(";").map(Number);
          let p = 0;
          while (p < params.length) {
            const n = params[p];
            if (n === 0) {
              fg = null; bg = null;
              bold = false; italic = false; dim = false; underline = false;
            } else if (n === 1) { bold = true; }
            else if (n === 2) { dim = true; }
            else if (n === 3) { italic = true; }
            else if (n === 4) { underline = true; }
            else if (n === 22) { bold = false; dim = false; }
            else if (n === 23) { italic = false; }
            else if (n === 24) { underline = false; }
            else if (n >= 30 && n <= 37) { fg = PALETTE[n - 30]; }
            else if (n === 39) { fg = null; }
            else if (n >= 40 && n <= 47) { bg = PALETTE[n - 40]; }
            else if (n === 49) { bg = null; }
            else if (n >= 90 && n <= 97) { fg = PALETTE[n - 90 + 8]; }
            else if (n >= 100 && n <= 107) { bg = PALETTE[n - 100 + 8]; }
            else if (n === 38) {
              if (params[p + 1] === 5) {
                fg = palette256(params[p + 2]);
                p += 2;
              } else if (params[p + 1] === 2) {
                fg = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`;
                p += 4;
              }
            } else if (n === 48) {
              if (params[p + 1] === 5) {
                bg = palette256(params[p + 2]);
                p += 2;
              } else if (params[p + 1] === 2) {
                bg = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`;
                p += 4;
              }
            }
            p++;
          }
          i = j + 1;
          continue;
        }
      }
      const cp = row.codePointAt(i);
      const char = String.fromCodePoint(cp);
      const wide = cp > 0xFFFF || (cp >= 0xE000 && cp <= 0xF8FF);
      cells.push({ char, fg, bg, bold, italic, dim, underline, wide });
      i += char.length;
    }
    for (let j = 0; j < cells.length; j++) {
      if (cells[j].wide && j + 1 < cells.length && cells[j + 1].char === " ") {
        cells[j + 1].widePad = true;
      }
    }
    grid.push(cells);
  }
  return grid;
}

// 256-color palette → CSS color
function palette256(n) {
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    n -= 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// ── Grid renderer ──────────────────────────────────────────────
// Renders parsed ANSI grid into styled <span> elements inside a <pre>.
function renderGrid(grid, cursorX, cursorY, container) {
  const frag = document.createDocumentFragment();

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    const rowDiv = document.createElement("div");
    let lastBg = null;
    let i = 0;
    while (i < row.length) {
      const start = i;
      const cell = row[i];
      const isCursorCell = (y === cursorY && i === cursorX);

      i++;

      if (cell.wide && i < row.length && row[i].widePad) {
        i++;
      } else if (!isCursorCell && !cell.wide) {
        while (
          i < row.length &&
          !row[i].wide &&
          !row[i].widePad &&
          row[i].fg === cell.fg &&
          row[i].bg === cell.bg &&
          row[i].bold === cell.bold &&
          row[i].italic === cell.italic &&
          row[i].dim === cell.dim &&
          row[i].underline === cell.underline &&
          !(y === cursorY && i === cursorX)
        ) {
          i++;
        }
      }

      const span = document.createElement("span");
      let text = "";
      for (let j = start; j < i; j++) {
        text += row[j].char;
      }
      span.textContent = text;

      const styles = [];
      if (cell.fg) styles.push(`color:${cell.fg}`);
      if (cell.bg) styles.push(`background:${cell.bg}`);
      if (cell.bold) styles.push("font-weight:bold");
      if (cell.italic) styles.push("font-style:italic");
      if (cell.dim) styles.push("opacity:0.6");
      if (cell.underline) styles.push("text-decoration:underline");
      if (cell.wide) styles.push("display:inline-block;width:calc(2 * var(--char-w));overflow:hidden;text-align:center;font-family:'Symbols Nerd Font Mono','Cascadia Code',monospace;vertical-align:bottom;line-height:1.2");

      if (isCursorCell) {
        styles.push("background:#cdd6f4");
        styles.push("color:#1e1e2e");
        span.className = "fzh-cursor";
        lastBg = "#cdd6f4";
      } else {
        lastBg = cell.bg;
      }

      if (styles.length > 0) {
        span.setAttribute("style", styles.join(";"));
      }
      rowDiv.appendChild(span);
    }
    if (lastBg) {
      rowDiv.style.background = lastBg;
    }
    frag.appendChild(rowDiv);
  }

  container.innerHTML = "";
  container.appendChild(frag);
}

// ── Font metrics ───────────────────────────────────────────────
let cachedCharSize = null;

function measureChar() {
  if (cachedCharSize) return cachedCharSize;

  const probe = document.createElement("pre");
  probe.style.cssText =
    "position:absolute;left:-9999px;top:-9999px;white-space:pre;" +
    'font-family:"Cascadia Code","Fira Code","JetBrains Mono","Consolas",monospace;font-size:16px;line-height:1.2;' +
    "padding:0;margin:0;border:0";
  probe.textContent = "MMMMMMMMMM";
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  document.body.removeChild(probe);

  const w = rect.width / 10;
  const h = rect.height;

  if (w >= 4 && h >= 8) {
    cachedCharSize = { w, h };
    document.documentElement.style.setProperty("--char-w", w + "px");
    return cachedCharSize;
  }
  return { w: 9.6, h: 19.2 };
}

function computeGridSize(container) {
  const rect = container.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) {
    return { cols: 80, rows: 24 };
  }
  const char = measureChar();
  // Subtract padding (8px each side)
  const usable_w = rect.width - 16;
  const usable_h = rect.height - 16;
  const cols = Math.min(Math.max(Math.floor(usable_w / char.w), 20), 250);
  const rows = Math.min(Math.max(Math.floor(usable_h / char.h), 5), 80);
  return { cols, rows };
}

// ── Keyboard forwarding ────────────────────────────────────────
let _editMode = false;

function shouldForwardKey(e) {
  if (_editMode) return false;
  if (document.activeElement && document.activeElement.matches("input, textarea, select")) return false;
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return true;
  if (e.ctrlKey && "aAeEuUwWpPnNcC".includes(e.key)) return true;
  const special = [
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Enter", "Escape", "Backspace", "Delete", "Tab", "Home", "End",
  ];
  return special.includes(e.key);
}

// ── State ──────────────────────────────────────────────────────
let _container = null;
let _ready = false;
let _sessionActive = false;
let _rendering = false;
let _lastGridSize = null;

function renderFrame(result) {
  if (!result || result instanceof Error) return;
  if (_rendering) return;
  _rendering = true;
  try {
    const grid = parseANSI(result.ansi);
    let cx = result.cursorX;
    let cy = result.cursorY;
    if (cx < 0 || cy < 0) {
      cx = 3;
      cy = 1;
    }
    renderGrid(grid, cx, cy, _container);
  } finally {
    _rendering = false;
  }
}

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

// ── URL helper ─────────────────────────────────────────────────
function ensureAbsoluteUrl(url) {
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return "https://" + url;
  return url;
}

// ── Public API ─────────────────────────────────────────────────

export async function initFzhTerminal(containerEl) {
  _container = containerEl;
  _container.textContent = "Loading fzt...";

  await document.fonts.ready;
  measureChar();

  const go = new Go();
  const result = await WebAssembly.instantiateStreaming(
    fetch("fzt.wasm"),
    go.importObject
  );
  go.run(result.instance);
  _ready = true;
  _container.textContent = "Ready. Waiting for bookmarks...";

  // Keyboard listener
  document.addEventListener("keydown", (e) => {
    if (!_sessionActive) return;
    if (!shouldForwardKey(e)) return;
    e.preventDefault();

    try {
      const result = fzt.handleKey(e.key, e.ctrlKey, e.shiftKey);
      if (result instanceof Error) {
        console.error("fzt.handleKey error:", result.message);
        return;
      }
      renderFrame(result);
      if (result.action && result.action.startsWith("select:") && result.url) {
        window.location.href = ensureAbsoluteUrl(result.url);
      }
    } catch (err) {
      console.error("handleKey threw:", err);
    }
  });

  // ResizeObserver
  const ro = new ResizeObserver(() => {
    if (!_sessionActive) return;
    try {
      const { cols, rows } = computeGridSize(_container);
      const key = cols + "x" + rows;
      if (key === _lastGridSize) return;
      _lastGridSize = key;
      const result = fzt.resize(cols, rows);
      if (result instanceof Error) {
        console.error("fzt.resize error:", result.message);
        return;
      }
      renderFrame(result);
    } catch (err) {
      console.error("resize threw:", err);
    }
  });
  ro.observe(_container);
}

export function loadBookmarks(bookmarks) {
  if (!_ready) return;
  if (!bookmarks || bookmarks.length === 0) {
    _container.textContent = "No bookmarks to display.";
    _sessionActive = false;
    return;
  }

  const yaml = bookmarksToYaml(bookmarks);
  const loadResult = fzt.loadYAML(yaml);
  if (loadResult instanceof Error) {
    console.error("fzt.loadYAML error:", loadResult.message);
    _container.textContent = "Error loading bookmarks: " + loadResult.message;
    return;
  }

  const { cols, rows } = computeGridSize(_container);
  _lastGridSize = cols + "x" + rows;
  const result = fzt.init(cols, rows);
  if (result instanceof Error) {
    console.error("fzt.init error:", result.message);
    _container.textContent = "Error initializing terminal: " + result.message;
    return;
  }

  _sessionActive = true;
  renderFrame(result);
}

export function setEditMode(val) {
  _editMode = val;
}

export function isTerminalReady() {
  return _ready;
}
