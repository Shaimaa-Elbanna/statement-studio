import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { statementSchema, type ParsedStatement, type Upload } from '@statement/shared';
import { extractMarkdown } from './pdf.js';

export const storageRoot = fileURLToPath(new URL('../storage/', import.meta.url));
export function uploadDirectory(id: string, root = storageRoot) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid upload ID.');
  return path.join(root, id);
}
export async function saveUpload(buffer: Buffer, filename: string, root = storageRoot): Promise<Upload> {
  // Parse before persistence so invalid/encrypted/oversized documents leave no saved files.
  const extracted = await extractMarkdown(buffer);
  const upload: Upload = { id: randomUUID(), filename: path.basename(filename).slice(0, 150), pageCount: extracted.pageCount, textCharacters: extracted.textCharacters, scannedPages: extracted.scannedPages };
  const dir = uploadDirectory(upload.id, root);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'statement.pdf'), buffer);
  await writeFile(path.join(dir, 'statement.md'), extracted.markdown, 'utf8');
  await writeFile(path.join(dir, 'upload.json'), JSON.stringify(upload, null, 2), 'utf8');
  return upload;
}
export async function readUpload(id: string, root = storageRoot) {
  const dir = uploadDirectory(id, root);
  const upload = JSON.parse(await readFile(path.join(dir, 'upload.json'), 'utf8')) as Upload;
  const markdown = await readFile(path.join(dir, 'statement.md'), 'utf8');
  const pdf = await readFile(path.join(dir, 'statement.pdf'));
  return { upload, markdown, pdf, dir };
}
// This reader deliberately does not load the original PDF or Markdown.
export async function readParsedStatement(id: string, root = storageRoot): Promise<ParsedStatement & { dir: string }> {
  const dir = uploadDirectory(id, root);
  const upload = JSON.parse(await readFile(path.join(dir, 'upload.json'), 'utf8')) as Upload;
  const statement = statementSchema.parse(JSON.parse(await readFile(path.join(dir, 'statement.json'), 'utf8')));
  return { upload, statement, dir };
}
