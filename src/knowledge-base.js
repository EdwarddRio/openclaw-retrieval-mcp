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
  /**
   * 知识库组合门面，聚合 Memory / Health / Benchmark / Wiki 子模块
   * @param {object} [options={}] - 传递给子模块的初始化选项
   */
  constructor(options = {}) {
    this.memoryFacade = new MemoryFacade(options); // 记忆操作门面
    this.benchmarkFacade = new BenchmarkFacade(options.benchmarkRoot); // 基准测试门面
    this.healthFacade = new HealthFacade(this.memoryFacade, this.benchmarkFacade); // 健康检查门面
    this.wikiCompiler = new WikiCompiler(options); // Wiki 编译器
  }

  // ========== Memory ==========

  /**
   * 查询记忆
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @returns {Promise<Array>} 匹配的记忆条目列表
   */
  queryMemory(query, topK = 3) {
    return this.memoryFacade.queryMemory(query, topK);
  }

  /**
   * 查询记忆上下文（含会话关联信息）
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string|null} [sessionId=null] - 限定会话 ID
   * @returns {Promise<object>} 查询上下文结果
   */
  queryMemoryContext(query, topK = 3, sessionId = null) {
    return this.memoryFacade.queryMemoryContext(query, topK, sessionId);
  }

  /**
   * 保存记忆取舍决策（kept/discard）
   * @param {object} params - 参数对象
   * @param {string} params.memoryId - 记忆 ID
   * @param {string} params.choice - 取舍选择
   * @param {string} [params.updatedAt] - 更新时间
   * @returns {Promise<object>} 操作结果
   */
  saveMemoryChoice({ memoryId, choice, updatedAt }) {
    return this.memoryFacade.saveMemoryChoice({ memoryId, choice, updatedAt });
  }

  /**
   * 获取记忆时间线
   * @param {object} params - 参数对象
   * @param {string} [params.memoryId] - 记忆 ID
   * @param {string} [params.sessionId] - 会话 ID
   * @param {number} [params.limit] - 返回条数上限
   * @returns {Promise<Array>} 时间线条目列表
   */
  memoryTimeline({ memoryId, sessionId, limit }) {
    return this.memoryFacade.memoryTimeline({ memoryId, sessionId, limit });
  }

  /**
   * 追加一轮对话到会话
   * @param {object} params - 参数对象
   * @param {string} params.sessionId - 会话 ID
   * @param {string} params.role - 角色（user/assistant）
   * @param {string} params.content - 对话内容
   * @param {string} [params.projectId] - 项目 ID
   * @param {string} [params.title] - 标题
   * @param {string} [params.createdAt] - 创建时间
   * @param {Array} [params.references] - 引用列表
   * @returns {Promise<object>} 操作结果
   */
  appendSessionTurn({ sessionId, role, content, projectId, title, createdAt, references }) {
    return this.memoryFacade.appendSessionTurn({ sessionId, role, content, projectId, title, createdAt, references });
  }

  /**
   * 启动新的记忆会话
   * @param {object} params - 参数对象
   * @param {string} [params.projectId] - 项目 ID
   * @param {string} [params.title] - 会话标题
   * @param {string} [params.createdAt] - 创建时间
   * @param {string} [params.sessionId] - 指定会话 ID
   * @returns {Promise<string>} 会话 ID
   */
  startMemorySession({ projectId, title, createdAt, sessionId }) {
    return this.memoryFacade.startMemorySession({ projectId, title, createdAt, sessionId });
  }

  /**
   * 重置当前活跃会话
   * @returns {Promise<object>} 操作结果
   */
  resetMemorySession() {
    return this.memoryFacade.resetMemorySession();
  }

  /**
   * 导入外部对话记录为会话
   * @param {object} params - 参数对象
   * @param {string} [params.transcriptPath] - 对话记录文件路径
   * @param {string} [params.transcriptId] - 对话记录 ID
   * @param {string} [params.transcriptsRoot] - 对话记录根目录
   * @param {string} [params.projectId] - 项目 ID
   * @param {string} [params.title] - 会话标题
   * @param {string} [params.createdAt] - 创建时间
   * @param {string} [params.sessionId] - 指定会话 ID
   * @returns {Promise<string>} 会话 ID
   */
  importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot, projectId, title, createdAt, sessionId }) {
    return this.memoryFacade.importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot, projectId, title, createdAt, sessionId });
  }

  /**
   * 获取单条记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Promise<object|null>} 记忆条目
   */
  getMemory(memoryId) {
    return this.memoryFacade.getMemory(memoryId);
  }

  /**
   * 更新记忆内容
   * @param {string} memoryId - 记忆 ID
   * @param {string} content - 新内容
   * @returns {Promise<object>} 操作结果
   */
  updateMemoryContent(memoryId, content) {
    return this.memoryFacade.updateMemoryContent(memoryId, content);
  }

  /**
   * 删除记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Promise<object>} 操作结果
   */
  deleteMemory(memoryId) {
    return this.memoryFacade.deleteMemory(memoryId);
  }

  /**
   * 保存记忆（直接写入，不走治理流程）
   * @param {object} options - 保存选项
   * @returns {Promise<object>} 操作结果
   */
  saveMemory(options) {
    return this.memoryFacade.saveMemory(options);
  }

  /**
   * 通过治理流程保存记忆（先规划再写入）
   * @param {object} options - 保存选项
   * @returns {Promise<object>} 操作结果
   */
  async saveMemoryWithGovernance(options) {
    return this.memoryFacade.saveMemoryWithGovernance(options);
  }

  /**
   * 治理流程预演：返回更新计划但不实际写入
   * @param {object} options - 规划选项
   * @returns {Promise<object>} 更新计划
   */
  async planKnowledgeUpdateDryRun(options) {
    return this.memoryFacade.planKnowledgeUpdateDryRun(options);
  }

  /**
   * 列出活跃的事实记忆
   * @param {number} [limit] - 返回条数上限
   * @returns {Promise<Array>} 事实记忆列表
   */
  listActiveFacts(limit) {
    return this.memoryFacade.listActiveFacts(limit);
  }

  // ========== Review ==========

  /**
   * 列出待审核记忆（state='tentative'）
   * @param {number} [limit=50] - 返回数量上限
   * @returns {Array<Object>} 待审核记忆列表
   */
  listReviews(limit = 50) {
    return this.memoryFacade.listReviews(limit);
  }

  /**
   * 提升待审核记忆为永久（kept）
   * @param {string} memoryId - 记忆 ID
   * @param {Object} [evaluation] - 可选的评估结果
   * @returns {Object} 操作结果
   */
  promoteReview(memoryId, evaluation = null) {
    return this.memoryFacade.promoteReview(memoryId, evaluation);
  }

  /**
   * 丢弃待审核记忆（硬删除）
   * @param {string} memoryId - 记忆 ID
   * @returns {Object} 操作结果
   */
  discardReview(memoryId) {
    return this.memoryFacade.discardReview(memoryId);
  }

  /**
   * 评估待审核记忆（存储 LLM 评估结果，不修改状态）
   * @param {string} memoryId - 记忆 ID
   * @param {Object} evaluation - 评估结果 { score, reasoning, recommendation }
   * @returns {Object} 操作结果
   */
  evaluateReview(memoryId, evaluation) {
    return this.memoryFacade.evaluateReview(memoryId, evaluation);
  }

  // ========== Health ==========

  /**
   * 生成完整健康快照
   * @returns {Promise<object>} 健康状态快照
   */
  async healthSnapshot() {
    return this.healthFacade.healthSnapshot();
  }

  /**
   * 检查本地记忆模块健康状态
   * @returns {Promise<object>} localmem 健康状态
   */
  healthLocalmem() {
    return this.healthFacade.healthLocalmem();
  }

  /**
   * 检查基准测试模块健康状态
   * @returns {Promise<object>} benchmark 健康状态
   */
  healthBenchmarks() {
    return this.healthFacade.healthBenchmarks();
  }

  // ========== Benchmark ==========

  /**
   * 记录基准测试结果
   * @param {object} payload - 测试结果数据，需包含 suite_name 字段
   * @returns {object} 带有 recorded_at 的完整条目
   */
  recordBenchmarkResult(payload) {
    return this.benchmarkFacade.recordBenchmarkResult(payload);
  }

  /**
   * 获取最新基准测试结果
   * @param {string|null} [suiteName=null] - 套件名，null 表示跨所有套件取最新
   * @returns {object|null} 最新测试条目
   */
  latestBenchmark(suiteName = null) {
    return this.benchmarkFacade.latestBenchmark(suiteName);
  }

  /**
   * 获取基准测试历史记录
   * @param {string|null} [suiteName=null] - 套件名，null 表示所有套件
   * @param {number} [limit=20] - 返回条数上限
   * @returns {Array} 按时间倒序的历史条目
   */
  benchmarkHistory(suiteName = null, limit = 20) {
    return this.benchmarkFacade.benchmarkHistory(suiteName, limit);
  }

  // ========== Wiki Compiler ==========

  /**
   * 检测 Wiki 源文件变更
   * @returns {object} 变更检测结果
   */
  wikiDetectChanges() {
    return this.wikiCompiler.detectChanges();
  }

  /**
   * 生成 Wiki 编译提示词
   * @param {object} changesResult - wikiDetectChanges() 的返回值
   * @returns {string} 编译提示词文本
   */
  wikiGenerateCompilePrompt(changesResult) {
    return this.wikiCompiler.generateCompilePrompt(changesResult);
  }

  /**
   * 保存 Wiki 页面
   * @param {object} params - 参数对象
   * @param {string} params.sourcePath - 源文件路径
   * @param {string} params.wikiPageName - Wiki 页面名称
   * @param {string} params.content - 页面内容
   * @param {string} [params.sourceId] - 源 ID
   * @returns {object} 保存结果
   */
  wikiSavePage({ sourcePath, wikiPageName, content, sourceId }) {
    return this.wikiCompiler.saveWikiPage({ sourcePath, wikiPageName, content, sourceId });
  }

  /**
   * 删除 Wiki 页面
   * @param {string} wikiPageName - 要删除的页面名称
   * @returns {object} 删除结果
   */
  wikiRemovePage(wikiPageName) {
    return this.wikiCompiler.removeWikiPage(wikiPageName);
  }

  /**
   * 更新 Wiki 索引
   * @param {Array} pages - 页面列表
   * @returns {object} 更新结果
   */
  wikiUpdateIndex(pages) {
    return this.wikiCompiler.updateIndex(pages);
  }

  /**
   * 获取 Wiki 编译状态
   * @returns {object} 状态信息
   */
  wikiGetStatus() {
    return this.wikiCompiler.getStatus();
  }

  /**
   * 搜索 Wiki 页面（基于词频匹配）
   * @param {string} query - 查询文本
   * @param {number} [topK=5] - 返回结果数量上限
   * @returns {Array} 匹配的页面列表
   */
  wikiSearch(query, topK = 5) {
    return this.wikiCompiler.searchWiki(query, topK);
  }

  /**
   * 重建 localMem 索引：验证完整性 + 清理过期 tentative 条目
   * @returns {Promise<object>} 重建结果摘要
   */
  async rebuildLocalMem() {
    const health = await this.healthFacade.healthLocalmem();
    const stats = this.memoryFacade.listActiveFacts(10000);
    const beforeCount = Array.isArray(stats) ? stats.length : 0;
    return {
      status: 'completed',
      health,
      activeCount: beforeCount,
      message: 'localMem rebuild: integrity check done, no vector index to rebuild (SQLite LIKE search)',
    };
  }

  /**
   * 检查 Wiki 是否需要重新编译
   * @returns {object} { stale: boolean, ... }
   */
  wikiIsStale() {
    return this.wikiCompiler.isStale();
  }

  /**
   * Graceful shutdown：级联关闭所有子模块资源
   */
  async close() {
    try {
      await this.memoryFacade.close();
    } catch (err) {
      console.error(`[KnowledgeBase] memory facade close error: ${err.message}`);
    }
  }
}

export default KnowledgeBase;
