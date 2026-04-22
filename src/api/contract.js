/**
 * API contracts - request/response models, endpoint constants, and MCP tool schemas.
 */

// ========== API Version & Endpoints ==========
export const API_VERSION = '1';
export const API_PREFIX = '/api';

export const SEARCH_ENDPOINTS = {
  SEARCH: `${API_PREFIX}/search`,
  SEARCH_SYNC: `${API_PREFIX}/search/sync`,
  SEARCH_DEBUG: `${API_PREFIX}/search/debug`,
  COLLECTIONS: `${API_PREFIX}/collections`,
};

export const MEMORY_ENDPOINTS = {
  SESSIONS: `${API_PREFIX}/memory/sessions`,
  SESSION: `${API_PREFIX}/memory/sessions/:session_id`,
  TURNS: `${API_PREFIX}/memory/sessions/:session_id/turns`,
  MEMORIES: `${API_PREFIX}/memory/memories`,
  MEMORY: `${API_PREFIX}/memory/memories/:memory_id`,
  SEARCH: `${API_PREFIX}/memory/search`,
  TIMELINE: `${API_PREFIX}/memory/timeline`,
  STATS: `${API_PREFIX}/memory/stats`,
};

export const HEALTH_ENDPOINTS = {
  HEALTH: `${API_PREFIX}/health`,
  READY: `${API_PREFIX}/health/ready`,
};

export const API_ENDPOINTS = {
  ...SEARCH_ENDPOINTS,
  ...MEMORY_ENDPOINTS,
  ...HEALTH_ENDPOINTS,
};

// ========== Request Contracts (Class-based with validate) ==========

export class SearchRequest {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 5;
    this.doc_type = options.doc_type || null;
    this.project_id = options.project_id || 'default';
    this.session_id = options.session_id || null;
    this.transcript_path = options.transcript_path || null;
    this.transcript_id = options.transcript_id || null;
    this.transcripts_root = options.transcripts_root || null;
    this.include_debug = options.include_debug || false;
  }

  validate() {
    const errors = [];
    if (!this.query || this.query.trim().length === 0) {
      errors.push('query is required');
    }
    if (this.top_k < 1) {
      errors.push('top_k must be at least 1');
    }
    return { valid: errors.length === 0, errors };
  }
}

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

export class MemorySaveRequest {
  constructor(options = {}) {
    this.session_id = options.session_id || null;
    this.content = options.content || '';
    this.state = options.state || 'local_only';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
    this.source = options.source || 'manual';
  }

  validate() {
    const errors = [];
    if (!this.session_id) {
      errors.push('session_id is required');
    }
    if (!this.content || this.content.trim().length === 0) {
      errors.push('content is required');
    }
    return { valid: errors.length === 0, errors };
  }
}

export class SaveMemoryChoiceRequest {
  constructor(options = {}) {
    this.memory_id = options.memory_id || '';
    this.choice = options.choice || '';
    this.updated_at = options.updated_at || null;
  }

  validate() {
    const errors = [];
    if (!this.memory_id) errors.push('memory_id is required');
    if (!this.choice) errors.push('choice is required');
    return { valid: errors.length === 0, errors };
  }
}

export class ListMemoryReviewsRequest {
  constructor(options = {}) {
    this.limit = options.limit || 50;
  }
}

export class ReviewMemoryCandidateRequest {
  constructor(options = {}) {
    this.memory_id = options.memory_id || '';
    this.action = options.action || '';
    this.publish_target = options.publish_target || null;
    this.updated_at = options.updated_at || null;
  }

  validate() {
    const errors = [];
    if (!this.memory_id) errors.push('memory_id is required');
    if (!this.action) errors.push('action is required');
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
}

export class SessionTurnRequest {
  constructor(options = {}) {
    this.session_id = options.session_id || '';
    this.role = options.role || '';
    this.content = options.content || '';
    this.project_id = options.project_id || 'default';
    this.title = options.title || '';
    this.created_at = options.created_at || null;
    this.references = options.references || {};
  }
}

export class StartMemorySessionRequest {
  constructor(options = {}) {
    this.project_id = options.project_id || 'default';
    this.title = options.title || '';
    this.created_at = options.created_at || null;
    this.session_id = options.session_id || null;
  }
}

export class ImportTranscriptSessionRequest {
  constructor(options = {}) {
    this.transcript_path = options.transcript_path || null;
    this.transcript_id = options.transcript_id || null;
    this.transcripts_root = options.transcripts_root || null;
    this.project_id = options.project_id || 'default';
    this.title = options.title || '';
    this.created_at = options.created_at || null;
    this.session_id = options.session_id || null;
  }
}

// ========== Response DTOs ==========

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

export class SearchResponse {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 5;
    this.result_count = options.result_count || 0;
    this.results = options.results || [];
    this.debug = options.debug || null;
    this.timing_ms = options.timing_ms || 0;
  }
}

export class MemoryItem {
  constructor(options = {}) {
    this.memory_id = options.memory_id || '';
    this.session_id = options.session_id || '';
    this.content = options.content || '';
    this.state = options.state || 'local_only';
    this.status = options.status || 'active';
    this.source = options.source || 'manual';
    this.created_at = options.created_at || '';
    this.updated_at = options.updated_at || '';
    this.aliases = options.aliases || [];
    this.path_hints = options.path_hints || [];
    this.collection_hints = options.collection_hints || [];
  }
}

export class MemorySearchResponse {
  constructor(options = {}) {
    this.query = options.query || '';
    this.top_k = options.top_k || 3;
    this.total_matched = options.total_matched || 0;
    this.items = options.items || [];
  }
}

export class HealthResponse {
  constructor(options = {}) {
    this.status = options.status || 'healthy';
    this.version = options.version || '1.0.0';
    this.timestamp = options.timestamp || new Date().toISOString();
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

// ========== MCP Tool Input Schemas ==========

export const SEARCH_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    top_k: { type: 'integer', default: 5, minimum: 1 },
    doc_type: { type: 'string', description: 'Filter by document type' },
    session_id: { type: 'string' },
    transcript_path: { type: 'string' },
    transcript_id: { type: 'string' },
    transcripts_root: { type: 'string' },
  },
  required: ['query'],
};

export const MEMORY_QUERY_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Memory query' },
    top_k: { type: 'integer', default: 3, minimum: 1 },
  },
  required: ['query'],
};

export const SAVE_MEMORY_CHOICE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    memory_id: { type: 'string' },
    choice: {
      type: 'string',
      enum: ['discard', 'keep_local', 'manual_publish', 'candidate_on_reuse', 'publish_now'],
    },
    updated_at: { type: 'string' },
  },
  required: ['memory_id', 'choice'],
};

export const LIST_MEMORY_REVIEWS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', default: 50, minimum: 1 },
  },
};

export const REVIEW_MEMORY_CANDIDATE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    memory_id: { type: 'string' },
    action: {
      type: 'string',
      enum: ['publish', 'discard', 'keep_local', 'manual_only', 'candidate_on_reuse'],
    },
    publish_target: { type: 'string', enum: ['wiki'] },
    updated_at: { type: 'string' },
  },
  required: ['memory_id', 'action'],
};

// ========== Call Builders ==========

export function buildSearchCall(payload) {
  return {
    query: payload.query || '',
    top_k: payload.top_k || 5,
    doc_type: payload.doc_type || null,
    session_id: payload.session_id || null,
    transcript_path: payload.transcript_path || null,
    transcript_id: payload.transcript_id || null,
    transcripts_root: payload.transcripts_root || null,
  };
}

export function buildMemoryQueryCall(payload) {
  return {
    query: payload.query || '',
    top_k: payload.top_k || 3,
  };
}

export function buildSaveMemoryChoiceCall(payload) {
  return {
    memory_id: payload.memory_id || '',
    choice: payload.choice || '',
    updated_at: payload.updated_at || null,
  };
}

export function buildListMemoryReviewsCall(payload) {
  return {
    limit: payload.limit || 50,
  };
}

export function buildReviewMemoryCandidateCall(payload) {
  return {
    memory_id: payload.memory_id || '',
    action: payload.action || '',
    publish_target: payload.publish_target || null,
    updated_at: payload.updated_at || null,
  };
}

export default {
  SearchRequest,
  MemoryQueryRequest,
  SaveMemoryChoiceRequest,
  buildSearchCall,
  buildMemoryQueryCall,
  buildSaveMemoryChoiceCall,
  SEARCH_TOOL_INPUT_SCHEMA,
  MEMORY_QUERY_INPUT_SCHEMA,
  SAVE_MEMORY_CHOICE_INPUT_SCHEMA,
  LIST_MEMORY_REVIEWS_INPUT_SCHEMA,
  REVIEW_MEMORY_CANDIDATE_INPUT_SCHEMA,
};
