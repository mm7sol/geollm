# GeoLLM

Ask a place. Get the map. An AI agent that answers geographic questions by calling open, keyless data sources, then flies a dotted world map to the answer.

## What's live

| Tool | Source | Notes |
|---|---|---|
| `geocode`, `reverse_geocode` | Nominatim (OpenStreetMap) | 1 request/second, identified User-Agent, results cached 30 days |
| `get_weather` | Open-Meteo forecast | current, 3-day forecast, sunrise/sunset, time zone; cached 15 min |
| `get_air_quality` | Open-Meteo air quality (CAMS) | modelled values; cached 30 min |
| `get_route` | Valhalla on the FOSSGIS demo server | car, bike, walk; cached 7 days |
| `search_satellite_images` | Sentinel-2 L2A via Earth Search STAC (Element 84) | newest scenes under a cloud limit, preview image shown in the result card; cached 6 h |
| `aircraft_nearby`, `find_flight` | adsb.lol (community ADS-B, ODbL) | live aircraft near a point or by ICAO callsign; no key today; cached 20 s |
| `ships_nearby` | AISStream.io WebSocket | **only when `AISSTREAM_API_KEY` is set** (free account); listens ~8 s, so mostly moving ships; cached 60 s |
| `osm_nearby` | OpenStreetMap via Overpass | counts and lists cafés, hospitals, parks, EV chargers, buildings… around a point; 1 request/s; cached 1 day |
| `distance` | computed locally | great-circle distance and compass direction, drawn as an arc |
| `user_location` | Vercel IP geolocation headers | approximate city of the visitor, only for "near me" questions; never cached |
| `get_weather_history` | Open-Meteo historical archive (ERA5) | past daily high/low and total rain over the last N days; cached 1 day |
| `get_sea_conditions` | Open-Meteo marine | wave height, period, direction and sea-surface temperature on the coast; cached 30 min |
| `get_elevation` | Open-Meteo (Copernicus DEM) | ground elevation in metres and feet; cached 30 days |
| `get_timezone` | Open-Meteo | time zone, current local time, UTC offset, sunrise/sunset; cached 1 h |
| `get_isochrone` | Valhalla (FOSSGIS) | area reachable within N minutes by car, bike or on foot, drawn on the map; cached 3 days |
| `find_ip_location` | ipwho.is | approximate city, region, country and ISP of a public IP address |

Still **planned**: a satellite *basemap* (the map uses OpenStreetMap tiles today), PostGIS / Overture Maps, GDAL file conversion, road traffic, land parcels (Regrid needs a paid key). Driving **QGIS or ArcGIS** is marked **local only**: those MCP servers need the desktop app on your own computer, so they can be used from OpenCode but not from the public site.

Not used on purpose: the OpenSky API (needs OAuth2 since March 2026 and may block cloud IPs such as Vercel's).

## Layout

```
index.html          the page: Leaflet map, floating command bar, compact answer card
api/chat.js         POST /api/chat  { question } -> { text, tool, sources, points, zoom, route, image }
                    GET  /api/chat  -> { tools: [...] }  (lets the page label what is switched on)
api/mcp.js          remote MCP server over Streamable HTTP (POST /api/mcp), stateless
lib/agent.js        tool-calling loop on an OpenAI-compatible endpoint (OpenRouter or NVIDIA NIM)
lib/tools.js        the tools (direct API calls, no MCP process needed on serverless)
lib/store.js        cache + rate-limit counters (Upstash Redis if configured, memory otherwise)
mcp/server.mjs      the same tools as a local MCP server (stdio), for OpenCode
opencode.json       registers that local MCP server in OpenCode
test/agent.test.mjs offline test with mocked APIs (npm test)
```

## Run and deploy

1. `cp .env.example .env.local` and fill in `OPENROUTER_API_KEY` and `NOMINATIM_USER_AGENT` (app name + real contact).
2. Local: `npm i -g vercel` then `vercel dev`. Offline test: `npm test`.
3. Deploy: push to GitHub, import in Vercel, add the same environment variables in Project Settings.
4. Recommended: add **Upstash for Redis** from the Vercel Marketplace. Without it, rate limits and caches only live inside each serverless instance and are easy to bypass.

## Use the tools over MCP

Two ways to reach the same tools with any MCP client (Claude, Cursor, OpenCode, …):

- **Local (stdio)** — `node mcp/server.mjs`, registered in `opencode.json`.
- **Remote (Streamable HTTP)** — `https://<your-domain>/api/mcp`, stateless, no install. Add it to an MCP client as an HTTP server with that URL. Rate-limited per IP (`MCP_LIMIT_PER_IP`, default 300/day).

## Protections

- API key only in server env vars; the page never sees it.
- 10 questions per IP per day (`DAILY_LIMIT_PER_IP`) and a global daily cap (`DAILY_LIMIT_GLOBAL`). IPs are hashed with a salt.
- Questions limited to 200 characters; tool arguments validated; at most 5 model turns and 8 tool calls per question.
- Identical questions are answered from cache for 10 minutes (no model call, no quota).
- Set a **credit limit on the OpenRouter key** itself, as the hard spending cap.
- `ALLOWED_ORIGINS` rejects browser calls from other sites (not a security boundary against scripts, the rate limit is).

## Before production

- The Nominatim, Valhalla (FOSSGIS) and Open-Meteo free endpoints have usage policies. The Valhalla demo server is meant for development and testing, not production. Read each policy and move to a self-hosted or paid endpoint (`NOMINATIM_URL`, `VALHALLA_URL`) when traffic or commercial use requires it.
- Overpass (overpass-api.de): about 10,000 queries/day for occasional use, divided by 100 for a regular service, and "commercial use should use self-hosted or paid Overpass servers". Set `OVERPASS_URL` before going public at scale.
- adsb.lol: free and keyless today, rate limits are dynamic, and the project says an API key (obtained by feeding data) will be required in the future. Data is ODbL: keep the attribution in the footer.
- AISStream: keep the key server-side (browser connections are not allowed), max 3 connections per account, no uptime guarantee.
- Node.js 22 is required (global WebSocket for AISStream); `package.json` pins `22.x`.
- Free OpenRouter models are rate-limited and their prompts may be logged by the provider. Test multi-tool questions on every model in `OPENROUTER_MODELS`; not all of them call tools reliably.

## Attribution

Place data © OpenStreetMap contributors (ODbL). Weather data by Open-Meteo.com (CC BY 4.0). Air quality: Copernicus Atmosphere Monitoring Service. Satellite previews contain modified Copernicus Sentinel data (via Earth Search by Element 84). Aircraft data from adsb.lol (ODbL). Ship positions from AISStream.io. Map queries via the Overpass API. Elevation from the Copernicus DEM and historical/marine data from Open-Meteo. IP geolocation by ipwho.is. Base map tiles © OpenStreetMap contributors. Tool ideas from the public catalog github.com/sparkgeo/geo-mcp-servers. GeoLLM is not affiliated with Sparkgeo, Anthropic, Mapbox, Esri or any provider named here.

## $GEOLLM

An optional community coin. The tool exists with or without it. Holding it gives no guaranteed access, return or price increase. Memecoins are highly speculative; not financial advice. The official contract address will be published here, on the site and on the official X account.
