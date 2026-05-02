# Context Engine 数据库运维手册

## 数据库位置

- **生产数据库**: `runtime/localmem/context-engine.db`
- **WAL 文件**: `runtime/localmem/context-engine.db-wal`
- **备份目录**: `workspace/memory/audit/context-engine-backup/`

## 常用操作

### 手动备份

```bash
cd /root/.openclaw/workspace
./scripts/context-engine-backup.sh
```

### 手动恢复

```bash
cd /root/.openclaw/workspace
./scripts/context-engine-restore.sh
# 按提示选择备份文件
```

### 数据库完整性检查

```bash
sqlite3 runtime/localmem/context-engine.db "PRAGMA integrity_check;"
```

### WAL Checkpoint

```bash
sqlite3 runtime/localmem/context-engine.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

## 故障诊断

### 中间件错误

- **现象**: 请求返回 500，日志中出现 `AppError`
- **排查**: 检查 `src/middleware/error-handler.js` 中的错误分类
- **修复**: 根据 `errorType` 定位具体路由或中间件

### BM25 索引重建

- **现象**: `/api/wiki/search` 返回空结果或延迟高
- **排查**: 检查 `runtime/localmem/index_manifest.json` 是否存在
- **修复**: 调用 `POST /api/wiki/detect-changes` + `POST /api/wiki/compile-prompt`

### 中文搜索召回不足

- **现象**: 中文查询返回结果过少
- **排查**: 检查 `MEMORY_SEARCH_MODE` 环境变量
- **修复**: 设置为 `or-first`（中文）或 `and-first`（英文）

## 表结构

| 表名 | 用途 |
|------|------|
| `sessions` | 对话会话 |
| `turns` | 单轮对话 |
| `memory_items` | 记忆事实 |
| `memory_events` | 记忆事件（如 autoTriage 禁用） |
| `memory_aliases` | 记忆别名 |
