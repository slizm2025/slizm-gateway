import { parseDocument, isMap } from 'yaml';
import { parseForESLint, getStaticTOMLValue } from 'toml-eslint-parser';
import { fail } from './agent-files.js';

export function detectBomAndEol(text) {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const raw = hasBom ? text.slice(1) : text;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { hasBom, eol, cleanText: raw };
}

export function parseClaudeMarkdown(content) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  const match = cleanText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw fail('文件缺少规范的 YAML frontmatter 边界 (---)', 400);
  }
  const rawFrontmatter = match[1];
  const doc = parseDocument(rawFrontmatter);
  if (doc.errors && doc.errors.length > 0) {
    const pos = doc.errors[0].linePos ? `第 ${doc.errors[0].linePos[0].line} 行` : '';
    throw fail(`YAML frontmatter 语法错误 ${pos}`.trim(), 400);
  }
  if (!isMap(doc.contents) && doc.contents !== null) {
    throw fail('YAML frontmatter 根节点必须是键值映射对象', 400);
  }
  const json = doc.toJSON() || {};
  const bodyOffset = match[0].length;
  const prompt = cleanText.slice(bodyOffset);
  return {
    frontmatter: json,
    prompt,
    hasBom,
    eol,
    rawFrontmatter,
    bodyOffset,
  };
}

export function updateClaudeMarkdown(content, updates = {}, newPrompt = null) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  const match = cleanText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw fail('原文件缺少规范的 YAML frontmatter 边界，不可写入', 400);
  }
  const doc = parseDocument(match[1]);
  if (doc.errors && doc.errors.length > 0) {
    throw fail('原文件 YAML frontmatter 损坏，不可写入', 400);
  }
  const body = newPrompt !== null && newPrompt !== undefined ? newPrompt : cleanText.slice(match[0].length);
  for (const [key, val] of Object.entries(updates)) {
    if (JSON.stringify(doc.get(key)?.toJSON?.() ?? doc.get(key)) === JSON.stringify(val)) continue;
    if (val === null || val === undefined) {
      doc.delete(key);
    } else {
      doc.set(key, val);
    }
  }
  let yamlStr = doc.toString().replace(/\r?\n/g, eol);
  if (!yamlStr.endsWith(eol)) yamlStr += eol;
  const frontStr = '---' + eol + yamlStr + '---' + eol;
  const bodyStr = body ? body.replace(/\r?\n/g, eol) : '';
  const res = (hasBom ? '\ufeff' : '') + frontStr + bodyStr;
  parseClaudeMarkdown(res); // 写入前自检
  return res;
}

export function serializeClaudeMarkdown({ name, description, model, tools, prompt = '', eol = '\n', hasBom = false }) {
  const doc = parseDocument('');
  if (name) doc.set('name', name);
  if (description) doc.set('description', description);
  if (tools) doc.set('tools', tools);
  if (model) doc.set('model', model);
  let yamlStr = doc.toString().replace(/\r?\n/g, eol);
  if (!yamlStr.endsWith(eol)) yamlStr += eol;
  const body = prompt ? prompt.replace(/\r?\n/g, eol) : '';
  const res = (hasBom ? '\ufeff' : '') + '---' + eol + yamlStr + '---' + eol + (body ? (body.startsWith(eol) ? body : eol + body) : '');
  parseClaudeMarkdown(res); // 自检
  return res;
}

export function parseCodexAgentToml(content) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  let parsed;
  try {
    parsed = parseForESLint(cleanText);
  } catch (e) {
    const pos = e.lineNumber ? `第 ${e.lineNumber} 行` : '';
    throw fail(`TOML 语法解析错误 ${pos}`.trim(), 400);
  }
  const top = parsed.ast.body[0];
  const fields = {};
  for (const item of top.body) {
    if (item.type === 'TOMLKeyValue') {
      const keys = item.key.keys.map(k => getStaticTOMLValue(k));
      if (keys.length === 1) {
        fields[keys[0]] = getStaticTOMLValue(item.value);
      }
    }
  }
  return { fields, hasBom, eol };
}

export function formatTomlValue(val, eol = '\n') {
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (typeof val === 'boolean' || typeof val === 'number') {
    return String(val);
  }
  return JSON.stringify(val);
}

export function updateCodexAgentToml(content, updates = {}) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  let text = cleanText;
  const fieldOrder = ['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'developer_instructions'];

  const normalizedUpdates = {};
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'effort') normalizedUpdates['model_reasoning_effort'] = v;
    else if (k === 'sandbox') normalizedUpdates['sandbox_mode'] = v;
    else if (k === 'prompt') normalizedUpdates['developer_instructions'] = v;
    else normalizedUpdates[k] = v;
  }

  for (const key of fieldOrder) {
    if (!(key in normalizedUpdates)) continue;
    const newVal = normalizedUpdates[key];
    let parsed;
    try {
      parsed = parseForESLint(text);
    } catch (e) {
      throw fail('TOML 格式解析错误，不可修改', 400);
    }
    const top = parsed.ast.body[0];
    const kv = top.body.find(x => x.type === 'TOMLKeyValue' && x.key.keys.length === 1 && getStaticTOMLValue(x.key.keys[0]) === key);

    if (kv) {
      const currentVal = getStaticTOMLValue(kv.value);
      if (currentVal === newVal) continue; // 无实质改动
      if (newVal === null || newVal === undefined) {
        let start = kv.range[0];
        let end = kv.range[1];
        if (text.slice(end, end + 2) === '\r\n') end += 2;
        else if (text.slice(end, end + 1) === '\n') end += 1;
        text = text.slice(0, start) + text.slice(end);
      } else {
        const valRange = kv.value.range;
        const valStr = formatTomlValue(newVal, eol);
        text = text.slice(0, valRange[0]) + valStr + text.slice(valRange[1]);
      }
    } else if (newVal !== null && newVal !== undefined) {
      const kvStr = key + ' = ' + formatTomlValue(newVal, eol) + eol;
      const firstTable = top.body.find(x => x.type === 'TOMLTable');
      if (firstTable) {
        const insertIdx = firstTable.range[0];
        text = text.slice(0, insertIdx) + kvStr + (text.charAt(insertIdx - 1) === '\n' ? '' : eol) + text.slice(insertIdx);
      } else {
        if (text.length > 0 && !text.endsWith(eol)) text += eol;
        text += kvStr;
      }
    }
  }

  const res = (hasBom ? '\ufeff' : '') + text;
  parseCodexAgentToml(res); // 验证输出有效性
  return res;
}

export function serializeCodexAgentToml({ name, description, model, effort, sandbox, prompt, eol = '\n', hasBom = false }) {
  let out = '';
  if (name) out += 'name = ' + formatTomlValue(name, eol) + eol;
  if (description) out += 'description = ' + formatTomlValue(description, eol) + eol;
  if (model) out += 'model = ' + formatTomlValue(model, eol) + eol;
  if (effort) out += 'model_reasoning_effort = ' + formatTomlValue(effort, eol) + eol;
  if (sandbox) out += 'sandbox_mode = ' + formatTomlValue(sandbox, eol) + eol;
  if (prompt !== undefined && prompt !== null && prompt !== '') {
    out += eol + 'developer_instructions = ' + formatTomlValue(prompt, eol) + eol;
  }
  const res = (hasBom ? '\ufeff' : '') + out;
  parseCodexAgentToml(res); // 自检
  return res;
}

export function parseCodexConfigAgentsDefaults(content) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  let parsed;
  try {
    parsed = parseForESLint(cleanText);
  } catch (e) {
    const pos = e.lineNumber ? `第 ${e.lineNumber} 行` : "";
    throw fail(`TOML 语法解析错误 ${pos}`.trim(), 400);
  }
  const top = parsed.ast.body[0];

  // 检查是否使用了 inline table: agents = { ... } 或 dotted key: agents.default_subagent_model = ...
  for (const item of top.body) {
    if (item.type === "TOMLKeyValue") {
      const keys = item.key.keys.map(k => getStaticTOMLValue(k));
      if (keys.length === 1 && keys[0] === "agents" && item.value.type === "TOMLInlineTable") {
        throw fail("暂不支持内联表 agents = {...} 写法，请使用标准 [agents] 表头", 400);
      }
      if (keys.length > 1 && keys[0] === "agents") {
        throw fail("暂不支持点号键 agents." + keys.slice(1).join(".") + " 写法，请使用标准 [agents] 表头", 400);
      }
    }
  }

  const table = top.body.find(x => x.type === "TOMLTable" && x.resolvedKey?.length === 1 && x.resolvedKey[0] === "agents");
  let defaultModel = null;
  let defaultEffort = null;
  if (table) {
    for (const kv of table.body) {
      if (kv.type === "TOMLKeyValue" && kv.key.keys.length === 1) {
        const k = getStaticTOMLValue(kv.key.keys[0]);
        const v = getStaticTOMLValue(kv.value);
        if (k === "default_subagent_model") defaultModel = v != null ? String(v) : null;
        if (k === "default_subagent_reasoning_effort") defaultEffort = v != null ? String(v) : null;
      }
    }
  }
  return { defaultModel, defaultEffort, hasBom, eol };
}

export function updateCodexConfigAgentsDefaults(content, updates = {}) {
  const { hasBom, eol, cleanText } = detectBomAndEol(content);
  let text = cleanText;
  const targetKeys = ["default_subagent_model", "default_subagent_reasoning_effort"];

  for (const key of targetKeys) {
    if (!(key in updates)) continue;
    const newVal = updates[key];
    parseCodexConfigAgentsDefaults(text); // 预先检查是否含有不支持的 inline/dotted 写法

    let parsed;
    try {
      parsed = parseForESLint(text);
    } catch (e) {
      throw fail("TOML 格式解析错误，不可修改", 400);
    }
    const top = parsed.ast.body[0];
    const table = top.body.find(x => x.type === "TOMLTable" && x.resolvedKey?.length === 1 && x.resolvedKey[0] === "agents");

    if (table) {
      const kv = table.body.find(x => x.type === "TOMLKeyValue" && x.key.keys.length === 1 && getStaticTOMLValue(x.key.keys[0]) === key);
      if (kv) {
        const currentVal = getStaticTOMLValue(kv.value);
        if (currentVal === newVal) continue;
        if (newVal === null || newVal === undefined) {
          let start = kv.range[0];
          let end = kv.range[1];
          const nextNl = text.indexOf("\n", end);
          if (nextNl !== -1) {
            const between = text.slice(end, nextNl);
            if (!between.includes("#")) {
              end = nextNl + 1;
            } else {
              end = nextNl + 1;
            }
          } else {
            end = text.length;
          }
          text = text.slice(0, start) + text.slice(end);
        } else {
          const valRange = kv.value.range;
          const valStr = formatTomlValue(newVal, eol);
          text = text.slice(0, valRange[0]) + valStr + text.slice(valRange[1]);
        }
      } else if (newVal !== null && newVal !== undefined) {
        const kvStr = key + " = " + formatTomlValue(newVal, eol) + eol;
        let insertPos;
        if (table.body.length > 0) {
          const lastKv = table.body[table.body.length - 1];
          const nextNl = text.indexOf("\n", lastKv.range[1]);
          insertPos = nextNl !== -1 ? nextNl + 1 : text.length;
          text = text.slice(0, insertPos) + kvStr + text.slice(insertPos);
        } else {
          const tableHeaderEnd = text.indexOf("]", table.range[0]);
          const nextNl = text.indexOf("\n", tableHeaderEnd);
          if (nextNl !== -1) {
            insertPos = nextNl + 1;
            text = text.slice(0, insertPos) + kvStr + text.slice(insertPos);
          } else {
            insertPos = text.length;
            text = text + eol + kvStr;
          }
        }
      }
    } else if (newVal !== null && newVal !== undefined) {
      let blockStr = "[agents]" + eol + key + " = " + formatTomlValue(newVal, eol) + eol;
      if (text.length > 0 && !text.endsWith(eol)) blockStr = eol + blockStr;
      text += blockStr;
    }
  }

  const res = (hasBom ? "\ufeff" : "") + text;
  parseCodexConfigAgentsDefaults(res); // 验证输出有效性
  return res;
}
