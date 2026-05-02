/**
 * HTTP server entry point.
 * Fastify-based REST API with modular architecture.
 * Architecture: localMem (memory) + LLMWiki (knowledge) — no static_kb/BM25.
 */

import Fastify from 'fastify';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import { 
  HTTP_HOST, 
  HTTP_PORT, 
  HTTP_SOCKET_PATH, 
  API_SECRET, 
  PROJECT_ROOT, 
  SIDE_LLM_GATEWAY_URL, 
  SIDE_LLM_GATEWAY_MODEL,
  AUTOTRIAGE_RECOVERY_MS,
  logger,
} from './config.js';
import { KnowledgeBase } from './knowledge-base.js';
import { QueryExporter } from './api/query-exporter.js';
import { rateLimitMiddleware, getRateLimitMetrics } from './middleware/rate-limit.js';
import { corsMiddleware } from './middleware/cors.js';
import { tracingMiddleware } from './middleware/tracing.js';
import { errorHandler } from './middleware/error-handler.js';
import { registerAllRoutes } from './routes/index.js';

/**
 * Build and configure a Fastify server instance (without listening).
 * Exported for testing — tests can use fastify.inject() without starting a real HTTP server.
 * @param {Object} [options] - Optional overrides
 * @param {Object} [options.knowledgeBase] - Custom KnowledgeBase instance
 * @param {Object} [options.metrics] - Custom metrics object
 * @returns {Promise<{ fastify: import('fastify').FastifyInstance, knowledgeBase: KnowledgeBase, metrics: Object }>}
 */
export async function buildServer(options = {}) {
  const metrics = options.metrics || {
    startTime: Date.now(),
    requestCount: 0,
    errorCount: 0,
    memoryQueryCount: 0,
    memoryTurnCount: 0,
    autoTriageSuccessCount: 0,
    autoTriageFailCount: 0,
    autoTriageConsecutiveFails: 0,
    autoTriageDisabled: false,
    autoTriageDisabledAt: null,
    lastQueryContext: null,
    lastAutoTriage: null,
    sanitizeMetadataCount: 0,
    sanitizeRejectedCount: 0,
  };

  const fastify = Fastify({
    logger: logger,
    genReqId: () => crypto.randomUUID(),
  });

  fastify.addHook('onRequest', tracingMiddleware);
  fastify.addHook('onRequest', corsMiddleware);
  fastify.addHook('onRequest', rateLimitMiddleware);
  fastify.setErrorHandler(errorHandler);

  const knowledgeBase = options.knowledgeBase || new KnowledgeBase();
  const queryExporter = new QueryExporter();

  let sideLlmGateway = null;
  if (SIDE_LLM_GATEWAY_URL) {
    sideLlmGateway = {
      defaultModel: SIDE_LLM_GATEWAY_MODEL,
      async chat({ model, messages, temperature, max_tokens }) {
        const response = await fetch(`${SIDE_LLM_GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model || SIDE_LLM_GATEWAY_MODEL, messages, temperature, max_tokens }),
        });
        if (!response.ok) throw new Error(`LLM gateway returned ${response.status}`);
        return response.json();
      },
    };
  }

  if (API_SECRET) {
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-unix-socket'] === 'true') return;
      const auth = request.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_SECRET) {
        reply.code(401).send({ error: 'Unauthorized' });
        throw new Error('Unauthorized');
      }
    });
  }

  const routeContext = {
    knowledgeBase,
    queryExporter,
    metrics,
    sideLlmGateway,
    PROJECT_ROOT,
    logger: fastify.log,
  };

  await registerAllRoutes(fastify, routeContext);

  fastify.addHook('onResponse', async (request, reply) => {
    metrics.requestCount += 1;
    if (reply.statusCode >= 500) {
      metrics.errorCount += 1;
    }
    if (request.url.startsWith('/api/memory/query')) {
      metrics.memoryQueryCount += 1;
    }
    if (request.url === '/api/memory/turn') {
      metrics.memoryTurnCount += 1;
    }
  });

  fastify.get('/metrics', async (_request, _reply) => {
    const mem = process.memoryUsage();
    const uptime = Date.now() - metrics.startTime;
    let memoryStats = null;
    try {
      const store = knowledgeBase?.memoryFacade?.localMemory?._store;
      if (store?.db) {
        const summary = store.statsSummary();
        const turnCount = store.db.prepare('SELECT COUNT(*) as cnt FROM turns').get()?.cnt || 0;
        memoryStats = { 
          kept_items: summary.kept, 
          tentative_items: summary.tentative, 
          turns: turnCount, 
          sessions: summary.sessions 
        };
      }
    } catch (metricsErr) {
      fastify.log.warn(`Failed to get memory stats for metrics: ${metricsErr.message}`);
    }
    
    return {
      uptime_ms: uptime,
      requests_total: metrics.requestCount,
      errors_total: metrics.errorCount,
      memory_queries_total: metrics.memoryQueryCount,
      memory_turns_total: metrics.memoryTurnCount,
      process: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        external_mb: Math.round(mem.external / 1024 / 1024),
      },
      memory: memoryStats,
      last_query_context: metrics.lastQueryContext,
      auto_triage: {
        success_total: metrics.autoTriageSuccessCount,
        fail_total: metrics.autoTriageFailCount,
        consecutive_fails: metrics.autoTriageConsecutiveFails,
        disabled: metrics.autoTriageDisabled,
        disabled_at: metrics.autoTriageDisabledAt,
        last: metrics.lastAutoTriage,
      },
      sanitize: {
        metadata_cleaned_total: metrics.sanitizeMetadataCount,
        rejected_total: metrics.sanitizeRejectedCount,
      },
      rate_limit: getRateLimitMetrics(),
    };
  });

  return { fastify, knowledgeBase, metrics };
}

// ========== AutoTriage Recovery Timer ==========
let recoveryInterval = null;

function startAutoTriageRecovery(metrics, fastifyInstance) {
  recoveryInterval = setInterval(() => {
    if (metrics.autoTriageDisabled && metrics.autoTriageDisabledAt) {
      const disabledAt = new Date(metrics.autoTriageDisabledAt).getTime();
      if (Date.now() - disabledAt >= AUTOTRIAGE_RECOVERY_MS) {
        metrics.autoTriageDisabled = false;
        metrics.autoTriageDisabledAt = null;
        metrics.autoTriageConsecutiveFails = 0;
        fastifyInstance.log.info('autoTriage disabled flag auto-reset after recovery timeout');
      }
    }
  }, 60 * 1000);
}

// ========== Server Startup ==========
let socketServer = null;
let serverInstance = null;

const start = async () => {
  try {
    // Port conflict detection and cleanup
    const checkPortAvailable = () => new Promise((resolve) => {
      const testServer = net.createServer();
      testServer.once('error', (err) => {
        resolve(err.code !== 'EADDRINUSE');
      });
      testServer.once('listening', () => {
        testServer.close(() => resolve(true));
      });
      testServer.listen(HTTP_PORT, HTTP_HOST);
    });

    const portAvailable = await checkPortAvailable();
    if (!portAvailable) {
      logger.warn(`Port ${HTTP_PORT} is in use, attempting to find and kill existing process...`);
      try {
        const { execSync } = await import('child_process');
        const pid = execSync(`lsof -ti :${HTTP_PORT} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
        if (pid && pid !== String(process.pid)) {
          logger.info(`Found process ${pid} on port ${HTTP_PORT}, sending SIGTERM...`);
          process.kill(parseInt(pid, 10), 'SIGTERM');
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (killErr) {
        logger.warn(`Failed to kill existing process: ${killErr.message}`);
      }
    }

    if (!API_SECRET) {
      logger.warn('OPENCLAW_API_SECRET is not set. API authentication is DISABLED. All endpoints are publicly accessible.');
    }

    const { fastify, knowledgeBase, metrics } = await buildServer();
    serverInstance = { fastify, knowledgeBase, metrics };

    // Restore autoTriage state from persistent events
    try {
      const store = knowledgeBase?.memoryFacade?.localMemory?._store;
      if (store?.db) {
        const disabledEvent = store.db.prepare(
          `SELECT created_at, payload_json FROM memory_events WHERE event_type = 'auto_triage_disabled' ORDER BY created_at DESC LIMIT 1`
        ).get();
        if (disabledEvent) {
          const data = typeof disabledEvent.payload_json === 'string' 
            ? JSON.parse(disabledEvent.payload_json) 
            : (disabledEvent.payload_json || {});
          metrics.autoTriageDisabled = true;
          metrics.autoTriageDisabledAt = data.disabled_at || disabledEvent.created_at;
          metrics.autoTriageConsecutiveFails = data.consecutiveFails || 5;
          fastify.log.warn(`autoTriage restored to disabled state from auto_triage_disabled event (disabled_at=${metrics.autoTriageDisabledAt})`);
        } else {
          const recentFail = store.db.prepare(
            `SELECT created_at, payload_json FROM memory_events WHERE event_type = 'auto_triage_failure' ORDER BY created_at DESC LIMIT 1`
          ).get();
          if (recentFail) {
            const data = typeof recentFail.payload_json === 'string'
              ? JSON.parse(recentFail.payload_json)
              : (recentFail.payload_json || {});
            if (data.consecutiveFails >= 5) {
              metrics.autoTriageDisabled = true;
              metrics.autoTriageDisabledAt = recentFail.created_at;
              metrics.autoTriageConsecutiveFails = data.consecutiveFails;
              fastify.log.warn(`autoTriage restored to disabled state from persistent events (consecutiveFails=${data.consecutiveFails})`);
            }
          }
        }
      }
    } catch (restoreErr) {
      fastify.log.warn(`Failed to restore autoTriage state: ${restoreErr.message}`);
    }

    startAutoTriageRecovery(metrics, fastify);

    // TCP entry point (for gateway)
    await fastify.listen({ host: HTTP_HOST, port: HTTP_PORT });
    logger.info(`HTTP server listening on ${HTTP_HOST}:${HTTP_PORT}`);

    // Unix Domain Socket entry point (optional, for local tools)
    if (HTTP_SOCKET_PATH) {
      try {
        if (fs.existsSync(HTTP_SOCKET_PATH)) {
          fs.unlinkSync(HTTP_SOCKET_PATH);
        }
        socketServer = net.createServer((clientSocket) => {
          const serverSocket = net.connect(HTTP_PORT, HTTP_HOST);

          if (API_SECRET) {
            let headerBuffer = Buffer.alloc(0);
            let headerParsed = false;

            clientSocket.on('data', (chunk) => {
              if (headerParsed) {
                serverSocket.write(chunk);
                return;
              }

              headerBuffer = Buffer.concat([headerBuffer, chunk]);
              const headerStr = headerBuffer.toString('utf-8');
              let headerEndIdx = headerStr.indexOf('\r\n\r\n');
              if (headerEndIdx === -1) {
                headerEndIdx = headerStr.indexOf('\n\n');
              }

              if (headerEndIdx === -1) {
                return;
              }

              headerParsed = true;
              const beforeHeaders = headerStr.slice(0, headerEndIdx);
              const afterHeaders = headerStr.slice(headerEndIdx + (headerStr.indexOf('\r\n\r\n') !== -1 ? 4 : 2));

              const headerLines = beforeHeaders.split(/\r?\n/);
              for (const line of headerLines) {
                if (line.toLowerCase().startsWith('authorization:')) {
                  const errResp = 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"Authorization header not allowed on Unix socket"}';
                  clientSocket.write(errResp, () => clientSocket.destroy());
                  return;
                }
              }

              const authHeader = `Authorization: Bearer ${API_SECRET}`;
              const unixHeader = 'X-Unix-Socket: true';
              const separator = headerStr.indexOf('\r\n\r\n') !== -1 ? '\r\n' : '\n';
              const injected = Buffer.from(
                beforeHeaders + separator + authHeader + separator + unixHeader + separator + separator + afterHeaders,
                'utf-8'
              );
              serverSocket.write(injected);
            });

            clientSocket.on('end', () => {
              if (!headerParsed && headerBuffer.length > 0) {
                serverSocket.write(headerBuffer);
              }
            });
          } else {
            clientSocket.pipe(serverSocket);
          }

          serverSocket.pipe(clientSocket);
          clientSocket.on('error', (err) => {
            logger.error(`[UnixSocket] client error: ${err.message}`);
          });
          serverSocket.on('error', (err) => {
            logger.error(`[UnixSocket] upstream connection error: ${err.message}`);
            clientSocket.destroy();
          });
          clientSocket.on('close', () => {
            serverSocket.end();
          });
          serverSocket.on('close', () => {
            clientSocket.end();
          });
        });
        socketServer.listen(HTTP_SOCKET_PATH, () => {
          fs.chmodSync(HTTP_SOCKET_PATH, 0o600);
          logger.info(`Unix socket proxy listening on ${HTTP_SOCKET_PATH} -> ${HTTP_HOST}:${HTTP_PORT}`);
        });
      } catch (sockErr) {
        logger.warn(`Unix socket start failed: ${sockErr.message}`);
      }
    }
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

// ========== Graceful Shutdown ==========
async function shutdown(signal) {
  logger.info(`[shutdown] received ${signal}, closing gracefully...`);
  try {
    if (recoveryInterval) {
      clearInterval(recoveryInterval);
      recoveryInterval = null;
    }
    if (socketServer) {
      socketServer.close();
      socketServer = null;
    }
    if (fs.existsSync(HTTP_SOCKET_PATH)) {
      fs.unlinkSync(HTTP_SOCKET_PATH);
    }
    await serverInstance.fastify.close();
    logger.info('[shutdown] closed successfully');
    process.exit(0);
  } catch (err) {
    logger.error(`[shutdown] error during close: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error(`[uncaughtException] ${err.message}\n${err.stack}`);
  try {
    const store = knowledgeBase?.memoryFacade?.localMemory?._store;
    if (store) {
      store.checkpoint();
      store.close();
    }
  } catch (closeErr) {
    logger.error(`[uncaughtException] emergency close failed: ${closeErr.message}`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`[unhandledRejection] ${reason}`);
  shutdown('unhandledRejection');
});

start();
