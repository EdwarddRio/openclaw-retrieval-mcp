/**
 * Code loader - chunks code files by definitions.
 */

import fs from 'fs';
import path from 'path';
import { Chunk } from './base.js';
import { CODE_EXTENSION_TO_LANG, MAX_CHUNK_SIZE } from '../config.js';

/**
 * Load a code file and split it into chunks by top-level definitions.
 */
export function loadCode(filePath, docType = 'code') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  const language = CODE_EXTENSION_TO_LANG[ext] || '';
  const fileName = path.basename(filePath);
  const chunks = [];

  const symbols = extractSymbols(content, language);

  const definitionPatterns = getDefinitionPatterns(language);
  const lines = content.split('\n');

  let currentChunk = [];
  let currentTitle = fileName;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isDefinitionStart = definitionPatterns.some(p => p.test(line));

    if (isDefinitionStart && currentChunk.length > 0) {
      const chunkContent = currentChunk.join('\n').trim();
      if (chunkContent.length > 0) {
        chunks.push(new Chunk({
          content: chunkContent,
          sourceFile: filePath,
          docType,
          title: currentTitle,
          language,
          symbols: symbols.filter(s => chunkContent.includes(s)),
        }));
      }
      currentChunk = [];
      currentTitle = extractTitleFromLine(line, language) || fileName;
    }

    currentChunk.push(line);

    if (currentChunk.join('\n').length > MAX_CHUNK_SIZE) {
      const chunkContent = currentChunk.join('\n').trim();
      chunks.push(new Chunk({
        content: chunkContent,
        sourceFile: filePath,
        docType,
        title: currentTitle,
        language,
        symbols: symbols.filter(s => chunkContent.includes(s)),
      }));
      currentChunk = [];
      currentTitle = fileName;
    }
  }

  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join('\n').trim();
    if (chunkContent.length > 0) {
      chunks.push(new Chunk({
        content: chunkContent,
        sourceFile: filePath,
        docType,
        title: currentTitle,
        language,
        symbols: symbols.filter(s => chunkContent.includes(s)),
      }));
    }
  }

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push(new Chunk({
      content: content.trim(),
      sourceFile: filePath,
      docType,
      title: fileName,
      language,
      symbols,
    }));
  }

  return chunks;
}

function getDefinitionPatterns(language) {
  return [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/,
    /^\s*(?:export\s+)?class\s+\w+/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*[=:]\s*(?:async\s*)?\(/,
    /^\s*def\s+\w+/,
    /^\s*class\s+\w+/,
    /^\s*(?:public|private|protected|static)?\s*(?:async\s+)?\w+\s+\w+\s*\(/,
    /^\s*func\s+\w+/,
    /^\s*(?:impl|trait|fn)\s+\w+/,
  ];
}

function extractSymbols(content, language) {
  const symbols = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /def\s+(\w+)/g,
    /class\s+(\w+)/g,
    /func\s+(\w+)/g,
    /fn\s+(\w+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!symbols.includes(match[1])) symbols.push(match[1]);
    }
  }

  return symbols;
}

function extractTitleFromLine(line, language) {
  const match = line.match(/(?:function|class|def|func|fn)\s+(\w+)/);
  return match ? match[1] : null;
}

export default loadCode;
