const form = document.getElementById("diagnostic-form");
const input = document.getElementById("verification-code");
const button = document.getElementById("submit-button");
const status = document.getElementById("status");
const runtime = document.getElementById("runtime");

function showStatus(kind, message) {
  status.className = `status visible ${kind}`;
  status.textContent = message;
}

input.addEventListener("input", () => {
  const compact = input.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
  input.value = compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = "正在安全采集…";
  showStatus("pending", "正在读取并哈希本机设备因子，请勿关闭工具。此过程通常只需几秒钟。");
  try {
    const result = await window.deviceDiagnostic.submit(input.value);
    if (result?.ok !== true) throw new Error(String(result?.message || "设备核验失败，请稍后重试。"));
    showStatus("pending", `${result.message}\n报告编号：${result.reportId}`);
    input.disabled = true;
    button.textContent = "已提交，等待管理员确认";
  } catch (error) {
    showStatus("error", error instanceof Error ? error.message : String(error));
    button.disabled = false;
    button.textContent = "重新采集并上传";
  }
});

window.deviceDiagnostic.platform().then((value) => {
  runtime.textContent = `${value.platform} · ${value.arch} · 工具版本 ${value.version}`;
}).catch(() => {});
