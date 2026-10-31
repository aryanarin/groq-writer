// SPDX-License-Identifier: GPL-3.0-or-later
// Shared constants and storage helpers (ES module).
// Used by the background worker, popup and options page.
// The content script cannot import modules, so it asks the background for settings.
//
// Firefox exposes promise-based APIs under `browser` and callback-based APIs under
// `chrome`; Chrome exposes promises under `chrome` (and, in recent versions, `browser`).
// Picking the namespace once keeps every call promise-based in both browsers.
export const api = globalThis.browser ?? globalThis.chrome;

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GITHUB_URL = 'https://github.com/aryanarin/fluenttext';
export const ISSUES_URL = GITHUB_URL + '/issues';

// Paste-ready providers. Only the endpoint and suggested models change; every one
// speaks the OpenAI chat-completions format.
export const PROVIDER_PRESETS = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: GROQ_BASE_URL,
    auth: 'bearer',
    checkModel: 'openai/gpt-oss-20b',
    rewriteModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    checkModel: 'gpt-5-mini',
    rewriteModel: 'gpt-5',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    checkModel: 'openai/gpt-5-mini',
    rewriteModel: 'openai/gpt-5',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'bearer',
    checkModel: 'mistral-small-latest',
    rewriteModel: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    auth: 'none',
    checkModel: 'llama3.2',
    rewriteModel: 'llama3.2',
    keyUrl: ''
  },
  {
    id: 'proxy',
    label: 'Cloudflare Worker / proxy',
    baseUrl: '',
    auth: 'bearer',
    checkModel: 'openai/gpt-oss-20b',
    rewriteModel: 'openai/gpt-oss-120b',
    keyUrl: ''
  },
  {
    id: 'custom',
    label: 'Custom / other',
    baseUrl: '',
    auth: 'bearer',
    checkModel: '',
    rewriteModel: '',
    keyUrl: ''
  }
];

export const AUTH_HEADERS = [
  ['bearer', 'Authorization: Bearer <key>'],
  ['x-api-key', 'x-api-key: <key>'],
  ['api-key', 'api-key: <key>'],
  ['none', 'No authentication']
];

export const DEFAULTS = {
  enabled: true,
  language: 'en-US',
  provider: 'groq',
  customBaseUrl: '',
  customAuth: 'bearer',
  // Groq retires models regularly. These are the defaults at the time of writing;
  // the options page can load the live model list from your account.
  checkModel: 'openai/gpt-oss-20b',
  rewriteModel: 'openai/gpt-oss-120b',
  targetLanguages: ['English', 'German'],
  translateTone: 'formal',
  quickTone: 'formal',
  quickLanguage: 'German',
  bubbleEverywhere: false,
  categories: {
    spelling: true,
    grammar: true,
    punctuation: true,
    clarity: true,
    style: false
  },
  debounceMs: 900,
  showBadge: true,
  // Kept in local storage, not sync: they can grow past sync's per-item quota.
  disabledSites: [],
  dictionary: []
};

export const CATEGORY_INFO = {
  spelling: 'Misspelled words and typos.',
  grammar: 'Grammar mistakes: agreement, tense, articles, prepositions, wrong word choice.',
  punctuation: 'Missing, extra, or misplaced punctuation and capitalization.',
  clarity: 'Awkward, wordy, or confusing phrasing, but only when a clearly better phrasing exists.',
  style: 'Tone and style polish (repetition, overly casual phrasing), only when clearly worthwhile.'
};

export const CATEGORY_IDS = Object.keys(CATEGORY_INFO);

export const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-CA', 'English (Canada)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
  ['auto', 'Auto-detect (any language)']
];

export const REWRITE_MODES = [
  { id: 'improve', label: 'Improve writing', prompt: 'Improve the writing: fix errors, tighten wording, and make it flow better while keeping the same meaning and voice.' },
  { id: 'fix', label: 'Fix grammar & spelling', prompt: 'Fix only spelling, grammar, and punctuation errors. Do not change wording or style otherwise.' },
  { id: 'shorten', label: 'Make shorter', prompt: 'Make the text noticeably shorter and more concise without losing key information.' },
  { id: 'expand', label: 'Make longer', prompt: 'Expand the text with a little more detail and context while keeping the same meaning and tone.' },
  { id: 'paraphrase', label: 'Paraphrase', prompt: 'Paraphrase the text using different wording while keeping the exact meaning.' },
  { id: 'formal', label: 'More formal', prompt: 'Rewrite the text in a formal, professional tone.' },
  { id: 'friendly', label: 'More friendly', prompt: 'Rewrite the text in a warm, friendly, approachable tone.' },
  { id: 'confident', label: 'More confident', prompt: 'Rewrite the text to sound confident and direct, removing hedging and filler.' }
];

const AUTH_IDS = new Set(AUTH_HEADERS.map(([id]) => id));
const LANGUAGE_IDS = new Set(LANGUAGES.map(([id]) => id));
const MODE_IDS = new Set(REWRITE_MODES.map((m) => m.id));
const PROVIDER_IDS = new Set(['groq', 'proxy', 'custom']);

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanLanguageName(value, fallback) {
  const v = cleanString(value, 40);
  return v || fallback;
}

function listOf(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const v = cleanString(item, maxLength);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function siteList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    let v = cleanString(item, 253).toLowerCase();
    v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:?#].*$/, '');
    if (!v || !/^[a-z0-9.-]+$/.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 1000) break;
  }
  return out;
}

function normalize(s) {
  const src = s && typeof s === 'object' ? s : {};
  const categories = {};
  for (const id of CATEGORY_IDS) {
    categories[id] = src.categories && typeof src.categories === 'object'
      ? !!src.categories[id]
      : DEFAULTS.categories[id];
  }
  const provider = PROVIDER_IDS.has(src.provider) ? src.provider : DEFAULTS.provider;
  const modelValue = (value, fallback) =>
    typeof value === 'string' ? cleanString(value, 200) : fallback;
  return {
    ...DEFAULTS,
    ...src,
    enabled: src.enabled !== false,
    language: LANGUAGE_IDS.has(src.language) ? src.language : DEFAULTS.language,
    provider,
    customBaseUrl: cleanString(src.customBaseUrl, 2048),
    customAuth: AUTH_IDS.has(src.customAuth) ? src.customAuth : DEFAULTS.customAuth,
    checkModel: modelValue(src.checkModel, DEFAULTS.checkModel),
    rewriteModel: modelValue(src.rewriteModel, DEFAULTS.rewriteModel),
    targetLanguages: Array.isArray(src.targetLanguages)
      ? listOf(src.targetLanguages, 12, 40)
      : [...DEFAULTS.targetLanguages],
    translateTone: src.translateTone === 'neutral' ? 'neutral' : 'formal',
    quickTone: MODE_IDS.has(src.quickTone) ? src.quickTone : DEFAULTS.quickTone,
    quickLanguage: cleanLanguageName(src.quickLanguage, DEFAULTS.quickLanguage),
    bubbleEverywhere: !!src.bubbleEverywhere,
    categories,
    debounceMs: Number.isFinite(Number(src.debounceMs))
      ? Math.min(3000, Math.max(400, Number(src.debounceMs)))
      : DEFAULTS.debounceMs,
    showBadge: src.showBadge !== false,
    dictionary: listOf(src.dictionary, 400, 60),
    disabledSites: siteList(src.disabledSites)
  };
}

export async function getSettings() {
  const [syncStore, localStore] = await Promise.all([
    api.storage.sync.get('settings'),
    api.storage.local.get(['dictionary', 'disabledSites'])
  ]);
  const raw = syncStore && syncStore.settings && typeof syncStore.settings === 'object'
    ? syncStore.settings
    : {};
  // Lists moved to local storage so they cannot exceed sync's per-item quota.
  const merged = { ...raw };
  if (Array.isArray(localStore && localStore.dictionary)) merged.dictionary = localStore.dictionary;
  if (Array.isArray(localStore && localStore.disabledSites)) merged.disabledSites = localStore.disabledSites;
  return normalize(merged);
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = normalize({
    ...cur,
    ...patch,
    categories: { ...cur.categories, ...((patch && patch.categories) || {}) }
  });

  const syncSettings = { ...next };
  delete syncSettings.dictionary;
  delete syncSettings.disabledSites;

  const writes = [api.storage.sync.set({ settings: syncSettings })];
  const localPatch = {};
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'dictionary')) {
    localPatch.dictionary = next.dictionary;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'disabledSites')) {
    localPatch.disabledSites = next.disabledSites;
  }
  if (Object.keys(localPatch).length) writes.push(api.storage.local.set(localPatch));
  await Promise.all(writes);
  return next;
}

// The API keys live in local storage only (never synced to other devices).
export async function getApiKey() {
  const { apiKey } = await api.storage.local.get('apiKey');
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

export async function setApiKey(key) {
  await api.storage.local.set({ apiKey: String(key || '').trim() });
}

export async function getCustomApiKey() {
  const { customApiKey } = await api.storage.local.get('customApiKey');
  return typeof customApiKey === 'string' ? customApiKey.trim() : '';
}

export async function setCustomApiKey(key) {
  await api.storage.local.set({ customApiKey: String(key || '').trim() });
}

// The proxy URL and its optional token live in local storage, never synced:
// a Worker URL can itself be a capability, and the token is a secret.
export async function getProxyUrl() {
  const { proxyUrl } = await api.storage.local.get('proxyUrl');
  return typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
}

export async function setProxyUrl(url) {
  await api.storage.local.set({ proxyUrl: String(url || '').trim() });
}

export async function getProxyToken() {
  const { proxyToken } = await api.storage.local.get('proxyToken');
  return typeof proxyToken === 'string' ? proxyToken.trim() : '';
}

export async function setProxyToken(token) {
  await api.storage.local.set({ proxyToken: String(token || '').trim() });
}

// Where an API request should go, and how it should be authenticated.
// A Worker receives the request at exactly the URL given, so the usual
// /chat/completions suffix is not appended for it.
export function resolveConnection(settings, {
  apiKey = '', customApiKey = '', proxyUrl = '', proxyToken = ''
} = {}) {
  if (settings.provider === 'proxy') {
    const baseUrl = String(proxyUrl || '').trim();
    const token = String(proxyToken || '').trim();
    return {
      isGroq: false,
      isProxy: true,
      baseUrl,
      auth: token ? 'bearer' : 'none',
      apiKey: token,
      configured: !!baseUrl && isValidEndpointUrl(baseUrl)
    };
  }

  const custom = settings.provider === 'custom';
  const baseUrl = custom ? (settings.customBaseUrl || '').trim() : GROQ_BASE_URL;
  const auth = custom ? settings.customAuth : 'bearer';
  const key = (custom ? customApiKey : apiKey || '').trim();
  return {
    isGroq: !custom,
    isProxy: false,
    baseUrl,
    auth,
    apiKey: key,
    configured: custom ? !!baseUrl : !!key
  };
}

export function isValidEndpointUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

// Host permission patterns have no port, so one origin pattern covers every port.
export function originPatternFor(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return '';
  }
}

export function endpointHost(value) {
  try {
    return new URL(String(value || '').trim()).hostname;
  } catch {
    return '';
  }
}

export function chatEndpointFor(baseUrl) {
  try {
    const u = new URL(String(baseUrl || '').trim());
    if (!/\/chat\/completions\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/chat/completions';
    }
    return u.toString();
  } catch {
    return '';
  }
}

export function modelsEndpointFor(baseUrl) {
  const chat = chatEndpointFor(baseUrl);
  if (!chat) return '';
  try {
    const u = new URL(chat);
    u.pathname = u.pathname.replace(/\/chat\/completions\/?$/i, '/models');
    u.search = '';
    return u.toString();
  } catch {
    return '';
  }
}

// Languages offered under "More languages" and as suggestions in the star menu.
// Any other language can still be typed in by hand.
export const COMMON_LANGUAGES = [
  'Arabic', 'Bengali', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Czech', 'Danish', 'Dutch',
  'English', 'Finnish', 'French', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian',
  'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Korean', 'Malay', 'Malayalam', 'Marathi',
  'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Spanish',
  'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese'
];

// ---- Project contact and support (same details as SN Commands / SN Assignflow) ----
// Bug reports go out as a mailto:, so nothing is ever sent to a server this project controls.
export const CONTACT_EMAIL = 'contact@davagni.eu.org';
export const KOFI_URL = 'https://ko-fi.com/ysaryan';
export const UPI_ID = 'ysaryanraj@okaxis';

export function bugReportMailto(version, userAgent) {
  const v = version || 'unknown';
  const body =
    'What happened\n\n\n' +
    'What I expected instead\n\n\n' +
    'Steps to reproduce\n' +
    '1. \n2. \n3. \n\n' +
    '--- details below help a great deal, please leave them in ---\n' +
    'FluentText: ' + v + '\n' +
    'Browser: ' + (userAgent || 'unknown') + '\n' +
    'Where it happened (website, text box, or rich editor): \n' +
    'Connection (Groq, a proxy, or a custom endpoint): \n';
  return 'mailto:' + CONTACT_EMAIL +
    '?subject=' + encodeURIComponent('FluentText \u2014 bug report (v' + v + ')') +
    '&body=' + encodeURIComponent(body);
}

export function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch {
    return '';
  }
}
