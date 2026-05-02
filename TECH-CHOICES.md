# 技术选型深度解析

> 本文采用"技术小白提问 + 架构师回答"的对话形式，逐层剥开 `openclaw-engine-js` 的每一个技术决策。
>
> **目标读者**：对技术感兴趣的产品/运维人员，以及刚接触本项目的开发者。
> **阅读建议**：每节相对独立，跳读不影响理解。建议先看决策矩阵速查表，再按需深入。

---

## 人物设定

- **小白**：刚入职的后端新人，会写 Node.js，对 AI 和知识检索完全没概念
- **架构师**：十年经验，负责本项目核心架构，说话直率

---

## 决策矩阵速查表

| 领域 | 选型 | 一句话理由 | 备选方案 | 关键指标 |
|------|------|-----------|----------|----------|
| 语言 | Node.js | 同语言通信、部署简单、内存低 | Python | ~50MB vs ~200MB |
| 架构 | 单服务 | 运维成本低、故障点少 | 微服务 (3进程) | 1进程 vs 3进程 |
| 搜索 | BM25 + 4因子融合 | 中文友好、<5ms、可解释 | 向量检索 | 内存索引 vs 向量库 |
| 分词 | bigram + jieba | 零依赖默认 + 可选增强 | jieba必需 | auto模式自动降级 |
| 记忆模型 | weight-based | 精细生命周期、递减衰减 | 2态/7态 | STRONG/MEDIUM/WEAK |
| 实体 | 正则+词典提取 | 零依赖、够用 | LLM提取 | <1ms vs 10s |
| HTTP 框架 | Fastify | 性能高、内置验证、Pino日志 | Express | 快2-3倍 |
| 数据库 | better-sqlite3 | 零部署、同步API、WAL模式 | PostgreSQL | ~5MB vs ~100MB+ |
| 治理比较 | 词法匹配 + LLM兜底 | 零依赖、优雅降级 | 纯LLM | 10秒超时保护 |
| 日志 | Pino(HTTP) + Winston(业务) | 各司其职 | 单一库 | Pino最快 |
| 认证 | Bearer Token + Unix Socket | 简单、轻量、本地免密 | OAuth2/JWT | 10行代码 |

---

## 一、全局架构选型

### 1.1 为什么是 Node.js 而不是 Python？

**小白**：之前的上下文引擎是 Python 写的，为什么重写成 Node.js？

**架构师**：三个核心原因：

| 维度 | Node.js | Python |
|------|---------|--------|
| 部署复杂度 | `npm install` + `node src/index.js` | 需要 Python 虚拟环境 + pip 依赖 |
| 与主程序通信 | 同语言直接 HTTP 调用，无序列化开销 | 需要跨进程通信（HTTP/gRPC） |
| 内存占用 | ~50MB | ~200MB（含 ChromaDB 客户端） |
| 数据科学生态 | 不需要 numpy/pandas | 生态丰富但本项目用不上 |

**小白**：那 Node.js 有什么劣势吗？

**架构师**：
- 数据科学生态不如 Python（但本项目不需要）
- CPU 密集型任务不如 Python C 扩展（但本项目是 I/O 密集型）
- 中文 NLP 工具链不如 Python 丰富（但我们用 jieba 的 Node.js 绑定够用）

**结论**：本项目是 I/O 密集型，不需要复杂 NLP，Node.js 生态完全够用。

---

### 1.2 为什么是单服务而不是微服务？

**小白**：之前是三服务协作（ChromaDB + Embedding 服务 + 主服务），为什么改成单服务？

**架构师**：因为三服务架构的运维成本远大于收益：

| 维度 | 旧架构（三服务） | 当前架构（单服务） |
|------|----------------|----------------|
| 进程数 | 3（ChromaDB + Embedding + 主服务） | 1 |
| 端口占用 | 3（8000 + 8902 + 8901） | 1（8901）+ 可选 Unix Socket |
| 内存占用 | ~700MB（含 ChromaDB + Python） | ~50MB |
| 部署 | systemd 三服务链 | systemd 单服务 |
| 故障点 | 3 个进程都可能挂 | 1 个进程 |

**小白**：单服务不能水平扩展怎么办？

**架构师**：本项目数据量在 GB 级别以内，单进程完全够用。如果未来需要扩展，可以拆分为读写分离，但目前没必要。

---

### 1.3 为什么用 BM25 替代 LIKE 查询？

**小白**：之前用 SQL LIKE 搜索，为什么要换成 BM25？

**架构师**：LIKE 查询有几个问题：

| 问题 | LIKE 查询 | BM25 |
|------|----------|------|
| 中文支持 | 需要 bigram 扩展 | 原生支持分词 |
| 排序 | 只能按时间排序 | 按相关度排序 |
| 布尔查询 | 不支持 | 支持 +/-/"" |
| 性能 | 全表扫描 | 内存索引 <5ms |

**小白**：BM25 是什么？

**架构师**：BM25（Best Matching 25）是一种经典的文本检索算法，核心思想是：
1. **词频（TF）**：一个词在文档中出现越多，越相关
2. **逆文档频率（IDF）**：一个词在越少文档中出现，越有区分度
3. **文档长度归一化**：短文档的词频权重更高

**我们的实现**：
```
finalScore = bm25Norm × 0.5 + positionScore × 0.1 + recency × 0.3 + weightBoost × 0.1
```

| 因子 | 权重 | 说明 |
|------|------|------|
| bm25Norm | 50% | BM25 分数归一化 |
| positionScore | 10% | 首次匹配位置越前越相关 |
| recency | 30% | 时间衰减（30天半衰期） |
| weightBoost | 10% | STRONG=1.5, MEDIUM=1.0, WEAK=0.5 |

**结论**：BM25 搜索更准确、更快、功能更强。

---

### 1.4 为什么用 bigram + jieba 双模式分词？

**小白**：中文分词为什么不用一个方案？

**架构师**：因为没有完美方案，只有权衡：

| 方案 | 优点 | 缺点 |
|------|------|------|
| bigram | 零依赖、永远可用 | 分词质量一般（"微服务"→"微服","服务"） |
| jieba | 分词质量好 | 需要安装、可能失败 |

**小白**：那怎么选择？

**架构师**：用 `auto` 模式：
1. 启动时检测 jieba 是否可用
2. 可用就用 jieba，打印日志 `[tokenizer] jieba loaded`
3. 不可用就 fallback 到 bigram，打印警告

```javascript
// 环境变量控制
TOKENIZER_MODE=auto   // 默认：自动选择
TOKENIZER_MODE=jieba  // 强制用 jieba（失败报错）
TOKENIZER_MODE=bigram // 强制用 bigram
```

**结论**：零依赖是底线，可选增强是加分。

---

### 1.5 为什么用 weight-based 生命周期替代 2 态模型？

**小白**：之前 tentative/kept 两个状态就够用，为什么要改成 STRONG/MEDIUM/WEAK？

**架构师**：2 态模型太粗：

| 问题 | 2 态模型 | weight-based |
|------|---------|-------------|
| 衰减 | tentative 7天一刀切 | 递减：14天→7天→3天 |
| 分类 | 无 | category: fact/preference/project/instruction/episodic |
| 免疫 | 无 | instruction 永不降级，preference+STRONG 永不降级 |
| 审核 | tentative 进 Review Queue | WEAK 进 Review Queue |

**小白**：递减衰减是什么意思？

**架构师**：越弱的记忆衰减越快：
```
STRONG → 14天 → MEDIUM → 7天 → WEAK → 3天 → 删除
总生存期：24天

MEDIUM → 7天 → WEAK → 3天 → 删除
总生存期：10天

WEAK → 3天 → 删除
总生存期：3天
```

**小白**：为什么要这样设计？

**架构师**：
- STRONG 记忆（用户确认的偏好）应该长期保留
- WEAK 记忆（临时提取的）应该快速清理
- 中间的 MEDIUM 给一个合理的过渡期

---

### 1.6 为什么要实体链接？

**小白**：记忆系统为什么要提取实体？

**架构师**：因为扁平记忆→结构化知识：

| 维度 | 扁平记忆 | 实体链接 |
|------|---------|---------|
| 查询 | 只能搜内容 | 可以搜实体关联 |
| 关联 | 无 | 通过实体关联不同记忆 |
| 精准度 | 返回整条记忆 | 返回单条观察 |

**小白**：实体提取准确吗？

**架构师**：用正则+词典，不是 LLM：

```javascript
const TECH_PATTERNS = [
  /(?:React|Vue|Kubernetes|Docker|PostgreSQL)/gi,
  /(?:Node\.js|Python|Go|Rust)/gi,
];
```

**优势**：
- 零依赖，不需要 LLM
- <1ms，实时提取
- 可预测，不会误判

**劣势**：
- 只能提取已知模式
- 不支持歧义消解

**结论**：对于技术文档，正则+词典够用。

---

## 二、HTTP 框架选型：Fastify vs Express

**小白**：API 层为什么用 Fastify 而不是 Express？

**架构师**：

| 维度 | Fastify | Express |
|------|---------|---------|
| 性能 | 比 Express 快 2-3 倍 | 够用但不是最快 |
| Schema 验证 | 内置 JSON Schema 验证 | 需要额外中间件 |
| 插件系统 | 封装性好，作用域隔离 | 中间件全局共享 |
| 日志 | 内置 Pino（最快的 Node.js 日志库） | 需要自行集成 |

**结论**：性能优势明显，内置验证和日志，插件作用域隔离。

---

## 三、数据库选型：SQLite (better-sqlite3) vs PostgreSQL/Redis

**小白**：为什么用 SQLite 而不是 PostgreSQL 或 Redis？

**架构师**：

| 维度 | better-sqlite3 | PostgreSQL | Redis |
|------|---------------|------------|-------|
| 部署 | 零配置，文件即数据库 | 需要独立服务 | 需要独立服务 |
| 内存 | ~5MB | ~100MB+ | ~50MB+ |
| 事务 | 完整 ACID | 完整 ACID | 有限事务 |
| 并发 | 单写多读（WAL 模式） | 多写多读 | 单线程 |

**小白**：SQLite 有什么劣势吗？

**架构师**：
- 单写：同一时刻只能有一个写操作（但本项目写操作频率低）
- 不支持多进程写入（本项目单进程，无此问题）
- 不适合超大数据集（本项目数据量在 GB 级别以内）

**关键实现**：
- WAL 模式：启动时自动启用
- Prepared Statement 缓存：避免重复编译 SQL
- 幂等迁移：`_ensureColumns` 只添加缺失的列

---

## 四、搜索方案选型：BM25 vs 向量检索

### 4.1 为什么放弃向量检索？

**小白**：向量检索不是更智能吗？为什么要换成 BM25？

**架构师**：向量检索有几个问题：

| 问题 | 说明 |
|------|------|
| 中文效果差 | MiniLM-L6-v2 中文效果极差 |
| 依赖重 | 28MB 模型 + 300MB 内存 |
| 不可解释 | 相似度分数无法解释 |
| 误匹配多 | "帧同步"可能匹配"同步帧率" |

**小白**：BM25 不会误匹配吗？

**架构师**：BM25 是精确匹配，不会出现语义相似但实际不同的情况。而且我们有 4 因子融合排序：
- bm25Norm：语义相关度
- positionScore：位置越前越相关
- recency：时间衰减
- weightBoost：权重加成

**结论**：对于 <200 条记忆，BM25 比向量检索更准确、更快、更可控。

### 4.2 布尔查询

**小白**：布尔查询是什么？

**架构师**：用符号控制搜索逻辑：

```
+部署          必须包含"部署"
-deprecated    必须排除"deprecated"
"Kubernetes"   精确短语匹配
category:fact  按分类过滤
weight:STRONG  按权重过滤
```

**实现**：`query-parser.js` 解析查询字符串，返回结构化条件。

### 4.3 Wiki 搜索为什么不用 BM25？

**架构师**：Wiki 页面太少（~24 页），BM25 的 IDF 区分度极低。简单词频匹配够用。

**未来**：当 wiki 页面超过 200 页时，自动升级为 BM25。

---

## 五、记忆模型选型：weight-based 生命周期

### 5.1 为什么用 weight 替代 state？

**小白**：之前 tentative/kept 两个状态，为什么要改成 STRONG/MEDIUM/WEAK？

**架构师**：2 态模型太粗，无法区分记忆的重要性：

| 场景 | 2 态模型 | weight-based |
|------|---------|-------------|
| 用户确认的偏好 | kept（永久） | STRONG + preference（永不降级） |
| 临时提取的事实 | tentative（7天） | WEAK（3天衰减） |
| 用户明确要求 | kept（永久） | STRONG（14天衰减） |

### 5.2 AutoTriage 智能分类

**小白**：AutoTriage 是什么？

**架构师**：自动从对话中提取记忆，并根据信号强度分配 weight：

```
TRIAGE_CONFIRM_SIGNALS 匹配 → STRONG (自动确认)
用户显式请求 → MEDIUM (需确认)
知识断言 → MEDIUM (需确认)
其他 → WEAK (3天衰减)
```

### 5.3 衰减 GC

**小白**：记忆会自动删除吗？

**架构师**：会，按递减规则：

```
STRONG → 14天 → MEDIUM → 7天 → WEAK → 3天 → 删除
```

**免疫规则**：
- instruction 类别：永不降级
- preference + STRONG：永不降级

### 5.4 Review Queue

**小白**：用户怎么审核记忆？

**架构师**：WEAK 记忆进入 Review Queue：

```bash
# 查看待审核记忆
curl http://127.0.0.1:8901/api/memory/reviews

# 确认记忆（WEAK → STRONG）
curl -X POST http://127.0.0.1:8901/api/memory/reviews/:id/confirm

# 丢弃记忆（硬删除）
curl -X POST http://127.0.0.1:8901/api/memory/reviews/:id/discard
```

---

## 六、治理系统选型：词法匹配 vs LLM 语义比较

**小白**：保存记忆时，如果和已有记忆冲突怎么办？

**架构师**：`governance.js` 负责冲突检测和策略规划。分两步：

### 第一步：四维重叠检测

| 维度 | 权重 | 检测方式 |
|------|------|---------|
| alias 重叠 | 0.35 | 别名集合是否有交集 |
| path 重叠 | 0.25 | path_hints 集合是否有交集 |
| collection 重叠 | 0.15 | collection_hints 集合是否有交集 |
| token 重叠 | 0.10 | 分词后 token 集合交集 |
| 文本包含 | 0.15 | 一方内容是否包含另一方 |

### 第二步：策略选择

| 策略 | 触发条件 | 行为 |
|------|---------|------|
| `keep_existing` | 同主题 + 语义相同 | 保留旧记忆 |
| `supersede_existing` | 同主题 + 新内容更完整 | 新记忆替代旧记忆 |
| `resolve_conflict` | 同主题 + 语义冲突 | 标记冲突 |
| `create_new` | 不同主题 | 直接创建 |

### LLM 语义比较（可选）

配置 `SIDE_LLM_GATEWAY_URL` 后，调用 LLM 判断两条记忆是否表达同一意图。

**优势**：默认零依赖，LLM 不可用时自动降级为词法匹配。

---

## 七、Wiki 编译选型：LLM Wiki vs 传统 RAG

**小白**：LLM Wiki 具体怎么工作的？

**架构师**：四步走：

1. **detectChanges**：扫描源文件，对比 SHA256 hash
2. **编译**：Agent 将原始材料编译为结构化 wiki 页面
3. **saveWikiPage**：保存到 wiki/ 目录
4. **updateIndex**：刷新总索引

**选择**：Karpathy LLM Wiki 模式

**优势**：
- 人可读：wiki 页面是标准 Markdown
- 机可查：Agent 可以用 `wiki_search` 搜索
- 易维护：只需要维护 Markdown 文件

**劣势**：
- 编译需要 LLM
- 搜索精度有限（页面少时）

---

## 八、日志选型：Winston vs Pino

**小白**：项目里同时用了 Winston 和 Pino，为什么？

**架构师**：它们各管各的：

| 日志库 | 用途 | 位置 |
|--------|------|------|
| Winston | 业务逻辑日志 | `config.js` 导出的 `logger` |
| Pino | HTTP 请求日志 | Fastify 自动管理 |

**结论**：各司其职，互不干扰。

---

## 九、配置管理选型：dotenv + 环境变量

**小白**：配置为什么用环境变量而不是 JSON/YAML 配置文件？

**架构师**：

| 维度 | 环境变量 | 配置文件 |
|------|---------|---------|
| 部署灵活性 | 容器/系统原生支持 | 需要额外挂载 |
| 敏感信息 | 不容易意外提交 | 容易误提交密钥 |

**结论**：12-Factor App 标准做法，敏感信息不进代码仓库。

---

## 十、认证方案选型：Bearer Token + Unix Socket

**小白**：API 认证是怎么做的？

**架构师**：轻量级 Bearer Token 方案：

- 配置 `OPENCLAW_API_SECRET` 后，所有 HTTP 请求必须携带 Token
- Unix Socket 连接自动注入 Token，无需手动传参

**优势**：实现简单，10 行代码，兼容性好。

---

## 十一、技术选型原则总结

1. **务实优先**：BM25 + SQLite 是经过验证的技术
2. **最小依赖**：单服务架构，7 个必需依赖 + 1 个可选依赖
3. **人机协作**：LLM Wiki 的 Markdown 格式让人和 AI 都能读写
4. **可观测性**：健康检查、结构化日志、Metrics 端点
5. **简化优先**：weight-based 模型比 7 态好维护
6. **优雅降级**：jieba 不可用时 fallback 到 bigram
7. **安全默认**：路径遍历防护、Bearer Token 认证
8. **数据安全**：Graceful Shutdown 确保 WAL 数据不丢失

---

## 附录 A：速查卡（出问题先看哪里）

| 问题现象 | 排查方式 | 相关章节 |
|---------|---------|---------|
| 搜不到记忆 | 检查 BM25 索引日志 | 四 |
| 服务起不来 | `journalctl --user -u openclaw-context-engine` | - |
| 中文分词差 | 检查 jieba 是否安装 | 1.4 |
| 记忆被误删 | 检查 weight 和 category | 5.1 |
| 治理误判 | 检查 LLM 网关配置 | 六 |
| 实体未提取 | 检查正则模式 | - |
| Unix Socket 连不上 | 检查 `/tmp/openclaw-engine.sock` | 十 |
| 认证失败 | 检查 `OPENCLAW_API_SECRET` | 十 |

---

## 附录 B：依赖清单

| 依赖 | 版本 | 类型 | 说明 |
|------|------|------|------|
| `fastify` | ^4.26.0 | 必需 | HTTP 框架 |
| `better-sqlite3` | ^9.4.0 | 必需 | SQLite 绑定 |
| `pino` | ^8.19.0 | 必需 | HTTP 日志 |
| `dotenv` | ^16.4.0 | 必需 | 环境变量加载 |
| `uuid` | ^9.0.1 | 必需 | UUID 生成 |
| `zod` | ^3.22.4 | 必需 | Schema 验证 |
| `rate-limiter-flexible` | ^11.0.1 | 必需 | API 速率限制 |
| `@node-rs/jieba` | - | 可选 | 中文分词增强 |

---

*本文档最后更新：2026-05-03*
*反映 v3.3 weight-based + BM25 + 实体链接架构*
