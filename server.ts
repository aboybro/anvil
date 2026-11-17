// server.ts — the HTTP server: routing, auth and the JSON envelope.
//
// Routes:
//   GET  /healthz                      health check, no auth
//   GET  /api/v3/                     API root, no auth, X-OAuth-Scopes
//   /api/v3/*                         the REST v3 dispatcher (src/rest.ts)
//   POST /api/graphql                GraphQL v4 (src/gql.ts)
//   POST /mcp                        the MCP endpoint (src/mcp.ts)
//   /{owner}/{repo}.git/*            git smart-HTTP (src/gitwire.ts)
//   /web/*                           the browsing interface (src/web.ts)
//
// Every API reply carries X-GitHub-Request-Id and application/json (except
// the git endpoints, which carry their own content types, and the web pages,
// which are HTML). A request without the bearer token is 401 everywhere
// except the API root, the health check and the web pages; a body that is not
// valid JSON is 400.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Vault } from './src/domain.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGit } from './src/gitwire.ts';
import { handleWeb } from './src/web.ts';
import { VIEWER_LOGIN } from './src/scenario.ts';

export interface ServerOptions {
  /** The expected bearer token. When unset, any non-empty Bearer is accepted. */
  token?: string;
  /** Maximum request body size, bytes. */
  maxBodyBytes?: number;
}

export function createServerApp(options: ServerOptions = {}): { server: ReturnType<typeof createServer>; vault: Vault } {
  const vault = new Vault();
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  function requestId(): string {
    requestCounter += 1;
    return `req-${requestCounter.toString(36)}-${requestCounter}`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId(),
      'content-length': Buffer.byteLength(text),
      ...extraHeaders,
    });
    res.end(text);
  }

  function sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'x-github-request-id': requestId(),
      'content-length': Buffer.byteLength(html),
    });
    res.end(html);
  }

  function authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? '';
    const bearer = /^Bearer\s+(.+)$/.exec(auth);
    if (bearer !== null) {
      if (expectedToken === '') return bearer[1]!.trim() !== '';
      return bearer[1] === expectedToken;
    }
    // Real git clients send the token as HTTP Basic credentials (as the
    // username with a blank password, or as the password): accept either.
    const basic = /^Basic\s+(.+)$/.exec(auth);
    if (basic !== null && expectedToken !== '') {
      try {
        const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
        if (decoded === `${expectedToken}:` || decoded === `:${expectedToken}`) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Read the whole request body as bytes: git packs are binary, so no UTF-8 round-trip. */
  function readBody(req: IncomingMessage): Promise<{ ok: true; raw: Buffer } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          failed = true;
          resolve({ ok: false, error: 'Request body too large' });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!failed) resolve({ ok: true, raw: Buffer.concat(chunks) });
      });
      req.on('error', () => {
        if (!failed) resolve({ ok: false, error: 'Failed to read request body' });
      });
    });
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // Health check and the API root need no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, {
            current_user_url: '/api/v3/user',
            repository_url: '/api/v3/repos/{owner}/{repo}',
            rate_limit_url: '/api/v3/rate_limit',
          }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // The browsing interface is public: plain HTML pages over the vault.
        if (path === '/web' || path === '/web/' || path.startsWith('/web/')) {
          if (method !== 'GET') {
            sendHtml(res, 405, '<h1>Method not allowed</h1>');
            return;
          }
          const segments = path.slice('/web/'.length).split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
          const result = handleWeb(vault, segments);
          sendHtml(res, result.status, result.body);
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="anvil", Bearer' });
          return;
        }

        // Git smart-HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1]!;
          const repoName = decodeURIComponent(gitMatch[2]!);
          const suffix = gitMatch[3] ?? '';
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: body.error });
            return;
          }
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
          const result = handleGit(vault, method, suffix, url.searchParams, body.raw, owner, repoName, gitProtocol);
          res.writeHead(result.status, {
            'content-type': result.contentType,
            'x-github-request-id': requestId(),
            'content-length': result.body.length,
          });
          res.end(result.body);
          return;
        }

        // GraphQL.
        if (path === '/api/graphql' && method === 'POST') {
          const body = await readBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: body.error });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const result = handleGraphQL(vault, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP.
        if (path === '/mcp' && method === 'POST') {
          const body = await readBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: body.error });
            return;
          }
          const result = handleMcp(vault, body.raw.toString('utf8'));
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = await readBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: body.error });
            return;
          }
          let parsed: unknown = null;
          if (body.raw.length > 0 && body.raw.toString('utf8').trim() !== '') {
            try {
              parsed = JSON.parse(body.raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const result = handleRest(vault, {
            method,
            segments: path.slice('/api/v3/'.length).split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment)),
            query: url.searchParams,
            body: parsed,
            origin: `http://${req.headers.host ?? '127.0.0.1'}`,
          });
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: `Internal Server Error: ${(e as Error).message}` });
        }
      }
    })();
  });

  return { server, vault };
}
