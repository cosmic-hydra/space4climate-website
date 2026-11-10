#!/usr/bin/env node
/* Teacher portal scheduling regressions. Run: node --test scripts/test-teacher-portal.js */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  dateKey, slotInstant, validSlots, aggregateAvailability, teacherStorageKeys, availabilityText
} = require('../space4climate/teacher-portal.js');

const DAY = '2026-11-10';
const slot = (hour, day = DAY) => `${day}T${String(hour).padStart(2, '0')}`;
const person = (id, name, role, slots) => ({ id, name, role, slots });
function board(id, timezone, participants, fields = {}) {
  return {
    board: {
      id, title: `Board ${id}`, startDate: DAY, endDate: DAY,
      startHour: 0, endHour: 24, sessionHours: 1, timezone, ...fields
    },
    participants: Object.fromEntries(participants.map((p) => [p.id, p])),
    booking: null,
    version: 1
  };
}
const options = { from: DAY, to: DAY, timezone: 'UTC' };
const ids = (row) => row.entries.map((entry) => entry.id).sort();
const span = (row) => [new Date(row.start).toISOString(), new Date(row.end).toISOString()];

test('board wall-clock hours use the correct instant and display date in another timezone', () => {
  assert.equal(slotInstant(DAY, 10, 'Europe/Berlin'), Date.UTC(2026, 10, 10, 9));
  assert.equal(slotInstant(DAY, 14, 'Asia/Kolkata'), Date.UTC(2026, 10, 10, 8, 30));
  assert.equal(slotInstant(DAY, 24, 'Europe/Berlin'), Date.UTC(2026, 10, 10, 23));
  assert.equal(dateKey(slotInstant(DAY, 23, 'Europe/Berlin'), 'Asia/Kolkata'), '2026-11-11');
  assert.equal(slotInstant('2026-03-28', 10, 'Europe/Berlin'), Date.UTC(2026, 2, 28, 9));
  assert.equal(slotInstant('2026-03-29', 10, 'Europe/Berlin'), Date.UTC(2026, 2, 29, 8));
});

test('availability excludes malformed, duplicate and out-of-board hours after board edits', () => {
  const entry = person('p_alice', 'Alice', 'facilitator', [
    slot(8), slot(9), slot(9), slot(10), slot(11), slot(12),
    slot(10, '2026-11-09'), slot(10, '2026-11-11'), '2026-11-10T9', 'invalid'
  ]);
  const doc = board('ob_Aaaaaa', 'UTC', [entry], { startHour: 9, endHour: 12 });
  assert.deepEqual(validSlots(doc, entry).sort(), [slot(9), slot(10), slot(11)]);
});

test('combined availability splits partial UTC overlaps instead of grouping local hour labels', () => {
  const a = board('ob_Aaaaaa', 'Europe/Berlin', [person('p_alice', 'Alice', 'facilitator', [slot(10)])]);
  const b = board('ob_Bbbbbb', 'Asia/Kolkata', [person('p_bob', 'Bob', 'facilitator', [slot(14)])]);
  const rows = aggregateAvailability([a, b], options);
  assert.equal(rows.length, 3);
  assert.deepEqual(span(rows[0]), ['2026-11-10T08:30:00.000Z', '2026-11-10T09:00:00.000Z']);
  assert.deepEqual(span(rows[1]), ['2026-11-10T09:00:00.000Z', '2026-11-10T09:30:00.000Z']);
  assert.deepEqual(span(rows[2]), ['2026-11-10T09:30:00.000Z', '2026-11-10T10:00:00.000Z']);
  assert.deepEqual(ids(rows[0]), ['ob_Bbbbbb:p_bob']);
  assert.deepEqual(ids(rows[1]), ['ob_Aaaaaa:p_alice', 'ob_Bbbbbb:p_bob']);
  assert.deepEqual(ids(rows[2]), ['ob_Aaaaaa:p_alice']);
});

test('teacher and observer hours never create facilitator supply', () => {
  const doc = board('ob_Aaaaaa', 'UTC', [
    person('p_alice', 'Alice', 'facilitator', [slot(9)]),
    person('p_teacher', 'Teacher', 'teacher', [slot(9), slot(10)]),
    person('p_other', 'Observer', 'other', [slot(9), slot(10)])
  ]);
  const rows = aggregateAvailability([doc], options);
  assert.equal(rows.length, 1);
  assert.deepEqual(ids(rows[0]), ['ob_Aaaaaa:p_alice']);
  assert.deepEqual(span(rows[0]), ['2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z']);
});

test('adjacent hours merge only while the same facilitator entries cover them', () => {
  const doc = board('ob_Aaaaaa', 'UTC', [
    person('p_alice', 'Alice', 'facilitator', [slot(9), slot(10)]),
    person('p_bob', 'Bob', 'facilitator', [slot(11)])
  ]);
  const rows = aggregateAvailability([doc], options);
  assert.equal(rows.length, 2);
  assert.deepEqual(span(rows[0]), ['2026-11-10T09:00:00.000Z', '2026-11-10T11:00:00.000Z']);
  assert.deepEqual(ids(rows[0]), ['ob_Aaaaaa:p_alice']);
  assert.deepEqual(span(rows[1]), ['2026-11-10T11:00:00.000Z', '2026-11-10T12:00:00.000Z']);
  assert.deepEqual(ids(rows[1]), ['ob_Aaaaaa:p_bob']);
});

test('same display names stay distinct across boards while duplicate catalog pages do not double-count', () => {
  const a = board('ob_Aaaaaa', 'UTC', [person('p_shared', 'Alex', 'facilitator', [slot(9)])]);
  const b = board('ob_Bbbbbb', 'UTC', [person('p_shared', 'Alex', 'facilitator', [slot(9)])]);
  const rows = aggregateAvailability([a, b, a], options);
  assert.equal(rows.length, 1);
  assert.deepEqual(ids(rows[0]), ['ob_Aaaaaa:p_shared', 'ob_Bbbbbb:p_shared']);
  assert.equal(rows[0].entries[0].boardTitle, 'Board ob_Aaaaaa');
});

test('booked boards are excluded by default and can be included explicitly', () => {
  const doc = board('ob_Aaaaaa', 'UTC', [person('p_alice', 'Alice', 'facilitator', [slot(9)])]);
  doc.booking = { ref: 'S4C-ABC123', slot: slot(9), hours: 1, name: 'Teacher' };
  assert.equal(aggregateAvailability([doc], options).length, 0);
  assert.equal(aggregateAvailability([doc], { ...options, includeBooked: true }).length, 1);
});

test('range dates apply in the selected timezone and split a slot across local midnight', () => {
  const doc = board('ob_Aaaaaa', 'Europe/Berlin', [person('p_alice', 'Alice', 'facilitator', [slot(19)])]);
  const rows = aggregateAvailability([doc], { from: DAY, to: '2026-11-11', timezone: 'Asia/Kolkata' });
  assert.equal(rows.length, 2);
  assert.deepEqual(span(rows[0]), ['2026-11-10T18:00:00.000Z', '2026-11-10T18:30:00.000Z']);
  assert.deepEqual(span(rows[1]), ['2026-11-10T18:30:00.000Z', '2026-11-10T19:00:00.000Z']);
  assert.equal(dateKey(rows[0].start, 'Asia/Kolkata'), DAY);
  assert.equal(dateKey(rows[1].start, 'Asia/Kolkata'), '2026-11-11');
  const nextDay = aggregateAvailability([doc], { from: '2026-11-11', to: '2026-11-11', timezone: 'Asia/Kolkata' });
  assert.equal(nextDay.length, 1);
  assert.deepEqual(span(nextDay[0]), span(rows[1]));
});

test('teacher identity keys are separate from facilitator entries and separate for each board', () => {
  const keys = teacherStorageKeys('ob_Aaaaaa');
  assert.deepEqual(keys, {
    me: 'cb:teacher:me:ob_Aaaaaa',
    pending: 'cb:teacher:pending:ob_Aaaaaa',
    profile: 'cb:teacher:profile'
  });
  assert.notEqual(keys.me, 'cb:me:ob_Aaaaaa');
  assert.notEqual(keys.pending, 'cb:pending:ob_Aaaaaa');
  assert.notEqual(keys.me, teacherStorageKeys('ob_Bbbbbb').me);
});

test('copied availability uses the requested timezone and includes dates, facilitator and production board link', () => {
  const doc = board('ob_Aaaaaa', 'Europe/Berlin', [person('p_alice', 'Alice', 'facilitator', [slot(10)])]);
  const rows = aggregateAvailability([doc], options);
  const text = availabilityText(rows, 'Asia/Kolkata');
  assert.equal(typeof text, 'string');
  assert.match(text, /Facilitator availability/);
  assert.match(text, /Kolkata/);
  assert.match(text, /Nov|2026-11-10/);
  assert.match(text, /14:30/);
  assert.match(text, /15:30/);
  assert.match(text, /Alice/);
  assert.match(text, /https:\/\/www\.space4climate\.org\/commonboard\.html\?b=ob_Aaaaaa/);
  assert.match(availabilityText(rows, 'UTC', 'Workshop options'), /Workshop options/);
});
