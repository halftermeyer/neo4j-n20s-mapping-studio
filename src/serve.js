// `n20s-mapping serve`: the endpoints of a recipes directory, without the studio.
import http from 'node:http';
import { endpoints } from './endpoints.js';

/** @returns {Promise<{url: string, close: () => Promise<void>}>} */
export async function serveEndpoints({ recipesDir, n20s, openSource = null, port = 7480, host = '127.0.0.1', allowRun = false }) {
  const handle = endpoints({ recipesDir, n20s, openSource, allowRun });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const out = await handle(req, url) ?? { status: 404, type: 'application/json', body: JSON.stringify({ error: `Not found: GET /sparql, /query${allowRun ? ' or /run' : ''}.` }) };
    res.writeHead(out.status, { 'content-type': `${out.type}; charset=utf-8`, ...(out.headers ?? {}) });
    res.end(out.body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const shown = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${shown}:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) };
}
