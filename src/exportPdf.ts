// In-app "Export PDF" button. Captures the registered canvases via
// canvas.toDataURL('image/png') and embeds each on its own PDF page
// (US Letter, landscape, image scaled to fit with margin and a header
// label). The page's entry calls registerExport() with a getter that
// returns the panels in display order, and mountExportButton() places
// the button in the shared tab bar.
//
// jsPDF is lazy-imported on the first click so it doesn't bloat the
// initial page load.

export interface ExportPanel {
  canvas: HTMLCanvasElement;
  label?: string;
}

let panelProvider: (() => ExportPanel[]) | null = null;
let filenameStem = 'figure';

export function registerExport(getPanels: () => ExportPanel[], filename: string): void {
  panelProvider = getPanels;
  filenameStem = filename;
}

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeDataUrl(canvas: HTMLCanvasElement): string | null {
  // WebGL canvases need preserveDrawingBuffer:true at context creation time
  // for toDataURL to return a populated image. The plain 2D canvases we use
  // always work.
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export async function exportPdf(): Promise<void> {
  if (!panelProvider) return;
  const panels = panelProvider().filter((p) => p.canvas.width > 0 && p.canvas.height > 0);
  if (panels.length === 0) return;

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const pageW = pdf.internal.pageSize.getWidth();   // 792 pt
  const pageH = pdf.internal.pageSize.getHeight();  // 612 pt
  const margin = 36;
  const labelGap = 18;

  panels.forEach((p, i) => {
    if (i > 0) pdf.addPage();
    const data = safeDataUrl(p.canvas);
    if (!data) return;
    const cw = p.canvas.width;
    const ch = p.canvas.height;
    const availW = pageW - 2 * margin;
    const availH = pageH - 2 * margin - (p.label ? labelGap : 0);
    const scale = Math.min(availW / cw, availH / ch);
    const w = cw * scale;
    const h = ch * scale;
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2 + (p.label ? labelGap / 2 : 0);
    if (p.label) {
      pdf.setFontSize(11);
      pdf.text(p.label, pageW / 2, margin + 9, { align: 'center' });
    }
    pdf.addImage(data, 'PNG', x, y, w, h);
  });

  pdf.save(`${filenameStem}-${dateStamp()}.pdf`);
}

export function mountExportButton(): void {
  const bar = document.querySelector('.tab-bar');
  if (!bar) return;
  if (bar.querySelector('.export-pdf')) return;
  const btn = document.createElement('button');
  btn.className = 'export-pdf';
  btn.type = 'button';
  btn.textContent = '⬇ PDF';
  btn.title = 'Export panels as PDF';
  btn.addEventListener('click', () => { void exportPdf(); });
  const toggle = bar.querySelector('.theme-toggle');
  if (toggle) bar.insertBefore(btn, toggle);
  else bar.appendChild(btn);
}
