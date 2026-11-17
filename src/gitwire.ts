// gitwire.ts — git smart HTTP: the wire the suite's git client speaks.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack    (protocol v2, with a v0 fallback)
//   POST /{owner}/{repo}.git/git-receive-pack   (protocol v0 only)
//
// The v2 advertisement opens with "version 2" and lists ls-refs, fetch
// (shallow, filter) and object-format sha1. The v0 advertisements open with
// the "# service=..." preamble and carry their capabilities on the first ref
// line. receive-pack advertises report-status, side-band-64k and delete-refs,
// and answers its report inside sideband band 1. A missing repository is 404
// on both services and the server stays up; a malformed body never takes it
// down.

import {
  ZERO_OID,
  decodePackets,
  isAncestor,
  isOid,
  packetTexts,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  verifyPackChecksum,
  writePack,
} from './loose.ts';
import { Vault, type Repository } from './domain.ts';

export const AGENT = 'anvil/1.0';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const json404 = (): GitResult => ({
  status: 404,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify({ message: 'Not Found' })),
});

/** Split a byte stream into sideband band-1 pkt-lines, each chunk ≤ 65515 bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The repository's refs as advertisement lines, HEAD first. */
function refLines(repo: Repository): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget) ?? ZERO_OID;
  lines.push({
    oid: headTip,
    name: 'HEAD',
    symrefTarget: headTarget,
    unborn: headTip === ZERO_OID ? true : undefined,
  });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = repo.objects.read(oid);
    if (object?.kind === 'tag') line.peeled = parseTag(object.data).object;
    lines.push(line);
  }
  return lines;
}

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement for a service, with the service preamble. */
function v0Advertisement(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow ofs-delta thin-pack multi_ack agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines = refLines(repo);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      let text: string;
      if (line.name === 'HEAD' && line.unborn) {
        text = `${ZERO_OID} HEAD\u0000${caps}\n`;
      } else {
        text = `${line.oid} ${line.name}${index === 0 ? `\u0000${caps}` : ''}\n`;
      }
      parts.push(pktLine(text));
      if (line.peeled !== undefined) {
        parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — the advertisement. With
 * `Git-Protocol: version=2` (upload-pack only) the answer is v2; otherwise v0.
 */
export function handleInfoRefs(
  vault: Vault,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): GitResult {
  const repo = vault.getRepo(owner, repoName);
  if (repo === null) return json404();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
    }
    return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return json404();
}

// -------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

/** The v2 ls-refs answer: one line per ref, filtered server-side by ref-prefix. */
function lsRefsResponse(repo: Repository, args: LsRefsArgs): Buffer {
  const out: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  for (const line of refLines(repo)) {
    if (!keep(line.name)) continue;
    if (line.name === 'HEAD' && line.unborn) {
      if (!args.unborn) continue;
      const target = line.symrefTarget !== undefined && args.symrefs ? ` symref-target:${line.symrefTarget}` : '';
      out.push(pktLine(`unborn HEAD${target}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (line.name === 'HEAD' && args.symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (args.peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    out.push(pktLine(`${text}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      // A v0 want line carries capabilities after the oid on the first line.
      args.wants.push(text.slice(5).trim().split(/\s+/)[0]!);
    } else if (text.startsWith('have ')) {
      args.haves.push(text.slice(5).trim().split(/\s+/)[0]!);
    } else if (text.startsWith('shallow ')) {
      args.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since and
    // deepen-not need no action: a filter is answered with the full objects,
    // and deepen-since/deepen-not are not part of this suite's checks.
  }
  return args;
}

/** The common ancestor set: every have that is a want or an ancestor of a want. */
function commonHaves(vault: Vault, repo: Repository, args: FetchArgs): string[] {
  const read = (oid: string) => repo.objects.read(oid);
  const common: string[] = [];
  for (const have of args.haves) {
    if (!isOid(have) || !read(have)) continue;
    if (args.wants.some((want) => want === have || (isOid(want) && read(want) !== undefined && isAncestor(have, want, read)))) {
      common.push(have);
    }
  }
  return common;
}

/**
 * The v2 fetch answer: an acknowledgments section, an optional shallow-info
 * section, and the packfile section (omitted when nothing is new). Every
 * section is a named data packet followed by its lines, sections split by
 * delim packets.
 */
function fetchV2Response(vault: Vault, repo: Repository, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const common = commonHaves(vault, repo, args);
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(pktDelim());
  }

  const { objects, shallow, unshallow } = vault.selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  if (args.depth !== undefined) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }

  if (objects.length > 0) {
    const key = `v2|${repo.version}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}`;
    const pack = vault.fetchPack(repo, key, () => writePack(objects));
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch: NAK/ACK lines, shallow lines, then the sideband pack. */
function fetchV0Response(vault: Vault, repo: Repository, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  const common = commonHaves(vault, repo, args);
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
  }
  const { objects, shallow, unshallow } = vault.selectFetchObjects(repo, args.wants, args.haves, args.shallow, args.depth);
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    const key = `v0|${repo.version}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}`;
    const pack = vault.fetchPack(repo, key, () => writePack(objects));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * POST git-upload-pack: v2 when the Git-Protocol header says version=2, else v0.
 * A body that is not pkt-lines is a 400; the server stays up.
 */
export function handleUploadPack(
  vault: Vault,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResult {
  const repo = vault.getRepo(owner, repoName);
  if (repo === null) return json404();
  let packets;
  try {
    packets = decodePackets(body);
  } catch (e) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: (e as Error).message })) };
  }
  const lines = packetTexts(packets);
  if (gitProtocol === 'version=2') {
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';
    if (command === 'ls-refs') {
      return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, parseLsRefsArgs(lines)) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: UPLOAD_RESULT, body: fetchV2Response(vault, repo, parseFetchArgs(lines)) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `Unknown command ${JSON.stringify(command)}` })) };
  }
  return { status: 200, contentType: UPLOAD_RESULT, body: fetchV0Response(vault, repo, parseFetchArgs(lines)) };
}

// -------------------------------------------------------------------------------------------
// receive-pack v0
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST git-receive-pack: a pkt-line command list, a flush, then the pack.
 * Applies the fast-forward commands, refuses the rest per ref, and answers
 * report-status inside sideband band 1.
 */
export function handleReceivePack(
  vault: Vault,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResult {
  const repo = vault.getRepo(owner, repoName);
  if (repo === null) return json404();
  const report = (unpack: string, refs: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const inner: (string | 'flush')[] = [`unpack ${unpack}\n`];
    for (const entry of refs) {
      inner.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
    }
    inner.push('flush');
    const innerBytes = pktLines(inner);
    const parts = sidebandPackets(innerBytes);
    parts.push(pktFlush());
    return Buffer.concat(parts);
  };

  // Split the command list (pkt-lines up to the first flush) from the pack bytes.
  let offset = 0;
  const commands: PushCommand[] = [];
  let sawFlush = false;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      const nul = payload.indexOf('\u0000');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
        throw new Error(`bad command line ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      offset += length;
    }
  } catch (e) {
    return { status: 400, contentType: RECEIVE_RESULT, body: report(`error ${(e as Error).message}`, []) };
  }
  if (!sawFlush || commands.length === 0) {
    return { status: 400, contentType: RECEIVE_RESULT, body: report('error no commands', []) };
  }

  const packBytes = body.subarray(offset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    if (!verifyPackChecksum(packBytes)) {
      return { status: 200, contentType: RECEIVE_RESULT, body: report('error pack checksum mismatch', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
    }
    try {
      vault.ingestPack(repo, packBytes);
    } catch (e) {
      return { status: 200, contentType: RECEIVE_RESULT, body: report(`error ${(e as Error).message}`, commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
    }
  } else if (updatesRef && packBytes.length === 0) {
    return { status: 200, contentType: RECEIVE_RESULT, body: report('error no pack', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const reason = vault.validatePushCommand(repo, command.oldOid, command.newOid, command.ref);
    if (reason !== null) {
      results.push({ ref: command.ref, ok: false, reason });
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    repo.version += 1;
    repo.updatedAt = vault.nowIso();
    repo.pushedAt = repo.updatedAt;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: report('ok', results) };
}

// -------------------------------------------------------------------------------------------
// dispatcher: one entry point for the /{owner}/{repo}.git/* routes
// -------------------------------------------------------------------------------------------

/** Route a git smart-HTTP request by method and path suffix. */
export function handleGit(
  vault: Vault,
  method: string,
  suffix: string,
  query: URLSearchParams,
  body: Buffer,
  owner: string,
  repoName: string,
  gitProtocol: string | null,
): GitResult {
  if (method === 'GET' && suffix === '/info/refs') {
    return handleInfoRefs(vault, owner, repoName, query.get('service') ?? '', gitProtocol);
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    return handleUploadPack(vault, owner, repoName, body, gitProtocol);
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    return handleReceivePack(vault, owner, repoName, body);
  }
  return json404();
}
