/**
 * Benchmark facade - manages benchmark results.
 */

import fs from 'fs';
import path from 'path';
import { BENCHMARKS_DIR } from '../config.js';

export class BenchmarkFacade {
  constructor(benchmarkRoot = BENCHMARKS_DIR) {
    this.benchmarkRoot = benchmarkRoot;
    this.maxFileSizeMb = 50;
    this.maxArchives = 3;
    if (!fs.existsSync(this.benchmarkRoot)) {
      fs.mkdirSync(this.benchmarkRoot, { recursive: true });
    }
  }

  recordBenchmarkResult(payload) {
    const suiteName = payload.suite_name;
    const filePath = path.join(this.benchmarkRoot, `${suiteName}.jsonl`);

    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > this.maxFileSizeMb * 1024 * 1024) {
        this._rotateFile(filePath);
      }
    }

    const entry = {
      ...payload,
      recorded_at: new Date().toISOString(),
    };

    let retries = 3;
    while (retries > 0) {
      try {
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
        return entry;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
      }
    }
    return entry;
  }

  _rotateFile(filePath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = filePath.replace('.jsonl', `-${timestamp}.jsonl`);
    try {
      fs.renameSync(filePath, archivePath);
    } catch (err) {
      console.warn(`[BenchmarkFacade] Failed to rotate ${filePath}: ${err.message}`);
      return;
    }

    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, '.jsonl');
    const archives = fs.readdirSync(dir)
      .filter(f => f.startsWith(baseName) && f.endsWith('.jsonl') && f !== path.basename(filePath))
      .sort()
      .reverse();

    for (let i = this.maxArchives; i < archives.length; i++) {
      try {
        fs.unlinkSync(path.join(dir, archives[i]));
      } catch {}
    }
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
