# OpenClaw Context Engine - JS Rewrite Implementation Plan

## [x] Task 1: 项目初始化
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 创建新目录 `openclaw-context-engine-js`
  - 初始化 package.json，配置依赖
  - 创建项目目录结构（src/、config/、scripts/、tests/）
  - 复制配置文件模板
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: `npm install` 成功
  - `programmatic` TR-1.2: 目录结构完整符合架构设计
- **Notes**: 依赖包括 fastify、better-sqlite3、chromadb、nodejieba、@modelcontextprotocol/sdk 等

## [x] Task 2: 基础设施层 - 配置管理
- **Priority**: P0
- **Depends On**: Task 1
- **Description**: 
  - 实现 config.js，读取环境变量
  - 配置日志系统
  - 路径管理
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-2.1: 环境变量读取正确
  - `programmatic` TR-2.2: 日志输出正常

## [x] Task 3: 基础设施层 - ChromaDB 客户端封装
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 vector/chroma-client.js，封装 ChromaDB 操作
  - 集合管理、向量添加、向量查询
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-3.1: 可以成功创建/删除集合
  - `programmatic` TR-3.2: 可以添加和查询向量

## [x] Task 4: 基础设施层 - Embedding HTTP 客户端
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 vector/embedding.js，调用 Python 服务的 Embedding API
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-4.1: 可以成功调用 API 获取向量
  - `programmatic` TR-4.2: 向量维度正确

## [x] Task 5: 基础设施层 - BM25 实现
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 bm25/index.js（倒排索引构建）
  - 实现 bm25/search.js（BM25 评分）
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-5.1: 可以构建倒排索引
  - `programmatic` TR-5.2: 可以执行 BM25 搜索

## [x] Task 6: 核心检索系统 - 文件扫描器
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 retrieval/scanner.js，递归扫描目录，识别文件类型
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-6.1: 可以递归扫描目录
  - `programmatic` TR-6.2: 可以正确识别文件类型（markdown、code、text）

## [x] Task 7: 核心检索系统 - 内容加载器
- **Priority**: P0
- **Depends On**: Task 6
- **Description**: 
  - 实现 loaders/base.js（基类）
  - 实现 loaders/markdown-loader.js
  - 实现 loaders/code-loader.js
  - 实现 loaders/text-loader.js
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-7.1: 可以加载并分块各类文件

## [x] Task 8: 核心检索系统 - 分词器
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 retrieval/tokenizer.js，基于 nodejieba 的中英文分词
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-8.1: 可以正确分词中英文

## [x] Task 9: 核心检索系统 - 索引器
- **Priority**: P0
- **Depends On**: Task 3, Task 4, Task 5, Task 7, Task 8
- **Description**: 
  - 实现 retrieval/indexer.js，向量化 + BM25 索引构建
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-9.1: 可以构建完整索引（向量 + BM25）

## [x] Task 10: 核心检索系统 - 检索器
- **Priority**: P0
- **Depends On**: Task 9
- **Description**: 
  - 实现 retrieval/retriever.js，混合检索执行
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-10.1: 可以执行混合检索

## [x] Task 11: 核心检索系统 - 查询规划器
- **Priority**: P0
- **Depends On**: Task 10
- **Description**: 
  - 实现 retrieval/query-planner.js，意图识别、查询变体、路由
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-11.1: 可以解析和规划查询

## [x] Task 12: 核心检索系统 - 融合排序
- **Priority**: P0
- **Depends On**: Task 11
- **Description**: 
  - 实现 retrieval/fusion.js，RRF 算法
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-12.1: 可以正确融合排序结果

## [x] Task 13: 核心检索系统 - MMR 去冗
- **Priority**: P0
- **Depends On**: Task 12
- **Description**: 
  - 实现 retrieval/mmr.js，最大边际相关性
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-13.1: 可以去冗结果

## [x] Task 14: 核心检索系统 - 其他组件
- **Priority**: P1
- **Depends On**: Task 13
- **Description**: 
  - 实现 retrieval/collection-manager.js
  - 实现 retrieval/scoring-config.js
  - 实现 retrieval/manifest.js
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-14.1: 组件功能完整

## [x] Task 15: 记忆系统 - SQLite 存储
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 memory/models.js（数据模型）
  - 实现 memory/context-types.js
  - 实现 SQLite 持久化
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-15.1: 数据可以持久化到 SQLite

## [x] Task 16: 记忆系统 - 核心服务
- **Priority**: P0
- **Depends On**: Task 15
- **Description**: 
  - 实现 memory/facade.js
  - 实现 memory/local-memory.js（CRUD、时间线）
  - 实现 memory/timeline.js
  - 实现 memory/helpers.js
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-16.1: 记忆 CRUD 正常
  - `programmatic` TR-16.2: 时间线管理正常

## [x] Task 17: 记忆系统 - 高级功能
- **Priority**: P1
- **Depends On**: Task 16
- **Description**: 
  - 实现 memory/auto-memory.js（自动沉淀）
  - 实现 memory/llm-gateway.js（LLM 网关）
  - 实现 memory/transcript-resolver.js（会话解析）
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-17.1: 自动沉淀功能正常

## [x] Task 18: API 服务层 - API 契约与响应格式化
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现 api/contract.js（请求/响应模型）
  - 实现 api/presenter.js（统一响应格式）
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-18.1: API 模型定义正确

## [x] Task 19: API 服务层 - 检索服务编排
- **Priority**: P0
- **Depends On**: Task 14, Task 18
- **Description**: 
  - 实现 api/search-service.js
- **Acceptance Criteria Addressed**: AC-2, AC-3
- **Test Requirements**:
  - `programmatic` TR-19.1: 检索流程编排正确

## [x] Task 20: API 服务层 - HTTP 服务
- **Priority**: P0
- **Depends On**: Task 19
- **Description**: 
  - 实现 src/index.js，Fastify 服务，19 个 REST 端点
- **Acceptance Criteria Addressed**: AC-2, AC-6
- **Test Requirements**:
  - `programmatic` TR-20.1: 所有 REST 端点正常响应
  - `programmatic` TR-20.2: /api/health 正常返回

## [x] Task 21: API 服务层 - MCP 服务
- **Priority**: P0
- **Depends On**: Task 20
- **Description**: 
  - 实现 src/mcp-server.js，16 个 MCP 工具
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-21.1: MCP 工具功能正常

## [x] Task 22: Facade 层
- **Priority**: P0
- **Depends On**: Task 21
- **Description**: 
  - 实现 facades/search.js
  - 实现 facades/memory.js
  - 实现 facades/health.js
  - 实现 facades/benchmark.js
  - 实现 src/knowledge-base.js
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4
- **Test Requirements**:
  - `programmatic` TR-22.1: Facade 接口完整

## [x] Task 23: 可观测性
- **Priority**: P1
- **Depends On**: Task 22
- **Description**: 
  - 实现 observability/query-exporter.js
  - 实现 observability/runtime-stats.js
  - 实现 observability/health-snapshot.js
  - 实现 observability/benchmark.js
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-23.1: 可观测性功能正常

## [x] Task 24: 运维脚本
- **Priority**: P1
- **Depends On**: Task 23
- **Description**: 
  - 实现 scripts/start-http.sh
  - 实现 scripts/start-mcp.sh
  - 实现 scripts/healthcheck.sh
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-24.1: 脚本可以正常执行

## [ ] Task 25: 集成与性能测试
- **Priority**: P0
- **Depends On**: Task 24
- **Description**: 
  - 编写测试用例
  - 验证 API 响应一致性
  - 验证搜索延迟 < 150ms
- **Acceptance Criteria Addressed**: AC-2, AC-5
- **Test Requirements**:
  - `programmatic` TR-25.1: 所有测试通过
  - `programmatic` TR-25.2: 搜索延迟满足要求

## Task Dependencies
- Task 2-14 依赖 Task 1（初始化）
- Task 15-17 依赖 Task 2（配置）
- Task 18-24 依赖之前的核心模块
- Task 25 依赖所有功能模块
