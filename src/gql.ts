// gql.ts — GitHub GraphQL v4 at /api/graphql.
//
// A tokenizing parser turns a document into operations, fragments and value
// nodes; a generic walker then resolves fields through a resolver table keyed
// `Type.field`, with a schema table for validation and introspection. Adding a
// field means adding one resolver and one schema line, never touching the
// walker. The documents this serves are the ones gh and github-mcp-server
// actually send: viewer and repository reads, the __type feature probes,
// issue and pull-request lists with ordering and cursor pagination, node(id:),
// the five mutations, and operation batching (a JSON array of documents
// answers an array of results in order). An unknown field is HTTP 200 with an
// errors array naming it; an unknown repository is data.repository = null
// with no errors; an unauthenticated request is 401 (decided in server.ts).

import { Vault, VaultError, fail, type Issue, type Pull, type Repository } from './domain.ts';
import { decodeRelayId, relayId } from './views.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

class ParseError extends Error {}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        tokens.push({ kind: 'string', value: text.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let out = '';
      i += 1;
      for (;;) {
        if (i >= text.length) throw new ParseError('unterminated string');
        const c = text[i++]!;
        if (c === '"') break;
        if (c === '\\') {
          const next = text[i++] ?? '';
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        } else {
          out += c;
        }
      }
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
      if (match === null) throw new ParseError(`bad number at ${i}`);
      const raw = match[0];
      tokens.push(raw.includes('.') || /[eE]/.test(raw) ? { kind: 'float', value: Number(raw) } : { kind: 'int', value: Number(raw) });
      i += raw.length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      tokens.push({ kind: 'name', value: match![0] });
      i += match![0].length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser: tokens → document
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      if (this.isName('fragment')) {
        this.next();
        const name = this.readName();
        this.expectName('on');
        this.readName();
        fragments.set(name, this.parseSelectionSet());
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new ParseError('no operation in the document');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    if (this.isName('query') || this.isName('mutation')) {
      operation = this.nextName() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek()?.kind === 'name') name = this.nextName();
    if (this.isPunct('(')) this.skipBalanced('(', ')');
    return { operation, name, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new ParseError('unterminated selection set');
      if (this.isPunct('}')) {
        this.next();
        return selections;
      }
      if (this.isPunct('...')) {
        this.next();
        if (this.isName('on')) {
          this.next();
          const typeCondition = this.readName();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.readName() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
  }

  private parseField(): FieldNode {
    const first = this.readName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.readName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.isPunct('(')) {
      this.next();
      for (;;) {
        if (this.isPunct(')')) {
          this.next();
          break;
        }
        const argName = this.readName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@...) are ignored.
    while (this.isPunct('@')) {
      this.next();
      this.readName();
      if (this.isPunct('(')) this.skipBalanced('(', ')');
    }
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token === undefined) throw new ParseError('expected a value');
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.readName() };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      for (;;) {
        if (this.isPunct(']')) {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      for (;;) {
        if (this.isPunct('}')) {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`expected a value, got ${JSON.stringify(token)}`);
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (this.pos < this.tokens.length && depth > 0) {
      const token = this.next()!;
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
    if (depth !== 0) throw new ParseError(`unbalanced ${open}`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private isName(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'name' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new ParseError(`expected ${JSON.stringify(value)}`);
    this.next();
  }

  private expectName(value: string): void {
    if (!this.isName(value)) throw new ParseError(`expected ${value}`);
    this.next();
  }

  private readName(): string {
    const token = this.next();
    if (token === undefined || token.kind !== 'name') throw new ParseError('expected a name');
    return token.value;
  }

  private nextName(): string {
    return this.readName();
  }
}

// -------------------------------------------------------------------------------------------
// values and the schema surface
// -------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

/** The fields each type exposes (for validation and introspection). */
const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'createdAt', 'updatedAt', 'url', 'author', 'closedAt', 'mergedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE'];

// -------------------------------------------------------------------------------------------
// execution: the resolver table and the generic walker
// -------------------------------------------------------------------------------------------

/** A typed value: the walker's unit. Internal links ride on `__`-prefixed keys. */
interface TypedObj {
  readonly __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  vault: Vault;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

type Resolver = (ctx: ExecContext, parent: TypedObj, args: Record<string, unknown>, selections: SelectionNode[]) => unknown;

function typed(type: string, fields: Record<string, unknown>): TypedObj {
  return { __typename: type, ...fields };
}

function repoById(vault: Vault, id: number): Repository | null {
  for (const repo of vault.repos.values()) if (repo.id === id) return repo;
  return null;
}

function issueNode(vault: Vault, repo: Repository, issue: Issue): TypedObj {
  return typed('Issue', {
    __repo: repo,
    __issue: issue,
    id: relayId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: typed('User', { login: VIEWER_LOGIN }),
  });
}

function pullNode(vault: Vault, repo: Repository, pull: Pull): TypedObj {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return typed('PullRequest', {
    __repo: repo,
    __pull: pull,
    id: relayId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: vault.pullMergeable(repo, pull),
    body: pull.body,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    mergedAt: pull.mergedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: typed('User', { login: VIEWER_LOGIN }),
  });
}

function repositoryNode(vault: Vault, repo: Repository): TypedObj {
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return typed('Repository', {
    __repo: repo,
    id: relayId('Repository', repo.id, 0),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: typed('User', { login: repo.owner }),
    defaultBranchRef: headTip !== undefined ? typed('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/' }) : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  });
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** The issue connection for repository.issues: filter, order, page. */
function issuesConnection(ctx: ExecContext, repo: Repository, args: Record<string, unknown>): TypedObj {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toLowerCase()) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const orderField = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  let issues = [...repo.issues.values()];
  if (states !== null) issues = issues.filter((issue) => states.includes(issue.state));
  issues.sort((a, b) => {
    const bySeq = a.createdSeq - b.createdSeq;
    const byNumber = a.number - b.number;
    const key = orderField === 'NUMBER' ? byNumber : bySeq;
    const ordered = key !== 0 ? key : byNumber;
    return direction === 'ASC' ? ordered : -ordered;
  });
  const after = typeof args.after === 'string' && args.after !== '' ? decodeCursor(args.after) : null;
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const totalCount = issues.length;
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const hasNextPage = first !== undefined && issues.length > first;
  return typed('IssueConnection', {
    nodes: page.map((issue) => issueNode(ctx.vault, repo, issue)),
    edges: page.map((issue) => typed('IssueEdge', { node: issueNode(ctx.vault, repo, issue), cursor: encodeCursor(issue.number) })),
    pageInfo: typed('PageInfo', {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0]!.number) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
    }),
    totalCount,
  });
}

/** The pull-request connection for repository.pullRequests. */
function pullRequestsConnection(ctx: ExecContext, repo: Repository, args: Record<string, unknown>): TypedObj {
  let pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : undefined;
  if (first !== undefined) pulls = pulls.slice(0, first);
  return typed('PullRequestConnection', {
    nodes: pulls.map((pull) => pullNode(ctx.vault, repo, pull)),
    edges: pulls.map((pull) => typed('IssueEdge', { node: pullNode(ctx.vault, repo, pull), cursor: encodeCursor(pull.number) })),
    pageInfo: typed('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: repo.pulls.size,
  });
}

/** The changed-files connection for pullRequest.files. */
function pullFilesConnection(ctx: ExecContext, repo: Repository, pull: Pull, args: Record<string, unknown>): TypedObj {
  const files = ctx.vault.pullFiles(repo, pull);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const sliced = first !== undefined ? files.slice(0, first) : files;
  return typed('PullRequestChangedFileConnection', {
    nodes: sliced.map((file) => typed('PullRequestChangedFile', {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
    })),
    edges: [],
    pageInfo: typed('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
    totalCount: files.length,
  });
}

function nodeByGlobalId(ctx: ExecContext, id: string): TypedObj | null {
  const decoded = decodeRelayId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoById(ctx.vault, decoded.repoId);
    return repo === null ? null : repositoryNode(ctx.vault, repo);
  }
  if (decoded.kind === 'Issue') {
    const repo = repoById(ctx.vault, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    return !repo || !issue ? null : issueNode(ctx.vault, repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const repo = repoById(ctx.vault, decoded.repoId);
    const pull = repo?.pulls.get(decoded.number);
    return !repo || !pull ? null : pullNode(ctx.vault, repo, pull);
  }
  return null;
}

const RESOLVERS: Readonly<Record<string, Resolver>> = {
  'Query.viewer': (_ctx, _parent, _args, _sel) => typed('User', {
    login: VIEWER_LOGIN,
    id: String(VIEWER_ID),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    url: `https://github.com/${VIEWER_LOGIN}`,
  }),
  'Query.repository': (ctx, _parent, args) => {
    const repo = ctx.vault.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo === null ? null : repositoryNode(ctx.vault, repo);
  },
  'Query.node': (ctx, _parent, args) => nodeByGlobalId(ctx, String(args.id ?? '')),
  'Query.__type': (_ctx, _parent, args) => typed('__Type', { __typeName: String(args.name ?? '') }),
  'Query.__schema': () => null,
  'Mutation.createIssue': (ctx, _parent, args, selections) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeRelayId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') throw fail(422, 'Invalid repositoryId');
    const repo = repoById(ctx.vault, decoded.repoId);
    if (repo === null) throw fail(404, 'Repository not found');
    const issue = ctx.vault.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return typed('CreateIssuePayload', { issue: issueNode(ctx.vault, repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  },
  'Mutation.closeIssue': (ctx, _parent, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeRelayId(String(input.issueId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') throw fail(422, 'Invalid issueId');
    const repo = repoById(ctx.vault, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) throw fail(404, 'Issue not found');
    issue.state = 'closed';
    issue.closedAt = ctx.vault.nowIso();
    issue.updatedAt = issue.closedAt;
    return typed('CloseIssuePayload', { issue: issueNode(ctx.vault, repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  },
  'Mutation.createPullRequest': (ctx, _parent, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeRelayId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') throw fail(422, 'Invalid repositoryId');
    const repo = repoById(ctx.vault, decoded.repoId);
    if (repo === null) throw fail(404, 'Repository not found');
    const pull = ctx.vault.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    return typed('CreatePullRequestPayload', { pullRequest: pullNode(ctx.vault, repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  },
  'Mutation.mergePullRequest': (ctx, _parent, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeRelayId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.kind !== 'PullRequest') throw fail(422, 'Invalid pullRequestId');
    const repo = repoById(ctx.vault, decoded.repoId);
    const pull = repo?.pulls.get(decoded.number);
    if (!repo || !pull) throw fail(404, 'Pull request not found');
    ctx.vault.mergePull(repo, pull);
    return typed('MergePullRequestPayload', { pullRequest: pullNode(ctx.vault, repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
  },
  'Mutation.addComment': (ctx, _parent, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeRelayId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') throw fail(422, 'Invalid subjectId');
    const repo = repoById(ctx.vault, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) throw fail(404, 'Issue not found');
    const comment = ctx.vault.createComment(repo, issue.number, String(input.body ?? ''));
    const node = typed('Comment', {
      id: relayId('IssueComment', repo.id, issue.number, comment.id),
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: typed('User', { login: VIEWER_LOGIN }),
    });
    return typed('AddCommentPayload', {
      commentEdge: typed('CommentEdge', { node, cursor: encodeCursor(issue.number) }),
      subject: issueNode(ctx.vault, repo, issue),
      clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
    });
  },
  'Repository.issue': (ctx, parent, args) => {
    const repo = parent.__repo as Repository;
    const issue = repo.issues.get(Number(args.number));
    return issue === undefined ? null : issueNode(ctx.vault, repo, issue);
  },
  'Repository.issues': (ctx, parent, args) => issuesConnection(ctx, parent.__repo as Repository, args),
  'Repository.pullRequests': (ctx, parent, args) => pullRequestsConnection(ctx, parent.__repo as Repository, args),
  'Repository.pullRequest': (ctx, parent, args) => {
    const repo = parent.__repo as Repository;
    const pull = repo.pulls.get(Number(args.number));
    return pull === undefined ? null : pullNode(ctx.vault, repo, pull);
  },
  'PullRequest.files': (ctx, parent, args) => pullFilesConnection(ctx, parent.__repo as Repository, parent.__pull as Pull, args),
  '__Type.fields': (_ctx, parent) => {
    const name = String(parent.__typeName ?? '');
    return (SCHEMA_FIELDS[name] ?? []).map((fieldName) => typed('__Field', { name: fieldName, description: null, args: [], type: null }));
  },
  '__Type.enumValues': (_ctx, parent) => {
    const name = String(parent.__typeName ?? '');
    if (name !== 'SearchType') return [];
    return SEARCH_TYPE_VALUES.map((enumName) => typed('__EnumValue', { name: enumName, description: null }));
  },
  '__Type.name': (_ctx, parent) => String(parent.__typeName ?? ''),
  '__Type.kind': (_ctx, parent) => (String(parent.__typeName ?? '') === 'SearchType' ? 'ENUM' : 'OBJECT'),
  '__Type.description': () => null,
};

/** Is this a typed value the walker should recurse into? */
function isTyped(value: unknown): value is TypedObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as TypedObj).__typename === 'string';
}

/** Materialize a resolved value against a field's sub-selections. */
function materialize(ctx: ExecContext, value: unknown, selections: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => materialize(ctx, entry, selections));
  if (isTyped(value)) {
    if (selections.length === 0) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!key.startsWith('__')) out[key] = entry;
      }
      return out;
    }
    return select(ctx, value, selections);
  }
  return value;
}

/** Run a selection set against a typed value. */
function select(ctx: ExecContext, typedValue: TypedObj, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typedValue.__typename) continue;
      Object.assign(out, select(ctx, typedValue, selection.selections));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, select(ctx, typedValue, fragment));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const allowed = SCHEMA_FIELDS[typedValue.__typename] ?? [];
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typedValue.__typename}".` });
      continue;
    }
    const args = argsOf(field, ctx.variables);
    const resolver = RESOLVERS[`${typedValue.__typename}.${field.name}`];
    const value = resolver !== undefined ? resolver(ctx, typedValue, args, field.selections) : (typedValue[field.name] ?? null);
    out[key] = materialize(ctx, value, field.selections);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (an object or an array of operation documents). */
export function handleGraphQL(vault: Vault, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) results.push(executeOne(vault, entry));
    return { status: 200, body: results };
  }
  return { status: 200, body: executeOne(vault, body) };
}

function executeOne(vault: Vault, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) {
    return { errors: [{ message: 'The request body must be a JSON object with query and variables.' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'A query string is required.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parse();
  } catch (e) {
    return { errors: [{ message: (e as Error).message }] };
  }
  const operation = operationName === null ? document.operations[0]! : document.operations.find((op) => op.name === operationName) ?? document.operations[0]!;
  const ctx: ExecContext = { vault, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = select(ctx, typed(rootType, {}), operation.selections);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (e) {
    if (e instanceof VaultError) {
      return { data: null, errors: [{ message: e.message }] };
    }
    return { data: null, errors: [{ message: (e as Error).message }] };
  }
}
