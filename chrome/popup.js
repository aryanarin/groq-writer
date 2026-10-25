// SPDX-License-Identifier: GPL-3.0-or-later
import {
  api, getSettings, saveSettings, resolveConnection, getApiKey, getCustomApiKey,
  getProxyUrl, getProxyToken,
  hostFromUrl, endpointHost, bugReportMailto, REWRITE_MODES
} from './shared.js';

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function connectionSummary(settings, conn) {
  if (!conn.configured) return 'Not connected yet.';
  if (conn.isGroq) return `Groq \u00B7 ${settings.checkModel || 'no model selected'}`;
  if (conn.isProxy) {
    return `Proxy \u00B7 ${endpointHost(conn.baseUrl) || 'Worker'} \u00B7 ${settings.checkModel || 'no model selected'}`;
  }
  return `${endpointHost(conn.baseUrl) || 'Custom endpoint'} \u00B7 ${settings.checkModel || 'no model selected'}`;
}

function keyNodes(shortcut) {
  if (!shortcut) return [document.createTextNode('not set')];
  const nodes = [];
  shortcut.split('+').map((p) => p.trim()).filter(Boolean).forEach((part, i) => {
    if (i) nodes.push(document.createTextNode('+'));
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    nodes.push(kbd);
  });
  return nodes;
}

async function renderHint(settings) {
  const hint = $('hint');
  hint.replaceChildren();
  const tone = (REWRITE_MODES.find((m) => m.id === settings.quickTone) || REWRITE_MODES[0]).label;
  let commands = [];
  try {
    commands = (await api.commands.getAll()) || [];
  } catch { /* shortcuts unavailable */ }
  const shortcut = (name) => (commands.find((c) => c.name === name) || {}).shortcut || '';

  const add = (text) => hint.append(text);
  add('Select text, then ');
  hint.append(...keyNodes(shortcut('tone-shortcut')));
  add(` for "${tone}", or `);
  hint.append(...keyNodes(shortcut('translate-shortcut')));
  add(` for ${settings.quickLanguage}. Right-click the selection for more.`);
}

async function init() {
  const [settings, apiKey, customApiKey, proxyUrl, proxyToken, tab] = await Promise.all([
    getSettings(), getApiKey(), getCustomApiKey(), getProxyUrl(), getProxyToken(), activeTab()
  ]);

  const conn = resolveConnection(settings, { apiKey, customApiKey, proxyUrl, proxyToken });
  const host = hostFromUrl(tab && tab.url);

  $('enabled').checked = settings.enabled;
  $('keyWarn').hidden = !!conn.configured;
  $('host').textContent = host || 'this page';
  $('connInfo').textContent = connectionSummary(settings, conn);
  $('connInfo').title = conn.baseUrl || '';

  const siteLine = $('siteOn').closest('.line');
  if (!host) {
    $('siteOn').disabled = true;
    $('siteOn').checked = false;
    siteLine.classList.add('disabled');
  } else {
    $('siteOn').checked = !settings.disabledSites.includes(host);
  }

  $('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));

  $('siteOn').addEventListener('change', async (e) => {
    const cur = await getSettings();
    const set = new Set(cur.disabledSites);
    if (e.target.checked) set.delete(host); else set.add(host);
    await saveSettings({ disabledSites: [...set] });
  });

  // The markup carries a plain mailto; this adds the version and browser to the report.
  $('reportBug').href = bugReportMailto(api.runtime.getManifest().version, navigator.userAgent);
  // Let the mail client take over, then get out of the way.
  $('reportBug').addEventListener('click', () => setTimeout(() => window.close(), 120));

  $('support').addEventListener('click', async () => {
    await api.tabs.create({ url: api.runtime.getURL('options.html#support') });
    window.close();
  });

  $('settings').addEventListener('click', () => api.runtime.openOptionsPage());
  $('openKey').addEventListener('click', () => api.runtime.openOptionsPage());
  $('shortcuts').addEventListener('click', async () => {
    await api.tabs.create({ url: api.runtime.getURL('options.html#shortcuts') });
    window.close();
  });

  $('recheck').addEventListener('click', async () => {
    if (!tab) return;
    try {
      const r = await api.tabs.sendMessage(tab.id, { type: 'recheck' });
      $('status').textContent = r && r.ok ? 'Checking...' : 'Click into a text box first';
    } catch {
      $('status').textContent = 'Click into a text box first';
    }
  });

  if (tab && host) {
    try {
      const st = await api.tabs.sendMessage(tab.id, { type: 'getState' });
      if (st) {
        const info = $('fieldInfo');
        info.hidden = false;
        info.textContent = st.issues
          ? `${st.issues} suggestion${st.issues === 1 ? '' : 's'} in the current field.`
          : st.status === 'ok' ? 'The current field looks good.' : 'Watching the current field.';
      }
    } catch { /* no content script on this page */ }
  }

  renderHint(settings);
}

init();
