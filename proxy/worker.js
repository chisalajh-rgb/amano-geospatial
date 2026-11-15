// Amano AI server — a Cloudflare Worker that holds the Anthropic API key so visitors to the
// app do not need their own. It only forwards map-reading requests from the allowed sites.
//
// Secrets and settings (set in the Cloudflare dashboard, never in this file):
//   ANTHROPIC_API_KEY  (secret)  your Anthropic key
//   ALLOWED_ORIGINS    (text)    comma-separated sites, e.g. https://amanogeospatial.com,https://chisalajh-rgb.github.io
//   ACCESS_CODE        (secret, optional)  if set, users must enter this code in the app's Settings

const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const MAX_TOKENS = 8000;
const MAX_BODY = 12 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-amano-access',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const fail = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return fail(405, 'Use POST.');
    if (!okOrigin) return fail(403, 'This site is not allowed to use the Amano server.');
    if (env.ACCESS_CODE && request.headers.get('x-amano-access') !== env.ACCESS_CODE) return fail(401, 'Access code missing or wrong.');
    if (!env.ANTHROPIC_API_KEY) return fail(500, 'The server has no API key configured.');
    const raw = await request.text();
    if (raw.length > MAX_BODY) return fail(413, 'Request too large.');
    let body;
    try { body = JSON.parse(raw); } catch { return fail(400, 'Request is not valid JSON.'); }
    if (!MODELS.includes(body.model)) return fail(400, 'Model not allowed.');
    if (!Array.isArray(body.messages) || body.messages.length !== 1) return fail(400, 'Unexpected request shape.');
    // Forward only the fields the app uses.
    const clean = { model: body.model, max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS), system: String(body.system || ''), messages: body.messages };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(clean),
    });
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'content-type': 'application/json' } });
  },
};
