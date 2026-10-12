import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Analysis, ParsedStatement } from '@statement/shared';
import { categorizeStatement, unknownClassifications } from './categorize.js';
import { analyze } from './analyze.js';
import { describeAnalysisError } from './errors.js';

// The AI analysis step accepts normalized JSON only; it has no PDF parser or PDF input.
export async function analyzeStatementJson(parsed: ParsedStatement, dir: string, categorizer = categorizeStatement): Promise<Analysis> {
  let classifications = unknownClassifications(parsed.statement);
  let failureMessage: string | null = null;
  try { classifications = await categorizer(parsed.statement); }
  catch (error) {
    const failure = describeAnalysisError(error);
    console.error('Statement categorization failed', failure.diagnostic);
    failureMessage = failure.message;
  }
  let result: Analysis;
  try { result = analyze(parsed.statement, parsed.upload, classifications); }
  catch { result = analyze(parsed.statement, parsed.upload); failureMessage = 'The category output was incomplete or invalid.'; }
  if (failureMessage) result.spending.issues.unshift(`Categorization was unavailable. ${failureMessage} Parsed JSON is preserved; assign categories manually or retry analysis.`);
  await writeFile(path.join(dir, 'classifications.json'), JSON.stringify(result.classifications, null, 2), 'utf8');
  await writeFile(path.join(dir, 'analysis.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}
