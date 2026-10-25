// gifos-broadcast-mcp: the shared tools from gifos-mcp-core plus the
// broadcast tools and the host booth.
import { createContext, createServer as composeServer } from 'gifos-mcp-core';
import { registerBroadcastTools } from './tools.js';
import { BoothPool } from './booth.js';

export const NAME = 'gifos-broadcast-mcp';
export const VERSION = '0.1.2';
export const HTTP_PORT = 19521;
export const README = 'https://github.com/nwcnwc/gifos-broadcast-mcp#readme';

// The booths live on the shared context, so every server the process hands
// out (one per HTTP request) sees the same open booths.
function register(server, ctx) {
  if (!ctx.booths) ctx.booths = new BoothPool(ctx.cfg);
  registerBroadcastTools(server, ctx);
}

export const product = {
  name: NAME,
  version: VERSION,
  httpPort: HTTP_PORT,
  readme: README,
  register,
  onClose: (ctx) => (ctx.booths ? ctx.booths.closeAll() : null),
};

// One server over its own context (what the unit tests build). booths may
// be a stand-in.
export function createServer(args) {
  const ctx = createContext(args);
  if (args.booths) ctx.booths = args.booths;
  return composeServer({ name: NAME, version: VERSION, ctx, register });
}
