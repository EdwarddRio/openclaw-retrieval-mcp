/**
 * Benchmark facade - manages benchmark results.
 */

import fs from 'fs';
import path from 'path';
import { BENCHMARKS_DIR } from '../config.js';

export class BenchmarkFacade {
  /**
   * 基准测试门面，管理基准测试结果的读写
   * @param {string} [benchmarkRoot=BENCHMARKS_DIR] - 基准测试数据存放目录
   */
  constructor(benchmarkRoot = BENCHMARKS_DIR) {
    this.benchmarkRoot = benchmarkRoot;
    if (!fs.existsSync(this.benchmarkRoot)) {
      fs.mkdirSync(this.benchmarkRoot, { recursive: true });
    }
  }

  /**
   * 记录一条基准测试结果，追加写入对应套件的 JSONL 文件
   * @param {object} payload - 测试结果数据，需包含 suite_name 字段
   * @returns {object} 带有 recorded_at 时间戳的完整条目
   */
  recordBenchmarkResult(payload) {
    const suiteName = payload.suite_name;
    const filePath = path.join(this.benchmarkRoot, `${suiteName}.jsonl`);

    const entry = {
      ...payload,
      recorded_at: new Date().toISOString(),
    };

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    return entry;
  }

  /**
   * 获取最新基准测试结果
   * @param {string|null} [suiteName=null] - 套件名，null 则跨所有套件取最新的
   * @returns {object|null} 最新测试条目，无数据时返回 null
   */
  latestBenchmark(suiteName = null) {
    if (suiteName) {
      return this._readLatestFromFile(path.join(this.benchmarkRoot, `${suiteName}.jsonl`));
    }

    // Return latest across all suites
    const files = fs.readdirSync(this.benchmarkRoot).filter(f => f.endsWith('.jsonl'));
    let latest = null;
    for (const file of files) {
      const entry = this._readLatestFromFile(path.join(this.benchmarkRoot, file));
      if (entry && (!latest || entry.executed_at > latest.executed_at)) {
        latest = entry;
      }
    }
    return latest;
  }

  /**
   * 获取基准测试历史记录
   * @param {string|null} [suiteName=null] - 套件名，null 则合并所有套件
   * @param {number} [limit=20] - 返回条数上限
   * @returns {Array} 按 executed_at 倒序排列的历史条目
   */
  benchmarkHistory(suiteName = null, limit = 20) {
    if (!suiteName) {
      // Return all suites combined
      const files = fs.readdirSync(this.benchmarkRoot).filter(f => f.endsWith('.jsonl'));
      const allEntries = [];
      for (const file of files) {
        const entries = this._readAllFromFile(path.join(this.benchmarkRoot, file));
        allEntries.push(...entries);
      }
      allEntries.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
      return allEntries.slice(0, limit);
    }

    const entries = this._readAllFromFile(path.join(this.benchmarkRoot, `${suiteName}.jsonl`));
    entries.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
    return entries.slice(0, limit);
  }

  /**
   * 从 JSONL 文件读取最后一条记录
   * @param {string} filePath - JSONL 文件路径
   * @returns {object|null} 最后一条解析成功的记录，文件不存在或为空则返回 null
   */
  _readLatestFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    try {
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  }

  /**
   * 从 JSONL 文件读取所有记录
   * @param {string} filePath - JSONL 文件路径
   * @returns {Array} 所有解析成功的记录数组，文件不存在则返回空数组
   */
  _readAllFromFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
}

export default BenchmarkFacade;
