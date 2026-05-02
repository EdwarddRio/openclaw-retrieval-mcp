# 测试运行手册

## 快速开始

```bash
cd /root/.openclaw/openclaw-engine-js
npm test
```

## 测试分组

| 测试文件 | 覆盖范围 | 依赖 |
|---------|---------|------|
| `tests/benchmark.test.js` | 基准测试框架 | — |
| `tests/bm25.test.js` | BM25 搜索算法 | — |
| `tests/contract.test.js` | API 契约模型 | — |
| `tests/governance.test.js` | 治理流程 | `LocalMemoryStore` |
| `tests/integration-memory.test.js` | 端到端记忆流程 | `LocalMemoryStore` |
| `tests/integration.test.js` | HTTP 集成（需服务运行） | 运行中的服务 |
| `tests/memory-edge-cases.test.js` | 边界条件与错误处理 | `LocalMemoryStore` |
| `tests/memory.test.js` | 本地记忆核心功能 | `LocalMemoryStore` |
| `tests/middleware.test.js` | 中间件单元测试 | — |
| `tests/performance.test.js` | 性能基准 | `LocalMemoryStore` |
| `tests/routes.test.js` | 路由模块结构 | — |
| `tests/sanitize.test.js` | 查询净化 | — |
| `tests/validation.test.js` | 请求校验 | — |
| `tests/wiki.test.js` | Wiki 编译器 | — |

## 测试隔离

所有使用 `LocalMemoryStore` 的测试必须使用**独立临时目录**：

```js
const TEST_ROOT_DIR = path.join(process.cwd(), 'tests', 'unique-test-root');

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT_DIR, { recursive: true });
  memory = new LocalMemoryStore({ rootDir: TEST_ROOT_DIR });
});

afterEach(() => {
  memory.close();
  fs.rmSync(TEST_ROOT_DIR, { recursive: true, force: true });
});
```

## CI 建议

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
```

## 覆盖率

```bash
# 使用 Node.js 原生覆盖率
node --test --experimental-test-coverage tests/**/*.test.js
```
