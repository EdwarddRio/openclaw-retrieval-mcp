/**
 * Benchmark reporting - JSON + Markdown dual-format output.
 * Aligned with rule-engine evaluation/reporting.py.
 */

import fs from 'fs';
import path from 'path';

export async function generateReport(suiteResult, reportDir) {
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${suiteResult.suite_name}-${timestamp}`;

  // JSON report
  const jsonPath = path.join(reportDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(suiteResult, null, 2), 'utf-8');

  // Markdown report
  const mdPath = path.join(reportDir, `${baseName}.md`);
  const md = _renderMarkdown(suiteResult);
  fs.writeFileSync(mdPath, md, 'utf-8');

  // Also write latest.json / latest.md for easy access
  fs.writeFileSync(path.join(reportDir, 'latest.json'), JSON.stringify(suiteResult, null, 2), 'utf-8');
  fs.writeFileSync(path.join(reportDir, 'latest.md'), md, 'utf-8');

  return { jsonPath, mdPath };
}

function _renderMarkdown(result) {
  const { suite_name, description, executed_at, cases, metrics } = result;
  const lines = [];

  lines.push(`# Benchmark Report: ${suite_name}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }
  lines.push(`- **Executed at**: ${executed_at}`);
  lines.push(`- **Cases**: ${metrics.case_count}`);
  lines.push(`- **Passed**: ${metrics.pass_count} / ${metrics.case_count} (${(metrics.pass_rate * 100).toFixed(1)}%)`);
  lines.push(`- **Avg Hit Rate**: ${(metrics.avg_hit_rate * 100).toFixed(1)}%`);
  lines.push(`- **Avg Recall**: ${(metrics.avg_recall * 100).toFixed(1)}%`);
  lines.push(`- **Avg Diversity**: ${(metrics.avg_diversity * 100).toFixed(1)}%`);
  lines.push('');

  lines.push('## Cases');
  lines.push('');
  lines.push('| ID | Query | Passed | Hit Rate | Recall | Diversity | Failures |');
  lines.push('|----|-------|--------|----------|--------|-----------|----------|');

  for (const c of cases) {
    const status = c.passed ? '✅' : '❌';
    const hr = c.hit_rate !== null ? `${(c.hit_rate * 100).toFixed(0)}%` : '-';
    const rc = c.recall !== null ? `${(c.recall * 100).toFixed(0)}%` : '-';
    const dv = c.diversity !== null ? `${(c.diversity * 100).toFixed(0)}%` : '-';
    const failures = (c.failures || c.errors || []).join('; ') || '-';
    lines.push(`| ${c.id} | ${c.query.slice(0, 40)} | ${status} | ${hr} | ${rc} | ${dv} | ${failures.slice(0, 60)} |`);
  }

  lines.push('');
  lines.push('## Detail');
  lines.push('');

  for (const c of cases) {
    lines.push(`### ${c.id}`);
    lines.push('');
    lines.push(`- **Query**: ${c.query}`);
    lines.push(`- **Passed**: ${c.passed ? 'Yes' : 'No'}`);
    if (c.hit_rate !== null) lines.push(`- **Hit Rate**: ${(c.hit_rate * 100).toFixed(1)}%`);
    if (c.recall !== null) lines.push(`- **Recall**: ${(c.recall * 100).toFixed(1)}%`);
    if (c.diversity !== null) lines.push(`- **Diversity**: ${(c.diversity * 100).toFixed(1)}%`);
    if (c.failures && c.failures.length) {
      lines.push(`- **Failures**: ${c.failures.join(', ')}`);
    }
    if (c.errors && c.errors.length) {
      lines.push(`- **Errors**: ${c.errors.join(', ')}`);
    }
    if (c.top_sources && c.top_sources.length) {
      lines.push('- **Top Results**:');
      for (const src of c.top_sources) {
        lines.push(`  - ${src.title || src.source} (score: ${typeof src.score === 'number' ? src.score.toFixed(4) : src.score})`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
