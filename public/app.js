/* DSH Mobile — phone-first client for the DSH agent. */
'use strict';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ---------------------------------------------------------------------------
// RPC client (matches the DSH web wire contract)
// ---------------------------------------------------------------------------

async function rpc(method, payload) {
  const rpcId = uuid();
  const body = { type: 'client-request', rpcId, method, payload };
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const full = await res.json();
  if (full.type !== 'server-response') throw new Error('bad envelope');
  return full.result; // { ok:true, value } | { ok:false, error }
}

function respond(rpcId, value) {
  return fetch('/api/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  });
}

function rpcError(result) {
  if (result && result.ok === false && result.error) return result.error;
  return null;
}

// ---------------------------------------------------------------------------
// Markdown (safe: HTML is escaped first, then light transforms)
// ---------------------------------------------------------------------------

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/__([^_]+)__/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, c) => `<em>${c}</em>`)
    .replace(/_([^_]+)_/g, (_, c) => `<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safe = /^https?:\/\//i.test(u) ? u : '#';
      return `<a href="${esc(safe)}" target="_blank" rel="noopener">${t}</a>`;
    });
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];
  let listType = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join('<br>'))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      const tag = listType === 'ol' ? 'ol' : 'ul';
      out.push(`<${tag}>${listBuf.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</${tag}>`);
      listBuf = [];
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (inCode) {
      if (/^```/.test(line.trim())) {
        inCode = false;
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
      } else {
        codeBuf.push(line);
      }
      i++;
      continue;
    }
    if (/^```/.test(line.trim())) {
      flushPara();
      flushList();
      inCode = true;
      codeBuf = [];
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      listType = listType || 'ul';
      listBuf.push(line.replace(/^\s*[-*]\s+/, ''));
      i++;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara();
      listType = listType || 'ol';
      listBuf.push(line.replace(/^\s*\d+[.)]\s+/, ''));
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      i++;
      continue;
    }
    flushList();
    para.push(line);
    i++;
  }
  flushPara();
  flushList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  authed: false,
  sessions: [],
  currentId: null,
  messages: [], // {kind, id?, text, images?, tools?, ts, pending?}
  stream: null, // {text, tools:[]} live assistant stream
  running: new Set(), // sessionIds currently running
  connected: false,
  pendingImages: new Map(), // attachmentId -> dataUrl
};

let muxWs = null;
let hostWs = null;
let reconnectTimer = null;
let lastSeq = -1;

const DEFAULT_TEMPLATES = [
  '帮我把当前目录整理一下，生成一个 README 说明',
  '看看最新的 git 状态和改动，总结一下',
  '帮我修复所有报错并跑通测试',
  '把最近的改动提交到 git（先给我看要提交的内容）',
];

// ---------------------------------------------------------------------------
// Templates (localStorage)
// ---------------------------------------------------------------------------

function loadTemplates() {
  try {
    const raw = localStorage.getItem('dshm.templates');
    if (raw) return JSON.parse(raw);
  } catch {}
  return [...DEFAULT_TEMPLATES];
}

function saveTemplates(list) {
  localStorage.setItem('dshm.templates', JSON.stringify(list));
}

// ---------------------------------------------------------------------------
// Message content extraction
// ---------------------------------------------------------------------------

function extractText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractImageRefs(msg) {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b) => b && b.type === 'image' && b.attachment)
    .map((b) => b.attachment);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const chatEl = $('#chat');
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const wasAtBottom = isNearBottom();
  chatEl.innerHTML = '';

  if (!state.messages.length && !state.stream) {
    chatEl.innerHTML = `
      <div class="chat-empty">
        <h2>给电脑里的 Agent 下指令</h2>
        <p>直接用文字、语音或拍照发任务，它会自己在电脑上干活，完成后通知你。</p>
        <p class="hint">出门在外也能用 · 全程通过 Tailscale 加密连接</p>
      </div>`;
    return;
  }

  for (const node of state.messages) {
    chatEl.appendChild(renderNode(node));
  }

  if (state.stream) {
    chatEl.appendChild(renderStreamNode(state.stream));
  }

  if (wasAtBottom) scrollToBottom();
}

function renderNode(node) {
  if (node.kind === 'user') return renderUserNode(node);
  if (node.kind === 'assistant') return renderAssistantNode(node);
  if (node.kind === 'tool') return renderToolNode(node);
  return renderSystemNode(node);
}

function renderUserNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (node.images && node.images.length) {
    const grid = document.createElement('div');
    grid.className = 'img-grid';
    for (const ref of node.images) {
      const img = document.createElement('img');
      img.className = 'msg-img';
      const dataUrl = state.pendingImages.get(ref.attachmentId);
      if (dataUrl) {
        img.src = dataUrl;
      } else {
        img.src = '/icons/icon-192.png';
        img.style.opacity = '0.4';
        fetchImage(ref.attachmentId).then((url) => {
          if (url) img.src = url;
          img.style.opacity = '1';
        });
      }
      grid.appendChild(img);
    }
    bubble.appendChild(grid);
  }
  if (node.text) {
    const p = document.createElement('div');
    p.textContent = node.text;
    bubble.appendChild(p);
  }
  wrap.appendChild(bubble);
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = node.pending ? '排队中…' : fmtTime(node.ts);
  wrap.appendChild(time);
  return wrap;
}

function renderAssistantNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(node.text || '');
  wrap.appendChild(bubble);
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = fmtTime(node.ts);
  wrap.appendChild(time);
  return wrap;
}

function renderToolNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const group = document.createElement('div');
  group.className = 'tool-group';
  const names = node.tools || [];
  const visible = names.slice(0, 4);
  for (const n of visible) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip';
    chip.innerHTML = `🛠 <span class="tname">${esc(n)}</span>`;
    group.appendChild(chip);
  }
  if (names.length > visible.length) {
    const more = document.createElement('span');
    more.className = 'tool-chip';
    more.textContent = `+${names.length - visible.length}`;
    group.appendChild(more);
  }
  wrap.appendChild(group);
  return wrap;
}

function renderSystemNode(node) {
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.cssText = 'font-size:12.5px;color:var(--text-dim);background:transparent;border:none;';
  bubble.textContent = node.text;
  wrap.appendChild(bubble);
  return wrap;
}

function renderStreamNode(stream) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  if (stream.tools && stream.tools.length) {
    wrap.appendChild(renderToolNode({ kind: 'tool', tools: stream.tools, ts: Date.now() }).firstChild);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (stream.text) {
    bubble.innerHTML = renderMarkdown(stream.text);
  } else {
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  }
  wrap.appendChild(bubble);
  return wrap;
}

function isNearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function fetchImage(attachmentId) {
  if (state.pendingImages.has(attachmentId)) return Promise.resolve(state.pendingImages.get(attachmentId));
  if (!state.currentId) return Promise.resolve(null);
  return rpc('session.attachment', { sessionId: state.currentId, attachmentId })
    .then((res) => {
      if (res.ok && res.value && res.value.data) {
        const url = `data:${res.value.attachment.mediaType};base64,${res.value.data}`;
        state.pendingImages.set(attachmentId, url);
        return url;
      }
      return null;
    })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function loadSessions() {
  const res = await rpc('session.list', {});
  if (!res.ok) return;
  state.sessions = res.value.items || [];
  renderSessionList();
}

function titleOf(item) {
  const t = item && item.projections && item.projections.values && item.projections.values.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  if (item && item.sessionId) return '会话 ' + item.sessionId.slice(0, 8);
  return '会话';
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  const sorted = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const item of sorted) {
    const el = document.createElement('div');
    el.className = 'session-item' + (item.sessionId === state.currentId ? ' active' : '');
    const title = document.createElement('div');
    title.className = 's-title';
    title.textContent = titleOf(item);
    const meta = document.createElement('div');
    meta.className = 's-meta';
    if (item.running) {
      const run = document.createElement('span');
      run.className = 's-running';
      run.textContent = '● 运行中';
      meta.appendChild(run);
    }
    const t = document.createElement('span');
    t.textContent = fmtTime(item.updatedAt);
    meta.appendChild(t);
    el.appendChild(title);
    el.appendChild(meta);
    el.addEventListener('click', () => {
      closeDrawer();
      openSession(item.sessionId);
    });
    list.appendChild(el);
  }
}

async function openSession(sessionId) {
  state.currentId = sessionId;
  state.messages = [];
  state.stream = null;
  lastSeq = -1;
  $('#topbar-title').textContent = titleOf(state.sessions.find((s) => s.sessionId === sessionId)) || '会话';
  scheduleRender();
  await loadHistory(sessionId);
  if (state.running.has(sessionId)) ensureTyping();
}

async function loadHistory(sessionId) {
  const res = await rpc('session.history', { sessionId, maxMessages: 200 });
  if (!res.ok) return;
  const events = res.value.events || [];
  foldHistory(events);
  scheduleRender();
}

function foldHistory(events) {
  state.messages = [];
  state.stream = null;
  let pendingTools = [];
  let maxSeq = -1;

  const flushTools = () => {
    if (pendingTools.length) {
      state.messages.push({ kind: 'tool', tools: pendingTools, ts: Date.now() });
      pendingTools = [];
    }
  };

  for (const entry of events) {
    const ev = entry.event;
    if (ev && typeof ev.seq === 'number') maxSeq = Math.max(maxSeq, ev.seq);
    if (!ev) continue;
    switch (ev.type) {
      case 'user/message': {
        const src = ev.data && ev.data.source;
        if (src && src.kind === 'user') {
          flushTools();
          state.messages.push({
            kind: 'user',
            id: ev.data.id,
            text: extractText(ev.data),
            images: extractImageRefs(ev.data),
            ts: ev.time || Date.now(),
          });
        }
        break;
      }
      case 'assistant/message': {
        flushTools();
        state.messages.push({
          kind: 'assistant',
          text: extractText(ev.data && ev.data.message),
          ts: ev.time || Date.now(),
        });
        break;
      }
      case 'tool/call': {
        if (ev.data && ev.data.name) pendingTools.push(ev.data.name);
        break;
      }
      case 'assistant/chunk': {
        const chunk = ev.data && ev.data.chunk;
        if (chunk && chunk.type === 'text-delta') {
          if (!state.stream) state.stream = { text: '', tools: [] };
          state.stream.text += chunk.text;
        }
        break;
      }
      default:
        break;
    }
  }
  // If history ends mid-stream (in-flight partial), keep the stream live.
  flushTools();
  if (state.stream && state.stream.text === '' && state.messages.length) {
    // an empty trailing stream is just a typing placeholder
  }
  lastSeq = maxSeq;
}

function ensureTyping() {
  if (!state.stream) {
    state.stream = { text: '', tools: [] };
    scheduleRender();
  }
}

async function createSession() {
  const res = await rpc('session.create', {});
  if (!res.ok) {
    toast('创建会话失败', rpcError(res)?.message || '');
    return null;
  }
  return res.value.sessionId;
}

async function ensureCurrentSession() {
  if (state.currentId) return state.currentId;
  const sid = await createSession();
  if (sid) {
    state.currentId = sid;
    $('#topbar-title').textContent = '新任务';
  }
  return sid;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let pendingImages = []; // {mediaType, data, name} awaiting send

async function sendMessage(text) {
  const parts = [];
  if (text && text.trim()) parts.push({ type: 'text', text: text.trim() });
  for (const img of pendingImages) parts.push({ type: 'image', ...img });
  if (!parts.length) return;

  const sid = await ensureCurrentSession();
  if (!sid) return;

  // Render optimistically (pending marker); the stream echo will confirm it.
  const userNode = {
    kind: 'user',
    text: text ? text.trim() : '',
    images: pendingImages.map(() => ({ attachmentId: null })),
    ts: Date.now(),
    pending: true,
  };
  state.messages.push(userNode);
  pendingImages = [];
  renderImagePreviews();
  clearInput();
  scheduleRender();

  // Ask the bridge to watch this session for completion (background notify).
  fetch('/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid }),
  }).catch(() => {});

  const res = await rpc('session.prompt', {
    sessionId: sid,
    mode: 'queue',
    content: parts,
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
  });

  const err = rpcError(res);
  if (err) {
    toast('发送失败', err.message || err.code);
    // remove the optimistic node on hard failure
    const idx = state.messages.indexOf(userNode);
    if (idx >= 0) state.messages.splice(idx, 1);
    scheduleRender();
  }
}

function clearInput() {
  $('#input').value = '';
  autoGrow();
}

// ---------------------------------------------------------------------------
// Composer wiring
// ---------------------------------------------------------------------------

const inputEl = $('#input');

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
}

$('#send-btn').addEventListener('click', () => {
  const text = inputEl.value;
  if (!text.trim() && !pendingImages.length) return;
  sendMessage(text);
});

inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = inputEl.value;
    if (!text.trim() && !pendingImages.length) return;
    sendMessage(text);
  }
});

// --- photo ---
const photoInput = $('#photo-input');
$('#photo-btn').addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', async () => {
  const files = photoInput.files;
  if (!files || !files.length) return;
  for (const file of files) {
    try {
      const img = await downscaleImage(file);
      pendingImages.push(img);
    } catch (e) {
      toast('图片处理失败', e.message);
    }
  }
  photoInput.value = '';
  renderImagePreviews();
});

function renderImagePreviews() {
  const wrap = $('#image-previews');
  wrap.innerHTML = '';
  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    const el = document.createElement('div');
    el.className = 'prev';
    const im = document.createElement('img');
    im.src = `data:${img.mediaType};base64,${img.data}`;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });
    el.appendChild(im);
    el.appendChild(rm);
    wrap.appendChild(el);
  }
}

function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > max || h > max) {
        const s = max / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const isPng = (file.type === 'image/png');
      const mediaType = isPng ? 'image/png' : 'image/jpeg';
      const dataUrl = canvas.toDataURL(mediaType, 0.85);
      resolve({
        mediaType,
        data: dataUrl.split(',')[1],
        name: (file.name || '').split(/[\\/]/).pop() || undefined,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    img.src = url;
  });
}

// --- voice ---
let recognition = null;
let voiceFinal = '';
$('#voice-btn').addEventListener('click', toggleVoice);

function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('语音输入不可用', '需要 HTTPS 或 Chrome/Safari 浏览器');
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = true;
  voiceFinal = '';
  $('#voice-btn').classList.add('recording');
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) voiceFinal += t;
      else interim += t;
    }
    inputEl.value = voiceFinal + interim;
    autoGrow();
  };
  recognition.onerror = () => endVoice();
  recognition.onend = () => endVoice();
  recognition.start();
}

function endVoice() {
  if (recognition) {
    recognition.onend = null;
    recognition = null;
  }
  $('#voice-btn').classList.remove('recording');
}

// --- templates ---
let templates = loadTemplates();
$('#tpl-btn').addEventListener('click', () => openTemplates());
$('#tpl-scrim').addEventListener('click', closeTemplates());
$('#tpl-manage-btn').addEventListener('click', () => {
  $('#tpl-list').classList.add('hidden');
  $('#tpl-manage').classList.remove('hidden');
  $('#tpl-editor').value = templates.join('\n');
});
$('#tpl-cancel-btn').addEventListener('click', () => {
  $('#tpl-manage').classList.add('hidden');
  $('#tpl-list').classList.remove('hidden');
  renderTemplateList();
});
$('#tpl-save-btn').addEventListener('click', () => {
  templates = $('#tpl-editor').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  saveTemplates(templates);
  $('#tpl-manage').classList.add('hidden');
  $('#tpl-list').classList.remove('hidden');
  renderTemplateList();
});

function openTemplates() {
  renderTemplateList();
  $('#tpl-manage').classList.add('hidden');
  $('#tpl-list').classList.remove('hidden');
  $('#tpl-sheet').classList.remove('hidden');
  $('#tpl-scrim').classList.remove('hidden');
}

function closeTemplates() {
  $('#tpl-sheet').classList.add('hidden');
  $('#tpl-scrim').classList.add('hidden');
}

function renderTemplateList() {
  const list = $('#tpl-list');
  list.innerHTML = '';
  if (!templates.length) {
    list.innerHTML = '<div class="tpl-empty">还没有快捷指令，点右上角「管理」添加</div>';
    return;
  }
  for (const t of templates) {
    const el = document.createElement('div');
    el.className = 'tpl-item';
    el.textContent = t;
    el.addEventListener('click', () => {
      closeTemplates();
      inputEl.value = t;
      autoGrow();
      sendMessage(t);
    });
    list.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

$('#menu-btn').addEventListener('click', () => {
  $('#drawer').classList.add('open');
  $('#drawer-scrim').classList.remove('hidden');
});
$('#drawer-scrim').addEventListener('click', closeDrawer);
$('#new-chat-btn').addEventListener('click', async () => {
  closeDrawer();
  const sid = await createSession();
  if (sid) {
    state.sessions.unshift({ sessionId: sid, updatedAt: Date.now(), running: false, blank: true });
    state.currentId = sid;
    state.messages = [];
    state.stream = null;
    lastSeq = -1;
    $('#topbar-title').textContent = '新任务';
    scheduleRender();
  }
});

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer-scrim').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Questions / approvals
// ---------------------------------------------------------------------------

let currentQuestions = null; // {rpcId, sessionId, questions, answers}

function openQuestionModal(frame) {
  const p = frame.payload;
  currentQuestions = {
    rpcId: frame.rpcId,
    sessionId: p.sessionId,
    questions: p.questions,
    answers: new Map(),
  };
  renderQuestionModal();
  $('#modal-scrim').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}

function renderQuestionModal() {
  const body = $('#modal-body');
  body.innerHTML = '';
  const qs = currentQuestions.questions;
  for (const q of qs) {
    const block = document.createElement('div');
    block.className = 'q-block';
    if (q.header) {
      const head = document.createElement('div');
      head.className = 'q-head';
      head.textContent = q.header;
      block.appendChild(head);
    }
    const qq = document.createElement('div');
    qq.className = 'q-question';
    qq.textContent = q.question;
    block.appendChild(qq);
    if (q.detail) {
      const d = document.createElement('div');
      d.className = 'q-detail';
      d.textContent = q.detail;
      block.appendChild(d);
    }
    if (q.options && q.options.length) {
      const selected = currentQuestions.answers.get(q.id) || [];
      for (const opt of q.options) {
        const btn = document.createElement('button');
        btn.className = 'q-option' + (selected.includes(opt.label) ? ' selected' : '');
        btn.textContent = opt.label;
        if (opt.description) {
          const desc = document.createElement('span');
          desc.className = 'q-desc';
          desc.textContent = opt.description;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', () => {
          if (q.multiSelect) {
            const cur = currentQuestions.answers.get(q.id) || [];
            if (cur.includes(opt.label)) {
              currentQuestions.answers.set(q.id, cur.filter((x) => x !== opt.label));
            } else {
              currentQuestions.answers.set(q.id, [...cur, opt.label]);
            }
          } else {
            currentQuestions.answers.set(q.id, [opt.label]);
          }
          renderQuestionModal();
        });
        block.appendChild(btn);
      }
    }
    body.appendChild(block);
  }
  const actions = document.createElement('div');
  actions.className = 'q-actions';
  const submit = document.createElement('button');
  submit.className = 'btn btn-primary';
  submit.textContent = '确定';
  submit.addEventListener('click', submitQuestionAnswers);
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => {
    respond(currentQuestions.rpcId, { sessionId: currentQuestions.sessionId, answer: { answers: [] } }).catch(() => {});
    closeModal();
  });
  actions.appendChild(cancel);
  actions.appendChild(submit);
  body.appendChild(actions);
}

function submitQuestionAnswers() {
  const answers = [];
  for (const q of currentQuestions.questions) {
    const selected = currentQuestions.answers.get(q.id) || [];
    if (!selected.length && !q.options) selected.push('');
    answers.push({ id: q.id, selected });
  }
  respond(currentQuestions.rpcId, {
    sessionId: currentQuestions.sessionId,
    answer: { answers },
  }).catch(() => {});
  closeModal();
}

function openApprovalModal(frame) {
  const p = frame.payload;
  const body = $('#modal-body');
  body.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'q-head';
  head.textContent = '工具需要你的授权';
  const q = document.createElement('div');
  q.className = 'q-question';
  q.textContent = `允许执行「${p.toolName}」吗？`;
  if (p.reason) {
    const d = document.createElement('div');
    d.className = 'q-detail';
    d.textContent = p.reason;
    body.appendChild(d);
  }
  body.appendChild(head);
  body.appendChild(q);
  const actions = document.createElement('div');
  actions.className = 'q-actions';
  const allow = document.createElement('button');
  allow.className = 'btn btn-primary';
  allow.textContent = '允许';
  allow.addEventListener('click', () => {
    respond(frame.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'allowed-once' }).catch(() => {});
    closeModal();
  });
  const reject = document.createElement('button');
  reject.className = 'btn btn-ghost';
  reject.textContent = '拒绝';
  reject.addEventListener('click', () => {
    respond(frame.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'rejected' }).catch(() => {});
    closeModal();
  });
  actions.appendChild(reject);
  actions.appendChild(allow);
  body.appendChild(actions);
  $('#modal-scrim').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  currentQuestions = null;
  $('#modal').classList.add('hidden');
  $('#modal-scrim').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

function connectStreams() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.host;

  muxWs = new WebSocket(`${proto}//${host}/api/events.mux`);
  muxWs.onmessage = (e) => {
    let frame;
    try {
      frame = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMuxFrame(frame);
  };
  muxWs.onclose = () => {
    state.connected = false;
    updateConnDot();
    scheduleReconnect();
  };
  muxWs.onerror = () => {};

  hostWs = new WebSocket(`${proto}//${host}/api/events.host`);
  hostWs.onmessage = (e) => {
    let frame;
    try {
      frame = JSON.parse(e.data);
    } catch {
      return;
    }
    handleHostFrame(frame);
  };
  hostWs.onopen = () => {
    state.connected = true;
    updateConnDot();
  };
  hostWs.onclose = () => {
    state.connected = false;
    updateConnDot();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStreams();
  }, 2500);
}

function updateConnDot() {
  const dot = $('#conn-dot');
  dot.className = 'dot ' + (state.connected ? 'on' : 'off');
}

function handleMuxFrame(frame) {
  const p = frame.payload;
  if (!p || typeof p !== 'object') return;
  switch (p.type) {
    case 'session/event':
      handleSessionEvent(p.sessionId, p.event);
      break;
    case 'question/requested':
      openQuestionModal(frame);
      break;
    case 'question/resolved':
      closeModal();
      break;
    case 'approval/requested':
      openApprovalModal(frame);
      break;
    case 'approval/resolved':
      closeModal();
      break;
    case 'session/queue':
      handleQueue(p.sessionId, p.items);
      break;
    case 'session/projection':
      if (p.key === 'title') refreshSessionTitle(p.sessionId, p.value);
      break;
    default:
      break;
  }
}

function handleHostFrame(frame) {
  const p = frame.payload;
  if (!p || typeof p !== 'object') return;
  switch (p.type) {
    case 'host/session-status': {
      const wasRunning = state.running.has(p.sessionId);
      if (p.running) state.running.add(p.sessionId);
      else state.running.delete(p.sessionId);
      if (wasRunning && !p.running && p.sessionId === state.currentId) {
        onTurnComplete();
      }
      updateSessionRunningInList(p.sessionId, p.running);
      break;
    }
    case 'host/session-added':
      refreshSessions();
      break;
    case 'host/session-removed':
      refreshSessions();
      break;
    case 'host/agent-error':
      if (p.sessionId === state.currentId) {
        state.messages.push({ kind: 'system', text: '⚠️ ' + (p.message || 'Agent 出错'), ts: Date.now() });
        scheduleRender();
      }
      break;
    default:
      break;
  }
}

function handleSessionEvent(sessionId, ev) {
  if (!ev) return;
  if (sessionId !== state.currentId) return;
  if (typeof ev.seq === 'number') {
    if (ev.seq <= lastSeq) return; // already folded from history
    lastSeq = ev.seq;
  }

  switch (ev.type) {
    case 'user/message': {
      const src = ev.data && ev.data.source;
      if (src && src.kind === 'user') {
        confirmUserMessage(ev.data);
      }
      break;
    }
    case 'assistant/chunk': {
      const chunk = ev.data && ev.data.chunk;
      if (chunk && chunk.type === 'text-delta') {
        if (!state.stream) state.stream = { text: '', tools: [] };
        state.stream.text += chunk.text;
        scheduleRender();
      }
      break;
    }
    case 'tool/call': {
      if (ev.data && ev.data.name) {
        if (!state.stream) state.stream = { text: '', tools: [] };
        state.stream.tools.push(ev.data.name);
        scheduleRender();
      }
      break;
    }
    case 'assistant/message': {
      const text = extractText(ev.data && ev.data.message);
      // Finalize any streaming state into a stable assistant node.
      state.stream = null;
      // If an assistant node for this exact text already exists (folded), skip.
      const last = state.messages[state.messages.length - 1];
      if (!(last && last.kind === 'assistant' && last.text === text && Date.now() - last.ts < 3000)) {
        state.messages.push({ kind: 'assistant', text, ts: ev.time || Date.now() });
      }
      scheduleRender();
      break;
    }
    case 'turn/end': {
      state.stream = null;
      scheduleRender();
      break;
    }
    default:
      break;
  }
}

function confirmUserMessage(msg) {
  const text = extractText(msg);
  const imgs = extractImageRefs(msg);
  // Confirm a matching optimistic pending node, else append fresh.
  const idx = state.messages.findIndex(
    (n) => n.kind === 'user' && n.pending && n.text === text
  );
  if (idx >= 0) {
    state.messages[idx] = {
      kind: 'user',
      id: msg.id,
      text,
      images: imgs,
      ts: msg && msg.id ? Date.now() : Date.now(),
      pending: false,
    };
  } else {
    state.messages.push({
      kind: 'user',
      id: msg.id,
      text,
      images: imgs,
      ts: Date.now(),
      pending: false,
    });
  }
  scheduleRender();
}

function handleQueue(sessionId, items) {
  if (sessionId !== state.currentId) return;
  // Render queued (not-yet-claimed) user messages as pending bubbles.
  for (const item of items || []) {
    if (item.placement !== 'queued') continue;
    const msg = item.message;
    const text = extractText(msg);
    if (!text) continue;
    const exists = state.messages.some(
      (n) => n.kind === 'user' && (n.id === msg.id || (n.pending && n.text === text))
    );
    if (exists) continue;
    state.messages.push({
      kind: 'user',
      id: msg.id,
      text,
      images: [],
      ts: Date.now(),
      pending: true,
    });
  }
  scheduleRender();
}

function onTurnComplete() {
  state.stream = null;
  scheduleRender();
  toast('✅ 任务完成', '点按查看结果');
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  playDing();
}

function playDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch {}
}

function refreshSessionTitle(sessionId, value) {
  const item = state.sessions.find((s) => s.sessionId === sessionId);
  if (item) {
    item.projections = item.projections || { values: {} };
    item.projections.values = item.projections.values || {};
    item.projections.values.title = value;
    if (sessionId === state.currentId) $('#topbar-title').textContent = value || '会话';
    renderSessionList();
  }
}

function updateSessionRunningInList(sessionId, running) {
  const item = state.sessions.find((s) => s.sessionId === sessionId);
  if (item) {
    item.running = running;
    renderSessionList();
  }
}

async function refreshSessions() {
  await loadSessions();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(title, body) {
  const el = $('#toast');
  el.innerHTML = `<div class="toast-title">${esc(title)}</div>${
    body ? `<div class="toast-body">${esc(body)}</div>` : ''
  }`;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
  el.onclick = () => el.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Auth + boot
// ---------------------------------------------------------------------------

$('#login-btn').addEventListener('click', doLogin);
$('#password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});
$('#logout-btn').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

async function doLogin() {
  const pass = $('#password').value;
  if (!pass) return;
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pass }),
  });
  if (!res.ok) {
    $('#login-err').textContent = '密码错误，请重试';
    return;
  }
  await boot();
}

async function boot() {
  let meta;
  try {
    const r = await fetch('/meta');
    meta = await r.json();
  } catch {
    showLogin();
    return;
  }
  if (!meta.authenticated) {
    showLogin();
    return;
  }
  state.authed = true;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connectStreams();
  await initApp();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#password').focus();
}

async function initApp() {
  await loadSessions();
  const sorted = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length) {
    await openSession(sorted[0].sessionId);
  } else {
    const sid = await createSession();
    if (sid) {
      state.sessions.unshift({ sessionId: sid, updatedAt: Date.now(), running: false, blank: true });
      state.currentId = sid;
      $('#topbar-title').textContent = '新任务';
      scheduleRender();
    }
  }
}

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
