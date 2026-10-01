// Resolve the trusted IPC registration once; callers cannot downgrade the
// required group by supplying a feature ID in a request payload.
export function protectedIpcHandler(registry, channel, getLicenseService, handler) {
  const feature = registry.forIpc(channel);
  if (!feature) throw new Error(`受控 IPC 未注册功能归属：${channel}`);
  return async (...args) => {
    const service = getLicenseService();
    if (!service) throw new Error("授权服务尚未就绪");
    service.assertFeature(feature.id);
    return handler(...args);
  };
}
