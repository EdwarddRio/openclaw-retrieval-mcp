/**
 * Memory facade - orchestrates memory operations via LocalMemoryStore.
 * Two states: tentative (temporary, 7-day TTL) and kept (permanent).
 * Discarding a memory = hard DELETE from database.
 * Wiki is independently managed by the LLMWiki compiler.
 */

import { LocalMemoryStore } from '../memory/local-memory.js';

export class MemoryFacade {
  /**
   * 记忆操作门面，编排 LocalMemoryStore 的各种操作
   * 两种记忆状态：tentative（临时，7天TTL）和 kept（永久）；丢弃即硬删除
   * @param {object} [options={}] - 传递给 LocalMemoryStore 的初始化选项
   */
  constructor(options = {}) {
    this.localMemory = new LocalMemoryStore(options);
  }

  /**
   * 查询记忆
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string|null} [sessionId=null] - 限定会话 ID
   * @returns {Promise<Array>} 匹配的记忆条目列表
   */
  queryMemory(query, topK = 3, sessionId = null) {
    return this.localMemory.queryMemoryFull(query, topK, sessionId);
  }

  /**
   * 查询记忆上下文（含会话关联信息）
   * @param {string} query - 查询文本
   * @param {number} [topK=3] - 返回结果数量上限
   * @param {string|null} [sessionId=null] - 限定会话 ID
   * @returns {Promise<object>} 查询上下文结果
   */
  queryMemoryContext(query, topK = 3, sessionId = null) {
    return this.localMemory.queryMemoryContext(query, topK, sessionId);
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
    return this.localMemory.saveMemoryChoice({ memoryId, choice, updatedAt });
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
    return this.localMemory.getMemoryTimeline({ memory_id: memoryId, session_id: sessionId, limit });
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
    return this.localMemory.appendTurn({
      session_id: sessionId,
      role,
      content,
      project_id: projectId,
      title,
      created_at: createdAt,
      references,
    });
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
    return this.localMemory.getOrCreateActiveSession({
      project_id: projectId,
      title,
      created_at: createdAt,
      session_id: sessionId,
    });
  }

  /**
   * 重置当前活跃会话
   * @returns {Promise<object>} 操作结果
   */
  resetMemorySession() {
    return this.localMemory.resetActiveSession();
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
    return this.localMemory.startNewSession({
      project_id: projectId,
      title: title || `Import: ${transcriptPath || transcriptId}`,
      created_at: createdAt,
      session_id: sessionId,
    });
  }

  /**
   * 获取单条记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Promise<object|null>} 记忆条目
   */
  getMemory(memoryId) {
    return this.localMemory.getMemory(memoryId);
  }

  /**
   * 更新记忆内容
   * @param {string} memoryId - 记忆 ID
   * @param {string} content - 新内容
   * @returns {Promise<object>} 操作结果
   */
  updateMemoryContent(memoryId, content) {
    return this.localMemory.updateMemoryContent(memoryId, content);
  }

  /**
   * 删除记忆
   * @param {string} memoryId - 记忆 ID
   * @returns {Promise<object>} 操作结果
   */
  deleteMemory(memoryId) {
    return this.localMemory.deleteMemory(memoryId);
  }

  /**
   * 保存记忆（直接写入，不走治理流程）
   * @param {object} options - 保存选项
   * @returns {object} 操作结果
   */
  saveMemory(options) {
    return this.localMemory.saveMemory(options);
  }

  /**
   * 通过治理流程保存记忆（先规划再写入）
   * @param {object} options - 保存选项
   * @returns {Promise<object>} 操作结果
   */
  async saveMemoryWithGovernance(options) {
    return this.localMemory.saveMemoryWithGovernance(options);
  }

  /**
   * 治理流程预演：返回更新计划但不实际写入
   * @param {object} options - 规划选项
   * @returns {Promise<object>} 更新计划
   */
  async planKnowledgeUpdateDryRun(options) {
    return this.localMemory.planKnowledgeUpdateDryRun(options);
  }

  /**
   * 列出活跃的事实记忆
   * @param {number} [limit] - 返回条数上限
   * @returns {Array} 事实记忆列表
   */
  listActiveFacts(limit) {
    return this.localMemory.listActiveFacts(limit);
  }
}

export default MemoryFacade;
