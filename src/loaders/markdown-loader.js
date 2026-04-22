/**
 * Markdown loader - chunks markdown files by headings.
 */

import fs from 'fs';
import path from 'path';
import { Chunk } from './base.js';

/**
 * Load a markdown file and split it into chunks by headings.
 */
export function loadMarkdown(filePath, docType = 'rule') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const chunks = [];
  let currentHeading = '';
  let currentContent = [];
  let headingPath = '';
  const fileName = path.basename(filePath);

  function flushChunk() {
    if (currentContent.length > 0) {
      const chunkContent = currentContent.join('\n').trim();
      if (chunkContent.length > 0) {
        chunks.push(new Chunk({
          content: chunkContent,
          sourceFile: filePath,
          docType,
          title: currentHeading || fileName,
          headingPath,
        }));
      }
      currentContent = [];
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushChunk();
      currentHeading = headingMatch[2].trim();
      const level = headingMatch[1].length;
      const pathParts = headingPath.split(' > ').filter(Boolean);
      while (pathParts.length >= level) {
        pathParts.pop();
      }
      pathParts.push(currentHeading);
      headingPath = pathParts.join(' > ');
    } else {
      currentContent.push(line);
    }
  }

  flushChunk();

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push(new Chunk({
      content: content.trim(),
      sourceFile: filePath,
      docType,
      title: fileName,
    }));
  }

  return chunks;
}

export default loadMarkdown;
