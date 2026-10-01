const HASH_PREFIX = /^[a-f0-9]{6}$/i;
const CODE_PREFIX = /^v3_[a-f0-9]{6}$/i;
const FACTOR_LABELS = Object.freeze({
  machine_guid: "MachineGuid",
  bios_uuid: "BIOS UUID",
  system_disk_serial: "系统盘序列号",
  baseboard_serial: "主板序列号",
  cpu_processor_id: "CPU ID",
  physical_mac: "物理网卡",
  io_platform_uuid: "IOPlatformUUID",
  io_platform_serial_number: "IOPlatformSerialNumber",
  hardware_model: "硬件型号",
});

/** Copyable, deliberately incomplete local evidence for support staff. */
export function redactedIdentityDiagnosticText(diagnostic) {
  const platform = diagnostic?.platform === "win32" || diagnostic?.platform === "darwin"
    ? diagnostic.platform : "unknown";
  const candidate = String(diagnostic?.candidateCodePrefix ?? "");
  const lines = [
    "AI媒体库 · 本地脱敏机器身份诊断",
    `平台: ${platform}`,
    `采集状态: ${["ready", "pending", "failed", "unsupported"].includes(diagnostic?.state) ? diagnostic.state : "unknown"}`,
    `候选码前缀: ${CODE_PREFIX.test(candidate) ? candidate.toLowerCase() : "未取得"}`,
    "因子哈希前 6 位（不能用于自动授权）:",
  ];
  const factors = Array.isArray(diagnostic?.factors) ? diagnostic.factors : [];
  for (const factor of factors) {
    if (!Object.hasOwn(FACTOR_LABELS, factor?.name)) continue;
    const prefix = String(factor?.hashPrefix ?? "");
    lines.push(`${FACTOR_LABELS[factor.name]}: ${HASH_PREFIX.test(prefix) ? prefix.toLowerCase() : "未取得"}`);
  }
  lines.push("完整序列号、设备凭证和完整机器码均未包含。激活失败需人工核对，不会自动授权。");
  return lines.join("\n");
}
