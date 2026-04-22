/**
 * Plain text loader - splits text files into chunks.
 */

import fs from 'fs';
import path from 'path';
import { Chunk } from './base.js';
import { MAX_CHUNK_SIZE, MIN_CHUNK_SIZE } from '../config.js';

/**
 * Load a plain text file and split it into chunks.
 */
export function loadText(filePath, docType = 'rule') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const chunks = [];

  if (content.length <= MAX_CHUNK_SIZE) {
    chunks.push(new Chunk({
      content: content.trim(),
      sourceFile: filePath,
      docType,
      title: fileName,
    }));
    return chunks;
  }

  const paragraphs = content.split(/\n\s*\n/);
  let currentContent = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (currentContent.length + trimmed.length + 2 <= MAX_CHUNK_SIZE) {
      currentContent += (currentContent ? '\n\n' : '') + trimmed;
    } else {
      if (currentContent.length >= MIN_CHUNK_SIZE) {
        chunks.push(new Chunk({
          content: currentContent,
          sourceFile: filePath,
          docType,
          title: fileName,
        }));
      }
      currentContent = trimmed;
    }
  }

  if (currentContent.length >= MIN_CHUNK_SIZE) {
    chunks.push(new Chunk({
      content: currentContent,
      sourceFile: filePath,
      docType,
      title: fileName,
    }));
  }

  return chunks;
}

export default loadText;
