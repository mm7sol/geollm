#!/usr/bin/env node
// Minimal MCP server (stdio, newline-delimited JSON-RPC) exposing the same tools
// as /api/chat. Lets OpenCode or any MCP client use GeoLLM's tools locally:
//   node mcp/server.mjs
// No dependencies. Logs go to stderr; stdout is reserved for protocol messages.

import { createInterface } from 'node:readline';
import { TOOLS, activeTools } from '../lib/tools.js';

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(m) {
  const { id, method, params = {} } = m;
  if (id === undefined) return; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize':
      return send({ id, result: {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'geollm-tools', version: '0.1.0' },
      } });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: activeTools().map(([name, t]) => ({
        name, description: t.schema.description, inputSchema: t.schema.parameters,
      })) } });
    case 'tools/call': {
      const tool = activeTools().some(([n]) => n === params.name) ? TOOLS[params.name] : null;
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
      try {
        const out = await tool.run(params.arguments || {});
        const text = JSON.stringify({ ...out.data, _source: out.source, _map_points: out.points });
        return send({ id, result: { content: [{ type: 'text', text }], isError: false } });
      } catch (e) {
        return send({ id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
      }
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(m).catch((e) => console.error('[geollm-mcp]', e));
});
console.error('[geollm-mcp] ready');
