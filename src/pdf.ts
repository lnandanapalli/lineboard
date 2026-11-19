/**
 * A minimal PDF writer: one JPEG picture per page, filling the page width. Enough to share a note
 * as a PDF (which every device can open and send) without a library.
 */

const A4_W = 595.28; // points (1/72 inch)
const A4_H = 841.89;

/** Cut a tall page picture into A4-shaped pages and write them as a PDF. */
export async function canvasToPdf(page: HTMLCanvasElement, title: string): Promise<Blob> {
  const sliceH = Math.round((page.width * A4_H) / A4_W);
  const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
  for (let y = 0; y < page.height; y += sliceH) {
    const h = Math.min(sliceH, page.height - y);
    const c = document.createElement('canvas');
    c.width = page.width;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(page, 0, y, page.width, h, 0, 0, page.width, h);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not make the PDF'))), 'image/jpeg', 0.9));
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: c.width, h });
  }
  return writePdf(pages, title);
}

function writePdf(pages: { jpeg: Uint8Array; w: number; h: number }[], title: string): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(bytes);
    size += bytes.length;
  };
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, contents, image.
  const n = pages.length;
  const pageObj = (i: number) => 4 + i * 3;
  const obj = (id: number, body: string | (() => void)) => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else body();
    push('\nendobj\n');
  };
  // PDF text strings: only printable ASCII kept, with ( ) \ escaped.
  // Cut to length first, so an escape is never split in two (which would leave the string open).
  const pdfText = (s: string) => s.slice(0, 200).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => '\\' + c);

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title (${pdfText(title)}) /Producer (Lineboard) >>`);
  pages.forEach((p, i) => {
    const id = pageObj(i);
    const h = (p.h * A4_W) / p.w; // the last page may be shorter: keep its proportions
    const ph = i === n - 1 ? Math.max(h, 1) : A4_H;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const draw = `q ${A4_W} 0 0 ${ph.toFixed(2)} 0 ${(A4_H - ph).toFixed(2)} cm /Im0 Do Q`;
    obj(id + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const total = 4 + n * 3;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
