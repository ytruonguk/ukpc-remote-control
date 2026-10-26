export const keys = {
  device: (deviceId: string) => `device:${deviceId}`,
  deviceCaps: (deviceId: string) => `device:caps:${deviceId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  activeSession: (deviceId: string) => `device:activeSession:${deviceId}`,
  tokenUsed: (jti: string) => `token:used:${jti}`,
  relayLoad: (node: string) => `relay:${node}:load`,
  relayNodes: 'relay:nodes',
  /** Người chờ kết quả `hw.dump` theo nonce (ingest lpush, api brpop). */
  hwDump: (nonce: string) => `hw:dump:${nonce}`,
  /** Chặn tự động hw.dump dồn dập cho cùng một máy. */
  /** API đăng ký nonce trước khi gửi lệnh; ingest chỉ trả lời nonce có đăng ký (máy không tự tạo được khóa Redis). */
  hwDumpReq: (nonce: string) => `hw:dumpreq:${nonce}`,
  hwAutoDump: (deviceId: string) => `hw:autodump:${deviceId}`,
  hwHeartbeat: (deviceId: string) => `hw:hb:${deviceId}`,
} as const;
