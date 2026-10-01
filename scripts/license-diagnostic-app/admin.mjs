#!/usr/bin/env node
const baseUrl = String(process.env.LICENSE_BASE_URL || "https://license.dadaozixun.com/api/license").replace(/\/$/, "");
const adminToken = String(process.env.LICENSE_ADMIN_API_TOKEN || "").trim();
if (!adminToken) {
  console.error("请通过环境变量 LICENSE_ADMIN_API_TOKEN 提供管理员令牌。");
  process.exit(2);
}

const [command = "", ...args] = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
};

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(result.message || result.error || `HTTP ${response.status}`);
  return result;
}

try {
  if (command === "create") {
    const operator = valueAfter("--operator");
    const result = await post("/admin/device-diagnostic/challenge", { operator });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "list") {
    const result = await post("/admin/device-diagnostic/list", {
      state: valueAfter("--state"),
      limit: Number(valueAfter("--limit") || 50),
    });
    console.table(result.items);
  } else if (["approve", "same", "reject"].includes(command)) {
    const reportId = String(args[0] || "").trim();
    const decision = {
      approve: "approve_new_installation",
      same: "confirm_same_installation",
      reject: "reject",
    }[command];
    const result = await post("/admin/device-diagnostic/review", {
      report_id: reportId,
      decision,
      operator: valueAfter("--operator"),
      reason: valueAfter("--reason"),
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("用法：\n  admin.mjs create --operator <操作人>\n  admin.mjs list [--state pending] [--limit 50]\n  admin.mjs approve|same|reject <报告ID> --operator <操作人> --reason <原因>");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
