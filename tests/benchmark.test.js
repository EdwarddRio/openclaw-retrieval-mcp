import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { BenchmarkFacade } from '../src/facades/benchmark.js';

const TEST_DIR = path.join(process.cwd(), 'tests', 'test-benchmarks');

describe('BenchmarkFacade', () => {
  let facade;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    facade = new BenchmarkFacade(TEST_DIR);
  });

  it('should record benchmark result', () => {
    const result = facade.recordBenchmarkResult({
      suite_name: 'test-suite',
      executed_at: new Date().toISOString(),
      case_count: 10,
      pass_count: 9,
      pass_rate: 0.9,
      metrics: {},
      regressions: [],
      artifact_paths: [],
    });

    assert.strictEqual(result.suite_name, 'test-suite');
    assert.ok(result.recorded_at);
  });

  it('should get latest benchmark', () => {
    facade.recordBenchmarkResult({
      suite_name: 'test-suite',
      executed_at: '2024-01-01T00:00:00Z',
      case_count: 5,
      pass_count: 5,
      pass_rate: 1.0,
      metrics: {},
      regressions: [],
      artifact_paths: [],
    });

    const latest = facade.latestBenchmark('test-suite');
    assert.ok(latest);
    assert.strictEqual(latest.case_count, 5);
  });

  it('should get benchmark history', () => {
    facade.recordBenchmarkResult({
      suite_name: 'test-suite',
      executed_at: '2024-01-01T00:00:00Z',
      case_count: 5,
      pass_count: 5,
      pass_rate: 1.0,
      metrics: {},
      regressions: [],
      artifact_paths: [],
    });

    const history = facade.benchmarkHistory('test-suite', 10);
    assert.strictEqual(history.length, 1);
  });
});
