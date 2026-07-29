// Light/dark theming. CSS variables in style.css are the source of truth;
// this module reads them for canvas-rendered colors and dispatches a
// 'themechange' event so canvases re-draw when the user toggles.

export type ThemeMode = 'dark' | 'light';

export interface Palette {
  // Page / panel
  bg: string;
  bgPanel: string;
  bgCanvas: string;
  bgCanvasOuter: string;
  // Text
  textPrimary: string;
  textMuted: string;
  // Plot chrome
  plotBorder: string;
  gridLine: string;
  gridLineStrong: string;
  // Domain-specific
  colorUp: string;
  colorDn: string;
  colorEscape: string;
  // Horseshoe overlays
  d0Line: string;
  d1Line: string;
  pMarkerFill: string;
  pMarkerStroke: string;
}

const STORAGE_KEY = 'threebody-theme';

let current: ThemeMode = 'dark';

export function currentMode(): ThemeMode { return current; }

function readVar(cs: CSSStyleDeclaration, name: string): string {
  return cs.getPropertyValue(name).trim();
}

export function getPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  return {
    bg:              readVar(cs, '--bg'),
    bgPanel:         readVar(cs, '--bg-panel'),
    bgCanvas:        readVar(cs, '--bg-canvas'),
    bgCanvasOuter:   readVar(cs, '--bg-canvas-outer'),
    textPrimary:     readVar(cs, '--text-primary'),
    textMuted:       readVar(cs, '--text-muted'),
    plotBorder:      readVar(cs, '--plot-border'),
    gridLine:        readVar(cs, '--grid-line'),
    gridLineStrong:  readVar(cs, '--grid-line-strong'),
    colorUp:         readVar(cs, '--color-up'),
    colorDn:         readVar(cs, '--color-dn'),
    colorEscape:     readVar(cs, '--color-escape'),
    d0Line:          readVar(cs, '--d0-line'),
    d1Line:          readVar(cs, '--d1-line'),
    pMarkerFill:     readVar(cs, '--p-marker-fill'),
    pMarkerStroke:   readVar(cs, '--p-marker-stroke'),
  };
}

export function setMode(mode: ThemeMode): void {
  current = mode;
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function toggleMode(): void {
  setMode(current === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener('themechange', handler);
  return () => window.removeEventListener('themechange', handler);
}

// Read stored preference (or prefers-color-scheme) and apply it. Call this
// before the page constructs canvases so the initial render uses the right
// palette.
export function initTheme(): void {
  let mode: ThemeMode;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      mode = stored;
    } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      mode = 'light';
    } else {
      mode = 'dark';
    }
  } catch {
    mode = 'dark';
  }
  setMode(mode);
}

// Wires the toggle button in the shared .tab-bar. Idempotent.
export function mountThemeToggle(): void {
  const bar = document.querySelector('.tab-bar');
  if (!bar) return;
  if (bar.querySelector('.theme-toggle')) return;
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  bar.appendChild(spacer);
  const btn = document.createElement('button');
  btn.className = 'theme-toggle';
  btn.type = 'button';
  const sync = () => {
    btn.textContent = current === 'dark' ? '☼ Light' : '☾ Dark';
    btn.title = `Switch to ${current === 'dark' ? 'light' : 'dark'} mode`;
  };
  btn.addEventListener('click', () => { toggleMode(); sync(); });
  onThemeChange(sync);
  sync();
  bar.appendChild(btn);
}
