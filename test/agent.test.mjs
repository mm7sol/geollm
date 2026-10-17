// Offline test: mocks the model and every data API (Nominatim, Open-Meteo, Valhalla,
// Earth Search, adsb.lol, Overpass, AISStream), then runs questions through the real handler.
// Run: npm test
import assert from 'node:assert/strict';

process.env.OPENROUTER_API_KEY = 'test';
process.env.DAILY_LIMIT_PER_IP = '3';
process.env.AIS_WAIT_MS = '300';
delete process.env.AISSTREAM_API_KEY;
let seq = [], lastBody = null, overpassBodies = [];

function enc6(points) { // polyline6 encoder (for the fake Valhalla answer)
  let out = '', pl = 0, pn = 0;
  const e = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of points) { const a = Math.round(la * 1e6), b = Math.round(lo * 1e6); out += e(a - pl) + e(b - pn); pl = a; pn = b; }
  return out;
}

let modelTurn = 0, mode = 'ok', nominatimCalls = 0;
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [
  [call('1', 'geocode', { query: 'Nice' }), call('2', 'geocode', { query: 'Marseille' })],
  [call('3', 'get_route', { from_lat: 43.7, from_lon: 7.27, to_lat: 43.3, to_lon: 5.37, from_name: 'Nice', to_name: 'Marseille' }),
   call('4', 'get_weather', { lat: 43.3, lon: 5.37, place_name: 'Marseille' })],
  null,
];

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if (url.includes('openrouter.ai')) {
    if (mode === 'busy') return json({ error: { message: 'rate limited' } }, 429);
    const body = JSON.parse(opts.body);
    assert.ok(Array.isArray(body.models) && body.models.length >= 2, 'fallback models sent');
    lastBody = body;
    if (mode === 'seq') {
      const toolsSoFar = body.messages.filter((m) => m.role === 'assistant').length;
      const step = seq[toolsSoFar];
      if (Array.isArray(step)) return json({ choices: [{ message: { content: null, tool_calls: step } }] });
      return json({ choices: [{ message: { content: step } }] });
    }
    assert.ok(body.tools.length >= 11, 'all keyless tools offered');
    if (mode === 'sat') {
      const done = body.messages.some((m) => m.role === 'tool' && m.name === 'search_satellite_images');
      const geo = body.messages.some((m) => m.role === 'tool' && m.name === 'geocode');
      if (!geo) return json({ choices: [{ message: { content: null, tool_calls: [call('s1', 'geocode', { query: 'Ilulissat' })] } }] });
      if (!done) return json({ choices: [{ message: { content: null, tool_calls: [call('s2', 'search_satellite_images', { lat: 69.22, lon: -51.1, place_name: 'Ilulissat' })] } }] });
      return json({ choices: [{ message: { content: 'Latest clear Sentinel-2 image of Ilulissat: 2026-10-12, 4% cloud.' } }] });
    }
    const step = script[modelTurn++ % 3];
    if (step) return json({ model: body.models[0], choices: [{ message: { role: 'assistant', content: null, tool_calls: step } }] });
    const toolMsgs = body.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 4, 'model saw all 4 tool results');
    return json({ model: body.models[0], choices: [{ message: { role: 'assistant', content: 'Nice to Marseille is about 200 km, 2 h 10 by car. Marseille: 19 °C and sunny.' } }] });
  }
  if (url.includes('nominatim')) {
    nominatimCalls++;
    assert.match(opts.headers['User-Agent'], /GeoLLM/);
    const q = new URL(url).searchParams.get('q');
    const p = q === 'Nice' ? { lat: '43.7', lon: '7.27' } : { lat: '43.3', lon: '5.37' };
    return json([{ ...p, name: q, display_name: q + ', France', type: 'city', address: { country: 'France' } }]);
  }
  if (url.includes('api.open-meteo.com')) {
    return json({ timezone: 'Europe/Paris', utc_offset_seconds: 7200,
      current: { time: '2026-10-16T14:00', temperature_2m: 19.2, apparent_temperature: 18, relative_humidity_2m: 60, precipitation: 0, weather_code: 0, wind_speed_10m: 12, wind_direction_10m: 320 },
      daily: { time: ['2026-10-16'], weather_code: [1], temperature_2m_max: [21], temperature_2m_min: [13], precipitation_sum: [0], sunrise: ['2026-10-16T08:05'], sunset: ['2026-10-16T19:00'] } });
  }
  if (url.includes('earth-search')) {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.collections, ['sentinel-2-l2a']);
    assert.equal(body.query['eo:cloud_cover'].lt, 20);
    return json({ features: [
      { id: 'S2B_22WEC_20261012_0_L2A', properties: { datetime: '2026-10-12T15:10:00Z', 'eo:cloud_cover': 4.2 }, assets: { thumbnail: { href: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/x/preview.jpg' } } },
      { id: 'S2A_22WEC_20261005_0_L2A', properties: { datetime: '2026-10-05T15:10:00Z', 'eo:cloud_cover': 11 }, assets: {} } ] });
  }
  if (url.includes('api.adsb.lol')) {
    assert.match(opts.headers['User-Agent'], /GeoLLM/);
    if (url.includes('/v2/callsign/')) return json({ ac: url.endsWith('/AFR123') ? [{ hex: '39ac45', flight: 'AFR123  ', r: 'F-GKXA', t: 'A320', lat: 47.1, lon: 1.9, alt_baro: 35000, gs: 450, track: 200, seen_pos: 1 }] : [] });
    assert.match(url, /\/v2\/lat\/48\.857\/lon\/2\.352\/dist\/27$/);
    return json({ ac: [
      { hex: 'a1', flight: 'AFR1234 ', t: 'A321', r: 'F-GTAZ', lat: 49.0, lon: 2.55, alt_baro: 34120, gs: 430, track: 225, seen_pos: 2 },
      { hex: 'a2', flight: 'EZY12   ', t: 'A320', lat: 48.9, lon: 2.4, alt_baro: 'ground', gs: 12, track: 90 },
      { hex: 'a3', lat: null, lon: null } ] });
  }
  if (url.includes('overpass')) {
    const q = decodeURIComponent(opts.body.replace(/^data=/, ''));
    overpassBodies.push(q);
    return json({ elements: [
      { type: 'count', tags: { total: '37' } },
      { type: 'node', lat: 48.8611, lon: 2.3370, tags: { name: 'Café Marly' } },
      { type: 'way', center: { lat: 48.8625, lon: 2.3355 }, tags: { name: 'Le Fumoir' } },
      { type: 'node', lat: 48.8600, lon: 2.3390, tags: {} } ] });
  }
  if (url.includes('valhalla')) {
    return json({ trip: { summary: { length: 199.6, time: 7800 }, legs: [{ shape: enc6([[43.7, 7.27], [43.55, 6.5], [43.3, 5.37]]) }] } });
  }
  throw new Error('unexpected fetch ' + url);
};

// Fake WebSocket for AISStream (Node 22 has a global WebSocket; we replace it).
let aisSubs = [];
globalThis.WebSocket = class {
  constructor(u) { assert.equal(u, 'wss://stream.aisstream.io/v0/stream'); setTimeout(() => this.onopen && this.onopen(), 5); }
  send(m) {
    const sub = JSON.parse(m); aisSubs.push(sub);
    const emit = (o) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(o) }), 10);
    emit({ MessageType: 'PositionReport', MetaData: { MMSI: 244660000, ShipName: 'EVER ACE   ', latitude: 51.95, longitude: 4.05 },
      Message: { PositionReport: { Latitude: 51.95, Longitude: 4.05, Sog: 11.2, Cog: 270.4, TrueHeading: 269, UserID: 244660000 } } });
    emit({ MessageType: 'StandardClassBPositionReport', MetaData: { MMSI: 244000111, ShipName: '', latitude: 51.92, longitude: 4.3 },
      Message: { StandardClassBPositionReport: { Latitude: 51.92, Longitude: 4.3, Sog: 0, Cog: 0, TrueHeading: 511 } } });
  }
  close() { this.onclose && this.onclose(); }
};

const { default: handler } = await import('../api/chat.js');

function fakeRes() {
  const r = { code: 0, headers: {}, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (s) => { r.body = JSON.parse(s); };
  return r;
}
const req = (question, ip = '1.2.3.4', extra = {}) => ({ method: 'POST', headers: { 'x-forwarded-for': ip, ...extra }, body: { question } });
const toolResult = (name) => JSON.parse(lastBody.messages.filter((m) => m.role === 'tool' && m.name === name).pop().content);

// 1. multi-tool chain
let t0 = Date.now();
let res = fakeRes(); await handler(req('Drive Nice to Marseille + weather'), res);
assert.equal(res.code, 200, JSON.stringify(res.body));
const b = res.body;
assert.match(b.tool, /nominatim.*→.*nominatim.*→.*valhalla.*→.*open-meteo/);
assert.deepEqual(b.sources.sort(), ['Open-Meteo', 'OpenStreetMap / Nominatim', 'Valhalla (FOSSGIS) / OpenStreetMap']);
assert.equal(b.points.length, 2, 'Marseille pin merged');
assert.ok(b.points.some((p) => /19°C/.test(p[2])), 'weather label wins');
assert.equal(b.route.length, 3);
assert.ok(b.zoom > 1 && b.zoom <= 5);
assert.equal(b.remaining, 2);
assert.ok(Date.now() - t0 >= 1000, 'second Nominatim call waited ~1 s');
console.log('✓ multi-tool chain:', b.text, '| zoom', b.zoom, '|', b.tool);

// 2. same question again -> answer cache, no quota used, no new Nominatim call
const before = nominatimCalls;
res = fakeRes(); await handler(req('drive nice to marseille + weather'), res);
assert.equal(res.code, 200); assert.equal(res.body.cached, true); assert.equal(nominatimCalls, before);
console.log('✓ answer cache');

// 3. validation
res = fakeRes(); await handler(req(''), res); assert.equal(res.code, 400);
res = fakeRes(); await handler(req('x'.repeat(201)), res); assert.equal(res.code, 400);
res = fakeRes(); await handler({ method: 'DELETE', headers: {} }, res); assert.equal(res.code, 405);
console.log('✓ validation');

// 4. model busy -> 503 with clear message
mode = 'busy';
res = fakeRes(); await handler(req('weather in Nuuk'), res);
assert.equal(res.code, 503); assert.equal(res.body.error, 'model_unavailable');
console.log('✓ model unavailable:', res.body.message);

// 5. per-IP daily limit (limit 3: chain + busy used 2)
res = fakeRes(); await handler(req('weather in Oslo'), res); assert.equal(res.code, 503);
res = fakeRes(); await handler(req('weather in Rome'), res); assert.equal(res.code, 429);
assert.equal(res.body.error, 'limit');
res = fakeRes(); await handler(req('weather in Rome', '9.9.9.9'), res); assert.equal(res.code, 503, 'other IP not limited');
console.log('✓ rate limit:', res.body.message);

// 6. satellite image chain
mode = 'sat';
res = fakeRes(); await handler(req('Satellite image of Ilulissat', '5.5.5.5'), res);
assert.equal(res.code, 200, JSON.stringify(res.body));
assert.match(res.body.tool, /nominatim.*→ stac\.search\(sentinel-2-l2a/);
assert.match(res.body.image.url, /^https:\/\/.*preview\.jpg$/);
assert.match(res.body.image.caption, /2026-10-12/);
assert.ok(res.body.sources.includes('Copernicus Sentinel-2 via Earth Search'));
console.log('✓ satellite:', res.body.text, '|', res.body.image.caption);

// 7. live aircraft near a place
mode = 'seq';
seq = [[call('p1', 'geocode', { query: 'Paris' })],
  [call('p2', 'aircraft_nearby', { lat: 48.857, lon: 2.352, radius_km: 50, place_name: 'Paris' })],
  'Two aircraft near Paris right now, including AFR1234 at 10,400 m.'];
res = fakeRes(); await handler(req('Planes over Paris', '7.7.7.7'), res);
assert.equal(res.code, 200, JSON.stringify(res.body));
assert.match(res.body.tool, /adsb\.lol\.aircraft_near\(Paris, 50 km\)/);
assert.ok(res.body.sources.includes('adsb.lol (ODbL)'));
assert.ok(res.body.points.some((p) => p[2] === 'AFR1234 · 10,400 m'), JSON.stringify(res.body.points));
assert.ok(res.body.points.some((p) => p[2] === 'EZY12 · on ground'));
let tr = toolResult('aircraft_nearby');
assert.equal(tr.total, 2); assert.equal(tr.airborne, 1); assert.equal(tr.closest[0].callsign, 'EZY12');
console.log('✓ aircraft nearby:', res.body.points.map((p) => p[2]).join(' | '));

// 8. one flight by callsign, found and not found
seq = [[call('f1', 'find_flight', { callsign: 'afr 123' })], 'AFR123 is over central France at 10,668 m.'];
res = fakeRes(); await handler(req('Where is flight AFR123?', '7.7.7.8'), res);
assert.equal(toolResult('find_flight').altitude_m, 10668);
seq = [[call('f2', 'find_flight', { callsign: 'XYZ999' })], 'Not visible right now.'];
res = fakeRes(); await handler(req('Where is XYZ999?', '7.7.7.8'), res);
assert.equal(toolResult('find_flight').found, false);
console.log('✓ find flight by callsign');

// 9. OpenStreetMap places
seq = [[call('o1', 'osm_nearby', { lat: 48.8606, lon: 2.3376, feature: 'cafes', radius_m: 500, place_name: 'Louvre' })], '37 cafés within 500 m of the Louvre.'];
res = fakeRes(); await handler(req('Cafés near the Louvre', '8.8.8.1'), res);
assert.equal(res.code, 200);
assert.match(overpassBodies.at(-1), /nwr\["amenity"="cafe"\]\(around:500,48\.8606,2\.3376\)->\.a;\.a out count;\.a out center 40;/);
tr = toolResult('osm_nearby'); assert.equal(tr.count, 37); assert.equal(tr.closest[0].name, 'Café Marly');
assert.ok(res.body.points.some((p) => p[2] === 'Louvre · 37 cafes'));
seq = [[call('o2', 'osm_nearby', { lat: 45.76, lon: 4.84, feature: 'buildings', radius_m: 5000 })], 'x'];
res = fakeRes(); await handler(req('Buildings in Lyon', '8.8.8.1'), res);
assert.match(toolResult('osm_nearby').error, /radius_m must be a number between 50 and 1500/);
seq = [[call('o3', 'osm_nearby', { lat: 45.76, lon: 4.84, feature: 'buildings', radius_m: 1000 })], 'x'];
res = fakeRes(); await handler(req('Buildings in Lyon centre', '8.8.8.1'), res);
assert.match(overpassBodies.at(-1), /way\["building"\]\(around:1000,45\.76,4\.84\);out count;$/);
console.log('✓ OpenStreetMap / Overpass');

// 10. straight-line distance with a great-circle arc
seq = [[call('d1', 'distance', { from_lat: 64.18, from_lon: -51.72, to_lat: 48.857, to_lon: 2.352, from_name: 'Nuuk', to_name: 'Paris' })], 'About 3,550 km as the crow flies.'];
res = fakeRes(); await handler(req('Distance from Nuuk to Paris', '8.8.8.2'), res);
tr = toolResult('distance');
assert.ok(tr.straight_line_km > 3500 && tr.straight_line_km < 3650, String(tr.straight_line_km));
assert.equal(tr.direction, 'E');
assert.equal(res.body.route.length, 49);
assert.ok(res.body.route[24][0] > (64.18 + 48.857) / 2 + 2, 'great-circle arc bulges north of the straight map line');
console.log('✓ distance:', tr.straight_line_km, 'km', tr.direction);

// 11. "near me" uses Vercel geo headers and is never cached
const geoH = { 'x-vercel-ip-latitude': '64.1814', 'x-vercel-ip-longitude': '-51.6941', 'x-vercel-ip-city': 'Nuuk', 'x-vercel-ip-country': 'GL' };
seq = [[call('u1', 'user_location', {})], [call('u2', 'get_weather', { lat: 64.18, lon: -51.69, place_name: 'Nuuk' })], 'Around Nuuk (approximate): 19 °C.'];
res = fakeRes(); await handler(req('Weather near me', '9.1.1.1', geoH), res);
assert.equal(toolResult('user_location').city, 'Nuuk');
assert.ok(res.body.points.some((p) => p[2].startsWith('Nuuk · ')));
assert.ok(toolResult('get_weather').local_time_now);
res = fakeRes(); await handler(req('Weather near me', '9.1.1.2'), res);
assert.notEqual(res.body.cached, true, 'personal answer not served from cache');
assert.equal(toolResult('user_location').found, false);
console.log('✓ near me (Vercel geo headers, not cached)');

// 12. ships: hidden without a key, live with one
seq = [[call('s0', 'ships_nearby', { lat: 51.95, lon: 4.1 })], 'Ship tracking is not connected yet.'];
res = fakeRes(); await handler(req('Ships near Rotterdam', '9.2.2.1'), res);
assert.ok(!lastBody.tools.some((t) => t.function.name === 'ships_nearby'));
assert.match(toolResult('ships_nearby').error, /unknown tool/);
let g = fakeRes(); await handler({ method: 'GET', headers: {} }, g);
assert.ok(!g.body.tools.includes('ships_nearby'));
process.env.AISSTREAM_API_KEY = 'ais-test-key';
g = fakeRes(); await handler({ method: 'GET', headers: {} }, g);
assert.ok(g.body.tools.includes('ships_nearby'));
seq = [[call('s1', 'ships_nearby', { lat: 51.95, lon: 4.1, radius_km: 20, place_name: 'Rotterdam' })], 'Two ships heard near Rotterdam, including EVER ACE at 11.2 knots.'];
res = fakeRes(); await handler(req('Ships near the port of Rotterdam', '9.2.2.2'), res);
assert.equal(res.code, 200, JSON.stringify(res.body));
assert.ok(lastBody.tools.some((t) => t.function.name === 'ships_nearby'));
assert.ok(/ships_nearby|live ships/.test(lastBody.messages[0].content));
const sub = aisSubs.at(-1);
assert.equal(sub.APIKey, 'ais-test-key');
assert.ok(sub.BoundingBoxes[0][0][0] < 51.95 && sub.BoundingBoxes[0][1][0] > 51.95, 'box is [lat, lon] pairs around the point');
tr = toolResult('ships_nearby');
assert.equal(tr.ships_heard, 2); assert.equal(tr.closest[0].name, 'EVER ACE'); assert.equal(tr.closest[1].heading_deg, null);
assert.ok(res.body.points.some((p) => p[2] === 'EVER ACE · 11.2 kn'));
console.log('✓ ships (AISStream):', res.body.points.map((p) => p[2]).join(' | '));

console.log('\nAll tests passed.');
