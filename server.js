#!/usr/bin/env node
/**
 * dsh-mobile bridge
 * =================
 * A phone-facing gateway in front of the local DSH web server (dsh --profile web,
 * loopback-only on 127.0.0.1:3080). It does four things:
 *
 *   1. Serves a mobile-first PWA (public/).
 *   2. Reverse-proxies the DSH RPC surface (`/api/*` HTTP + the two WebSocket
 *      downlinks) to the loopback DSH server, rewriting Host/Origin/fetch-metadata
 *      so the DSH browser-trust fence sees a loopback client.
 *   3. Adds a password + signed-cookie authentication layer (DSH's web carrier has
 *      none by design, so remote exposure needs one).
 *   4. Watches the mux stream for turn completion on sessions the phone asked to
 *      watch, and fires a completion notification to Bark / ntfy / Server酱.
 *
 * Requirements: Node >= 20 (global fetch, WebSocket is only used server-side via ws).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const COOKIE_NAME = 'dshm';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.warn('[dsh-mobile] config.json unreadable, starting fresh:', err.message);
    }
  }
  cfg.host = process.env.DSH_MOBILE_HOST || cfg.host || '0.0.0.0';
  cfg.port = Number(process.env.DSH_MOBILE_PORT || cfg.port || 3090);
  cfg.dshTarget = process.env.DSH_TARGET || cfg.dshTarget || 'http://127.0.0.1:3080';
  cfg.password = process.env.DSH_MOBILE_PASSWORD || cfg.password || '';
  if (!cfg.password) {
    cfg.password = randomToken(6); // ~8 chars, unambiguous base64url
  }
  if (!cfg.sessionSecret || typeof cfg.sessionSecret !== 'string' || cfg.sessionSecret.length < 16) {
    cfg.sessionSecret = randomToken(32);
  }
  cfg.notify = Object.assign({ bark: '', ntfy: '', serverchan: '' }, cfg.notify || {});
  // Persist generated secrets so a restart keeps the same password/cookie key.
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    console.warn('[dsh-mobile] could not persist config.json:', err.message);
  }
  return cfg;
}

const cfg = loadConfig();
const targetUrl = new URL(cfg.dshTarget);
const targetAuthority = targetUrl.host; // e.g. 127.0.0.1:3080

// ---------------------------------------------------------------------------
// Auth (signed cookie, stateless)
// ---------------------------------------------------------------------------

function signToken(secret, expMs) {
  const payload = Buffer.from(String(expMs)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(secret, token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expMs;
  try {
    expMs = Number(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getCookieToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
  return m ? m[1] : null;
}

function isAuthed(req) {
  return verifyToken(cfg.sessionSecret, getCookieToken(req));
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA fallback: any non-file path serves index.html.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, limitBytes = 1 << 20) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// Notification watcher (mux observer -> Bark / ntfy / Server酱)
// ---------------------------------------------------------------------------

const watchMap = new Map(); // sessionId -> { lastPrompt, lastText }

function extractTextFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractTextFromPromptParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function handleMuxFrame(frame) {
  const payload = frame && frame.payload;
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type;

  if (type === 'session/event') {
    const ev = payload.event;
    if (!ev) return;
    const sid = payload.sessionId;
    if (ev.type === 'user/message') {
      const w = watchMap.get(sid);
      if (w && ev.data && ev.data.source && ev.data.source.kind === 'user') {
        const t = extractTextFromMessage(ev.data);
        if (t) w.lastPrompt = t;
      }
    } else if (ev.type === 'assistant/message') {
      const w = watchMap.get(sid);
      if (w) {
        const t = extractTextFromMessage(ev.data && ev.data.message);
        if (t) w.lastText = t;
      }
    } else if (ev.type === 'turn/end') {
      const w = watchMap.get(sid);
      if (w) {
        watchMap.delete(sid);
        fireNotify(sid, w.lastPrompt, w.lastText, ev.data && ev.data.reason);
      }
    }
  } else if (type === 'host/session-status' && payload.running === false) {
    // A turn-ending status flip can also land before the observer started
    // tracking; treat it as a completion for a watched-but-still-pending session.
    const w = watchMap.get(payload.sessionId);
    if (w) {
      watchMap.delete(payload.sessionId);
      fireNotify(payload.sessionId, w.lastPrompt, w.lastText, undefined);
    }
  }
}

function shortTitle(prompt) {
  const s = (prompt || '').trim().replace(/\s+/g, ' ');
  if (!s) return '任务';
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function shortBody(text) {
  const s = (text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '已完成';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function fireNotify(sessionId, prompt, text, reason) {
  const cfgNotify = cfg.notify || {};
  const title = `✅ ${shortTitle(prompt)} 完成`;
  const body = shortBody(text);
  const jobs = [];

  if (cfgNotify.bark) {
    const base = cfgNotify.bark.replace(/\/+$/, '');
    jobs.push(
      fetch(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`, { method: 'POST' })
        .catch((e) => console.warn('[dsh-mobile] bark notify failed:', e.message))
    );
  }
  if (cfgNotify.ntfy) {
    jobs.push(
      fetch(cfgNotify.ntfy, {
        method: 'POST',
        headers: { 'Title': title },
        body,
      }).catch((e) => console.warn('[dsh-mobile] ntfy notify failed:', e.message))
    );
  }
  if (cfgNotify.serverchan) {
    jobs.push(
      fetch(`https://sctapi.ftqq.com/${cfgNotify.serverchan}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: `# ${title}\n\n${body}` }).toString(),
      }).catch((e) => console.warn('[dsh-mobile] serverchan notify failed:', e.message))
    );
  }

  Promise.all(jobs).then(() => {
    if (jobs.length) console.log(`[dsh-mobile] notified completion for ${sessionId}`);
  });
}

function startObserver() {
  let ws = null;
  let stopped = false;
  let timer = null;

  function connect() {
    if (stopped) return;
    const wsTarget = cfg.dshTarget.replace(/^http/, 'ws');
    try {
      ws = new WebSocket(`${wsTarget}/api/events.mux`, {
        headers: { Host: targetAuthority, Origin: `http://${targetAuthority}` },
      });
    } catch (err) {
      scheduleReconnect();
      return;
    }
    ws.on('open', () => console.log('[dsh-mobile] observer connected to DSH mux'));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        handleMuxFrame(frame);
      } catch (err) {
        console.warn('[dsh-mobile] observer frame error:', err.message);
      }
    });
    ws.on('close', () => scheduleReconnect());
    ws.on('error', () => {});
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(connect, 5000);
  }

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (ws) ws.terminate();
  };
}

// ---------------------------------------------------------------------------
// Reverse proxy
// ---------------------------------------------------------------------------

const proxy = httpProxy.createProxyServer({});

proxy.on('error', (err, req, res) => {
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    json(res, 502, { error: 'proxy', message: err.message });
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
});

// Rewrite browser markers so DSH's trust fence sees a loopback, marker-less client.
proxy.on('proxyReq', (proxyReq) => {
  proxyReq.setHeader('Host', targetAuthority);
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
  proxyReq.removeHeader('sec-fetch-site');
  proxyReq.removeHeader('sec-fetch-mode');
  proxyReq.removeHeader('sec-fetch-dest');
});

proxy.on('proxyReqWs', (proxyReq) => {
  proxyReq.setHeader('Host', targetAuthority);
  proxyReq.setHeader('Origin', `http://${targetAuthority}`);
  proxyReq.removeHeader('referer');
  proxyReq.removeHeader('sec-fetch-site');
  proxyReq.removeHeader('sec-fetch-mode');
  proxyReq.removeHeader('sec-fetch-dest');
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }

  // --- auth endpoints -------------------------------------------------------
  if (pathname === '/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const pass = body && body.password ? String(body.password) : '';
    if (!safeEqual(pass, cfg.password)) {
      json(res, 401, { ok: false, error: '密码错误' });
      return;
    }
    const token = signToken(cfg.sessionSecret, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token);
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
    return;
  }

  // Public metadata for the UI (no secrets).
  if (pathname === '/meta' && req.method === 'GET') {
    json(res, 200, {
      authenticated: isAuthed(req),
      notify: {
        bark: Boolean(cfg.notify && cfg.notify.bark),
        ntfy: Boolean(cfg.notify && cfg.notify.ntfy),
        serverchan: Boolean(cfg.notify && cfg.notify.serverchan),
      },
    });
    return;
  }

  // --- API proxy (auth-gated) ----------------------------------------------
  if (isApiPath(pathname)) {
    if (!isAuthed(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    proxy.web(req, res, { target: cfg.dshTarget, changeOrigin: true });
    return;
  }

  // --- watch endpoint (auth-gated, bridge-local, NOT proxied) ----------------
  if (pathname === '/watch' && req.method === 'POST') {
    if (!isAuthed(req)) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    const body = await readJsonBody(req);
    const sid = body && body.sessionId;
    if (!sid || typeof sid !== 'string') {
      json(res, 400, { ok: false, error: 'sessionId required' });
      return;
    }
    watchMap.set(sid, { lastPrompt: '', lastText: '' });
    json(res, 200, { ok: true });
    return;
  }

  // --- static ---------------------------------------------------------------
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('method not allowed');
});

// --- WebSocket upgrades (the two DSH downlinks, auth-gated) -----------------
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (!isApiPath(pathname)) {
    socket.destroy();
    return;
  }
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: cfg.dshTarget, changeOrigin: true });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const stopObserver = startObserver();

server.listen(cfg.port, cfg.host, () => {
  console.log('==============================================================');
  console.log('  dsh-mobile 已启动');
  console.log(`  本机访问:   http://127.0.0.1:${cfg.port}`);
  console.log(`  监听地址:   ${cfg.host}:${cfg.port}`);
  console.log(`  DSH 目标:   ${cfg.dshTarget}`);
  console.log(`  登录密码:   ${cfg.password}`);
  console.log('  手机远程访问请通过 Tailscale（见 README.md 的 HTTPS 章节）。');
  console.log('==============================================================');
});

function shutdown() {
  stopObserver();
  proxy.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
