/**
 * API contracts - request/response models and endpoint constants.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
 */

// ========== API Version & Endpoints ==========
export const API_VERSION = '1';
export const API_PREFIX = '/api';

export const MEMORY_ENDPOINTS = {
  QUERY: `${API_PREFIX}/memory/query`,
  QUERY_CONTEXT: `${API_PREFIX}/memory/query-context`,
  TURN: `${API_PREFIX}/memory/turn`,
  SAVE: `${API_PREFIX}/memory/save`,
  MEMORY: `${API_PREFIX}/memory/:id`,
  SESSION_START: `${API_PREFIX}/memory/session/start`,
  AUTO_TRIAGE: `${API_PREFIX}/memory/auto-triage`,
  AUTO_TRIAGE_BATCH: `${API_PREFIX}/memory/auto-triage/batch`,
  REVIEWS: `${API_PREFIX}/memory/reviews`,
  REVIEW_EVALUATE: `${API_PREFIX}/memory/reviews/:id/evaluate`,
  REVIEW_CONFIRM: `${API_PREFIX}/memory/reviews/:id/confirm`,
  REVIEW_PROMOTE: `${API_PREFIX}/memory/reviews/:id/promote`, // @deprecated
  REVIEW_DISCARD: `${API_PREFIX}/memory/reviews/:id/discard`,
  GOVERNANCE_PLAN: `${API_PREFIX}/memory/governance/plan-update`,
  TIMELINE: `${API_PREFIX}/memory/timeline`,
  REBUILD: `${API_PREFIX}/rebuild`,
  WIKI_CHECK_STALE: `${API_PREFIX}/wiki/check-stale`,
  WIKI_DETECT_CHANGES: `${API_PREFIX}/wiki/detect-changes`,
  WIKI_COMPILE_PROMPT: `${API_PREFIX}/wiki/compile-prompt`,
  WIKI_SAVE_PAGE: `${API_PREFIX}/wiki/save-page`,
  WIKI_REMOVE_PAGE: `${API_PREFIX}/wiki/remove-page`,
  WIKI_UPDATE_INDEX: `${API_PREFIX}/wiki/update-index`,
  WIKI_SEARCH: `${API_PREFIX}/wiki/search`,
  WIKI_STATUS: `${API_PREFIX}/wiki/status`,
};

export const HEALTH_ENDPOINTS = {
  HEALTH: `${API_PREFIX}/health`,
  READY: `${API_PREFIX}/health/ready`,
};

export const API_ENDPOINTS = {
  ...MEMORY_ENDPOINTS,
  ...HEALTH_ENDPOINTS,
};

// ========== Request Contracts (Class-based with validate) ==========

export class MemoryQueryRequest {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 3;
  }

  validate() {
    const errors = [];
    if (!this.query || this.query.trim().length === 0) {
      errors.push('query is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class MemoryQueryContextRequest {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 3;
    this.session_id = options.session_id || null;
  }

  validate() {
    const errors = [];
    if (!this.query || this.query.trim().length === 0) {
      errors.push('query is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class MemorySaveRequest {
  constructor(options = {}) {
    this.session_id = options.session_id || null;
    this.content = options.content || '';
    this.state = options.state || 'tentative';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    this.source = options.source || 'manual';
    // v3.3: weight-based lifecycle
    this.category = options.category || 'general';
    this.weight = options.weight || 'MEDIUM';
    this.weight_set_at = options.weight_set_at || null;
    this.expires_at = options.expires_at || null;
  }

  validate() {
    const errors = [];
    if (!this.content || this.content.trim().length === 0) {
      errors.push('content is required');
    }
    if (this.content && this.content.length > 5000) {
      errors.push('content must be less than 5000 characters');
    }
    if (this.state && !['tentative', 'kept'].includes(this.state)) {
      errors.push('state must be tentative or kept');
    }
    if (this.category && !['fact', 'preference', 'project', 'instruction', 'episodic', 'general'].includes(this.category)) {
      errors.push('category must be fact, preference, project, instruction, episodic, or general');
    }
    if (this.weight && !['STRONG', 'MEDIUM', 'WEAK'].includes(this.weight)) {
      errors.push('weight must be STRONG, MEDIUM, or WEAK');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class BenchmarkResultRequest {
  constructor(options = {}) {
    this.suite_name = options.suite_name || '';
    this.executed_at = options.executed_at || '';
    this.git_sha = options.git_sha || null;
    this.case_count = options.case_count || 0;
    this.pass_count = options.pass_count || 0;
    this.pass_rate = options.pass_rate || null;
    this.metrics = options.metrics || {};
    this.regressions = options.regressions || [];
    this.artifact_paths = options.artifact_paths || [];
  }

  validate() {
    const errors = [];
    if (!this.suite_name || this.suite_name.trim().length === 0) {
      errors.push('suite_name is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class SessionTurnRequest {
  constructor(options = {}) {
    this.session_id = options.session_id || '';
    this.role = options.role || '';
    this.content = options.content || '';
    this.previous_role = options.previous_role || '';
    this.previous_content = options.previous_content || '';
    this.project_id = options.project_id || 'default';
    this.title = options.title || '';
    this.created_at = options.created_at || null;
    this.references = options.references || {};
  }

  validate() {
    const errors = [];
    if (!this.session_id) errors.push('session_id is required');
    if (!this.role || !['user', 'assistant', 'system'].includes(this.role)) {
      errors.push('role is required and must be user, assistant, or system');
    }
    if (!this.content || this.content.trim().length === 0) {
      errors.push('content is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class StartMemorySessionRequest {
  constructor(options = {}) {
    this.project_id = options.project_id || 'default';
    this.title = options.title || '';
    this.created_at = options.created_at || null;
    this.session_id = options.session_id || null;
  }

  validate() {
    const errors = [];
    if (!this.project_id) errors.push('project_id is required');
    return { valid: errors.length === 0, errors };
  }
}

export class AutoTriageRequest {
  constructor(options = {}) {
    this.session_id = options.session_id || '';
    this.role = options.role || '';
    this.content = options.content || '';
    this.previous_role = options.previous_role || '';
    this.previous_content = options.previous_content || '';
  }

  validate() {
    const errors = [];
    if (!this.session_id) errors.push('session_id is required');
    if (!this.role || !['user', 'assistant', 'system'].includes(this.role)) {
      errors.push('role is required and must be user, assistant, or system');
    }
    if (!this.content || this.content.trim().length === 0) {
      errors.push('content is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class GovernancePlanUpdateRequest {
  constructor(options = {}) {
    this.content = options.content || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
  }

  validate() {
    const errors = [];
    if (!this.content || this.content.trim().length === 0) {
      errors.push('content is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class WikiSearchRequest {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 5;
  }

  validate() {
    const errors = [];
    if (!this.query || this.query.trim().length === 0) {
      errors.push('query is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class WikiSavePageRequest {
  constructor(options = {}) {
    this.sourcePath = options.sourcePath || '';
    this.wikiPageName = options.wikiPageName || '';
    this.content = options.content || '';
    this.sourceId = options.sourceId || null;
  }

  validate() {
    const errors = [];
    if (!this.sourcePath) errors.push('sourcePath is required');
    if (!this.wikiPageName) errors.push('wikiPageName is required');
    if (!this.content || this.content.trim().length === 0) errors.push('content is required');
    return { valid: errors.length === 0, errors };
  }
}

export class WikiRemovePageRequest {
  constructor(options = {}) {
    this.wikiPageName = options.wikiPageName || '';
  }

  validate() {
    const errors = [];
    if (!this.wikiPageName) errors.push('wikiPageName is required');
    return { valid: errors.length === 0, errors };
  }
}

// ========== Response DTOs (used by presenter) ==========

export class MemoryItem {
  constructor(options = {}) {
    this.memory_id = options.memory_id || '';
    this.session_id = options.session_id || '';
    this.content = options.content || '';
    this.state = options.state || 'tentative';
    this.status = options.status || 'active';
    this.source = options.source || 'manual';
    this.created_at = options.created_at || '';
    this.updated_at = options.updated_at || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    // v3.3: weight-based lifecycle
    this.category = options.category || 'general';
    this.weight = options.weight || 'MEDIUM';
    this.weight_set_at = options.weight_set_at || null;
    this.expires_at = options.expires_at || null;
  }
}

export class HealthResponse {
  constructor(options = {}) {
    this.status = options.status || 'healthy';
    this.version = options.version || '1.0.0';
    this.timestamp = options.timestamp || new Date().toISOString();
  }
}

export class SearchResponse {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 5;
    this.result_count = options.result_count || 0;
    this.results = options.results || [];
    this.timing_ms = options.timing_ms || null;
    this.debug = options.debug || null;
  }
}

export class SearchResultItem {
  constructor(options = {}) {
    this.content = options.content || '';
    this.source = options.source || '';
    this.doc_type = options.doc_type || '';
    this.title = options.title || '';
    this.score = options.score || 0;
    this.collection = options.collection || '';
    this.chunk_id = options.chunk_id || '';
    this.matched_chunks = options.matched_chunks || 1;
    this.score_breakdown = options.score_breakdown || {};
  }
}

export class MemorySearchResponse {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 5;
    this.total_matched = options.total_matched || 0;
    this.items = options.items || [];
  }
}

export class ErrorResponse {
  constructor(options = {}) {
    this.error = options.error || 'Internal Server Error';
    this.message = options.message || '';
    this.code = options.code || 500;
    this.timestamp = options.timestamp || new Date().toISOString();
  }
}

export function buildMemoryQueryCall(payload) {
  return {
    query: payload.query || '',
    top_k: payload.top_k || 3,
  };
}

export default {
  MemoryQueryRequest,
  MemoryQueryContextRequest,
  MemorySaveRequest,
  BenchmarkResultRequest,
  SessionTurnRequest,
  StartMemorySessionRequest,
  AutoTriageRequest,
  GovernancePlanUpdateRequest,
  WikiSearchRequest,
  WikiSavePageRequest,
  WikiRemovePageRequest,
  buildMemoryQueryCall,
};
