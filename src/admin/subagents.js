import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from '../config.js';
import {
  parseClaudeMarkdown,
  updateClaudeMarkdown,
  serializeClaudeMarkdown,
  parseCodexAgentToml,
  updateCodexAgentToml,
  serializeCodexAgentToml,
  parseCodexConfigAgentsDefaults,
  updateCodexConfigAgentsDefaults,
  detectBomAndEol,
} from './agent-documents.js';
import {
  MAX_FILE_SIZE,
  fail,
  computeRevision,
  validateAgentId,
  assertSafePath,
  assertNoSymlinksInAncestors,
  atomicWrite,
  safeDeleteFile,
} from './agent-files.js';

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('配置数据必须是对象');
  for (const key of ['name', 'description', 'prompt', 'model', 'effort', 'sandbox', 'tools']) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') throw fail(key + ' 必须是字符串');
  }
}
function validateRequired(fields, tool) {
  validateAgentId(fields.name);
  if (typeof fields.description !== 'string' || !fields.description.trim()) throw fail('作用不能为空');
  if (tool === 'codex' && (typeof fields.developer_instructions !== 'string' || !fields.developer_instructions.trim())) throw fail('Codex 指令不能为空');
}

const BUILTIN_CLAUDE = [
  { id: 'Explore', name: 'Explore', description: '只读的代码探索：定位文件、符号、调用关系，理解代码结构而不做修改。覆盖内置 Explore。', tools: 'Read, Grep, Glob', model: null, editable: true },
  { id: 'Plan', name: 'Plan', description: '只读的方案调研与设计：收集上下文、产出可直接执行的实现方案。覆盖内置 Plan。', tools: 'Read, Grep, Glob', model: null, editable: true },
  { id: 'general-purpose', name: 'general-purpose', description: '通用编码执行：探索 + 修改、多步实现与复杂任务落地。覆盖内置 general-purpose。', tools: null, model: null, editable: true },
  { id: 'claude', name: 'claude', description: '兜底子代理：处理不归 Explore / Plan / general-purpose 管辖的任务，工具全开放。覆盖内置 claude。', tools: null, model: null, editable: true },
  { id: 'statusline-setup', name: 'statusline-setup', description: '系统角色，仅查看。', tools: null, model: null, editable: false },
  { id: 'claude-code-guide', name: 'claude-code-guide', description: '系统角色，仅查看。', tools: null, model: null, editable: false },
];

const BUILTIN_CODEX = [
  { id: 'default', name: 'default', description: '通用兜底执行代理：独立完成实现、分析与验证类任务。覆盖内置 default。', tools: null, model: null, effort: null, sandbox: null, editable: true },
  { id: 'explorer', name: 'explorer', description: '只读搜索与代码库探索：追踪代码、文档与相关证据。覆盖内置 explorer。', tools: null, model: null, effort: null, sandbox: null, editable: true },
  { id: 'worker', name: 'worker', description: '面向执行的实现代理：落实聚焦的代码改动与修复。覆盖内置 worker。', tools: null, model: null, effort: null, sandbox: null, editable: true },
];

export function createSubagentStore(options = {}) {
  const claudeHome = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const codexHome = options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const backupDirBase = options.backupDir || join(ROOT, 'logs', 'config-backups');
  const validateModel = typeof options.validateModel === 'function' ? options.validateModel : () => {};

  function getPaths(tool) {
    if (tool === 'claude') {
      const root = join(claudeHome, 'agents');
      const configFile = join(claudeHome, 'settings.json');
      const backupDir = join(backupDirBase, 'claude');
      return { root, configFile, backupDir, ext: '.md' };
    } else if (tool === 'codex') {
      const root = join(codexHome, 'agents');
      const configFile = join(codexHome, 'config.toml');
      const backupDir = join(backupDirBase, 'codex');
      return { root, configFile, backupDir, ext: '.toml' };
    } else {
      throw fail(`不支持的工具类型: ${tool}，仅支持 claude 或 codex`, 400);
    }
  }

  function getDefaults(tool) {
    const { configFile } = getPaths(tool);
    assertNoSymlinksInAncestors(configFile);
    if (!existsSync(configFile)) {
      return { model: null, effort: null, revision: null, file: configFile };
    }
    try {
      const stat = statSync(configFile);
      if (stat.size > MAX_FILE_SIZE) {
        return { model: null, effort: null, revision: null, file: configFile, error: '配置文件体积过大' };
      }
      const content = readFileSync(configFile, 'utf8');
      const revision = computeRevision(content);
      if (tool === 'claude') {
        let json;
        try {
          json = JSON.parse(detectBomAndEol(content).cleanText);
          if (!json || Array.isArray(json) || typeof json !== 'object' || (json.env != null && (Array.isArray(json.env) || typeof json.env !== 'object'))) throw new Error();
        } catch { return { model: null, effort: null, revision, file: configFile, error: 'Claude 配置文件 JSON 格式错误' }; }
        const model = json?.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? null;
        return { model: model !== null ? String(model) : null, effort: null, revision, file: configFile };
      } else {
        try {
          const { defaultModel, defaultEffort } = parseCodexConfigAgentsDefaults(content);
          return { model: defaultModel, effort: defaultEffort, revision, file: configFile };
        } catch {
          return { model: null, effort: null, revision, file: configFile, error: 'Codex 配置文件 TOML 格式错误' };
        }
      }
    } catch {
      return { model: null, effort: null, revision: null, file: configFile, error: '无法读取默认配置文件' };
    }
  }

  function listDiskAgents(tool) {
    const { root, ext } = getPaths(tool);
    const diskMap = new Map();
    if (!existsSync(root)) return diskMap;
    assertNoSymlinksInAncestors(root);
    const entries = readdirSync(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (extname(ent.name).toLowerCase() !== ext) continue;
      const base = basename(ent.name, extname(ent.name));
      const filePath = join(root, ent.name);
      try {
        assertSafePath(root, filePath);
        const stat = statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          diskMap.set(base.toLowerCase(), { id: base, file: filePath, error: `文件体积过大 (${stat.size} 字节)` });
          continue;
        }
        const content = readFileSync(filePath, 'utf8');
        const revision = computeRevision(content);
        if (tool === 'claude') {
          const { frontmatter, prompt } = parseClaudeMarkdown(content);
          validateRequired(frontmatter, tool);
          const toolsVal = frontmatter.tools !== undefined && frontmatter.tools !== null ? String(frontmatter.tools) : null;
          diskMap.set(base.toLowerCase(), {
            id: base,
            name: frontmatter.name ? String(frontmatter.name) : base,
            description: frontmatter.description ? String(frontmatter.description) : '',
            model: frontmatter.model !== undefined && frontmatter.model !== null ? String(frontmatter.model) : null,
            effort: null,
            tools: toolsVal,
            sandbox: null,
            prompt: prompt || '',
            file: filePath,
            revision,
          });
        } else {
          const { fields } = parseCodexAgentToml(content);
          validateRequired(fields, tool);
          diskMap.set(base.toLowerCase(), {
            id: base,
            name: fields.name ? String(fields.name) : base,
            description: fields.description ? String(fields.description) : '',
            model: fields.model !== undefined && fields.model !== null ? String(fields.model) : null,
            effort: fields.model_reasoning_effort ? String(fields.model_reasoning_effort) : null,
            tools: null,
            sandbox: fields.sandbox_mode ? String(fields.sandbox_mode) : null,
            prompt: fields.developer_instructions ? String(fields.developer_instructions) : '',
            file: filePath,
            revision,
          });
        }
      } catch (err) {
        diskMap.set(base.toLowerCase(), { id: base, file: filePath, error: err.message });
      }
    }
    const names = new Map();
    for (const disk of diskMap.values()) {
      if (!disk.name) continue;
      const key = disk.name.toLowerCase();
      if (names.has(key)) {
        disk.error = '多个配置文件声明了相同的代理名称';
        names.get(key).error = disk.error;
      } else names.set(key, disk);
    }
    return diskMap;
  }

  function get(tool) {
    const { root } = getPaths(tool);
    const diskAgents = listDiskAgents(tool);
    const builtins = tool === 'claude' ? BUILTIN_CLAUDE : BUILTIN_CODEX;
    const defaults = getDefaults(tool);
    const warnings = [];
    if (defaults.error) warnings.push(`默认配置文件警告: ${defaults.error}`);

    const agents = [];
    const seenKeys = new Set();

    for (const b of builtins) {
      const key = b.id.toLowerCase();
      const disk = [...diskAgents.values()].find((d) => d.name === b.name) || (diskAgents.get(key)?.error ? diskAgents.get(key) : null);
      if (disk) seenKeys.add(disk.id.toLowerCase());
      if (disk) {
        if (disk.error) {
          agents.push({
            id: disk.id,
            name: disk.id,
            description: b.description,
            model: null,
            effort: null,
            tools: b.tools || null,
            sandbox: null,
            prompt: '',
            source: 'override',
            file: disk.file,
            editable: false,
            revision: null,
            error: disk.error,
          });
        } else {
          agents.push({
            id: disk.id,
            name: disk.name,
            description: disk.description,
            model: disk.model,
            effort: disk.effort,
            tools: disk.tools,
            sandbox: disk.sandbox,
            prompt: disk.prompt,
            source: 'override',
            file: disk.file,
            editable: b.editable !== false,
            revision: disk.revision,
          });
        }
      } else {
        agents.push({
          id: b.id,
          name: b.name,
          description: b.description,
          model: null,
          effort: b.effort || null,
          tools: b.tools || null,
          sandbox: b.sandbox || null,
          prompt: tool === 'claude' ? `你负责执行交给你的 ${b.name} 任务。` : `You are the ${b.name} delegated agent.`,
          source: 'builtin',
          file: null,
          editable: b.editable !== false,
          revision: null,
        });
      }
    }

    for (const [key, disk] of diskAgents.entries()) {
      if (seenKeys.has(key)) continue;
      if (disk.error) {
        agents.push({
          id: disk.id,
          name: disk.id,
          description: '',
          model: null,
          effort: null,
          tools: null,
          sandbox: null,
          prompt: '',
          source: 'custom',
          file: disk.file,
          editable: false,
          revision: null,
          error: disk.error,
        });
      } else {
        agents.push({
          id: disk.id,
          name: disk.name,
          description: disk.description,
          model: disk.model,
          effort: disk.effort,
          tools: disk.tools,
          sandbox: disk.sandbox,
          prompt: disk.prompt,
          source: 'custom',
          file: disk.file,
          editable: true,
          revision: disk.revision,
        });
      }
    }

    return { tool, root, agents, defaults, warnings };
  }

  function save(tool, rawId, body = {}) {
    validateBody(body);
    const id = validateAgentId(rawId);
    const { root, ext, backupDir } = getPaths(tool);
    const builtins = tool === 'claude' ? BUILTIN_CLAUDE : BUILTIN_CODEX;
    const existingAgent = listDiskAgents(tool).get(id.toLowerCase());
    if (existingAgent?.error) throw fail('此代理配置无效，不能写入');
    const currentName = existingAgent?.name || id;
    const builtinMeta = builtins.find(b => b.name === (existingAgent?.name || id));

    if (builtinMeta && builtinMeta.editable === false) {
      throw fail(`内置代理 [${builtinMeta.id}] 为系统固定代理，不可修改`, 400);
    }

    // 查找当前对应文件
    let actualFileName = id + ext;
    let targetPath = join(root, actualFileName);
    if (existsSync(root)) {
      assertNoSymlinksInAncestors(root);
      const existingFiles = readdirSync(root);
      const match = existingFiles.find(f => f.toLowerCase() === actualFileName.toLowerCase());
      if (match) {
        actualFileName = match;
        targetPath = join(root, actualFileName);
      }
    }
    assertSafePath(root, targetPath);

    const fileExists = existsSync(targetPath);
    let existingContent = '';
    let currentRevision = null;
    if (fileExists) {
      if (statSync(targetPath).size > MAX_FILE_SIZE) throw fail('文件体积过大');
      existingContent = readFileSync(targetPath, 'utf8');
      currentRevision = computeRevision(existingContent);
    }

    // 严格 revision 机制
    if (fileExists) {
      if (!body.revision || body.revision !== currentRevision) {
        throw fail(`配置版本冲突 (409): 客户端 revision (${body.revision}) 与当前版本 (${currentRevision}) 不一致`, 409);
      }
    } else {
      if (body.revision !== null) {
        throw fail(`新建代理 revision 必须为 null`, 409);
      }
    }

    // 字段 schema 严格校验
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw fail('代理 name 必须为非空字符串', 400);
    }
    if (body.description !== undefined && typeof body.description !== 'string') {
      throw fail('代理 description 必须为字符串', 400);
    }
    if (body.prompt !== undefined && typeof body.prompt !== 'string') {
      throw fail('代理 prompt 必须为字符串', 400);
    }
    if (tool === 'codex') {
      if (body.effort !== undefined && body.effort !== null && !CODEX_EFFORTS.has(String(body.effort))) {
        throw fail(`无效的 Codex effort: ${body.effort}，必须为 low/medium/high`, 400);
      }
      if (body.sandbox !== undefined && body.sandbox !== null && !CODEX_SANDBOXES.has(String(body.sandbox))) {
        throw fail(`无效的 Codex sandbox: ${body.sandbox}`, 400);
      }
    }

    // 检查重命名原子迁移
    let newFileName = actualFileName;
    let newTargetPath = targetPath;
    if (body.name !== undefined && body.name.trim() !== currentName) {
      const newId = validateAgentId(body.name.trim());
      newFileName = newId + ext;
      newTargetPath = join(root, newFileName);
      assertSafePath(root, newTargetPath);
      if (existsSync(newTargetPath) && newTargetPath.toLowerCase() !== targetPath.toLowerCase()) {
        throw fail(`目标文件已存在，不可重命名覆盖: ${newFileName}`, 400);
      }
    }

    let currentModel = null;
    if (fileExists) {
      if (tool === 'claude') {
        const parsed = parseClaudeMarkdown(existingContent);
        currentModel = parsed.frontmatter.model !== undefined && parsed.frontmatter.model !== null ? String(parsed.frontmatter.model) : null;
      } else {
        const parsed = parseCodexAgentToml(existingContent);
        currentModel = parsed.fields.model !== undefined && parsed.fields.model !== null ? String(parsed.fields.model) : null;
      }
    }

    const newModel = body.model !== undefined ? (body.model !== null && String(body.model).trim() ? String(body.model).trim() : null) : currentModel;
    const newName = body.name?.trim() || currentName;
    for (const other of listDiskAgents(tool).values()) {
      if (other.id.toLowerCase() !== id.toLowerCase() && other.name?.toLowerCase() === newName.toLowerCase()) throw fail('代理名称已存在', 409);
    }
    if (newName !== currentName && builtins.some((b) => b.id.toLowerCase() === newName.toLowerCase())) throw fail('不能通过重命名接管另一个内置代理');
    if (newModel !== currentModel && newModel !== null) {
      validateModel(tool, newModel);
    }

    let finalContent = '';
    if (tool === 'claude') {
      if (fileExists) {
        const updates = {};
        if (body.name !== undefined) updates.name = body.name.trim();
        if (body.description !== undefined) updates.description = body.description.trim();
        if (body.tools !== undefined) {
          const toolsTrim = body.tools !== null ? String(body.tools).trim() : '';
          updates.tools = toolsTrim ? toolsTrim : null;
        }
        if (body.model !== undefined) updates.model = newModel;
        const prompt = body.prompt !== undefined ? String(body.prompt) : null;
        finalContent = updateClaudeMarkdown(existingContent, updates, prompt);
      } else {
        const templateName = body.name ? body.name.trim() : (builtinMeta ? builtinMeta.name : id);
        const templateDesc = body.description !== undefined ? body.description.trim() : (builtinMeta ? builtinMeta.description : '自定义 Claude 子代理');
        const toolsTrim = body.tools !== undefined && body.tools !== null ? String(body.tools).trim() : (builtinMeta && builtinMeta.tools ? builtinMeta.tools : '');
        const templatePrompt = body.prompt !== undefined && body.prompt.trim() ? body.prompt : `你负责执行交给你的聚焦子任务。`;
        finalContent = serializeClaudeMarkdown({
          name: templateName,
          description: templateDesc,
          tools: toolsTrim || null,
          model: newModel,
          prompt: templatePrompt,
        });
      }
    } else {
      if (fileExists) {
        const updates = {};
        if (body.name !== undefined) updates.name = body.name.trim();
        if (body.description !== undefined) updates.description = body.description.trim();
        if (body.model !== undefined) updates.model = newModel;
        if (body.effort !== undefined) updates.effort = body.effort !== null ? String(body.effort).trim() : null;
        if (body.sandbox !== undefined) updates.sandbox = body.sandbox !== null ? String(body.sandbox).trim() : null;
        if (body.prompt !== undefined) {
          if (!String(body.prompt).trim()) throw fail('Codex 子代理 developer_instructions 不能为空', 400);
          updates.prompt = String(body.prompt);
        }
        finalContent = updateCodexAgentToml(existingContent, updates);
      } else {
        const templateName = body.name ? body.name.trim() : (builtinMeta ? builtinMeta.name : id);
        const templateDesc = body.description !== undefined ? body.description.trim() : (builtinMeta ? builtinMeta.description : '自定义 Codex 子代理');
        if (!templateDesc) throw fail('Codex 子代理 description 不能为空', 400);
        if (body.prompt !== undefined && !String(body.prompt).trim()) throw fail('Codex 子代理 developer_instructions 不能为空', 400);
        const templatePrompt = body.prompt !== undefined && body.prompt.trim() ? body.prompt : `You are a delegated subagent.\nImplement only the bounded task assigned to you.`;
        finalContent = serializeCodexAgentToml({
          name: templateName,
          description: templateDesc,
          model: newModel,
          effort: body.effort || (builtinMeta ? builtinMeta.effort : null),
          sandbox: body.sandbox || (builtinMeta ? builtinMeta.sandbox : null),
          prompt: templatePrompt,
        });
      }
    }

    // 如果重命名且旧文件存在，原子写入新文件并备份删除旧文件
    validateRequired(tool === 'claude' ? parseClaudeMarkdown(finalContent).frontmatter : parseCodexAgentToml(finalContent).fields, tool);
    if (fileExists && newTargetPath.toLowerCase() !== targetPath.toLowerCase()) {
      atomicWrite(newTargetPath, finalContent, backupDir, true, statSync(targetPath).mode & 0o777);
      try {
        safeDeleteFile(targetPath, backupDir);
      } catch (delErr) {
        try { safeDeleteFile(newTargetPath, null); } catch {}
        throw delErr;
      }
    } else {
      atomicWrite(fileExists ? targetPath : newTargetPath, finalContent, backupDir, !fileExists);
    }

    return get(tool);
  }

  function restore(tool, rawId, body = {}) {
    validateBody(body);
    const id = validateAgentId(rawId);
    const { root, ext, backupDir } = getPaths(tool);
    const builtins = tool === 'claude' ? BUILTIN_CLAUDE : BUILTIN_CODEX;
    const existingAgent = listDiskAgents(tool).get(id.toLowerCase());
    const builtinMeta = builtins.find(b => b.name === existingAgent?.name);

    if (!builtinMeta || existingAgent?.error) {
      throw fail(`代理 [${id}] 不是内置代理，不能执行恢复内置操作`, 400);
    }

    let actualFileName = id + ext;
    let targetPath = join(root, actualFileName);
    if (existsSync(root)) {
      assertNoSymlinksInAncestors(root);
      const existingFiles = readdirSync(root);
      const match = existingFiles.find(f => f.toLowerCase() === actualFileName.toLowerCase());
      if (match) {
        actualFileName = match;
        targetPath = join(root, actualFileName);
      }
    }
    assertSafePath(root, targetPath);

    if (!existsSync(targetPath)) {
      return get(tool);
    }

    const content = readFileSync(targetPath, 'utf8');
    const currentRevision = computeRevision(content);
    if (!body.revision || body.revision !== currentRevision) {
      throw fail(`配置版本冲突 (409): 客户端 revision (${body.revision}) 与当前版本 (${currentRevision}) 不一致`, 409);
    }

    safeDeleteFile(targetPath, backupDir);
    return get(tool);
  }

  function saveDefaults(tool, body = {}) {
    validateBody(body);
    if (body.effort != null && !CODEX_EFFORTS.has(body.effort)) throw fail('无效的推理力度');
    const { configFile, backupDir } = getPaths(tool);
    assertNoSymlinksInAncestors(configFile);
    const defaults = getDefaults(tool);
    if (defaults.error) {
      throw fail(`默认配置文件损坏，不可写入修改: ${defaults.error}`, 400);
    }

    if (existsSync(configFile)) {
      if (!body.revision || body.revision !== defaults.revision) {
        throw fail(`默认配置版本冲突 (409): 客户端 revision (${body.revision}) 与当前版本 (${defaults.revision}) 不一致`, 409);
      }
    } else {
      if (body.revision !== null) {
        throw fail(`新建默认配置 revision 必须为 null`, 409);
      }
    }

    const newModel = body.model !== undefined ? (body.model !== null && String(body.model).trim() ? String(body.model).trim() : null) : defaults.model;
    if (newModel !== defaults.model && newModel !== null) {
      validateModel(tool, newModel);
    }

    if (tool === 'claude') {
      let json = {};
      let format = { hasBom: false, eol: '\n' };
      if (existsSync(configFile)) {
        format = detectBomAndEol(readFileSync(configFile, 'utf8'));
        try { json = JSON.parse(format.cleanText); } catch { throw fail('无法解析 Claude 配置文件', 400); }
      }
      if (!json.env || typeof json.env !== 'object') json.env = {};
      if (newModel === null) {
        delete json.env.CLAUDE_CODE_SUBAGENT_MODEL;
      } else {
        json.env.CLAUDE_CODE_SUBAGENT_MODEL = newModel;
      }
      const content = (format.hasBom ? '\ufeff' : '') + JSON.stringify(json, null, 2).replace(/\n/g, format.eol) + format.eol;
      atomicWrite(configFile, content, backupDir, !existsSync(configFile));
    } else {
      let content = '';
      if (existsSync(configFile)) content = readFileSync(configFile, 'utf8');
      const updates = {};
      if (body.model !== undefined) updates.default_subagent_model = newModel;
      if (body.effort !== undefined) {
        if (body.effort !== null && !CODEX_EFFORTS.has(String(body.effort))) {
          throw fail(`无效的 Codex effort: ${body.effort}`, 400);
        }
        updates.default_subagent_reasoning_effort = body.effort !== null ? String(body.effort).trim() : null;
      }
      const newContent = updateCodexConfigAgentsDefaults(content, updates);
      atomicWrite(configFile, newContent, backupDir, !existsSync(configFile));
    }

    return get(tool);
  }

  return { get, save, restore, saveDefaults };
}
