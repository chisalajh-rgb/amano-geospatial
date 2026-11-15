// The AI server: origin allow-list, access code, model allow-list, forwarding.
import worker from '../proxy/worker.js';
const env = { ANTHROPIC_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://amanogeospatial.com, https://chisalajh-rgb.github.io', ACCESS_CODE: 'abc' };
let sent = null;
globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }), { status: 200 }); };
const call = (o = {}) => worker.fetch(new Request('https://x.workers.dev/', { method: o.method || 'POST', headers: { Origin: o.origin ?? 'https://amanogeospatial.com', 'x-amano-access': o.code ?? 'abc', 'content-type': 'application/json' }, body: o.method === 'OPTIONS' ? undefined : JSON.stringify(o.body || { model: 'claude-sonnet-5-5', max_tokens: 99999, system: 's', messages: [{ role: 'user', content: 'hi' }], extra: 1 }) }), o.env || env);
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: got ${a}, want ${b}`); };
eq((await call({ method: 'OPTIONS' })).status, 204, 'preflight');
eq((await call({ origin: 'https://evil.example' })).status, 403, 'bad origin');
eq((await call({ code: 'nope' })).status, 401, 'bad code');
eq((await call({ body: { model: 'other', messages: [{}] } })).status, 400, 'bad model');
const ok = await call();
eq(ok.status, 200, 'ok'); eq(ok.headers.get('Access-Control-Allow-Origin'), 'https://amanogeospatial.com', 'cors');
const fwd = JSON.parse(sent.init.body);
eq(sent.init.headers['x-api-key'], 'test-key', 'key'); eq(fwd.max_tokens, 8000, 'cap'); eq(fwd.extra, undefined, 'strip');
eq((await call({ env: { ...env, ANTHROPIC_API_KEY: '' } })).status, 500, 'no key');
console.log('OK');
