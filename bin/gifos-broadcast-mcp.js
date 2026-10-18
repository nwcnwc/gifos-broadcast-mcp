#!/usr/bin/env node
// gifos-broadcast-mcp: GifOS broadcasts for Grok Bot, run on your own computer.
//
//   gifos-broadcast-mcp                 MCP over stdio (what Grok Bot launches)
//   gifos-broadcast-mcp --http [port]   MCP over streamable HTTP on 127.0.0.1 (default port 19521)
import { runMain } from 'gifos-mcp-core';
import { product } from '../src/server.js';

await runMain(product);
