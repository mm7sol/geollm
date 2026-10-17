// Remote MCP server over Streamable HTTP (stateless): POST /api/mcp
// Exposes the same tools as /api/chat and mcp/server.mjs to any MCP client
// (Claude, Cursor, OpenCode, ...) by URL — no local install needed.
import { createHash } from 'node:crypto';
import { TOOLS, activeTools } from '../lib/tools.js';
import { incr } from '../lib/store.js';

const PROTOCOL = '2025-06-18';
const SERVER = { name: 'geollm-tools', version: '0.2.0' };
const LIMIT_PER_IP = Number(process.env.MCP_LIMIT_PER_IP || 300);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization',
  'Access-Control-Max-Age': '86400',
};

function toolList() {
  return activeTools().map(([name, t]) => ({ name, description: t.schema.description, inputSchema: t.schema.parameters }));
}

// Approximate caller location from Vercel's IP geolocation headers (used by user_location).
function clientGeo(req) {
  const h = (k) => { const v = req.headers[k]; if (!v) return null; try { return decodeURIComponent(String(v)); } catch { return String(v); } };
  const lat = Number(h('x-vercel-ip-latitude')), lon = Number(h('x-vercel-ip-longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon, city: h('x-vercel-ip-city'), region: h('x-vercel-ip-country-region'), country: h('x-vercel-ip-country') };
}

// Returns a JSON-RPC response object, or null for notifications (which get no reply).
async function handle(msg, ctx) {
  const { id, method, params = {} } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification, e.g. notifications/initialized
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } }, serverInfo: SERVER });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call': {
      const name = params.name, known = activeTools().some(([n]) => n === name);
      if (!known) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const out = await TOOLS[name].run(params.arguments || {}, ctx);
        return reply({ content: [{ type: 'text', text: JSON.stringify({ ...out.data, _source: out.source }) }], structuredContent: out.data, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET') {
    // Stateless mode: no server-initiated SSE stream, so GET is not offered.
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(405).end(JSON.stringify({ error: 'method_not_allowed', message: 'Stateless MCP endpoint. POST JSON-RPC messages here.' }));
    return;
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); res.status(405).end(); return; }

  // ---- rate limit (IP is hashed, never stored raw) ----
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT || 'geollm';
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ipHash = createHash('sha256').update(salt + ip).digest('hex').slice(0, 24);
  const used = await incr(`mcpl:${day}:${ipHash}`, 86400);
  if (used > LIMIT_PER_IP) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Retry-After', '3600');
    res.status(429).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit reached. Try again later.' } }));
    return;
  }

  // ---- parse (single message or batch) ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(400).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const ctx = { geo: clientGeo(req) };
  const replies = (await Promise.all(messages.map((m) => handle(m, ctx).catch((e) => ({ jsonrpc: '2.0', id: m && m.id, error: { code: -32603, message: e.message } }))))).filter(Boolean);

  if (!replies.length) { res.status(202).end(); return; } // only notifications
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(JSON.stringify(batch ? replies : replies[0]));
}
