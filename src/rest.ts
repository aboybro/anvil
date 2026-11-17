// rest.ts — GitHub REST v3 under /api/v3.
//
// The routes are a table, not a nest of conditionals: each entry names a
// method, a pattern of segments (`:param` takes one segment, `*rest` takes
// the remainder) and a handler. The first entry whose method and shape match
// wins; anything else is a JSON 404. Every reply is JSON with a message on
// errors, every status is the one the wire contract states, and a repository
// belongs to the login the bearer token names: the same name under another
// owner is 404, never 403.
//
// Besides the routes the suite drives, the table carries the wider v3 surface
// a client expects around them: search, rate_limit, users, git blobs/trees/
// commits, contributors, languages, the readme, issue labels and pull
// commits/reviews.

import { parseCommit, parseTree } from './loose.ts';
import {
  Vault,
  VaultError,
  fail,
  type Repository,
} from './domain.ts';
import { commentJson, issueJson, labelJson, pullJson, repoJson, userJson } from './views.ts';
import { VIEWER_LOGIN } from './scenario.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** The request's origin (scheme://host), for absolute pagination links. */
  origin: string;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (message = 'Not Found'): RestResult => ok(404, { message });
const badRequest = (message: string): RestResult => ok(400, { message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyField(body: unknown, field: string): unknown {
  return isRecord(body) ? body[field] : undefined;
}

function stringField(body: unknown, field: string): string | undefined {
  const value = bodyField(body, field);
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPageRaw = Number(query.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginationLinks(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const link = (p: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${origin}${path}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'));
  if (page > 1) parts.push(link(page - 1, 'prev'));
  parts.push(link(1, 'first'));
  parts.push(link(totalPages, 'last'));
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const link = paginationLinks(origin, path, query, page, perPage, items.length);
  if (link !== null) headers.link = link;
  return { slice, headers };
}

/** Parse "Name <email> 1234567890 +0000" into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') : '',
  };
}

/** One commit as the REST v3 commits list renders it. */
function commitJson(vault: Vault, repo: Repository, sha: string): Record<string, unknown> | null {
  const object = repo.objects.read(sha);
  if (!object || object.kind !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    node_id: Buffer.from(`Commit:${repo.id}:${sha}`).toString('base64'),
    commit: {
      author,
      committer,
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
  };
}

// -------------------------------------------------------------------------------------------
// the route table
// -------------------------------------------------------------------------------------------

type Handler = (vault: Vault, req: RestRequest, params: Record<string, string>) => RestResult;

interface Route {
  method: string;
  /** Segments; `:name` takes one, `*name` takes the rest (may be empty). */
  pattern: string[];
  handler: Handler;
}

/** Compile one pattern against path segments; null when it does not match. */
function matchPattern(pattern: readonly string[], segments: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let index = 0;
  for (let p = 0; p < pattern.length; p += 1) {
    const part = pattern[p]!;
    if (part.startsWith('*')) {
      params[part.slice(1)] = segments.slice(index).join('/');
      return params;
    }
    if (index >= segments.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = segments[index]!;
    } else if (part !== segments[index]) {
      return null;
    }
    index += 1;
  }
  return index === segments.length ? params : null;
}

function route(method: string, path: string, handler: Handler): Route {
  return { method, pattern: path.split('/').filter((part) => part !== ''), handler };
}

function repoOf(vault: Vault, params: Record<string, string>): Repository | null {
  return vault.getRepo(params.owner ?? '', params.name ?? '');
}

function needRepo(vault: Vault, params: Record<string, string>): Repository {
  const repo = repoOf(vault, params);
  if (repo === null) throw fail(404, 'Not Found');
  return repo;
}

function issueNumber(params: Record<string, string>): number {
  const number = Number(params.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw fail(404, 'Not Found');
  return number;
}

const ROUTES: readonly Route[] = [
  // The installation's version.
  route('GET', '/meta', () => ok(200, { installed_version: '1.0.0' })),
  // The token owner.
  route('GET', '/user', () => ok(200, userJson())),
  // Rate limit (a fixed, generous budget: the suite never hits it).
  route('GET', '/rate_limit', () => ok(200, {
    resources: { core: { limit: 5000, remaining: 4999, reset: 1_700_000_000 } },
    rate: { limit: 5000, remaining: 4999, reset: 1_700_000_000 },
  })),
  // A user by login (the viewer, or 404 for anyone else).
  route('GET', '/users/:login', (_vault, _req, params) => {
    if (params.login !== VIEWER_LOGIN) return notFound();
    return ok(200, userJson());
  }),
  // Search.
  route('GET', '/search/repositories', (vault, req) => {
    const q = (req.query.get('q') ?? '').toLowerCase();
    const items = vault.listRepos()
      .filter((repo) => q === '' || repo.name.toLowerCase().includes(q) || repo.description.toLowerCase().includes(q))
      .map(repoJson);
    return ok(200, { total_count: items.length, incomplete_results: false, items });
  }),
  route('GET', '/search/issues', (vault, req) => {
    const q = (req.query.get('q') ?? '').toLowerCase();
    const items: Record<string, unknown>[] = [];
    for (const repo of vault.listRepos()) {
      for (const issue of repo.issues.values()) {
        if (q === '' || issue.title.toLowerCase().includes(q) || issue.body.toLowerCase().includes(q)) {
          items.push(issueJson(repo, issue));
        }
      }
    }
    return ok(200, { total_count: items.length, incomplete_results: false, items });
  }),
  // The viewer's repositories: list (paginated) and create.
  route('GET', '/user/repos', (vault, req) => {
    const all = vault.listRepos();
    const { slice, headers } = paginate(all, req.query, req.origin, '/api/v3/user/repos');
    return ok(200, slice.map(repoJson), headers);
  }),
  route('POST', '/user/repos', (vault, req) => {
    const name = stringField(req.body, 'name');
    if (name === undefined || name === '') return ok(422, { message: 'name is required' });
    const repo = vault.createRepo(name, {
      private: bodyField(req.body, 'private') === true,
      description: stringField(req.body, 'description') ?? '',
    });
    return ok(201, repoJson(repo));
  }),
  // One repository: read, patch, delete.
  route('GET', '/repos/:owner/:name', (vault, _req, params) => {
    const repo = repoOf(vault, params);
    if (repo === null) return notFound();
    return ok(200, repoJson(repo));
  }),
  route('PATCH', '/repos/:owner/:name', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const description = stringField(req.body, 'description');
    if (description !== undefined) repo.description = description;
    const isPrivate = bodyField(req.body, 'private');
    if (typeof isPrivate === 'boolean') repo.private = isPrivate;
    repo.updatedAt = vault.nowIso();
    return ok(200, repoJson(repo));
  }),
  route('DELETE', '/repos/:owner/:name', (vault, _req, params) => {
    if (vault.getRepo(params.owner ?? '', params.name ?? '') === null) return notFound();
    vault.deleteRepo(params.owner ?? '', params.name ?? '');
    return { status: 204, body: null };
  }),
  // Branches.
  route('GET', '/repos/:owner/:name/branches', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    return ok(200, vault.listBranches(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha, url: `/api/v3/repos/${params.owner}/${params.name}/commits/${branch.sha}` },
      protected: false,
    })));
  }),
  route('GET', '/repos/:owner/:name/branches/:branch', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const branch = vault.listBranches(repo).find((entry) => entry.name === params.branch);
    if (!branch) return notFound();
    return ok(200, {
      name: branch.name,
      commit: { sha: branch.sha, url: `/api/v3/repos/${params.owner}/${params.name}/commits/${branch.sha}` },
      protected: false,
    });
  }),
  // Commits.
  route('GET', '/repos/:owner/:name/commits', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const tip = vault.resolveRef(repo, req.query.get('sha') ?? undefined);
    if (tip === null) {
      if (req.query.get('sha') !== null) return notFound();
      return ok(200, []);
    }
    const out: Record<string, unknown>[] = [];
    for (const sha of vault.listCommits(repo, tip)) {
      const rendered = commitJson(vault, repo, sha);
      if (rendered !== null) out.push(rendered);
    }
    return ok(200, out);
  }),
  route('GET', '/repos/:owner/:name/commits/:sha', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const rendered = commitJson(vault, repo, params.sha ?? '');
    if (rendered === null) return notFound();
    return ok(200, rendered);
  }),
  // Git refs: create, list, read one.
  route('POST', '/repos/:owner/:name/git/refs', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const ref = stringField(req.body, 'ref');
    const sha = stringField(req.body, 'sha');
    if (ref === undefined || sha === undefined) return badRequest('ref and sha are required');
    vault.createRef(repo, ref, sha);
    return ok(201, {
      ref,
      node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
      url: `/api/v3/repos/${params.owner}/${params.name}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${params.owner}/${params.name}/git/commits/${sha}` },
    });
  }),
  route('GET', '/repos/:owner/:name/git/refs', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return ok(200, refs.map(([ref, sha]) => ({
      ref,
      node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
      url: `/api/v3/repos/${params.owner}/${params.name}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${params.owner}/${params.name}/git/commits/${sha}` },
    })));
  }),
  route('GET', '/repos/:owner/:name/git/refs/*rest', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const ref = `refs/${params.rest ?? ''}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return ok(200, {
      ref,
      node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
      url: `/api/v3/repos/${params.owner}/${params.name}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${params.owner}/${params.name}/git/commits/${sha}` },
    });
  }),
  // Git objects: one commit, one tree, one blob.
  route('GET', '/repos/:owner/:name/git/commits/:sha', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const rendered = commitJson(vault, repo, params.sha ?? '');
    if (rendered === null) return notFound();
    return ok(200, rendered);
  }),
  route('GET', '/repos/:owner/:name/git/trees/:sha', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const sha = params.sha ?? '';
    const object = repo.objects.read(sha);
    if (!object || object.kind !== 'tree') return notFound();
    const recursive = req.query.get('recursive') === '1';
    const entries: Record<string, unknown>[] = [];
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.read(treeOid);
      if (!tree || tree.kind !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        entries.push({
          path,
          mode: entry.mode,
          type: entry.mode === '40000' ? 'tree' : 'blob',
          sha: entry.oid,
          size: entry.mode === '40000' ? undefined : repo.objects.read(entry.oid)?.data.length,
          url: `/api/v3/repos/${params.owner}/${params.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
        });
        if (recursive && entry.mode === '40000') walk(entry.oid, path);
      }
    };
    walk(sha, '');
    return ok(200, { sha, url: `/api/v3/repos/${params.owner}/${params.name}/git/trees/${sha}`, tree: entries, truncated: false });
  }),
  route('GET', '/repos/:owner/:name/git/blobs/:sha', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const sha = params.sha ?? '';
    const object = repo.objects.read(sha);
    if (!object || object.kind !== 'blob') return notFound();
    return ok(200, {
      sha,
      size: object.data.length,
      url: `/api/v3/repos/${params.owner}/${params.name}/git/blobs/${sha}`,
      content: object.data.toString('base64'),
      encoding: 'base64',
    });
  }),
  // Contents: create/update, read (file or directory), delete.
  route('PUT', '/repos/:owner/:name/contents/*path', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const contentPath = params.path ?? '';
    const message = stringField(req.body, 'message');
    const content = stringField(req.body, 'content');
    if (message === undefined || content === undefined) return badRequest('message and content are required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const result = vault.putContent(repo, {
      path: contentPath,
      content: bytes,
      message,
      branch: stringField(req.body, 'branch'),
      sha: stringField(req.body, 'sha'),
    });
    return ok(result.status, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        content: bytes.toString('base64'),
        sha: result.blobSha,
      },
      commit: { sha: result.commitSha, message, url: `/api/v3/repos/${params.owner}/${params.name}/commits/${result.commitSha}` },
    });
  }),
  route('GET', '/repos/:owner/:name/contents', (vault, req, params) => contentsRead(vault, req, params, '')),
  route('GET', '/repos/:owner/:name/contents/*path', (vault, req, params) => contentsRead(vault, req, params, params.path ?? '')),
  route('DELETE', '/repos/:owner/:name/contents/*path', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const contentPath = params.path ?? '';
    const message = stringField(req.body, 'message') ?? '';
    const result = vault.deleteContent(repo, {
      path: contentPath,
      message,
      branch: stringField(req.body, 'branch'),
      sha: stringField(req.body, 'sha'),
    });
    return ok(200, { commit: { sha: result.commitSha, message, url: `/api/v3/repos/${params.owner}/${params.name}/commits/${result.commitSha}` } });
  }),
  // The readme: the README at the default branch's tip.
  route('GET', '/repos/:owner/:name/readme', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const tip = vault.headCommit(repo);
    if (tip === null) return notFound();
    const flat = vault.flattenTree(repo, parseCommit(repo.objects.read(tip)!.data).tree);
    for (const candidate of ['README.md', 'README', 'readme.md', 'Readme.md']) {
      const entry = flat.get(candidate);
      if (!entry) continue;
      const blob = repo.objects.read(entry.oid);
      if (!blob) continue;
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: candidate,
        path: candidate,
        content: blob.data.toString('base64'),
        sha: entry.oid,
      });
    }
    return notFound();
  }),
  // Contributors and languages: small, honest answers from the store.
  route('GET', '/repos/:owner/:name/contributors', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    if (vault.headCommit(repo) === null) return ok(200, []);
    return ok(200, [{ ...userJson(), contributions: vault.listCommits(repo, vault.headCommit(repo)!).length }]);
  }),
  route('GET', '/repos/:owner/:name/languages', (vault, req, params) => {
    const repo = needRepo(vault, params);
    void req;
    void repo;
    return ok(200, {});
  }),
  // Labels.
  route('POST', '/repos/:owner/:name/labels', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const labelName = stringField(req.body, 'name');
    if (labelName === undefined || labelName === '') return ok(422, { message: 'name is required' });
    const label = vault.createLabel(repo, labelName, stringField(req.body, 'color') ?? 'ededed', stringField(req.body, 'description') ?? '');
    return ok(201, labelJson(label));
  }),
  route('GET', '/repos/:owner/:name/labels', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    return ok(200, [...repo.labels.values()].map(labelJson));
  }),
  route('GET', '/repos/:owner/:name/labels/:label', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const label = repo.labels.get(params.label ?? '');
    if (!label) return notFound();
    return ok(200, labelJson(label));
  }),
  route('DELETE', '/repos/:owner/:name/labels/:label', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    if (!repo.labels.delete(params.label ?? '')) return notFound();
    return { status: 204, body: null };
  }),
  // Issues.
  route('POST', '/repos/:owner/:name/issues', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const title = stringField(req.body, 'title');
    if (title === undefined || title === '') return ok(422, { message: 'title is required' });
    const rawLabels = bodyField(req.body, 'labels');
    const labelNames: string[] = [];
    if (Array.isArray(rawLabels)) {
      for (const entry of rawLabels) {
        if (typeof entry === 'string') labelNames.push(entry);
        else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
      }
    }
    const issue = vault.createIssue(repo, title, stringField(req.body, 'body') ?? '', labelNames);
    return ok(201, issueJson(repo, issue));
  }),
  route('GET', '/repos/:owner/:name/issues', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    const { slice, headers } = paginate(issues, req.query, req.origin, `/api/v3/repos/${params.owner}/${params.name}/issues`);
    return ok(200, slice.map((issue) => issueJson(repo, issue)), headers);
  }),
  route('GET', '/repos/:owner/:name/issues/:number', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    return ok(200, issueJson(repo, issue));
  }),
  route('PATCH', '/repos/:owner/:name/issues/:number', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    const state = stringField(req.body, 'state');
    if (state === 'open' || state === 'closed') {
      issue.state = state;
      issue.closedAt = state === 'closed' ? vault.nowIso() : null;
    }
    const title = stringField(req.body, 'title');
    if (title !== undefined) issue.title = title;
    const body = stringField(req.body, 'body');
    if (body !== undefined) issue.body = body;
    issue.updatedAt = vault.nowIso();
    return ok(200, issueJson(repo, issue));
  }),
  // Issue comments.
  route('POST', '/repos/:owner/:name/issues/:number/comments', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    const body = stringField(req.body, 'body');
    if (body === undefined) return badRequest('body is required');
    const comment = vault.createComment(repo, issue.number, body);
    return ok(201, commentJson(repo, issue, comment));
  }),
  route('GET', '/repos/:owner/:name/issues/:number/comments', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
  }),
  // Issue labels.
  route('GET', '/repos/:owner/:name/issues/:number/labels', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    return ok(200, issue.labels.map(labelJson));
  }),
  route('POST', '/repos/:owner/:name/issues/:number/labels', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const issue = repo.issues.get(issueNumber(params));
    if (issue === undefined) return notFound();
    const rawLabels = bodyField(req.body, 'labels');
    const names: string[] = Array.isArray(rawLabels) ? rawLabels.filter((entry): entry is string => typeof entry === 'string') : [];
    if (names.length === 0 && typeof bodyField(req.body, 'name') === 'string') names.push(bodyField(req.body, 'name') as string);
    for (const name of names) {
      const label = repo.labels.get(name);
      if (!label) return ok(422, { message: `Label does not exist: ${name}` });
      if (!issue.labels.includes(label)) issue.labels.push(label);
    }
    issue.updatedAt = vault.nowIso();
    return ok(200, issue.labels.map(labelJson));
  }),
  // Pull requests.
  route('POST', '/repos/:owner/:name/pulls', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const title = stringField(req.body, 'title');
    const headRef = stringField(req.body, 'head');
    const baseRef = stringField(req.body, 'base');
    if (title === undefined || headRef === undefined || baseRef === undefined) {
      return ok(422, { message: 'title, head and base are required' });
    }
    const clean = (ref: string): string => ref.split(':').pop() ?? ref;
    const pull = vault.createPull(repo, title, stringField(req.body, 'body') ?? '', clean(headRef), clean(baseRef));
    return ok(201, pullJson(repo, pull));
  }),
  route('GET', '/repos/:owner/:name/pulls', (vault, req, params) => {
    const repo = needRepo(vault, params);
    const state = req.query.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    const { slice, headers } = paginate(pulls, req.query, req.origin, `/api/v3/repos/${params.owner}/${params.name}/pulls`);
    return ok(200, slice.map((pull) => pullJson(repo, pull)), headers);
  }),
  route('GET', '/repos/:owner/:name/pulls/:number', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const pull = repo.pulls.get(issueNumber(params));
    if (pull === undefined) return notFound();
    return ok(200, pullJson(repo, pull));
  }),
  route('GET', '/repos/:owner/:name/pulls/:number/files', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const pull = repo.pulls.get(issueNumber(params));
    if (pull === undefined) return notFound();
    return ok(200, vault.pullFiles(repo, pull));
  }),
  route('GET', '/repos/:owner/:name/pulls/:number/commits', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const pull = repo.pulls.get(issueNumber(params));
    if (pull === undefined) return notFound();
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
    const out: Record<string, unknown>[] = [];
    for (const sha of vault.listCommits(repo, headTip)) {
      const rendered = commitJson(vault, repo, sha);
      if (rendered !== null) out.push(rendered);
    }
    return ok(200, out);
  }),
  route('GET', '/repos/:owner/:name/pulls/:number/reviews', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    if (repo.pulls.get(issueNumber(params)) === undefined) return notFound();
    return ok(200, []);
  }),
  route('PUT', '/repos/:owner/:name/pulls/:number/merge', (vault, _req, params) => {
    const repo = needRepo(vault, params);
    const pull = repo.pulls.get(issueNumber(params));
    if (pull === undefined) return notFound();
    const result = vault.mergePull(repo, pull);
    return ok(200, result);
  }),
];

/**
 * First-segment index over the route table: dispatch only tries routes whose
 * method matches and whose first literal segment matches the request's first
 * segment (or whose first segment is a parameter, bucketed under '*'). The
 * hot read/write paths then match against a handful of candidates instead
 * of scanning the whole table.
 */
const ROUTE_INDEX = new Map<string, Route[]>();
for (const routeDef of ROUTES) {
  const first = routeDef.pattern[0];
  const bucket = first === undefined || first.startsWith(':') || first.startsWith('*') ? '*' : first;
  const key = `${routeDef.method}\0${bucket}`;
  const list = ROUTE_INDEX.get(key);
  if (list === undefined) ROUTE_INDEX.set(key, [routeDef]);
  else list.push(routeDef);
}

/** GET /contents (file or directory) shared by the exact and wildcard routes. */
function contentsRead(vault: Vault, req: RestRequest, params: Record<string, string>, contentPath: string): RestResult {
  const repo = needRepo(vault, params);
  const read = vault.readContent(repo, { path: contentPath, ref: req.query.get('ref') ?? undefined });
  if (read === null) return notFound();
  if (read.kind === 'file') {
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: read.blob.length,
      name: contentPath.split('/').pop() ?? contentPath,
      path: contentPath,
      content: read.blob.toString('base64'),
      sha: read.sha,
    });
  }
  return ok(200, read.entries.map((entry) => ({
    type: entry.type,
    size: 0,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
  })));
}

/** The dispatcher: one REST call in, one RestResult out. Never throws. */
export function handleRest(vault: Vault, req: RestRequest): RestResult {
  try {
    const first = req.segments[0] ?? '';
    const candidates = [
      ...(ROUTE_INDEX.get(`${req.method}\0${first}`) ?? []),
      ...(ROUTE_INDEX.get(`${req.method}\0*`) ?? []),
    ];
    for (const routeDef of candidates) {
      const params = matchPattern(routeDef.pattern, req.segments);
      if (params === null) continue;
      return routeDef.handler(vault, req, params);
    }
    return notFound();
  } catch (e) {
    if (e instanceof VaultError) return ok(e.status, { message: e.message });
    return ok(500, { message: (e as Error).message });
  }
}
