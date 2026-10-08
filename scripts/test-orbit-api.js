#!/usr/bin/env node
/* Tests for api/orbit.js.
 *   node --test scripts/test-orbit-api.js                          (in-memory store)
 *   ORBIT_TEST_STORE=redis node --test scripts/test-orbit-api.js   (RedisStore against a fake Upstash)
 */
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const path = require('path');

const orbit = require(path.join(__dirname, '..', 'api', 'orbit.js'));

// A tiny stand-in for Upstash's REST API (pipeline + multi-exec), enough to exercise RedisStore.
function fakeUpstash() {
  const strings = new Map();
  const hashes = new Map();
  const run = ([cmd, key, ...args]) => {
    switch (cmd) {
      case 'GET': return strings.has(key) ? strings.get(key) : null;
      case 'SET':
        if (args.includes('NX') && strings.has(key)) return null;
        strings.set(key, args[0]);
        return 'OK';
      case 'DEL': return Number(strings.delete(key)) + Number(hashes.delete(key));
      case 'INCR': {
        const n = Number(strings.get(key) || 0) + 1;
        strings.set(key, String(n));
        return n;
      }
      case 'HSET': {
        const h = hashes.get(key) || new Map();
        const isNew = !h.has(args[0]);
        h.set(args[0], args[1]);
        hashes.set(key, h);
        return isNew ? 1 : 0;
      }
      case 'HDEL': return hashes.has(key) && hashes.get(key).delete(args[0]) ? 1 : 0;
      case 'HGETALL': return [...(hashes.get(key) || new Map())].flat();
      case 'EXPIREAT': {
        const exists = strings.has(key) || hashes.has(key);
        if (exists && Number(args[0]) * 1000 <= Date.now()) {
          strings.delete(key);
          hashes.delete(key);
        }
        return exists ? 1 : 0;
      }
      default: throw new Error('unsupported ' + cmd);
    }
  };
  return async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.match(url, /\/(pipeline|multi-exec)$/);
    const out = JSON.parse(init.body).map((c) => ({ result: run(c) }));
    return { ok: true, json: async () => out };
  };
}

const STORES = {
  memory: () => new orbit.MemoryStore(),
  redis: () => {
    globalThis.fetch = fakeUpstash();
    return new orbit.RedisStore('https://fake.upstash.io', 'test-token');
  }
};
const KIND = process.env.ORBIT_TEST_STORE || 'memory';

function client() {
  const handler = orbit.createHandler(STORES[KIND]());
  return async function call(method, query, { key, body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = '/api/orbit' + (query ? '?' + new URLSearchParams(query) : '');
    req.headers = key ? { 'x-orbit-key': key } : {};
    let status = 0;
    let text = '';
    await handler(req, {
      setHeader() {},
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      end(chunk) { text = chunk || ''; }
    });
    return { status, body: text ? JSON.parse(text) : null };
  };
}

const START = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
const D = (n) => new Date(Date.parse(START) + n * 86400000).toISOString().slice(0, 10);
const ADMIN = 'admin-key-0123456789abcdef';
const ALICE = 'alice-key-0123456789abcdef';
const BOB = 'bob-key-0123456789abcdef00';
const BOARD = {
  title: 'Bonn workshop',
  startDate: `${D(0)}`,
  endDate: `${D(4)}`,
  startHour: 9,
  endHour: 17,
  sessionHours: 3,
  timezone: 'Europe/Berlin'
};

async function setup() {
  const call = client();
  const created = await call('POST', null, { key: ADMIN, body: { board: BOARD } });
  assert.equal(created.status, 201);
  return { call, id: created.body.board.id };
}

test('health reports the storage type', async () => {
  const res = await client()('GET', null);
  assert.equal(res.status, 200);
  assert.equal(res.body.storage, KIND);
});

test('creates a board without leaking the organiser key', async () => {
  const { call, id } = await setup();
  const res = await call('GET', { id });
  assert.equal(res.status, 200);
  assert.match(id, /^ob_/);
  assert.equal(res.body.board.title, 'Bonn workshop');
  assert.equal(res.body.board.sessionHours, 3);
  assert.equal(res.body.board.adminHash, undefined);
  assert.equal(res.body.version, 1);
});

test('rejects invalid boards', async () => {
  const call = client();
  const bad = [
    { ...BOARD, title: ' ' },
    { ...BOARD, startDate: '2027-02-30' },
    { ...BOARD, endDate: `${D(-11)}` },
    { ...BOARD, endDate: `${D(80)}` },
    { ...BOARD, startHour: 17, endHour: 9 },
    { ...BOARD, sessionHours: 9 },
    { ...BOARD, startHour: 9, endHour: 10, sessionHours: 3 },
    { ...BOARD, timezone: 'Mars/Olympus' }
  ];
  for (const board of bad) {
    const res = await call('POST', null, { key: ADMIN, body: { board } });
    assert.equal(res.status, 400, JSON.stringify(board));
  }
  assert.equal((await call('POST', null, { body: { board: BOARD } })).status, 401);
});

test('participants save independently and keep only valid hours', async () => {
  const { call, id } = await setup();
  const a = await call('PUT', { id, p: 'p_alice001' }, {
    key: ALICE,
    body: { name: '  Alice  ', role: 'facilitator', slots: [`${D(1)}T10`, `${D(1)}T10`, `${D(8)}T10`, `${D(1)}T08`, 'junk'] }
  });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.participant.slots, [`${D(1)}T10`]);
  assert.equal(a.body.participant.name, 'Alice');
  await call('PUT', { id, p: 'p_bob00001' }, { key: BOB, body: { name: 'Bob', role: 'teacher', slots: [`${D(1)}T11`] } });
  const doc = (await call('GET', { id })).body;
  assert.deepEqual(Object.keys(doc.participants).sort(), ['p_alice001', 'p_bob00001']);
  assert.equal(doc.participants.p_alice001.keyHash, undefined);
  assert.equal(doc.version, 3);
});

test('nobody can overwrite or delete someone else', async () => {
  const { call, id } = await setup();
  await call('PUT', { id, p: 'p_alice001' }, { key: ALICE, body: { name: 'Alice', slots: [] } });
  const hijack = await call('PUT', { id, p: 'p_alice001' }, { key: BOB, body: { name: 'Mallory', slots: [] } });
  assert.equal(hijack.status, 403);
  assert.equal((await call('DELETE', { id, p: 'p_alice001' }, { key: BOB })).status, 403);
  assert.equal((await call('DELETE', { id, p: 'p_alice001' }, { key: ALICE })).status, 200);
  await call('PUT', { id, p: 'p_bob00001' }, { key: BOB, body: { name: 'Bob', slots: [] } });
  assert.equal((await call('DELETE', { id, p: 'p_bob00001' }, { key: ADMIN })).status, 200);
  assert.deepEqual((await call('GET', { id })).body.participants, {});
});

test('only one booking per board, first come first served', async () => {
  const { call, id } = await setup();
  const outside = await call('POST', { id, action: 'book' }, { key: ALICE, body: { slot: `${D(1)}T15`, hours: 3, name: 'Alice' } });
  assert.equal(outside.status, 400);
  const [first, second] = await Promise.all([
    call('POST', { id, action: 'book' }, { key: ALICE, body: { slot: `${D(1)}T10`, hours: 3, name: 'Alice' } }),
    call('POST', { id, action: 'book' }, { key: BOB, body: { slot: `${D(2)}T09`, hours: 3, name: 'Bob' } })
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const winner = first.status === 201 ? first : second;
  assert.match(winner.body.booking.ref, /^S4C-[A-Z2-9]{6}$/);
  const loser = first.status === 201 ? second : first;
  assert.equal(loser.body.booking.ref, winner.body.booking.ref);
});

test('cancelling needs the booker or the organiser', async () => {
  const { call, id } = await setup();
  await call('POST', { id, action: 'book' }, { key: ALICE, body: { slot: `${D(1)}T10`, hours: 3, name: 'Alice' } });
  assert.equal((await call('DELETE', { id, action: 'book' }, { key: BOB })).status, 403);
  assert.equal((await call('DELETE', { id, action: 'book' }, { key: ALICE })).status, 200);
  await call('POST', { id, action: 'book' }, { key: BOB, body: { slot: `${D(2)}T09`, hours: 2, name: 'Bob' } });
  assert.equal((await call('DELETE', { id, action: 'book' }, { key: ADMIN })).status, 200);
  assert.equal((await call('GET', { id })).body.booking, null);
});

test('only the organiser can edit, and the time zone stays fixed', async () => {
  const { call, id } = await setup();
  assert.equal((await call('PATCH', { id }, { key: ALICE, body: { title: 'Hacked' } })).status, 403);
  const res = await call('PATCH', { id }, { key: ADMIN, body: { title: 'Bonn workshop (moved)', endDate: `${D(8)}`, timezone: 'Asia/Tokyo' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.board.title, 'Bonn workshop (moved)');
  assert.equal(res.body.board.endDate, `${D(8)}`);
  assert.equal(res.body.board.timezone, 'Europe/Berlin');
});

test('polling with since= is cheap when nothing changed', async () => {
  const { call, id } = await setup();
  const first = await call('GET', { id });
  const same = await call('GET', { id, since: String(first.body.version) });
  assert.deepEqual(same.body, { unchanged: true, version: 1 });
  await call('PUT', { id, p: 'p_alice001' }, { key: ALICE, body: { name: 'Alice', slots: [] } });
  const changed = await call('GET', { id, since: '1' });
  assert.equal(changed.body.version, 2);
  assert.ok(changed.body.board);
});

test('unknown boards return 404', async () => {
  const call = client();
  assert.equal((await call('GET', { id: 'ob_doesnotexist' })).status, 404);
  assert.equal((await call('GET', { id: '../etc/passwd' })).status, 404);
});

test('rejects boards that already ended, and impossible dates', async () => {
  const call = client();
  const past = await call('POST', null, { key: ADMIN, body: { board: { ...BOARD, startDate: '2025-01-06', endDate: '2025-01-10' } } });
  assert.equal(past.status, 400);
  assert.equal((await call('POST', null, { key: ADMIN, body: null })).status, 400);
  const { call: c2, id } = await setup();
  assert.equal((await c2('PATCH', { id }, { key: ADMIN, body: { startDate: '2025-01-06', endDate: '2025-01-10' } })).status, 400);
  const feb = await c2('POST', { id, action: 'book' }, { key: ALICE, body: { slot: `${D(0).slice(0, 8)}32T10`, hours: 1, name: 'Alice' } });
  assert.equal(feb.status, 400);
  assert.equal((await c2('GET', { id })).status, 200, 'board still exists after create on this store');
});

test('shrinking a board never locks people out', async () => {
  const { call, id } = await setup();
  const many = [];
  for (let d = 0; d < 5; d++) for (let h = 9; h < 17; h++) many.push(`${D(d)}T${String(h).padStart(2, '0')}`);
  await call('PUT', { id, p: 'p_alice001' }, { key: ALICE, body: { name: 'Alice', slots: many } });
  assert.equal((await call('PATCH', { id }, { key: ADMIN, body: { endDate: D(1), startHour: 10, endHour: 13 } })).status, 200);
  const again = await call('PUT', { id, p: 'p_alice001' }, { key: ALICE, body: { name: 'Alice', slots: many } });
  assert.equal(again.status, 200);
  assert.equal(again.body.participant.slots.length, 6);
});

test('an edit cannot strand the booked session', async () => {
  const { call, id } = await setup();
  await call('POST', { id, action: 'book' }, { key: ALICE, body: { slot: `${D(3)}T10`, hours: 3, name: 'Alice' } });
  assert.equal((await call('PATCH', { id }, { key: ADMIN, body: { endDate: D(2) } })).status, 409);
  assert.equal((await call('PATCH', { id }, { key: ADMIN, body: { endDate: D(4), title: 'Renamed' } })).status, 200);
});

