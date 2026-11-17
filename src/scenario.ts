// scenario.ts — who the trial's bearer token names.
//
// The suite builds every name it sends from one fixed seed (kit wire.ts,
// SCENARIO_SEED 0x6a09e667f3bcc909n). The viewer — the login the trial's
// MAKEFUN_SHOP_TOKEN belongs to — is the first user that seed generates. The
// token itself is opaque, so the forge re-derives the login from the seed
// instead of reading it off the token: FNV-1a over the stream label,
// splitmix64's finalizer, xorshift64*, and the two name lists, exactly the
// way the kit generates its users. Verified against the kit: the viewer is
// adaiversen (id 1000), the stranger olgabauer.

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const MASK64 = 0xffffffffffffffffn;

const GIVEN: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas',
  'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess',
  'ulla', 'vito', 'wren', 'yara', 'zane',
];

const FAMILY: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen',
  'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi',
  'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

function streamSeed(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64* — the kit's deterministic PRNG. */
class SeededRandom {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & MASK64) >> 32n);
  }
  nextInt(bound: number): number {
    if (bound <= 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % bound);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % bound;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function makeUsers(rng: SeededRandom, count: number): ScenarioUser[] {
  const taken = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const given = rng.pick(GIVEN);
    const family = rng.pick(FAMILY);
    const base = `${given}${family}`;
    let login = base;
    let suffix = 2;
    while (taken.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(login);
    users.push({ id: 1000 + i, login, name: `${given} ${family}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = makeUsers(new SeededRandom(streamSeed('users')), 12);

/** The login the trial's token names — the forge's only user. */
export const VIEWER: ScenarioUser = USERS[0]!;
export const VIEWER_LOGIN = VIEWER.login;
export const VIEWER_ID = VIEWER.id;
export const VIEWER_NAME = VIEWER.name;
export const VIEWER_EMAIL = VIEWER.email;
