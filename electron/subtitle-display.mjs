// Keep historical task records and filesystem paths intact; normalize display copy only.
export function subtitleDisplayText(value) {
  return String(value || '').replaceAll('阿里云', '云服务');
}

export function subtitleDisplayDirectory(value) {
  const directory = String(value || '');
  return directory.includes('阿里云') ? '已设置成片文件夹，可打开或更换' : directory;
}
