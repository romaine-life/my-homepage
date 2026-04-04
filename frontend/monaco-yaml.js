const MONACO_VERSION = '0.50.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;

let monacoPromise = null;

function loadMonaco() {
  if (monacoPromise) return monacoPromise;

  monacoPromise = new Promise((resolve) => {
    self.MonacoEnvironment = {
      getWorkerUrl() {
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment = { baseUrl: '${CDN_BASE}/../' };
          importScripts('${CDN_BASE}/base/worker/workerMain.js');
        `)}`;
      }
    };

    require.config({ paths: { vs: CDN_BASE } });
    require(['vs/editor/editor.main'], function () {
      monaco.editor.defineTheme('catppuccin-mocha', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'type', foreground: '89b4fa' },
          { token: 'string', foreground: 'a6e3a1' },
          { token: 'number', foreground: 'fab387' },
          { token: 'keyword', foreground: 'cba6f7' },
          { token: 'comment', foreground: '6c7086' },
          { token: 'tag', foreground: 'f9e2af' },
        ],
        colors: {
          'editor.background': '#181825',
          'editor.foreground': '#cdd6f4',
          'editor.lineHighlightBackground': '#31324480',
          'editor.selectionBackground': '#45475a',
          'editorCursor.foreground': '#f5e0dc',
          'editorLineNumber.foreground': '#6c7086',
          'editorLineNumber.activeForeground': '#cdd6f4',
          'editorGutter.background': '#181825',
          'editorWidget.background': '#313244',
          'editorWidget.foreground': '#cdd6f4',
          'input.background': '#313244',
          'input.foreground': '#cdd6f4',
          'input.border': '#45475a',
          'focusBorder': '#89b4fa',
          'scrollbarSlider.background': '#45475a80',
          'scrollbarSlider.hoverBackground': '#585b70',
          'scrollbarSlider.activeBackground': '#6c7086',
        },
      });
      resolve(monaco);
    });
  });

  return monacoPromise;
}

// Start loading immediately on import
loadMonaco();

export async function createYamlEditor(parent, initialValue, onChange) {
  const m = await loadMonaco();

  const editor = m.editor.create(parent, {
    value: initialValue,
    language: 'yaml',
    theme: 'catppuccin-mocha',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    fontSize: 16,
    lineHeight: 19,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    wordWrap: 'on',
    lineNumbers: 'on',
    renderLineHighlight: 'line',
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    glyphMargin: false,
    folding: true,
    lineDecorationsWidth: 8,
    lineNumbersMinChars: 3,
  });

  editor.onDidChangeModelContent(() => {
    if (onChange) onChange(editor.getValue());
  });

  return {
    getValue: () => editor.getValue(),
    destroy: () => editor.dispose(),
  };
}
