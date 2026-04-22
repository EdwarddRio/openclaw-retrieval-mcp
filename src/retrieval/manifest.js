/**
 * Manifest store - persists file fingerprints for incremental sync.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MANIFEST_PATH } from '../config.js';

export class ManifestStore {
  constructor(manifestPath = MANIFEST_PATH) {
    this._path = path.resolve(manifestPath);
    this._records = this._load();
  }

  diff(targets, collectionNames = null) {
    const targetList = Array.from(targets);
    const current = {};
    for (const target of targetList) {
      current[this._key(target)] = this._recordFor(target);
    }

    const knownCollections = new Set(Object.values(this._records).map(r => r.collection));
    const targetCollections = new Set(targetList.map(t => t.collection));
    const requestedCollections = new Set(collectionNames || []);
    const relevantCollections = requestedCollections.size > 0
      ? requestedCollections
      : (targetCollections.size > 0 ? targetCollections : knownCollections);

    const added = [];
    const updated = [];
    const deleted = [];

    for (const target of targetList) {
      const key = this._key(target);
      if (!this._records[key]) {
        added.push(target);
      } else if (JSON.stringify(this._records[key]) !== JSON.stringify(current[key])) {
        updated.push(target);
      }
    }

    for (const [key, record] of Object.entries(this._records)) {
      if (relevantCollections.has(record.collection) && !current[key]) {
        deleted.push(record);
      }
    }

    return { added, updated, deleted };
  }

  saveTargets(targets, collectionNames = null) {
    const targetList = Array.from(targets);
    let affectedCollections = new Set(collectionNames || []);
    if (affectedCollections.size === 0) {
      affectedCollections = new Set(targetList.map(t => t.collection));
    }
    if (affectedCollections.size === 0) {
      affectedCollections = new Set(Object.values(this._records).map(r => r.collection));
    }

    for (const [key, record] of Object.entries(this._records)) {
      if (affectedCollections.has(record.collection)) {
        delete this._records[key];
      }
    }

    for (const target of targetList) {
      this._records[this._key(target)] = this._recordFor(target);
    }

    this._persist();
  }

  isStale(targets, collectionNames = null) {
    const diff = this.diff(targets, collectionNames);
    return diff.added.length > 0 || diff.updated.length > 0 || diff.deleted.length > 0;
  }

  _load() {
    if (!fs.existsSync(this._path)) return {};
    try {
      return JSON.parse(fs.readFileSync(this._path, 'utf-8'));
    } catch {
      return {};
    }
  }

  _persist() {
    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(this._records, null, 2), 'utf-8');
  }

  _key(target) {
    return `${target.collection}::${target.sourceFile}`;
  }

  _recordFor(target) {
    const stat = fs.statSync(target.sourceFile);
    const content = fs.readFileSync(target.sourceFile);
    return {
      collection: target.collection,
      loaderType: target.loaderType,
      docType: target.docType,
      mtimeNs: stat.mtimeNs || stat.mtime.getTime() * 1000000,
      size: stat.size,
      sha1: crypto.createHash('sha1').update(content).digest('hex'),
      sourceFile: target.sourceFile,
    };
  }
}

export default ManifestStore;
