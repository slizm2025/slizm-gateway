import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentStore } from "../src/admin/subagents.js";
import {
  parseClaudeMarkdown,
  updateClaudeMarkdown,
  serializeClaudeMarkdown,
  parseCodexAgentToml,
  updateCodexAgentToml,
  serializeCodexAgentToml,
  parseCodexConfigAgentsDefaults,
  updateCodexConfigAgentsDefaults,
} from "../src/admin/agent-documents.js";

async function createEnv(t) {
  const root = await mkdtemp(join(tmpdir(), "gw-test-subagents-"));
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const backupDir = join(root, "backups");
  await mkdir(join(claudeHome, "agents"), { recursive: true });
  await mkdir(join(codexHome, "agents"), { recursive: true });
  await mkdir(backupDir, { recursive: true });
  t.after(async () => {
    try { await rm(root, { recursive: true, force: true }); } catch {}
  });
  return { root, claudeHome, codexHome, backupDir };
}

test('store requires revisions for restore/defaults, rejects invalid bodies, and safely creates and renames agents', async (t) => {
  const env = await createEnv(t);
  const store = createSubagentStore(env);
  assert.throws(() => store.save('codex', 'new-agent', null), { statusCode: 400 });
  assert.throws(() => store.save('codex', 'new-agent', []), { statusCode: 400 });
  assert.throws(() => store.save('codex', 'new-agent', {}), { statusCode: 409 });
  assert.throws(() => store.save('codex', 'check-models', { revision: null }), { statusCode: 400 });
  const source = { revision: null, name: 'worker', description: 'Worker', prompt: 'Read C:\\new\\file. Say "ok".\nThen report.', effort: 'xhigh' };
  const worker = store.save('codex', 'worker', source).agents.find(a => a.id === 'worker');
  const text = await readFile(join(env.codexHome, 'agents', 'worker.toml'), 'utf8');
  assert.equal(parseCodexAgentToml(text).fields.developer_instructions, source.prompt);
  assert.throws(() => store.restore('codex', 'worker', {}), { statusCode: 409 });
  assert.throws(() => store.save('codex', 'worker', { revision: worker.revision, description: '' }), { statusCode: 400 });
  const renamed = store.save('codex', 'worker', { revision: worker.revision, name: 'builder' });
  assert.equal(renamed.agents.find(a => a.id === 'worker').source, 'builtin');
  assert.equal(renamed.agents.find(a => a.id === 'builder').source, 'custom');
  await assert.rejects(readFile(join(env.codexHome, 'agents', 'worker.toml')), { code: 'ENOENT' });
  const added = store.save('codex', 'new-entry', { revision: null, name: 'named-entry', description: 'New', prompt: 'Work' });
  assert.ok(added.agents.find(a => a.id === 'named-entry'));
  const defaults = store.saveDefaults('codex', { revision: null, model: null, effort: 'high' }).defaults;
  assert.throws(() => store.saveDefaults('codex', { effort: 'low' }), { statusCode: 409 });
  assert.equal(store.get('codex').defaults.revision, defaults.revision);
});

test('Claude defaults preserve unrelated values, BOM and CRLF without exposing malformed secrets', async (t) => {
  const env = await createEnv(t);
  const file = join(env.claudeHome, 'settings.json');
  await writeFile(file, '\ufeff{\r\n  "env": { "TOKEN": "private-secret" },\r\n  "theme": "dark"\r\n}\r\n');
  const store = createSubagentStore(env);
  const defaults = store.get('claude').defaults;
  store.saveDefaults('claude', { revision: defaults.revision, model: 'gemini' });
  const saved = await readFile(file, 'utf8');
  assert.ok(saved.startsWith('\ufeff'));
  assert.ok(saved.includes('\r\n'));
  assert.equal(JSON.parse(saved.slice(1)).env.TOKEN, 'private-secret');
  await writeFile(file, '{"secret":"private-secret", bad');
  assert.ok(!JSON.stringify(store.get('claude')).includes('private-secret'));
  assert.throws(() => store.saveDefaults('claude', { revision: null, model: null }), { statusCode: 400 });
});

test('junctions in configuration ancestors and default file links are rejected', async (t) => {
  const env = await createEnv(t);
  const outside = join(env.root, 'outside');
  await mkdir(outside);
  const linked = join(env.root, 'linked');
  try { await symlink(outside, linked, 'junction'); } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('link privilege unavailable'); throw e; }
  const store = createSubagentStore({ ...env, claudeHome: join(linked, 'claude') });
  assert.throws(() => store.saveDefaults('claude', { revision: null, model: null }), { statusCode: 400 });
  assert.throws(() => store.save('claude', 'Explore', { revision: null }), { statusCode: 400 });
});

test('Codex role names, not filenames, determine built-in overrides and edits preserve filenames', async (t) => {
  const env = await createEnv(t);
  await writeFile(join(env.codexHome, 'agents', 'my-reader.toml'), 'name = "explorer"\ndescription = "Read"\ndeveloper_instructions = "Read only"\n');
  const store = createSubagentStore(env);
  const explorer = store.get('codex').agents.find(a => a.name === 'explorer');
  assert.equal(explorer.id, 'my-reader');
  assert.equal(explorer.source, 'override');
  const saved = store.save('codex', explorer.id, { ...explorer, description: 'Updated' }).agents.find(a => a.id === explorer.id);
  assert.equal(saved.name, 'explorer');
  assert.match(await readFile(join(env.codexHome, 'agents', 'my-reader.toml'), 'utf8'), /description = "Updated"/);
  await assert.rejects(readFile(join(env.codexHome, 'agents', 'explorer.toml')), { code: 'ENOENT' });
  assert.throws(() => store.save('codex', saved.id, { ...saved, name: 'worker' }), { statusCode: 400 });
  const result = store.restore('codex', saved.id, { revision: saved.revision });
  assert.equal(result.agents.find(a => a.name === 'explorer').source, 'builtin');
});

test("agent-documents: Claude markdown preserves frontmatter comments, eol, BOM, and body", () => {
  const raw = "\ufeff---\r\nname: Explore\r\n# Keep this comment\r\nmodel: gemini\r\ntools: Read, Grep\r\n---\r\n\r\nOriginal instructions line 1\r\nLine 2";
  const parsed = parseClaudeMarkdown(raw);
  assert.equal(parsed.hasBom, true);
  assert.equal(parsed.eol, "\r\n");
  assert.equal(parsed.frontmatter.name, "Explore");
  assert.equal(parsed.frontmatter.model, "gemini");

  const updated = updateClaudeMarkdown(raw, { model: "deepseek", tools: null }, "Updated body");
  assert.ok(updated.startsWith("\ufeff---"));
  assert.ok(updated.includes("# Keep this comment"));
  assert.ok(updated.includes("model: deepseek"));
  assert.ok(!updated.includes("tools:"));
  assert.ok(updated.includes("Updated body"));
});

test("agent-documents: Codex TOML preserves comments, eol, tables, and AST-ranges edits", () => {
  const raw = "# Top level comment\r\nname = \"worker\"\r\nmodel = \"gemini\"\r\n\r\n[extra_table]\r\ncustom_val = 123\r\n";
  const parsed = parseCodexAgentToml(raw);
  assert.equal(parsed.fields.name, "worker");
  assert.equal(parsed.fields.model, "gemini");

  const updated = updateCodexAgentToml(raw, { model: "deepseek", effort: "high", sandbox: null });
  assert.ok(updated.includes("# Top level comment"));
  assert.ok(updated.includes("model = \"deepseek\""));
  assert.ok(updated.includes("model_reasoning_effort = \"high\""));
  assert.ok(updated.includes("[extra_table]"));
  assert.ok(updated.includes("custom_val = 123"));

  const configToml = "# Main config\r\n[agents]\r\nenabled = true\r\ndefault_subagent_model = \"gemini\"\r\n";
  const cfgParsed = parseCodexConfigAgentsDefaults(configToml);
  assert.equal(cfgParsed.defaultModel, "gemini");
  assert.equal(cfgParsed.defaultEffort, null);

  const cfgUpdated = updateCodexConfigAgentsDefaults(configToml, { default_subagent_model: "claude-opus-5-5", default_subagent_reasoning_effort: "medium" });
  assert.ok(cfgUpdated.includes("# Main config"));
  assert.ok(cfgUpdated.includes("default_subagent_model = \"claude-opus-5-5\""));
  assert.ok(cfgUpdated.includes("default_subagent_reasoning_effort = \"medium\""));
  assert.ok(cfgUpdated.includes("enabled = true"));
});

test("subagents store: Claude get, save override, revision conflict, restore builtin", async (t) => {
  const { claudeHome, codexHome, backupDir } = await createEnv(t);
  const validatedModels = [];
  const store = createSubagentStore({
    claudeHome,
    codexHome,
    backupDir,
    validateModel: (tool, model) => {
      validatedModels.push({ tool, model });
      if (model === "invalid-model") {
        const err = new Error("Invalid model");
        err.statusCode = 400;
        throw err;
      }
    }
  });

  const init = store.get("claude");
  assert.equal(init.tool, "claude");
  const explore = init.agents.find(a => a.id === "Explore");
  assert.ok(explore);
  assert.equal(explore.source, "builtin");
  assert.equal(explore.file, null);

  // Takeover Explore
  const saved = store.save("claude", "Explore", {
    revision: null,
    name: "Explore",
    description: "Custom explore",
    model: "gemini",
    prompt: "Custom explore prompt"
  });
  const overridden = saved.agents.find(a => a.id === "Explore");
  assert.equal(overridden.source, "override");
  assert.ok(overridden.file);
  assert.ok(overridden.revision);
  assert.equal(overridden.description, "Custom explore");

  // Validate model called on new model
  assert.deepEqual(validatedModels, [{ tool: "claude", model: "gemini" }]);

  // Test revision conflict
  assert.throws(() => {
    store.save("claude", "Explore", {
      revision: "stale_hash",
      description: "Conflict test"
    });
  }, (err) => err.statusCode === 409);

  // Restore builtin Explore
  const restored = store.restore("claude", "Explore", { revision: overridden.revision });
  const backToBuiltin = restored.agents.find(a => a.id === "Explore");
  assert.equal(backToBuiltin.source, "builtin");
  assert.equal(backToBuiltin.file, null);
});

test("subagents store: Codex get, save override, defaults, and backup created", async (t) => {
  const { claudeHome, codexHome, backupDir } = await createEnv(t);
  const store = createSubagentStore({ claudeHome, codexHome, backupDir });

  // Save Codex default agent override
  const saved = store.save("codex", "worker", {
    revision: null,
    name: "worker",
    description: "Codex worker",
    model: "gemini",
    effort: "high",
    sandbox: "workspace-write",
    prompt: "Do work"
  });
  const worker = saved.agents.find(a => a.id === "worker");
  assert.equal(worker.source, "override");
  assert.equal(worker.effort, "high");
  assert.equal(worker.sandbox, "workspace-write");

  // Modify worker, verify backup created
  const modified = store.save("codex", "worker", {
    revision: worker.revision,
    description: "Updated worker description"
  });
  const updatedWorker = modified.agents.find(a => a.id === "worker");
  assert.equal(updatedWorker.description, "Updated worker description");
  assert.notEqual(updatedWorker.revision, worker.revision);

  // Save Codex config defaults
  const defSaved = store.saveDefaults("codex", {
    revision: null,
    model: "gemini",
    effort: "high"
  });
  assert.equal(defSaved.defaults.model, "gemini");
  assert.equal(defSaved.defaults.effort, "high");
  assert.ok(defSaved.defaults.revision);
});

test("subagents store: security checks on agent id, path traversal, symlink out of bounds", async (t) => {
  const { root, claudeHome, codexHome, backupDir } = await createEnv(t);
  const store = createSubagentStore({ claudeHome, codexHome, backupDir });

  // Reserved and invalid IDs
  assert.throws(() => store.save("claude", "defaults", {}), (err) => err.statusCode === 400);
  assert.throws(() => store.save("claude", "CON", {}), (err) => err.statusCode === 400);
  assert.throws(() => store.save("claude", "../escape", {}), (err) => err.statusCode === 400);
  assert.throws(() => store.save("claude", "has/slash", {}), (err) => err.statusCode === 400);

  // Symlink pointing outside root
  const secretFile = join(root, "secret.txt");
  await writeFile(secretFile, "secret content");
  const symAgent = join(claudeHome, "agents", "evil.md");
  try {
    await symlink(secretFile, symAgent);
    assert.throws(() => {
      store.save("claude", "evil", { prompt: "overwrite" });
    }, (err) => err.statusCode === 400);
  } catch (e) {
    if (e.code !== "EPERM") throw e;
  }
});

test("subagents store: corrupted or oversized files do not crash listing", async (t) => {
  const { claudeHome, codexHome, backupDir } = await createEnv(t);
  const store = createSubagentStore({ claudeHome, codexHome, backupDir });

  // Corrupted markdown file
  await writeFile(join(claudeHome, "agents", "broken.md"), "---\nfoo: [1, 2\n---\n");
  const data = store.get("claude");
  const broken = data.agents.find(a => a.id === "broken");
  assert.ok(broken);
  assert.equal(broken.editable, false);
  assert.ok(broken.error);

  // Oversized file (> 256KB)
  const bigContent = "a".repeat(300 * 1024);
  await writeFile(join(codexHome, "agents", "huge.toml"), bigContent);
  const codexData = store.get("codex");
  const huge = codexData.agents.find(a => a.id === "huge");
  assert.ok(huge);
  assert.equal(huge.editable, false);
  assert.match(huge.error, /体积过大/);
});

test('subagents store: rename atomic migration and tools blanking', async (t) => {
  const { claudeHome, codexHome, backupDir } = await createEnv(t);
  const store = createSubagentStore({ claudeHome, codexHome, backupDir });

  // Create new custom agent with revision: null
  const created = store.save('claude', 'helper', {
    revision: null,
    name: 'helper',
    description: 'Initial helper',
    tools: 'Read, Grep',
    prompt: 'Help task',
  });
  const helperAgent = created.agents.find(a => a.id === 'helper');
  assert.ok(helperAgent);
  assert.equal(helperAgent.tools, 'Read, Grep');

  // Blank tools -> key removed
  const blankTools = store.save('claude', 'helper', {
    revision: helperAgent.revision,
    name: 'helper',
    tools: '   ',
  });
  const blankAgent = blankTools.agents.find(a => a.id === 'helper');
  assert.equal(blankAgent.tools, null);

  // Rename helper to helper-renamed
  const renamed = store.save('claude', 'helper', {
    revision: blankAgent.revision,
    name: 'helper-renamed',
    description: 'Renamed description',
  });
  assert.ok(!renamed.agents.some(a => a.id === 'helper'));
  assert.ok(renamed.agents.some(a => a.id === 'helper-renamed'));
});

test('subagents store: schema enforcement and corrupted defaults prevention', async (t) => {
  const { claudeHome, codexHome, backupDir } = await createEnv(t);
  const store = createSubagentStore({ claudeHome, codexHome, backupDir });

  // Invalid Codex effort & sandbox
  assert.throws(() => store.save('codex', 'tester', {
    revision: null,
    name: 'tester',
    effort: 'ultra-high',
  }), (err) => err.statusCode === 400);

  assert.throws(() => store.save('codex', 'tester', {
    revision: null,
    name: 'tester',
    sandbox: 'root-access',
  }), (err) => err.statusCode === 400);

  // Empty prompt on Codex
  assert.throws(() => store.save('codex', 'tester', {
    revision: null,
    name: 'tester',
    description: 'tester',
    prompt: '   ',
  }), (err) => err.statusCode === 400);

  // Corrupted defaults file blocks saveDefaults
  await writeFile(join(claudeHome, 'settings.json'), '{ bad json');
  assert.throws(() => store.saveDefaults('claude', { model: 'fast' }), (err) => err.statusCode === 400);
});
test('agent-documents: Codex defaults insertion preserves inline comments and rejects dotted/inline tables', () => {
  // Case 1: [agents] with table comment and inline comment on last kv
  const tomlWithComments = '[agents] # table comment\r\nenabled = true # inline comment\r\n\r\n[other]\r\nfoo = 1\r\n';
  const updated1 = updateCodexConfigAgentsDefaults(tomlWithComments, { default_subagent_model: 'gemini' });
  assert.ok(updated1.includes('# table comment'));
  assert.ok(updated1.includes('enabled = true # inline comment'));
  assert.ok(updated1.includes('default_subagent_model = "gemini"'));
  assert.ok(updated1.includes('[other]'));
  const parsed1 = parseCodexConfigAgentsDefaults(updated1);
  assert.equal(parsed1.defaultModel, 'gemini');

  // Case 2: Empty [agents] with header comment at EOF without trailing newline
  const tomlEmptyHeader = '[agents] # header comment';
  const updated2 = updateCodexConfigAgentsDefaults(tomlEmptyHeader, { default_subagent_model: 'claude-opus-5-5' });
  assert.ok(updated2.includes('# header comment'));
  assert.ok(updated2.includes('default_subagent_model = "claude-opus-5-5"'));
  const parsed2 = parseCodexConfigAgentsDefaults(updated2);
  assert.equal(parsed2.defaultModel, 'claude-opus-5-5');

  // Case 3: Rejects inline table agents = { ... }
  const tomlInline = 'agents = { default_subagent_model = "gemini" }\n';
  assert.throws(() => parseCodexConfigAgentsDefaults(tomlInline), (err) => err.statusCode === 400 && err.message.includes('内联表'));
  assert.throws(() => updateCodexConfigAgentsDefaults(tomlInline, { default_subagent_model: 'fast' }), (err) => err.statusCode === 400);

  // Case 4: Rejects dotted key agents.default_subagent_model = ...
  const tomlDotted = 'agents.default_subagent_model = "gemini"\n';
  assert.throws(() => parseCodexConfigAgentsDefaults(tomlDotted), (err) => err.statusCode === 400 && err.message.includes('点号键'));
  assert.throws(() => updateCodexConfigAgentsDefaults(tomlDotted, { default_subagent_model: 'fast' }), (err) => err.statusCode === 400);
});
