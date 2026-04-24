/**
 * Wiki manifest - tracks raw source file changes for incremental compilation.
 * Uses SHA256 hash to detect modifications.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../config.js';

export class WikiManifest {
  constructor(manifestPath) {
    this._path = manifestPath;
    this._data = { files: {} };
  }

  load() {
    if (fs.existsSync(this._path)) {
      try {
        this._data = JSON.parse(fs.readFileSync(this._path, 'utf-8'));
        if (!this._data.files) this._data.files = {};
      } catch (err) {
        logger.warn(`Wiki manifest load failed: ${err.message}`);
        this._data = { files: {} };
      }
    }
  }

  save() {
    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf-8');
  }

  /**
   * Compute SHA256 hash of a file's content.
   */
  static fileHash(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Detect changes: compare current file states against manifest.
   * Returns { added: [], modified: [], deleted: [], unchanged: [] }
   */
  detectChanges(currentFiles) {
    const currentMap = new Map();
    for (const f of currentFiles) {
      currentMap.set(f.path, f);
    }

    const added = [];
    const modified = [];
    const unchanged = [];

    for (const f of currentFiles) {
      const recorded = this._data.files[f.path];
      if (!recorded) {
        added.push(f);
      } else if (recorded.hash !== f.hash) {
        modified.push(f);
      } else {
        unchanged.push(f);
      }
    }

    const currentPaths = new Set(currentFiles.map(f => f.path));
    const deleted = [];
    for (const [recordedPath] of Object.entries(this._data.files)) {
      if (!currentPaths.has(recordedPath)) {
        deleted.push({ path: recordedPath, wikiPage: this._data.files[recordedPath].wikiPage });
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /**
   * Mark a file as compiled: update hash and wiki page mapping.
   */
  markCompiled(filePath, hash, wikiPage, sourceId = '') {
    this._data.files[filePath] = {
      hash,
      wikiPage,
      sourceId,
      lastCompiled: new Date().toISOString(),
    };
  }

  /**
   * Remove a file entry (source deleted).
   */
  removeEntry(filePath) {
    delete this._data.files[filePath];
  }

  getEntry(filePath) {
    return this._data.files[filePath] || null;
  }

  get allEntries() {
    return { ...this._data.files };
  }
}

export default WikiManifest;
