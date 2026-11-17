// loose.ts — git's object model as a content-addressed loose-object store.
//
// Unlike a parsed-object model, this store keeps every object exactly the way
// git keeps a loose object on disk: the deflated bytes of "<type> <size>\0<data>",
// keyed by the SHA-1 of the uncompressed form. Nothing is parsed until a caller
// asks for it, and parsing is a pure function over bytes. The same module holds
// the pkt-line framing, the packfile reader/writer (plain objects plus OFS and
// REF deltas, thin packs resolved against this store) and the reachability
// walks. No wall clock, no randomness: the same bytes always hash the same.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

const KIND_CODE: Readonly<Record<ObjectKind, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Readonly<Record<number, ObjectKind>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const OID_RE = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function objectId(kind: ObjectKind, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${kind} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** The loose-object bytes of an object: zlib("<type> <size>\0<data>"). */
export function looseBytes(kind: ObjectKind, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return deflateSync(Buffer.concat([Buffer.from(`${kind} ${body.length}\u0000`, 'utf8'), body]));
}

/**
 * A repository's object database: a map from object id to loose bytes. Reads
 * inflate and split the header on demand; writes deflate once and store the
 * compressed form. A small decoded cache keeps hot objects (the tips a fetch
 * walks) from being inflated twice in a row.
 */
export class LooseStore {
  readonly #loose = new Map<string, Buffer>();
  readonly #decoded = new Map<string, { kind: ObjectKind; data: Buffer }>();

  get size(): number {
    return this.#loose.size;
  }

  has(oid: string): boolean {
    return this.#loose.has(oid);
  }

  /** Store an object; returns its id. */
  put(kind: ObjectKind, data: Uint8Array): string {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = objectId(kind, body);
    if (!this.#loose.has(oid)) {
      this.#loose.set(oid, looseBytes(kind, body));
      if (this.#decoded.size > 4096) this.#decoded.clear();
      this.#decoded.set(oid, { kind, data: body });
    }
    return oid;
  }

  /** Store an already-built loose object under its id (pack ingestion). */
  putLoose(oid: string, kind: ObjectKind, data: Buffer): void {
    if (this.#loose.has(oid)) return;
    this.#loose.set(oid, looseBytes(kind, data));
    if (this.#decoded.size > 4096) this.#decoded.clear();
    this.#decoded.set(oid, { kind, data });
  }

  /** Read an object, inflating its loose bytes; undefined when absent. */
  read(oid: string): { kind: ObjectKind; data: Buffer } | undefined {
    const cached = this.#decoded.get(oid);
    if (cached !== undefined) return cached;
    const loose = this.#loose.get(oid);
    if (loose === undefined) return undefined;
    const raw = inflateSync(loose);
    const nul = raw.indexOf(0);
    if (nul < 0) return undefined;
    const header = raw.subarray(0, nul).toString('ascii');
    const space = header.indexOf(' ');
    if (space < 0) return undefined;
    const kind = header.slice(0, space) as ObjectKind;
    if (kind !== 'commit' && kind !== 'tree' && kind !== 'blob' && kind !== 'tag') return undefined;
    const size = Number(header.slice(space + 1));
    if (!Number.isSafeInteger(size) || raw.length - nul - 1 !== size) return undefined;
    const data = Buffer.from(raw.subarray(nul + 1));
    if (this.#decoded.size > 4096) this.#decoded.clear();
    const entry = { kind, data };
    this.#decoded.set(oid, entry);
    return entry;
  }
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export const PKT_MAX = 65520;

/** One pkt-line: a 4-hex length prefix plus the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the maximum`);
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws on a malformed header. */
export function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The text of every data packet, in order. */
export function packetTexts(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// -------------------------------------------------------------------------------------------
// trees, commits, tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: ObjectKind;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjectKind,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${timezone}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

export type ObjectReader = (oid: string) => { kind: ObjectKind; data: Buffer } | undefined;

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing. Throws on a missing object.
 * Iterative, with an index pointer instead of shift(), so long histories stay linear.
 */
export function reachable(roots: Iterable<string>, read: ObjectReader): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index]!;
    if (seen.has(oid)) continue;
    const object = read(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.kind === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.kind === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.kind === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, read: ObjectReader): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index]!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = read(oid);
    if (!object) continue;
    if (object.kind === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.kind === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** Walk commits from `tip` newest-first (parents after the commit), each once. */
export function walkCommits(tip: string, read: ObjectReader): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = read(oid);
    if (!object || object.kind !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile
// -------------------------------------------------------------------------------------------

function readEntrySize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  readonly objects: Map<string, { kind: ObjectKind; data: Buffer }>;
  readonly count: number;
  readonly deltas: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out.
 * Every object's SHA-1 is recomputed; a mismatch is an error.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectReader } = {}): PackRead {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedKind?: ObjectKind;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntrySize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_KIND[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, { kind: ObjectKind; data: Buffer }>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  let deltas = 0;
  const resolve = (entry: RawEntry): { kind: ObjectKind; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedKind && entry.oid) {
      return { kind: entry.resolvedKind, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let kind: ObjectKind;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      kind = base.kind;
      data = applyDelta(base.data, entry.data);
      deltas += 1;
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        kind = base.kind;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        kind = external.kind;
        data = applyDelta(external.data, entry.data);
      }
      deltas += 1;
    } else {
      kind = CODE_KIND[entry.typeCode]!;
      data = entry.data;
    }
    const oid = objectId(kind, data);
    entry.resolved = data;
    entry.resolvedKind = kind;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { kind, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { kind: resolved.kind, data: resolved.data });
  }
  return { objects, count: declaredCount, deltas };
}

/** Encode one object's pack header: the type/size varint. */
function packObjectHeader(kind: ObjectKind, size: number): Buffer {
  const code = KIND_CODE[kind];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's;
 * the trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<{ kind: ObjectKind; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.kind, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): boolean {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) return false;
  return buffer.subarray(buffer.length - 20).toString('hex') === packChecksum(buffer);
}
