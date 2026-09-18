function attach(server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: () => void }, next: () => void) => void) => void } }) {
  server.middlewares.use((req, res, next) => {
    const url = req.originalUrl ?? req.url ?? '';
    if (!url.startsWith('/d/')) return next();
    res.statusCode = 302;
    res.setHeader('Location', `/login?next=${encodeURIComponent(url)}`);
    res.end();
  });
}

/** Unauthenticated GET /d/:id must 302 — spec §7.2. */
export function deeplinkRedirect() {
  return {
    name: 'deeplink-redirect',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
