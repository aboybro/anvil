// web.ts — the browsing interface under /web/.
//
// The suite never calls this surface; it exists for a person. Server-rendered
// HTML over the same vault the API serves: the repository list, a file browser
// (tree/blob at any branch), the commit list, and the issue and pull-request
// lists and details. No auth, no JavaScript, no network: every link is a
// plain GET and every byte comes from the vault.

import { parseCommit } from './loose.ts';
import { Vault, type Repository } from './domain.ts';

export interface WebResult {
  status: number;
  body: string;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — anvil</title>
<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#1f2328}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:1.4rem}h2{font-size:1.1rem}code{font-family:ui-monospace,monospace}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:.35rem .5rem;text-align:left}
pre{background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px}
.badge{display:inline-block;background:#ddf4ff;color:#0969da;border-radius:2em;padding:.1em .6em;font-size:.8rem}
nav{color:#656d76;margin-bottom:1rem}</style></head>
<body><nav><a href="/web/">anvil</a> · a GitHub-compatible git forge</nav>${body}</body></html>`;
}

function notFoundHtml(what: string): WebResult {
  return { status: 404, body: page('Not found', `<h1>Not found</h1><p>${esc(what)} does not exist here.</p>`) };
}

function repoLink(owner: string, name: string): string {
  return `/web/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** The tree at a commit, flattened to path → {oid, mode}. */
function flatTree(vault: Vault, repo: Repository, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = repo.objects.read(commitOid);
  if (!commit || commit.kind !== 'commit') return new Map();
  return vault.flattenTree(repo, parseCommit(commit.data).tree);
}

function repoHome(vault: Vault, repo: Repository): WebResult {
  const head = vault.headCommit(repo);
  const branches = vault.listBranches(repo);
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  let files = '';
  if (head !== null) {
    const flat = flatTree(vault, repo, head);
    const rows = [...flat.keys()].sort().map((path) => {
      const entry = flat.get(path)!;
      const url = `${repoLink(repo.owner, repo.name)}/blob/${repo.defaultBranch}/${path.split('/').map(encodeURIComponent).join('/')}`;
      return `<tr><td><a href="${url}">${esc(path)}</a></td><td><code>${entry.oid.slice(0, 7)}</code></td><td>${entry.mode}</td></tr>`;
    }).join('');
    files = `<h2>Files at <code>${esc(repo.defaultBranch)}</code></h2><table><tr><th>path</th><th>blob</th><th>mode</th></tr>${rows}</table>`;
  } else {
    files = '<p>This repository has no commits yet.</p>';
  }
  const branchLinks = branches.map((branch) => `<a href="${repoLink(repo.owner, repo.name)}/commits/${encodeURIComponent(branch.name)}">${esc(branch.name)}</a>`).join(', ');
  return {
    status: 200,
    body: page(`${repo.owner}/${repo.name}`, `
<h1>${esc(repo.owner)}/${esc(repo.name)}</h1>
<p>${esc(repo.description || 'No description.')}</p>
<p><span class="badge">${openIssues} open issue${openIssues === 1 ? '' : 's'}</span>
<span class="badge">${openPulls} open pull request${openPulls === 1 ? '' : 's'}</span>
<span class="badge">${repo.objects.size} objects</span></p>
<p><a href="${repoLink(repo.owner, repo.name)}/issues">Issues</a> · <a href="${repoLink(repo.owner, repo.name)}/pulls">Pull requests</a></p>
<p>Branches: ${branchLinks || 'none'}</p>
${files}`),
  };
}

function treePage(vault: Vault, repo: Repository, branch: string, path: string): WebResult {
  const tip = vault.resolveRef(repo, branch);
  if (tip === null) return notFoundHtml(`branch ${branch}`);
  const flat = flatTree(vault, repo, tip);
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { oid: string; mode: string; dir: boolean }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, { ...entry, dir: false });
    else if (!children.has(rest.slice(0, slash))) {
      children.set(rest.slice(0, slash), { oid: '', mode: '40000', dir: true });
    }
  }
  if (children.size === 0) return notFoundHtml(`path ${path}`);
  const rows = [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) => {
    const childPath = prefix + name;
    const url = entry.dir
      ? `${repoLink(repo.owner, repo.name)}/tree/${encodeURIComponent(branch)}/${childPath.split('/').map(encodeURIComponent).join('/')}`
      : `${repoLink(repo.owner, repo.name)}/blob/${encodeURIComponent(branch)}/${childPath.split('/').map(encodeURIComponent).join('/')}`;
    return `<tr><td><a href="${url}">${esc(name)}${entry.dir ? '/' : ''}</a></td><td>${entry.dir ? 'directory' : entry.mode}</td></tr>`;
  }).join('');
  return {
    status: 200,
    body: page(`${repo.name}/${path || ''}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<p>branch <code>${esc(branch)}</code> · path <code>${esc(path || '/')}</code></p>
<table><tr><th>name</th><th>kind</th></tr>${rows}</table>`),
  };
}

function blobPage(vault: Vault, repo: Repository, branch: string, path: string): WebResult {
  const read = vault.readContent(repo, { path, ref: branch });
  if (read === null || read.kind !== 'file') return notFoundHtml(`file ${path}`);
  const text = read.blob.toString('utf8');
  const printable = [...text].every((ch) => ch === '\n' || ch === '\r' || ch === '\t' || (ch >= ' ' && ch !== '\u007f'));
  const body = printable ? `<pre>${esc(text)}</pre>` : `<p>A binary file (${read.blob.length} bytes, sha <code>${read.sha.slice(0, 12)}</code>).</p>`;
  return {
    status: 200,
    body: page(`${repo.name}/${path}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<p>branch <code>${esc(branch)}</code> · <code>${esc(path)}</code> · ${read.blob.length} bytes</p>
${body}`),
  };
}

function commitsPage(vault: Vault, repo: Repository, branch: string): WebResult {
  const tip = vault.resolveRef(repo, branch);
  if (tip === null) return notFoundHtml(`branch ${branch}`);
  const rows = vault.listCommits(repo, tip).map((sha) => {
    const object = repo.objects.read(sha);
    if (!object || object.kind !== 'commit') return '';
    const commit = parseCommit(object.data);
    const author = commit.author.replace(/ \d+ [+-]\d{4}$/, '');
    return `<tr><td><code>${sha.slice(0, 7)}</code></td><td>${esc(commit.message.replace(/\n$/, ''))}</td><td>${esc(author)}</td></tr>`;
  }).join('');
  return {
    status: 200,
    body: page(`Commits on ${branch}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<h2>Commits on <code>${esc(branch)}</code></h2>
<table><tr><th>sha</th><th>message</th><th>author</th></tr>${rows}</table>`),
  };
}

function issuesPage(vault: Vault, repo: Repository): WebResult {
  const issues = [...repo.issues.values()].sort((a, b) => b.number - a.number);
  const rows = issues.map((issue) => `<tr><td>#${issue.number}</td><td><a href="${repoLink(repo.owner, repo.name)}/issues/${issue.number}">${esc(issue.title)}</a></td><td>${issue.state}</td><td>${issue.comments.length}</td></tr>`).join('');
  return {
    status: 200,
    body: page(`Issues · ${repo.name}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<h2>Issues</h2>
<table><tr><th>#</th><th>title</th><th>state</th><th>comments</th></tr>${rows || '<tr><td colspan="4">No issues yet.</td></tr>'}</table>`),
  };
}

function issuePage(vault: Vault, repo: Repository, number: number): WebResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFoundHtml(`issue #${number}`);
  const labels = issue.labels.map((label) => `<span class="badge">${esc(label.name)}</span>`).join(' ');
  const comments = issue.comments.map((comment) => `<div><p>${esc(comment.body)}</p><p><small>${esc(comment.createdAt)}</small></p></div>`).join('');
  return {
    status: 200,
    body: page(`#${issue.number} ${issue.title}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<h2>#${issue.number} ${esc(issue.title)} <span class="badge">${issue.state}</span></h2>
<p>${labels}</p>
<p>${esc(issue.body)}</p>
<h2>Comments (${issue.comments.length})</h2>${comments || '<p>No comments yet.</p>'}`),
  };
}

function pullsPage(vault: Vault, repo: Repository): WebResult {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const rows = pulls.map((pull) => `<tr><td>#${pull.number}</td><td><a href="${repoLink(repo.owner, repo.name)}/pulls/${pull.number}">${esc(pull.title)}</a></td><td>${pull.merged ? 'merged' : pull.state}</td><td><code>${esc(pull.headRef)} → ${esc(pull.baseRef)}</code></td></tr>`).join('');
  return {
    status: 200,
    body: page(`Pull requests · ${repo.name}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<h2>Pull requests</h2>
<table><tr><th>#</th><th>title</th><th>state</th><th>refs</th></tr>${rows || '<tr><td colspan="4">No pull requests yet.</td></tr>'}</table>`),
  };
}

function pullPage(vault: Vault, repo: Repository, number: number): WebResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFoundHtml(`pull request #${number}`);
  const files = vault.pullFiles(repo, pull);
  const rows = files.map((file) => `<tr><td>${esc(file.filename)}</td><td>${file.status}</td><td>+${file.additions} −${file.deletions}</td></tr>`).join('');
  return {
    status: 200,
    body: page(`#${pull.number} ${pull.title}`, `
<h1><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></h1>
<h2>#${pull.number} ${esc(pull.title)} <span class="badge">${pull.merged ? 'merged' : pull.state}</span></h2>
<p><code>${esc(pull.headRef)} → ${esc(pull.baseRef)}</code></p>
<p>${esc(pull.body)}</p>
<h2>Changed files (${files.length})</h2>
<table><tr><th>file</th><th>status</th><th>changes</th></tr>${rows || '<tr><td colspan="3">No changed files.</td></tr>'}</table>`),
  };
}

/** Route a /web request. `segments` are the decoded path parts after /web. */
export function handleWeb(vault: Vault, segments: string[]): WebResult {
  if (segments.length === 0) {
    const repos = vault.listRepos();
    const rows = repos.map((repo) => `<tr><td><a href="${repoLink(repo.owner, repo.name)}">${esc(repo.owner)}/${esc(repo.name)}</a></td><td>${esc(repo.description)}</td><td>${repo.private ? 'private' : 'public'}</td></tr>`).join('');
    return {
      status: 200,
      body: page('Repositories', `
<h1>Repositories</h1>
<p>One process, one store: git smart HTTP, REST v3, GraphQL v4 and MCP — and these pages, rendered from the same vault.</p>
<table><tr><th>repository</th><th>description</th><th>visibility</th></tr>${rows || '<tr><td colspan="3">No repositories yet. Create one over <code>POST /api/v3/user/repos</code>.</td></tr>'}</table>`),
    };
  }
  const owner = segments[0] ?? '';
  const name = segments[1] ?? '';
  const repo = vault.getRepo(owner, name);
  if (repo === null) return notFoundHtml(`repository ${owner}/${name}`);
  if (segments.length === 2) return repoHome(vault, repo);
  const section = segments[2] ?? '';
  if (section === 'tree' && segments.length >= 4) {
    return treePage(vault, repo, segments[3]!, segments.slice(4).join('/'));
  }
  if (section === 'blob' && segments.length >= 5) {
    return blobPage(vault, repo, segments[3]!, segments.slice(4).join('/'));
  }
  if (section === 'commits' && segments.length === 4) {
    return commitsPage(vault, repo, segments[3]!);
  }
  if (section === 'issues' && segments.length === 3) {
    return issuesPage(vault, repo);
  }
  if (section === 'issues' && segments.length === 4) {
    const number = Number(segments[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return notFoundHtml(`issue ${segments[3]}`);
    return issuePage(vault, repo, number);
  }
  if (section === 'pulls' && segments.length === 3) {
    return pullsPage(vault, repo);
  }
  if (section === 'pulls' && segments.length === 4) {
    const number = Number(segments[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return notFoundHtml(`pull request ${segments[3]}`);
    return pullPage(vault, repo, number);
  }
  return notFoundHtml(`page /web/${segments.join('/')}`);
}
