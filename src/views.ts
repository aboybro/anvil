// views.ts — the REST v3 (and GraphQL/MCP) JSON shapes.
//
// One function per resource, each a pure function of the vault's records: the
// repository, the user, a label, an issue, a comment, a pull request. The
// Relay ids are opaque base64 of "<Kind>:<repoId>:<number>[:<extra>]" and
// decode back to the same parts, so a GraphQL node(id:) round-trips.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import type { Comment, Issue, Label, Pull, Repository } from './domain.ts';

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`).toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

export function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: relayId('Repository', repo.id, 0),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: relayId('Issue', repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

export function commentJson(repo: Repository, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: relayId('IssueComment', repo.id, issue.number, comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: Repository, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: relayId('PullRequest', repo.id, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? true : null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** The opaque Relay id of a repository, an issue, a pull request or a comment. */
export function relayId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoId: number, number: number, extra?: number): string {
  const text = extra === undefined ? `${kind}:${repoId}:${number}` : `${kind}:${repoId}:${number}:${extra}`;
  return Buffer.from(text).toString('base64');
}

/** Decode an opaque Relay id back to its parts, or null when it is not one. */
export function decodeRelayId(id: string): { kind: string; repoId: number; number: number; extra?: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 3) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
    const extra = parts.length >= 4 ? Number(parts[3]) : undefined;
    return { kind, repoId, number, extra };
  } catch {
    return null;
  }
}
