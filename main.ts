// main.ts — the entrypoint: the trial lifecycle around the anvil forge.
//
// The trial runs `node /bot/main.ts` beside the suite (the env). The contract:
//   1. Bind an ephemeral port (listen(0)); never bind 8080, the env owns it.
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register; the env records the
//      address the request came from plus N and dials the forge there. A 409
//      means another entry already registered first; that is not this
//      process's to fix.
//   3. Poll GET $MAKEFUN_ENV_URL/done until {"done": true}, then close the
//      server and exit 0. Never exit early: the suite's export is written
//      only after done.
//   4. A failed or slow register/done request is retried with a short
//      exponential backoff; the process only gives up on a contract error
//      (400/405 on register).
//
// main.ts builds the server from server.ts and nothing else. It makes no model
// call, reads no clock for any decision the suite could see, and holds no
// state of its own.

import { createServerApp } from './server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[anvil] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
/** How long a signalled shutdown waits for the server to close before forcing exit. */
const SHUTDOWN_GRACE_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or another
 * status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (shuttingDown) return;
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/**
 * Set once a signal asks for shutdown; the done-poll checks it each round so
 * a SIGTERM during the wait stops polling instead of hanging until done.
 */
let shuttingDown = false;

/** The bound server, so a signal handler can close it even before main() returns. */
let boundServer: ReturnType<typeof createServerApp>['server'] | null = null;

/**
 * A signal (SIGTERM from the env or a process manager, SIGINT from a human)
 * means stop cleanly: close the server, drop any idle keep-alive connections
 * so close does not hang, and exit 0. A second signal, or a close that takes
 * longer than SHUTDOWN_GRACE_MS, forces the exit.
 */
function requestShutdown(signal: string): void {
  if (shuttingDown) {
    process.exit(0);
  }
  shuttingDown = true;
  process.stdout.write(`[anvil] ${signal} received: shutting down\n`);
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  if (boundServer === null) {
    process.exit(0);
    return;
  }
  boundServer.close(() => process.exit(0));
  boundServer.closeAllConnections();
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  const { server } = createServerApp();
  boundServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[anvil] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[anvil] registered; waiting for the env to say done\n');

  await waitForDone();
  if (shuttingDown) return;
  server.close();
  process.stdout.write('[anvil] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[anvil] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
