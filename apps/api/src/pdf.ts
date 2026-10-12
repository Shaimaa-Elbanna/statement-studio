import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractMarkdown(buffer: Buffer) {
  const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 30) throw new Error('Please upload a statement of 30 pages or fewer.');
    const pages: string[] = [], scannedPages: number[] = [];
    let characters = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '', lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== null && Math.abs(lastY - y) > 3 && !text.endsWith('\n')) text += '\n';
        text += `${item.str}${item.hasEOL ? '\n' : '\t'}`;
        lastY = y;
      }
      characters += text.trim().length;
      if (text.replace(/\s/g, '').length < 30) scannedPages.push(n);
      pages.push(`## Page ${n}\n\n${text.trim() || '[No selectable text. Read original PDF page.]'}`);
      page.cleanup();
      if (characters > 180_000) throw new Error('Too much text for one analysis. Upload a shorter statement.');
    }
    return { markdown: pages.join('\n\n'), pageCount: pdf.numPages, textCharacters: characters, scannedPages };
  } finally { await task.destroy(); }
}
