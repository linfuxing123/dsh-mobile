#!/usr/bin/env node
/* End-to-end test: create a session, send a harmless prompt through the bridge,
 * and capture the assistant reply from the mux stream (event-driven). */
'use strict';

const WebSocket = require('ws');

const BASE = process.env.DSHM_BASE || 'http://127.0.0.1:3090';
const PASSWORD = process.env.DSHM_PASSWORD || require('../config.json').password;
const PROMPT = process.env.DSHM_PROMPT || '用一句话回复“收到”即可，不要调用任何工具。';

let cookie = '';

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error('login failed');
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const s of set) {
    const m = s.match(/^dshm=([^;]+)/);
    if (m) cookie = m[1];
  }
  if (!cookie) throw new Error('no cookie');
}

async function rpc(method, payload) {
  const rpcId = 'e2e-' + Math.random().toString(36).slice(2);
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `dshm=${cookie}` },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  const full = await res.json();
  return full.result;
}

function main() {
  return new Promise(async (resolve, reject) => {
    await login();
    const created = await rpc('session.create', {});
    if (!created.ok) return reject(new Error('create failed: ' + JSON.stringify(created)));
    const sessionId = created.value.sessionId;
    console.log('created session:', sessionId);

    const watched = await fetch(`${BASE}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `dshm=${cookie}` },
      body: JSON.stringify({ sessionId }),
    });
    console.log('/watch status:', watched.status);

    const proto = BASE.startsWith('https') ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${new URL(BASE).host}/api/events.mux`, {
      headers: { Cookie: `dshm=${cookie}` },
    });

    let done = false;
    let answer = '';
    const finish = (code) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      console.log('TIMEOUT: no assistant/message for', sessionId);
      finish(1);
    }, 90000);

    ws.on('open', async () => {
      const sent = await rpc('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: PROMPT }],
      });
      console.log('prompt accepted:', JSON.stringify(sent));
      if (!sent.ok) finish(1);
    });

    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      const p = frame.payload;
      if (p && p.type === 'session/event' && p.sessionId === sessionId) {
        const ev = p.event;
        if (ev && ev.type === 'assistant/message') {
          const text = (ev.data.message.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (text) {
            answer = text;
            console.log('ASSISTANT ANSWER:\n' + text);
          }
        }
        if (ev && ev.type === 'turn/end') {
          console.log('turn/end reason:', JSON.stringify(ev.data && ev.data.reason));
          if (answer) finish(0);
          else finish(1);
        }
      }
    });
    ws.on('error', (e) => {
      console.log('ws error', e.message);
      finish(1);
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('E2E FAILED:', e.message);
    process.exit(1);
  });
