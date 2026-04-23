#!/usr/bin/env node
/**
 * Benchmark CLI runner.
 * Usage: node src/benchmark/cli.js [--suite <name>] [--report-dir <dir>] [--scenarios-dir <dir>]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeBase } from '../knowledge-base.js';
import { BenchmarkHarness } from './harness.js';
import { BENCHMARKS_DIR } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    suite: null,
    reportDir: BENCHMARKS_DIR,
    scenariosDir: path.join(__dirname, '../../config/benchmark-scenarios'),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite' && i + 1 < args.length) options.suite = args[i + 1];
    if (args[i] === '--report-dir' && i + 1 < args.length) options.reportDir = args[i + 1];
    if (args[i] === '--scenarios-dir' && i + 1 < args.length) options.scenariosDir = args[i + 1];
  }
  return options;
}

async function main() {
  const options = parseArgs();

  console.log('Initializing KnowledgeBase...');
  const kb = new KnowledgeBase();
  await kb.initializeEager();

  const harness = new BenchmarkHarness({
    searchFn: (opts) => kb.search(opts),
    scenariosDir: options.scenariosDir,
    reportDir: options.reportDir,
  });

  console.log(`Running benchmark suite: ${options.suite || 'all'}`);
  console.log(`Scenarios dir: ${options.scenariosDir}`);
  console.log(`Report dir: ${options.reportDir}`);
  console.log('');

  const results = await harness.runSuite(options.suite);

  for (const result of results) {
    console.log(`\n=== Suite: ${result.suite_name} ===`);
    console.log(`Cases: ${result.metrics.case_count}`);
    console.log(`Passed: ${result.metrics.pass_count} / ${result.metrics.case_count} (${(result.metrics.pass_rate * 100).toFixed(1)}%)`);
    console.log(`Avg Hit Rate: ${(result.metrics.avg_hit_rate * 100).toFixed(1)}%`);
    console.log(`Avg Recall: ${(result.metrics.avg_recall * 100).toFixed(1)}%`);
    console.log(`Avg Diversity: ${(result.metrics.avg_diversity * 100).toFixed(1)}%`);

    for (const c of result.cases) {
      const icon = c.passed ? '✅' : '❌';
      console.log(`  ${icon} ${c.id}: ${c.query.slice(0, 50)}`);
      if (!c.passed && (c.failures || c.errors)) {
        console.log(`      ${(c.failures || c.errors).join('; ')}`);
      }
    }
  }

  // Exit with non-zero if any suite failed
  const anyFailed = results.some(r => r.metrics.pass_rate < 1.0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
