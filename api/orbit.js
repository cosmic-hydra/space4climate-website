/**
 * CommonBoard (Orbit Scheduler) API.
 *
 * Storage: Upstash Redis over its REST API when KV_REST_API_URL / KV_REST_API_TOKEN
 * (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) are set. Without them an
 * in-memory store is used, which only lives as long as the server process.
 *
 * Routes (JSON in and out; secrets travel in the X-Orbit-Key header):
 *   GET    /api/orbit                     health and storage type
 *   POST   /api/orbit                     create a board (X-Orbit-Key = new organiser key)
 *   GET    /api/orbit?id=ID[&since=V]     read a board, or { unchanged: true } if still at version V
 *   PATCH  /api/orbit?id=ID               edit the board (organiser key)
 *   PUT    /api/orbit?id=ID&p=PID         save one participant (that participant's key)
 *   DELETE /api/orbit?id=ID&p=PID         remove a participant (their key or the organiser key)
 *   POST   /api/orbit?id=ID&action=book   book a session; 409 if the board is already booked
 *   DELETE /api/orbit?id=ID&action=book   cancel the booking (booking key or organiser key)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DAYS = 28;
const MAX_SESSION_HOURS = 8;
const KEEP_DAYS_AFTER_END = 120;
const ROLES = ['facilitator', 'teacher', 'other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;
const ID_RE = /^ob_[A-Za-z0-9_-]{6,24}$/;
const PID_RE = /^p_[A-Za-z0-9_-]{6,32}$/;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ── Helpers ─────────────────────────────────────── */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function randomString(length, alphabet) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const newBoardId = () => 'ob_' + crypto.randomBytes(8).toString('base64url').slice(0, 10);
const newBookingRef = () => 'S4C-' + randomString(6, REF_ALPHABET);

function isValidDate(iso) {
  if (typeof iso !== 'string' || !DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysBetween(start, end) {
  const toMs = (iso) => Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((toMs(end) - toMs(start)) / 86400000) + 1;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toInt(value) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isInteger(n) ? n : NaN;
}

function expiryFor(board) {
  const [y, m, d] = board.endDate.split('-').map(Number);
  const afterEnd = Math.floor(Date.UTC(y, m - 1, d) / 1000) + KEEP_DAYS_AFTER_END * 86400;
  return Math.max(afterEnd, Math.floor(Date.now() / 1000) + 30 * 86400);
}

// Yesterday in UTC, so organisers anywhere in the world can still pick their own "today".
const earliestEndDate = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/* ── Validation ──────────────────────────────────── */

function validateBoardFields(input, existing) {
  const merged = { ...(existing || {}), ...(input || {}) };
  const title = cleanText(merged.title, 120);
  if (!title) throw new HttpError(400, 'Give the board a name.');
  if (!isValidDate(merged.startDate) || !isValidDate(merged.endDate)) throw new HttpError(400, 'Choose valid dates.');
  if (merged.startDate > merged.endDate) throw new HttpError(400, 'The end date must be on or after the start date.');
  if ((!existing || merged.endDate !== existing.endDate) && merged.endDate < earliestEndDate()) {
    throw new HttpError(400, 'The last day is in the past.');
  }
  if (daysBetween(merged.startDate, merged.endDate) > MAX_DAYS) {
    throw new HttpError(400, `Keep the date range to ${MAX_DAYS} days or fewer.`);
  }
  const startHour = toInt(merged.startHour);
  const endHour = toInt(merged.endHour);
  if (!(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
    throw new HttpError(400, 'The daily end time must be after the start time.');
  }
  const sessionHours = toInt(merged.sessionHours == null ? 1 : merged.sessionHours);
  if (!(sessionHours >= 1 && sessionHours <= MAX_SESSION_HOURS)) throw new HttpError(400, 'Choose a session length.');
  if (sessionHours > endHour - startHour) {
    throw new HttpError(400, 'The session is longer than the daily time window.');
  }
  const timezone = existing ? existing.timezone : merged.timezone;
  if (!isValidTimezone(timezone)) throw new HttpError(400, 'Choose a valid time zone.');
  return { title, startDate: merged.startDate, endDate: merged.endDate, startHour, endHour, sessionHours, timezone };
}

function slotInBoard(slot, board) {
  const match = SLOT_RE.exec(slot);
  if (!match || !isValidDate(match[1])) return false;
  const hour = Number(match[2]);
  return match[1] >= board.startDate && match[1] <= board.endDate && hour >= board.startHour && hour < board.endHour;
}

function validateParticipant(input, board) {
  const name = cleanText(input && input.name, 40);
  if (!name) throw new HttpError(400, 'Add your name first.');
  const role = ROLES.includes(input && input.role) ? input.role : 'other';
  const raw = Array.isArray(input && input.slots) ? input.slots : [];
  if (raw.length > MAX_DAYS * 24) throw new HttpError(400, 'Too many hours selected.');
  const slots = Array.from(new Set(raw.filter((s) => typeof s === 'string' && slotInBoard(s, board)))).sort();
  return { name, role, slots };
}

/* ── Public shapes (never expose key hashes) ─────── */

function publicBoard(board) {
  const { adminHash, ...rest } = board;
  return rest;
}

function publicParticipant(p) {
  const { keyHash, ...rest } = p;
  return rest;
}

function publicBooking(b) {
  if (!b) return null;
  const { keyHash, ...rest } = b;
  return rest;
}

function publicDoc(doc) {
  const participants = {};
  Object.values(doc.participants || {}).forEach((p) => {
    participants[p.id] = publicParticipant(p);
  });
  return {
    board: publicBoard(doc.board),
    participants,
    booking: publicBooking(doc.booking),
    version: doc.version || 0
  };
}

/* ── Stores ──────────────────────────────────────── */

class RedisStore {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.kind = 'redis';
  }

  async call(endpoint, commands) {
    const res = await fetch(`${this.url}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands)
    });
    if (!res.ok) throw new HttpError(503, `Storage is unavailable (${res.status}).`);
    const out = await res.json();
    return out.map((r) => {
      if (r && r.error) throw new HttpError(503, `Storage error: ${r.error}`);
      return r ? r.result : null;
    });
  }

  keys(id) {
    return { board: `cb:${id}:board`, people: `cb:${id}:people`, booking: `cb:${id}:booking`, version: `cb:${id}:v` };
  }

  touch(id, board) {
    const k = this.keys(id);
    const at = String(expiryFor(board));
    return [k.board, k.people, k.booking, k.version].map((key) => ['EXPIREAT', key, at]);
  }

  async get(id) {
    const k = this.keys(id);
    // Version first: if a write lands mid-read, the client sees an older version and simply refetches.
    const [version, board, people, booking] = await this.call('pipeline', [
      ['GET', k.version], ['GET', k.board], ['HGETALL', k.people], ['GET', k.booking]
    ]);
    if (!board) return null;
    const participants = {};
    const flat = Array.isArray(people) ? people : [];
    for (let i = 0; i + 1 < flat.length; i += 2) participants[flat[i]] = JSON.parse(flat[i + 1]);
    return { board: JSON.parse(board), participants, booking: booking ? JSON.parse(booking) : null, version: Number(version) || 0 };
  }

  async version(id) {
    const [v] = await this.call('pipeline', [['GET', this.keys(id).version]]);
    return v == null ? null : Number(v);
  }

  async create(board) {
    const k = this.keys(board.id);
    const [ok] = await this.call('multi-exec', [
      ['SET', k.board, JSON.stringify(board), 'NX'], ['SET', k.version, '1', 'NX'], ...this.touch(board.id, board)
    ]);
    return ok === 'OK';
  }

  async saveBoard(board) {
    const k = this.keys(board.id);
    const out = await this.call('multi-exec', [
      ['SET', k.board, JSON.stringify(board)], ['INCR', k.version], ...this.touch(board.id, board)
    ]);
    return Number(out[1]);
  }

  async putParticipant(board, participant) {
    const k = this.keys(board.id);
    const out = await this.call('multi-exec', [
      ['HSET', k.people, participant.id, JSON.stringify(participant)], ['INCR', k.version], ...this.touch(board.id, board)
    ]);
    return Number(out[1]);
  }

  async deleteParticipant(board, pid) {
    const k = this.keys(board.id);
    const out = await this.call('multi-exec', [['HDEL', k.people, pid], ['INCR', k.version]]);
    return Number(out[1]);
  }

  async book(board, booking) {
    const k = this.keys(board.id);
    const [ok, version] = await this.call('multi-exec', [
      ['SET', k.booking, JSON.stringify(booking), 'NX'], ['INCR', k.version], ...this.touch(board.id, board)
    ]);
    return ok === 'OK' ? Number(version) : null;
  }

  async unbook(board) {
    const k = this.keys(board.id);
    const out = await this.call('multi-exec', [['DEL', k.booking], ['INCR', k.version]]);
    return Number(out[1]);
  }
}

class MemoryStore {
  constructor(filePath) {
    this.kind = filePath ? 'file' : 'memory';
    this.filePath = filePath || null;
    this.boards = new Map();
    if (this.filePath) {
      try {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        Object.entries(data || {}).forEach(([id, doc]) => this.boards.set(id, doc));
      } catch {}
    }
  }

  persist() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.boards)));
    } catch {}
  }

  bump(doc) {
    doc.version = (doc.version || 0) + 1;
    this.persist();
    return doc.version;
  }

  async get(id) {
    const doc = this.boards.get(id);
    return doc ? JSON.parse(JSON.stringify(doc)) : null;
  }

  async version(id) {
    const doc = this.boards.get(id);
    return doc ? doc.version : null;
  }

  async create(board) {
    if (this.boards.has(board.id)) return false;
    this.boards.set(board.id, { board, participants: {}, booking: null, version: 1 });
    this.persist();
    return true;
  }

  async saveBoard(board) {
    const doc = this.boards.get(board.id);
    doc.board = board;
    return this.bump(doc);
  }

  async putParticipant(board, participant) {
    const doc = this.boards.get(board.id);
    doc.participants[participant.id] = participant;
    return this.bump(doc);
  }

  async deleteParticipant(board, pid) {
    const doc = this.boards.get(board.id);
    delete doc.participants[pid];
    return this.bump(doc);
  }

  async book(board, booking) {
    const doc = this.boards.get(board.id);
    if (doc.booking) return null;
    doc.booking = booking;
    return this.bump(doc);
  }

  async unbook(board) {
    const doc = this.boards.get(board.id);
    doc.booking = null;
    return this.bump(doc);
  }
}

function storeFromEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (url && token) return new RedisStore(url, token);
  const mem = globalThis.__S4C_COMMONBOARD_MEMORY__ || (globalThis.__S4C_COMMONBOARD_MEMORY__ = new MemoryStore());
  return mem;
}

/* ── HTTP plumbing ───────────────────────────────── */

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Array.isArray(req.body)) throw new HttpError(400, 'Request body must be a JSON object.');
    return req.body;
  }
  let raw = '';
  if (typeof req.body === 'string') raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large.');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large.');
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
  return parsed;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function requireKey(req) {
  const key = String(req.headers['x-orbit-key'] || '');
  if (key.length < 16 || key.length > 128) throw new HttpError(401, 'Missing or invalid key.');
  return key;
}

function optionalKey(req) {
  const key = String(req.headers['x-orbit-key'] || '');
  return key.length >= 16 && key.length <= 128 ? key : '';
}

async function loadDoc(store, id) {
  if (!ID_RE.test(id || '')) throw new HttpError(404, 'Board not found.');
  const doc = await store.get(id);
  if (!doc) throw new HttpError(404, 'Board not found.');
  return doc;
}

function isAdmin(doc, key) {
  return !!key && safeEqual(sha256(key), doc.board.adminHash || '');
}

/* ── Route handlers ──────────────────────────────── */

async function createBoard(store, req) {
  const adminKey = requireKey(req);
  const input = await readBody(req);
  const fields = validateBoardFields(input.board || input);
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const board = { id: newBoardId(), ...fields, createdAt: now, updatedAt: now, adminHash: sha256(adminKey) };
    if (await store.create(board)) {
      return { status: 201, body: publicDoc({ board, participants: {}, booking: null, version: 1 }) };
    }
  }
  throw new HttpError(503, 'Could not create the board. Please try again.');
}

async function editBoard(store, req, id) {
  const doc = await loadDoc(store, id);
  if (!isAdmin(doc, optionalKey(req))) throw new HttpError(403, 'Only the organiser can edit this board.');
  const input = await readBody(req);
  const fields = validateBoardFields(input.board || input, doc.board);
  const board = { ...doc.board, ...fields, updatedAt: Date.now() };
  if (doc.booking) {
    const start = Number(doc.booking.slot.slice(11, 13));
    const day = doc.booking.slot.slice(0, 10);
    if (day < board.startDate || day > board.endDate || start < board.startHour || start + doc.booking.hours > board.endHour) {
      throw new HttpError(409, 'The booked session would fall outside the board. Cancel the booking first, or keep its day and hours on the board.');
    }
  }
  const version = await store.saveBoard(board);
  return { status: 200, body: { board: publicBoard(board), version } };
}

async function saveParticipant(store, req, id, pid) {
  if (!PID_RE.test(pid || '')) throw new HttpError(400, 'Invalid participant id.');
  const key = requireKey(req);
  const doc = await loadDoc(store, id);
  const existing = doc.participants[pid];
  if (existing && !safeEqual(sha256(key), existing.keyHash || '')) {
    throw new HttpError(403, 'This entry belongs to someone else.');
  }
  if (!existing && Object.keys(doc.participants).length >= 200) {
    throw new HttpError(400, 'This board is full.');
  }
  const fields = validateParticipant(await readBody(req), doc.board);
  const participant = { id: pid, ...fields, updatedAt: Date.now(), keyHash: existing ? existing.keyHash : sha256(key) };
  const version = await store.putParticipant(doc.board, participant);
  return { status: 200, body: { participant: publicParticipant(participant), version } };
}

async function removeParticipant(store, req, id, pid) {
  const key = optionalKey(req);
  const doc = await loadDoc(store, id);
  const existing = doc.participants[pid];
  if (!existing) return { status: 200, body: { version: doc.version } };
  const isOwner = !!key && safeEqual(sha256(key), existing.keyHash || '');
  if (!isOwner && !isAdmin(doc, key)) throw new HttpError(403, 'Only that person or the organiser can remove them.');
  const version = await store.deleteParticipant(doc.board, pid);
  return { status: 200, body: { version } };
}

async function bookSession(store, req, id) {
  const key = requireKey(req);
  const doc = await loadDoc(store, id);
  if (doc.booking) throw new HttpError(409, 'This board already has a booking.', { booking: publicBooking(doc.booking) });
  const input = await readBody(req);
  const match = SLOT_RE.exec(input.slot || '');
  const hours = toInt(input.hours);
  const { board } = doc;
  if (!match || !isValidDate(match[1]) || !(hours >= 1 && hours <= MAX_SESSION_HOURS)) throw new HttpError(400, 'Choose a session time.');
  const startHour = Number(match[2]);
  if (match[1] < board.startDate || match[1] > board.endDate || startHour < board.startHour || startHour + hours > board.endHour) {
    throw new HttpError(400, 'That time is outside this board.');
  }
  const name = cleanText(input.name, 40);
  if (!name) throw new HttpError(400, 'Add your name to book.');
  const booking = { ref: newBookingRef(), slot: input.slot, hours, name, bookedAt: Date.now(), keyHash: sha256(key) };
  const version = await store.book(board, booking);
  if (version == null) {
    const latest = await store.get(id);
    throw new HttpError(409, 'Someone booked this board a moment ago.', { booking: publicBooking(latest && latest.booking) });
  }
  return { status: 201, body: { booking: publicBooking(booking), version } };
}

async function cancelBooking(store, req, id) {
  const key = optionalKey(req);
  const doc = await loadDoc(store, id);
  if (!doc.booking) return { status: 200, body: { version: doc.version } };
  const isBooker = !!key && safeEqual(sha256(key), doc.booking.keyHash || '');
  if (!isBooker && !isAdmin(doc, key)) throw new HttpError(403, 'Only the person who booked or the organiser can cancel.');
  const version = await store.unbook(doc.board);
  return { status: 200, body: { version } };
}

async function readBoard(store, id, since) {
  if (since != null && ID_RE.test(id || '')) {
    const version = await store.version(id);
    if (version == null) throw new HttpError(404, 'Board not found.');
    if (version === since) return { status: 200, body: { unchanged: true, version } };
  }
  const doc = await loadDoc(store, id);
  return { status: 200, body: publicDoc(doc) };
}

function createHandler(store) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const pid = url.searchParams.get('p');
    const action = url.searchParams.get('action');
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw != null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
    const s = store || storeFromEnv();
    try {
      let result;
      if (req.method === 'GET' && !id) {
        result = { status: 200, body: { ok: true, service: 'commonboard', storage: s.kind } };
      } else if (req.method === 'GET') {
        result = await readBoard(s, id, since);
      } else if (req.method === 'POST' && !id) {
        result = await createBoard(s, req);
      } else if (req.method === 'PATCH' && id) {
        result = await editBoard(s, req, id);
      } else if (req.method === 'PUT' && id && pid) {
        result = await saveParticipant(s, req, id, pid);
      } else if (req.method === 'DELETE' && id && pid) {
        result = await removeParticipant(s, req, id, pid);
      } else if (req.method === 'POST' && id && action === 'book') {
        result = await bookSession(s, req, id);
      } else if (req.method === 'DELETE' && id && action === 'book') {
        result = await cancelBooking(s, req, id);
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
      return send(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
      return send(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}

const handler = createHandler(null);
handler.createHandler = createHandler;
handler.MemoryStore = MemoryStore;
handler.RedisStore = RedisStore;
module.exports = handler;
