# OpenClaw Context Engine - JavaScript 重写 Spec

## Overview

* **Summary**: 将现有的 Python 实现的 openclaw-context-engine 完全重写为 JavaScript/Node.js 版本，保持 API 完全兼容

* **Purpose**: 用 Node.js 重写以满足技术栈统一、部署简化等需求，同时保持与现有 OpenClaw 主程序无缝对接

* **Target Users**: OpenClaw 项目开发者和最终用户

## Goals

* 用 JavaScript/Node.js 完全重写约 14,689 行 Python 代码

* 保持 API 完全兼容（19 个 REST 端点 + 16 个 MCP 工具）

* 使用 ChromaDB 作为向量存储

* 通过 HTTP API 复用现有的 Python Embedding 服务

* 实现完整的检索系统、记忆系统和可观测性功能

## Non-Goals (Out of Scope)

* 修改现有 OpenClaw 主程序的调用代码

* 重写 Embedding 模型（复用 Python 服务）

* 增加超出原始系统的新功能

## Background & Context

当前系统是一个 Python 实现的上下文管理和知识检索服务，包含约 14,689 行代码，支持文件扫描、内容索引、混合检索（向量 + BM25）、记忆管理等功能。

## Functional Requirements

* **FR-1**: 项目初始化，创建新目录结构和 package.json

* **FR-2**: 基础设施层（配置管理、ChromaDB 客户端、Embedding HTTP 客户端、BM25 实现）

* **FR-3**: 核心检索系统（文件扫描、内容加载、分词、索引、检索、查询规划、融合排序、MMR 去冗）

* **FR-4**: 记忆系统（SQLite 存储、CRUD、时间线、自动沉淀、LLM 网关）

* **FR-5**: API 服务层（Fastify HTTP 服务、MCP 服务）

* **FR-6**: Facade 层（搜索、记忆、健康、基准）

* **FR-7**: 可观测性（查询导出、运行统计、健康快照、基准测试）

* **FR-8**: 运维脚本（启动、健康检查）

## Non-Functional Requirements

* **NFR-1**: 搜索延迟目标 < 150ms

* **NFR-2**: API 响应与原 Python 版本完全一致

* **NFR-3**: 内存占用合理

* **NFR-4**: 代码结构清晰，易于维护

## Constraints

* **Technical**: Node.js、Fastify、ChromaDB、SQLite、nodejieba、@modelcontextprotocol/sdk

* **Dependencies**: 现有的 Python Embedding 服务（用于向量生成）

## Assumptions

* Python Embedding 服务的 API 保持稳定

* ChromaDB JS SDK 可用且功能完整

* 现有 OpenClaw 主程序调用 API 的方式保持不变

## Acceptance Criteria

### AC-1: 项目初始化成功

* **Given**: 新目录已创建

* **When**: 执行 npm install

* **Then**: 所有依赖安装成功，项目结构完整

* **Verification**: programmatic

### AC-2: API 兼容性

* **Given**: JavaScript 服务已启动

* **When**: 发送与原 Python 服务相同的请求

* **Then**: 响应格式和内容与原服务完全一致

* **Verification**: programmatic

### AC-3: 检索功能完整

* **Given**: 索引已构建

* **When**: 执行搜索请求

* **Then**: 返回正确的结果，排序与原系统一致

* **Verification**: programmatic

### AC-4: 记忆功能完整

* **Given**: 记忆系统已初始化

* **When**: 执行记忆 CRUD 操作

* **Then**: 操作成功，数据持久化正确

* **Verification**: programmatic

### AC-5: 性能满足要求

* **Given**: 系统正常运行

* **When**: 执行搜索请求

* **Then**: 响应时间 < 150ms

* **Verification**: programmatic

### AC-6: 健康检查可用

* **Given**: 服务已启动

* **When**: 访问 /api/health

* **Then**: 返回健康状态

* **Verification**: programmatic

## Open Questions

* [ ] Python Embedding 服务的具体 API 端点是什么？

