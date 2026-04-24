/**
 * KnowledgeBase - composite facade that composes all sub-facades.
 */

import { SearchFacade } from './facades/search.js';
import { MemoryFacade } from './facades/memory.js';
import { HealthFacade } from './facades/health.js';
import { BenchmarkFacade } from './facades/benchmark.js';
import { BenchmarkHarness } from './benchmark/harness.js';
import { BENCHMARKS_DIR } from './config.js';

export class KnowledgeBase {
  constructor(options = {}) {
    this.memoryFacade = new MemoryFacade(options);
    this.searchFacade = new SearchFacade({
      ...options,
      memoryStore: this.memoryFacade.localMemory,
    });
    this.benchmarkFacade = new BenchmarkFacade(options.benchmarkRoot);
    this.healthFacade = new HealthFacade(this.searchFacade, this.memoryFacade, this.benchmarkFacade);
  }

  // ========== Initialization ==========

  async initializeEager() {
    await this.searchFacade.initializeEager();
  }

  // ========== Search ==========

  async search(options) {
    return this.searchFacade.search(options);
  }

  async syncCollections() {
    return this.searchFacade.syncCollections();
  }

  getCollections() {
    return this.searchFacade.getCollections();
  }

  async rebuild() {
    return this.searchFacade.rebuild();
  }

  async stats() {
    return this.searchFacade.stats();
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

  listMemoryReviews(limit = 50) {
    return this.memoryFacade.listMemoryReviews(limit);
  }

  reviewMemoryCandidate({ memoryId, action, publishTarget, updatedAt }) {
    return this.memoryFacade.reviewMemoryCandidate({ memoryId, action, publishTarget, updatedAt });
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

  async healthCollections() {
    return this.healthFacade.healthCollections();
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

  async runBenchmark(suiteName = null) {
    const harness = new BenchmarkHarness({
      searchFn: (opts) => this.search(opts),
      scenariosDir: './config/benchmark-scenarios',
      reportDir: BENCHMARKS_DIR,
    });
    return harness.runSuite(suiteName);
  }
}

export default KnowledgeBase;
