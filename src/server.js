'use strict';

/**
 * Local server for the web UI: serves public/ and the same stateless API that
 * runs on Vercel (src/web/api.js), so `npm run ui` behaves like the deployed site.
 *
 *   npm run ui                 http://127.0.0.1:4321/
 *   npm run ui -- --port 4400
 *
 * Local-only extras on top of the API's own checks:
 *   - binds to 127.0.0.1 only
 *   - Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding)
 *   - static files: a fixed list from public/ only
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createApi, ROUTES } = require('./web/api');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PUBLIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/zip.js': ['zip.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// Same headers as vercel.json.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

function createServer({ config, pollWaitSecs }) {
  const api = createApi({ config, pollWaitSecs });
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const sendText = (status, text) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: text }));
    };
    try {
      const port = server.address().port;
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendText(421, 'Unexpected Host header');
      // The API trusts only the real Host header locally.
      delete req.headers['x-forwarded-host'];
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname.startsWith('/api/')) {
        const route = pathname.slice(5);
        return await api(ROUTES.has(route) ? route : '', req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(405, 'Method not allowed');
      const file = PUBLIC_FILES[pathname];
      if (!file) return sendText(404, 'Not found');
      const body = await fsp.readFile(path.join(PUBLIC_DIR, file[0]));
      res.statusCode = 200;
      res.setHeader('Content-Type', file[1]);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      console.error(`[server] ${err?.message || err}`);
      if (!res.headersSent) sendText(500, 'Internal error');
      else res.end();
    }
  });
  return server;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const server = createServer({ config });
  const port = args.port || config.uiPort;
  server.listen(port, '127.0.0.1', () => {
    console.log(`Post Collector UI at http://127.0.0.1:${server.address().port}/`);
    if (config.accessCodeRequired) console.log('Access code is required (DEMO_ACCESS_CODE).');
    console.log('Press Ctrl+C to stop.');
  });
}

module.exports = { createServer, PUBLIC_FILES };

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.name === 'ConfigError' ? err.message : err);
    process.exitCode = 1;
  });
}
