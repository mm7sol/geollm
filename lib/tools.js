// Geospatial tools exposed to the model. Each one calls a free, keyless public API
// directly (no MCP process needed on serverless) and returns:
//   { data, points, route, trace, source }
// `data` goes back to the model; points/route/trace/source go to the map.

import { cacheGet, cacheSet, takeSlot } from './store.js';

const UA = process.env.NOMINATIM_USER_AGENT ||
  'GeoLLM/0.1 (set NOMINATIM_USER_AGENT to "GeoLLM/0.1 (+https://your-site; contact@your-domain)")';
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const VALHALLA = process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de';

const DAY = 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function num(v, min, max, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`${name} must be a number between ${min} and ${max}`);
  return n;
}
function str(v, max, name) {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${name} is required`);
  return v.trim().slice(0, max);
}
export class ToolError extends Error {}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new ToolError(`upstream ${new URL(url).host} returned ${r.status}`);
  return r.json();
}

// ---------- Nominatim (1 req/s, identified User-Agent, cached) ----------
async function nominatim(path) {
  const key = 'nom:' + path;
  const hit = await cacheGet(key);
  if (hit) return hit;
  // Per-instance spacing, plus a shared 1 s slot when Redis is configured.
  await politeSlot('geocoder', 1100);
  const data = await getJSON(`${NOMINATIM}${path}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  await cacheSet(key, data, 30 * DAY);
  return data;
}

function shortName(r) {
  const a = r.address || {};
  return r.name || a.city || a.town || a.village || a.state || a.country || (r.display_name || '').split(',')[0];
}

async function geocode({ query }) {
  const q = str(query, 120, 'query');
  const res = await nominatim(`/search?format=jsonv2&addressdetails=1&limit=3&q=${encodeURIComponent(q)}`);
  if (!res.length) return { data: { found: false, query: q }, trace: `nominatim.search("${q}")`, source: 'OpenStreetMap / Nominatim' };
  const best = res.map((r) => ({
    name: shortName(r),
    full_name: r.display_name,
    lat: round(+r.lat), lon: round(+r.lon),
    type: r.type, country: r.address && r.address.country,
  }));
  const b = best[0];
  return {
    data: { found: true, best: b, alternatives: best.slice(1) },
    points: [[b.lat, b.lon, b.name]],
    trace: `nominatim.search("${q}")`,
    source: 'OpenStreetMap / Nominatim',
  };
}

async function reverseGeocode({ lat, lon }) {
  const la = num(lat, -90, 90, 'lat'), lo = num(lon, -180, 180, 'lon');
  const r = await nominatim(`/reverse?format=jsonv2&addressdetails=1&zoom=12&lat=${round(la, 3)}&lon=${round(lo, 3)}`);
  if (!r || r.error) return { data: { found: false }, points: [[la, lo, `${round(la, 2)}, ${round(lo, 2)}`]], trace: `nominatim.reverse(${round(la, 2)}, ${round(lo, 2)})`, source: 'OpenStreetMap / Nominatim' };
  const name = shortName(r);
  return {
    data: { found: true, name, full_name: r.display_name, country: r.address && r.address.country },
    points: [[la, lo, name]],
    trace: `nominatim.reverse(${round(la, 2)}, ${round(lo, 2)})`,
    source: 'OpenStreetMap / Nominatim',
  };
}

// ---------- Open-Meteo ----------
const WMO = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
  96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail' };

async function weather({ lat, lon, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 2), lo = round(num(lon, -180, 180, 'lon'), 2);
  const label = typeof place_name === 'string' && place_name.trim() ? place_name.trim().slice(0, 40) : `${la}, ${lo}`;
  const key = `om:fc:${la}:${lo}`;
  let d = await cacheGet(key);
  if (!d) {
    d = await getJSON('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: la, longitude: lo, timezone: 'auto', forecast_days: '3',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset',
    }));
    await cacheSet(key, d, 15 * 60);
  }
  const c = d.current || {}, dl = d.daily || {};
  const t = Math.round(c.temperature_2m);
  const days = (dl.time || []).map((date, i) => ({
    date, conditions: WMO[dl.weather_code[i]] || 'unknown',
    min_c: dl.temperature_2m_min[i], max_c: dl.temperature_2m_max[i], precipitation_mm: dl.precipitation_sum[i],
    sunrise: (dl.sunrise[i] || '').slice(11), sunset: (dl.sunset[i] || '').slice(11),
  }));
  return {
    data: {
      place: label, timezone: d.timezone, utc_offset_hours: (d.utc_offset_seconds || 0) / 3600, local_time: c.time, local_time_now: d.timezone ? new Date().toLocaleString('en-GB', { timeZone: d.timezone, dateStyle: 'medium', timeStyle: 'short' }) : null,
      current: { temperature_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m,
        precipitation_mm: c.precipitation, conditions: WMO[c.weather_code] || 'unknown', wind_kmh: c.wind_speed_10m, wind_dir_deg: c.wind_direction_10m },
      days,
    },
    points: [[la, lo, `${label} · ${t}°C`]],
    trace: `open-meteo.forecast(${la}, ${lo})`,
    source: 'Open-Meteo',
  };
}

async function airQuality({ lat, lon, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 2), lo = round(num(lon, -180, 180, 'lon'), 2);
  const label = typeof place_name === 'string' && place_name.trim() ? place_name.trim().slice(0, 40) : `${la}, ${lo}`;
  const key = `om:aq:${la}:${lo}`;
  let d = await cacheGet(key);
  if (!d) {
    d = await getJSON('https://air-quality-api.open-meteo.com/v1/air-quality?' + new URLSearchParams({
      latitude: la, longitude: lo, timezone: 'auto',
      current: 'european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone',
    }));
    await cacheSet(key, d, 30 * 60);
  }
  const c = d.current || {};
  return {
    data: { place: label, time: c.time, european_aqi: c.european_aqi, us_aqi: c.us_aqi, pm2_5_ugm3: c.pm2_5, pm10_ugm3: c.pm10, no2_ugm3: c.nitrogen_dioxide, ozone_ugm3: c.ozone,
      note: 'European AQI: 0-20 good, 20-40 fair, 40-60 moderate, 60-80 poor, 80-100 very poor, >100 extremely poor. Values are modelled (CAMS), not station readings.' },
    points: [[la, lo, `${label} · PM2.5 ${Math.round(c.pm2_5)}`]],
    trace: `open-meteo.air_quality(${la}, ${lo})`,
    source: 'Open-Meteo / CAMS',
  };
}

// ---------- Valhalla routing ----------
function decodePolyline6(s) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}
function thin(pts, max) {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1), out = [];
  for (let k = 0; k < max; k++) out.push(pts[Math.round(k * step)]);
  return out;
}

async function route({ from_lat, from_lon, to_lat, to_lon, from_name, to_name, mode }) {
  const a = [num(from_lat, -90, 90, 'from_lat'), num(from_lon, -180, 180, 'from_lon')];
  const b = [num(to_lat, -90, 90, 'to_lat'), num(to_lon, -180, 180, 'to_lon')];
  const costing = { car: 'auto', bike: 'bicycle', walk: 'pedestrian' }[mode] || 'auto';
  const n1 = typeof from_name === 'string' && from_name.trim() ? from_name.trim().slice(0, 30) : 'Start';
  const n2 = typeof to_name === 'string' && to_name.trim() ? to_name.trim().slice(0, 30) : 'End';
  const body = { locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }], costing, units: 'kilometers', directions_type: 'none' };
  const key = `vh:${costing}:${a.map((x) => round(x, 3))}:${b.map((x) => round(x, 3))}`;
  let trip = await cacheGet(key);
  if (!trip) {
    const r = await fetch(`${VALHALLA}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ToolError(j.error ? `no route found: ${j.error}` : `routing server returned ${r.status}`);
    const t = j.trip;
    const shape = t.legs.flatMap((l) => decodePolyline6(l.shape));
    trip = { km: round(t.summary.length, 1), seconds: Math.round(t.summary.time), shape: thin(shape, 160).map(([x, y]) => [round(x, 3), round(y, 3)]) };
    await cacheSet(key, trip, 7 * DAY);
  }
  const h = Math.floor(trip.seconds / 3600), m = Math.round((trip.seconds % 3600) / 60);
  return {
    data: { from: n1, to: n2, mode: costing, distance_km: trip.km, duration: `${h} h ${m} min`, duration_seconds: trip.seconds },
    points: [[a[0], a[1], n1], [b[0], b[1], `${n2} · ${Math.round(trip.km)} km`]],
    route: trip.shape,
    trace: `valhalla.route(${n1} → ${n2}, ${costing})`,
    source: 'Valhalla (FOSSGIS) / OpenStreetMap',
  };
}

// ---------- Earth observation: Sentinel-2 via a public STAC API ----------
const STAC = process.env.STAC_URL || 'https://earth-search.aws.element84.com/v1';

async function satelliteImages({ lat, lon, place_name, max_cloud, days }) {
  const la = round(num(lat, -90, 90, 'lat'), 3), lo = round(num(lon, -180, 180, 'lon'), 3);
  const cloud = max_cloud == null ? 20 : num(max_cloud, 0, 100, 'max_cloud');
  const span = days == null ? 60 : num(days, 1, 365, 'days');
  const label = typeof place_name === 'string' && place_name.trim() ? place_name.trim().slice(0, 40) : `${la}, ${lo}`;
  const end = new Date(), start = new Date(end - span * DAY * 1000);
  const key = `stac:s2:${la}:${lo}:${cloud}:${span}:${end.toISOString().slice(0, 10)}`;
  let items = await cacheGet(key);
  if (!items) {
    const r = await fetch(`${STAC}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        collections: ['sentinel-2-l2a'],
        intersects: { type: 'Point', coordinates: [lo, la] },
        datetime: `${start.toISOString()}/${end.toISOString()}`,
        query: { 'eo:cloud_cover': { lt: cloud } },
        sortby: [{ field: 'properties.datetime', direction: 'desc' }],
        limit: 5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new ToolError(`satellite catalog returned ${r.status}`);
    const j = await r.json();
    items = (j.features || []).map((f) => {
      const thumb = f.assets && (f.assets.thumbnail || f.assets.preview);
      return {
        id: f.id,
        date: (f.properties.datetime || '').slice(0, 10),
        cloud_pct: Math.round(f.properties['eo:cloud_cover'] ?? -1),
        thumbnail: thumb && /^https:\/\//.test(thumb.href) ? thumb.href : null,
      };
    });
    await cacheSet(key, items, 6 * 3600);
  }
  const base = { trace: `stac.search(sentinel-2-l2a, ${label}, cloud<${cloud}%, ${span} d)`, source: 'Copernicus Sentinel-2 via Earth Search' };
  if (!items.length) return { ...base, data: { place: label, found: 0, hint: 'No scene matched. Try a higher max_cloud or more days.' }, points: [[la, lo, `${label} · no clear scene`]] };
  const best = items[0];
  return {
    ...base,
    data: { place: label, found: items.length, latest: { date: best.date, cloud_pct: best.cloud_pct, id: best.id },
      others: items.slice(1).map((i) => ({ date: i.date, cloud_pct: i.cloud_pct })),
      note: 'A preview image of the latest scene is shown to the user. Sentinel-2 resolution is 10 m per pixel.' },
    points: [[la, lo, `Sentinel-2 · ${best.date}`]],
    image: best.thumbnail ? { url: best.thumbnail, caption: `Sentinel-2 · ${label} · ${best.date} · ${best.cloud_pct}% cloud` } : null,
  };
}

// ---------- shared helpers for the live-data tools ----------
const KM_PER_NM = 1.852;
const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
function haversineKm(a, b) {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingDeg(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
const label = (v, la, lo, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : `${round(la, 2)}, ${round(lo, 2)}`);

// Spacing for shared public servers: one request per `ms` per server, across instances when Redis is set.
const lastHit = {};
async function politeSlot(name, ms) {
  for (let i = 0; ; i++) {
    const wait = (lastHit[name] || 0) + ms - Date.now();
    if (wait > 0) await sleep(wait);
    if (await takeSlot(`slot:${name}`, ms)) break;
    if (i >= 6) throw new ToolError(`${name} is busy, try again in a moment`);
    await sleep(350);
  }
  lastHit[name] = Date.now();
}

// ---------- Aircraft: adsb.lol (community ADS-B, no key, ODbL) ----------
const ADSB = (process.env.ADSB_URL || 'https://api.adsb.lol').replace(/\/+$/, '');

function aircraftRow(a, from) {
  const onGround = a.alt_baro === 'ground';
  const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : null;
  const callsign = (a.flight || '').trim() || null;
  const row = {
    callsign, registration: a.r || null, type: a.t || null, icao24: a.hex,
    lat: round(a.lat, 3), lon: round(a.lon, 3),
    altitude_m: onGround ? 0 : altFt == null ? null : Math.round(altFt * 0.3048),
    on_ground: onGround,
    speed_kmh: typeof a.gs === 'number' ? Math.round(a.gs * KM_PER_NM) : null,
    heading_deg: typeof a.track === 'number' ? Math.round(a.track) : null,
    seconds_since_position: typeof a.seen_pos === 'number' ? Math.round(a.seen_pos) : null,
  };
  if (from) row.distance_km = Math.round(haversineKm(from, [a.lat, a.lon]) * 10) / 10;
  return row;
}
const planeLabel = (r) => `${r.callsign || r.registration || r.icao24} · ${r.on_ground ? 'on ground' : r.altitude_m == null ? '?' : r.altitude_m.toLocaleString('en-US') + ' m'}`;

async function adsb(path, ttl) {
  const key = 'adsb:' + path;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const j = await getJSON(`${ADSB}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const ac = (j.ac || j.aircraft || []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon));
  await cacheSet(key, ac, ttl);
  return ac;
}

async function aircraftNearby({ lat, lon, radius_km, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 3), lo = round(num(lon, -180, 180, 'lon'), 3);
  const km = radius_km == null ? 50 : num(radius_km, 1, 400, 'radius_km');
  const nm = Math.min(250, Math.max(1, Math.round(km / KM_PER_NM)));
  const name = label(place_name, la, lo);
  const ac = await adsb(`/v2/lat/${la}/lon/${lo}/dist/${nm}`, 20);
  const rows = ac.map((a) => aircraftRow(a, [la, lo])).sort((a, b) => a.distance_km - b.distance_km);
  const airborne = rows.filter((r) => !r.on_ground);
  return {
    data: { place: name, radius_km: Math.round(nm * KM_PER_NM), total: rows.length, airborne: airborne.length,
      closest: rows.slice(0, 10), note: 'Live snapshot from volunteer ADS-B receivers. Coverage varies by region; some aircraft are not visible.' },
    points: rows.length ? rows.slice(0, 6).map((r) => [r.lat, r.lon, planeLabel(r)]) : [[la, lo, `${name} · no aircraft seen`]],
    trace: `adsb.lol.aircraft_near(${name}, ${Math.round(nm * KM_PER_NM)} km)`,
    source: 'adsb.lol (ODbL)',
    answerTtl: 30,
  };
}

async function findFlight({ callsign }) {
  const cs = str(callsign, 10, 'callsign').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cs.length < 3) throw new ToolError('callsign must be at least 3 letters or digits, e.g. AFR123');
  const ac = await adsb(`/v2/callsign/${cs}`, 20);
  const base = { trace: `adsb.lol.callsign(${cs})`, source: 'adsb.lol (ODbL)', answerTtl: 30 };
  if (!ac.length) return { ...base, data: { callsign: cs, found: false,
    hint: 'Not seen right now. Use the ICAO callsign (e.g. AFR123 for Air France AF123); the flight may also be on the ground or out of coverage.' } };
  const r = aircraftRow(ac[0]);
  return { ...base, data: { found: true, ...r, note: 'Live position from volunteer ADS-B receivers.' }, points: [[r.lat, r.lon, planeLabel(r)]] };
}

// ---------- Ships: AISStream.io (free key, server-side WebSocket only) ----------
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const shipsEnabled = () => Boolean(process.env.AISSTREAM_API_KEY);

function listenAIS(box, waitMs, maxShips) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new ToolError('ship tracking needs Node.js 22 or newer'));
    const ships = new Map();
    let settled = false, ws;
    const finish = (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve([...ships.values()]);
    };
    const timer = setTimeout(() => finish(), waitMs);
    try { ws = new WebSocket(AIS_URL); } catch { return finish(new ToolError('could not reach the ship tracking service')); }
    ws.onopen = () => ws.send(JSON.stringify({
      APIKey: process.env.AISSTREAM_API_KEY,
      BoundingBoxes: [box],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport'],
    }));
    ws.onmessage = async (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : typeof ev.data.text === 'function' ? await ev.data.text() : Buffer.from(ev.data).toString();
        const j = JSON.parse(raw);
        if (j.error) return finish(new ToolError(`ship tracking refused the request: ${String(j.error).slice(0, 80)}`));
        const m = j.MetaData || {}, msg = j.Message || {};
        const pr = msg.PositionReport || msg.StandardClassBPositionReport || {};
        const la = pr.Latitude ?? m.latitude ?? m.Latitude, lo = pr.Longitude ?? m.longitude ?? m.Longitude;
        const mmsi = m.MMSI ?? pr.UserID;
        if (!Number.isFinite(la) || !Number.isFinite(lo) || !mmsi) return;
        ships.set(mmsi, {
          name: String(m.ShipName || '').trim() || null, mmsi,
          lat: round(la, 4), lon: round(lo, 4),
          speed_knots: Number.isFinite(pr.Sog) ? pr.Sog : null,
          course_deg: Number.isFinite(pr.Cog) ? Math.round(pr.Cog) : null,
          heading_deg: Number.isFinite(pr.TrueHeading) && pr.TrueHeading !== 511 ? pr.TrueHeading : null,
        });
        if (ships.size >= maxShips) finish();
      } catch { /* ignore malformed frames */ }
    };
    ws.onerror = () => finish(ships.size ? undefined : new ToolError('ship tracking service is unavailable right now'));
    ws.onclose = () => finish();
  });
}

async function shipsNearby({ lat, lon, radius_km, place_name }) {
  if (!shipsEnabled()) throw new ToolError('ship tracking is not connected yet');
  const la = round(num(lat, -85, 85, 'lat'), 3), lo = round(num(lon, -180, 180, 'lon'), 3);
  const km = radius_km == null ? 20 : num(radius_km, 1, 100, 'radius_km');
  const name = label(place_name, la, lo);
  const dLat = km / 111, dLon = km / (111 * Math.max(0.1, Math.cos(toRad(la))));
  const box = [[round(la - dLat, 4), round(lo - dLon, 4)], [round(la + dLat, 4), round(lo + dLon, 4)]];
  const key = `ais:${la}:${lo}:${km}`;
  let ships = await cacheGet(key);
  if (!ships) {
    ships = await listenAIS(box, Number(process.env.AIS_WAIT_MS || 8000), 25);
    await cacheSet(key, ships, 60);
  }
  const rows = ships.map((s) => ({ ...s, distance_km: Math.round(haversineKm([la, lo], [s.lat, s.lon]) * 10) / 10 }))
    .sort((a, b) => a.distance_km - b.distance_km);
  return {
    data: { place: name, radius_km: km, ships_heard: rows.length, closest: rows.slice(0, 10),
      note: 'Ships that broadcast a position during an ~8 second listen. Moving ships report every few seconds; anchored or moored ships report rarely, so many are missing. Coverage depends on volunteer receivers.' },
    points: rows.length ? rows.slice(0, 6).map((s) => [s.lat, s.lon, `${s.name || 'MMSI ' + s.mmsi}${s.speed_knots != null ? ' · ' + s.speed_knots + ' kn' : ''}`]) : [[la, lo, `${name} · no ship heard`]],
    trace: `aisstream.vessels_in_area(${name}, ${km} km)`,
    source: 'AISStream.io',
    answerTtl: 60,
  };
}

// ---------- OpenStreetMap queries: Overpass ----------
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const OSM_FEATURES = {
  buildings: { q: 'way["building"]', countOnly: true, maxR: 1500 },
  restaurants: { q: 'nwr["amenity"="restaurant"]' }, cafes: { q: 'nwr["amenity"="cafe"]' },
  bars: { q: 'nwr["amenity"~"^(bar|pub)$"]' }, hospitals: { q: 'nwr["amenity"="hospital"]' },
  pharmacies: { q: 'nwr["amenity"="pharmacy"]' }, schools: { q: 'nwr["amenity"="school"]' },
  supermarkets: { q: 'nwr["shop"="supermarket"]' }, hotels: { q: 'nwr["tourism"="hotel"]' },
  museums: { q: 'nwr["tourism"="museum"]' }, viewpoints: { q: 'nwr["tourism"="viewpoint"]' },
  parks: { q: 'nwr["leisure"="park"]' }, playgrounds: { q: 'nwr["leisure"="playground"]' },
  toilets: { q: 'nwr["amenity"="toilets"]' }, drinking_water: { q: 'nwr["amenity"="drinking_water"]' },
  ev_charging: { q: 'nwr["amenity"="charging_station"]' }, atms: { q: 'nwr["amenity"="atm"]' },
  bus_stops: { q: 'nwr["highway"="bus_stop"]' }, train_stations: { q: 'nwr["railway"="station"]' },
  places_of_worship: { q: 'nwr["amenity"="place_of_worship"]' },
};

async function osmNearby({ lat, lon, feature, radius_m, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 4), lo = round(num(lon, -180, 180, 'lon'), 4);
  const f = OSM_FEATURES[feature];
  if (!f) throw new ToolError(`feature must be one of: ${Object.keys(OSM_FEATURES).join(', ')}`);
  const maxR = f.maxR || 3000;
  const r = Math.round(radius_m == null ? Math.min(800, maxR) : num(radius_m, 50, maxR, 'radius_m'));
  const name = label(place_name, la, lo);
  const sel = `${f.q}(around:${r},${la},${lo})`;
  const query = f.countOnly
    ? `[out:json][timeout:20];${sel};out count;`
    : `[out:json][timeout:20];${sel}->.a;.a out count;.a out center 40;`;
  const key = `osm:${feature}:${r}:${la}:${lo}`;
  let els = await cacheGet(key);
  if (!els) {
    await politeSlot('overpass', 1000);
    const resp = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(25000),
    });
    if (resp.status === 429 || resp.status === 504) throw new ToolError('the OpenStreetMap query server is busy, try again in a minute');
    if (!resp.ok) throw new ToolError(`OpenStreetMap query server returned ${resp.status}`);
    els = ((await resp.json()).elements || []).map((e) => e.type === 'count'
      ? { count: Number(e.tags && e.tags.total) || 0 }
      : { name: (e.tags && (e.tags['name:en'] || e.tags.name)) || null, lat: e.lat ?? (e.center && e.center.lat), lon: e.lon ?? (e.center && e.center.lon) });
    await cacheSet(key, els, DAY);
  }
  const total = (els.find((e) => 'count' in e) || {}).count ?? 0;
  const items = els.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map((e) => ({ name: e.name, lat: round(e.lat, 5), lon: round(e.lon, 5), distance_m: Math.round(haversineKm([la, lo], [e.lat, e.lon]) * 1000) }))
    .sort((a, b) => a.distance_m - b.distance_m);
  const nice = feature.replace(/_/g, ' ');
  const named = items.filter((i) => i.name);
  const shown = (named.length >= 3 ? named : items).slice(0, 6);
  return {
    data: { place: name, feature: nice, radius_m: r, count: total, closest: items.slice(0, 10),
      note: 'Counts what is mapped in OpenStreetMap, which can be incomplete.' },
    points: [[la, lo, `${name} · ${total} ${nice}`], ...shown.map((i) => [i.lat, i.lon, i.name || nice.replace(/s$/, '')])],
    trace: `overpass.${feature}(${name}, ${r} m)`,
    source: 'OpenStreetMap / Overpass',
  };
}

// ---------- Straight-line distance (computed locally, no API) ----------
function greatCircle(a, b, n = 48) {
  const [p1, l1, p2, l2] = [a[0], a[1], b[0], b[1]].map(toRad);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-6) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([round(toDeg(Math.atan2(z, Math.hypot(x, y))), 3), round(toDeg(Math.atan2(y, x)), 3)]);
  }
  // the dotted map does not wrap around: if the arc crosses the date line, draw nothing
  for (let i = 1; i < out.length; i++) if (Math.abs(out[i][1] - out[i - 1][1]) > 180) return null;
  return out;
}

async function distance({ from_lat, from_lon, to_lat, to_lon, from_name, to_name }) {
  const a = [num(from_lat, -90, 90, 'from_lat'), num(from_lon, -180, 180, 'from_lon')];
  const b = [num(to_lat, -90, 90, 'to_lat'), num(to_lon, -180, 180, 'to_lon')];
  const n1 = label(from_name, a[0], a[1], 30), n2 = label(to_name, b[0], b[1], 30);
  const km = haversineKm(a, b), brg = bearingDeg(a, b);
  return {
    data: { from: n1, to: n2, straight_line_km: Math.round(km * 10) / 10, straight_line_miles: Math.round(km * 0.621371 * 10) / 10,
      nautical_miles: Math.round((km / KM_PER_NM) * 10) / 10, initial_bearing_deg: Math.round(brg), direction: compass(brg),
      note: 'Great-circle distance ("as the crow flies"), not a road distance.' },
    points: [[a[0], a[1], n1], [b[0], b[1], `${n2} · ${Math.round(km).toLocaleString('en-US')} km`]],
    route: greatCircle(a, b),
    trace: `geo.distance(${n1} → ${n2})`,
    source: 'Computed (great-circle)',
  };
}

// ---------- Visitor's approximate location: Vercel IP geolocation headers ----------
async function userLocation(_args, ctx = {}) {
  const g = ctx.geo || {};
  const base = { trace: 'vercel.ip_geolocation()', source: 'Approximate IP location (Vercel)', answerTtl: 0 };
  if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) {
    return { ...base, data: { found: false, hint: 'Location is not available here. Ask the user which city they mean.' } };
  }
  const name = g.city || g.country || 'You';
  return {
    ...base,
    data: { found: true, city: g.city || null, region: g.region || null, country: g.country || null,
      lat: round(g.lat, 2), lon: round(g.lon, 2), accuracy: 'approximate, city level, from the IP address' },
    points: [[round(g.lat, 2), round(g.lon, 2), `≈ ${name}`]],
  };
}

// ---------- Weather history / climate: Open-Meteo archive (ERA5) ----------
async function weatherHistory({ lat, lon, place_name, days }) {
  const la = round(num(lat, -90, 90, 'lat'), 2), lo = round(num(lon, -180, 180, 'lon'), 2);
  const span = days == null ? 30 : num(days, 1, 366, 'days');
  const name = label(place_name, la, lo);
  const end = new Date(Date.now() - 6 * DAY * 1000); // the archive lags the last few days
  const start = new Date(end - (span - 1) * DAY * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const key = `om:hist:${la}:${lo}:${iso(start)}:${iso(end)}`;
  let d = await cacheGet(key);
  if (!d) {
    d = await getJSON('https://archive-api.open-meteo.com/v1/archive?' + new URLSearchParams({
      latitude: la, longitude: lo, timezone: 'auto', start_date: iso(start), end_date: iso(end),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    }));
    await cacheSet(key, d, DAY);
  }
  const dl = d.daily || {};
  const nums = (a) => (a || []).filter((x) => x != null);
  const max = nums(dl.temperature_2m_max), min = nums(dl.temperature_2m_min), rain = nums(dl.precipitation_sum);
  const avg = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
  return {
    data: { place: name, from: iso(start), to: iso(end), days_measured: max.length,
      avg_high_c: avg(max), avg_low_c: avg(min), warmest_c: max.length ? Math.max(...max) : null, coldest_c: min.length ? Math.min(...min) : null,
      total_precipitation_mm: rain.length ? Math.round(rain.reduce((s, x) => s + x, 0) * 10) / 10 : null,
      note: 'Daily figures from the Open-Meteo historical archive (ERA5 reanalysis), not a local weather station.' },
    points: [[la, lo, `${name} · ${avg(min)}–${avg(max)}°C`]],
    trace: `open-meteo.archive(${la}, ${lo}, ${span} d)`,
    source: 'Open-Meteo historical archive (ERA5)',
  };
}

// ---------- Sea state: Open-Meteo marine ----------
async function seaConditions({ lat, lon, place_name }) {
  const la = round(num(lat, -89.9, 89.9, 'lat'), 2), lo = round(num(lon, -180, 180, 'lon'), 2);
  const name = label(place_name, la, lo);
  const key = `om:marine:${la}:${lo}`;
  let d = await cacheGet(key);
  if (!d) {
    d = await getJSON('https://marine-api.open-meteo.com/v1/marine?' + new URLSearchParams({
      latitude: la, longitude: lo, timezone: 'auto',
      current: 'wave_height,wave_direction,wave_period,sea_surface_temperature',
    }));
    await cacheSet(key, d, 30 * 60);
  }
  const c = d.current || {};
  if (c.wave_height == null) {
    return { data: { place: name, found: false, hint: 'No marine data here. This works on sea and ocean points, not inland places.' },
      points: [[la, lo, `${name} · no marine data`]], trace: `open-meteo.marine(${la}, ${lo})`, source: 'Open-Meteo Marine' };
  }
  return {
    data: { place: name, time: c.time, wave_height_m: c.wave_height, wave_direction_deg: c.wave_direction, wave_period_s: c.wave_period,
      sea_surface_temperature_c: c.sea_surface_temperature, note: 'Modelled wave and sea-surface data, not a buoy reading.' },
    points: [[la, lo, `${name} · waves ${c.wave_height} m`]],
    trace: `open-meteo.marine(${la}, ${lo})`,
    source: 'Open-Meteo Marine',
  };
}

// ---------- Elevation: Open-Meteo (Copernicus DEM) ----------
async function elevation({ lat, lon, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 4), lo = round(num(lon, -180, 180, 'lon'), 4);
  const name = label(place_name, la, lo);
  const key = `om:elev:${la}:${lo}`;
  let d = await cacheGet(key);
  if (!d) { d = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`); await cacheSet(key, d, 30 * DAY); }
  const m = Array.isArray(d.elevation) ? d.elevation[0] : null;
  if (m == null) return { data: { place: name, found: false }, points: [[la, lo, name]], trace: `open-meteo.elevation(${la}, ${lo})`, source: 'Open-Meteo (Copernicus DEM)' };
  return {
    data: { place: name, elevation_m: Math.round(m), elevation_ft: Math.round(m * 3.28084), note: 'Ground elevation from the Copernicus DEM (90 m grid).' },
    points: [[la, lo, `${name} · ${Math.round(m).toLocaleString('en-US')} m`]],
    trace: `open-meteo.elevation(${la}, ${lo})`,
    source: 'Open-Meteo (Copernicus DEM)',
  };
}

// ---------- Time zone and local time: Open-Meteo ----------
async function localTime({ lat, lon, place_name }) {
  const la = round(num(lat, -90, 90, 'lat'), 2), lo = round(num(lon, -180, 180, 'lon'), 2);
  const name = label(place_name, la, lo);
  const key = `om:tz:${la}:${lo}`;
  let d = await cacheGet(key);
  if (!d) {
    d = await getJSON('https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: la, longitude: lo, timezone: 'auto', forecast_days: '1', daily: 'sunrise,sunset',
    }));
    await cacheSet(key, d, 3600);
  }
  const dl = d.daily || {};
  const now = d.timezone ? new Date().toLocaleString('en-GB', { timeZone: d.timezone, dateStyle: 'medium', timeStyle: 'short' }) : null;
  const hm = now && now.includes(', ') ? now.split(', ')[1] : now;
  return {
    data: { place: name, timezone: d.timezone || null, utc_offset_hours: (d.utc_offset_seconds || 0) / 3600, local_time_now: now,
      sunrise: (dl.sunrise && dl.sunrise[0] || '').slice(11) || null, sunset: (dl.sunset && dl.sunset[0] || '').slice(11) || null },
    points: [[la, lo, `${name} · ${hm || ''}`]],
    trace: `open-meteo.timezone(${la}, ${lo})`,
    source: 'Open-Meteo (time zone)',
  };
}

// ---------- Reachability: Valhalla isochrone ----------
function sphericalAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [la1, lo1] = ring[i], [la2, lo2] = ring[(i + 1) % n];
    sum += toRad(lo2 - lo1) * (2 + Math.sin(toRad(la1)) + Math.sin(toRad(la2)));
  }
  return (Math.abs(sum) * 6371.0088 ** 2) / 2;
}

async function isochrone({ lat, lon, place_name, minutes, mode }) {
  const la = round(num(lat, -90, 90, 'lat'), 4), lo = round(num(lon, -180, 180, 'lon'), 4);
  const mins = minutes == null ? 15 : num(minutes, 1, 120, 'minutes');
  const costing = { car: 'auto', bike: 'bicycle', walk: 'pedestrian' }[mode] || 'auto';
  const name = label(place_name, la, lo);
  const key = `vh:iso:${costing}:${mins}:${la}:${lo}`;
  let fc = await cacheGet(key);
  if (!fc) {
    const r = await fetch(`${VALHALLA}/isochrone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ locations: [{ lat: la, lon: lo }], costing, contours: [{ time: mins, color: '0a0a0a' }], polygons: true }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ToolError(j.error ? `no reachable area found: ${j.error}` : `routing server returned ${r.status}`);
    fc = j;
    await cacheSet(key, fc, 3 * DAY);
  }
  const feat = (fc.features || [])[0];
  if (!feat) throw new ToolError('the routing server returned no reachable area');
  const ring = ((feat.geometry && feat.geometry.coordinates && feat.geometry.coordinates[0]) || []).map(([x, y]) => [round(y, 3), round(x, 3)]);
  const outline = thin(ring, 180);
  const area = sphericalAreaKm2(ring);
  return {
    data: { place: name, mode: costing, minutes: mins, reachable_area_km2: area != null ? Math.round(area) : null,
      note: `Area reachable within ${mins} minutes by ${costing === 'auto' ? 'car' : costing === 'bicycle' ? 'bike' : 'foot'} on the road network.` },
    points: [[la, lo, name]],
    route: outline.length > 1 ? outline : null,
    trace: `valhalla.isochrone(${name}, ${mins} min, ${costing})`,
    source: 'Valhalla (FOSSGIS) / OpenStreetMap',
  };
}

// ---------- IP address location: ipwho.is (no key) ----------
async function ipLocation({ ip }) {
  const q = str(ip, 64, 'ip');
  const j = await getJSON(`https://ipwho.is/${encodeURIComponent(q)}`);
  if (!j || j.success === false) return { data: { ip: q, found: false, hint: (j && j.message) || 'Not a valid public IP address.' }, trace: `ipwho.is(${q})`, source: 'ipwho.is' };
  const la = round(j.latitude, 2), lo = round(j.longitude, 2);
  const name = j.city || j.region || j.country || q;
  return {
    data: { ip: j.ip, found: true, type: j.type, city: j.city || null, region: j.region || null, country: j.country || null,
      latitude: la, longitude: lo, timezone: j.timezone && j.timezone.id, isp: j.connection && j.connection.isp,
      note: 'Approximate, city-level, from IP ranges; VPNs and mobile networks can be far off.' },
    points: [[la, lo, name]],
    trace: `ipwho.is(${q})`,
    source: 'ipwho.is',
  };
}

// ---------- registry ----------
const coord = (d) => ({ type: 'number', description: d });
export const TOOLS = {
  geocode: {
    run: geocode,
    schema: { description: 'Find the coordinates of a place name or address (city, landmark, street). Call this before any tool that needs coordinates. Never guess coordinates yourself.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Place name or address, e.g. "Nuuk, Greenland"' } }, required: ['query'] } },
  },
  reverse_geocode: {
    run: reverseGeocode,
    schema: { description: 'Find the place name for a latitude/longitude pair.',
      parameters: { type: 'object', properties: { lat: coord('Latitude'), lon: coord('Longitude') }, required: ['lat', 'lon'] } },
  },
  get_weather: {
    run: weather,
    schema: { description: 'Current weather and a 3-day forecast at a location, plus local time zone, sunrise and sunset.',
      parameters: { type: 'object', properties: { lat: coord('Latitude'), lon: coord('Longitude'), place_name: { type: 'string', description: 'Short place name for the map label' } }, required: ['lat', 'lon'] } },
  },
  get_air_quality: {
    run: airQuality,
    schema: { description: 'Current modelled air quality (European AQI, PM2.5, PM10, NO2, ozone) at a location.',
      parameters: { type: 'object', properties: { lat: coord('Latitude'), lon: coord('Longitude'), place_name: { type: 'string', description: 'Short place name for the map label' } }, required: ['lat', 'lon'] } },
  },
  get_weather_history: {
    run: weatherHistory,
    schema: { description: 'Past weather at a location: daily average high/low and total precipitation over the last N days (default 30). Use for "was it rainy last month", "how warm was it recently".',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
        days: { type: 'number', description: 'How many days back (default 30, max 366)' },
      }, required: ['lat', 'lon'] } },
  },
  get_sea_conditions: {
    run: seaConditions,
    schema: { description: 'Current sea state at a coastal or ocean point: wave height, direction, period and sea-surface temperature. Not for inland places.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon'] } },
  },
  get_elevation: {
    run: elevation,
    schema: { description: 'Ground elevation above sea level (metres and feet) at a latitude/longitude.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon'] } },
  },
  get_timezone: {
    run: localTime,
    schema: { description: 'Time zone, current local time, UTC offset, sunrise and sunset at a location.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon'] } },
  },
  get_route: {
    run: route,
    schema: { description: 'Road route between two points: distance and travel time by car, bike or on foot.',
      parameters: { type: 'object', properties: {
        from_lat: coord('Start latitude'), from_lon: coord('Start longitude'),
        to_lat: coord('End latitude'), to_lon: coord('End longitude'),
        from_name: { type: 'string' }, to_name: { type: 'string' },
        mode: { type: 'string', enum: ['car', 'bike', 'walk'] },
      }, required: ['from_lat', 'from_lon', 'to_lat', 'to_lon'] } },
  },
  get_isochrone: {
    run: isochrone,
    schema: { description: 'The area reachable from a point within a time budget by car, bike or on foot (isochrone), drawn on the map. Use for "what can I reach in 20 minutes from X".',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
        minutes: { type: 'number', description: 'Time budget in minutes (default 15, max 120)' },
        mode: { type: 'string', enum: ['car', 'bike', 'walk'] },
      }, required: ['lat', 'lon'] } },
  },
  search_satellite_images: {
    run: satelliteImages,
    schema: { description: 'Find recent Sentinel-2 satellite images (10 m resolution) over a location, newest first, filtered by cloud cover. Shows a preview of the latest one.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        place_name: { type: 'string', description: 'Short place name for the map label' },
        max_cloud: { type: 'number', description: 'Maximum cloud cover in percent (default 20)' },
        days: { type: 'number', description: 'How many days back to search (default 60, max 365)' },
      }, required: ['lat', 'lon'] } },
  },
  aircraft_nearby: {
    run: aircraftNearby,
    schema: { description: 'Live aircraft currently flying near a location (callsign, type, altitude, speed, distance). Use for "planes over X" or "flights near X".',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        radius_km: { type: 'number', description: 'Search radius in km (default 50, max 400)' },
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon'] } },
  },
  find_flight: {
    run: findFlight,
    schema: { description: 'Live position of one flight by its ICAO callsign (e.g. AFR123 for Air France AF123, BAW45 for British Airways BA45).',
      parameters: { type: 'object', properties: { callsign: { type: 'string', description: 'ICAO callsign, letters and digits' } }, required: ['callsign'] } },
  },
  ships_nearby: {
    run: shipsNearby,
    enabled: shipsEnabled,
    schema: { description: 'Live ships broadcasting AIS near a coastal location (name, speed, course). Takes about 8 seconds.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        radius_km: { type: 'number', description: 'Search radius in km (default 20, max 100)' },
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon'] } },
  },
  osm_nearby: {
    run: osmNearby,
    schema: { description: 'Count and list places mapped in OpenStreetMap around a point: cafés, restaurants, hospitals, pharmacies, parks, EV chargers, buildings and more.',
      parameters: { type: 'object', properties: {
        lat: coord('Latitude'), lon: coord('Longitude'),
        feature: { type: 'string', enum: Object.keys(OSM_FEATURES) },
        radius_m: { type: 'number', description: 'Radius in metres (default 800, max 3000; buildings max 1500)' },
        place_name: { type: 'string', description: 'Short place name for the map label' },
      }, required: ['lat', 'lon', 'feature'] } },
  },
  distance: {
    run: distance,
    schema: { description: 'Straight-line ("as the crow flies") distance and compass direction between two points. For driving distance use get_route.',
      parameters: { type: 'object', properties: {
        from_lat: coord('Start latitude'), from_lon: coord('Start longitude'),
        to_lat: coord('End latitude'), to_lon: coord('End longitude'),
        from_name: { type: 'string' }, to_name: { type: 'string' },
      }, required: ['from_lat', 'from_lon', 'to_lat', 'to_lon'] } },
  },
  user_location: {
    run: userLocation,
    schema: { description: 'The user\'s approximate location (city level, from their IP address). Only call this when the user says "near me", "here", "where I am" or similar.',
      parameters: { type: 'object', properties: {} } },
  },
  find_ip_location: {
    run: ipLocation,
    schema: { description: 'Approximate location (city, region, country) and ISP of a public IP address the user gives you.',
      parameters: { type: 'object', properties: { ip: { type: 'string', description: 'IPv4 or IPv6 address, e.g. "8.8.8.8"' } }, required: ['ip'] } },
  },
};

export const activeTools = () => Object.entries(TOOLS).filter(([, t]) => !t.enabled || t.enabled());
export const toolSpecs = () => activeTools().map(([name, t]) => ({ type: 'function', function: { name, ...t.schema } }));
