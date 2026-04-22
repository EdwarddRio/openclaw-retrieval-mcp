/**
 * MCP server entry point.
 * Exposes 16 tools via stdio using @modelcontextprotocol/sdk.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeBase } from './knowledge-base.js';
import {
  SEARCH_TOOL_INPUT_SCHEMA,
  MEMORY_QUERY_INPUT_SCHEMA,
  SAVE_MEMORY_CHOICE_INPUT_SCHEMA,
  LIST_MEMORY_REVIEWS_INPUT_SCHEMA,
  REVIEW_MEMORY_CANDIDATE_INPUT_SCHEMA,
} from './api/contract.js';

const knowledgeBase = new KnowledgeBase();
await knowledgeBase.initializeEager();

const server = new Server(
  {
    name: 'openclaw-context-engine',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query_static_kb',
        description: 'Search the workspace knowledge base. Returns relevant knowledge fragments + session/transcript binding info.',
        inputSchema: SEARCH_TOOL_INPUT_SCHEMA,
      },
      {
        name: 'rebuild_index',
        description: 'Rebuild the workspace knowledge base index when project files change.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'query_memory',
        description: 'Query localMem v2 memory hits, tentative items, and review queue.',
        inputSchema: MEMORY_QUERY_INPUT_SCHEMA,
      },
      {
        name: 'query_benchmark_results',
        description: 'Query latest and historical benchmark results.',
        inputSchema: {
          type: 'object',
          properties: {
            suite_name: { type: 'string' },
            limit: { type: 'integer' },
          },
        },
      },
      {
        name: 'health_status',
        description: 'Query aggregated health status of context-engine.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'memory_timeline',
        description: 'Query localMem memory timeline and change events.',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string' },
            session_id: { type: 'string' },
            limit: { type: 'integer' },
          },
        },
      },
      {
        name: 'save_memory_choice',
        description: 'Record explicit user choice for a localMem v2 memory.',
        inputSchema: SAVE_MEMORY_CHOICE_INPUT_SCHEMA,
      },
      {
        name: 'list_memory_reviews',
        description: 'List localMem v2 pending review items.',
        inputSchema: LIST_MEMORY_REVIEWS_INPUT_SCHEMA,
      },
      {
        name: 'review_memory_candidate',
        description: 'Execute review action on a localMem v2 candidate.',
        inputSchema: REVIEW_MEMORY_CANDIDATE_INPUT_SCHEMA,
      },
      {
        name: 'append_session_turn',
        description: 'Append a message turn to a localMem chat session.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string' },
            project_id: { type: 'string' },
            title: { type: 'string' },
            created_at: { type: 'string' },
            references: { type: 'object' },
          },
          required: ['session_id', 'role', 'content'],
        },
      },
      {
        name: 'start_memory_session',
        description: 'Explicitly create or switch the active localMem session.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            title: { type: 'string' },
            created_at: { type: 'string' },
            session_id: { type: 'string' },
          },
        },
      },
      {
        name: 'reset_memory_session',
        description: 'Reset the current active localMem session pointer.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'import_transcript_session',
        description: 'Import a Cursor transcript JSONL into a localMem session.',
        inputSchema: {
          type: 'object',
          properties: {
            transcript_path: { type: 'string' },
            transcript_id: { type: 'string' },
            transcripts_root: { type: 'string' },
            project_id: { type: 'string' },
            title: { type: 'string' },
            created_at: { type: 'string' },
            session_id: { type: 'string' },
          },
        },
      },
      {
        name: 'get_memory',
        description: 'Get a single memory detail by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string' },
          },
          required: ['memory_id'],
        },
      },
      {
        name: 'update_memory_content',
        description: 'Edit memory content (preserving original state).',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['memory_id', 'content'],
        },
      },
      {
        name: 'delete_memory',
        description: 'Delete a memory (mark as discarded).',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string' },
          },
          required: ['memory_id'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'query_static_kb':
        result = await knowledgeBase.search({
          query: args.query,
          top_k: args.top_k,
          doc_type: args.doc_type,
          session_id: args.session_id,
          include_debug: false,
        });
        break;

      case 'rebuild_index':
        result = await knowledgeBase.rebuild();
        break;

      case 'query_memory':
        result = await knowledgeBase.queryMemory(args.query, args.top_k);
        break;

      case 'query_benchmark_results':
        result = await knowledgeBase.benchmarkHistory(args.suite_name, args.limit);
        break;

      case 'health_status':
        result = await knowledgeBase.healthSnapshot();
        break;

      case 'memory_timeline':
        result = await knowledgeBase.memoryTimeline({
          memory_id: args.memory_id,
          session_id: args.session_id,
          limit: args.limit,
        });
        break;

      case 'save_memory_choice':
        result = await knowledgeBase.saveMemoryChoice({
          memory_id: args.memory_id,
          choice: args.choice,
          updated_at: args.updated_at,
        });
        break;

      case 'list_memory_reviews':
        result = await knowledgeBase.listMemoryReviews(args.limit);
        break;

      case 'review_memory_candidate':
        result = await knowledgeBase.reviewMemoryCandidate({
          memory_id: args.memory_id,
          action: args.action,
          publish_target: args.publish_target,
          updated_at: args.updated_at,
        });
        break;

      case 'append_session_turn':
        result = await knowledgeBase.appendSessionTurn({
          session_id: args.session_id,
          role: args.role,
          content: args.content,
          project_id: args.project_id,
          title: args.title,
          created_at: args.created_at,
          references: args.references,
        });
        break;

      case 'start_memory_session':
        result = await knowledgeBase.startMemorySession({
          project_id: args.project_id,
          title: args.title,
          created_at: args.created_at,
          session_id: args.session_id,
        });
        break;

      case 'reset_memory_session':
        result = await knowledgeBase.resetMemorySession();
        break;

      case 'import_transcript_session':
        result = await knowledgeBase.importTranscriptSession({
          transcript_path: args.transcript_path,
          transcript_id: args.transcript_id,
          transcripts_root: args.transcripts_root,
          project_id: args.project_id,
          title: args.title,
          created_at: args.created_at,
          session_id: args.session_id,
        });
        break;

      case 'get_memory':
        result = await knowledgeBase.getMemory(args.memory_id);
        break;

      case 'update_memory_content':
        result = await knowledgeBase.updateMemoryContent(args.memory_id, args.content);
        break;

      case 'delete_memory':
        result = await knowledgeBase.deleteMemory(args.memory_id);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err.message }),
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('MCP server started');
