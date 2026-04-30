/**
 * Benchmark harness - runs scenario suites against the search API.
 * Aligned with rule-engine evaluation/harness.py.
 */

import { ScenarioSuite, discoverScenarioSuites } from './scenario.js';
import { computeHitRate, computeRecall, computeDiversity, aggregateMetrics } from './metrics.js';
import { generateReport } from './reporting.js';

export class BenchmarkHarness {
  /**
   * @param {Object} options - 配置选项
   * @param {Function} options.searchFn - 搜索函数，接收查询参数返回搜索结果
   * @param {string} options.scenariosDir - 场景定义文件目录
   * @param {string} options.reportDir - 报告输出目录
   */
  constructor({ searchFn, scenariosDir, reportDir }) {
    this.searchFn = searchFn; // 搜索函数引用
    this.scenariosDir = scenariosDir; // 场景目录
    this.reportDir = reportDir; // 报告目录
  }

  /**
   * 运行基准测试套件
   * @param {string|null} suiteName - 指定要运行的套件名，null 表示运行全部
   * @returns {Promise<Array>} 各套件运行结果列表
   */
  async runSuite(suiteName = null) {
    const suites = discoverScenarioSuites(this.scenariosDir);
    let targetSuites = suites;
    if (suiteName) {
      targetSuites = suites.filter(s => s.name === suiteName);
      if (targetSuites.length === 0) {
        throw new Error(`Suite "${suiteName}" not found in ${this.scenariosDir}`);
      }
    }

    const allResults = [];
    for (const suiteMeta of targetSuites) {
      const suite = ScenarioSuite.fromFile(suiteMeta.path);
      const result = await this._runScenarioSuite(suite);
      allResults.push(result);
    }

    return allResults;
  }

  /**
   * 执行单个场景套件：逐条运行用例、计算指标、生成报告
   * @param {ScenarioSuite} suite - 场景套件对象
   * @returns {Promise<Object>} 套件运行结果（含 cases、metrics 等）
   */
  async _runScenarioSuite(suite) {
    const caseResults = [];

    for (const benchmarkCase of suite.cases) {
      const validation = benchmarkCase.validate();
      if (!validation.valid) {
        caseResults.push({
          id: benchmarkCase.id,
          query: benchmarkCase.query,
          passed: false,
          errors: validation.errors,
          hit_rate: null,
          recall: null,
          diversity: null,
        });
        continue;
      }

      try {
        const searchResult = await this.searchFn({
          query: benchmarkCase.query,
          top_k: 5,
          include_wiki: true,
          include_debug: false,
        });

        const results = searchResult.hits || searchResult.results || [];
        const hitRate = computeHitRate(results, benchmarkCase.expectedHits);
        const recall = computeRecall(results, benchmarkCase.expectedRecalls);
        const diversity = computeDiversity(results);

        let passed = true;
        const failures = [];

        if (benchmarkCase.expectedHits.length > 0 && hitRate < 1.0) {
          passed = false;
          failures.push(`hit_rate ${hitRate.toFixed(2)} < 1.0`);
        }
        if (benchmarkCase.expectedRecalls.length > 0 && recall < 1.0) {
          passed = false;
          failures.push(`recall ${recall.toFixed(2)} < 1.0`);
        }
        if (benchmarkCase.minRecall !== null && (recall === null || recall < benchmarkCase.minRecall)) {
          passed = false;
          failures.push(`recall ${(recall ?? 0).toFixed(2)} < min_recall ${benchmarkCase.minRecall}`);
        }

        caseResults.push({
          id: benchmarkCase.id,
          query: benchmarkCase.query,
          passed,
          failures,
          hit_rate: hitRate,
          recall,
          diversity,
          result_count: results.length,
          top_sources: results.slice(0, 3).map(r => ({ source: r.source, title: r.title, score: r.score })),
        });
      } catch (err) {
        caseResults.push({
          id: benchmarkCase.id,
          query: benchmarkCase.query,
          passed: false,
          errors: [err.message],
          hit_rate: null,
          recall: null,
          diversity: null,
        });
      }
    }

    const metrics = aggregateMetrics(caseResults);
    const suiteResult = {
      suite_name: suite.name,
      description: suite.description,
      executed_at: new Date().toISOString(),
      cases: caseResults,
      metrics,
    };

    if (this.reportDir) {
      await generateReport(suiteResult, this.reportDir);
    }

    return suiteResult;
  }
}
