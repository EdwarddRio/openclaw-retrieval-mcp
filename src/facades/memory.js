/**
 * Memory facade - orchestrates memory operations via LocalMemoryStore.
 * Two states: tentative (temporary, 7-day TTL) and kept (permanent).
 * Discarding a memory = hard DELETE from database.
 * Wiki is independently managed by the LLMWiki compiler.
 */

import { LocalMemoryStore } from '../memory/local-memory.js';

export class MemoryFacade {
  constructor(options = {}) {
    this.localMemory = new LocalMemoryStore(options);
  }

  queryMemory(query, topK = 3, sessionId = null) {
    return this.localMemory.queryMemoryFull(query, topK, sessionId);
  }

  queryMemoryContext(query, topK = 3, sessionId = null) {
    return this.localMemory.queryMemoryContext(query, topK, sessionId);
  }

  saveMemoryChoice({ memoryId, choice, updatedAt }) {
    return this.localMemory.saveMemoryChoice({ memoryId, choice, updatedAt });
  }

  memoryTimeline({ memoryId, sessionId, limit }) {
    return this.localMemory.getMemoryTimeline({ memory_id: memoryId, session_id: sessionId, limit });
  }

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

  startMemorySession({ projectId, title, createdAt, sessionId }) {
    return this.localMemory.getOrCreateActiveSession({
      project_id: projectId,
      title,
      created_at: createdAt,
      session_id: sessionId,
    });
  }

  resetMemorySession() {
    return this.localMemory.resetActiveSession();
  }

  importTranscriptSession({ transcriptPath, transcriptId, transcriptsRoot, projectId, title, createdAt, sessionId }) {
    return this.localMemory.startNewSession({
      project_id: projectId,
      title: title || `Import: ${transcriptPath || transcriptId}`,
      created_at: createdAt,
      session_id: sessionId,
    });
  }

  getMemory(memoryId) {
    return this.localMemory.getMemory(memoryId);
  }

  updateMemoryContent(memoryId, content) {
    return this.localMemory.updateMemoryContent(memoryId, content);
  }

  deleteMemory(memoryId) {
    return this.localMemory.deleteMemory(memoryId);
  }

  saveMemory(options) {
    return this.localMemory.saveMemory(options);
  }

  async saveMemoryWithGovernance(options) {
    return this.localMemory.saveMemoryWithGovernance(options);
  }

  async planKnowledgeUpdateDryRun(options) {
    return this.localMemory.planKnowledgeUpdateDryRun(options);
  }

  listActiveFacts(limit) {
    return this.localMemory.listActiveFacts(limit);
  }
}

export default MemoryFacade;
