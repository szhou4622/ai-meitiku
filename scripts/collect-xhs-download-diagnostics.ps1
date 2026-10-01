<#
.SYNOPSIS
  一次性收集 AI媒体库小红书下载的脱敏诊断证据。

.DESCRIPTION
  兼容 Windows PowerShell 5.1 与 PowerShell 7，不需要管理员权限。
  脚本不会读取或导出 Cookie 内容、激活码、xsec_token、完整作品链接和用户素材；
  不会重试作品下载。默认仅向小红书首页发起一次匿名连通性请求，可用
  -SkipNetwork 跳过。结果写到桌面 ZIP，发送这一份 ZIP 即可分析。
#>

param(
  [string]$InstallDirectory = "",
  [string]$AppDataDirectory = "",
  [string]$OutputDirectory = "",
  [switch]$SkipNetwork,
  [switch]$SkipWriteProbe
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$RunAt = Get-Date
$Stamp = $RunAt.ToString("yyyyMMdd-HHmmss")
if (-not $OutputDirectory) { $OutputDirectory = [Environment]::GetFolderPath("DesktopDirectory") }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $env:USERPROFILE "Desktop" }
if (-not $OutputDirectory) { $OutputDirectory = (Get-Location).Path }
if (-not $AppDataDirectory) { $AppDataDirectory = Join-Path $env:APPDATA "ai-media-library" }
try { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null } catch { $OutputDirectory = (Get-Location).Path }
$WorkRoot = Join-Path ([IO.Path]::GetTempPath()) "AI媒体库-小红书诊断-$Stamp"
$ResultZip = Join-Path $OutputDirectory "AI媒体库-小红书诊断-$Stamp.zip"
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

function Get-HashText {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return "" }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 16)
  } finally { $sha.Dispose() }
}

function Get-FileEvidence {
  param([string]$Path, [string]$Label, [bool]$IncludeHash = $true)
  if (-not $Path) { return [ordered]@{ label = $Label; exists = $false; size = 0; modified_at = ""; sha256 = "" } }
  $exists = Test-Path -LiteralPath $Path -PathType Leaf
  $item = if ($exists) { Get-Item -LiteralPath $Path } else { $null }
  [ordered]@{
    label = $Label
    exists = $exists
    size = if ($item) { $item.Length } else { 0 }
    modified_at = if ($item) { $item.LastWriteTimeUtc.ToString("o") } else { "" }
    sha256 = if ($item -and $IncludeHash) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" }
  }
}

function Protect-Text {
  param($Value)
  $text = [string]$Value
  if (-not $text) { return "" }
  $text = [regex]::Replace($text, "(?i)(xsec_token|access_token|refresh_token|cookie|authorization|activation[_ -]?code)(\s*[:=]\s*)([^\s&;]+)", '$1$2<redacted>')
  $text = [regex]::Replace($text, "(?i)Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer <redacted>")
  $text = [regex]::Replace($text, 'https?://[^\s"''<>]+', {
    param($match)
    try {
      $uri = [Uri]$match.Value
      return "$($uri.Scheme)://$($uri.Host)/<redacted-path>"
    } catch { return "<redacted-url>" }
  })
  return $text.Substring(0, [Math]::Min($text.Length, 1000))
}

function Get-UrlEvidence {
  param([string]$RawUrl)
  $result = [ordered]@{ valid = $false; host = ""; path_kind = "unknown"; work_ref_hash = ""; has_xsec_token = $false; query_keys = @() }
  if (-not $RawUrl) { return $result }
  try {
    $uri = [Uri]$RawUrl
    $result.valid = $uri.IsAbsoluteUri
    $result.host = $uri.Host.ToLowerInvariant()
    if ($uri.AbsolutePath -match "/explore/") { $result.path_kind = "explore" }
    elseif ($result.host -match "xhslink") { $result.path_kind = "short-link" }
    elseif ($uri.AbsolutePath -match "/discovery/item/") { $result.path_kind = "discovery-item" }
    $lastPart = ($uri.AbsolutePath.TrimEnd("/") -split "/")[-1]
    $result.work_ref_hash = Get-HashText $lastPart
    $keys = @()
    foreach ($part in $uri.Query.TrimStart("?") -split "&") {
      if (-not $part) { continue }
      $key = [Uri]::UnescapeDataString(($part -split "=", 2)[0]).ToLowerInvariant()
      if ($key) { $keys += $key }
    }
    $result.query_keys = @($keys | Sort-Object -Unique)
    $result.has_xsec_token = $result.query_keys -contains "xsec_token"
  } catch {}
  return $result
}

function Find-AppExecutable {
  param([string]$ExplicitDirectory)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($ExplicitDirectory) { [void]$candidates.Add((Join-Path $ExplicitDirectory "AI媒体库.exe")) }
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "AI媒体库|ai-media-library" })) {
    if ($process.Path) { [void]$candidates.Add($process.Path) }
  }
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $base) { continue }
    [void]$candidates.Add((Join-Path $base "Programs\AI媒体库\AI媒体库.exe"))
    [void]$candidates.Add((Join-Path $base "Programs\ai-media-library\AI媒体库.exe"))
    [void]$candidates.Add((Join-Path $base "AI媒体库\AI媒体库.exe"))
  }
  if (Get-PSDrive -Name HKCU -ErrorAction SilentlyContinue) {
    foreach ($root in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*")) {
      foreach ($entry in @(Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*AI媒体库*" })) {
        if ($entry.InstallLocation) { [void]$candidates.Add((Join-Path $entry.InstallLocation "AI媒体库.exe")) }
      }
    }
  }
  $found = @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
  return $found | Select-Object -First 1
}

function Get-PathProbe {
  param([string]$Path)
  $probe = [ordered]@{ path_hash = Get-HashText $Path; exists = $false; writable = $null; free_bytes = $null; error = "" }
  if (-not $Path) { return $probe }
  $probe.exists = Test-Path -LiteralPath $Path -PathType Container
  try {
    $root = [IO.Path]::GetPathRoot($Path)
    if ($root) { $probe.free_bytes = (Get-PSDrive -Name $root.Substring(0, 1)).Free }
  } catch {}
  if ($probe.exists -and -not $SkipWriteProbe) {
    $testFile = Join-Path $Path ".aiml-xhs-diagnostic-$([Guid]::NewGuid().ToString('N')).tmp"
    try {
      [IO.File]::WriteAllText($testFile, "diagnostic", [Text.Encoding]::UTF8)
      Remove-Item -LiteralPath $testFile -Force
      $probe.writable = $true
    } catch {
      $probe.writable = $false
      $probe.error = Protect-Text $_.Exception.Message
      Remove-Item -LiteralPath $testFile -Force
    }
  }
  return $probe
}

try {
$AppExe = Find-AppExecutable $InstallDirectory
$AppRoot = if ($AppExe) { Split-Path -Parent $AppExe } else { "" }
$Resources = if ($AppRoot) { Join-Path $AppRoot "resources" } else { "" }
$RuntimeRoot = if ($Resources) { Join-Path $Resources "downloaders\xhs-runtime" } else { "" }
$RuntimePython = if ($RuntimeRoot) { Join-Path $RuntimeRoot "python.exe" } else { "" }
$Launcher = if ($RuntimeRoot) { Join-Path $RuntimeRoot "xhs_launcher.py" } else { "" }
$ParserPath = if ($RuntimeRoot) { Join-Path $RuntimeRoot "Lib\site-packages\xhs_adapters\parsing\page.py" } else { "" }
$InitialStatePath = if ($RuntimeRoot) { Join-Path $RuntimeRoot "Lib\site-packages\xhs_adapters\parsing\_initial_state.py" } else { "" }

$TaskPath = Join-Path $AppDataDirectory "video-downloads\tasks.json"
$taskEvidence = @()
$pathProbes = @()
if (Test-Path -LiteralPath $TaskPath -PathType Leaf) {
  try {
    $taskDocument = Get-Content -LiteralPath $TaskPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $tasks = if ($taskDocument.tasks) { @($taskDocument.tasks) } else { @($taskDocument) }
    $xhsTasks = @($tasks | Where-Object { $_.platform -eq "xiaohongshu" } | Sort-Object updatedAt -Descending | Select-Object -First 100)
    foreach ($task in $xhsTasks) {
      $urlEvidence = Get-UrlEvidence ([string]$task.url)
      $taskEvidence += [ordered]@{
        task_ref = Get-HashText ([string]$task.id)
        status = [string]$task.status
        progress = $task.progress
        message = Protect-Text $task.message
        error = Protect-Text $task.error
        created_at = [string]$task.createdAt
        updated_at = [string]$task.updatedAt
        completed_at = [string]$task.completedAt
        url = $urlEvidence
        output_file_count = @($task.outputFiles).Count
        output_directory_hash = Get-HashText ([string]$task.outputDirectory)
      }
    }
    foreach ($directory in @($xhsTasks | ForEach-Object { [string]$_.outputDirectory } | Where-Object { $_ } | Select-Object -Unique -First 5)) {
      $pathProbes += Get-PathProbe $directory
    }
  } catch {
    $taskEvidence = @([ordered]@{ read_error = Protect-Text $_.Exception.Message })
  }
}

$parserCapabilities = [ordered]@{ present = $false; robust_initial_state_loader = $false; responsive_value_unwrap = $false; diagnostic_codes = $false }
if ($ParserPath -and (Test-Path -LiteralPath $ParserPath -PathType Leaf)) {
  try {
    $parserCapabilities.present = $true
    $parserText = Get-Content -LiteralPath $ParserPath -Raw -Encoding UTF8
    $parserCapabilities.robust_initial_state_loader = $parserText.Contains("load_latest_initial_state")
    $parserCapabilities.responsive_value_unwrap = $parserText.Contains("def _unwrap")
    $parserCapabilities.diagnostic_codes = $parserText.Contains("initial-state-invalid") -and $parserText.Contains("note-state-missing")
  } catch {}
}

$runtimeVersion = ""
if ((Test-Path -LiteralPath $RuntimePython -PathType Leaf) -and (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
  $runtimeVersion = ((& $RuntimePython $Launcher version 2>&1) | Out-String).Trim()
}

$network = [ordered]@{ skipped = [bool]$SkipNetwork; dns = ""; tcp_443 = $null; http_status = $null; final_host = ""; content_type = ""; has_initial_state = $null; error = "" }
if (-not $SkipNetwork) {
  try { $network.dns = ((Resolve-DnsName "www.xiaohongshu.com" -Type A | Select-Object -First 3 -ExpandProperty IPAddress) -join ",") } catch { $network.error = Protect-Text $_.Exception.Message }
  try { $network.tcp_443 = [bool](Test-NetConnection "www.xiaohongshu.com" -Port 443 -InformationLevel Quiet) } catch {}
  try {
    $headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36" }
    $response = Invoke-WebRequest -Uri "https://www.xiaohongshu.com/" -Headers $headers -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 5
    $network.http_status = [int]$response.StatusCode
    $finalUri = $response.BaseResponse.ResponseUri
    if (-not $finalUri -and $response.BaseResponse.RequestMessage) { $finalUri = $response.BaseResponse.RequestMessage.RequestUri }
    if ($finalUri) { $network.final_host = ([Uri]$finalUri).Host }
    $network.content_type = [string]$response.Headers["Content-Type"]
    $network.has_initial_state = ([string]$response.Content).Contains("window.__INITIAL_STATE__")
  } catch {
    if ($_.Exception.Response) { $network.http_status = [int]$_.Exception.Response.StatusCode }
    $network.error = Protect-Text $_.Exception.Message
  }
}

$failed = @($taskEvidence | Where-Object { $_.status -eq "failed" })
$summaryFlags = [ordered]@{
  xhs_task_count = $taskEvidence.Count
  failed_count = $failed.Count
  initial_state_invalid_count = @($failed | Where-Object { $_.error -match "初始状态无法解析|initial-state-invalid" -or $_.message -match "初始状态无法解析|initial-state-invalid" }).Count
  note_state_missing_count = @($failed | Where-Object { $_.error -match "没有作品数据|note-state-missing" -or $_.message -match "没有作品数据|note-state-missing" }).Count
  failed_without_xsec_count = @($failed | Where-Object { $_.url.valid -and -not $_.url.has_xsec_token }).Count
}

$authRoot = Join-Path $AppDataDirectory "video-downloads\auth"
$cookieDb = Join-Path $AppDataDirectory "Partitions\ai-media-download-xiaohongshu\Cookies"
$networkCookieDb = Join-Path $AppDataDirectory "Partitions\ai-media-download-xiaohongshu\Network\Cookies"
$cookieExport = Join-Path $authRoot "xiaohongshu.cookies.txt"
$appVersion = if ($AppExe) { (Get-Item -LiteralPath $AppExe).VersionInfo.ProductVersion } else { "" }
$signature = if ($AppExe) { Get-AuthenticodeSignature -LiteralPath $AppExe } else { $null }

$report = [ordered]@{
  schema = "aiml-xhs-diagnostic-v1"
  generated_at = $RunAt.ToUniversalTime().ToString("o")
  privacy = "No cookies, activation codes, xsec_token values, full work URLs, or user media are included."
  system = [ordered]@{
    os = [Environment]::OSVersion.VersionString
    architecture = $env:PROCESSOR_ARCHITECTURE
    powershell = $PSVersionTable.PSVersion.ToString()
    timezone = [TimeZoneInfo]::Local.Id
  }
  application = [ordered]@{
    found = [bool]$AppExe
    version = $appVersion
    executable_hash = Get-HashText $AppExe
    signature_status = if ($signature) { [string]$signature.Status } else { "unavailable" }
    signature_subject = if ($signature -and $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
    app_data_found = Test-Path -LiteralPath $AppDataDirectory -PathType Container
  }
  runtime = [ordered]@{
    version = Protect-Text $runtimeVersion
    launcher = Get-FileEvidence $Launcher "xhs_launcher.py"
    parser = Get-FileEvidence $ParserPath "page.py"
    initial_state_reader = Get-FileEvidence $InitialStatePath "_initial_state.py"
    capabilities = $parserCapabilities
  }
  login_evidence = [ordered]@{
    partition_cookie_db = @(
      (Get-FileEvidence $cookieDb "Electron Cookies database (legacy path)" $false),
      (Get-FileEvidence $networkCookieDb "Electron Cookies database (network path)" $false)
    )
    transient_cookie_export = Get-FileEvidence $cookieExport "temporary downloader cookie file" $false
    note = "Only file metadata is recorded; cookie contents are never read or copied."
  }
  tasks = $taskEvidence
  output_paths = $pathProbes
  network = $network
  findings = $summaryFlags
}

$JsonPath = Join-Path $WorkRoot "diagnostic-report.json"
$TextPath = Join-Path $WorkRoot "诊断摘要.txt"
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $JsonPath -Encoding UTF8
@"
AI媒体库小红书下载诊断摘要
生成时间：$($RunAt.ToString("yyyy-MM-dd HH:mm:ss zzz"))
客户端版本：$appVersion
小红书后端版本：$runtimeVersion
小红书任务数：$($summaryFlags.xhs_task_count)
失败任务数：$($summaryFlags.failed_count)
初始状态无法解析：$($summaryFlags.initial_state_invalid_count)
初始状态没有作品数据：$($summaryFlags.note_state_missing_count)
失败链接缺少 xsec_token：$($summaryFlags.failed_without_xsec_count)
新版安全解析器：$($parserCapabilities.robust_initial_state_loader)
响应式包装兼容：$($parserCapabilities.responsive_value_unwrap)
匿名网络检查已跳过：$([bool]$SkipNetwork)

请只发送同目录生成的 ZIP。ZIP 不包含 Cookie、完整链接、令牌、激活码或用户素材。
"@ | Set-Content -LiteralPath $TextPath -Encoding UTF8

if (Test-Path -LiteralPath $ResultZip) { Remove-Item -LiteralPath $ResultZip -Force }
Compress-Archive -Path (Join-Path $WorkRoot "*") -DestinationPath $ResultZip -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $ResultZip -PathType Leaf)) { throw "诊断结果压缩失败" }
Remove-Item -LiteralPath $WorkRoot -Recurse -Force
Write-Host "诊断完成。请把下面这一份文件发回：" -ForegroundColor Green
Write-Host $ResultZip -ForegroundColor Cyan
exit 0
} catch {
  $message = Protect-Text $_.Exception.Message
  $failurePath = Join-Path $OutputDirectory "AI媒体库-小红书诊断-失败-$Stamp.txt"
  try {
    @("诊断脚本未完成。", "错误：$message", "请把这个失败日志发回分析。") | Set-Content -LiteralPath $failurePath -Encoding UTF8
  } catch {}
  Write-Host "诊断脚本未完成：$message" -ForegroundColor Red
  Write-Host "失败日志：$failurePath" -ForegroundColor Yellow
  exit 1
}
