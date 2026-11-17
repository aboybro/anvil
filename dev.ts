// dev.ts — local development runner.
//
//   node --experimental-strip-types dev.ts [port]
//
// Serves the forge on 127.0.0.1 with the token from MAKEFUN_SHOP_TOKEN (or
// "dev-token" when unset). The bearer token for every API call is that token;
// the viewer login is derived from the scenario seed, so it is always
// adaiversen. The web interface is at /web/.

import { createServerApp } from './server.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'dev-token';
const { server } = createServerApp({ token });

server.listen(port, '127.0.0.1', () => {
  console.log(`anvil listening on http://127.0.0.1:${port} (token: ${token})`);
});
