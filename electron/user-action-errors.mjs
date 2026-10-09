/** @typedef {{code:string,title:string,message:string,target:"api"|"qianchuan"|"models"|"aliyun"|null,action:string|null}} UserAction */
/** @type {Record<string, UserAction>} */
const actions = {
  FEATURE_NOT_ENTITLED: { code: "FEATURE_NOT_ENTITLED", title: "请检查功能授权", message: "当前授权尚未包含此功能，请在设置中查看授权状态。", target: "api", action: "查看授权" },
  SOFTWARE_AUTH_REQUIRED: { code: "SOFTWARE_AUTH_REQUIRED", title: "请验证软件授权", message: "设备授权凭证不完整，请重新验证软件授权。", target: "api", action: "查看授权" },
  QIANCHUAN_CONNECT_REQUIRED: { code: "QIANCHUAN_CONNECT_REQUIRED", title: "请先连接千川账户", message: "尚未连接千川账户，完成连接后即可查看视频与投放数据。", target: "qianchuan", action: "去连接千川" },
  QIANCHUAN_AUTH_EXPIRED: { code: "QIANCHUAN_AUTH_EXPIRED", title: "请重新连接千川账户", message: "千川账户授权已失效，请重新完成官方授权。", target: "qianchuan", action: "重新连接千川" },
  QIANCHUAN_CONFIG_REQUIRED: { code: "QIANCHUAN_CONFIG_REQUIRED", title: "请完善千川接入设置", message: "请在千川接入设置中补全应用配置。", target: "qianchuan", action: "去千川设置" },
  MODEL_API_SETUP_REQUIRED: { code: "MODEL_API_SETUP_REQUIRED", title: "请先配置模型 API", message: "模型 API 尚未配置完整，请在设置中填写接入点或地址、模型和密钥。", target: "models", action: "去配置 API" },
  MODEL_AUTH_REQUIRED: { code: "MODEL_AUTH_REQUIRED", title: "请检查 API 连接设置", message: "模型服务未通过认证，请检查所选服务的密钥、模型权限和账户状态。", target: "models", action: "去检查 API" },
  ALIYUN_SETUP_REQUIRED: { code: "ALIYUN_SETUP_REQUIRED", title: "请先连接去字幕服务", message: "去字幕服务密钥尚未配置，请先在设置中完成连接。", target: "aliyun", action: "去配置服务" },
  USER_INPUT_REQUIRED: { code: "USER_INPUT_REQUIRED", title: "请补充操作所需的信息", message: "请补充所需信息后重试。", target: null, action: null },
};

export function cleanOperationMessage(value) {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : value?.message || value?.reason || value?.detail || value?.error || "";
  return String(raw).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "").split(/\n操作：|\n错误码：|\n诊断编号：/)[0].trim();
}

/** Known prerequisites only; unknown failures retain their diagnostic path. @returns {UserAction|null} */
export function classifyUserAction(value, operation = "") {
  const message = cleanOperationMessage(value);
  const context = String(operation || value?.operation || "");
  const tagged = message.match(/\[ACTION_REQUIRED:([A-Z_]+)\]/);
  const code = actions[value?.code] ? value.code : tagged?.[1];
  if (code && actions[code]) return { ...actions[code], message: (tagged ? message.slice(tagged.index + tagged[0].length).trim() : message) || actions[code].message };
  for (const action of Object.values(actions)) if (message.includes(action.message)) return { ...action };
  const known = [
    ["QIANCHUAN_CONNECT_REQUIRED", /本机尚未完成千川授权|尚未连接千川账户|千川账户尚未授权|请先(?:连接|授权)千川/],
    ["QIANCHUAN_AUTH_EXPIRED", /千川(?:账户访问|账户)?授权(?:已过期|已失效)|千川授权已过期/],
    ["QIANCHUAN_CONFIG_REQUIRED", /请输入正确的千川 APP ID|千川 APP Secret 格式不正确|千川应用(?:尚未配置|未配置)/],
    ["MODEL_API_SETUP_REQUIRED", /所选 API 配置不完整|请先在设置中选择火山引擎或中转 API|(?:文本模型|视觉模型|中转|火山引擎|MiniMax).*API (?:Key )?未配置|视觉模型配置不完整|请补全模型.*配置/],
    ["ALIYUN_SETUP_REQUIRED", /请先在设置中保存(?:阿里云|云服务)密钥/],
    ["SOFTWARE_AUTH_REQUIRED", /设备授权凭证不完整，请重新验证软件授权/],
  ];
  for (const [key, pattern] of known)
    if (pattern.test(message)) return { ...actions[key], ...(key === "QIANCHUAN_CONFIG_REQUIRED" ? { message } : {}) };
  if (/qianchuan|千川/.test(context) && !/软件|设备|激活码|安全凭证/.test(message)) {
    if (/授权(?:已过期|已失效)|重新授权/.test(message)) return { ...actions.QIANCHUAN_AUTH_EXPIRED };
    if (/(?:账户|账号)?(?:未登录|尚未登录)|尚未完成授权/.test(message)) return { ...actions.QIANCHUAN_CONNECT_REQUIRED };
  }
  if (!/qianchuan|千川/.test(context) && /prompt-library|classifier|api-settings|提示词|分类|模型|API/.test(context) && /HTTP\s*(?:401|403)|Incorrect API key|invalid_api_key/i.test(message))
    return { ...actions.MODEL_AUTH_REQUIRED };
  if (/Endpoint ID 格式不正确|请填写(?:分类方案文本模型|素材分类视觉模型|火山引擎 API Key|中转 API Key)|(?:中转 Base URL|火山引擎 API Key|中转 API Key|MiniMax Base URL|MiniMax API Key)(?:格式不正确|不是有效的网址|必须使用)/.test(message))
    return { ...actions.MODEL_API_SETUP_REQUIRED, message };
  if (/^(?:请选择|请先选择|请填写|请输入|请先勾选|请先确认上传|至少选择|至少需要|素材创建日期的开始日期不能晚于|数据统计周期的开始日期不能晚于)/.test(message))
    return { ...actions.USER_INPUT_REQUIRED, message };
  return null;
}

export function userActionError(code, message = "") {
  const action = actions[code];
  if (!action) throw new Error("未知的操作引导类型");
  const error = new Error(message || action.message);
  error.code = code;
  return error;
}

/** Preserve the category through Electron's string-only rejected IPC messages. */
export function serializeUserAction(action) {
  return `[ACTION_REQUIRED:${action.code}] ${action.message}`;
}
