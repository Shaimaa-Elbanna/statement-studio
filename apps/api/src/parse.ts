import path from 'node:path';
import { statementSchema, type ParsedStatement, type ParseProgress } from '@statement/shared';
import { readUpload, readParsedStatement } from './storage.js';
import { extractStatement } from './extract.js';
import { parsePdfChunks, writeJsonAtomic } from './chunks.js';

export async function parseSavedPdf(id: string, root?: string, extractor = extractStatement, onProgress?: (progress: ParseProgress) => Promise<void>): Promise<ParsedStatement> {
  try {
    const cached = await readParsedStatement(id, root);
    return { upload: cached.upload, statement: cached.statement };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const saved = await readUpload(id, root);
  const statement = statementSchema.parse(await parsePdfChunks(saved.pdf, saved.markdown, saved.dir, extractor, onProgress));
  await writeJsonAtomic(path.join(saved.dir, 'statement.json'), statement);
  return { upload: saved.upload, statement };
}
