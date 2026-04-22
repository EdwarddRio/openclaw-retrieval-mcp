/**
 * Benchmark facade - manages benchmark results.
 */

import fs from 'fs';
import path from 'path';
import { BENCHMARKS_DIR } from '../config.js';

export class BenchmarkFacade {
  constructor(benchmarkRoot = BENCHMARKS_DIR) {
    this.benchmarkRoot = benchmarkRoot;
    if (!fs.existsSync(this.benchmarkRoot)) {
      fs.mkdirSync(this.benchmarkRoot, { recursive: true });
    }
  }

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
