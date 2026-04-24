/**
 * KnowledgeBase - composite facade that composes all sub-facades.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no BM25/static_kb.
 */

import { MemoryFacade } from './facades/memory.js';
import { HealthFacade } from './facades/health.js';
import { BenchmarkFacade } from './facades/benchmark.js';
import { BenchmarkHarness } from './benchmark/harness.js';
import { BENCHMARKS_DIR } from './config.js';
import { WikiCompiler } from './wiki/compiler.js';

export class KnowledgeBase {
  constructor(options = {}) {
    this.memoryFacade = new MemoryFacade(options);
    this.benchmarkFacade = new BenchmarkFacade(options.benchmarkRoot);
    this.healthFacade = new HealthFacade(this.memoryFacade, this.benchmarkFacade);
    this.wikiCompiler = new WikiCompiler(options);
  }

  // ========== Memory ==========

  queryMemory(query, topK = 3) {
    return this.memoryFacade.queryMemory(query, topK);
  }

  queryMemoryContext(query, topK = 3, sessionId = null) {
    return this.memoryFacade.queryMemoryContext(query, topK, sessionId);
  }

  saveMemoryChoice({ memoryId, choice, updatedAt }) {
    return this.memoryFacade.saveMemoryChoice({ memoryId, choice, updatedAt });
  }

  memoryTimeline({ memoryId, sessionId, limit }) {
    return this.memoryFacade.memoryTimeline({ memoryId, sessionId, limit });
  }

  appendSessionTurn({ sessionId, role, content, projectId, title, createdAt, references }) {
    return this.memoryFacade.appendSessionTurn({ sessionId, role, content, projectId, title, createdAt, references });
  }

  startMemorySession({ projectId, title, createdAt, sessionId }) {
    return this.memoryFacade.startMemorySession({ projectId, title, createdAt, sessionId });
  }

  resetMemorySession() {
    return this.memoryFacade.resetMemorySession();
  }

  importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot, projectId, title, createdAt, sessionId }) {
    return this.memoryFacade.importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot, projectId, title, createdAt, sessionId });
  }

  getMemory(memoryId) {
    return this.memoryFacade.getMemory(memoryId);
  }

  updateMemoryContent(memoryId, content) {
    return this.memoryFacade.updateMemoryContent(memoryId, content);
  }

  deleteMemory(memoryId) {
    return this.memoryFacade.deleteMemory(memoryId);
  }

  saveMemory(options) {
    return this.memoryFacade.saveMemory(options);
  }

  async saveMemoryWithGovernance(options) {
    return this.memoryFacade.saveMemoryWithGovernance(options);
  }

  async planKnowledgeUpdateDryRun(options) {
    return this.memoryFacade.planKnowledgeUpdateDryRun(options);
  }

  listActiveFacts(limit) {
    return this.memoryFacade.listActiveFacts(limit);
  }

  // ========== Health ==========

  async healthSnapshot() {
    return this.healthFacade.healthSnapshot();
  }

  healthLocalmem() {
    return this.healthFacade.healthLocalmem();
  }

  healthBenchmarks() {
    return this.healthFacade.healthBenchmarks();
  }

  // ========== Benchmark ==========

  recordBenchmarkResult(payload) {
    return this.benchmarkFacade.recordBenchmarkResult(payload);
  }

  latestBenchmark(suiteName = null) {
    return this.benchmarkFacade.latestBenchmark(suiteName);
  }

  benchmarkHistory(suiteName = null, limit = 20) {
    return this.benchmarkFacade.benchmarkHistory(suiteName, limit);
  }

  // ========== Wiki Compiler ==========

  wikiDetectChanges() {
    return this.wikiCompiler.detectChanges();
  }

  wikiGenerateCompilePrompt(changesResult) {
    return this.wikiCompiler.generateCompilePrompt(changesResult);
  }

  wikiSavePage({ sourcePath, wikiPageName, content, sourceId }) {
    return this.wikiCompiler.saveWikiPage({ sourcePath, wikiPageName, content, sourceId });
  }

  wikiRemovePage(wikiPageName) {
    return this.wikiCompiler.removeWikiPage(wikiPageName);
  }

  wikiUpdateIndex(pages) {
    return this.wikiCompiler.updateIndex(pages);
  }

  wikiGetStatus() {
    return this.wikiCompiler.getStatus();
  }

  wikiSearch(query, topK = 5) {
    return this.wikiCompiler.searchWiki(query, topK);
  }

  wikiIsStale() {
    return this.wikiCompiler.isStale();
  }
}

export default KnowledgeBase;
