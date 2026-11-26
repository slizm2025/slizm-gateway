param(
  [switch]$AutoStart
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Root = Split-Path -Parent $PSScriptRoot
$script:GwScript = Join-Path $script:Root 'scripts\gw.js'
$script:LogDir = Join-Path $script:Root 'logs'
$script:NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$script:AutoStart = [bool]$AutoStart
$script:Busy = $false
$script:CommandProcess = $null
$script:CommandKind = ''
$script:Status = $null
$script:OutFile = Join-Path $env:TEMP ("slizm-gateway-panel-{0}.out.log" -f $PID)
$script:ErrFile = Join-Path $env:TEMP ("slizm-gateway-panel-{0}.err.log" -f $PID)
$env:NO_COLOR = '1'

$script:L = @{
  Title = 'Slizm Gateway 控制台'
  Subtitle = '本地模型网关与 Web 管理'
  Gateway = '模型网关'
  Web = '管理 Web'
  Port = '端口'
  Checking = '正在检查'
  Running = '运行中'
  Stopped = '未运行'
  Disabled = '已禁用'
  Start = '启动服务'
  Stop = '停止服务'
  Restart = '重启服务'
  OpenWeb = '打开 Web'
  Logs = '日志目录'
  Refresh = '刷新状态'
  Busy = '正在处理，请稍候'
  Ready = '状态已更新'
  StartSuccess = '服务已启动'
  StopSuccess = '服务已停止'
  RestartSuccess = '服务已重启'
  OpenSuccess = '管理 Web 已打开'
  CommandFailed = '操作失败'
  GatewayStoppedHint = '启动服务后可使用模型网关'
  WebStoppedHint = '可点击“打开 Web”启动管理页面'
  WebDisabledHint = 'GATEWAY_WEB_ENABLED=0，管理 Web 已禁用'
  Active = '在途'
  Uptime = '运行'
  SourceChanged = '源码已更新，重启后生效'
  CloseBusy = '命令仍在执行，请完成后再关闭窗口。'
  StatusUnavailable = '无法读取服务状态'
  LogsOpened = '已打开日志目录'
  AllRunning = '网关与 Web 运行中 · 每 4 秒自动刷新'
  GatewayOnly = '仅网关运行中 · Web 未运行'
  WebOnly = '仅 Web 运行中 · 网关未运行'
  NoneRunning = '服务未运行'
  RequestsProcessing = '{0} 个请求处理中'
  WaitForRequests = '有请求处理中，结束后才能停止或重启'
  RestartToApply = '源码已更新，重启后加载最新代码'
  TipStart = '启动尚未运行的服务'
  TipStop = '停止网关和管理 Web'
  TipRestart = '重启网关和管理 Web'
  TipOpen = '打开管理 Web，未运行时会自动启动'
  TipLogs = '打开网关与管理 Web 的日志目录'
  TipRefresh = '立即刷新进程状态'
}

if (-not $script:NodePath) {
  [System.Windows.Forms.MessageBox]::Show('未找到 Node.js。请先安装 Node.js 20 或更高版本。', $script:L.Title, 'OK', 'Error') | Out-Null
  exit 1
}

$script:ColorInk = [System.Drawing.Color]::FromArgb(24, 33, 48)
$script:ColorMuted = [System.Drawing.Color]::FromArgb(100, 116, 139)
$script:ColorGreen = [System.Drawing.Color]::FromArgb(22, 163, 74)
$script:ColorRed = [System.Drawing.Color]::FromArgb(220, 38, 38)
$script:ColorAmber = [System.Drawing.Color]::FromArgb(217, 119, 6)
$script:ColorBlue = [System.Drawing.Color]::FromArgb(37, 99, 235)
$script:ColorLine = [System.Drawing.Color]::FromArgb(226, 232, 240)

function New-FlatButton {
  param([string]$Text, [int]$Width = 86, [switch]$Primary)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Width = $Width
  $button.Height = 34
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 1
  $button.FlatAppearance.BorderColor = if ($Primary) { $script:ColorBlue } else { $script:ColorLine }
  $button.BackColor = if ($Primary) { $script:ColorBlue } else { [System.Drawing.Color]::White }
  $button.ForeColor = if ($Primary) { [System.Drawing.Color]::White } else { $script:ColorInk }
  $button.Cursor = 'Hand'
  $button.Margin = New-Object System.Windows.Forms.Padding(3, 0, 3, 0)
  return $button
}

function ConvertTo-PlainText {
  param([AllowNull()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  $escape = [char]27
  $plain = [regex]::Replace($Text, "$escape\[[0-?]*[ -/]*[@-~]", '')
  $plain = [regex]::Replace($plain, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '')
  return $plain.Trim()
}

function Get-CommandFailureLine {
  param([AllowNull()][string]$Text)
  $plain = ConvertTo-PlainText $Text
  $lines = @($plain -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $line = $lines |
    Where-Object { $_ -match '失败|错误|无法|拒绝|占用|不可达|未及时|不存在|未知|用法|Error|failed|refused|unavailable|invalid' } |
    Select-Object -First 1
  if (-not $line) { $line = $script:L.CommandFailed }
  if ($line.Length -gt 220) { $line = $line.Substring(0, 217) + '...' }
  return $line
}

function Set-Message {
  param([string]$Text, [string]$Kind = 'normal')
  $Text = ConvertTo-PlainText $Text
  $script:Message.Text = $Text
  $script:Tip.SetToolTip($script:Message, $Text)
  switch ($Kind) {
    'success' { $script:Message.ForeColor = $script:ColorGreen }
    'error' { $script:Message.ForeColor = $script:ColorRed }
    'busy' { $script:Message.ForeColor = $script:ColorAmber }
    default { $script:Message.ForeColor = $script:ColorMuted }
  }
}

function Update-Buttons {
  $gatewayRunning = $script:Status -and $script:Status.gateway.running
  $webRunning = $script:Status -and $script:Status.web.running
  $webEnabled = -not $script:Status -or $script:Status.web.enabled
  $activeRequests = if ($script:Status) { [int]$script:Status.gateway.activeRequests } else { 0 }
  $canStop = $activeRequests -eq 0
  $allReady = $gatewayRunning -and ((-not $webEnabled) -or $webRunning)
  $anyRunning = $gatewayRunning -or $webRunning

  $script:BtnStart.Enabled = -not $script:Busy -and -not $allReady
  $script:BtnStop.Enabled = -not $script:Busy -and $anyRunning -and $canStop
  $script:BtnRestart.Enabled = -not $script:Busy -and $anyRunning -and $canStop
  $script:BtnOpenWeb.Enabled = -not $script:Busy -and $webEnabled
  $script:BtnLogs.Enabled = -not $script:Busy
  $script:BtnRefresh.Enabled = -not $script:Busy

  $waitHint = if ($canStop) { $script:L.TipRestart } else { $script:L.WaitForRequests }
  $script:Tip.SetToolTip($script:BtnStop, $(if ($canStop) { $script:L.TipStop } else { $script:L.WaitForRequests }))
  $script:Tip.SetToolTip($script:BtnRestart, $waitHint)

  $sourceChanged = $gatewayRunning -and $script:Status.gateway.sourceChanged
  if ($sourceChanged) {
    $script:BtnRestart.BackColor = $script:ColorAmber
    $script:BtnRestart.FlatAppearance.BorderColor = $script:ColorAmber
    $script:BtnRestart.ForeColor = [System.Drawing.Color]::White
    if ($canStop) { $script:Tip.SetToolTip($script:BtnRestart, $script:L.RestartToApply) }
  } else {
    $script:BtnRestart.BackColor = [System.Drawing.Color]::White
    $script:BtnRestart.FlatAppearance.BorderColor = $script:ColorLine
    $script:BtnRestart.ForeColor = $script:ColorInk
  }
}

function Format-Uptime {
  param([double]$Seconds)
  if ($Seconds -lt 60) { return ('{0}s' -f [int]$Seconds) }
  if ($Seconds -lt 3600) { return ('{0}m' -f [int]($Seconds / 60)) }
  if ($Seconds -lt 86400) { return ('{0}h {1}m' -f [int]($Seconds / 3600), [int](($Seconds % 3600) / 60)) }
  return ('{0}d {1}h' -f [int]($Seconds / 86400), [int](($Seconds % 86400) / 3600))
}

function Refresh-Status {
  if ($script:Busy) { return }
  try {
    $raw = & $script:NodePath $script:GwScript status --json 2>$null
    if ($LASTEXITCODE -ne 0) { throw "status exited with code $LASTEXITCODE" }
    $status = (($raw -join "`n") | ConvertFrom-Json)
    $script:Status = $status

    if ($status.gateway.running) {
      $script:GatewayDot.ForeColor = $script:ColorGreen
      $script:GatewayState.Text = $script:L.Running
      $details = @("PID $($status.gateway.pid)", "$($status.gateway.activeRequests) $($script:L.Active)", "$($script:L.Uptime) $(Format-Uptime $status.gateway.uptimeSec)")
      $script:GatewayDetail.Text = $details -join '  ·  '
      $script:GatewayDetail.ForeColor = if ($status.gateway.sourceChanged) { $script:ColorAmber } else { $script:ColorMuted }
      if ($status.gateway.sourceChanged) { $script:GatewayDetail.Text += "`r`n$($script:L.SourceChanged)" }
    } else {
      $script:GatewayDot.ForeColor = $script:ColorRed
      $script:GatewayState.Text = $script:L.Stopped
      $script:GatewayDetail.ForeColor = $script:ColorMuted
      $script:GatewayDetail.Text = $script:L.GatewayStoppedHint
    }

    if (-not $status.web.enabled) {
      $script:WebDot.ForeColor = $script:ColorMuted
      $script:WebState.Text = $script:L.Disabled
      $script:WebLink.Text = ''
      $script:WebDetail.Text = $script:L.WebDisabledHint
    } elseif ($status.web.running) {
      $script:WebDot.ForeColor = $script:ColorGreen
      $script:WebState.Text = $script:L.Running
      $script:WebLink.Text = $status.web.url
      $script:WebDetail.Text = "PID $($status.web.pid)  ·  $($script:L.Port) $($status.web.port)"
    } else {
      $script:WebDot.ForeColor = $script:ColorRed
      $script:WebState.Text = $script:L.Stopped
      $script:WebLink.Text = ''
      $script:WebDetail.Text = $script:L.WebStoppedHint
    }

    $allReady = $status.gateway.running -and ($status.web.running -or -not $status.web.enabled)
    $footerText = if ($allReady) {
      $script:L.AllRunning
    } elseif ($status.gateway.running) {
      $script:L.GatewayOnly
    } elseif ($status.web.running) {
      $script:L.WebOnly
    } else {
      $script:L.NoneRunning
    }
    if ($status.gateway.activeRequests -gt 0) {
      $footerText += ' · ' + ($script:L.RequestsProcessing -f $status.gateway.activeRequests)
    }
    $script:FooterLabel.Text = $footerText
    $script:FooterLabel.ForeColor = if ($allReady) { $script:ColorGreen } elseif ($status.gateway.running -or $status.web.running) { $script:ColorAmber } else { $script:ColorRed }
    Update-Buttons
  } catch {
    Set-Message $script:L.StatusUnavailable 'error'
    $script:FooterLabel.Text = $script:L.Stopped
    $script:FooterLabel.ForeColor = $script:ColorRed
  }
}

function Quote-Argument {
  param([string]$Value)
  if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
  return $Value
}

function Test-CommandOutcome {
  param([string]$Kind)
  # Windows PowerShell 5.1 在 Start-Process 同时使用输出重定向和 -PassThru 时拿不到 ExitCode
  # （进程句柄不保留退出码，实测恒为 $null），所以成功与否以服务实际状态为准。
  if (-not $script:Status) { return $false }
  $gatewayReady = [bool]$script:Status.gateway.running
  $webReady = (-not $script:Status.web.enabled) -or [bool]$script:Status.web.running
  switch ($Kind) {
    'down' { return (-not $gatewayReady) -and (-not $script:Status.web.running) }
    'open' { return [bool]$script:Status.web.running }
    default { return $gatewayReady -and $webReady }
  }
}

function Complete-Command {
  if (-not $script:CommandProcess) { return }
  if (-not $script:CommandProcess.HasExited) { return }

  $kind = $script:CommandKind
  $output = ''
  $errorOutput = ''
  if (Test-Path $script:OutFile) { $output = ([System.IO.File]::ReadAllText($script:OutFile, [System.Text.Encoding]::UTF8)).Trim() }
  if (Test-Path $script:ErrFile) { $errorOutput = ([System.IO.File]::ReadAllText($script:ErrFile, [System.Text.Encoding]::UTF8)).Trim() }
  $script:CommandProcess.Dispose()
  $script:CommandProcess = $null
  $script:Busy = $false
  $script:CommandKind = ''

  Refresh-Status

  if (Test-CommandOutcome $kind) {
    $success = @{
      up = $script:L.StartSuccess
      down = $script:L.StopSuccess
      restart = $script:L.RestartSuccess
      open = $script:L.OpenSuccess
    }[$kind]
    Set-Message $success 'success'
  } else {
    $detail = if ($errorOutput) { $errorOutput } else { $output }
    $failureLine = Get-CommandFailureLine $detail
    Set-Message ("{0}：{1}" -f $script:L.CommandFailed, $failureLine) 'error'
    $script:Tip.SetToolTip($script:Message, (ConvertTo-PlainText $detail))
  }
}

function Start-GatewayCommand {
  param([string]$Kind, [string[]]$Arguments, [string]$BusyMessage)
  if ($script:Busy) { return }

  Remove-Item -LiteralPath $script:OutFile, $script:ErrFile -Force -ErrorAction SilentlyContinue
  $script:Busy = $true
  $script:CommandKind = $Kind
  Set-Message $BusyMessage 'busy'
  Update-Buttons
  try {
    $allArguments = @($script:GwScript, $Kind) + $Arguments
    $argumentLine = ($allArguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $script:CommandProcess = Start-Process -FilePath $script:NodePath -ArgumentList $argumentLine -WorkingDirectory $script:Root -RedirectStandardOutput $script:OutFile -RedirectStandardError $script:ErrFile -PassThru -WindowStyle Hidden
  } catch {
    $script:Busy = $false
    Set-Message $_.Exception.Message 'error'
    Update-Buttons
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $script:L.Title
$form.ClientSize = New-Object System.Drawing.Size(620, 430)
$form.MinimumSize = New-Object System.Drawing.Size(636, 469)
$form.MaximumSize = New-Object System.Drawing.Size(636, 469)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(246, 248, 251)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$main = New-Object System.Windows.Forms.TableLayoutPanel
$main.Dock = 'Fill'
$main.ColumnCount = 1
$main.RowCount = 3
$main.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 44))) | Out-Null

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Fill'
$header.BackColor = [System.Drawing.Color]::FromArgb(24, 33, 48)
$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Text = $script:L.Title
$headerTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 16)
$headerTitle.ForeColor = [System.Drawing.Color]::White
$headerTitle.AutoSize = $true
$headerTitle.Location = New-Object System.Drawing.Point(20, 13)
$headerSubtitle = New-Object System.Windows.Forms.Label
$headerSubtitle.Text = $script:L.Subtitle
$headerSubtitle.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$headerSubtitle.AutoSize = $true
$headerSubtitle.Location = New-Object System.Drawing.Point(22, 44)
$header.Controls.Add($headerTitle)
$header.Controls.Add($headerSubtitle)

$content = New-Object System.Windows.Forms.TableLayoutPanel
$content.Dock = 'Fill'
$content.Padding = New-Object System.Windows.Forms.Padding(16, 14, 16, 10)
$content.ColumnCount = 2
$content.RowCount = 3
$content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$content.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 150))) | Out-Null
$content.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 54))) | Out-Null
$content.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null

$gatewayCard = New-Object System.Windows.Forms.GroupBox
$gatewayCard.Text = $script:L.Gateway
$gatewayCard.Dock = 'Fill'
$gatewayCard.Margin = New-Object System.Windows.Forms.Padding(0, 0, 7, 0)
$gatewayCard.BackColor = [System.Drawing.Color]::White
$script:GatewayDot = New-Object System.Windows.Forms.Label
$script:GatewayDot.Text = '●'
$script:GatewayDot.Font = New-Object System.Drawing.Font('Segoe UI', 15)
$script:GatewayDot.ForeColor = $script:ColorMuted
$script:GatewayDot.AutoSize = $true
$script:GatewayDot.Location = New-Object System.Drawing.Point(14, 28)
$script:GatewayState = New-Object System.Windows.Forms.Label
$script:GatewayState.Text = $script:L.Checking
$script:GatewayState.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$script:GatewayState.ForeColor = $script:ColorInk
$script:GatewayState.AutoSize = $true
$script:GatewayState.Location = New-Object System.Drawing.Point(42, 31)
$script:GatewayDetail = New-Object System.Windows.Forms.Label
$script:GatewayDetail.Text = ''
$script:GatewayDetail.ForeColor = $script:ColorMuted
$script:GatewayDetail.Location = New-Object System.Drawing.Point(16, 68)
$script:GatewayDetail.Size = New-Object System.Drawing.Size(250, 56)
$gatewayCard.Controls.Add($script:GatewayDot)
$gatewayCard.Controls.Add($script:GatewayState)
$gatewayCard.Controls.Add($script:GatewayDetail)

$webCard = New-Object System.Windows.Forms.GroupBox
$webCard.Text = $script:L.Web
$webCard.Dock = 'Fill'
$webCard.Margin = New-Object System.Windows.Forms.Padding(7, 0, 0, 0)
$webCard.BackColor = [System.Drawing.Color]::White
$script:WebDot = New-Object System.Windows.Forms.Label
$script:WebDot.Text = '●'
$script:WebDot.Font = New-Object System.Drawing.Font('Segoe UI', 15)
$script:WebDot.ForeColor = $script:ColorMuted
$script:WebDot.AutoSize = $true
$script:WebDot.Location = New-Object System.Drawing.Point(14, 28)
$script:WebState = New-Object System.Windows.Forms.Label
$script:WebState.Text = $script:L.Checking
$script:WebState.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$script:WebState.ForeColor = $script:ColorInk
$script:WebState.AutoSize = $true
$script:WebState.Location = New-Object System.Drawing.Point(42, 31)
$script:WebLink = New-Object System.Windows.Forms.LinkLabel
$script:WebLink.Text = ''
$script:WebLink.AutoSize = $true
$script:WebLink.Location = New-Object System.Drawing.Point(16, 68)
$script:WebLink.LinkColor = $script:ColorBlue
$script:WebLink.ActiveLinkColor = $script:ColorBlue
$script:WebDetail = New-Object System.Windows.Forms.Label
$script:WebDetail.Text = ''
$script:WebDetail.ForeColor = $script:ColorMuted
$script:WebDetail.Location = New-Object System.Drawing.Point(16, 94)
$script:WebDetail.Size = New-Object System.Drawing.Size(250, 28)
$webCard.Controls.Add($script:WebDot)
$webCard.Controls.Add($script:WebState)
$webCard.Controls.Add($script:WebLink)
$webCard.Controls.Add($script:WebDetail)

$actions = New-Object System.Windows.Forms.FlowLayoutPanel
$actions.Dock = 'Fill'
$actions.WrapContents = $false
$actions.FlowDirection = 'LeftToRight'
$actions.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$content.SetColumnSpan($actions, 2)
$script:BtnStart = New-FlatButton $script:L.Start 88 -Primary
$script:BtnStop = New-FlatButton $script:L.Stop 88
$script:BtnRestart = New-FlatButton $script:L.Restart 88
$script:BtnOpenWeb = New-FlatButton $script:L.OpenWeb 88 -Primary
$script:BtnLogs = New-FlatButton $script:L.Logs 82
$script:BtnRefresh = New-FlatButton $script:L.Refresh 82
$actions.Controls.Add($script:BtnStart)
$actions.Controls.Add($script:BtnStop)
$actions.Controls.Add($script:BtnRestart)
$actions.Controls.Add($script:BtnOpenWeb)
$actions.Controls.Add($script:BtnLogs)
$actions.Controls.Add($script:BtnRefresh)

$script:Message = New-Object System.Windows.Forms.Label
$script:Message.Text = $script:L.Ready
$script:Message.Dock = 'Fill'
$script:Message.ForeColor = $script:ColorMuted
$script:Message.TextAlign = 'MiddleLeft'
$script:Message.AutoEllipsis = $true
$content.SetColumnSpan($script:Message, 2)

$content.Controls.Add($gatewayCard, 0, 0)
$content.Controls.Add($webCard, 1, 0)
$content.Controls.Add($actions, 0, 1)
$content.Controls.Add($script:Message, 0, 2)

$footerPanel = New-Object System.Windows.Forms.Panel
$footerPanel.Dock = 'Fill'
$footerPanel.BackColor = [System.Drawing.Color]::White
$script:FooterLabel = New-Object System.Windows.Forms.Label
$script:FooterLabel.Text = $script:L.Checking
$script:FooterLabel.Dock = 'Fill'
$script:FooterLabel.TextAlign = 'MiddleLeft'
$script:FooterLabel.Padding = New-Object System.Windows.Forms.Padding(20, 0, 0, 0)
$script:FooterLabel.ForeColor = $script:ColorMuted
$footerPanel.Controls.Add($script:FooterLabel)

$main.Controls.Add($header, 0, 0)
$main.Controls.Add($content, 0, 1)
$main.Controls.Add($footerPanel, 0, 2)
$form.Controls.Add($main)

$script:Tip = New-Object System.Windows.Forms.ToolTip
$script:Tip.SetToolTip($script:GatewayDetail, $script:L.GatewayStoppedHint)
$script:Tip.SetToolTip($script:WebDetail, $script:L.WebStoppedHint)
$script:Tip.SetToolTip($script:BtnStart, $script:L.TipStart)
$script:Tip.SetToolTip($script:BtnStop, $script:L.TipStop)
$script:Tip.SetToolTip($script:BtnRestart, $script:L.TipRestart)
$script:Tip.SetToolTip($script:BtnOpenWeb, $script:L.TipOpen)
$script:Tip.SetToolTip($script:BtnLogs, $script:L.TipLogs)
$script:Tip.SetToolTip($script:BtnRefresh, $script:L.TipRefresh)

$script:BtnStart.Add_Click({ Start-GatewayCommand 'up' @('--no-open') $script:L.Busy })
$script:BtnStop.Add_Click({ Start-GatewayCommand 'down' @() $script:L.Busy })
$script:BtnRestart.Add_Click({ Start-GatewayCommand 'restart' @('--all') $script:L.Busy })
$script:BtnOpenWeb.Add_Click({ Start-GatewayCommand 'open' @() $script:L.Busy })
$script:BtnRefresh.Add_Click({ Refresh-Status; if (-not $script:Busy) { Set-Message $script:L.Ready 'normal' } })
$script:WebLink.Add_LinkClicked({ Start-GatewayCommand 'open' @() $script:L.Busy })
$script:BtnLogs.Add_Click({
  if (-not (Test-Path $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $script:LogDir)
  Set-Message $script:L.LogsOpened 'normal'
})

$script:CommandTimer = New-Object System.Windows.Forms.Timer
$script:CommandTimer.Interval = 200
$script:CommandTimer.Add_Tick({ Complete-Command })
$script:RefreshTimer = New-Object System.Windows.Forms.Timer
$script:RefreshTimer.Interval = 4000
$script:RefreshTimer.Add_Tick({ if (-not $script:Busy) { Refresh-Status } })

$form.Add_Shown({
  Refresh-Status
  $script:RefreshTimer.Start()
  $needsStart = $script:AutoStart -and (
    -not $script:Status -or
    -not $script:Status.gateway.running -or
    ($script:Status.web.enabled -and -not $script:Status.web.running)
  )
  if ($needsStart) {
    Start-GatewayCommand 'up' @('--no-open') $script:L.Busy
  }
})
$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($script:Busy) {
    $eventArgs.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show($script:L.CloseBusy, $script:L.Title, 'OK', 'Information') | Out-Null
  }
})
$form.Add_FormClosed({
  $script:CommandTimer.Stop()
  $script:RefreshTimer.Stop()
  if ($script:CommandProcess) { $script:CommandProcess.Dispose() }
  Remove-Item -LiteralPath $script:OutFile, $script:ErrFile -Force -ErrorAction SilentlyContinue
})

$script:CommandTimer.Start()
[void]$form.ShowDialog()
