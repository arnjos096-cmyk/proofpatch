import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function serveReport(directory: string, port = 4317, host = '127.0.0.1'): Promise<Server> {
  const root = resolve(directory);
  const routes: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/receipt.json': ['receipt.json', 'application/json'], '/summary.md': ['summary.md', 'text/markdown; charset=utf-8'] };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const route = routes[(req.url || '/').split('?')[0]];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !route) { res.writeHead(404); res.end('Not found'); return; }
    try { const data = await readFile(join(root, route[0])); res.writeHead(200, { 'Content-Type': route[1] }); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(404); res.end('No receipt here. Run proofpatch demo or inspect first.'); }
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, host, () => { server.off('error', no); yes(); }); });
  return server;
}
