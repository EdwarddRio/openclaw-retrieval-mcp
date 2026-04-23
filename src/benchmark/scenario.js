/**
 * Benchmark scenario definitions.
 * Aligned with rule-engine evaluation/scenarios.py design.
 */

import fs from 'fs';
import path from 'path';

export class BenchmarkCase {
  constructor(options = {}) {
    this.id = options.id || '';
    this.query = options.query || '';
    this.docType = options.doc_type || null;
    this.expectedHits = options.expected_hits || [];       // list of expected source/title patterns
    this.expectedRecalls = options.expected_recalls || []; // list of patterns that must be in top-k
    this.minRecall = options.min_recall ?? null;           // minimum recall rate (0-1)
    this.tags = options.tags || [];
    this.notes = options.notes || '';
  }

  validate() {
    const errors = [];
    if (!this.query) errors.push('query is required');
    if (!this.id) errors.push('id is required');
    return { valid: errors.length === 0, errors };
  }
}

export class ScenarioSuite {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.description = options.description || '';
    this.cases = (options.cases || []).map(c => new BenchmarkCase(c));
    this.defaults = options.defaults || {};
  }

  static fromJSON(json) {
    if (typeof json === 'string') {
      json = JSON.parse(json);
    }
    return new ScenarioSuite(json);
  }

  static fromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return ScenarioSuite.fromJSON(raw);
  }
}

export function discoverScenarioSuites(scenariosDir) {
  if (!fs.existsSync(scenariosDir)) return [];
  return fs.readdirSync(scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      path: path.join(scenariosDir, f),
    }));
}
