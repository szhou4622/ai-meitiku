/** @typedef {{code:string,title:string,message:string,target:"api"|"qianchuan"|"models"|"aliyun"|null,action:string|null}} UserAction */
/** @type {Record<string, UserAction>} */
const actions = {
  INSUFFICIENT_POINTS: { code: "INSUFFICIENT_POINTS", title: "积分不足", message: "可用积分不足，请充值或兑换积分后重试。", target: "api", action: "去充值积分" },
  INVALID_REDEEM_CODE: { code: "INVALID_REDEEM_CODE", title: "请检查积分码", message: "请输入有效的媒体库积分码。", target: "api", action: "查看积分兑换" },
  REDEEM_CODE_NOT_FOUND: { code: "REDEEM_CODE_NOT_FOUND", title: "请检查积分码", message: "积分码无效，请核对后重试。", target: "api", action: "查看积分兑换" },
  REDEEM_CODE_USED: { code: "REDEEM_CODE_USED", title: "积分码已被使用", message: "该积分码已被其他账户兑换，请核对积分码或联系管理员。", target: "api", action: "查看积分兑换" },
  LEGACY_CODE_REVIEW_REQUIRED: { code: "LEGACY_CODE_REVIEW_REQUIRED", title: "请核对旧积分码", message: "该旧码需管理员核对，不能直接作为积分码兑换。", target: "api", action: "查看积分兑换" },
  LEGACY_BALANCE_REVIEW_REQUIRED: { code: "LEGACY_BALANCE_REVIEW_REQUIRED", title: "历史积分待核对", message: "历史积分余额需管理员核对后迁移，请联系管理员。", target: "api", action: "查看积分账户" },
  QUOTE_EXPIRED: { code: "QUOTE_EXPIRED", title: "请重新确认积分报价", message: "积分报价已过期，请重新发起任务并确认最新报价。", target: null, action: null },
  QUOTE_CONFIGURATION_CHANGED: { code: "QUOTE_CONFIGURATION_CHANGED", title: "积分报价已更新", message: "积分报价已更新，请重新确认后运行。", target: null, action: null },
  PLATFORM_API_UNAVAILABLE: { code: "PLATFORM_API_UNAVAILABLE", title: "积分生成暂不可用", message: "当前功能的积分生成暂不可用，请稍后重试，或在 AI 服务设置中检查可用方式。", target: "models", action: "查看 AI 服务设置" },
  PLATFORM_FEATURE_UNAVAILABLE: { code: "PLATFORM_FEATURE_UNAVAILABLE", title: "积分生成暂不可用", message: "当前功能的积分生成尚未开放，请在 AI 服务设置中检查可用方式。", target: "models", action: "查看 AI 服务设置" },
  CONSUMPTION_DISABLED: { code: "CONSUMPTION_DISABLED", title: "积分消费暂不可用", message: "积分消费暂不可用，请稍后重试，或在 AI 服务设置中检查可用方式。", target: "models", action: "查看 AI 服务设置" },
  SUBTITLE_FILE_TOO_LARGE: { code: "SUBTITLE_FILE_TOO_LARGE", title: "请选择较小的视频", message: "上传文件不能超过 1 GB，请压缩视频或分段后重新上传。", target: null, action: null },
  PLATFORM_TASK_CANCELLED: { code: "PLATFORM_TASK_CANCELLED", title: "已取消生成", message: "已取消，本次未提交任务，也未扣积分。", target: null, action: null },
  OPERATION_CANCELLED: { code: "OPERATION_CANCELLED", title: "操作已取消", message: "操作已取消。", target: null, action: null },
  TASK_IN_PROGRESS: { code: "TASK_IN_PROGRESS", title: "任务正在处理中", message: "已有任务正在处理中，请等待完成后再操作，或先取消待处理队列。", target: null, action: null },
  PLATFORM_TASK_PENDING: { code: "PLATFORM_TASK_PENDING", title: "任务仍在处理中", message: "任务仍在处理中，请稍后查看原任务状态，不要重复提交。", target: null, action: null },
  NO_ACTIVE_TASK: { code: "NO_ACTIVE_TASK", title: "当前没有可操作的任务", message: "当前没有符合本次操作的任务，请刷新任务状态后查看。", target: null, action: null },
  RESOURCE_CHANGED: { code: "RESOURCE_CHANGED", title: "内容已变化，请重新选择", message: "所选内容已变化或不再可用，请刷新后重新选择。", target: null, action: null },
  USER_FILE_REQUIRED: { code: "USER_FILE_REQUIRED", title: "请检查所选文件", message: "请检查所选文件的格式、大小和内容后重试。", target: null, action: null },
  DEVICE_AUTH_FAILED: { code: "DEVICE_AUTH_FAILED", title: "请重新验证设备授权", message: "设备会话未通过验证，请在授权设置中重新验证。", target: "api", action: "查看授权" },
  DEVICE_CHANGED: { code: "DEVICE_CHANGED", title: "设备绑定已变化", message: "设备绑定已变化，请在授权设置中重新验证后继续。", target: "api", action: "查看授权" },
  POINTS_CREDENTIAL_REQUIRED: { code: "POINTS_CREDENTIAL_REQUIRED", title: "请先完成设备授权", message: "请先完成设备授权验证，再查看或兑换积分。", target: "api", action: "查看授权" },
  PLATFORM_CREDENTIAL_REQUIRED: { code: "PLATFORM_CREDENTIAL_REQUIRED", title: "请先完成设备授权", message: "请先完成设备授权验证，再使用积分生成。", target: "api", action: "查看授权" },
  POINTS_PREVIEW_REDEMPTION_DISABLED: { code: "POINTS_PREVIEW_REDEMPTION_DISABLED", title: "请在正式客户端兑换", message: "源码预览不提交真实积分码，请使用正式客户端兑换。", target: null, action: null },
  LICENSE_DISABLED: { code: "LICENSE_DISABLED", title: "当前授权已停用", message: "当前授权已停用，请联系管理员核对授权状态。", target: "api", action: "查看授权" },
  FEIGUA_AUTH_REQUIRED: { code: "FEIGUA_AUTH_REQUIRED", title: "请重新登录热点采集", message: "请在热点采集页面完成登录后继续。", target: null, action: null },
  FEIGUA_VERIFICATION_REQUIRED: { code: "FEIGUA_VERIFICATION_REQUIRED", title: "请完成平台验证", message: "平台需要图形验证，请在已打开的平台登录窗口完成验证后继续。", target: null, action: null },
  FEIGUA_ENTRY_REQUIRED: { code: "FEIGUA_ENTRY_REQUIRED", title: "请设置登录入口", message: "请在热点采集页面配置并保存登录入口网址。", target: null, action: null },
  FEIGUA_CANCELLED: { code: "FEIGUA_CANCELLED", title: "操作已取消", message: "采集或登录检查已取消。", target: null, action: null },
  FEATURE_NOT_ENTITLED: { code: "FEATURE_NOT_ENTITLED", title: "请检查功能授权", message: "当前授权尚未包含此功能，请在设置中查看授权状态。", target: "api", action: "查看授权" },
  SOFTWARE_AUTH_REQUIRED: { code: "SOFTWARE_AUTH_REQUIRED", title: "请验证软件授权", message: "设备授权凭证不完整，请重新验证软件授权。", target: "api", action: "查看授权" },
  QIANCHUAN_CONNECT_REQUIRED: { code: "QIANCHUAN_CONNECT_REQUIRED", title: "请先连接千川账户", message: "尚未连接千川账户，完成连接后即可查看视频与投放数据。", target: "qianchuan", action: "去连接千川" },
  QIANCHUAN_AUTH_EXPIRED: { code: "QIANCHUAN_AUTH_EXPIRED", title: "请重新连接千川账户", message: "千川账户授权已失效，请重新完成官方授权。", target: "qianchuan", action: "重新连接千川" },
  QIANCHUAN_CONFIG_REQUIRED: { code: "QIANCHUAN_CONFIG_REQUIRED", title: "请完善千川接入设置", message: "请在千川接入设置中补全应用配置。", target: "qianchuan", action: "去千川设置" },
  MODEL_API_SETUP_REQUIRED: { code: "MODEL_API_SETUP_REQUIRED", title: "请先配置模型 API", message: "模型 API 尚未配置完整，请在设置中填写接入点或地址、模型和密钥。", target: "models", action: "去配置 API" },
  MODEL_AUTH_REQUIRED: { code: "MODEL_AUTH_REQUIRED", title: "请检查 API 连接设置", message: "模型服务未通过认证，请检查所选服务的密钥、模型权限和账户状态。", target: "models", action: "去检查 API" },
  MODEL_QUOTA_REQUIRED: { code: "MODEL_QUOTA_REQUIRED", title: "模型服务额度不足", message: "所选模型服务的余额或配额不足，请检查该服务账户的额度后重试。", target: "models", action: "查看 AI 服务设置" },
  MODEL_RATE_LIMITED: { code: "MODEL_RATE_LIMITED", title: "请求过于频繁", message: "模型服务暂时限制了请求频率，请稍后重试或减少同时运行的任务。", target: null, action: null },
  MODEL_OUTPUT_INCOMPLETE: { code: "MODEL_OUTPUT_INCOMPLETE", title: "生成内容待补充", message: "AI 返回的内容不完整或格式不符合要求。请查看已保存内容，决定是否手动补充或重新生成；不会自动重复提交。", target: null, action: null },
  MODEL_RESPONSE_TIMEOUT: { code: "MODEL_RESPONSE_TIMEOUT", title: "AI 服务响应超时", message: "AI 服务未在等待时间内完成响应。请先查看已保存内容和原任务状态，再决定是否重试，避免重复提交。", target: null, action: null },
  MODEL_SERVICE_UNAVAILABLE: { code: "MODEL_SERVICE_UNAVAILABLE", title: "AI 服务暂不可用", message: "AI 服务暂时无法完成请求，请稍后再试。若任务已提交，请先查看原任务状态与积分记录。", target: null, action: null },
  MODEL_CONTENT_RESTRICTED: { code: "MODEL_CONTENT_RESTRICTED", title: "AI 未完成这次生成", message: "AI 服务拒绝生成或限制了部分内容。请检查素材与要求后再决定是否调整；已有返回内容可先查看。", target: null, action: null },
  OPERATION_BLOCKED: { code: "OPERATION_BLOCKED", title: "请先完成当前任务", message: "当前操作暂不可执行，请先完成或停止相关任务后重试。", target: null, action: null },
  ALIYUN_SETUP_REQUIRED: { code: "ALIYUN_SETUP_REQUIRED", title: "请先连接去字幕服务", message: "去字幕服务密钥尚未配置，请先在设置中完成连接。", target: "aliyun", action: "去配置服务" },
  USER_INPUT_REQUIRED: { code: "USER_INPUT_REQUIRED", title: "请补充操作所需的信息", message: "请补充所需信息后重试。", target: null, action: null },
};

// Preserve an actual exception's classification when Electron drops Error properties.
export const UNEXPECTED_DIAGNOSTIC_MARKER = "\n诊断类型：异常";

function operationMessage(value) {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : value?.message || value?.reason || value?.detail || value?.error || "";
  return typeof raw === "object" && raw !== null ? String(raw.message || raw.reason || raw.detail || "") : String(raw);
}

export function cleanOperationMessage(value) {
  return operationMessage(value).replace(/^.*?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "").split(/\n操作：|\n错误码：|\n诊断编号：/)[0].trim();
}

/** Known prerequisites only; unknown failures retain their diagnostic path. @returns {UserAction|null} */
export function classifyUserAction(value, operation = "") {
  // A failed, already-submitted task may have charged points; keep its diagnostic and billing details.
  if (value?.terminalFailure === true || value?.billingPending === true || value?.error?.terminalFailure === true || value?.error?.billingPending === true) return null;
  const raw = operationMessage(value);
  const message = cleanOperationMessage(value);
  if (value?.category === "unexpected" || raw.includes(UNEXPECTED_DIAGNOSTIC_MARKER)) return null;
  // These are actual failures, even if their text mentions an otherwise normal prerequisite.
  if (["TypeError", "ReferenceError", "SyntaxError", "RangeError"].includes(value?.name)
      || /(?:^|\s)(?:TypeError|ReferenceError|SyntaxError|RangeError):/.test(raw)
      || /^任务处理失败[，,].*(?:扣除|积分结算|积分结算记录)/.test(message)) return null;
  const context = String(operation || value?.operation || raw.match(/remote method '([^']+)'/)?.[1] || "");
  if ((value?.cancelled === true || value?.canceled === true) && !value?.error)
    return { ...actions.OPERATION_CANCELLED };
  if (value?.blocked === true && !value?.error)
    return { ...actions.OPERATION_BLOCKED, message: message || actions.OPERATION_BLOCKED.message };
  const tagged = message.match(/\[ACTION_REQUIRED:([A-Z_]+)\]/);
  const code = actions[value?.code] ? value.code : actions[value?.error?.code] ? value.error.code : tagged?.[1] || raw.match(/\n错误码：\s*([A-Z][A-Z_0-9]*)/)?.[1];
  const preservesInput = key => ["USER_INPUT_REQUIRED", "USER_FILE_REQUIRED", "RESOURCE_CHANGED", "OPERATION_BLOCKED"].includes(key);
  if (code && actions[code]) return { ...actions[code], ...(preservesInput(code) ? { message: (tagged ? message.slice(tagged.index + tagged[0].length).trim() : message) || actions[code].message } : {}) };
  for (const action of Object.values(actions)) if (message === action.message) return { ...action };
  const known = [
    ["INSUFFICIENT_POINTS", /可用积分不足|积分余额不足|积分不足，请(?:充值|兑换)/],
    ["INVALID_REDEEM_CODE", /请输入有效的媒体库积分码/],
    ["REDEEM_CODE_NOT_FOUND", /积分码无效，请核对后重试/],
    ["REDEEM_CODE_USED", /积分码已被其他账户兑换/],
    ["LEGACY_CODE_REVIEW_REQUIRED", /该旧码需管理员核对，不能直接作为积分码兑换/],
    ["LEGACY_BALANCE_REVIEW_REQUIRED", /历史积分余额需管理员核对后迁移/],
    ["QUOTE_EXPIRED", /积分报价已过期，请重新发起任务/],
    ["QUOTE_CONFIGURATION_CHANGED", /积分报价已更新，请重新确认后运行/],
    ["PLATFORM_API_UNAVAILABLE", /此功能的(?:积分生成服务|平台积分接口)尚未开放|此服务商的(?:分类草案|资料识别|打标)积分模式尚未开放/],
    ["PLATFORM_FEATURE_UNAVAILABLE", /^提示词库积分接口尚未开放/],
    ["CONSUMPTION_DISABLED", /平台积分消费暂不可用/],
    ["SUBTITLE_FILE_TOO_LARGE", /^上传文件不能超过 1 GB/],
    ["PLATFORM_TASK_CANCELLED", /^已取消，本次未提交任务，也未扣积分。$/],
    ["TASK_IN_PROGRESS", /^(?:已有分类任务正在运行|已有文案转写任务正在进行|仍有去字幕任务运行或等待提交|请等待当前批次完成，或先取消待处理队列)/],
    ["PLATFORM_TASK_PENDING", /^(?:任务仍在处理，请稍后查看原任务|任务状态需要确认，请查看原任务，不要重复提交)/],
    ["NO_ACTIVE_TASK", /^(?:当前没有正在运行的分类任务|当前任务无需重试|该任务无需重试同步|成片尚未完成|该任务没有可继续查询的云端编号|本批次已没有待提交视频|本批次没有暂停的待提交视频|本批次没有可取消的待提交视频)/],
    ["RESOURCE_CHANGED", /^(?:提示词已被删除，请重新选择|提示词已发生变化，请重新打开后再保存|参考图片不存在(?:，请重新选择)?|当前分类方案不存在|下载任务不存在|CSV (?:字段|数据)选择已过期，请重新选择文件|当前授权页面已(?:失效|过期)，请重新发起授权|原视频已变化，请重新添加)/],
    ["USER_FILE_REQUIRED", /^(?:CSV (?:至少需要表头和 1 行数据|最多支持 (?:5000 行|128 列)数据|存在未闭合的引号|中没有可导入的画面或文案)|最多(?:选择 24 个分类字段|保留 128 个数据字段)|同一列不能同时作为大分类和细分类字段|参考图片最多 9 张|参考图片超过 10MB|参考素材仅支持 JPG、PNG、WebP 图片|每张图片须非空且不超过 10MB|提示词文件过大|图片超过 10MB，无法提交视觉模型识别|上传文件不能超过阿里云官方上限 1 GB|没有识别到抖音或小红书链接|单次最多添加 100 条链接|共享网盘中没有可处理的图片或视频|只能选择媒体库中的本地图片|只能转写视频文件|图片反推仅支持整片提示词|图片反推不包含视频台词)/],
    ["POINTS_CREDENTIAL_REQUIRED", /^本机缺少设备凭证，请先完成设备授权验证/],
    ["PLATFORM_CREDENTIAL_REQUIRED", /^请先完成设备授权验证/],
    ["FEIGUA_AUTH_REQUIRED", /^(?:请先完成飞瓜登录|请先核验代理工作台登录|飞瓜登录已失效，请重新登录)/],
    ["FEIGUA_VERIFICATION_REQUIRED", /^飞瓜需要图形验证，请在已打开的飞瓜窗口完成验证后重新采集/],
    ["FEIGUA_ENTRY_REQUIRED", /^请先配置并保存登录入口网址/],
    ["QIANCHUAN_CONNECT_REQUIRED", /本机尚未完成千川授权|尚未连接千川账户|千川账户尚未授权|请先(?:连接|授权)千川/],
    ["QIANCHUAN_AUTH_EXPIRED", /千川(?:账户访问|账户)?授权(?:已过期|已失效)|千川授权已过期/],
    ["QIANCHUAN_CONFIG_REQUIRED", /请输入正确的千川 APP ID|千川 APP Secret 格式不正确|千川应用(?:尚未配置|未配置)/],
    ["MODEL_API_SETUP_REQUIRED", /所选 API 配置不完整|请先在设置中选择火山引擎或中转 API|(?:文本模型|视觉模型|中转|火山引擎|MiniMax).*API (?:Key )?未配置|视觉模型配置不完整|请补全模型.*配置/],
    ["ALIYUN_SETUP_REQUIRED", /请先在设置中保存(?:阿里云|云服务)密钥|^更新密钥时请同时填写 AccessKey ID 和 Secret|^阿里云密钥格式不正确/],
    ["SOFTWARE_AUTH_REQUIRED", /设备授权凭证不完整，请重新验证软件授权/],
  ];
  for (const [key, pattern] of known)
    if (pattern.exec(message)?.index === 0) return { ...actions[key], ...(preservesInput(key) || key === "QIANCHUAN_CONFIG_REQUIRED" ? { message } : {}) };
  if (/qianchuan|千川/.test(context) && !/软件|设备|激活码|安全凭证/.test(message)) {
    if (/授权(?:已过期|已失效)|重新授权/.test(message)) return { ...actions.QIANCHUAN_AUTH_EXPIRED };
    if (/(?:账户|账号)?(?:未登录|尚未登录)|尚未完成授权/.test(message)) return { ...actions.QIANCHUAN_CONNECT_REQUIRED };
  }
  if (!/qianchuan|千川/.test(context) && /prompt-library|classifier|api-settings|voice|提示词|分类|模型|API/.test(context)) {
    const modelCode = String(value?.code || value?.error?.code || '').toLowerCase();
    if (/^(?:invalid_json|invalid_schema|empty_response|empty_summary|output_truncated|stream_interrupted|invalid_stream|summary_not_reduced|compatibility_error)$/.test(modelCode)
      || /^(?:分镜\s*\d+\s*的时间或独立提示词不完整|(?:文本模型|反推模型|视觉模型|模型)(?:没有|未)(?:返回|得到).*(?:内容|正文|JSON|草案|提示词|摘要)|(?:文本模型|模型)返回的.*(?:不完整|格式错误)|(?:草案因模型输出长度限制被截断|参考素材识别不完整|替换检查不完整|替换结果未通过完整性检查))/.test(message)) return { ...actions.MODEL_OUTPUT_INCOMPLETE };
    if (/^(?:idle_timeout|total_timeout|etimedout|econnaborted)$/.test(modelCode)
      || /^(?:文本模型|视觉模型|反推模型|模型|AI).*(?:超时|超过最长等待时间|长时间没有返回|\d+\s*秒内没有返回)/.test(message)) return { ...actions.MODEL_RESPONSE_TIMEOUT };
    if (/^(?:refusal|content_filter|content_policy_violation|responsibleaipolicyviolation)$/.test(modelCode)
      || /^(?:文本模型|视觉模型|反推模型|模型|AI).*(?:拒绝生成|限制了.*输出|内容审核未通过)/.test(message)) return { ...actions.MODEL_CONTENT_RESTRICTED };
    if (/^(?:econnreset|enotfound|eai_again|econnrefused)$/.test(modelCode)
      || (modelCode === 'provider_error' && [500,502,503,504].includes(value?.httpStatus))
      || /HTTP\s*(?:500|502|503|504)\b|service_unavailable|overloaded_error/i.test(message)
      || /^(?:文本模型|视觉模型|反推模型|模型|AI)(?:服务)?.*(?:暂不可用|暂时不可用|服务繁忙)/.test(message)) return { ...actions.MODEL_SERVICE_UNAVAILABLE };
    if (/HTTP\s*(?:401|403)|Incorrect API key|invalid_api_key/i.test(message)) return { ...actions.MODEL_AUTH_REQUIRED };
    if (/HTTP\s*402|insufficient_quota|insufficient[_ ]balance|账户余额不足|账号余额不足|可用额度不足|配额不足/i.test(message)) return { ...actions.MODEL_QUOTA_REQUIRED };
    if (/HTTP\s*429|rate_limit_exceeded|too many requests/i.test(message)) return { ...actions.MODEL_RATE_LIMITED };
  }
  if (/aliyun-subtitle/.test(context) && /InvalidAccessKeyId|SignatureDoesNotMatch|InvalidAccessKeySecret|HTTP\s*(?:401|403)/i.test(message)) return { ...actions.ALIYUN_SETUP_REQUIRED };
  if (/Endpoint ID 格式不正确|请填写(?:分类方案文本模型|素材分类视觉模型|火山引擎 API Key|中转 API Key)|(?:中转 Base URL|火山引擎 API Key|中转 API Key|MiniMax Base URL|MiniMax API Key)(?:格式不正确|不是有效的网址|必须使用)/.test(message))
    return { ...actions.MODEL_API_SETUP_REQUIRED, message };
  if (/^(?:字幕区域必须位于画面内，宽度和高度必须大于 0|视频不能为空，上传文件不能超过 1 GB|文件内容不是可识别的 MP4 视频|视频无法读取，请确认文件完整且包含视频画面|上传视频分辨率不得超过 1080P)/.test(message))
    return { ...actions.USER_FILE_REQUIRED, message };
  if (/^(?:请选择|请先选择|请填写|请先填写|请输入|请先上传|请先导入|请拖入|请至少选择|请先勾选|请先确认上传|至少选择|至少需要|素材创建日期的开始日期不能晚于|数据统计周期的开始日期不能晚于)/.test(message))
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

/** A declined points quote is a normal outcome; do not hide other cancellations or uncertain billing. */
export function isPlatformQuoteCancellation(value) {
  if (value?.terminalFailure === true || value?.billingPending === true || operationMessage(value).includes(UNEXPECTED_DIAGNOSTIC_MARKER)) return false;
  return value?.code === 'PLATFORM_TASK_CANCELLED' || cleanOperationMessage(value) === '已取消，本次未提交任务，也未扣积分。';
}
