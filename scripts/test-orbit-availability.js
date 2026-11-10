#!/usr/bin/env node
/* CommonBoard facilitator availability regressions.
 *   node --test scripts/test-orbit-availability.js
 *
 * The app is a browser IIFE. Replace its startup calls in this test's VM only,
 * so the actual scheduling logic runs without networking or a browser build.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const DAY = '2030-06-10';
const NEXT_DAY = '2030-06-11';
const slot = (hour, day = DAY) => `${day}T${String(hour).padStart(2, '0')}`;
const BOARD = {
  startDate: DAY, endDate: NEXT_DAY, startHour: 9, endHour: 13,
  sessionHours: 2, timezone: 'UTC'
};

function element() {
  return {
    dataset: {}, attributes: {}, style: {}, textContent: '', hidden: false,
    offsetWidth: 240, offsetHeight: 80,
    getBoundingClientRect() { return { left: 100, top: 100, bottom: 144, width: 44 }; },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  };
}

function app(participants = []) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'space4climate', 'orbit-app.js'), 'utf8');
  const startup = source.indexOf("  document.querySelectorAll('.s4c-btn_icon:empty')");
  assert.notEqual(startup, -1, 'browser startup entrypoint must remain identifiable');
  const instrumented = source.slice(0, startup) +
    '  globalThis.testApp = { S, people, facilitators, availabilityMap, windows, defaultTab, patchGrid, showCellInfo, updateBookSummary };\n})();';
  const elements = new Map();
  const context = vm.createContext({
    document: {
      title: 'CommonBoard',
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      }
    },
    Intl, Date, Set, Map,
    window: { innerWidth: 1200, innerHeight: 800 }
  });
  vm.runInContext(instrumented, context, { filename: 'orbit-app.js' });
  const api = context.testApp;
  api.S.doc = { board: { ...BOARD }, participants: Object.fromEntries(participants.map((p) => [p.id, p])), booking: null };
  return { ...api, elements };
}

const person = (id, role, hours, day = DAY) => ({ id, name: id, role, slots: hours.map((h) => slot(h, day)) });
const ids = (people) => Array.from(people, (p) => p.id).sort();

test('visitors and teachers open the combined view; facilitators open their hours', () => {
  const { S, defaultTab } = app([
    person('facilitator', 'facilitator', []),
    person('teacher', 'teacher', []),
    person('observer', 'other', [])
  ]);
  assert.equal(S.tab, 'group', 'a new visitor sees facilitator availability immediately');
  assert.equal(defaultTab(), 'group');
  S.me = { pid: 'teacher' };
  assert.equal(defaultTab(), 'group');
  S.me = { pid: 'observer' };
  assert.equal(defaultTab(), 'group');
  S.me = { pid: 'facilitator' };
  assert.equal(defaultTab(), 'mine');
  S.draft = { name: 'facilitator', role: 'teacher', slots: new Set() };
  assert.equal(defaultTab(), 'group', 'unsaved role changes use the matching view');
});

test('the cumulative grid counts only facilitators, including overlapping entries', () => {
  const { S, patchGrid } = app([
    person('alice', 'facilitator', [9, 10]),
    person('bob', 'facilitator', [10, 11]),
    person('teacher', 'teacher', [9, 10, 11, 12]),
    person('observer', 'other', [10, 12])
  ]);
  S.tab = 'group';
  S.cellList = [9, 10, 11, 12].map((hour) => {
    const cell = element();
    cell.dataset.slot = slot(hour);
    return cell;
  });
  patchGrid();
  assert.deepEqual(Array.from(S.cellList, (cell) => cell.textContent), ['1', '2', '1', '']);
  assert.deepEqual(ids(S.avail.get(slot(10))), ['alice', 'bob']);
  assert.equal(S.avail.has(slot(12)), false, 'teacher-only hours do not create facilitator supply');
  assert.match(S.cellList[1].attributes['aria-label'], /2 of 2 facilitators/);
});

test('no facilitator availability produces no suggested sessions', () => {
  const { windows } = app([
    person('teacher', 'teacher', [9, 10, 11]),
    person('observer', 'other', [9, 10, 11])
  ]);
  assert.equal(windows(2).length, 0);
});

test('hour details name only available and unmarked facilitators', () => {
  const { S, elements, patchGrid, showCellInfo } = app([
    person('Alice', 'facilitator', [9]),
    person('Bob', 'facilitator', [10]),
    person('TeacherOnly', 'teacher', [9]),
    person('ObserverOnly', 'other', [9])
  ]);
  S.tab = 'group';
  const cell = element();
  cell.dataset.slot = slot(9);
  S.cellList = [cell];
  patchGrid();
  showCellInfo(cell, true);
  assert.equal(elements.get('tt-count').textContent, '1 of 2 facilitators available');
  const names = elements.get('tt-names').innerHTML;
  assert.match(names, /Available:<\/span> Alice/);
  assert.match(names, /Not marked available:<\/span> Bob/);
  assert.doesNotMatch(names, /TeacherOnly|ObserverOnly/);
});

test('booking summaries count full-session facilitators and preserve the availability warning', () => {
  const { elements, updateBookSummary } = app([
    person('Alice', 'facilitator', [9, 10]),
    person('Bob', 'facilitator', [10, 11]),
    person('TeacherOnly', 'teacher', [9, 10, 11]),
    person('ObserverOnly', 'other', [9, 10, 11])
  ]);
  for (const [id, value] of [['book-date', DAY], ['book-start', '9'], ['book-len', '2']]) {
    const node = element();
    node.value = value;
    elements.set(id, node);
  }
  updateBookSummary();
  const summary = elements.get('book-summary').innerHTML;
  assert.match(summary, /1 facilitator available for the whole session\. Alice/);
  assert.match(summary, /Not marked available: Bob/);
  assert.doesNotMatch(summary, /TeacherOnly|ObserverOnly|cb-warn/);
  elements.get('book-len').value = '3';
  updateBookSummary();
  assert.match(elements.get('book-summary').innerHTML, /No facilitator has marked this whole time as available/);
  assert.equal(elements.get('book-confirm').disabled, false, 'availability remains a warning, not a new booking restriction');
});

test('suggested times rank facilitator capacity without teacher availability', () => {
  const { windows } = app([
    person('alice', 'facilitator', [9, 10, 11]),
    person('bob', 'facilitator', [10, 11]),
    person('teacher', 'teacher', [9, 10]),
    person('observer', 'other', [9, 10])
  ]);
  const suggestions = windows(2);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].start, 10, 'two facilitators rank ahead of one even without a teacher entry');
  assert.deepEqual(ids(suggestions[0].free), ['alice', 'bob']);
  assert.deepEqual(ids(suggestions[1].free), ['alice']);
});

test('a multi-hour session needs the same facilitator for its whole duration', () => {
  const { windows } = app([
    person('alice', 'facilitator', [9]),
    person('bob', 'facilitator', [10]),
    person('teacher', 'teacher', [9, 10])
  ]);
  assert.equal(windows(1).length, 2, 'each single hour remains available');
  assert.equal(windows(2).length, 0, 'different facilitators cannot be stitched into a full session');
});

test('unsaved facilitator edits update the cumulative supply immediately', () => {
  const { S, facilitators, availabilityMap, windows } = app([
    person('alice', 'facilitator', [9, 10]),
    person('bob', 'facilitator', [9, 10])
  ]);
  S.me = { pid: 'alice' };
  S.draft = { name: 'Alice edited', role: 'facilitator', slots: new Set([slot(10), slot(11)]) };
  const available = availabilityMap(facilitators());
  assert.deepEqual(ids(available.get(slot(9))), ['bob']);
  assert.deepEqual(ids(available.get(slot(10))), ['alice', 'bob']);
  assert.deepEqual(ids(windows(2).find((w) => w.start === 10).free), ['alice']);
  S.draft.role = 'teacher';
  assert.deepEqual(ids(facilitators()), ['bob'], 'changing role removes an entry from supply');
});

test('hours outside the current board are excluded after a board edit', () => {
  const participant = person('alice', 'facilitator', [8, 9, 10, 12, 13]);
  participant.slots.push(slot(10, '2030-06-09'), slot(10, '2030-06-12'));
  const { facilitators, availabilityMap, windows } = app([participant]);
  const available = availabilityMap(facilitators());
  assert.deepEqual(Array.from(available.keys()).sort(), [slot(9), slot(10), slot(12)]);
  assert.deepEqual(Array.from(windows(2), (w) => w.start), [9]);
});
