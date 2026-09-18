export function shouldSendViewerJoin(params: { peer: 'agent' | 'viewer'; otherOpen: boolean }): boolean {
  return params.otherOpen;
}
