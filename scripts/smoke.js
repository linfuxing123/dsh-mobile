#!/usr/bin/env node
/* Smoke test for the dsh-mobile bridge: auth, RPC proxy, and the mux WebSocket. */
'use strict';

const WebSocket = require('ws');

const BASE = process.env.DSHM_BASE || 'http://127.0.0.1:3090';
const PASSWORD = process.env.DSHM_PASSWORD || require('../config.json').password;

let cookie = '';

function getCookie(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!set.length) {
    const raw = res.headers.get('set-cookie');
    if (raw) set.push(raw);
  }
  for (const s of set) {
    const m = s.match(/^dshm=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

async function main() {
  console.log('== /meta (no auth) ==');
  let res = await fetch(`${BASE}/meta`);
  console.log(res.status, await res.text());

  console.log('\n== /api/host.describe (no auth, expect 401) ==');
  res = await fetch(`${BASE}/api/host.describe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(res.status, await res.text());

  console.log('\n== POST /login ==');
  res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  console.log(res.status, await res.text());
  cookie = getCookie(res);
  console.log('cookie set:', cookie ? 'yes' : 'NO');

  console.log('\n== /api/host.describe (authed) ==');
  res = await fetch(`${BASE}/api/host.describe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `dshm=${cookie}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method: 'host.describe', payload: {} }),
  });
  console.log(res.status, await res.text());

  console.log('\n== /api/session.list (authed) ==');
  res = await fetch(`${BASE}/api/session.list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `dshm=${cookie}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-2', method: 'session.list', payload: {} }),
  });
  console.log(res.status, await res.text());

  console.log('\n== WebSocket /api/events.mux (authed) ==');
  const proto = BASE.startsWith('https') ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${new URL(BASE).host}/api/events.mux`, {
    headers: { Cookie: `dshm=${cookie}` },
  });
  let frames = 0;
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    frames++;
    console.log('mux frame:', JSON.stringify({ method: frame.method, type: frame.payload && frame.payload.type }).slice(0, 160));
    if (frames >= 3) ws.close();
  });
  ws.on('open', () => console.log('mux OPEN'));
  ws.on('close', () => {
    console.log('mux CLOSED after', frames, 'frames');
    process.exit(0);
  });
  ws.on('error', (e) => {
    console.log('mux ERROR', e.message);
    process.exit(1);
  });
  setTimeout(() => {
    console.log('mux TIMEOUT (no frames in 8s)');
    process.exit(1);
  }, 8000);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
