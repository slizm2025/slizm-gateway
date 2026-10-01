import { existsSync, lstatSync, mkdirSync, copyFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, statSync, linkSync } from 'node:fs';
import { resolve, join, basename, dirname, sep, parse } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const MAX_FILE_SIZE = 256 * 1024;

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function fail(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function computeRevision(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function validateAgentId(id) {
  if (typeof id !== 'string' || !id.trim()) {
    throw fail('子代理 ID 不能为空', 400);
  }
  const trimmed = id.trim();
  if (trimmed.length > 64) {
    throw fail('子代理 ID 长度不能超过 64 个字符', 400);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw fail(`子代理 ID 包含非法字符: ${trimmed}`, 400);
  }
  if (['defaults', 'check-models', '__proto__', 'constructor', 'prototype'].includes(trimmed.toLowerCase())) {
    throw fail('子代理 ID 不能使用保留名 defaults', 400);
  }
  if (WINDOWS_RESERVED.has(trimmed.toUpperCase())) {
    throw fail(`子代理 ID 不能使用系统保留设备名: ${trimmed}`, 400);
  }
  return trimmed;
}

export function assertNoSymlinksInAncestors(targetPath) {
  const resolved = resolve(targetPath);
  const root = parse(resolved).root;
  let curr = resolved;
  while (curr && curr !== root) {
    try {
      const st = lstatSync(curr);
      if (st.isSymbolicLink()) {
        throw fail(`路径包含符号链接或连接点: ${curr}`, 400);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        // 路径尚不存在是允许的，继续检查已存在的祖先
      } else if (e.statusCode) {
        throw e;
      } else {
        throw fail(`检查路径安全性失败: ${curr}`, 400);
      }
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
}

export function assertSafePath(rootDir, targetPath) {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;

  if (!resolvedTarget.startsWith(rootPrefix) && resolvedTarget !== resolvedRoot) {
    throw fail(`路径穿越拒绝: 目标路径超出根目录 (${resolvedTarget})`, 400);
  }

  assertNoSymlinksInAncestors(resolvedTarget);
}

export function atomicWrite(targetPath, content, backupDir = null, exclusive = false, sourceMode = null) {
  assertNoSymlinksInAncestors(targetPath);
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > MAX_FILE_SIZE) {
    throw fail(`写入内容体积超过上限 (${buf.length} > ${MAX_FILE_SIZE} 字节)`, 400);
  }

  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let originalMode = sourceMode ?? 0o600;
  if (existsSync(targetPath)) {
    const st = statSync(targetPath);
    originalMode = st.mode & 0o777;
    if (backupDir) {
      assertNoSymlinksInAncestors(backupDir);
      mkdirSync(backupDir, { recursive: true });
      const baseName = basename(targetPath);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = randomBytes(4).toString('hex');
      const backupPath = join(backupDir, `${baseName}.${ts}.${rand}.bak`);
      copyFileSync(targetPath, backupPath);
      try { chmodSync(backupPath, 0o600); } catch {}
    }
  }

  const baseName = basename(targetPath);
  const tmpRand = randomBytes(6).toString('hex');
  const tmpPath = join(dir, `.${baseName}.tmp-${Date.now()}-${process.pid}-${tmpRand}`);
  try {
    writeFileSync(tmpPath, content, { mode: originalMode, flag: 'wx' });
    try { chmodSync(tmpPath, originalMode); } catch {}
    if (exclusive) linkSync(tmpPath, targetPath);
    else renameSync(tmpPath, targetPath);
    try { chmodSync(targetPath, originalMode); } catch {}
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }
}

export function safeDeleteFile(targetPath, backupDir = null) {
  assertNoSymlinksInAncestors(targetPath);
  if (!existsSync(targetPath)) return;
  if (backupDir) {
    assertNoSymlinksInAncestors(backupDir);
    mkdirSync(backupDir, { recursive: true });
    const baseName = basename(targetPath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    const backupPath = join(backupDir, `${baseName}.${ts}.${rand}.bak`);
    copyFileSync(targetPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch {}
  }
  unlinkSync(targetPath);
}
