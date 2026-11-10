#!/usr/bin/env node
/* Teacher portal links must never replace a facilitator's local identity.
 *   node --test scripts/test-orbit-teacher-links.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ID = 'ob_teacher123';
const FAC = { pid: 'p_facilitator1', key: 'facilitator-key-0123456789' };
const TEACHER = { pid: 'p_teacher123', key: 'teacher-key-0123456789' };
const DOC = {
  board: { id: ID, title: 'Workshop', startDate: '2030-06-10', endDate: '2030-06-11', startHour: 9, endHour: 13, sessionHours: 2, timezone: 'UTC' },
  participants: {
    [FAC.pid]: { id: FAC.pid, name: 'Facilitator', role: 'facilitator', slots: ['2030-06-10T09', '2030-06-10T10'] },
    [TEACHER.pid]: { id: TEACHER.pid, name: 'Teacher', role: 'teacher', slots: ['2030-06-10T10'] }
  },
  version: 3, booking: null
};

function app(search = `?b=${ID}&role=teacher&view=group`) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'space4climate', 'orbit-app.js'), 'utf8');
  const startup = source.indexOf("  document.querySelectorAll('.s4c-btn_icon:empty')");
  assert.notEqual(startup, -1);
  const storage = new Map();
  const elements = new Map();
  const requests = [];
  const instrumented = source.slice(0, startup) + `
    renderBoard = () => { if (!S.tabReady) { S.tab = S.requestedTab || defaultTab(); S.tabReady = true; } };
    setStatus = () => {}; showView = () => {}; hideCellInfo = () => {};
    schedulePoll = () => {}; bindChannel = () => {}; checkStorage = () => {};
    rememberBoard = () => {}; queueSave = () => {}; toast = () => {};
    globalThis.testApp = { S, K, identityKeys, boardLinkOptions, openBoard, joinBoard, persistDraft, saveMe, applyDoc };
  })();`;
  const context = vm.createContext({
    document: {
      title: 'CommonBoard',
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: '', hidden: false, focus() {} });
        return elements.get(id);
      },
      querySelector(selector) { return selector.includes('me-role') ? { value: 'facilitator' } : null; }
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    location: { search, hash: '', pathname: '/commonboard.html' },
    window: { scrollTo() {} },
    history: { state: {}, replaceState() {} },
    URLSearchParams, Intl, Date, Set, Map, crypto: webcrypto, btoa,
    clearTimeout, setTimeout,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ version: 4, participant: { id: TEACHER.pid, ...body } }) };
    }
  });
  vm.runInContext(instrumented, context, { filename: 'orbit-app.js' });
  const put = (key, value) => storage.set(key, JSON.stringify(value));
  const get = (key) => JSON.parse(storage.get(key) ?? 'null');
  return { ...context.testApp, storage, elements, requests, put, get };
}

const doc = () => JSON.parse(JSON.stringify(DOC));

test('teacher link options accept only teacher role and supported initial views', () => {
  const { boardLinkOptions } = app();
  assert.equal(boardLinkOptions('?role=teacher&view=mine').teacherMode, true);
  assert.equal(boardLinkOptions('?role=teacher&view=mine').requestedTab, 'mine');
  assert.equal(boardLinkOptions('?role=teacher&view=group').requestedTab, 'group');
  assert.equal(boardLinkOptions('?role=facilitator&view=unknown').teacherMode, false);
  assert.equal(boardLinkOptions('?role=facilitator&view=unknown').requestedTab, null);
});

test('teacher board uses the portal identity and keeps the normal facilitator identity', async () => {
  const { S, K, openBoard, put, get } = app();
  put(K.me(ID), FAC);
  put(K.teacherMe(ID), TEACHER);
  await openBoard(ID, doc());
  assert.equal(S.me.pid, TEACHER.pid);
  assert.equal(S.teacherMode, true);
  assert.equal(S.tab, 'group');
  assert.deepEqual(get(K.me(ID)), FAC);
  assert.equal(S.doc.participants[FAC.pid].role, 'facilitator');
});

test('teacher edit link opens the teacher hours rather than facilitator hours', async () => {
  const { S, K, openBoard, put, get } = app(`?b=${ID}&role=teacher&view=mine`);
  put(K.me(ID), FAC);
  put(K.teacherMe(ID), TEACHER);
  await openBoard(ID, doc());
  assert.equal(S.tab, 'mine');
  assert.equal(S.doc.participants[S.me.pid].role, 'teacher');
  assert.deepEqual(get(K.me(ID)), FAC);
});

test('normal links retain the original facilitator identity and default view', async () => {
  const { S, K, openBoard, put } = app(`?b=${ID}`);
  put(K.me(ID), FAC);
  put(K.teacherMe(ID), TEACHER);
  await openBoard(ID, doc());
  assert.equal(S.me.pid, FAC.pid);
  assert.equal(S.teacherMode, false);
  assert.equal(S.tab, 'mine');
});

test('joining through a teacher link creates a separate teacher entry and profile', async () => {
  const { S, K, openBoard, joinBoard, put, get, elements } = app(`?b=${ID}&role=teacher&view=mine`);
  put(K.me(ID), FAC);
  put(K.profile, { name: 'Facilitator', role: 'facilitator' });
  await openBoard(ID, doc());
  elements.set('me-name', { value: 'New teacher' });
  joinBoard({ preventDefault() {} });
  assert.equal(S.draft.role, 'teacher', 'the role is teacher even if an old radio value says facilitator');
  assert.equal(S.tab, 'mine');
  assert.notEqual(S.me.pid, FAC.pid);
  assert.equal(get(K.teacherMe(ID)).pid, S.me.pid);
  assert.deepEqual(get(K.me(ID)), FAC);
  assert.deepEqual(get(K.profile), { name: 'Facilitator', role: 'facilitator' });
  assert.deepEqual(get(K.teacherProfile), { name: 'New teacher', role: 'teacher' });
  assert.equal(get(K.teacherPending(ID)).role, 'teacher');
});

test('saving a teacher draft uses the teacher key without clearing facilitator drafts', async () => {
  const { S, K, openBoard, persistDraft, saveMe, put, get, requests } = app();
  const facilitatorDraft = { name: 'Facilitator', role: 'facilitator', slots: ['2030-06-10T09'] };
  put(K.me(ID), FAC);
  put(K.teacherMe(ID), TEACHER);
  put(K.pending(ID), facilitatorDraft);
  await openBoard(ID, doc());
  assert.equal(S.draft, null, 'a facilitator draft is not loaded into the teacher context');
  S.draft = { name: 'Teacher', role: 'teacher', slots: new Set(['2030-06-10T11']) };
  persistDraft();
  await saveMe();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['X-Orbit-Key'], TEACHER.key);
  assert.match(requests[0].url, new RegExp('p=' + TEACHER.pid));
  assert.equal(JSON.parse(requests[0].body).role, 'teacher');
  assert.deepEqual(get(K.pending(ID)), facilitatorDraft);
  assert.equal(get(K.teacherPending(ID)), null);
  assert.equal(S.doc.participants[FAC.pid].slots.length, 2);
});

test('a mistaken teacher identity pointing at a facilitator is discarded locally', async () => {
  const { S, K, openBoard, put, get } = app();
  put(K.me(ID), FAC);
  put(K.teacherMe(ID), FAC);
  await openBoard(ID, doc());
  assert.equal(S.me, null);
  assert.equal(get(K.teacherMe(ID)), null);
  assert.deepEqual(get(K.me(ID)), FAC);
  assert.equal(S.doc.participants[FAC.pid].role, 'facilitator');
});
