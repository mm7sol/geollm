// Small key-value store: Upstash Redis (REST) when configured, in-memory otherwise.
// In-memory state lives per serverless instance only, so for real rate limiting
// and a shared cache, connect Upstash Redis (Vercel Marketplace) and set the env vars.

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
export const hasRedis = Boolean(URL_ && TOKEN);

const mem = new Map(); // key -> { v, exp }

function memGet(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; }
  return e.v;
}
function memSet(k, v, ttlSec) {
  if (mem.size > 5000) mem.delete(mem.keys().next().value); // crude bound
  mem.set(k, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

export async function cacheGet(key) {
  const m = memGet(key);
  if (m !== null) return m;
  if (!hasRedis) return null;
  try {
    const raw = await redis(['GET', key]);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    memSet(key, v, 300);
    return v;
  } catch { return null; }
}

export async function cacheSet(key, value, ttlSec) {
  memSet(key, value, ttlSec);
  if (!hasRedis) return;
  try { await redis(['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]); } catch {}
}

// Try to take a short-lived slot (used to keep Nominatim at 1 request/second
// across all instances). Returns true if the slot was free.
export async function takeSlot(key, ms) {
  if (hasRedis) {
    try { return (await redis(['SET', key, '1', 'NX', 'PX', String(ms)])) === 'OK'; } catch {}
  }
  if (memGet(key)) return false;
  mem.set(key, { v: 1, exp: Date.now() + ms });
  return true;
}

// Increment a counter that expires after ttlSec. Returns the new count.
export async function incr(key, ttlSec) {
  if (hasRedis) {
    try {
      const n = await redis(['INCR', key]);
      if (n === 1) await redis(['EXPIRE', key, String(ttlSec)]);
      return n;
    } catch { /* fall back to memory */ }
  }
  const n = (memGet(key) || 0) + 1;
  const e = mem.get(key);
  mem.set(key, { v: n, exp: e && e.exp ? e.exp : Date.now() + ttlSec * 1000 });
  return n;
}
