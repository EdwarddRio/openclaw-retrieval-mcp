/**
 * Benchmark scenario definitions.
 * Aligned with rule-engine evaluation/scenarios.py design.
 */

import fs from 'fs';
import path from 'path';

/** 基准测试用例定义 */
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

  /**
   * 验证用例必填字段
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    const errors = [];
    if (!this.query) errors.push('query is required');
    if (!this.id) errors.push('id is required');
    return { valid: errors.length === 0, errors };
  }
}

/** 场景测试套件，包含一组 BenchmarkCase */
export class ScenarioSuite {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.description = options.description || '';
    this.cases = (options.cases || []).map(c => new BenchmarkCase(c));
    this.defaults = options.defaults || {};
  }

  /**
   * 从 JSON 对象或字符串创建套件
   * @param {Object|string} json - 套件定义
   * @returns {ScenarioSuite}
   */
  static fromJSON(json) {
    if (typeof json === 'string') {
      json = JSON.parse(json);
    }
    return new ScenarioSuite(json);
  }

  /**
   * 从文件路径读取并创建套件
   * @param {string} filePath - 场景 JSON 文件路径
   * @returns {ScenarioSuite}
   */
  static fromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return ScenarioSuite.fromJSON(raw);
  }
}

/**
 * 扫描目录发现所有场景套件文件
 * @param {string} scenariosDir - 场景定义目录
 * @returns {Array<{ name: string, path: string }>} 发现的套件元数据列表
 */
export function discoverScenarioSuites(scenariosDir) {
  if (!fs.existsSync(scenariosDir)) return [];
  return fs.readdirSync(scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f.replace(/\.json$/, ''),
      path: path.join(scenariosDir, f),
    }));
}
