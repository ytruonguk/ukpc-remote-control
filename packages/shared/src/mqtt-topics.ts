export const mqttTopics = {
  state: (deviceId: string) => `rc/state/${deviceId}`,
  probe: (deviceId: string) => `rc/probe/${deviceId}`,
  cmd: (deviceId: string) => `rc/cmd/${deviceId}`,
  event: (deviceId: string) => `rc/event/${deviceId}`,
  shareState: '$share/ingest/rc/state/+',
  shareProbe: '$share/ingest/rc/probe/+',
  // Event không retained nên chỉ cần subscription chia tải; subscribe thêm kiểu thường sẽ ghi trùng.
  shareEvent: '$share/ingest/rc/event/+',
} as const;

export function deviceIdFromTopic(topic: string): string {
  const parts = topic.split('/');
  return parts[parts.length - 1] ?? '';
}
