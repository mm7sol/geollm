// POST /api/chat  { question }  ->  { text, tool, sources, points, zoom, route, image }
import { createHash } from 'node:crypto';
import { runAgent, UpstreamError } from '../lib/agent.js';
import { activeTools } from '../lib/tools.js';
import { cacheGet, cacheSet, incr } from '../lib/store.js';

const PER_IP_DAILY = Number(process.env.DAILY_LIMIT_PER_IP || 10);
const GLOBAL_DAILY = Number(process.env.DAILY_LIMIT_GLOBAL || 500);
const MAX_LEN = 200;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function send(res, status, body, extra = {}) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

// Approximate visitor location from Vercel's IP geolocation headers (only used by the user_location tool).
function clientGeo(req) {
  const h = (k) => { const v = req.headers[k]; if (!v) return null; try { return decodeURIComponent(String(v)); } catch { return String(v); } };
  const lat = Number(h('x-vercel-ip-latitude')), lon = Number(h('x-vercel-ip-longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon, city: h('x-vercel-ip-city'), region: h('x-vercel-ip-country-region'), country: h('x-vercel-ip-country') };
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export default async function handler(req, res) {
  // GET lists the tools that are switched on, so the page can label them honestly.
  if (req.method === 'GET') return send(res, 200, { tools: activeTools().map(([n]) => n) });
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'Use GET or POST.' }, { Allow: 'GET, POST' });

  const origin = req.headers.origin;
  if (ALLOWED.length && origin && !ALLOWED.includes(origin)) {
    return send(res, 403, { error: 'forbidden', message: 'This API only serves the GeoLLM site.' });
  }

  // ---- validate input ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const raw = body && typeof body.question === 'string' ? body.question : '';
  // strip control characters, collapse whitespace
  const question = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!question) return send(res, 400, { error: 'empty', message: 'Type a question first.' });
  if (question.length > MAX_LEN) return send(res, 400, { error: 'too_long', message: `Keep it under ${MAX_LEN} characters.` });

  // ---- answer cache (identical questions within 10 min don't cost a model call or quota) ----
  const qKey = 'ans:' + createHash('sha256').update(question.toLowerCase()).digest('hex').slice(0, 32);
  const cached = await cacheGet(qKey);
  if (cached) return send(res, 200, { ...cached, cached: true });

  // ---- rate limits (IP is hashed, never stored raw) ----
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT || 'geollm';
  const ipHash = createHash('sha256').update(salt + clientIp(req)).digest('hex').slice(0, 24);
  const used = await incr(`rl:${day}:${ipHash}`, 86400);
  if (used > PER_IP_DAILY) {
    return send(res, 429, { error: 'limit', message: `Daily limit reached (${PER_IP_DAILY} questions). Come back tomorrow.` }, { 'Retry-After': '3600' });
  }
  const total = await incr(`rl:${day}:all`, 86400);
  if (total > GLOBAL_DAILY) {
    return send(res, 429, { error: 'global_limit', message: 'GeoLLM has hit its daily budget. Try again tomorrow.' }, { 'Retry-After': '3600' });
  }

  // ---- run the agent ----
  try {
    const out = await runAgent(question, { geo: clientGeo(req) });
    const payload = { text: out.text, tool: out.tool, sources: out.sources, points: out.points, zoom: out.zoom, route: out.route, image: out.image,
      remaining: Math.max(0, PER_IP_DAILY - used) };
    // live or personal answers (aircraft, ships, "near me") are cached briefly or not at all
    if (out.tool && out.answerTtl > 0) await cacheSet(qKey, { ...payload, remaining: undefined }, out.answerTtl);
    return send(res, 200, payload);
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.error('[model]', e.kind, e.message);
      const msg = {
        busy: 'The model is busy right now. Try again in a minute.',
        credits: 'The model is unavailable (budget reached). Try again later.',
        config: 'The server is not configured yet.',
        unavailable: 'The model is unavailable right now. Try again in a minute.',
      }[e.kind];
      return send(res, 503, { error: 'model_unavailable', message: msg });
    }
    console.error(e);
    return send(res, 500, { error: 'server', message: 'Something went wrong on our side.' });
  }
}

