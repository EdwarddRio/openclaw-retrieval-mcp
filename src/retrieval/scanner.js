/**
 * File scanner - discovers files and dispatches to appropriate loaders.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CODE_EXTENSION_TO_LANG,
  CODE_LOAD_SLOW_THRESHOLD_MS,
  DOC_EXTENSIONS,
  IGNORE_DIRS,
  INDEX_COLLECTIONS,
  PROJECT_ROOT,
} from '../config.js';
import { loadMarkdown } from '../loaders/markdown-loader.js';
import { loadText } from '../loaders/text-loader.js';
import { loadCode } from '../loaders/code-loader.js';

const DOC_SUFFIXES = DOC_EXTENSIONS;
const STRUCTURED_DOC_SUFFIXES = new Set(['.md', '.mdc']);
const PLAIN_TEXT_SUFFIXES = new Set(['.txt']);

export class ScanTarget {
  constructor(sourceFile, loaderType, docType, collection) {
    this.sourceFile = sourceFile;
    this.loaderType = loaderType;
    this.docType = docType;
    this.collection = collection;
  }

  toJSON() {
    return {
      sourceFile: this.sourceFile,
      loaderType: this.loaderType,
      docType: this.docType,
      collection: this.collection,
    };
  }
}

export class ScanReport {
  constructor() {
    this.scannedFileCount = 0;
    this.chunkCount = 0;
    this.skippedFileCount = 0;
    this.timeoutFileCount = 0;
    this.skippedFiles = [];
    this.timeoutFiles = [];
    this.slowFiles = [];
  }

  merge(other) {
    this.scannedFileCount += other.scannedFileCount;
    this.chunkCount += other.chunkCount;
    this.skippedFileCount += other.skippedFileCount;
    this.timeoutFileCount += other.timeoutFileCount;
    this.skippedFiles.push(...other.skippedFiles);
    this.timeoutFiles.push(...other.timeoutFiles);
    this.slowFiles.push(...other.slowFiles);
  }
}

export function eagerCollections() {
  return Object.entries(INDEX_COLLECTIONS)
    .filter(([, cfg]) => !cfg.lazy)
    .map(([name]) => name);
}

export function iterTargets(collectionNames = null) {
  const selected = new Set(collectionNames || Object.keys(INDEX_COLLECTIONS));
  const targets = [];

  for (const [collection, cfg] of Object.entries(INDEX_COLLECTIONS)) {
    if (!selected.has(collection)) continue;
    const sources = cfg.sources || {};
    for (const [loaderType, relPaths] of Object.entries(sources)) {
      for (const rel of relPaths) {
        targets.push(...expandPath(collection, loaderType, rel));
      }
    }
  }

  return targets.sort((a, b) => {
    if (a.collection !== b.collection) return a.collection.localeCompare(b.collection);
    return a.sourceFile.localeCompare(b.sourceFile);
  });
}

export function scanCollection(collectionName) {
  const [chunks] = scanCollectionWithReport(collectionName);
  return chunks;
}

export function scanCollectionWithReport(collectionName) {
  return scanAllWithReport([collectionName]);
}

export function scanAll(collectionNames = null) {
  const [chunks] = scanAllWithReport(collectionNames);
  return chunks;
}

export function scanAllWithReport(collectionNames = null) {
  const chunks = [];
  const report = new ScanReport();

  for (const target of iterTargets(collectionNames)) {
    const [targetChunks, targetReport] = loadTargetWithReport(target);
    chunks.push(...targetChunks);
    report.merge(targetReport);
  }

  report.chunkCount = chunks.length;
  console.log(
    `Scanned ${chunks.length} total chunks files=${report.scannedFileCount} ` +
    `skipped=${report.skippedFileCount} timeouts=${report.timeoutFileCount} ` +
    `slow=${report.slowFiles.length}`
  );

  return [chunks, report];
}

export function scanByCollection(collectionNames = null) {
  const grouped = {};
  for (const target of iterTargets(collectionNames)) {
    if (!grouped[target.collection]) grouped[target.collection] = [];
    grouped[target.collection].push(...loadTarget(target));
  }
  return grouped;
}

export function loadTarget(target) {
  const [chunks] = loadTargetWithReport(target);
  return chunks;
}

export function loadTargetWithReport(target) {
  const report = new ScanReport();
  report.scannedFileCount = 1;
  const startedAt = performance.now();

  const loader = resolveLoader(target.loaderType);
  const args = loaderArgs(target);

  let rawChunks = [];
  try {
    rawChunks = callLoader(loader, target, args);
  } catch (err) {
    if (err.name === 'TimeoutError') {
      report.timeoutFileCount += 1;
      report.timeoutFiles.push(target.sourceFile);
      console.warn(`Timeout loading ${target.sourceFile}: ${err.message}`);
    } else {
      report.skippedFileCount += 1;
      report.skippedFiles.push({ sourceFile: target.sourceFile, error: err.message });
      console.warn(`Error loading ${target.sourceFile}: ${err.message}`);
    }
    return [[], report];
  }

  const decorated = [];
  for (let index = 0; index < rawChunks.length; index++) {
    const chunk = rawChunks[index];
    chunk.collection = target.collection;
    chunk.chunkId = stableChunkId(target, chunk.title, index);
    decorated.push(chunk);
  }

  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs >= CODE_LOAD_SLOW_THRESHOLD_MS) {
    report.slowFiles.push({ sourceFile: target.sourceFile, elapsedMs: Math.round(elapsedMs) });
  }
  report.chunkCount = decorated.length;

  return [decorated, report];
}

// ========== Path Expansion ==========

function expandPath(collection, loaderType, relPath) {
  const fullPath = path.resolve(PROJECT_ROOT, relPath);

  if (loaderType === 'markdown') {
    return expandMarkdown(collection, fullPath);
  }
  if (loaderType === 'code') {
    return expandCode(collection, fullPath);
  }

  return [];
}

function expandMarkdown(collection, fullPath) {
  const targets = [];

  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = walkDir(fullPath);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (STRUCTURED_DOC_SUFFIXES.has(ext)) {
          targets.push(new ScanTarget(file, 'markdown', markdownDocType(file), collection));
        } else if (PLAIN_TEXT_SUFFIXES.has(ext)) {
          targets.push(new ScanTarget(file, 'text', markdownDocType(file), collection));
        }
      }
    } else {
      const ext = path.extname(fullPath).toLowerCase();
      if (STRUCTURED_DOC_SUFFIXES.has(ext)) {
        targets.push(new ScanTarget(fullPath, 'markdown', markdownDocType(fullPath), collection));
      } else if (PLAIN_TEXT_SUFFIXES.has(ext)) {
        targets.push(new ScanTarget(fullPath, 'text', markdownDocType(fullPath), collection));
      }
    }
  }

  return targets;
}

function expandCode(collection, fullPath) {
  const targets = [];

  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const files = walkDir(fullPath);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (CODE_EXTENSION_TO_LANG[ext]) {
          const lang = CODE_EXTENSION_TO_LANG[ext];
          const loaderType = lang === 'java' ? 'java' : 'code';
          targets.push(new ScanTarget(file, loaderType, lang, collection));
        }
      }
    } else {
      const ext = path.extname(fullPath).toLowerCase();
      if (CODE_EXTENSION_TO_LANG[ext]) {
        const lang = CODE_EXTENSION_TO_LANG[ext];
        const loaderType = lang === 'java' ? 'java' : 'code';
        targets.push(new ScanTarget(fullPath, loaderType, lang, collection));
      }
    }
  }

  return targets;
}

function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function markdownDocType(filePath) {
  return filePath.includes('mds') ? 'design' : 'rule';
}

// ========== Loader Dispatch ==========

function loaderArgs(target) {
  if (target.loaderType === 'markdown' || target.loaderType === 'text') {
    return [target.sourceFile, target.docType];
  }
  if (target.loaderType === 'code' || target.loaderType === 'java') {
    return [target.sourceFile, target.docType];
  }
  return [target.sourceFile];
}

function resolveLoader(loaderType) {
  const mapping = {
    markdown: loadMarkdown,
    text: loadText,
    code: loadCode,
    java: loadCode,
  };
  return mapping[loaderType];
}

function callLoader(loaderFn, target, args) {
  return loaderFn(...args);
}

function stableChunkId(target, title, index) {
  const payload = `${target.collection}|${target.docType}|${target.sourceFile}|${title}|${index}`;
  return crypto.createHash('sha1').update(payload, 'utf-8').digest('hex');
}

export default {
  ScanTarget,
  ScanReport,
  eagerCollections,
  iterTargets,
  scanCollection,
  scanCollectionWithReport,
  scanAll,
  scanAllWithReport,
  scanByCollection,
  loadTarget,
  loadTargetWithReport,
};
