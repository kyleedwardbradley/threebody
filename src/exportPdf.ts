// Per-panel "Export PDF" button. Each panel's container gets a small
// floating button in its top-right corner; clicking it exports just
// that panel as a one-page PDF (US Letter, landscape, image scaled to
// fit with margin and a header label).
//
// jsPDF is dynamic-imported on the first click so it doesn't bloat
// the initial page load.

export interface PanelExportConfig {
  // The container element that holds the canvas. Must be position:
  // relative (or absolute) so the floating button lays out correctly.
  container: HTMLElement;
  // Resolves the canvas to capture at the moment of export. A function
  // (not a static ref) so callers can re-render before snapshot — e.g.
  // View3D.getCanvas() forces a WebGL render so toDataURL is populated.
  getCanvas: () => HTMLCanvasElement;
  // Human-readable header printed at the top of the PDF page.
  label: string;
  // Filename stem (no extension). The current date-time is appended.
  filename: string;
}

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
       + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function exportPanel(cfg: PanelExportConfig): Promise<void> {
  const canvas = cfg.getCanvas();
  if (canvas.width === 0 || canvas.height === 0) return;
  let data: string;
  try { data = canvas.toDataURL('image/png'); } catch { return; }

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const labelGap = 18;

  const cw = canvas.width;
  const ch = canvas.height;
  const availW = pageW - 2 * margin;
  const availH = pageH - 2 * margin - labelGap;
  const scale = Math.min(availW / cw, availH / ch);
  const w = cw * scale;
  const h = ch * scale;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2 + labelGap / 2;

  pdf.setFontSize(11);
  pdf.text(cfg.label, pageW / 2, margin + 9, { align: 'center' });
  pdf.addImage(data, 'PNG', x, y, w, h);
  pdf.save(`${cfg.filename}-${dateStamp()}.pdf`);
}

export function mountPanelExport(cfg: PanelExportConfig): void {
  if (cfg.container.querySelector(':scope > .panel-export-pdf')) return;
  const btn = document.createElement('button');
  btn.className = 'panel-export-pdf';
  btn.type = 'button';
  btn.textContent = '⬇ PDF';
  btn.title = `Export "${cfg.label}" as PDF`;
  btn.addEventListener('click', () => { void exportPanel(cfg); });
  cfg.container.appendChild(btn);
}
