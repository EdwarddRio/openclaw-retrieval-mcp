/**
 * 布尔查询解析器
 * 支持 +/-/"" /category: /weight: 语法
 */

/**
 * 解析查询词
 * @typedef {Object} ParsedTerm
 * @property {string} term - 词文本
 * @property {'required'|'excluded'|'optional'} modifier - 修饰符
 * @property {boolean} isPhrase - 是否精确短语
 * @property {string|null} fieldFilter - 字段过滤 (category/weight)
 * @property {string|null} fieldValue - 字段值
 */

/**
 * 解析布尔查询
 * @param {string} query - 查询字符串
 * @returns {{ required: string[], excluded: string[], optional: string[], fieldFilters: Object, phraseTerms: string[] }}
 */
export function parseQuery(query) {
  if (!query || !query.trim()) {
    return { required: [], excluded: [], optional: [], fieldFilters: {}, phraseTerms: [] };
  }

  const required = [];
  const excluded = [];
  const optional = [];
  const fieldFilters = {};
  const phraseTerms = [];

  // 匹配引号包裹的短语、+/-前缀词、field:value、普通词
  const tokenRegex = /([+-]?)"([^"]+)"|([+-]?)(\w+:\w+)|([+-]?)(\S+)/g;
  let match;

  while ((match = tokenRegex.exec(query)) !== null) {
    const phraseWithMod = match[1]; // +/- before quote
    const phraseContent = match[2]; // content inside quotes
    const fieldWithMod = match[3]; // +/- before field:value
    const fieldValue = match[4];    // field:value
    const wordWithMod = match[5];   // +/- before word
    const word = match[6];          // plain word

    if (phraseContent !== undefined) {
      // 短语匹配
      const modifier = phraseWithMod || '';
      if (modifier === '+') {
        required.push(phraseContent);
      } else if (modifier === '-') {
        excluded.push(phraseContent);
      } else {
        optional.push(phraseContent);
      }
      phraseTerms.push(phraseContent);
    } else if (fieldValue !== undefined) {
      // 字段过滤 (category:xxx, weight:xxx)
      const [field, value] = fieldValue.split(':');
      if (['category', 'weight'].includes(field)) {
        fieldFilters[field] = value;
      }
    } else if (word !== undefined) {
      // 普通词
      const modifier = wordWithMod || '';
      if (modifier === '+') {
        required.push(word);
      } else if (modifier === '-') {
        excluded.push(word);
      } else {
        optional.push(word);
      }
    }
  }

  return { required, excluded, optional, fieldFilters, phraseTerms };
}

/**
 * 检查文档是否匹配字段过滤
 * @param {Object} doc - 文档对象
 * @param {Object} fieldFilters - 字段过滤条件
 * @returns {boolean}
 */
export function matchesFieldFilters(doc, fieldFilters) {
  if (!fieldFilters || Object.keys(fieldFilters).length === 0) return true;
  
  for (const [field, value] of Object.entries(fieldFilters)) {
    if (field === 'category' && doc.category !== value) return false;
    if (field === 'weight' && doc.weight !== value) return false;
  }
  
  return true;
}

/**
 * 检查文档是否包含精确短语
 * @param {string} content - 文档内容
 * @param {string[]} phraseTerms - 短语列表
 * @returns {boolean}
 */
export function matchesPhrases(content, phraseTerms) {
  if (!phraseTerms || phraseTerms.length === 0) return true;
  
  const contentLower = content.toLowerCase();
  return phraseTerms.every(phrase => contentLower.includes(phrase.toLowerCase()));
}

export default { parseQuery, matchesFieldFilters, matchesPhrases };
