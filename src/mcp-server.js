/**
 * MCP server entry point.
 * Exposes tools via stdio using @modelcontextprotocol/sdk.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb.
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
        name: 'query_memory',
        description: 'Query localMem memory hits and tentative items.',
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
        description: 'Delete a memory permanently from the database.',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string' },
          },
          required: ['memory_id'],
        },
      },
      {
        name: 'save_memory',
        description: 'Save a memory item with optional governance conflict detection.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            content: { type: 'string' },
            state: { type: 'string', enum: ['tentative', 'kept'] },
            aliases: { type: 'array', items: { type: 'string' } },
            path_hints: { type: 'array', items: { type: 'string' } },
            collection_hints: { type: 'array', items: { type: 'string' } },
            source: { type: 'string', enum: ['manual', 'auto_triage', 'user_explicit', 'auto_draft'] },
            use_governance: { type: 'boolean', default: true },
          },
          required: ['session_id', 'content'],
        },
      },
      {
        name: 'plan_knowledge_update',
        description: 'Dry-run governance: plan how a new memory would integrate without persisting.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            aliases: { type: 'array', items: { type: 'string' } },
            path_hints: { type: 'array', items: { type: 'string' } },
            collection_hints: { type: 'array', items: { type: 'string' } },
          },
          required: ['content'],
        },
      },
      {
        name: 'run_benchmark',
        description: 'Run benchmark suite to evaluate search quality.',
        inputSchema: {
          type: 'object',
          properties: {
            suite_name: { type: 'string' },
          },
        },
      },
      {
        name: 'wiki_detect_changes',
        description: 'Detect changes in raw source files since last wiki compilation. Returns added/modified/deleted files with content for LLM to compile. This is the first step in incremental wiki compilation.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'wiki_compile_prompt',
        description: 'Generate a compilation prompt for changed raw sources. Use after wiki_detect_changes if you want the structured prompt format with schema reference.',
        inputSchema: {
          type: 'object',
          properties: {
            include_content: { type: 'boolean', default: true, description: 'Include file content in prompt' },
          },
        },
      },
      {
        name: 'wiki_save_page',
        description: 'Save a compiled wiki page to the wiki directory. Call this after LLM compiles raw material into a structured wiki page.',
        inputSchema: {
          type: 'object',
          properties: {
            source_path: { type: 'string', description: 'Original source file path' },
            wiki_page_name: { type: 'string', description: 'Wiki page filename (e.g. "用户画像与偏好.md")' },
            content: { type: 'string', description: 'Compiled wiki page content in Markdown' },
            source_id: { type: 'string', description: 'Source ID from raw-sources.json' },
          },
          required: ['source_path', 'wiki_page_name', 'content', 'source_id'],
        },
      },
      {
        name: 'wiki_remove_page',
        description: 'Remove a wiki page when its source file is deleted.',
        inputSchema: {
          type: 'object',
          properties: {
            wiki_page_name: { type: 'string', description: 'Wiki page filename to remove' },
          },
          required: ['wiki_page_name'],
        },
      },
      {
        name: 'wiki_update_index',
        description: 'Update the wiki/index.md with current page listing. Call after saving/removing pages.',
        inputSchema: {
          type: 'object',
          properties: {
            pages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  title: { type: 'string' },
                  sourceId: { type: 'string' },
                  lastCompiled: { type: 'string' },
                },
                required: ['name', 'title', 'sourceId'],
              },
              description: 'Array of wiki page metadata',
            },
          },
          required: ['pages'],
        },
      },
      {
        name: 'wiki_status',
        description: 'Get wiki compilation status: manifest entries, existing wiki pages, etc.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'wiki_search',
        description: 'Search wiki pages by keywords. Wiki owns its own search independent of any BM25 index. Use this to find relevant wiki pages before reading them.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query keywords' },
            top_k: { type: 'integer', description: 'Max results (default 5)', default: 5 },
          },
          required: ['query'],
        },
      },
      {
        name: 'wiki_check_stale',
        description: 'Check if wiki is stale (raw sources changed since last compilation). Returns stale status and change summary without reading file contents.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
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

      case 'save_memory':
        result = await knowledgeBase.saveMemoryWithGovernance({
          session_id: args.session_id,
          content: args.content,
          state: args.state || 'tentative',
          aliases: args.aliases || [],
          path_hints: args.path_hints || [],
          collection_hints: args.collection_hints || [],
          source: args.source || 'manual',
        });
        break;

      case 'plan_knowledge_update':
        result = await knowledgeBase.planKnowledgeUpdateDryRun({
          content: args.content,
          aliases: args.aliases || [],
          path_hints: args.path_hints || [],
          collection_hints: args.collection_hints || [],
        });
        break;

      case 'run_benchmark':
        result = await knowledgeBase.runBenchmark(args.suite_name || null);
        break;

      case 'wiki_detect_changes':
        result = knowledgeBase.wikiDetectChanges();
        break;

      case 'wiki_compile_prompt': {
        const changes = knowledgeBase.wikiDetectChanges();
        result = knowledgeBase.wikiGenerateCompilePrompt(changes);
        break;
      }

      case 'wiki_save_page':
        result = knowledgeBase.wikiSavePage({
          sourcePath: args.source_path,
          wikiPageName: args.wiki_page_name,
          content: args.content,
          sourceId: args.source_id,
        });
        break;

      case 'wiki_remove_page':
        result = knowledgeBase.wikiRemovePage(args.wiki_page_name);
        break;

      case 'wiki_update_index':
        result = knowledgeBase.wikiUpdateIndex(args.pages);
        break;

      case 'wiki_status':
        result = knowledgeBase.wikiGetStatus();
        break;

      case 'wiki_search':
        result = knowledgeBase.wikiSearch(args.query, args.top_k || 5);
        break;

      case 'wiki_check_stale':
        result = knowledgeBase.wikiIsStale();
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
