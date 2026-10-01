<#
.SYNOPSIS
  AI 媒体库 Windows 镜像克隆机器身份只读诊断脚本。

.DESCRIPTION
  只读取注册表和 WMI/CIM 信息，不修改系统，不需要管理员权限，
  不联网，不上传，仅向标准输出写一个 JSON。

  运行：
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose-windows-machine-identity.ps1
  保存本机结果：
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\diagnose-windows-machine-identity.ps1 > .\machine-identity.json

  在 5 台机器上分别运行后人工比对：
  1. current_v2_machine_code 是否确实完全相同。
  2. candidate_v3_machine_code 是否在 5 台机器上各不相同。
  3. 哪些因子 valid=true，哪些是厂商占位值。
  4. 如果 BIOS UUID 也在 5 台上相同，说明厂商批量写入了同一值；
     此时强因子可能只剩系统盘物理序列号，v3 组合规则需要重新评估。

  输出包含原始硬件标识，仅用于用户自己的本机诊断，请勿公开分享 JSON。
#>

$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$AppName = "ai-media-library"
$Nul = [char]0
$TotalTimer = [System.Diagnostics.Stopwatch]::StartNew()
$CimTimer = [System.Diagnostics.Stopwatch]::StartNew()
$FallbackPaths = New-Object System.Collections.Generic.List[string]
$MachineLabel = "MACHINE: $env:COMPUTERNAME"
Write-Output $MachineLabel

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $digest = $sha.ComputeHash($bytes)
    return (($digest | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha.Dispose()
  }
}

function Normalize-FactorValue {
  param($Value)
  if ($null -eq $Value) { return "" }
  $upper = ([string]$Value).Trim().ToUpperInvariant()
  return [System.Text.RegularExpressions.Regex]::Replace($upper, "[^\p{L}\p{Nd}]", "")
}

function Get-FactorInspection {
  param($Value)
  $normalized = Normalize-FactorValue $Value
  $reason = "valid"
  if ([string]::IsNullOrEmpty($normalized)) { $reason = "empty" }
  elseif ($normalized.Length -lt 6) { $reason = "too_short" }
  elseif ($normalized -match "^0+$") { $reason = "all_zero" }
  elseif ($normalized -match "^F+$") { $reason = "all_f" }
  elseif (@("TOBEFILLEDBYOEM", "DEFAULTSTRING", "SYSTEMSERIALNUMBER", "NONE", "NOTSPECIFIED") -contains $normalized) {
    $reason = "placeholder"
  }
  [pscustomobject]@{
    normalized = $(if ($reason -eq "valid") { $normalized } else { "" })
    valid = ($reason -eq "valid")
    reason = $reason
  }
}

function Get-FactorHash {
  param([string]$FactorName, [string]$NormalizedValue)
  if ([string]::IsNullOrEmpty($NormalizedValue)) { return "" }
  $payload = "license-machine-factor-v3${Nul}${AppName}${Nul}$($FactorName.ToLowerInvariant())${Nul}${NormalizedValue}"
  return (Get-Sha256Hex $payload).Substring(0, 32)
}

function Get-CurrentV2Code {
  param($MachineGuid)
  $stableSource = ([string]$MachineGuid).Trim().ToLowerInvariant()
  if ([string]::IsNullOrEmpty($stableSource)) { return "" }
  return "v2_$(Get-Sha256Hex "license-machine-code-v2${Nul}${AppName}${Nul}${stableSource}")"
}

function Test-VirtualAdapterText {
  param([string]$Text)
  return $Text -match "VIRTUAL|HYPER[- ]?V|VMWARE|VBOX|VIRTUALBOX|TAP|TUNNEL|LOOPBACK|BLUETOOTH|MINIPORT|VPN|WIREGUARD|TAILSCALE|HAMACHI|DOCKER|WSL"
}

function Get-ValidPhysicalMac {
  param($Value)
  $normalized = Normalize-FactorValue $Value
  if ($normalized -notmatch "^[A-F0-9]{12}$" -or $normalized -match "^0+$" -or $normalized -match "^F+$") { return "" }
  $firstOctet = [Convert]::ToInt32($normalized.Substring(0, 2), 16)
  if (($firstOctet -band 1) -ne 0 -or ($firstOctet -band 2) -ne 0) { return "" }
  return $normalized
}

function Get-WmicValue {
  param([string]$Text, [string]$Key)
  $matches = [regex]::Matches($Text, "(?im)^" + [regex]::Escape($Key) + "\s*=\s*(.+)$")
  $values = @()
  foreach ($match in $matches) {
    $candidate = $match.Groups[1].Value.Trim()
    if ($candidate) { $values += $candidate }
  }
  return $values
}

function Invoke-WmicRead {
  param([string[]]$Arguments)
  if (-not (Get-Command wmic.exe -ErrorAction SilentlyContinue)) { return "" }
  return ((& wmic.exe @Arguments 2>$null) | Out-String)
}

function Add-FallbackPath {
  param([string]$Name)
  if (-not $FallbackPaths.Contains($Name)) { [void]$FallbackPaths.Add($Name) }
}

$raw = [ordered]@{
  machine_guid = ""
  bios_uuid = ""
  baseboard_serial = ""
  system_disk_serial = ""
  cpu_processor_id = @()
  physical_mac = @()
}
$sources = [ordered]@{
  machine_guid = "unavailable"
  bios_uuid = "unavailable"
  baseboard_serial = "unavailable"
  system_disk_serial = "unavailable"
  cpu_processor_id = "unavailable"
  physical_mac = "unavailable"
}

try {
  $raw.machine_guid = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid
  $sources.machine_guid = "powershell_registry"
} catch {}

$os = $null
$cimAvailable = $false
try {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
  if ($null -ne $os) { $cimAvailable = $true }
} catch {}
try {
  $raw.bios_uuid = (Get-CimInstance -ClassName Win32_ComputerSystemProduct -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1).UUID
  if ($raw.bios_uuid) { $sources.bios_uuid = "powershell_cim" }
} catch {}
try {
  $raw.baseboard_serial = (Get-CimInstance -ClassName Win32_BaseBoard -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1).SerialNumber
  if ($raw.baseboard_serial) { $sources.baseboard_serial = "powershell_cim" }
} catch {}
try {
  $raw.cpu_processor_id = @(Get-CimInstance -ClassName Win32_Processor -OperationTimeoutSec 4 -ErrorAction Stop | ForEach-Object { $_.ProcessorId })
  if ($raw.cpu_processor_id.Count -gt 0) { $sources.cpu_processor_id = "powershell_cim" }
} catch {}
try {
  $systemDrive = if ($null -ne $os -and $os.SystemDrive) { $os.SystemDrive } elseif ($env:SystemDrive) { $env:SystemDrive } else { "C:" }
  $logical = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + $systemDrive + "'") -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
  $partition = Get-CimAssociatedInstance -InputObject $logical -ResultClassName Win32_DiskPartition -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
  $disk = Get-CimAssociatedInstance -InputObject $partition -ResultClassName Win32_DiskDrive -OperationTimeoutSec 4 -ErrorAction Stop | Select-Object -First 1
  $raw.system_disk_serial = $disk.SerialNumber
  if ($raw.system_disk_serial) { $sources.system_disk_serial = "powershell_cim" }
} catch {}
try {
  $adapterRows = @(Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "PhysicalAdapter=True AND MACAddress IS NOT NULL" -OperationTimeoutSec 4 -ErrorAction Stop)
  foreach ($adapter in $adapterRows) {
    if (-not (Test-VirtualAdapterText "$($adapter.Name) $($adapter.Description)")) {
      if ($adapter.MACAddress) { $raw.physical_mac += [string]$adapter.MACAddress }
    }
  }
  if ($raw.physical_mac.Count -gt 0) { $sources.physical_mac = "powershell_cim" }
} catch {}
$CimTimer.Stop()

if (-not (Get-FactorInspection $raw.machine_guid).valid) {
  Add-FallbackPath "reg.exe"
  $regOutput = ((& reg.exe query "HKLM\SOFTWARE\Microsoft\Cryptography" /v MachineGuid 2>$null) | Out-String)
  $matched = [regex]::Match($regOutput, "(?im)MachineGuid\s+REG_SZ\s+([^\r\n]+)")
  if ($matched.Success) {
    $raw.machine_guid = $matched.Groups[1].Value.Trim()
    $sources.machine_guid = "reg.exe"
  }
}

if (-not (Get-FactorInspection $raw.bios_uuid).valid) {
  Add-FallbackPath "wmic.exe"
  $value = @(Get-WmicValue (Invoke-WmicRead @("csproduct", "get", "UUID", "/value")) "UUID") | Select-Object -First 1
  if ($value) { $raw.bios_uuid = $value; $sources.bios_uuid = "wmic.exe" }
}
if (-not (Get-FactorInspection $raw.baseboard_serial).valid) {
  Add-FallbackPath "wmic.exe"
  $value = @(Get-WmicValue (Invoke-WmicRead @("baseboard", "get", "SerialNumber", "/value")) "SerialNumber") | Select-Object -First 1
  if ($value) { $raw.baseboard_serial = $value; $sources.baseboard_serial = "wmic.exe" }
}
if ($raw.cpu_processor_id.Count -eq 0 -or -not (Get-FactorInspection (($raw.cpu_processor_id | Sort-Object -Unique) -join "")).valid) {
  Add-FallbackPath "wmic.exe"
  $values = @(Get-WmicValue (Invoke-WmicRead @("cpu", "get", "ProcessorId", "/value")) "ProcessorId")
  if ($values.Count -gt 0) { $raw.cpu_processor_id = $values; $sources.cpu_processor_id = "wmic.exe" }
}
if (-not (Get-FactorInspection $raw.system_disk_serial).valid) {
  Add-FallbackPath "wmic.exe"
  if (-not $systemDrive) { $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { "C:" } }
  $associationText = Invoke-WmicRead @("path", "Win32_LogicalDiskToPartition", "get", "Antecedent,Dependent", "/format:list")
  $diskIndex = ""
  foreach ($block in [regex]::Split($associationText, "(?:\r?\n){2,}")) {
    if ($block -match [regex]::Escape($systemDrive) -and $block -match "Disk\s+#(\d+)") {
      $diskIndex = $Matches[1]
      break
    }
  }
  if ($diskIndex -ne "") {
    $value = @(Get-WmicValue (Invoke-WmicRead @("diskdrive", "where", "Index=$diskIndex", "get", "SerialNumber", "/value")) "SerialNumber") | Select-Object -First 1
    if ($value) { $raw.system_disk_serial = $value; $sources.system_disk_serial = "wmic.exe" }
  }
}

$validMacs = @($raw.physical_mac | ForEach-Object { Get-ValidPhysicalMac $_ } | Where-Object { $_ } | Sort-Object -Unique)
if ($validMacs.Count -eq 0) {
  Add-FallbackPath "wmic.exe"
  $nicText = Invoke-WmicRead @("nic", "where", "PhysicalAdapter=True and MACAddress is not null", "get", "MACAddress,Name,Description", "/format:list")
  $fallbackMacs = @()
  foreach ($block in [regex]::Split($nicText, "(?:\r?\n){2,}")) {
    $name = [regex]::Match($block, "(?im)^Name=(.*)$").Groups[1].Value.Trim()
    $description = [regex]::Match($block, "(?im)^Description=(.*)$").Groups[1].Value.Trim()
    $mac = [regex]::Match($block, "(?im)^MACAddress=(.*)$").Groups[1].Value.Trim()
    if ($mac -and -not (Test-VirtualAdapterText "$name $description")) { $fallbackMacs += $mac }
  }
  if ($fallbackMacs.Count -gt 0) {
    $raw.physical_mac = $fallbackMacs
    $sources.physical_mac = "wmic.exe"
    $validMacs = @($fallbackMacs | ForEach-Object { Get-ValidPhysicalMac $_ } | Where-Object { $_ } | Sort-Object -Unique)
  }
}

$factorResults = [ordered]@{}
$fullHashes = [ordered]@{}
$simpleFactors = @("machine_guid", "bios_uuid", "baseboard_serial", "system_disk_serial")
foreach ($name in $simpleFactors) {
  $inspection = Get-FactorInspection $raw[$name]
  $fullHash = if ($inspection.valid) { Get-FactorHash $name $inspection.normalized } else { "" }
  $fullHashes[$name] = $fullHash
  $factorResults[$name] = [ordered]@{
    raw_value = [string]$raw[$name]
    normalized_value = $inspection.normalized
    valid = $inspection.valid
    invalid_reason = $(if ($inspection.valid) { "" } else { $inspection.reason })
    hash_prefix = $(if ($fullHash) { $fullHash.Substring(0, 6) } else { "" })
    source = $sources[$name]
  }
}

$cpuNormalized = @( $raw.cpu_processor_id | ForEach-Object { (Get-FactorInspection $_).normalized } | Where-Object { $_ } | Sort-Object -Unique ) -join ""
$cpuInspection = Get-FactorInspection $cpuNormalized
$cpuHash = if ($cpuInspection.valid) { Get-FactorHash "cpu_processor_id" $cpuInspection.normalized } else { "" }
$fullHashes.cpu_processor_id = $cpuHash
$factorResults.cpu_processor_id = [ordered]@{
  raw_value = @($raw.cpu_processor_id)
  normalized_value = $cpuInspection.normalized
  valid = $cpuInspection.valid
  invalid_reason = $(if ($cpuInspection.valid) { "" } else { $cpuInspection.reason })
  hash_prefix = $(if ($cpuHash) { $cpuHash.Substring(0, 6) } else { "" })
  source = $sources.cpu_processor_id
}

$macNormalized = ($validMacs -join "")
$macInspection = Get-FactorInspection $macNormalized
$macReason = if ($macInspection.valid) { "" } elseif ($raw.physical_mac.Count -gt 0) { "randomized_or_invalid_mac" } else { $macInspection.reason }
$macHash = if ($macInspection.valid) { Get-FactorHash "physical_mac" $macInspection.normalized } else { "" }
$fullHashes.physical_mac = $macHash
$factorResults.physical_mac = [ordered]@{
  raw_value = @($raw.physical_mac)
  normalized_value = $macInspection.normalized
  valid = $macInspection.valid
  invalid_reason = $macReason
  hash_prefix = $(if ($macHash) { $macHash.Substring(0, 6) } else { "" })
  source = $sources.physical_mac
}

$v3Payload = "license-machine-code-v3${Nul}${AppName}${Nul}win32${Nul}"
$strongCount = 0
foreach ($name in @("machine_guid", "bios_uuid", "system_disk_serial")) {
  $factorHash = [string]$fullHashes[$name]
  if ($factorHash -match "^[a-f0-9]{32}$") {
    $v3Payload += "${name}=${factorHash}${Nul}"
    $strongCount += 1
  }
}
$candidateV3 = if ($strongCount -gt 0) { "v3_$(Get-Sha256Hex $v3Payload)" } else { "" }
$TotalTimer.Stop()

$result = [ordered]@{
  schema_version = 1
  app_name = $AppName
  current_v2_machine_code = Get-CurrentV2Code $raw.machine_guid
  candidate_v3_machine_code = $candidateV3
  factors = $factorResults
  collection = [ordered]@{
    duration_ms = [math]::Round($TotalTimer.Elapsed.TotalMilliseconds)
    cim_duration_ms = [math]::Round($CimTimer.Elapsed.TotalMilliseconds)
    powershell_cim_available = $cimAvailable
    fallback_used = ($FallbackPaths.Count -gt 0)
    fallback_paths = @($FallbackPaths)
    powershell_version = $PSVersionTable.PSVersion.ToString()
  }
  privacy = [ordered]@{
    read_only = $true
    administrator_required = $false
    network_used = $false
    uploaded = $false
  }
}

$Json = $result | ConvertTo-Json -Depth 8
$ClipboardText = $MachineLabel + [Environment]::NewLine + $Json
$Json | Write-Output
Set-Clipboard -Value $ClipboardText -ErrorAction SilentlyContinue
