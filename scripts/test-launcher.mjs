// 启动入口的回归测试：start.cmd → start.vbs → gw.js up，以及管理页的应用窗口打开方式。
// 历史问题一：start.cmd 拉起 control-panel.ps1 后，Windows 11 默认终端会给它一个常驻黑框窗口，
// -WindowStyle Hidden 在 Windows Terminal 下不生效。
// 历史问题二：控制台把命令动词丢了，实际执行 gw.js --no-open；命令行窗口还会在服务就绪期间一直留着。
// 现在入口是 wscript.exe + start.vbs：没有控制台宿主进程，gw.js up 隐藏执行，只留下一个应用窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAppBrowser } from '../src/admin/lifecycle.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const panelPath = join(root, 'scripts', 'control-panel.ps1');
const startCmdPath = join(root, 'start.cmd');
const startVbsPath = join(root, 'start.vbs');
const openCmdPath = join(root, 'open.cmd');
const openVbsPath = join(root, 'open.vbs');
const gwPath = join(root, 'scripts', 'gw.js');
const windows = process.platform === 'win32';

// 控制台按钮实际用的动词与参数，与 control-panel.ps1 里的调用点一致。
const panelCases = [
  { kind: 'up', args: ['--no-open'] },
  { kind: 'down', args: [] },
  { kind: 'restart', args: ['--all'] },
  { kind: 'open', args: [] },
];

const wizardScript = `
$ErrorActionPreference = 'Stop'
$path = $env:LAUNCHER_PANEL
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
$result = [ordered]@{}
$result['errorCount'] = @($parseErrors).Count
$result['errors'] = @($parseErrors | ForEach-Object { '{0}: {1}' -f $_.Extent.StartLineNumber, $_.Message })
$result['assignFound'] = $false
$result['cases'] = @()
if (@($parseErrors).Count -eq 0) {
  $assign = $null
  foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
    if ($node.Left.Extent.Text -eq '$allArguments') { $assign = $node }
  }
  if ($assign) {
    $result['assignFound'] = $true
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
      if ($fn.Name -eq 'Quote-Argument') { Invoke-Expression $fn.Extent.Text }
    }
    $script:GwScript = 'C:\\gw\\scripts\\gw.js'
    foreach ($case in (ConvertFrom-Json $env:LAUNCHER_CASES)) {
      $Kind = [string]$case.kind
      $Arguments = @($case.args | ForEach-Object { [string]$_ })
      $allArguments = @(Invoke-Expression $assign.Right.Extent.Text)
      $result['cases'] += ,([ordered]@{
        kind = $Kind
        argv = @($allArguments | ForEach-Object { [string]$_ })
        argumentLine = ($allArguments | ForEach-Object { Quote-Argument $_ }) -join ' '
      })
    }
  }
}
$result | ConvertTo-Json -Compress -Depth 6
`;

test('start.cmd 转交 start.vbs，不再拉起控制台窗口', async () => {
  const raw = await readFile(startCmdPath);

  // cmd.exe 按当前代码页读批处理，这里保持纯 ASCII，避免中文在不同区域设置下变成乱码命令。
  assert.ok(![...raw].some((byte) => byte > 0x7f), 'start.cmd 应保持 ASCII');

  const lines = raw.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(lines.slice(0, 3), ['@echo off', 'setlocal', 'cd /d "%~dp0"']);

  const launch = lines.find((line) => line.startsWith('start '));
  assert.ok(launch, 'start.cmd 应启动 start.vbs');
  // start 让 cmd 立即退出：否则批处理会等 wscript 跑完，命令行窗口要陪跑到服务就绪。
  assert.ok(launch.startsWith('start "" '), 'start.cmd 应让 cmd 立即退出，不等 wscript');
  assert.match(launch, /wscript\.exe/i, '应交给 wscript 启动，PowerShell 会重新分配一个控制台窗口');
  assert.match(launch, /"%~dp0start\.vbs"/);

  assert.equal(lines[lines.length - 1], 'exit /b 0');
  assert.ok(!lines.some((line) => /^pause$/i.test(line)), 'start.cmd 不应留下需要按键的暂停窗口');
  assert.ok(
    !lines.some((line) => /powershell|control-panel/i.test(line)),
    'start.cmd 不应再把 WinForms 控制台窗口拉起来，它是黑框的来源',
  );
});

test('start.vbs 隐藏执行 gw.js up，并把输出写进 logs/launcher.log', async () => {
  const raw = await readFile(startVbsPath);

  // Windows Script Host 对无 BOM 的 .vbs 按系统代码页解析，这里同样只用 ASCII。
  assert.ok(![...raw].some((byte) => byte > 0x7f), 'start.vbs 应保持 ASCII，中文只出现在日志里');
  const text = raw.toString('utf8');
  assert.match(text, /CreateObject\("WScript\.Shell"\)/);
  assert.match(text, /"scripts\\gw\.js"/);
  assert.match(text, /"launcher\.log"/);
  // 窗口样式 0 + 等待完成：既不留黑框，也能拿到真实退出码。
  assert.match(text, /, 0,\s*True\)/, 'gw.js up 必须以隐藏窗口运行并等待结束');
  assert.match(text, /MsgBox/, '启动失败时要弹出提示，不能静默退出');
  assert.match(text, /WScript\.Quit 1/);
});

test('start.vbs 用 wscript 拉起 gw.js up（隐藏运行、写入日志、退出码 0）', {
  skip: windows ? false : 'wscript.exe 仅 Windows 可用',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-vbs-test-'));
  const markerPath = join(dir, 'marker.txt');
  try {
    // 桩项目：只放 start.vbs 需要的 scripts/gw.js，不必复制 node_modules，也不占用真实端口。
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await copyFile(startVbsPath, join(dir, 'start.vbs'));
    await writeFile(join(dir, 'scripts', 'gw.js'), [
      "const { writeFileSync } = require('node:fs');",
      "console.log('stub gw.js invoked: ' + process.argv.slice(2).join(' '));",
      `writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join(' ') + '|' + process.cwd());`,
    ].join('\n'));

    await execFileAsync('wscript.exe', ['//Nologo', join(dir, 'start.vbs')], { timeout: 60_000 });

    const marker = await readFile(markerPath, 'utf8');
    const [argv, cwd] = marker.split('|');
    assert.equal(argv, 'up', 'start.vbs 必须执行 gw.js up（带上命令动词）');
    assert.equal(resolve(cwd).toLowerCase(), resolve(dir).toLowerCase(), 'wscript 应把工作目录切到项目根');

    const log = await readFile(join(dir, 'logs', 'launcher.log'), 'utf8');
    assert.match(log, /stub gw\.js invoked: up/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('管理页优先用 Chrome/Edge 的 --app 应用窗口打开', () => {
  const envVars = {
    ProgramFiles: join('C:', 'Program Files'),
    'ProgramFiles(x86)': join('C:', 'Program Files (x86)'),
    LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local'),
  };
  const chrome = join(envVars.ProgramFiles, 'Google/Chrome/Application/chrome.exe');
  const edge = join(envVars['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe');
  const url = 'http://127.0.0.1:48731/';
  const args = [`--app=${url}`, '--no-first-run', '--no-default-browser-check'];

  assert.deepEqual(
    resolveAppBrowser(url, { platform: 'win32', envVars, fileExists: (path) => path === chrome }),
    { command: chrome, args },
  );
  assert.equal(
    resolveAppBrowser(url, { platform: 'win32', envVars, fileExists: (path) => path === edge }).command,
    edge,
    '没有 Chrome 时应退回 Edge',
  );
  // 两个浏览器都找不到、显式禁用应用模式、非 Windows：都返回 null，由 openBrowser 退回默认浏览器。
  assert.equal(resolveAppBrowser(url, { platform: 'win32', envVars, fileExists: () => false }), null);
  assert.equal(resolveAppBrowser(url, { platform: 'win32', mode: 'default', envVars, fileExists: () => true }), null);
  assert.equal(resolveAppBrowser(url, { platform: 'linux', envVars, fileExists: () => true }), null);
});

test('control-panel.ps1 保持 Windows PowerShell 5.1 能读的编码', async () => {
  const raw = await readFile(panelPath);

  // 5.1 对无 BOM 的 .ps1 按 ANSI 解析，中文串会变乱码并连带出语法错误。
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'control-panel.ps1 必须带 UTF-8 BOM');

  const text = raw.toString('utf8');
  const lineFeeds = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  assert.equal(crlf, lineFeeds, 'control-panel.ps1 应统一为 CRLF 行尾');
});

test('控制台把命令动词拼在 gw.js 之后', async () => {
  const panel = await readFile(panelPath, 'utf8');

  assert.match(
    panel,
    /\$allArguments = @\(\$script:GwScript, \$Kind\) \+ \$Arguments/,
    '命令动词 $Kind 必须紧跟 gw.js，否则实际执行的是 gw.js --no-open',
  );
  assert.doesNotMatch(panel, /\$allArguments = @\(\$script:GwScript\) \+ \$Arguments/);
});

test('控制台按钮用的动词都在 gw.js 支持表里', async () => {
  const [panel, gw] = await Promise.all([readFile(panelPath, 'utf8'), readFile(gwPath, 'utf8')]);

  const tableMatch = gw.match(/const table = \{([\s\S]*?)\n\};/);
  assert.ok(tableMatch, 'gw.js 应有命令表');
  const supported = new Set([...tableMatch[1].matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*cmd[A-Za-z]*/gm)].map((match) => match[1]));
  assert.ok(supported.has('up') && supported.has('down'), 'gw.js 命令表应包含 up / down');

  const verbs = new Set([...panel.matchAll(/Start-GatewayCommand '([a-z][a-z-]*)'/g)].map((match) => match[1]));
  assert.deepEqual([...verbs].sort(), ['down', 'open', 'restart', 'up']);
  for (const verb of verbs) {
    assert.ok(supported.has(verb), `控制台调用了 gw.js 不认识的命令: ${verb}`);
  }
});

test('命令结果按服务状态判定，而不是子进程退出码', async () => {
  const panel = await readFile(panelPath, 'utf8');
  const start = panel.indexOf('function Complete-Command');
  const end = panel.indexOf('function Start-GatewayCommand');
  assert.ok(start > 0 && end > start, '应能找到 Complete-Command / Start-GatewayCommand');

  const complete = panel.slice(start, end);
  assert.match(complete, /Test-CommandOutcome \$kind/, '成功与否必须回读服务状态');
  assert.doesNotMatch(complete, /ExitCode/, 'Start-Process 重定向 + -PassThru 时 ExitCode 恒为 $null，不能据此判失败');
  assert.match(panel, /function Test-CommandOutcome/);
});

test(
  '控制台脚本通过 PowerShell 解析并生成正确的 gw.js 命令行',
  { skip: windows ? false : '仅验证 Windows PowerShell 5.1 的解析与拼接' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-launcher-test-'));
    const scriptPath = join(dir, 'probe.ps1');
    try {
      await writeFile(scriptPath, `\ufeff${wizardScript}`, 'utf8');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          env: { ...process.env, LAUNCHER_PANEL: panelPath, LAUNCHER_CASES: JSON.stringify(panelCases) },
          timeout: 60_000,
        },
      );

      const report = JSON.parse(stdout.trim());
      assert.equal(report.errorCount, 0, `PowerShell 解析报错: ${report.errors.join('; ')}`);
      assert.equal(report.assignFound, true, '应能在脚本里找到 $allArguments 拼接语句');
      assert.equal(report.cases.length, panelCases.length);

      for (const item of report.cases) {
        assert.deepEqual(
          item.argv,
          ['C:\\gw\\scripts\\gw.js', item.kind, ...panelCases.find((entry) => entry.kind === item.kind).args],
          `${item.kind} 的命令行应以 gw.js 与动词开头`,
        );
      }
      const up = report.cases.find((item) => item.kind === 'up');
      assert.equal(up.argumentLine, 'C:\\gw\\scripts\\gw.js up --no-open');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('open.cmd 与 open.vbs 保持 ASCII 并无黑框调用 gw.js open', async () => {
  const cmdRaw = await readFile(openCmdPath);
  const vbsRaw = await readFile(openVbsPath);
  assert.ok(![...cmdRaw].some((byte) => byte > 0x7f), 'open.cmd 应保持 ASCII');
  assert.ok(![...vbsRaw].some((byte) => byte > 0x7f), 'open.vbs 应保持 ASCII');

  const cmdText = cmdRaw.toString('utf8');
  assert.match(cmdText, /start "" wscript\.exe \/\/Nologo "%~dp0open\.vbs"/i);

  const vbsText = vbsRaw.toString('utf8');
  assert.match(vbsText, /"scripts\\gw\.js"/);
  assert.match(vbsText, / open > /);
  assert.match(vbsText, /, 0,\s*True\)/);
});
