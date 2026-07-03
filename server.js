import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const port = process.env.PORT || 3000;
const scriptUrl = process.env.APPS_SCRIPT_URL;
const jsonLimitBytes = Number(process.env.JSON_LIMIT_BYTES || 50 * 1024 * 1024);
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 25000);
const serviceVersion = 'railway-survey-2026-07-03-1735';

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, version: serviceVersion });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/version') {
      sendJson(res, 200, {
        ok: true,
        version: serviceVersion,
        scriptUrlConfigured: Boolean(scriptUrl),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/apps-script') {
      await handleAppsScriptDebug(res);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      await handleApi(req, res, decodeURIComponent(url.pathname.slice('/api/'.length)));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

async function handleApi(req, res, action) {
  if (!scriptUrl) {
    sendJson(res, 500, {
      ok: false,
      error: 'APPS_SCRIPT_URL is not configured on Railway.',
    });
    return;
  }

  const params = await readJsonBody(req);
  const payload = await callAppsScript(action, params);
  sendJson(res, 200, { ok: true, result: payload.result });
}

async function handleAppsScriptDebug(res) {
  if (!scriptUrl) {
    sendJson(res, 500, {
      ok: false,
      scriptUrlConfigured: false,
      error: 'APPS_SCRIPT_URL is not configured on Railway.',
    });
    return;
  }

  try {
    const payload = await callAppsScript('testDeploymentReady', {});
    sendJson(res, 200, {
      ok: true,
      scriptUrlConfigured: true,
      result: payload.result,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      scriptUrlConfigured: true,
      error: error && error.message ? error.message : String(error),
    });
  }
}

async function callAppsScript(action, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, params }),
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const sample = text.replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(
        `Apps Script returned non-JSON response. Check deployment access and APPS_SCRIPT_URL. Response: ${sample}`
      );
    }

    if (!upstream.ok || payload.ok === false) {
      throw new Error(payload.error || upstream.statusText);
    }

    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Apps Script did not respond within ${Math.round(upstreamTimeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > jsonLimitBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });

    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(publicDir, requested));

  if (!target.startsWith(publicDir)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': mimeByExt[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    const index = await fs.readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(index);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

server.listen(port, () => {
  console.log(`Mapping Survey ${serviceVersion} is running on port ${port}`);
});
