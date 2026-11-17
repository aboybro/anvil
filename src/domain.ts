// domain.ts — the forge's whole state, in memory.
//
// One Vault holds every repository: its loose objects and refs, its issues,
// pull requests, labels and comments. The object database is a LooseStore (raw
// deflated objects, parsed lazily); the collaboration records are plain
// objects in maps. Nothing is read from disk and nothing reaches the network.
//
// Determinism: every timestamp comes from a fixed base (MAKEFUN_TRIAL_NOW when
// the trial sets it, else a constant) plus a monotonic counter, and every id
// from a counter. Two runs that receive the same requests in the same order
// build the same bytes, which is what a replay compares.

import {
  LooseStore,
  ZERO_OID,
  buildCommit,
  buildTree,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  reachable,
  walkCommits,
  writePack,
  type ObjectKind,
} from './loose.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';

export class VaultError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function fail(status: number, message: string): VaultError {
  return new VaultError(status, message);
}

// -------------------------------------------------------------------------------------------
// records
// -------------------------------------------------------------------------------------------

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: Comment[];
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string;
  readonly baseShaAtCreate: string;
  readonly mergeBaseSha: string;
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repository {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  /** The object database: loose objects by id. */
  readonly objects: LooseStore;
  /** Refs by full name (refs/heads/main, refs/tags/v1). */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** One counter for issues and pull requests, as GitHub numbers them together. */
  nextNumber: number;
  /** Bumped on any object or ref change; the pack cache keys on it. */
  version: number;
  /** Pack bytes keyed by the fetch that built them. */
  readonly packCache: Map<string, Buffer>;
}

// -------------------------------------------------------------------------------------------
// the vault
// -------------------------------------------------------------------------------------------

const DEFAULT_BRANCH = 'main';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const BASE_EPOCH = (() => {
  const parsed = TRIAL_NOW === '' ? Number.NaN : Date.parse(TRIAL_NOW) / 1000;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1_700_000_000;
})();

/** Added/removed line counts between two texts, by multiset difference. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export class Vault {
  readonly repos = new Map<string, Repository>();
  private nextId = 1_000_000;
  private tick = 0;
  private seq = 0;

  /** The next deterministic timestamp, ISO-8601, one second later than the last. */
  nowIso(): string {
    const sec = BASE_EPOCH + this.tick;
    this.tick += 1;
    return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The next deterministic timestamp as epoch seconds (for git objects). */
  nowEpoch(): number {
    return BASE_EPOCH + this.tick++;
  }

  private newId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -------------------------------------------------------------------------------- repos

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repository {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      throw fail(422, `Invalid repository name ${JSON.stringify(name)}`);
    }
    if (this.repos.has(name)) throw fail(422, 'Repository already exists');
    const createdAt = this.nowIso();
    const repo: Repository = {
      id: this.newId(),
      name,
      owner: VIEWER_LOGIN,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdAt,
      updatedAt: createdAt,
      pushedAt: null,
      objects: new LooseStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      version: 0,
      packCache: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** The repository, or null when the owner is not the token owner or the name is unknown. */
  getRepo(owner: string, name: string): Repository | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(name);
  }

  /** The viewer's repositories, in creation order. */
  listRepos(): Repository[] {
    return [...this.repos.values()];
  }

  // -------------------------------------------------------------------------------- objects

  /** Read an object from a repository, or undefined. */
  readObject(repo: Repository, oid: string): { kind: ObjectKind; data: Buffer } | undefined {
    return repo.objects.read(oid);
  }

  /** Store an object; returns its id. */
  writeObject(repo: Repository, kind: ObjectKind, data: Buffer): string {
    return repo.objects.put(kind, data);
  }

  /** Ingest a received packfile into the repository's object database. */
  ingestPack(repo: Repository, pack: Buffer): void {
    const read = readPack(pack, { resolveBase: (oid) => repo.objects.read(oid) });
    for (const [oid, object] of read.objects) {
      repo.objects.putLoose(oid, object.kind, object.data);
    }
  }

  /** The tip of a ref, or null. */
  refTip(repo: Repository, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The default branch's tip commit, or null when the repository is unborn. */
  headCommit(repo: Repository): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  // -------------------------------------------------------------------------------- trees

  /** A tree flattened to path → {oid, mode}. */
  flattenTree(repo: Repository, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const stack: { oid: string; prefix: string }[] = [{ oid: treeOid, prefix: '' }];
    while (stack.length > 0) {
      const { oid, prefix } = stack.pop()!;
      const object = repo.objects.read(oid);
      if (!object || object.kind !== 'tree') continue;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') stack.push({ oid: entry.oid, prefix: path });
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** Build (and store) the tree for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repository, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return repo.objects.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob at `path` in the tree of `commitOid`, or null. */
  blobAtPath(repo: Repository, commitOid: string, path: string): { oid: string; mode: string } | null {
    const commit = repo.objects.read(commitOid);
    if (!commit || commit.kind !== 'commit') return null;
    return this.flattenTree(repo, parseCommit(commit.data).tree).get(path) ?? null;
  }

  /** The tree of `commitOid` with `path` set to `blobOid` (or removed when null). */
  updatePath(repo: Repository, commitOid: string | null, path: string, blobOid: string | null): string {
    let flat: Map<string, { oid: string; mode: string }>;
    if (commitOid === null) {
      flat = new Map();
    } else {
      const commit = repo.objects.read(commitOid);
      if (!commit || commit.kind !== 'commit') throw fail(404, 'Commit not found');
      flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    }
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { oid: blobOid, mode: '100644' });
    return this.buildTreeFromFlat(repo, flat);
  }

  // -------------------------------------------------------------------------------- commits

  /** Store a commit object and return its id. */
  createCommit(
    repo: Repository,
    fields: { tree: string; parents: readonly string[]; message: string },
  ): string {
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
      author,
      committer: author,
      timestamp: this.nowEpoch(),
    });
    return repo.objects.put('commit', data);
  }

  /** Commits reachable from `tip`, newest first. */
  listCommits(repo: Repository, tip: string): string[] {
    return walkCommits(tip, (oid) => repo.objects.read(oid));
  }

  // -------------------------------------------------------------------------------- contents

  /**
   * PUT /contents: create or update one file with a commit. `branch` names the
   * branch (the default branch when omitted); a branch that does not exist yet
   * is created from the default branch's tip, so a contents write can open a
   * branch.
   */
  putContent(
    repo: Repository,
    options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; blobSha: string; status: 201 | 200 } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      tip = this.headCommit(repo);
      if (tip !== null) repo.refs.set(ref, tip);
    }
    const current = tip === null ? null : this.blobAtPath(repo, tip, options.path);
    const blobOid = repo.objects.put('blob', options.content);
    let status: 201 | 200;
    if (current !== null) {
      if (options.sha === undefined) throw fail(422, 'sha is required to update a file');
      if (options.sha.toLowerCase() !== current.oid.toLowerCase()) throw fail(409, 'sha does not match the current file');
      status = 200;
    } else {
      if (options.sha !== undefined) throw fail(422, 'sha does not match: the file does not exist');
      status = 201;
    }
    const tree = this.updatePath(repo, tip, options.path, blobOid);
    const commitSha = this.createCommit(repo, {
      tree,
      parents: tip === null ? [] : [tip],
      message: options.message,
    });
    repo.refs.set(ref, commitSha);
    repo.version += 1;
    repo.updatedAt = this.nowIso();
    repo.pushedAt = repo.updatedAt;
    return { commitSha, blobSha: blobOid, status };
  }

  /** DELETE /contents: remove one file with a commit. */
  deleteContent(
    repo: Repository,
    options: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) throw fail(404, 'Not Found');
    const current = this.blobAtPath(repo, tip, options.path);
    if (current === null) throw fail(404, 'Not Found');
    if (options.sha !== undefined && options.sha.toLowerCase() !== current.oid.toLowerCase()) {
      throw fail(409, 'sha does not match the current file');
    }
    const tree = this.updatePath(repo, tip, options.path, null);
    const commitSha = this.createCommit(repo, { tree, parents: [tip], message: options.message });
    repo.refs.set(ref, commitSha);
    repo.version += 1;
    repo.updatedAt = this.nowIso();
    repo.pushedAt = repo.updatedAt;
    return { commitSha };
  }

  /** Read one path at a ref: a file's blob, a directory's entries, or null when absent. */
  readContent(
    repo: Repository,
    options: { path: string; ref?: string },
  ): { kind: 'file'; blob: Buffer; sha: string } | { kind: 'dir'; entries: { name: string; path: string; sha: string; type: 'file' | 'dir' }[] } | null {
    const tip = this.resolveRef(repo, options.ref);
    if (tip === null) return null;
    const commit = repo.objects.read(tip);
    if (!commit || commit.kind !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    const flat = this.flattenTree(repo, treeOid);
    const direct = flat.get(options.path);
    if (direct) {
      const blob = repo.objects.read(direct.oid);
      if (!blob) return null;
      return { kind: 'file', blob: blob.data, sha: direct.oid };
    }
    const prefix = options.path === '' ? '' : `${options.path}/`;
    const children = new Map<string, { sha: string; type: 'file' | 'dir' }>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { sha: entry.oid, type: 'file' });
      } else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) {
          const dirTreeOid = this.treeAtPath(repo, treeOid, `${prefix}${dir}`);
          if (dirTreeOid !== null) children.set(dir, { sha: dirTreeOid, type: 'dir' });
        }
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .map(([name, entry]) => ({ name, path: prefix + name, sha: entry.sha, type: entry.type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  /** The tree oid of a directory path inside a tree, or null. */
  private treeAtPath(repo: Repository, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (const segment of segments) {
      const object = repo.objects.read(current);
      if (!object || object.kind !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  /**
   * Resolve a ref-ish to a commit id: a branch name, a full ref, a 40-hex oid, or
   * nothing (the default branch). Null when it names nothing the repo holds.
   */
  resolveRef(repo: Repository, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') return this.headCommit(repo);
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.read(tag);
      if (object?.kind === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return null;
  }

  // -------------------------------------------------------------------------------- branches / refs

  createRef(repo: Repository, ref: string, sha: string): void {
    if (!ref.startsWith('refs/')) throw fail(422, 'Invalid ref');
    if (!isOid(sha) || !repo.objects.has(sha)) throw fail(422, 'Invalid sha');
    if (repo.refs.has(ref)) throw fail(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.version += 1;
  }

  listBranches(repo: Repository): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // -------------------------------------------------------------------------------- issues / labels

  createLabel(repo: Repository, name: string, color: string, description = ''): Label {
    if (repo.labels.has(name)) throw fail(422, 'Label already exists');
    const label: Label = { id: this.newId(), name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repository, title: string, body: string, labelNames: readonly string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) throw fail(422, `Label does not exist: ${name}`);
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const createdAt = this.nowIso();
    const issue: Issue = {
      id: this.newId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      createdSeq: this.nextSeq(),
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repository, issueNumber: number, body: string): Comment {
    const issue = repo.issues.get(issueNumber);
    if (!issue) throw fail(404, 'Not Found');
    const createdAt = this.nowIso();
    const comment: Comment = { id: this.newId(), body, createdAt, updatedAt: createdAt };
    issue.comments.push(comment);
    issue.updatedAt = createdAt;
    return comment;
  }

  // -------------------------------------------------------------------------------- pull requests

  createPull(repo: Repository, title: string, body: string, head: string, base: string): Pull {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) throw fail(422, `Head branch does not exist: ${head}`);
    if (baseTip === undefined) throw fail(422, `Base branch does not exist: ${base}`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        throw fail(422, 'A pull request already exists for this head and base');
      }
    }
    const number = repo.nextNumber++;
    const createdAt = this.nowIso();
    const pull: Pull = {
      id: this.newId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headShaAtCreate: headTip,
      baseShaAtCreate: baseTip,
      mergeBaseSha: baseTip,
      createdSeq: this.nextSeq(),
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The changed files of a pull request, against its merge base. */
  pullFiles(repo: Repository, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
    const headCommit = repo.objects.read(headTip);
    const baseCommit = repo.objects.read(pull.mergeBaseSha);
    if (!headCommit || headCommit.kind !== 'commit' || !baseCommit || baseCommit.kind !== 'commit') return [];
    const base = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const head = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const from = base.get(path);
      const to = head.get(path);
      if (from && to && from.oid === to.oid) continue;
      const oldText = from ? (repo.objects.read(from.oid)?.data.toString('utf8') ?? '') : '';
      const newText = to ? (repo.objects.read(to.oid)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      const status = !from ? 'added' : !to ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** 'MERGEABLE' | 'CONFLICTING' for an open pull request (UNKNOWN when it has no tips). */
  pullMergeable(repo: Repository, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const merged = this.threeWayMerge(repo, pull.mergeBaseSha, headTip, baseTip);
    return merged === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * The three-way merge of `headTip`'s changes (against `mergeBase`) onto
   * `currentTip`. Returns the merged flat tree, or null when the same path
   * changed both ways.
   */
  threeWayMerge(repo: Repository, mergeBase: string, headTip: string, currentTip: string): Map<string, { oid: string; mode: string }> | null {
    const baseCommit = repo.objects.read(mergeBase);
    const headCommit = repo.objects.read(headTip);
    const currentCommit = repo.objects.read(currentTip);
    if (!baseCommit || baseCommit.kind !== 'commit' || !headCommit || headCommit.kind !== 'commit' || !currentCommit || currentCommit.kind !== 'commit') {
      return null;
    }
    const base = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const head = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const current = this.flattenTree(repo, parseCommit(currentCommit.data).tree);
    const result = new Map(current);
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const c = current.get(path);
      const bOid = b?.oid ?? null;
      const hOid = h?.oid ?? null;
      const cOid = c?.oid ?? null;
      if (hOid === bOid) continue; // the head did not change this path
      if (cOid === bOid) {
        // Only the head changed it: take the head's version (or its deletion).
        if (h === undefined) result.delete(path);
        else result.set(path, h);
      } else if (hOid === cOid) {
        continue; // both changed it the same way
      } else {
        return null; // both changed it differently: a conflict
      }
    }
    return result;
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repository, pull: Pull): { sha: string; merged: true; message: string } {
    if (pull.state !== 'open') throw fail(405, 'Pull request is not open');
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) throw fail(405, 'Pull request is not mergeable');
    const merged = this.threeWayMerge(repo, pull.mergeBaseSha, headTip, baseTip);
    if (merged === null) throw fail(405, 'Merge conflict');
    const tree = this.buildTreeFromFlat(repo, merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const sha = this.createCommit(repo, { tree, parents: [baseTip], message });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    repo.version += 1;
    repo.updatedAt = this.nowIso();
    repo.pushedAt = repo.updatedAt;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = pull.updatedAt;
    pull.mergeCommitSha = sha;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }

  // -------------------------------------------------------------------------------- fetch selection

  /**
   * The objects a fetch of `wants` must send, given what the client `haves`
   * and the shallow boundaries it already holds. A have's ancestors are
   * excluded — except across a shallow boundary, whose parents the client does
   * not hold.
   */
  selectFetchObjects(
    repo: Repository,
    wants: readonly string[],
    haves: readonly string[],
    shallowBoundaries: readonly string[],
    depth: number | undefined,
  ): { objects: { kind: ObjectKind; data: Buffer }[]; shallow: string[]; unshallow: string[] } {
    const read = (oid: string) => repo.objects.read(oid);
    const boundarySet = new Set(shallowBoundaries);
    // The wanted commits, cut at `depth` (1 = the wants themselves, no parents).
    const wanted = new Set<string>();
    const newShallow: string[] = [];
    const queue: { oid: string; level: number }[] = [];
    const seenCommit = new Set<string>();
    const pushWant = (oid: string): void => {
      const object = read(oid);
      if (!object) return;
      if (object.kind === 'tag') {
        wanted.add(oid);
        queue.push({ oid: parseTag(object.data).object, level: 1 });
      } else if (object.kind === 'commit') {
        queue.push({ oid, level: 1 });
      }
    };
    for (const want of wants) pushWant(want);
    for (let index = 0; index < queue.length; index += 1) {
      const { oid, level } = queue[index]!;
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const object = read(oid);
      if (!object || object.kind !== 'commit') continue;
      if (depth !== undefined && level > depth) continue;
      wanted.add(oid);
      if (depth !== undefined && level === depth) newShallow.push(oid);
      if (depth === undefined || level < depth) {
        for (const parent of parseCommit(object.data).parents) {
          if (!seenCommit.has(parent)) queue.push({ oid: parent, level: level + 1 });
        }
      }
    }
    // The wanted closure: the wanted commits plus each one's tree (trees and
    // blobs), and — for a full fetch — every ancestor commit and its tree.
    const wantedClosure = new Set<string>();
    const addTreeClosure = (treeOid: string): void => {
      try {
        for (const reached of reachable([treeOid], read)) wantedClosure.add(reached);
      } catch {
        // A tree the store does not hold contributes nothing.
      }
    };
    for (const oid of wanted) {
      wantedClosure.add(oid);
      const object = read(oid);
      if (object?.kind === 'commit') addTreeClosure(parseCommit(object.data).tree);
    }
    if (depth === undefined) {
      for (const oid of wanted) {
        try {
          for (const reached of reachable([oid], read)) wantedClosure.add(reached);
        } catch {
          // A want the store does not hold contributes nothing.
        }
      }
    }
    // What the client already holds: the closure of its haves, stopping at the
    // shallow boundaries it named (their parents are not held).
    const held = new Set<string>();
    const heldQueue: string[] = [...haves];
    const heldSeen = new Set<string>();
    while (heldQueue.length > 0) {
      const oid = heldQueue.pop()!;
      if (heldSeen.has(oid)) continue;
      heldSeen.add(oid);
      const object = read(oid);
      if (!object) continue;
      held.add(oid);
      if (object.kind === 'commit') {
        const commit = parseCommit(object.data);
        if (!boundarySet.has(oid)) {
          for (const parent of commit.parents) heldQueue.push(parent);
        }
        try {
          for (const reached of reachable([commit.tree], read)) held.add(reached);
        } catch {
          // A tree the store does not hold contributes nothing.
        }
      } else if (object.kind === 'tag') {
        heldQueue.push(parseTag(object.data).object);
      } else if (object.kind === 'tree') {
        try {
          for (const reached of reachable([oid], read)) held.add(reached);
        } catch {
          // Nothing held here.
        }
      }
    }
    const objects: { oid: string; kind: ObjectKind; data: Buffer }[] = [];
    for (const oid of wantedClosure) {
      if (held.has(oid)) continue;
      const object = read(oid);
      if (object) objects.push({ oid, ...object });
    }
    // Boundaries that stopped being shallow: an old boundary now held with a parent.
    const unshallow: string[] = [];
    if (depth !== undefined) {
      for (const old of shallowBoundaries) {
        if (!wantedClosure.has(old)) continue;
        const object = read(old);
        if (object?.kind !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.some((parent) => wantedClosure.has(parent) && !held.has(parent))) unshallow.push(old);
      }
    }
    // Keep the pack order stable: commits first, then tags, trees, blobs, each
    // by id — deterministic across runs.
    const rank = (object: { kind: ObjectKind }): number =>
      object.kind === 'commit' ? 0 : object.kind === 'tag' ? 1 : object.kind === 'tree' ? 2 : 3;
    objects.sort((a, b) => rank(a) - rank(b) || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
    return { objects, shallow: [...new Set(newShallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
  }

  /** A pack for a fetch, cached on the repository version and the request's shape. */
  fetchPack(repo: Repository, key: string, build: () => Buffer): Buffer {
    const cached = repo.packCache.get(key);
    if (cached !== undefined) return cached;
    const pack = build();
    if (repo.packCache.size > 64) repo.packCache.clear();
    repo.packCache.set(key, pack);
    return pack;
  }

  // -------------------------------------------------------------------------------- receive-pack

  /**
   * Validate one receive-pack command against the current refs. Returns the
   * refusal reason, or null when the command may apply.
   */
  validatePushCommand(repo: Repository, oldOid: string, newOid: string, ref: string): string | null {
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (newOid === ZERO_OID) {
      // A delete.
      if (current === ZERO_OID) return 'remote ref does not exist';
      if (oldOid !== ZERO_OID && oldOid !== current) return 'non-fast-forward';
      return null;
    }
    if (!repo.objects.has(newOid)) return 'missing object';
    const newObject = repo.objects.read(newOid)!;
    if (newObject.kind !== 'commit' && newObject.kind !== 'tag') return 'not a commit or tag';
    if (current === ZERO_OID) {
      // A create: the old value must be zero.
      if (oldOid !== ZERO_OID) return 'non-fast-forward';
      return null;
    }
    if (oldOid !== current) return 'non-fast-forward';
    if (newObject.kind === 'tag') return null;
    if (!isAncestor(current, newOid, (oid) => repo.objects.read(oid))) return 'non-fast-forward';
    return null;
  }
}
