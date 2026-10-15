// Keep historical task records and filesystem paths intact; normalize display copy only.
export function subtitleDisplayText(value) {
  return String(value || '').replace(/https?:\/\/\S+/gi, '服务地址')
    .replace(/阿里云|火山引擎|火山方舟|豆包|aliyun|alicloud|volcengine|minimax|doubao/gi, '处理服务');
}

export function subtitleDisplayDirectory(value) {
  const directory = String(value || '');
  return /阿里云|aliyun|alicloud/i.test(directory) ? '已设置成片文件夹，可打开或更换' : directory;
}
