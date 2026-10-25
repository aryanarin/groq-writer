// SPDX-License-Identifier: GPL-3.0-or-later
// Groq Writer content script.
// Watches editable fields, asks the background worker to proofread them,
// draws underlines, and offers fixes plus a rewrite menu for selected text.
(() => {
  'use strict';
  if (window.__groqWriterLoaded) return;
  window.__groqWriterLoaded = true;

  // Firefox only returns promises from `browser.*`; Chrome's `chrome.*` also has them.
  const api = globalThis.browser ?? globalThis.chrome;

  // ------------------------------------------------------------------ constants

  const CHUNK_MAX = 1200;
  const TOTAL_MAX = 15000;
  const CACHE_MAX = 400;
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE'
  ]);
  const CATEGORY = {
    spelling: { label: 'Spelling', cls: 'err' },
    grammar: { label: 'Grammar', cls: 'err' },
    punctuation: { label: 'Punctuation', cls: 'err' },
    clarity: { label: 'Clarity', cls: 'clarity' },
    style: { label: 'Style', cls: 'style' }
  };
  const ERROR_TEXT = {
    no_key: 'Add your API key or endpoint in settings to start checking.',
    invalid_key: 'The provider or proxy rejected your credentials. Check them in settings.',
    permission: 'Allow access to your API endpoint when the browser asks, then try again.',
    rate_limited: 'The provider rate limit was reached. Retrying shortly.',
    network: 'Could not reach the API endpoint. Check your connection and endpoint URL.',
    timeout: 'The API took too long to answer.',
    server: 'The API had a server error. Try again soon.',
    bad_request: 'The provider rejected the request. Check the model name and endpoint in settings.',
    no_model: 'Choose a model in settings first.',
    bad_language: 'That does not look like a language name. Try something like "Spanish".',
    reload: 'Groq Writer was updated. Reload this page to continue.',
    empty: 'Nothing to do.',
    unknown: 'Something went wrong.'
  };
  const MIRROR_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign',
    'direction', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'wordBreak', 'textRendering'
  ];

  // ------------------------------------------------------------------ state

  let settings = null;
  let configured = false;
  let modes = [];
  let commonLanguages = [];
  let siteOff = true;
  let sig = '';
  let active = null;
  let selSnap = null;
  let rewriteOpen = false;
  let panelOpen = false;
  let tipSt = null;
  let tipIssue = null;

  const states = new WeakMap();
  const live = new Set();
  const cache = new Map();
  const dismissed = new Set();

  // ------------------------------------------------------------------ messaging

  function send(msg) {
    try {
      if (globalThis.browser) {
        return api.runtime.sendMessage(msg).catch(() => ({ ok: false, error: 'reload' }));
      }
      return new Promise((resolve) => {
        api.runtime.sendMessage(msg, (r) => {
          if (api.runtime.lastError) resolve({ ok: false, error: 'reload' });
          else resolve(r || { ok: false, error: 'unknown' });
        });
      });
    } catch {
      return Promise.resolve({ ok: false, error: 'reload' });
    }
  }

  function siteHost() {
    let h = location.hostname;
    if (!h && location.ancestorOrigins && location.ancestorOrigins.length) {
      try { h = new URL(location.ancestorOrigins[0]).hostname; } catch { /* ignore */ }
    }
    return (h || '').toLowerCase();
  }

  async function loadSettings() {
    const r = await send({ type: 'getSettings' });
    if (!r || !r.ok) return false;
    settings = r.settings;
    configured = r.hasKey;
    modes = r.modes || [];
    commonLanguages = r.commonLanguages || [];
    const host = siteHost();
    const blocked = host === 'docs.google.com' ||
      settings.disabledSites.some((d) => host === d || host.endsWith('.' + d));
    siteOff = !settings.enabled || blocked;
    sig = JSON.stringify([
      settings.provider, settings.customBaseUrl, settings.customAuth,
      settings.language, settings.checkModel, settings.categories, settings.dictionary
    ]);
    return true;
  }

  // ------------------------------------------------------------------ field detection

  function editableRoot(t) {
    if (!(t instanceof Element)) return null;
    if (t.tagName === 'TEXTAREA') return t.readOnly || t.disabled ? null : t;
    if (t.tagName === 'INPUT') {
      const type = (t.getAttribute('type') || 'text').toLowerCase();
      return type === 'text' && !t.readOnly && !t.disabled ? t : null;
    }
    if (t.isContentEditable) {
      let r = t;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return r;
    }
    return null;
  }

  function eligible(el) {
    if (!el.isConnected) return false;
    if (el.getAttribute('spellcheck') === 'false') return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^(cc-|one-time-code|new-password|current-password|username|email)/.test(ac)) return false;
    if (el.closest('.cm-editor, .CodeMirror, .monaco-editor, .ace_editor, [data-gramm="false"]')) return false;
    if (el.tagName === 'INPUT' && (el.clientWidth < 150 || el.clientHeight < 22)) return false;
    return true;
  }

  function getState(el) {
    let st = states.get(el);
    if (!st) {
      const isText = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      st = {
        el,
        kind: isText ? 'text' : 'ce',
        issues: [],
        lastText: '',
        checkedText: null,
        timer: null,
        retry: null,
        reqId: 0,
        status: 'idle',
        error: null,
        mirror: null,
        model: null,
        ro: null
      };
      states.set(el, st);
    }
    return st;
  }

  // ------------------------------------------------------------------ text model

  // Flattens a contenteditable into plain text plus a map back to DOM text nodes.
  function modelOf(root) {
    let text = '';
    const segs = [];
    const walk = (n) => {
      if (n.nodeType === 3) {
        const d = n.data;
        segs.push({ node: n, start: text.length, end: text.length + d.length });
        text += d.replace(/\u00A0/g, ' ');
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (n !== root && n.isContentEditable === false) return;
      if (tag === 'BR') {
        text += '\n';
        return;
      }
      const block = BLOCK_TAGS.has(tag) && n !== root;
      if (block && text && !text.endsWith('\n')) text += '\n';
      for (const c of n.childNodes) walk(c);
      if (block && text && !text.endsWith('\n')) text += '\n';
    };
    walk(root);
    return { text, segs };
  }

  function offsetOf(model, node, off) {
    if (node.nodeType === 3) {
      const g = model.segs.find((s) => s.node === node);
      return g ? g.start + off : null;
    }
    const target = node.childNodes[off];
    if (target) {
      for (const g of model.segs) {
        if (target === g.node || target.contains(g.node) ||
          (target.compareDocumentPosition(g.node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          return g.start;
        }
      }
    }
    return model.text.length;
  }

  function rangeFor(model, start, end) {
    let a = null;
    let b = null;
    for (const g of model.segs) {
      if (!a && start >= g.start && start < g.end) a = g;
      if (end > g.start && end <= g.end) b = g;
    }
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, start - a.start);
      r.setEnd(b.node, end - b.start);
      return r;
    } catch {
      return null;
    }
  }

  function readText(st) {
    if (st.kind === 'text') return st.el.value;
    st.model = modelOf(st.el);
    return st.model.text;
  }

  // ------------------------------------------------------------------ chunking and locating

  function splitLong(line, base) {
    const pieces = [];
    const re = /[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g;
    let m;
    let last = 0;
    while ((m = re.exec(line))) {
      pieces.push({ off: base + m.index, len: m[0].length });
      last = m.index + m[0].length;
    }
    if (last < line.length) pieces.push({ off: base + last, len: line.length - last });
    const out = [];
    for (const p of pieces) {
      for (let i = 0; i < p.len; i += CHUNK_MAX) {
        out.push({ off: p.off + i, len: Math.min(CHUNK_MAX, p.len - i) });
      }
    }
    return out;
  }

  function chunkText(text) {
    const chunks = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.text.trim()) chunks.push(cur);
      cur = null;
    };
    let pos = 0;
    for (const line of text.split('\n')) {
      const pieces = line.length > CHUNK_MAX ? splitLong(line, pos) : [{ off: pos, len: line.length }];
      for (const p of pieces) {
        if (cur && p.off + p.len - cur.start > CHUNK_MAX) flush();
        if (!cur) cur = { start: p.off, text: '' };
        cur.text = text.slice(cur.start, p.off + p.len);
      }
      pos += line.length + 1;
    }
    flush();
    return chunks;
  }

  const WORD_CHAR = /[\p{L}\p{N}]/u;

  function locate(chunk, issue, used) {
    const { original, context } = issue;
    const first = original[0];
    const last = original[original.length - 1];
    const idxs = [];
    let i = chunk.indexOf(original);
    while (i !== -1) {
      const before = i > 0 ? chunk[i - 1] : '';
      const after = i + original.length < chunk.length ? chunk[i + original.length] : '';
      const okStart = !(WORD_CHAR.test(first) && before && WORD_CHAR.test(before));
      const okEnd = !(WORD_CHAR.test(last) && after && WORD_CHAR.test(after));
      if (okStart && okEnd) idxs.push(i);
      i = chunk.indexOf(original, i + 1);
    }
    if (!idxs.length) return -1;
    if (context) {
      const hit = idxs.find((k) => !used.has(k) && chunk.slice(0, k).endsWith(context));
      if (hit !== undefined) return hit;
    }
    const free = idxs.find((k) => !used.has(k));
    return free !== undefined ? free : -1;
  }

  // ------------------------------------------------------------------ checking

  async function checkChunk(text) {
    const key = sig + '|' + text;
    if (cache.has(key)) return { ok: true, issues: cache.get(key) };
    const r = await send({ type: 'check', text });
    if (r.ok) {
      cache.set(key, r.issues);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return r;
  }

  function dismissKey(i) {
    return i.original + '\u0000' + i.replacement;
  }

  function schedule(st, ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => runCheck(st, false), ms);
  }

  async function runCheck(st, force) {
    clearTimeout(st.timer);
    st.timer = null;
    if (siteOff || !settings || !st.el.isConnected) return;

    const text = readText(st);
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const tooShort = st.el.tagName === 'INPUT' ? words < 3 : text.trim().length < 3;
    if (tooShort) {
      st.issues = [];
      st.lastText = st.checkedText = text;
      st.status = 'idle';
      st.error = null;
      renderIssues(st);
      return;
    }
    if (!force && st.checkedText === text) return;
    if (!configured) {
      st.status = 'error';
      st.error = 'no_key';
      updateBadge();
      return;
    }

    const id = ++st.reqId;
    st.status = 'checking';
    st.error = null;
    updateBadge();

    const chunks = chunkText(text.slice(0, TOTAL_MAX));
    let firstError = null;
    const results = await Promise.all(
      chunks.map(async (c) => {
        const r = await checkChunk(c.text);
        if (!r.ok) {
          firstError = firstError || r.error || 'unknown';
          return { c, issues: null };
        }
        return { c, issues: r.issues };
      })
    );

    if (id !== st.reqId) return;
    if (readText(st) !== text) {
      if (!st.timer) schedule(st, 300);
      return;
    }

    const failedAll = firstError && results.every((x) => x.issues === null);
    if (failedAll) {
      st.status = 'error';
      st.error = firstError;
      updateBadge();
      if (firstError === 'rate_limited' || firstError === 'network' || firstError === 'server') {
        clearTimeout(st.retry);
        st.retry = setTimeout(() => runCheck(st, true), 10000);
      }
      return;
    }

    const found = [];
    for (const { c, issues } of results) {
      if (!issues) continue;
      const used = new Set();
      for (const is of issues) {
        const idx = locate(c.text, is, used);
        if (idx < 0) continue;
        used.add(idx);
        if (dismissed.has(dismissKey(is))) continue;
        const info = CATEGORY[is.category];
        if (!info) continue;
        found.push({
          ...is,
          cls: info.cls,
          start: c.start + idx,
          end: c.start + idx + is.original.length
        });
      }
    }
    found.sort((a, b) => a.start - b.start);
    const clean = [];
    let edge = -1;
    for (const f of found) {
      if (f.start >= edge) {
        clean.push(f);
        edge = f.end;
      }
    }

    st.issues = clean;
    st.checkedText = st.lastText = text;
    st.status = firstError ? 'partial' : 'ok';
    st.error = null;
    renderIssues(st);
  }

  // Keeps existing underlines roughly in place while the user types, until the next check lands.
  function adjustIssues(st, oldText, newText) {
    if (!st.issues.length || oldText === newText) return;
    const min = Math.min(oldText.length, newText.length);
    let p = 0;
    while (p < min && oldText[p] === newText[p]) p++;
    let s = 0;
    while (s < min - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
    const oldEnd = oldText.length - s;
    const delta = newText.length - oldText.length;
    st.issues = st.issues
      .filter((i) => i.end < p || i.start > oldEnd)
      .map((i) => (i.start > oldEnd ? { ...i, start: i.start + delta, end: i.end + delta } : i));
  }

  // ------------------------------------------------------------------ applying edits

  function applyReplacement(st, start, end, replacement) {
    const el = st.el;
    try {
      el.focus({ preventScroll: true });
      if (st.kind === 'text') {
        el.setSelectionRange(start, end);
        if (!document.execCommand('insertText', false, replacement)) {
          el.setRangeText(replacement, start, end, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
        }
        return true;
      }
      const model = modelOf(el);
      const r = rangeFor(model, start, end);
      if (!r) return false;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      if (!document.execCommand('insertText', false, replacement)) {
        r.deleteContents();
        r.insertNode(document.createTextNode(replacement));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
      }
      return true;
    } catch {
      return false;
    }
  }

  function acceptIssue(st, issue) {
    const current = readText(st).slice(issue.start, issue.end);
    if (current !== issue.original) {
      st.issues = st.issues.filter((i) => i !== issue);
      renderIssues(st);
      return;
    }
    applyReplacement(st, issue.start, issue.end, issue.replacement);
    closeTip();
    schedule(st, 400);
  }

  function dismissIssue(st, issue) {
    dismissed.add(dismissKey(issue));
    st.issues = st.issues.filter((i) => i !== issue);
    closeTip();
    renderIssues(st);
  }

  function fixAll(st) {
    const text = readText(st);
    const todo = st.issues
      .filter((i) => text.slice(i.start, i.end) === i.original)
      .sort((a, b) => b.start - a.start);
    for (const i of todo) applyReplacement(st, i.start, i.end, i.replacement);
    closePanel();
    closeTip();
    schedule(st, 400);
  }

  // ------------------------------------------------------------------ UI scaffolding

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .layer { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none; }
    .mirror { position: fixed; overflow: hidden; pointer-events: none; }
    .mirror .inner { position: absolute; left: 0; top: 0; color: transparent; }
    .mk { color: transparent; text-decoration-line: underline; text-decoration-style: wavy;
          text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
    .mk.err { text-decoration-color: #e5484d; }
    .mk.clarity { text-decoration-color: #3b82f6; }
    .mk.style { text-decoration-color: #8b5cf6; }
    .mk.sel { text-decoration: none; }
    .ui { position: fixed; z-index: 2147483647; pointer-events: auto; color: #1f2430; }
    .hidden { display: none !important; }
    .badge { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
             font-size: 11px; font-weight: 700; color: #fff; background: #8a93a6; cursor: pointer; user-select: none;
             box-shadow: 0 1px 4px rgba(0,0,0,.3); }
    .badge.ok { background: #16a34a; }
    .badge.issues { background: #e5484d; }
    .badge.error { background: #d97706; }
    .badge.checking::after { content: ""; width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.4);
             border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card { width: 320px; max-width: calc(100vw - 16px); background: #fff; border: 1px solid #dfe3ea; border-radius: 10px;
            box-shadow: 0 8px 28px rgba(15,23,42,.22); padding: 12px; font-size: 13px; line-height: 1.45; }
    .card h4 { margin: 0 0 6px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #6b7280;
               display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; display: inline-block; }
    .dot.clarity { background: #3b82f6; } .dot.style { background: #8b5cf6; }
    .change { font-size: 14px; margin-bottom: 4px; word-break: break-word; }
    .old { color: #b42318; text-decoration: line-through; }
    .new { color: #067647; font-weight: 600; }
    .why { color: #5b6475; margin-bottom: 10px; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    button { font: inherit; font-size: 12px; border-radius: 6px; padding: 5px 10px; cursor: pointer;
             border: 1px solid #d0d5dd; background: #fff; color: #1f2430; }
    button:hover { background: #f4f5f7; }
    button.primary { background: #f55036; border-color: #f55036; color: #fff; font-weight: 600; }
    button.primary:hover { background: #dc4229; }
    button.link { border: none; background: none; color: #5b6475; padding: 5px 4px; }
    .list { max-height: 220px; overflow: auto; margin: 6px 0 10px; }
    .card.wide { width: 380px; }
    .item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 4px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .item:hover { background: #f4f5f7; }
    .item .dot { margin-top: 6px; flex: none; }
    .item .txt { min-width: 0; flex: 1; }
    .item .txt > div { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .item span.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #5b6475; }
    .gap { margin-bottom: 10px; }
    .foot { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-top: 8px;
            padding-top: 6px; border-top: 1px solid #eef0f4; }
    .foot .link { color: #b42318; }
    .bubble { width: 28px; height: 28px; border-radius: 8px; background: #f55036; color: #fff; display: flex; align-items: center;
              justify-content: center; font-size: 15px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); user-select: none; }
    .menu { width: 230px; padding: 6px; max-height: min(480px, calc(100vh - 16px)); overflow: auto; }
    .menu .sec { padding: 6px 8px 2px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; }
    .menu .opt { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .menu .opt:hover { background: #f4f5f7; }
    .menu input { width: 100%; margin: 4px 0; padding: 6px 8px; font-size: 13px; border: 1px solid #d0d5dd; border-radius: 6px; color: #1f2430; background: #fff; }
    .result { white-space: pre-wrap; max-height: 220px; overflow: auto; background: #f8fafc; border: 1px solid #e5e7eb;
              border-radius: 6px; padding: 8px; margin-bottom: 10px; word-break: break-word; }
    .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #d0d5dd; border-top-color: #f55036;
            border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    .err-text { color: #b42318; margin-bottom: 10px; }
    .toast-msg { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1f2430;
                 color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 13px; z-index: 2147483648;
                 box-shadow: 0 2px 8px rgba(0,0,0,.3); animation: fade-in-out 2s ease-out; }
    @keyframes fade-in-out { 0% { opacity: 0; } 20% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
  `;

  let host = null;
  let shadow = null;
  let layer = null;
  let badge = null;
  let panel = null;
  let tip = null;
  let bubble = null;
  let menu = null;
  let card = null;
  let highlightSheet = null;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
    }
    for (const k of kids.flat()) {
      if (k == null) continue;
      e.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return e;
  }

  function openSupport() {
    send({ type: 'openSupport' });
  }

  function supportButton(label) {
    return h('button', { class: 'link', onclick: openSupport }, label || '\u2665 Support');
  }

  function settingsButton() {
    return h('button', { class: 'link', onclick: () => send({ type: 'openOptions' }) }, 'Settings');
  }

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-groq-writer', '');
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    // Constructable stylesheets are not blocked by page CSP, unlike injected <style> tags.
    // Firefox can refuse sheets created in the content-script world, so fall back to a <style> tag.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, CSS));
    }

    layer = h('div', { class: 'layer' });
    badge = h('div', { class: 'ui badge hidden', onclick: onBadgeClick });
    panel = h('div', { class: 'ui card wide hidden' });
    tip = h('div', { class: 'ui card hidden' });
    bubble = h('div', { class: 'ui bubble hidden', title: 'Rewrite with Groq Writer', onclick: openMenu }, '\u2726');
    menu = h('div', { class: 'ui card menu hidden' });
    card = h('div', { class: 'ui card hidden' });
    shadow.append(layer, badge, panel, tip, bubble, menu, card);

    // Keep focus (and the text selection) inside the page field when clicking our UI.
    shadow.addEventListener('mousedown', (e) => {
      if (e.composedPath()[0] instanceof HTMLInputElement) return;
      e.preventDefault();
    });

    (document.documentElement || document.body).append(host);

    if (!highlightSheet) {
      const rules =
        '::highlight(gw-err){text-decoration:underline wavy #e5484d;}' +
        '::highlight(gw-clarity){text-decoration:underline wavy #3b82f6;}' +
        '::highlight(gw-style){text-decoration:underline wavy #8b5cf6;}';
      try {
        highlightSheet = new CSSStyleSheet();
        highlightSheet.replaceSync(rules);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, highlightSheet];
      } catch {
        highlightSheet = document.createElement('style');
        highlightSheet.textContent = rules;
        (document.head || document.documentElement).append(highlightSheet);
      }
    }
  }

  function placeNear(node, rect, below = true) {
    node.style.left = '0px';
    node.style.top = '0px';
    const w = node.offsetWidth;
    const hh = node.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - w - 8));
    let top = below ? rect.bottom + 6 : rect.top - hh - 6;
    if (below && top + hh > window.innerHeight - 8) top = rect.top - hh - 6;
    if (!below && top < 8) top = rect.bottom + 6;
    node.style.left = left + 'px';
    node.style.top = Math.max(8, top) + 'px';
  }

  // ------------------------------------------------------------------ underlines

  function buildMirror(st, marks) {
    const el = st.el;
    const cs = getComputedStyle(el);
    const wrap = h('div', { class: 'mirror' });
    const inner = h('div', { class: 'inner' });
    for (const p of MIRROR_STYLE_PROPS) inner.style[p] = cs[p];
    const isArea = el.tagName === 'TEXTAREA';
    inner.style.boxSizing = 'border-box';
    inner.style.width = el.clientWidth + 'px';
    inner.style.whiteSpace = isArea && el.wrap !== 'off' ? 'pre-wrap' : 'pre';
    inner.style.overflowWrap = isArea ? 'break-word' : 'normal';
    if (isArea) {
      inner.style.lineHeight = cs.lineHeight;
    } else {
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      inner.style.lineHeight = Math.max(8, el.clientHeight - pad) + 'px';
    }

    const text = el.value;
    let pos = 0;
    for (const m of marks.slice().sort((a, b) => a.start - b.start)) {
      if (m.start < pos || m.end > text.length) continue;
      if (m.start > pos) inner.append(text.slice(pos, m.start));
      const node = h('span', { class: 'mk ' + m.cls }, text.slice(m.start, m.end));
      m.node = node;
      inner.append(node);
      pos = m.end;
    }
    inner.append(text.slice(pos));
    wrap.append(inner);
    placeMirror(st, wrap, inner);
    return { wrap, inner };
  }

  function placeMirror(st, wrap, inner) {
    const el = st.el;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      wrap.style.display = 'none';
      return;
    }
    const cs = getComputedStyle(el);
    wrap.style.display = '';
    wrap.style.left = r.left + (parseFloat(cs.borderLeftWidth) || 0) + 'px';
    wrap.style.top = r.top + (parseFloat(cs.borderTopWidth) || 0) + 'px';
    wrap.style.width = el.clientWidth + 'px';
    wrap.style.height = el.clientHeight + 'px';
    inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  }

  function renderMirror(st) {
    ensureUI();
    if (st.mirror) {
      st.mirror.wrap.remove();
      st.mirror = null;
    }
    if (!st.issues.length || siteOff) {
      if (st.ro) {
        st.ro.disconnect();
        st.ro = null;
      }
      live.delete(st);
      return;
    }
    const m = buildMirror(st, st.issues);
    layer.append(m.wrap);
    st.mirror = m;
    live.add(st);
    if (!st.ro && typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(() => renderMirror(st));
      st.ro.observe(st.el);
    }
  }

  function rebuildHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    const buckets = { err: [], clarity: [], style: [] };
    for (const st of live) {
      if (st.kind !== 'ce') continue;
      for (const i of st.issues) if (i.range) buckets[i.cls].push(i.range);
    }
    try {
      for (const k of Object.keys(buckets)) {
        if (buckets[k].length) CSS.highlights.set('gw-' + k, new Highlight(...buckets[k]));
        else CSS.highlights.delete('gw-' + k);
      }
    } catch { /* the page's highlight registry is not reachable from this context */ }
  }

  function renderIssues(st) {
    if (st.kind === 'text') {
      renderMirror(st);
    } else {
      const model = modelOf(st.el);
      st.model = model;
      for (const i of st.issues) i.range = rangeFor(model, i.start, i.end);
      if (st.issues.length) live.add(st); else live.delete(st);
      rebuildHighlights();
    }
    updateBadge();
    if (panelOpen) renderPanel();
  }

  function cleanupState(st) {
    clearTimeout(st.timer);
    clearTimeout(st.retry);
    if (st.mirror) st.mirror.wrap.remove();
    st.mirror = null;
    if (st.ro) st.ro.disconnect();
    st.ro = null;
    live.delete(st);
  }

  function clearAll() {
    for (const st of Array.from(live)) {
      st.issues = [];
      cleanupState(st);
    }
    if (active) {
      active.issues = [];
      cleanupState(active);
    }
    rebuildHighlights();
    if (host) {
      for (const n of [badge, panel, tip, bubble, menu, card]) n.classList.add('hidden');
    }
    panelOpen = false;
    rewriteOpen = false;
    tipSt = tipIssue = null;
  }

  // ------------------------------------------------------------------ geometry

  function issueRects(st, issue) {
    if (st.kind === 'text') return issue.node && issue.node.isConnected ? Array.from(issue.node.getClientRects()) : [];
    return issue.range ? Array.from(issue.range.getClientRects()) : [];
  }

  function issueAtPoint(st, x, y) {
    for (const i of st.issues) {
      for (const r of issueRects(st, i)) {
        if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 2 && y <= r.bottom + 2) return i;
      }
    }
    return null;
  }

  function measureRange(st, start, end) {
    if (st.kind === 'ce') {
      const r = rangeFor(modelOf(st.el), start, end);
      if (!r) return null;
      const rects = r.getClientRects();
      return rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
    }
    ensureUI();
    const marks = [{ start, end, cls: 'sel' }];
    const m = buildMirror(st, marks);
    m.wrap.style.visibility = 'hidden';
    layer.append(m.wrap);
    const rects = marks[0].node ? marks[0].node.getClientRects() : [];
    const rect = rects.length ? rects[rects.length - 1] : null;
    m.wrap.remove();
    return rect;
  }

  let raf = 0;
  function scheduleReposition() {
    if (raf || !host) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const st of Array.from(live)) {
        if (!st.el.isConnected) {
          cleanupState(st);
          continue;
        }
        if (st.kind === 'text' && st.mirror) placeMirror(st, st.mirror.wrap, st.mirror.inner);
      }
      if (active && !active.el.isConnected) setActive(null);
      positionBadge();
      positionTip();
      positionBubble();
    });
  }

  // ------------------------------------------------------------------ badge and panel

  function badgeInfo(st) {
    if (!configured || st.error === 'no_key') return { cls: 'error', text: '!', title: ERROR_TEXT.no_key };
    if (st.status === 'checking') return { cls: 'checking', text: '', title: 'Checking...' };
    if (st.status === 'error') return { cls: 'error', text: '!', title: ERROR_TEXT[st.error] || ERROR_TEXT.unknown };
    if (st.issues.length) {
      const n = st.issues.length;
      return { cls: 'issues', text: n > 99 ? '99+' : String(n), title: `${n} suggestion${n === 1 ? '' : 's'}` };
    }
    if (st.status === 'ok' || st.status === 'partial') return { cls: 'ok', text: '\u2713', title: 'No issues found' };
    return { cls: '', text: 'G', title: 'Groq Writer' };
  }

  function updateBadge() {
    if (!host) return;
    if (!active || siteOff || !settings.showBadge || !active.el.isConnected) {
      badge.classList.add('hidden');
      return;
    }
    const info = badgeInfo(active);
    badge.className = 'ui badge ' + info.cls;
    badge.textContent = info.text;
    badge.title = info.title;
    positionBadge();
  }

  function positionBadge() {
    if (!host || badge.classList.contains('hidden') || !active) return;
    const r = active.el.getBoundingClientRect();
    if (r.width < 100 || r.height < 20 || r.bottom < 0 || r.top > window.innerHeight) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';
    const left = Math.min(r.right - 30, window.innerWidth - 32);
    const top = r.height >= 52 ? r.bottom - 30 : r.top + (r.height - 24) / 2;
    badge.style.left = Math.max(4, left) + 'px';
    badge.style.top = Math.max(4, Math.min(top, window.innerHeight - 30)) + 'px';
    if (panelOpen) placePanel();
  }

  function placePanel() {
    const r = badge.getBoundingClientRect();
    placeNear(panel, { left: r.right - panel.offsetWidth, top: r.top, bottom: r.bottom }, false);
  }

  function onBadgeClick() {
    if (!active) return;
    closeTip();
    if (panelOpen) closePanel();
    else openPanel();
  }

  function openPanel() {
    panelOpen = true;
    renderPanel();
    panel.classList.remove('hidden');
    placePanel();
  }

  function closePanel() {
    panelOpen = false;
    if (panel) panel.classList.add('hidden');
  }

  function renderPanel() {
    if (!active) return;
    const st = active;
    const info = badgeInfo(st);
    panel.replaceChildren();
    panel.append(h('h4', null, 'Groq Writer'));

    if (!configured || st.status === 'error') {
      panel.append(
        h('div', { class: 'err-text' }, !configured ? ERROR_TEXT.no_key : (ERROR_TEXT[st.error] || ERROR_TEXT.unknown)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => send({ type: 'openOptions' }) }, 'Open settings'),
          configured ? h('button', { onclick: () => { closePanel(); runCheck(st, true); } }, 'Retry') : null),
        h('div', { class: 'foot' }, supportButton())
      );
      return;
    }

    if (!st.issues.length) {
      panel.append(
        h('div', { class: 'muted gap' }, st.status === 'checking' ? 'Checking...' : info.title),
        h('div', { class: 'row' }, h('button', { onclick: () => { closePanel(); runCheck(st, true); } }, 'Check again')),
        h('div', { class: 'foot' }, supportButton())
      );
      return;
    }

    const list = h('div', { class: 'list' });
    for (const i of st.issues.slice(0, 50)) {
      list.append(
        h('div', { class: 'item', onclick: () => { closePanel(); showTip(st, i); } },
          h('span', { class: 'dot ' + i.cls }),
          h('div', { class: 'txt', title: `${i.original} \u2192 ${i.replacement}` },
            h('div', { class: 'old' }, i.original),
            h('div', { class: 'new' }, i.replacement === '' ? '(remove)' : i.replacement)))
      );
    }
    panel.append(
      list,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => fixAll(st) }, `Fix all (${st.issues.length})`),
        h('button', { onclick: () => { closePanel(); runCheck(st, true); } }, 'Recheck')),
      h('div', { class: 'foot' }, supportButton())
    );
  }

  // ------------------------------------------------------------------ suggestion tooltip

  function showTip(st, issue) {
    ensureUI();
    const rect = issueRects(st, issue)[0];
    if (!rect) return;
    tipSt = st;
    tipIssue = issue;
    const cat = CATEGORY[issue.category];
    tip.replaceChildren(
      h('h4', null, h('span', { class: 'dot ' + issue.cls }), cat ? cat.label : 'Suggestion'),
      h('div', { class: 'change' },
        h('span', { class: 'old' }, issue.original),
        ' \u2192 ',
        h('span', { class: 'new' }, issue.replacement === '' ? '(remove)' : issue.replacement)),
      issue.explanation ? h('div', { class: 'why' }, issue.explanation) : null,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => acceptIssue(st, issue) }, 'Accept'),
        h('button', { onclick: () => dismissIssue(st, issue) }, 'Dismiss'),
        issue.category === 'spelling'
          ? h('button', { class: 'link', onclick: () => addToDictionary(st, issue) }, 'Add to dictionary')
          : null)
    );
    tip.classList.remove('hidden');
    placeNear(tip, rect);
  }

  function positionTip() {
    if (!tipIssue || !tipSt || tip.classList.contains('hidden')) return;
    const rect = issueRects(tipSt, tipIssue)[0];
    if (!rect) closeTip();
    else placeNear(tip, rect);
  }

  function closeTip() {
    tipSt = tipIssue = null;
    if (tip) tip.classList.add('hidden');
  }

  async function addToDictionary(st, issue) {
    closeTip();
    st.issues = st.issues.filter((i) => i.original !== issue.original);
    renderIssues(st);
    await send({ type: 'addWord', word: issue.original });
  }

  // ------------------------------------------------------------------ selection rewrite

  function readSelection() {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      const root = editableRoot(ae);
      if (!root || !eligible(root) || typeof root.selectionStart !== 'number') return null;
      const { selectionStart: s, selectionEnd: e } = root;
      if (s === e) return null;
      return { st: getState(root), start: s, end: e, text: root.value.slice(s, e) };
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const startEl = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    const root = editableRoot(startEl);
    if (!root || !eligible(root) || !root.contains(r.endContainer)) return null;
    const st = getState(root);
    const model = modelOf(root);
    const s = offsetOf(model, r.startContainer, r.startOffset);
    const e = offsetOf(model, r.endContainer, r.endOffset);
    if (s == null || e == null || e <= s) return null;
    return { st, start: s, end: e, text: model.text.slice(s, e) };
  }

  let selTimer = null;
  function queueSelectionUpdate() {
    clearTimeout(selTimer);
    selTimer = setTimeout(updateSelection, 180);
  }

  function updateSelection() {
    if (rewriteOpen) return;
    if (siteOff || !settings) {
      hideBubble();
      return;
    }
    const snap = readSelection() || (settings.bubbleEverywhere ? readPageSelection() : null);
    if (!snap || snap.text.trim().length < 4) {
      selSnap = null;
      hideBubble();
      return;
    }
    selSnap = snap;
    ensureUI();
    bubble.classList.remove('hidden');
    positionBubble();
  }

  // Selected text outside any editable field (reading text on a page). Copy-only results.
  function readPageSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!startEl || (host && host.contains(startEl))) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    return { st: null, readonly: true, range: range.cloneRange(), start: 0, end: 0, text };
  }

  function snapRect(snap) {
    if (snap.range) {
      const rects = snap.range.getClientRects();
      return rects.length ? rects[rects.length - 1] : snap.range.getBoundingClientRect();
    }
    return measureRange(snap.st, snap.start, snap.end);
  }

  // The current selection, whether it comes from the star, a shortcut, or the right-click menu.
  function ensureSnap() {
    if (rewriteOpen && selSnap) return selSnap;
    if (siteOff || !settings) return null;
    const s = readSelection() || readPageSelection();
    selSnap = s && s.text.trim() ? s : null;
    return selSnap;
  }

  function anchorRect() {
    if (bubble && !bubble.classList.contains('hidden')) {
      const b = bubble.getBoundingClientRect();
      if (b.width) return b;
    }
    const r = selSnap ? snapRect(selSnap) : null;
    return r ? { left: r.left, top: r.top, bottom: r.bottom } : { left: 20, top: 20, bottom: 40 };
  }

  function positionBubble() {
    if (!host || !selSnap || bubble.classList.contains('hidden')) return;
    const rect = snapRect(selSnap);
    if (!rect) {
      bubble.classList.add('hidden');
      return;
    }
    bubble.style.left = Math.min(rect.right + 4, window.innerWidth - 36) + 'px';
    bubble.style.top = Math.max(4, rect.top - 32) + 'px';
  }

  function hideBubble() {
    if (bubble) bubble.classList.add('hidden');
  }

  function openMenu() {
    if (!ensureSnap() || !host) return;
    ensureUI();
    hideBubble();
    rewriteOpen = true;
    card.classList.add('hidden');
    menu.replaceChildren(h('div', { class: 'sec' }, 'Rewrite'));
    for (const m of modes) {
      menu.append(h('div', { class: 'opt', onclick: () => runTask('rewrite', m.id) }, m.label));
    }
    menu.append(h('div', { class: 'sec' }, 'Translate to'));
    for (const lang of settings.targetLanguages || []) {
      menu.append(h('div', { class: 'opt', onclick: () => runTask('translate', lang) }, lang));
    }

    // Any other language: type it, pick a suggestion or press Enter.
    const other = h('input', { type: 'text', placeholder: 'Other language...', 'aria-label': 'Other language' });
    const sugg = h('div', null);
    const matches = () => {
      const q = other.value.trim().toLowerCase();
      return q ? commonLanguages.filter((l) => l.toLowerCase().startsWith(q)).slice(0, 5) : [];
    };
    const drawSugg = () => {
      sugg.replaceChildren(...matches().map((l) => h('div', { class: 'opt', onclick: () => runTask('translate', l) }, l)));
    };
    other.addEventListener('input', drawSugg);
    other.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') closeRewrite();
      if (e.key !== 'Enter') return;
      const typed = other.value.trim();
      if (!typed) return;
      const m = matches();
      const exact = m.find((l) => l.toLowerCase() === typed.toLowerCase());
      runTask('translate', exact || (m.length === 1 ? m[0] : typed));
    });
    menu.append(other, sugg);

    menu.append(h('div', { class: 'sec' }, 'Language'));
    menu.append(h('div', { class: 'opt', onclick: () => runTask('detect') }, 'Detect language'));
    const input = h('input', { type: 'text', placeholder: 'Or describe the change, then Enter' });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) runTask('rewrite', 'custom', input.value.trim());
      if (e.key === 'Escape') closeRewrite();
    });
    menu.append(input);
    menu.append(
      h('div', { class: 'foot' },
        h('div', null,
          h('button', {
            class: 'link',
            onclick: () => { closeRewrite(); send({ type: 'openOptions' }); }
          }, 'Settings'),
          ' \u00B7 ',
          supportButton('\u2665 Support')))
    );
    menu.classList.remove('hidden');
    placeNear(menu, anchorRect());
  }

  // kind: 'rewrite' (arg = mode id or 'custom'), 'translate' (arg = language), 'detect'.
  async function runTask(kind, arg, instruction) {
    const snap = ensureSnap();
    if (!snap) return;
    ensureUI();
    rewriteOpen = true;
    menu.classList.add('hidden');

    let label;
    let msg;
    let busy;
    if (kind === 'translate') {
      label = `Translate to ${arg}`;
      msg = { type: 'translate', text: snap.text, language: arg };
      busy = 'Translating...';
    } else if (kind === 'detect') {
      label = 'Detect language';
      msg = { type: 'detect', text: snap.text };
      busy = 'Detecting...';
    } else {
      label = arg === 'custom' ? 'Custom' : (modes.find((m) => m.id === arg) || {}).label || 'Rewrite';
      msg = { type: 'rewrite', text: snap.text, mode: arg, instruction };
      busy = 'Rewriting...';
    }
    const retry = () => runTask(kind, arg, instruction);
    const anchor = anchorRect();

    card.replaceChildren(
      h('h4', null, label),
      h('div', { class: 'muted' }, h('span', { class: 'spin' }), busy)
    );
    card.classList.remove('hidden');
    placeNear(card, anchor);

    const r = await send(msg);
    if (!rewriteOpen) return;

    if (!r.ok) {
      card.replaceChildren(
        h('h4', null, label),
        h('div', { class: 'err-text' }, ERROR_TEXT[r.error] || r.message || ERROR_TEXT.unknown),
        h('div', { class: 'row' },
          r.error === 'no_key' || r.error === 'invalid_key' || r.error === 'permission'
            ? h('button', { class: 'primary', onclick: () => send({ type: 'openOptions' }) }, 'Open settings')
            : h('button', { class: 'primary', onclick: retry }, 'Try again'),
          h('button', { onclick: closeRewrite }, 'Close')),
        h('div', { class: 'foot' }, supportButton())
      );
      placeNear(card, anchor);
      return;
    }

    const output = kind === 'detect' ? r.language : r.text;
    const rows = [h('h4', null, label)];
    if (kind === 'translate' && r.sourceLanguage) {
      rows.push(h('div', { class: 'muted gap' }, `Detected language: ${r.sourceLanguage}`));
    }
    rows.push(h('div', { class: 'result' }, output));

    const buttons = [];
    if (kind !== 'detect' && !snap.readonly) {
      buttons.push(h('button', {
        class: 'primary',
        onclick: () => {
          if (replaceSelection(snap, output)) closeRewrite();
          else card.querySelector('h4').textContent = 'The text changed. Select it again.';
        }
      }, 'Replace'));
    }
    buttons.push(h('button', { class: kind === 'detect' || snap.readonly ? 'primary' : '', onclick: (e) => copyText(output, e.target) }, 'Copy'));
    if (kind !== 'detect') buttons.push(h('button', { onclick: retry }, 'Try again'));
    buttons.push(h('button', { class: 'link', onclick: closeRewrite }, 'Close'));
    rows.push(h('div', { class: 'row' }, buttons));
    rows.push(h('div', { class: 'foot' }, supportButton()));

    card.replaceChildren(...rows);
    placeNear(card, anchor);
  }

  function replaceSelection(snap, newText) {
    const st = snap.st;
    if (!st) return false;
    const text = readText(st);
    let { start, end } = snap;
    if (text.slice(start, end) !== snap.text) {
      const i = text.indexOf(snap.text);
      if (i < 0) return false;
      start = i;
      end = i + snap.text.length;
    }
    return applyReplacement(st, start, end, newText);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
  }

  function closeRewrite() {
    rewriteOpen = false;
    if (menu) menu.classList.add('hidden');
    if (card) card.classList.add('hidden');
    queueSelectionUpdate();
  }

  // Quick actions: rewrite or translate without showing the result card, just apply directly.
  async function quickAction(kind, arg) {
    const snap = ensureSnap();
    if (!snap) return;

    let msg;
    if (kind === 'translate') {
      msg = { type: 'translate', text: snap.text, language: arg };
    } else {
      msg = { type: 'rewrite', text: snap.text, mode: arg };
    }

    const r = await send(msg);
    if (!r.ok) {
      showToast(`${ERROR_TEXT[r.error] || r.message || 'Failed'}`);
      return;
    }

    const result = kind === 'translate' ? r.text : r.text;
    if (snap.readonly) {
      try {
        await navigator.clipboard.writeText(result);
        showToast('✓ Copied to clipboard');
      } catch {
        showToast('Could not copy');
      }
      return;
    }

    if (replaceSelection(snap, result)) {
      showToast(`\u2713 ${kind === 'translate' ? 'Translated' : 'Rewritten'}`);
      if (snap.st) schedule(snap.st, 400);
    } else {
      showToast('The text changed. Select it again.');
    }
  }

  // Toast notification for quick actions
  function showToast(msg) {
    ensureUI();
    const t = h('div', { class: 'ui toast-msg' }, msg);
    shadow.append(t);
    setTimeout(() => t.remove(), 2000);
  }

  // ------------------------------------------------------------------ activation and events

  function setActive(st) {
    if (active === st) return;
    active = st;
    closePanel();
    closeTip();
    updateBadge();
  }

  function pathTarget(e) {
    return e.composedPath ? e.composedPath()[0] : e.target;
  }

  function isOurs(e) {
    return !!host && e.composedPath && e.composedPath().includes(host);
  }

  function onFocusIn(e) {
    if (siteOff || !settings || isOurs(e)) return;
    const el = editableRoot(pathTarget(e));
    if (!el || !eligible(el)) {
      setActive(null);
      return;
    }
    ensureUI();
    const st = getState(el);
    setActive(st);
    if (st.checkedText === null) {
      st.lastText = readText(st);
      schedule(st, 300);
    }
  }

  function onInput(e) {
    if (siteOff || !settings || isOurs(e)) return;
    const el = editableRoot(pathTarget(e));
    if (!el || !eligible(el)) return;
    ensureUI();
    const st = getState(el);
    setActive(st);
    const text = readText(st);
    adjustIssues(st, st.lastText, text);
    st.lastText = text;
    closeTip();
    renderIssues(st);
    schedule(st, settings.debounceMs);
  }

  function onMouseDown(e) {
    if (isOurs(e)) return;
    closeTip();
    closePanel();
    if (rewriteOpen) closeRewrite();
  }

  function onMouseUp(e) {
    if (siteOff || !settings || isOurs(e)) return;
    queueSelectionUpdate();
    const el = editableRoot(pathTarget(e));
    const st = el && states.get(el);
    if (!st || !st.issues.length) return;
    const x = e.clientX;
    const y = e.clientY;
    setTimeout(() => {
      const sel = st.kind === 'text' ? st.el.selectionStart !== st.el.selectionEnd : !window.getSelection().isCollapsed;
      if (sel) return;
      const hit = issueAtPoint(st, x, y);
      if (hit) showTip(st, hit);
    }, 0);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && host && !isOurs(e)) {
      closeTip();
      closePanel();
      if (rewriteOpen) closeRewrite();
    }
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', queueSelectionUpdate, true);
  document.addEventListener('selectionchange', queueSelectionUpdate);
  window.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition);

  // ------------------------------------------------------------------ extension messages

  api.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg && msg.type) {
      case 'getState':
        if (!active) return;
        respond({
          status: active.status,
          error: active.error,
          issues: active.issues.length,
          siteOff
        });
        return;
      case 'recheck':
        if (!active) return;
        runCheck(active, true);
        respond({ ok: true });
        return;
      case 'openRewriteMenu':
        openMenu();
        return;
      case 'rewriteWith':
        runTask('rewrite', msg.mode);
        return;
      case 'translateWith':
        runTask('translate', String(msg.language || ''));
        return;
      case 'detectWith':
        runTask('detect');
        return;
      case 'quickRewrite':
        quickAction('rewrite', msg.mode);
        return;
      case 'quickTranslate':
        quickAction('translate', msg.language);
        return;
      default:
    }
  });

  api.storage.onChanged.addListener(async (changes, area) => {
    const settingsChanged = area === 'sync' && changes.settings;
    const localChanged = area === 'local' &&
      (changes.apiKey || changes.customApiKey || changes.proxyUrl || changes.proxyToken ||
        changes.dictionary || changes.disabledSites);
    if (!settingsChanged && !localChanged) return;
    const prevSig = sig;
    await loadSettings();
    if (siteOff) {
      clearAll();
      return;
    }
    if (sig !== prevSig) cache.clear();
    if (active) {
      active.status = 'idle';
      active.error = null;
      runCheck(active, true);
    }
    updateBadge();
  });

  loadSettings().then(() => {
    // The user may already be focused in a field when the script loads.
    if (!siteOff && document.activeElement && document.activeElement !== document.body) {
      onFocusIn({ target: document.activeElement, composedPath: () => [document.activeElement] });
    }
  });
})();
