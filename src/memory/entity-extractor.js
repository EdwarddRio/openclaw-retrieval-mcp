/**
 * 实体提取器 - 使用正则+词典提取实体
 * 支持中文和英文实体识别
 */

import crypto from 'crypto';

// ========== 实体提取规则 ==========

/** 技术实体模式 */
const TECH_PATTERNS = [
  // 编程语言
  /(?:JavaScript|TypeScript|Python|Java|Go|Rust|C\+\+|Ruby|PHP|Swift|Kotlin)/gi,
  // 框架
  /(?:React|Vue|Angular|Next\.js|Nuxt|Express|Fastify|Django|Flask|Spring)/gi,
  // 数据库
  /(?:PostgreSQL|MySQL|SQLite|MongoDB|Redis|Elasticsearch|ClickHouse)/gi,
  // 容器/云
  /(?:Docker|Kubernetes|K8s|AWS|Azure|GCP|Cloudflare|Vercel)/gi,
  // 工具
  /(?:Git|GitHub|GitLab|CI\/CD|Jenkins|GitHub Actions|Terraform)/gi,
  // AI/ML
  /(?:LLM|GPT|Claude|Gemini|OpenAI|Anthropic|Hugging Face|TensorFlow|PyTorch)/gi,
  // 其他技术
  /(?:Node\.js|Bun|Deno|npm|yarn|pnpm|Webpack|Vite|ESBuild)/gi,
];

/** 项目实体模式 */
const PROJECT_PATTERNS = [
  /项目[：:]\s*(\S+)/g,
  /(?:项目|系统|平台|服务|应用)\s*[：:]?\s*["""]([^"""]+)["""]/g,
  /(?:Project|System|Platform|Service)\s*[：:]?\s*["""]([^"""]+)["""]/gi,
];

/** 概念实体模式 */
const CONCEPT_PATTERNS = [
  /(?:微服务|容器化|CI\/CD|灰度发布|知识图谱|机器学习|深度学习|自然语言处理)/gi,
  /(?:负载均衡|缓存|消息队列|事件驱动|领域驱动|六边形架构)/gi,
  /(?:DevOps|MLOps|AIOps|DataOps|GitOps|Platform Engineering)/gi,
];

/** 人物实体模式 */
const PERSON_PATTERNS = [
  /@(\w+)/g,
  /(?:用户|同学|老师|师傅|大佬)[\s]*[：:]?\s*(\S+)/g,
];

// ========== 停用词 ==========

/** 不应作为实体的停用词 */
const ENTITY_STOPWORDS = new Set([
  '这个', '那个', '这样', '那样', '什么', '怎么', '为什么',
  '可以', '应该', '必须', '需要', '不是', '没有', '已经',
  'this', 'that', 'what', 'how', 'why', 'can', 'should',
]);

// ========== 提取函数 ==========

/**
 * 从内容中提取实体
 * @param {string} content - 文本内容
 * @returns {Array<{name: string, type: string, observation: string}>} 提取的实体列表
 */
export function extractEntities(content) {
  if (!content || content.length < 10) return [];
  
  const entities = [];
  const seen = new Set();
  
  // 1. 提取技术实体
  for (const pattern of TECH_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const name = match[0].trim();
      if (name && !ENTITY_STOPWORDS.has(name) && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({
          name,
          type: 'tech',
          observation: extractObservation(content, name),
        });
      }
    }
  }
  
  // 2. 提取项目实体
  for (const pattern of PROJECT_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const name = (match[1] || match[2] || '').trim();
      if (name && name.length >= 2 && !ENTITY_STOPWORDS.has(name) && !seen.has(name)) {
        seen.add(name);
        entities.push({
          name,
          type: 'project',
          observation: extractObservation(content, name),
        });
      }
    }
  }
  
  // 3. 提取概念实体
  for (const pattern of CONCEPT_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const name = match[0].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        entities.push({
          name,
          type: 'concept',
          observation: extractObservation(content, name),
        });
      }
    }
  }
  
  // 4. 提取人物实体
  for (const pattern of PERSON_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const name = (match[1] || match[2] || '').trim();
      if (name && name.length >= 2 && !ENTITY_STOPWORDS.has(name) && !seen.has(name)) {
        seen.add(name);
        entities.push({
          name,
          type: 'person',
          observation: extractObservation(content, name),
        });
      }
    }
  }
  
  return entities;
}

/**
 * 提取实体在内容中的观察（上下文）
 * @param {string} content - 原始内容
 * @param {string} entityName - 实体名称
 * @returns {string} 观察内容
 */
function extractObservation(content, entityName) {
  const idx = content.indexOf(entityName);
  if (idx < 0) return '';
  
  // 提取实体周围的上下文（前后各50字）
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + entityName.length + 50);
  const context = content.slice(start, end).trim();
  
  return context;
}

/**
 * 生成实体 ID（基于名称和类型）
 * @param {string} name - 实体名称
 * @param {string} type - 实体类型
 * @returns {string} 实体 ID
 */
export function generateEntityId(name, type) {
  const normalized = `${type}:${name.toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export default { extractEntities, generateEntityId };
