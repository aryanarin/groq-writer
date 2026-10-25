// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end check for the Chrome build: loads the unpacked extension in
// Chromium, mocks the Groq API, drives the real page UI, and checks the
// popup and options pages for errors. Run with: node tools/e2e-chrome.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'chrome');
const OUT = path.join(os.tmpdir(), 'groq-writer-e2e');
const PAGE_TITLE = 'Groq Writer E2E';
const results = [];
const pageErrors = [];
let mockMode = 'normal';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, condition, detail) {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${!condition && detail ? ' :: ' + detail : ''}`);
  if (!condition) process.exitCode = 1;
}

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome for Testing'),
    path.join(process.env.PROGRAMFILES || '', 'Chromium')
  ];
  const found = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const candidates = [
        path.join(root, dir, 'chrome-win64', 'chrome.exe'),
        path.join(root, dir, 'chrome-win', 'chrome.exe'),
        path.join(root, dir, 'chrome.exe')
      ];
      for (const exe of candidates) if (fs.existsSync(exe)) found.push(exe);
    }
  }
  // Branded Chrome ignores --load-extension since Chrome 137.
  return found.find((p) => !/Program Files\\Google\\Chrome\\Application/i.test(p)) || found[0] || '';
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.next = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP socket error'));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
          else p.resolve(msg.result || {});
          return;
        }
        const list = this.handlers.get(msg.method) || [];
        for (const fn of list) {
          try { fn(msg.params || {}, msg.sessionId); } catch { /* ignore handler errors */ }
        }
      });
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP not connected (${method})`));
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  close() {
    try { this.ws && this.ws.close(); } catch { /* already closed */ }
  }
}

async function evaluate(cdp, expression, { userGesture = false, awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture
  });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception && r.exceptionDetails.exception.description
      ? r.exceptionDetails.exception.description
      : r.exceptionDetails.text;
    throw new Error('Evaluation failed: ' + String(text).split('\n')[0]);
  }
  return r.result ? r.result.value : undefined;
}

async function waitFor(cdp, expression, label, { timeout = 10000, interval = 120, userGesture = false } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await evaluate(cdp, expression, { userGesture });
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

function targetUrl(port, suffix) {
  return `http://127.0.0.1:${port}${suffix}`;
}

function startServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
    const json = (status, data) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*'
      });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*'
      });
      res.end();
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(testPage());
      return;
    }
    if (req.url === '/proxy' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer e2e-proxy-token') {
        json(401, { error: { message: 'Invalid proxy token' } });
        return;
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const messages = payload.messages || [];
      const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
      const user = messages.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');
      const text = (user.match(/<text>\n?([\s\S]*?)\n?<\/text>/) || [, user])[1];
      let content = 'OK';
      if (/proofreading engine/i.test(system)) {
        const issues = [];
        if (text.includes('recieve')) {
          issues.push({
            original: 'recieve', replacement: 'receive', category: 'spelling',
            explanation: 'Spelling', context: text.slice(0, Math.max(0, text.indexOf('recieve')))
          });
        }
        content = JSON.stringify({ issues });
      }
      json(200, { choices: [{ message: { role: 'assistant', content } }], model: payload.model || 'proxy-model' });
      return;
    }
    if (req.url === '/v1/models') {
      json(200, { data: [{ id: 'local-chat' }, { id: 'local-embed' }] });
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const messages = payload.messages || [];
      const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
      const user = messages.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');
      const text = (user.match(/<text>\n?([\s\S]*?)\n?<\/text>/) || [, user])[1];
      let content = 'OK';
      if (/proofreading engine/i.test(system)) {
        const issues = [];
        if (text.includes('recieve')) {
          issues.push({
            original: 'recieve', replacement: 'receive', category: 'spelling',
            explanation: 'Spelling', context: text.slice(0, Math.max(0, text.indexOf('recieve')))
          });
        }
        content = JSON.stringify({ issues });
      }
      json(200, { choices: [{ message: { role: 'assistant', content } }], model: payload.model || 'local-chat' });
      return;
    }
    json(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function testPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${PAGE_TITLE}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 36px 48px; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         color: #1f2430; background: #f6f7f9; }
  main { max-width: 980px; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -.02em; }
  .lede { color: #5d6577; margin: 0 0 24px; }
  .panel { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 20px;
           box-shadow: 0 2px 10px rgba(15,23,42,.05); margin-bottom: 20px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .08em; color: #677084; margin: 0 0 10px; }
  textarea { width: 100%; min-height: 130px; resize: vertical; padding: 12px 14px; font: inherit;
             border: 1px solid #cfd4de; border-radius: 8px; outline: none; }
  textarea:focus, .rich:focus { border-color: #8b93a6; box-shadow: 0 0 0 3px rgba(139,147,166,.15); }
  .rich { min-height: 90px; padding: 12px 14px; border: 1px solid #cfd4de; border-radius: 8px; background: #fff; }
  .row { display: flex; gap: 12px; align-items: center; }
  .fake-button { background: #2563eb; color: #fff; border: 0; border-radius: 7px; padding: 9px 15px; font: inherit; }
  .muted { color: #7b8397; font-size: 13px; }
</style></head>
<body><main>
  <h1>Write better, everywhere</h1>
  <p class="lede">Groq Writer checks spelling, grammar and clarity as you type. Select text for rewriting and translation.</p>
  <div class="panel">
    <h2>Draft</h2>
    <textarea id="editor" spellcheck="true" placeholder="Start typing..."></textarea>
    <div class="row" style="margin-top:12px">
      <button class="fake-button" type="button">Publish note</button>
      <span class="muted">Saved as a draft</span>
    </div>
  </div>
  <div class="panel">
    <h2>Rich editor</h2>
    <div id="rich" class="rich" contenteditable="true" spellcheck="true"></div>
  </div>
</main></body></html>`;
}

function groqModels() {
  return {
    data: [
      { id: 'openai/gpt-oss-20b' },
      { id: 'openai/gpt-oss-120b' },
      { id: 'llama-3.3-70b-versatile' },
      { id: 'whisper-large-v3' },
      { id: 'text-embedding-3-small' }
    ]
  };
}

function mockGroqResponse(url, postData) {
  if (mockMode === 'unauthorized') {
    return { status: 401, payload: { error: { message: 'Invalid API Key', type: 'invalid_request_error' } } };
  }
  if (/\/models(?:\?|$)/.test(url)) return { status: 200, payload: groqModels() };

  let body = {};
  try { body = postData ? JSON.parse(postData) : {}; } catch { /* ignore */ }
  const messages = body.messages || [];
  const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');
  const text = (user.match(/<text>\n?([\s\S]*?)\n?<\/text>/) || [, user])[1];
  let content = 'OK';

  if (/proofreading engine/i.test(system)) {
    const issues = [];
    const add = (original, replacement, category, explanation) => {
      if (!text.includes(original)) return;
      const at = text.indexOf(original);
      issues.push({
        original, replacement, category, explanation,
        context: text.slice(Math.max(0, at - 12), at)
      });
    };
    add('Teh', 'The', 'spelling', 'Capitalize the first word');
    add('brwon', 'brown', 'spelling', 'Misspelled word');
    add('jump', 'jumps', 'grammar', 'Subject-verb agreement');
    add('teh', 'the', 'spelling', 'Misspelled word');
    content = JSON.stringify({ issues });
  } else if (/professional translator/i.test(system)) {
    const target = (system.match(/Translate the text inside <text> tags into ([^.\n]+)/) || [, 'German'])[1].trim();
    const translation = /German/i.test(target) && /writing assistant/i.test(text)
      ? 'Dies ist ein Test des Schreibassistenten.'
      : `[${target}] ${text}`;
    content = JSON.stringify({ source_language: 'English', translation });
  } else if (/identify the natural language/i.test(system)) {
    content = JSON.stringify({ language: 'English' });
  } else if (/professional writing assistant/i.test(system)) {
    if (/warm, friendly/i.test(system)) content = `Hey there! ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    else if (/formal, professional/i.test(system)) content = `Dear recipient, ${text}`;
    else content = `Revised: ${text}`;
  } else if (/Reply with OK/i.test(user)) {
    content = 'OK';
  }

  return {
    status: 200,
    payload: {
      id: 'chatcmpl-e2e',
      model: body.model || 'openai/gpt-oss-20b',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }
  };
}

function fulfill(cdp, requestId, status, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  return cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: status,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Access-Control-Allow-Origin', value: '*' }
    ],
    body
  });
}

async function screenshot(cdp, name, width = 1280, height = 800) {
  fs.mkdirSync(OUT, { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(250);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

function readDevTools(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { port: lines[0] || '', path: lines[1] || '' };
}

async function openTarget(browser, port, url, { width = 1280, height = 800, waitReady = true } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const info = await waitForTarget(port, targetId);
  const cdp = new Cdp(info.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const text = d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text;
    pageErrors.push({ kind: 'exception', page: url, text: String(text || 'exception') });
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry && p.entry.level === 'error') {
      pageErrors.push({ kind: 'console', page: p.entry.url || url, text: p.entry.text });
    }
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  if (waitReady) {
    await waitFor(cdp, 'document.readyState === "complete"', 'page load', { timeout: 15000 });
  }
  return { cdp, targetId };
}

async function waitForTarget(port, targetId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = list.find((x) => x.id === targetId || x.targetId === targetId);
    if (t && t.webSocketDebuggerUrl) return t;
    await sleep(150);
  }
  throw new Error('Target did not appear: ' + targetId);
}

async function findWorker(port) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const t of list.filter((x) => x.type === 'service_worker' && /background\.js$/.test(x.url))) {
      const cdp = new Cdp(t.webSocketDebuggerUrl);
      try {
        await cdp.open();
        await cdp.send('Runtime.enable');
        const name = await evaluate(cdp, 'chrome.runtime.getManifest().name');
        if (name === 'Groq Writer') return { cdp, extId: t.url.split('/')[2] };
        cdp.close();
      } catch {
        cdp.close();
      }
    }
    await sleep(250);
  }
  throw new Error('Groq Writer service worker not found');
}

function shadowExpr(body) {
  return `(() => { const h = document.querySelector('[data-groq-writer]'); const s = h && h.shadowRoot; if (!s) return null; ${body} })()`;
}

function badgeExpr() {
  return shadowExpr(`const b = s.querySelector('.badge'); if (!b) return null;
    return { cls: b.className, text: b.textContent, hidden: b.classList.contains('hidden'), title: b.title };`);
}

async function typeInTextarea(page, text) {
  await evaluate(page, `(() => {
    const ta = document.getElementById('editor');
    ta.focus();
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`, { userGesture: true });
}

async function selectInTextarea(page, start, end) {
  return evaluate(page, `(() => {
    const ta = document.getElementById('editor');
    ta.focus();
    ta.setSelectionRange(${start}, ${end});
    document.dispatchEvent(new Event('selectionchange'));
    ta.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
  })()`, { userGesture: true });
}

async function clickShadow(page, selector, text) {
  return evaluate(page, `(() => {
    const h = document.querySelector('[data-groq-writer]');
    const s = h && h.shadowRoot;
    if (!s) return false;
    let el = s.querySelector(${JSON.stringify(selector)});
    if (${JSON.stringify(text || '')} !== '') {
      el = [...s.querySelectorAll(${JSON.stringify(selector)})]
        .find((n) => n.textContent.trim() === ${JSON.stringify(text || '')});
    }
    if (!el) return false;
    el.click();
    return true;
  })()`, { userGesture: true });
}

async function waitForBubble(page) {
  return waitFor(page, shadowExpr(`const b = s.querySelector('.bubble'); return b ? !b.classList.contains('hidden') : false;`), 'selection bubble', { timeout: 5000 });
}

async function openMenuFromSelection(page) {
  await waitForBubble(page);
  const clicked = await clickShadow(page, '.bubble');
  if (!clicked) throw new Error('Could not click the rewrite bubble');
  await waitFor(page, shadowExpr(`const m = s.querySelector('.menu'); return m ? !m.classList.contains('hidden') : false;`), 'rewrite menu', { timeout: 5000 });
}

async function waitForMenuOption(page, label) {
  return waitFor(page, shadowExpr(`return [...s.querySelectorAll('.menu .opt')].some((n) => n.textContent.trim() === ${JSON.stringify(label)});`), `menu option ${label}`, { timeout: 5000 });
}

async function clickMenuOption(page, label) {
  const clicked = await clickShadow(page, '.menu .opt', label);
  if (!clicked) throw new Error('Menu option not found: ' + label);
  return waitFor(page, shadowExpr(`const c = s.querySelectorAll('.card')[3];
    return c && !c.classList.contains('hidden') && c.querySelector('.result') ? c.innerText : false;`), 'result text', { timeout: 10000 });
}

async function clickCardButton(page, label) {
  return evaluate(page, `(() => {
    const c = document.querySelector('[data-groq-writer]').shadowRoot.querySelectorAll('.card')[3];
    const b = [...c.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`, { userGesture: true });
}

async function run() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = findChromium();
  if (!chrome) throw new Error('No Chromium build found. Set CHROME_PATH.');
  console.log('Chromium:', chrome);

  const server = await startServer();
  console.log('Test server:', `http://127.0.0.1:${server.port}`);
  const profile = path.join(os.tmpdir(), 'groq-writer-e2e-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const chromeLog = fs.openSync(path.join(OUT, 'chromium.log'), 'w');
  const proc = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--window-size=1280,800',
    'about:blank'
  ], { detached: true, stdio: ['ignore', chromeLog, chromeLog] });
  proc.unref();

  let browser = null;
  let sw = null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let dev = { port: '', path: '' };
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(portFile)) {
        dev = readDevTools(portFile);
        if (dev.port) break;
      }
      await sleep(150);
    }
    const port = dev.port;
    if (!port) throw new Error('Chromium did not expose a DevTools port');
    console.log('DevTools port:', port);

    browser = new Cdp(`ws://127.0.0.1:${port}${dev.path}`);
    await browser.open();
    const worker = await findWorker(dev.port);
    sw = worker.cdp;
    console.log('Extension:', worker.extId);

    // Keep one page target for the test page, close any other extension tabs.
    const initial = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const t of initial) {
      if (t.type === 'page' && t.url.startsWith('chrome-extension://')) {
        await browser.send('Target.closeTarget', { targetId: t.id }).catch(() => {});
      }
    }

    // Seed a working Groq key and deterministic quick actions.
    await evaluate(sw, `(async () => {
      await chrome.storage.local.set({ apiKey: 'gsk_e2e_test_key', customApiKey: '' });
      await chrome.storage.sync.set({ settings: {
        provider: 'groq',
        enabled: true,
        language: 'en-US',
        checkModel: 'openai/gpt-oss-20b',
        rewriteModel: 'openai/gpt-oss-120b',
        targetLanguages: ['German', 'Spanish'],
        translateTone: 'formal',
        quickTone: 'friendly',
        quickLanguage: 'German',
        bubbleEverywhere: false,
        categories: { spelling: true, grammar: true, punctuation: true, clarity: true, style: false },
        debounceMs: 400,
        showBadge: true
      } });
      return true;
    })()`);

    // Intercept only Groq; the local custom endpoint goes over the real socket.
    await sw.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://api.groq.com/*', requestStage: 'Request' }]
    });
    sw.on('Fetch.requestPaused', (p) => {
      const req = p.request || {};
      if (req.method === 'OPTIONS') {
        fulfill(sw, p.requestId, 204, {}).catch(() => {});
        return;
      }
      const { status, payload } = mockGroqResponse(req.url, req.postData);
      fulfill(sw, p.requestId, status, payload).catch(() => {});
    });

    const test = await openTarget(browser, dev.port, targetUrl(server.port, '/'));
    const page = test.cdp;
    await waitFor(page, `document.title === ${JSON.stringify(PAGE_TITLE)}`, 'test page title');

    // ---------------------------------------------------------- proofreading
    await typeInTextarea(page, 'Teh quick brwon fox jump over teh lazy dog.');
    const badge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /issues/.test(info.cls) && info.text === '4' ? info : false;
    })()`, 'four suggestions', { timeout: 15000 });
    ok('content script shows 4 suggestions', badge.text === '4', JSON.stringify(badge));
    const shotA = await screenshot(page, '01-underlines-badge');
    console.log('Screenshot:', shotA);

    await clickShadow(page, '.badge');
    const panel = await waitFor(page, shadowExpr(`const p = s.querySelector('.card.wide'); return p && !p.classList.contains('hidden') ? p.innerText : false;`), 'badge panel');
    ok('badge panel lists all fixes', /Fix all \(4\)/.test(panel) && /Support/.test(panel), panel.slice(0, 250));
    const shotB = await screenshot(page, '02-badge-panel');
    console.log('Screenshot:', shotB);

    await evaluate(page, shadowExpr(`s.querySelector('.item').click(); return true;`), { userGesture: true });
    const tip = await waitFor(page, shadowExpr(`const cards = [...s.querySelectorAll('.card')].filter((c) => !c.classList.contains('hidden') && !c.classList.contains('wide') && !c.classList.contains('menu')); return cards.length ? cards[0].innerText : false;`), 'suggestion tooltip');
    ok('suggestion tooltip offers Accept and Add to dictionary', /Accept/.test(tip) && /Add to dictionary/.test(tip), tip.slice(0, 200));
    const shotC = await screenshot(page, '03-tooltip');
    console.log('Screenshot:', shotC);

    // The tooltip closes the panel; click the badge once to reopen it, then fix all.
    await clickShadow(page, '.badge');
    const fixAll = await clickShadow(page, '.card.wide button', 'Fix all (4)');
    ok('Fix all button clicked', fixAll);
    const fixed = await waitFor(page, `document.getElementById('editor').value === 'The quick brown fox jumps over the lazy dog.' ? document.getElementById('editor').value : false`, 'all fixes applied', { timeout: 10000 });
    ok('Fix all applies every suggestion', fixed === 'The quick brown fox jumps over the lazy dog.', fixed);
    const cleanBadge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /ok/.test(info.cls) ? info : false;
    })()`, 'clean badge after recheck', { timeout: 15000 });
    ok('badge returns to a clean state', cleanBadge.title === 'No issues found', JSON.stringify(cleanBadge));

    // ---------------------------------------------------------- rich editor
    await evaluate(page, `(() => {
      const r = document.getElementById('rich');
      r.focus();
      r.textContent = 'Teh cat sat on teh mat.';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return r.textContent;
    })()`, { userGesture: true });
    const richBadge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /issues/.test(info.cls) && info.text === '2' ? info : false;
    })()`, 'rich text suggestions', { timeout: 15000 });
    ok('rich editor shows 2 suggestions', richBadge.text === '2', JSON.stringify(richBadge));
    const highlights = await evaluate(page, `typeof CSS !== 'undefined' && CSS.highlights ? [...CSS.highlights.keys()] : []`);
    if (highlights.length) {
      ok('rich text uses the CSS highlight registry', highlights.some((k) => k.startsWith('gw-')), highlights.join(','));
    } else {
      console.log('note  CSS highlight registry not readable from the page world (visual check only)');
    }

    // ---------------------------------------------------------- rewrite / translate
    await typeInTextarea(page, 'This is a test of the writing assistant.');
    await selectInTextarea(page, 'This is a test of the writing assistant.'.indexOf('test'), 'This is a test of the writing assistant.'.length);
    await openMenuFromSelection(page);
    const menuText = await evaluate(page, shadowExpr(`return s.querySelector('.menu').innerText;`));
    ok('rewrite menu offers tone modes', /More formal/.test(menuText) && /More friendly/.test(menuText), '');
    ok('rewrite menu offers translation and support', /German/.test(menuText) && /Support/.test(menuText), '');
    const shotD = await screenshot(page, '04-rewrite-menu');
    console.log('Screenshot:', shotD);

    await clickMenuOption(page, 'More friendly');
    const rewritten = await waitFor(page, shadowExpr(`const c = s.querySelectorAll('.card')[3]; return c && !c.classList.contains('hidden') ? c.querySelector('.result').textContent : false;`), 'friendly rewrite', { timeout: 10000 });
    ok('friendly rewrite returns text', /Hey there! Test of the writing assistant\./.test(rewritten), rewritten);
    const shotE = await screenshot(page, '05-friendly-result');
    console.log('Screenshot:', shotE);
    await clickCardButton(page, 'Replace');
    const replaced = await waitFor(page, `document.getElementById('editor').value === 'This is a Hey there! Test of the writing assistant.' ? document.getElementById('editor').value : false`, 'rewrite replacement', { timeout: 5000 });
    ok('Replace writes the rewrite into the field', !!replaced, String(replaced));

    await selectInTextarea(page, 0, 'This is a Hey there! Test of the writing assistant.'.length);
    await openMenuFromSelection(page);
    await clickMenuOption(page, 'German');
    const translated = await waitFor(page, shadowExpr(`const c = s.querySelectorAll('.card')[3]; return c && !c.classList.contains('hidden') ? c.innerText : false;`), 'translation result', { timeout: 10000 });
    ok('translation shows the source language', /Detected language: English/.test(translated), translated.slice(0, 300));
    ok('translation returns the German text', /Dies ist ein Test des Schreibassistenten\./.test(translated), translated.slice(0, 300));
    const shotF = await screenshot(page, '06-translate-result');
    console.log('Screenshot:', shotF);
    await clickCardButton(page, 'Replace');
    const translatedValue = await waitFor(page, `document.getElementById('editor').value === 'Dies ist ein Test des Schreibassistenten.' ? document.getElementById('editor').value : false`, 'translation replacement', { timeout: 5000 });
    ok('Replace writes the translation into the field', !!translatedValue, String(translatedValue));

    // ---------------------------------------------------------- quick action
    await typeInTextarea(page, 'Please send me the report.');
    await selectInTextarea(page, 0, 'Please send me the report.'.length);
    await waitForBubble(page);
    await browser.send('Target.activateTarget', { targetId: test.targetId }).catch(() => {});
    await evaluate(sw, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.active);
      if (!tab) return false;
      await chrome.tabs.sendMessage(tab.id, { type: 'quickRewrite', mode: 'friendly' });
      return true;
    })()`);
    const quick = await waitFor(page, `document.getElementById('editor').value === 'Hey there! Please send me the report.' ? document.getElementById('editor').value : false`, 'quick rewrite applied', { timeout: 15000 });
    ok('quick action rewrites the selection directly', !!quick, String(quick));
    const toast = await waitFor(page, `(() => {
      const h = document.querySelector('[data-groq-writer]');
      const t = h && h.shadowRoot && h.shadowRoot.querySelector('.toast-msg');
      return t ? t.textContent : false;
    })()`, 'quick action toast', { timeout: 5000 });
    ok('quick action shows a confirmation toast', /Rewritten/.test(toast), toast);

    // ---------------------------------------------------------- error state
    mockMode = 'unauthorized';
    await typeInTextarea(page, 'Teh provider should reject this.');
    const errorBadge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /error/.test(info.cls) ? info : false;
    })()`, 'error badge', { timeout: 15000 });
    ok('failed checks surface an error badge', errorBadge.cls.includes('error'), JSON.stringify(errorBadge));
    await clickShadow(page, '.badge');
    const errorPanel = await waitFor(page, shadowExpr(`const p = s.querySelector('.card.wide'); return p && !p.classList.contains('hidden') ? p.innerText : false;`), 'error panel');
    ok('error panel explains the key problem', /API key|rejected|401/i.test(errorPanel), errorPanel.slice(0, 300));
    ok('error panel keeps support available', /Support/.test(errorPanel), errorPanel.slice(0, 300));
    const shotG = await screenshot(page, '07-error-state');
    console.log('Screenshot:', shotG);
    mockMode = 'normal';
    await clickShadow(page, '.card.wide button', 'Retry');
    await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /issues/.test(info.cls) ? info : false;
    })()`, 'retry succeeds', { timeout: 15000 });
    ok('Retry recovers after a provider error', true);

    // ---------------------------------------------------------- support tab
    await selectInTextarea(page, 0, 'Teh provider should reject this.'.length);
    await openMenuFromSelection(page);
    const supportClicked = await clickShadow(page, '.menu .foot .link', '\u2665 Support');
    ok('menu exposes a Support button', supportClicked);
    const supportTarget = await waitForTargetByUrl(port, /options\.html#support/);
    const support = new Cdp(supportTarget.webSocketDebuggerUrl);
    await support.open();
    await support.send('Runtime.enable');
    await waitSupportDialog(support);
    const supportText = await evaluate(support, `document.getElementById('supportDialog').innerText`);
    ok('support dialog opens with Ko-fi and UPI', /Ko-fi/.test(supportText) && /UPI/.test(supportText), supportText.slice(0, 250));
    await screenshot(support, '08-support-dialog', 1000, 900);
    support.close();

    // ---------------------------------------------------------- options page
    const options = await openTarget(browser, dev.port, `chrome-extension://${worker.extId}/options.html`, { width: 1000, height: 1000 });
    const opt = options.cdp;
    await waitFor(opt, `document.querySelectorAll('#provider option').length >= 2`, 'provider options');
    await waitFor(opt, `/Alt\\s*\\+\\s*Shift/.test(document.getElementById('shortcutList').innerText)`, 'shortcut list', { timeout: 8000 });
    const providerState = await evaluate(opt, `(() => ({
      provider: document.getElementById('provider').value,
      customHidden: document.getElementById('customFields').hidden,
      proxyHidden: document.getElementById('proxyFields').hidden,
      providerOptions: [...document.getElementById('provider').options].map((o) => o.value),
      hint: document.getElementById('providerHint').textContent,
      tone: document.getElementById('quickTone').value,
      language: document.getElementById('quickLanguage').value,
      shortcutUrl: document.getElementById('shortcutUrl').textContent,
      shortcuts: document.getElementById('shortcutList').innerText
    }))()`);
    ok('options default to the Groq provider', providerState.provider === 'groq', providerState.provider);
    ok('Worker proxy is offered as its own provider',
      providerState.providerOptions.includes('proxy') && providerState.proxyHidden,
      providerState.providerOptions.join(','));
    ok('quick action settings are rendered', providerState.tone === 'friendly' && providerState.language === 'German', providerState.tone + '/' + providerState.language);
    ok('shortcut page address is shown', providerState.shortcutUrl === 'chrome://extensions/shortcuts', providerState.shortcutUrl);
    ok('all four shortcuts are listed', /Alt\s*\+\s*Shift\s*\+\s*E/.test(providerState.shortcuts) && /Alt\s*\+\s*Shift\s*\+\s*F/.test(providerState.shortcuts) && /Alt\s*\+\s*Shift\s*\+\s*G/.test(providerState.shortcuts) && /Alt\s*\+\s*Shift\s*\+\s*K/.test(providerState.shortcuts), providerState.shortcuts);
    await screenshot(opt, '09-options', 1000, 1000);

    await evaluate(opt, `document.getElementById('testConnection').click(); true`, { userGesture: true });
    const connected = await waitFor(opt, `document.getElementById('connStatus').textContent.includes('Connected') ? document.getElementById('connStatus').textContent : false`, 'connection test', { timeout: 15000 });
    ok('Test connection reaches the mocked Groq API', /3 models available/.test(connected), connected);
    const models = await evaluate(opt, `[...document.querySelectorAll('#modelList option')].map((o) => o.value)`);
    ok('model list filters non-chat models', models.includes('openai/gpt-oss-20b') && !models.some((m) => /whisper|embed/.test(m)), models.join(','));
    const shotH = await screenshot(opt, '10-options-connected');
    console.log('Screenshot:', shotH);

    // Support from the options header.
    await evaluate(opt, `document.getElementById('openSupport').click(); true`, { userGesture: true });
    await waitFor(opt, `document.getElementById('supportDialog').open`, 'options support dialog', { timeout: 5000 });
    ok('options header Support opens the dialog', true);
    await screenshot(opt, '12-options-support', 1000, 1000);
    await evaluate(opt, `document.getElementById('closeSupport').click(); true`, { userGesture: true });
    await waitFor(opt, `!document.getElementById('supportDialog').open`, 'support dialog closed', { timeout: 5000 });

    // ---------------------------------------------------------- popup
    await browser.send('Target.activateTarget', { targetId: test.targetId }).catch(() => {});
    await sleep(400);
    const opened = await evaluate(sw, `(async () => {
      try { await chrome.action.openPopup(); return 'opened'; }
      catch (e) { return 'failed: ' + e.message; }
    })()`, { userGesture: true });
    let popup = null;
    let popupTargetId = null;
    if (opened === 'opened') {
      try {
        const target = await waitForTargetByUrl(port, /popup\.html/, 4000);
        popupTargetId = target.id;
        popup = new Cdp(target.webSocketDebuggerUrl);
        await popup.open();
        await popup.send('Runtime.enable');
        await popup.send('Page.enable');
        await popup.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 560, deviceScaleFactor: 1, mobile: false });
      } catch {
        popup = null;
      }
    }
    if (!popup) {
      const p = await openTarget(browser, port, `chrome-extension://${worker.extId}/popup.html`, { width: 380, height: 560 });
      popup = p.cdp;
      popupTargetId = p.targetId;
    }
    await waitFor(popup, `document.getElementById('connInfo') && document.getElementById('connInfo').textContent.length > 0`, 'popup render');
    const popupState = await evaluate(popup, `(() => ({
      conn: document.getElementById('connInfo').textContent,
      hint: document.getElementById('hint').innerText,
      warnHidden: document.getElementById('keyWarn').hidden,
      host: document.getElementById('host').textContent,
      siteDisabled: document.getElementById('siteOn').disabled,
      buttons: [...document.querySelectorAll('button, a.foot-link')].map((b) => b.textContent.trim()).filter(Boolean)
    }))()`);
    ok('popup shows the provider and model', popupState.conn === 'Groq \u00B7 openai/gpt-oss-20b', popupState.conn);
    ok('popup explains the configured quick actions', /More friendly/.test(popupState.hint) && /German/.test(popupState.hint), popupState.hint);
    ok('popup shows support, shortcuts and report links', popupState.buttons.some((b) => /Support/.test(b)) && popupState.buttons.some((b) => /Shortcuts/.test(b)) && popupState.buttons.some((b) => /Report/.test(b)), popupState.buttons.join(' | '));
    await screenshot(popup, '13-popup', 380, 560);
    if (popupTargetId) await browser.send('Target.closeTarget', { targetId: popupTargetId }).catch(() => {});

    // ---------------------------------------------------------- custom provider UI + permission
    await evaluate(opt, `document.getElementById('provider').value = 'custom'; document.getElementById('provider').dispatchEvent(new Event('change')); true`, { userGesture: true });
    await waitFor(opt, `document.getElementById('customFields').hidden === false`, 'custom fields');
    const customUi = await evaluate(opt, `(() => ({
      hidden: document.getElementById('customFields').hidden,
      base: document.getElementById('customBaseUrl').value,
      authOptions: [...document.getElementById('customAuth').options].map((o) => o.value),
      keyHint: document.getElementById('apiKeyLabel').textContent
    }))()`);
    ok('custom provider reveals endpoint fields', customUi.hidden === false, String(customUi.hidden));
    ok('all auth header styles are offered', ['bearer', 'x-api-key', 'api-key', 'none'].every((a) => customUi.authOptions.includes(a)), customUi.authOptions.join(','));
    await evaluate(opt, `(() => {
      const url = document.getElementById('customBaseUrl');
      url.value = ${JSON.stringify(targetUrl(server.port, '/v1'))};
      url.dispatchEvent(new Event('input', { bubbles: true }));
      const auth = document.getElementById('customAuth');
      auth.value = 'none';
      auth.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, { userGesture: true });
    await screenshot(opt, '11-options-custom', 1000, 1000);

    // This may show a native permission bubble that headless cannot dismiss; the
    // UI should still expose the manual Allow access route.
    await evaluate(opt, `document.getElementById('testConnection').click(); true`, { userGesture: true });
    await sleep(3000);
    const customTest = await evaluate(opt, `(() => ({
      status: document.getElementById('connStatus').textContent,
      grantVisible: !document.getElementById('grantAccess').hidden
    }))()`);
    if (/Connected/.test(customTest.status)) {
      const customModels = await evaluate(opt, `[...document.querySelectorAll('#modelList option')].map((o) => o.value)`);
      ok('custom endpoint test succeeds after access is granted', customModels.includes('local-chat') && !customModels.includes('local-embed'), JSON.stringify(customTest));
    } else {
      ok('missing host access is surfaced with a grant action', customTest.grantVisible && !/Connected/.test(customTest.status), JSON.stringify(customTest));
      console.log('note  optional host permission was not auto-granted in headless; status:', JSON.stringify(customTest.status));
    }

    // A copy with the local origin in host_permissions proves the whole custom path.
    const customCopy = path.join(os.tmpdir(), 'groq-writer-e2e-custom-extension');
    fs.rmSync(customCopy, { recursive: true, force: true });
    fs.cpSync(EXT, customCopy, { recursive: true });
    const manifestFile = path.join(customCopy, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.host_permissions = [...new Set([...manifest.host_permissions, 'http://127.0.0.1/*'])];
    manifest.optional_host_permissions = (manifest.optional_host_permissions || []).filter((p) => p !== 'http://*/*');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

    await runCustomPhase(chrome, customCopy, server);
    ok('no uncaught exceptions in extension pages', pageErrors.filter((e) => e.kind === 'exception').length === 0,
      pageErrors.filter((e) => e.kind === 'exception').map((e) => e.text).join(' | '));
  } catch (e) {
    ok('E2E run completed without an exception', false, e && e.message);
    if (pageErrors.length) console.log('Page errors:', pageErrors);
    throw e;
  } finally {
    try { browser && browser.close(); } catch { /* ignore */ }
    try { server.server.close(); } catch { /* ignore */ }
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(300);
    if (pageErrors.length) {
      console.log('\nCaptured page errors:');
      for (const e of pageErrors) console.log(' -', e.page, '::', e.text);
    } else {
      console.log('\nNo page exceptions or console errors were captured.');
    }
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
    console.log('Artifacts:', OUT);
    if (failed.length) process.exitCode = 1;
  }
}

async function waitForTargetByUrl(port, re, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = list.find((x) => re.test(x.url) && x.webSocketDebuggerUrl && x.type !== 'service_worker');
    if (t) return t;
    await sleep(150);
  }
  throw new Error('No target matching ' + re);
}

async function waitSupportDialog(cdp) {
  await waitFor(cdp, `document.getElementById('supportDialog') && document.getElementById('supportDialog').open`, 'support dialog', { timeout: 8000 });
}

// Runs a second browser instance with a copy that has the local endpoint in
// host_permissions. This proves the non-Groq network path without a prompt.
async function runCustomPhase(chrome, extDir, server) {
  const profile = path.join(os.tmpdir(), 'groq-writer-e2e-custom-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const log = fs.openSync(path.join(OUT, 'chromium-custom.log'), 'w');
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--window-size=1280,800',
    'about:blank'
  ], { detached: true, stdio: ['ignore', log, log] });
  proc.unref();
  let browser = null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let dev = { port: '', path: '' };
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(portFile)) {
        dev = readDevTools(portFile);
        if (dev.port) break;
      }
      await sleep(150);
    }
    if (!dev.port) throw new Error('Custom phase: no DevTools port');
    browser = new Cdp(`ws://127.0.0.1:${dev.port}${dev.path}`);
    await browser.open();
    const worker = await findWorker(dev.port);
    const sw = worker.cdp;

    await evaluate(sw, `(async () => {
      await chrome.storage.sync.set({ settings: {
        provider: 'custom',
        customBaseUrl: ${JSON.stringify(targetUrl(server.port, '/v1'))},
        customAuth: 'none',
        checkModel: 'local-chat',
        rewriteModel: 'local-chat',
        enabled: true,
        language: 'en-US',
        targetLanguages: ['German'],
        quickTone: 'friendly',
        quickLanguage: 'German',
        debounceMs: 400,
        categories: { spelling: true, grammar: true, punctuation: true, clarity: true, style: false }
      } });
      await chrome.storage.local.set({ customApiKey: '', apiKey: '' });
      return true;
    })()`);

    const test = await openTarget(browser, dev.port, targetUrl(server.port, '/'));
    const page = test.cdp;
    await typeInTextarea(page, 'I recieve mail.');
    const badge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && /issues/.test(info.cls) && info.text === '1' ? info : false;
    })()`, 'custom provider suggestion', { timeout: 15000 });
    ok('custom provider checks text over the real socket', badge.text === '1', JSON.stringify(badge));
    const sent = server.requests.filter((r) => r.url === '/v1/chat/completions');
    ok('custom provider sends no auth header with auth=none', sent.length > 0 && sent.every((r) => !r.auth), JSON.stringify(sent.map((r) => r.auth)));

    const options = await openTarget(browser, dev.port, `chrome-extension://${worker.extId}/options.html`, { width: 1000, height: 1000 });
    const opt = options.cdp;
    await waitFor(opt, `document.getElementById('connStatus') !== null`, 'custom options');
    const view = await evaluate(opt, `(() => ({
      provider: document.getElementById('provider').value,
      base: document.getElementById('customBaseUrl').value,
      auth: document.getElementById('customAuth').value,
      keyHint: document.getElementById('apiKeyLabel').textContent
    }))()`);
    ok('options reflect the custom provider', view.provider === 'custom' && /\/v1$/.test(view.base) && view.auth === 'none', JSON.stringify(view));

    await evaluate(opt, `document.getElementById('testConnection').click(); true`, { userGesture: true });
    const connected = await waitFor(opt, `document.getElementById('connStatus').textContent.includes('Connected') ? document.getElementById('connStatus').textContent : false`, 'custom connection test', { timeout: 15000 });
    const models = await evaluate(opt, `[...document.querySelectorAll('#modelList option')].map((o) => o.value)`);
    ok('custom connection test lists chat models', connected.includes('1 model available') && models.includes('local-chat') && !models.includes('local-embed'), connected + ' / ' + models.join(','));
    await screenshot(opt, '14-options-custom-connected', 1000, 1000);

    // ---------------------------------------------------------- dedicated Worker proxy
    await evaluate(opt, `(() => {
      const p = document.getElementById('provider');
      p.value = 'proxy';
      p.dispatchEvent(new Event('change'));
      return true;
    })()`, { userGesture: true });
    await waitFor(opt, `document.getElementById('proxyFields').hidden === false`, 'proxy fields');
    const proxyUi = await evaluate(opt, `(() => ({
      proxyVisible: !document.getElementById('proxyFields').hidden,
      keyHidden: document.getElementById('keyField').hidden,
      customHidden: document.getElementById('customFields').hidden,
      models: [document.getElementById('checkModel').value, document.getElementById('rewriteModel').value]
    }))()`);
    ok('proxy provider shows the Worker URL and hides the key field',
      proxyUi.proxyVisible && proxyUi.keyHidden && proxyUi.customHidden, JSON.stringify(proxyUi));
    ok('proxy provider prefills Groq model names',
      proxyUi.models[0] === 'openai/gpt-oss-20b' && proxyUi.models[1] === 'openai/gpt-oss-120b',
      proxyUi.models.join(' / '));

    const proxyEndpoint = targetUrl(server.port, '/proxy');
    await evaluate(opt, `(() => {
      const url = document.getElementById('proxyUrl');
      url.value = ${JSON.stringify(proxyEndpoint)};
      url.dispatchEvent(new Event('input', { bubbles: true }));
      const token = document.getElementById('proxyToken');
      token.value = 'e2e-proxy-token';
      token.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`, { userGesture: true });
    await evaluate(opt, `document.getElementById('testConnection').click(); true`, { userGesture: true });
    const proxyStatus = await waitFor(opt, `document.getElementById('connStatus').textContent.includes('Worker answered') ? document.getElementById('connStatus').textContent : false`, 'proxy connection test', { timeout: 15000 });
    ok('proxy test succeeds with a short chat request', /Connected/.test(proxyStatus), proxyStatus);

    await evaluate(opt, `document.getElementById('saveConnection').click(); true`, { userGesture: true });
    const savedProxy = await waitFor(sw, `(async () => {
      const s = await chrome.storage.sync.get('settings');
      const l = await chrome.storage.local.get(['proxyUrl', 'proxyToken']);
      return s.settings && s.settings.provider === 'proxy' &&
        l.proxyUrl === ${JSON.stringify(proxyEndpoint)} && l.proxyToken === 'e2e-proxy-token'
        ? {
            provider: s.settings.provider,
            url: l.proxyUrl,
            token: l.proxyToken,
            syncProxyKeys: Object.keys(s.settings).filter((k) => /proxy/i.test(k))
          }
        : false;
    })()`, 'saved proxy connection', { timeout: 10000 });
    ok('Save stores the Worker URL and token locally, never in sync settings',
      savedProxy.provider === 'proxy' && savedProxy.syncProxyKeys.length === 0,
      JSON.stringify(savedProxy));
    await waitFor(opt, `document.getElementById('connStatus').textContent.includes('saved') ? true : false`, 'proxy save confirmation');
    await sleep(1400);
    await screenshot(opt, '15-options-proxy-connected', 1280, 800);

    await sleep(300);
    await typeInTextarea(page, 'I recieve parcels.');
    let proxyCheck = null;
    for (let i = 0; i < 100 && !proxyCheck; i++) {
      proxyCheck = server.requests.find((r) =>
        r.url === '/proxy' && r.method === 'POST' && r.body.includes('recieve parcels')) || null;
      if (!proxyCheck) await sleep(150);
    }
    const proxyBadge = await waitFor(page, `(() => {
      const info = ${badgeExpr()};
      return info && !info.hidden && info.text === '1' ? info : false;
    })()`, 'proxy provider suggestion', { timeout: 15000 });
    ok('proxy provider checks text over the real socket', proxyBadge.text === '1', JSON.stringify(proxyBadge));
    ok('proxy check goes to the exact Worker URL, with no path added',
      !!proxyCheck, JSON.stringify(server.requests.map((r) => r.url)));
    ok('proxy check carries the Bearer token',
      !!proxyCheck && proxyCheck.auth === 'Bearer e2e-proxy-token',
      proxyCheck && proxyCheck.auth);
    const proxyBody = proxyCheck ? JSON.parse(proxyCheck.body) : {};
    ok('proxy check omits Groq-only reasoning fields',
      !('reasoning_effort' in proxyBody) && !('include_reasoning' in proxyBody),
      Object.keys(proxyBody).join(','));
    ok('proxy never asks for a model list',
      !server.requests.some((r) => /^\/proxy\/models/.test(r.url)),
      JSON.stringify(server.requests.map((r) => r.url)));

    const proxyPopup = await openTarget(browser, dev.port, `chrome-extension://${worker.extId}/popup.html`, { width: 380, height: 560 });
    await waitFor(proxyPopup.cdp, `document.getElementById('connInfo') && document.getElementById('connInfo').textContent.includes('Proxy')`, 'proxy popup summary');
    const proxySummary = await evaluate(proxyPopup.cdp, `document.getElementById('connInfo').textContent`);
    ok('popup names the proxy and its model', /Proxy/.test(proxySummary) && /127\.0\.0\.1/.test(proxySummary) && /gpt-oss-20b/.test(proxySummary), proxySummary);
    await screenshot(proxyPopup.cdp, '16-popup-proxy', 380, 560);
  } finally {
    try { browser && browser.close(); } catch { /* ignore */ }
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

run().catch((e) => {
  console.error('E2E failed:', e && e.stack || e);
  process.exit(1);
});
