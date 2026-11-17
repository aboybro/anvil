// mcp.ts — the Model Context Protocol endpoint at /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP, answering application/json. The modern era
// (revision 2026-07-28) negotiates through server/discover, which answers the
// server's identity, capabilities and supportedVersions; the handshake era
// (2025-11-25 and earlier) negotiates through initialize and
// notifications/initialized with an optional Mcp-Session-Id.
//
// The tools are a registry, not a switch: each entry names its schema and a
// handler that runs against the vault, so the tools act on the same store as
// REST and a repository or an issue created over MCP reads back over /api/v3
// as the same object. An unknown tool is JSON-RPC -32602, never HTTP 500; a
// body that is not JSON is HTTP 400 with -32700; a tools/call missing a
// required argument is isError:true.

import { Vault, VaultError, type Repository } from './domain.ts';
import { issueJson, pullJson, repoJson } from './views.ts';
import { VIEWER_LOGIN } from './scenario.ts';

export const SERVER_NAME = 'anvil';
export const SERVER_VERSION = '1.0.0';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
  run: (vault: Vault, args: Record<string, unknown>) => unknown;
}

/** A tool result: a text block carrying the JSON plus the structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Split "owner/repo" (or "owner") out of the call's arguments. */
function repoTarget(args: Record<string, unknown>): { owner: string; name: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || name === '') && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      if (owner === '') owner = args.full_name.slice(0, slash);
      if (name === '') name = args.full_name.slice(slash + 1);
    }
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, name };
}

function needRepo(vault: Vault, args: Record<string, unknown>): Repository {
  const { owner, name } = repoTarget(args);
  const repo = vault.getRepo(owner, name);
  if (repo === null) throw new VaultError(404, `Repository not found: ${owner}/${name}`);
  return repo;
}

const cleanRef = (ref: string): string => ref.split(':').pop() ?? ref;

/** The tool registry: schema and handler together, frozen at load. */
const TOOL_DEFS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
    run: (vault, args) => repoJson(vault.createRepo(String(args.name), {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    })),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
    run: (vault, args) => repoJson(needRepo(vault, args)),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      return issueJson(repo, vault.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []));
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return issues.map((issue) => issueJson(repo, issue));
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      const pull = vault.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', cleanRef(String(args.head)), cleanRef(String(args.base)));
      return pullJson(repo, pull);
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new VaultError(404, `Pull request not found: #${args.pull_number}`);
      const result = vault.mergePull(repo, pull);
      return { sha: result.sha, merged: true, message: result.message, number: pull.number };
    },
  }),
  Object.freeze({
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({}),
      required: Object.freeze([]),
    }),
    run: (vault) => vault.listRepos().map(repoJson),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue by repository and number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        issue_number: Object.freeze({ type: 'integer', description: 'The issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new VaultError(404, `Issue not found: #${args.issue_number}`);
      return issueJson(repo, issue);
    },
  }),
  Object.freeze({
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'The repository full name, "owner/repo".' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
    run: (vault, args) => {
      const repo = needRepo(vault, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return pulls.map((pull) => pullJson(repo, pull));
    },
  }),
]);

/** The tool list as tools/list answers it: built once, byte-identical every time. */
export const TOOLS: readonly { name: string; description: string; inputSchema: ToolDef['inputSchema'] }[] = Object.freeze(
  TOOL_DEFS.map((tool) => Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
);

function findTool(name: string): ToolDef | undefined {
  const exact = TOOL_DEFS.find((tool) => tool.name === name);
  if (exact !== undefined) return exact;
  // A server prefix is allowed (github__create_issue): match by suffix,
  // case-insensitively.
  const wanted = name.toLowerCase();
  return TOOL_DEFS.find((tool) => wanted === tool.name || wanted.endsWith(`__${tool.name}`) || wanted.endsWith(`_${tool.name}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** The missing required arguments of a call, by the tool's own schema. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return false;
    // full_name can stand in for owner + repo.
    if ((name === 'owner' || name === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) return false;
    return true;
  });
}

function callTool(vault: Vault, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) throw new VaultError(-32602, `Unknown tool: ${name}`);
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  try {
    return toolResult(tool.run(vault, args));
  } catch (e) {
    if (e instanceof VaultError) return toolError(e.message);
    return toolError((e as Error).message);
  }
}

/**
 * Handle one POST /mcp body. `raw` is the request text: a body that is not JSON
 * is HTTP 400 with -32700. Auth is decided by the caller (server.ts) before this.
 */
export function handleMcp(vault: Vault, raw: string): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (!isRecord(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // Notifications carry no id and expect no JSON-RPC answer.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers: { 'mcp-session-id': 'mcp-session-1' },
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(vault, toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    } catch (e) {
      if (e instanceof VaultError && (e.status === -32602 || e.status === -32601)) {
        return { status: 200, body: rpcError(id, e.status, e.message) };
      }
      return { status: 200, body: rpcResult(id, toolError((e as Error).message)) };
    }
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
