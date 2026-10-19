$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$taskState = @{
  Submitted = $false
  Running = $false
  Process = $null
  OutputTask = $null
  ErrorTask = $null
}
$taskForm = New-Object System.Windows.Forms.Form
$taskForm.Text = 'HL 正式支付 · 本机安全输入'
$taskForm.StartPosition = 'CenterScreen'
$taskForm.ClientSize = New-Object System.Drawing.Size(760,330)
$taskForm.FormBorderStyle = 'FixedDialog'
$taskForm.MaximizeBox = $false
$taskForm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',10)

$taskNotice = New-Object System.Windows.Forms.Label
$taskNotice.Location = New-Object System.Drawing.Point(22,18)
$taskNotice.Size = New-Object System.Drawing.Size(715,100)
$taskNotice.Text = "请填写微信小程序虚拟支付的「现网／正式 AppKey」，不要填写沙箱 AppKey。`r`n获取位置：微信公众平台 → 虚拟支付 → 基本配置 → 基础配置。`r`n提交后将核验正式密钥，并开通 VIP 和人工牵线正式支付。`r`n密钥仅经本机内存管道提交，不写入文件、命令行或聊天。"
$taskForm.Controls.Add($taskNotice)

$taskLabel = New-Object System.Windows.Forms.Label
$taskLabel.Location = New-Object System.Drawing.Point(22,140)
$taskLabel.Size = New-Object System.Drawing.Size(220,30)
$taskLabel.Text = '现网／正式 AppKey'
$taskForm.Controls.Add($taskLabel)

$taskInput = New-Object System.Windows.Forms.TextBox
$taskInput.Location = New-Object System.Drawing.Point(245,137)
$taskInput.Size = New-Object System.Drawing.Size(490,30)
$taskInput.MaxLength = 128
$taskInput.UseSystemPasswordChar = $true
$taskForm.Controls.Add($taskInput)

$taskStatus = New-Object System.Windows.Forms.Label
$taskStatus.Location = New-Object System.Drawing.Point(22,190)
$taskStatus.Size = New-Object System.Drawing.Size(715,64)
$taskStatus.Text = '目标：cloud1-d2gza7q9c8d69c721 / hlApi。此操作不会代您下单或付款。'
$taskForm.Controls.Add($taskStatus)

$taskSubmit = New-Object System.Windows.Forms.Button
$taskSubmit.Location = New-Object System.Drawing.Point(430,272)
$taskSubmit.Size = New-Object System.Drawing.Size(305,38)
$taskSubmit.Text = '保存正式密钥并开通支付'
$taskForm.Controls.Add($taskSubmit)
$taskForm.AcceptButton = $taskSubmit

$taskTimer = New-Object System.Windows.Forms.Timer
$taskTimer.Interval = 300
$taskTimer.Add_Tick({
  if (-not $taskState.Running -or $null -eq $taskState.Process) { return }
  try {
    if (-not $taskState.Process.HasExited) { return }
    if (-not $taskState.OutputTask.IsCompleted -or -not $taskState.ErrorTask.IsCompleted) { return }
    $taskTimer.Stop()
    $taskState.Running = $false
    $taskForm.UseWaitCursor = $false
    $taskSafeCode = 'FORMAL_PAYMENT_RESULT_UNKNOWN'
    $taskResult = $null
    try {
      # Only the structured safe response is interpreted. Never display raw output.
      $taskReply = $taskState.OutputTask.GetAwaiter().GetResult()
      if ($taskReply.Length -gt 65536) { throw 'Invalid response size' }
      $taskResult = $taskReply | ConvertFrom-Json -ErrorAction Stop
      if ($null -eq $taskResult -or $taskResult -is [array] -or $taskResult.status -isnot [string]) {
        throw 'Invalid response object'
      }
      if ($taskResult.code -is [string] -and $taskResult.code -cmatch '^[A-Z][A-Z0-9_]{2,63}$') {
        $taskSafeCode = $taskResult.code
      }
    } catch {
      $taskSafeCode = 'FORMAL_PAYMENT_RESULT_UNKNOWN'
    } finally {
      $taskReply = $null
    }
    $taskInput.Clear()
    if ($taskState.Process.ExitCode -eq 0 -and $null -ne $taskResult -and $taskResult.status -ceq 'enabled') {
      $taskStatus.Text = '正式支付已开通并核验成功。请重新进入小程序刷新支付页面。'
      [System.Windows.Forms.MessageBox]::Show($taskStatus.Text,'开通成功') | Out-Null
      $taskForm.Close()
    } else {
      $taskStatus.Text = "尚未确认开通成功。编号：$taskSafeCode`r`n请将此编号告知助手，等待核查，不要重复提交或发送密钥。"
      [System.Windows.Forms.MessageBox]::Show($taskStatus.Text,'等待核查') | Out-Null
    }
    $taskResult = $null
    $taskState.OutputTask = $null
    $taskState.ErrorTask = $null
    $taskState.Process.Dispose()
    $taskState.Process = $null
  } catch {
    $taskTimer.Stop()
    $taskInput.Clear()
    $taskForm.UseWaitCursor = $false
    $taskStatus.Text = '开通结果待核查。编号：FORMAL_PAYMENT_RESULT_UNKNOWN。请告知助手，不要重复提交。'
    # Retain a running child; do not terminate a possibly submitted cloud update.
    if ($null -ne $taskState.Process) {
      try { $taskState.Running = -not $taskState.Process.HasExited } catch { $taskState.Running = $true }
    }
  }
})

$taskSubmit.Add_Click({
  if ($taskState.Submitted) { return }
  $taskValue = $taskInput.Text.Trim()
  if ($taskValue.Length -lt 16 -or $taskValue.Length -gt 128 -or $taskValue -match '\s') {
    $taskValue = $null
    [System.Windows.Forms.MessageBox]::Show('请填写完整的现网／正式 AppKey。','尚未提交') | Out-Null
    return
  }
  # Lock before starting the child. Unknown outcomes must never be retried here.
  $taskState.Submitted = $true
  $taskSubmit.Enabled = $false
  $taskInput.Enabled = $false
  $taskForm.UseWaitCursor = $true
  $taskStatus.Text = '正在核验正式密钥、配置支付并回读结果，请稍候；不要重复操作。'
  $taskPayload = $null
  try {
    $taskStart = New-Object System.Diagnostics.ProcessStartInfo
    $taskStart.FileName = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $taskStart.Arguments = '"D:\HL_dev_cloud\scripts\enable-formal-payment.mjs" --apply-stdin'
    $taskStart.WorkingDirectory = 'D:\HL_dev_cloud'
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardInput = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $taskStart.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $taskState.Process = [System.Diagnostics.Process]::Start($taskStart)
    $taskState.Running = $true
    # Drain both pipes concurrently to avoid a full stderr pipe blocking stdout.
    $taskState.OutputTask = $taskState.Process.StandardOutput.ReadToEndAsync()
    $taskState.ErrorTask = $taskState.Process.StandardError.ReadToEndAsync()
    $taskPayload = @{ productionAppKey = $taskValue } | ConvertTo-Json -Compress
    $taskState.Process.StandardInput.WriteLine($taskPayload)
    $taskState.Process.StandardInput.Close()
    $taskInput.Clear()
    $taskTimer.Start()
  } catch {
    $taskInput.Clear()
    $taskForm.UseWaitCursor = $false
    $taskStatus.Text = '本机提交未完成。编号：FORMAL_PAYMENT_SUBMIT_UNKNOWN。请告知助手核查，不要重复提交。'
    if ($null -ne $taskState.Process) {
      try { $taskState.Process.StandardInput.Close() } catch { }
      # A started child may already have submitted the update. Observe its result.
      if ($null -ne $taskState.OutputTask -and $null -ne $taskState.ErrorTask) { $taskTimer.Start() }
    }
  } finally {
    $taskValue = $null
    $taskPayload = $null
  }
})

$taskForm.Add_FormClosing({
  param($taskSender, $taskEvent)
  if ($taskState.Running) {
    $taskEvent.Cancel = $true
    $taskStatus.Text = '正在等待本次提交结果，请暂勿关闭；不要重复启动开通工具。'
  }
})

try {
  [void]$taskForm.ShowDialog()
} finally {
  $taskInput.Clear()
  $taskTimer.Stop()
  $taskTimer.Dispose()
  if ($null -ne $taskState.Process -and -not $taskState.Running) { $taskState.Process.Dispose() }
  $taskState.OutputTask = $null
  $taskState.ErrorTask = $null
  $taskForm.Dispose()
}
