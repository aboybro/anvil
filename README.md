# anvil

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aboybro/anvil/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aboybro/anvil/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node process — built
around a real git object database, not a parsed-object model: every object is
stored as a deflated loose object (`zlib("<type> <size>\0<data>")`), keyed by
its SHA-1 and inflated lazily, exactly the way git keeps `.git/objects`. On
top of that store it serves git smart-HTTP (protocol v2 and v0), the GitHub
REST v3 API, the GraphQL v4 API, the Model Context Protocol, and a small web
interface for browsing repositories, files, commits, issues and pull requests.
No git binary, no database, no network — the whole forge is the standard
library.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entrypoint the harness runs: it listens on an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`
until the trial ends, then exits 0. The bearer token for every API call is
`$MAKEFUN_SHOP_TOKEN`.

For local development:

```sh
MAKEFUN_SHOP_TOKEN=dev-token node --experimental-strip-types dev.ts 8080
```

Then the forge listens on `http://127.0.0.1:8080` with token `dev-token`, and
the web interface is at `http://127.0.0.1:8080/web/`.

## What it serves

- **Git smart-HTTP** — `/{owner}/{repo}.git/info/refs`,
  `git-upload-pack` (v2 `ls-refs` and `fetch`, with a v0 fallback) and
  `git-receive-pack` (v0, `report-status` + sideband). Clone, fetch, push and
  pull work end-to-end with a real `git` client: shallow and deepen fetches,
  thin packs, OFS and REF deltas, annotated-tag peeling, unborn HEAD, and
  per-ref fast-forward validation (a non-fast-forward push is `ng` and the ref
  does not move). Packs are cached per repository version and request shape.
- **REST v3** (`/api/v3`) — a route table, not a nest of conditionals:
  repositories (create/list/get/patch/delete, with pagination `Link`
  headers), branches, commits, git refs, git blobs/trees/commits, contents
  (create/update/delete with real git blob SHAs), labels, issues and comments,
  pull requests with files, diff stats and squash merges — plus search,
  rate_limit, users, contributors, languages, the readme and issue labels.
  A repository belongs to the login the token names; the same name under
  another owner is 404.
- **GraphQL v4** (`/api/graphql`) — a tokenizing parser and a resolver table
  keyed `Type.field`: `viewer`, `repository`, `issue` and `pullRequest`
  reads, `__type` introspection, issue lists with `states`, `orderBy` and
  cursor pagination, `node(id:)` with stable opaque Relay ids, the
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` and
  `addComment` mutations, and batched operation arrays.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP: `server/discover` for the
  modern revision and `initialize` for the legacy handshake, `tools/list`
  with nine tools (the six `github-mcp-server` tools plus `list_repos`,
  `get_issue` and `list_pull_requests`), and `tools/call` acting on the same
  store as REST. A tool name may carry a server prefix
  (`github__create_issue`), matched as a suffix, and a `full_name`
  argument stands in for `owner` + `repo`.
- **Web** (`/web/`) — server-rendered HTML over the same store: the
  repository list, a file browser (tree/blob at any branch), the commit list,
  and issue and pull-request lists and details. No JavaScript, no auth.

## Layout

- `main.ts` — the harness lifecycle (listen, register, poll `/done`, exit).
- `server.ts` — the HTTP server: routing, bearer auth, request ids, JSON bodies.
- `src/loose.ts` — the loose-object store, object codecs, pkt-lines, packfiles.
- `src/domain.ts` — the vault: repositories, refs, issues, pull requests, merges, fetch selection.
- `src/views.ts` — the REST/GraphQL JSON shapes and the Relay ids.
- `src/gitwire.ts` — git smart HTTP (v2/v0 upload-pack, v0 receive-pack).
- `src/rest.ts` — the REST v3 route table.
- `src/gql.ts` — the GraphQL parser and resolver table.
- `src/mcp.ts` — the MCP tool registry.
- `src/web.ts` — the HTML browsing interface.
- `src/scenario.ts` — who the trial's bearer token names, derived from the suite's seed.
- `dev.ts` — the local runner.
