// SPDX-License-Identifier: GPL-3.0-or-later
//
// Example Cloudflare Worker for Groq Writer.
//
// It receives the extension's chat-completion requests, adds your API key, and forwards
// them to Groq. The key lives only in Cloudflare, never in the browser.
//
// Environment variables (set in the Cloudflare dashboard, not in code):
//   API_KEY       Your Groq API key (store as a Secret)
//   API_ENDPOINT  https://api.groq.com/openai/v1/chat/completions
//   API_MODEL     Optional fallback model, used only when a request names none.
//                 Groq Writer always names a model, so this matters for other clients.
//   PROXY_TOKEN   Optional. When set, requests must send "Authorization: Bearer <token>".
//                 Use a long random value and paste the same value into the Proxy token
//                 field in Groq Writer (Provider: Cloudflare Worker / proxy).
//
// SECURITY: without PROXY_TOKEN this Worker has no authentication. Anyone who learns its
// URL can spend your key. Keep the URL private, set a spend limit with your provider, and
// set PROXY_TOKEN before sharing or publishing the URL.
//
// Deploy: Workers & Pages > Create Worker > Edit code > paste this file > Deploy.
// Or:     wrangler deploy docs/cloudflare-worker.example.js --name groq-writer-proxy

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }
    if (env.PROXY_TOKEN) {
      const header = request.headers.get('Authorization') || '';
      const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (given !== env.PROXY_TOKEN) {
        return json({ error: 'Invalid proxy token' }, 401);
      }
    }

    try {
      const body = await request.json();
      if (!body.model) body.model = env.API_MODEL || 'openai/gpt-oss-20b';

      const upstream = await fetch(env.API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.API_KEY}`
        },
        body: JSON.stringify(body)
      });

      // Pass the answer (and rate-limit hints) straight back to the extension.
      const headers = {
        ...corsHeaders(),
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json'
      };
      const retryAfter = upstream.headers.get('Retry-After');
      if (retryAfter) headers['Retry-After'] = retryAfter;

      return new Response(await upstream.text(), { status: upstream.status, headers });
    } catch (err) {
      return json({ error: 'Proxy error: ' + err.message }, 500);
    }
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Retry-After'
  };
}
