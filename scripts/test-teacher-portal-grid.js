#!/usr/bin/env node
/* Teacher portal date-column/time-row grid. Run: node --test scripts/test-teacher-portal-grid.js */
const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateAvailability, buildAvailabilityGrid, dateKey } = require('../space4climate/teacher-portal.js');

const DAY = '2026-11-10';
const NEXT = '2026-11-11';
const THIRD = '2026-11-12';
const instant = text => Date.parse(text);
const entry = (boardId, pid, name = pid) => ({ id: `${boardId}:${pid}`, name, boardId, boardTitle: `Board ${boardId}` });
const row = (start, end, entries) => ({ start: instant(start), end: instant(end), entries });
const options = { from: DAY, to: THIRD, timezone: 'UTC' };
function cellAt(grid, date, minute) {
  const band = grid.bands.find(item => item.startMinute <= minute && item.endMinute > minute);
  assert.ok(band, `a time band covers minute ${minute}`);
  const cell = band.cells.find(item => item.date === date);
  assert.ok(cell, `the ${date} date column exists`);
  return cell;
}
const ids = cell => cell.entries.map(person => person.id).sort();

test('dates form columns including empty days and the grid shows two-facilitator overlap', () => {
  const alice = entry('ob_Aaaaaa', 'p_alice', 'Alice');
  const bob = entry('ob_Bbbbbb', 'p_bob', 'Bob');
  const rows = [
    row('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z', [alice]),
    row('2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z', [alice, bob]),
    row('2026-11-10T11:00:00Z', '2026-11-10T12:00:00Z', [bob]),
    row('2026-11-11T09:00:00Z', '2026-11-11T10:00:00Z', [bob])
  ];
  const grid = buildAvailabilityGrid(rows, options);
  assert.deepEqual(grid.dates, [DAY, NEXT, THIRD]);
  assert.equal(grid.maxCount, 2);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60)), [alice.id]);
  assert.deepEqual(ids(cellAt(grid, DAY, 10 * 60)), [alice.id, bob.id]);
  assert.deepEqual(ids(cellAt(grid, DAY, 11 * 60)), [bob.id]);
  assert.deepEqual(ids(cellAt(grid, NEXT, 9 * 60)), [bob.id]);
  assert.deepEqual(ids(cellAt(grid, NEXT, 10 * 60)), []);
  for (const band of grid.bands) {
    assert.deepEqual(band.cells.map(cell => cell.date), grid.dates);
    assert.deepEqual(ids(band.cells[2]), [], 'a day with no hours stays visibly empty');
    assert.ok(band.startMinute < band.endMinute);
  }
});

test('half-hour time-zone overlaps retain separate rows and accurate full-band counts', () => {
  const doc = (id, timezone, name, hour) => ({
    board: { id, title: id, startDate: DAY, endDate: DAY, startHour: 0, endHour: 24, timezone },
    participants: { p_person: { id: 'p_person', name, role: 'facilitator', slots: [`${DAY}T${hour}`] } },
    booking: null
  });
  const rows = aggregateAvailability([
    doc('ob_Aaaaaa', 'Europe/Berlin', 'Alice', '10'),
    doc('ob_Bbbbbb', 'Asia/Kolkata', 'Bob', '14')
  ], options);
  const grid = buildAvailabilityGrid(rows, options);
  assert.equal(grid.maxCount, 2);
  assert.deepEqual(ids(cellAt(grid, DAY, 8 * 60 + 30)), ['ob_Bbbbbb:p_person']);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60)), ['ob_Aaaaaa:p_person', 'ob_Bbbbbb:p_person']);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60 + 30)), ['ob_Aaaaaa:p_person']);
  for (const band of grid.bands) {
    assert.ok(band.endMinute - band.startMinute <= 30, 'a partial overlap cannot be hidden inside a whole-hour cell');
  }
});

test('quarter-hour display offsets preserve their exact cell boundaries', () => {
  const alice = entry('ob_Aaaaaa', 'p_alice', 'Alice');
  const grid = buildAvailabilityGrid([
    row('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z', [alice])
  ], { from: DAY, to: DAY, timezone: 'Asia/Kathmandu' });
  const first = grid.bands[0];
  const last = grid.bands.at(-1);
  assert.equal(first.startMinute, 14 * 60 + 45);
  assert.equal(last.endMinute, 15 * 60 + 45);
  for (const band of grid.bands) {
    assert.ok(band.endMinute - band.startMinute <= 15);
    assert.deepEqual(ids(band.cells[0]), [alice.id]);
    assert.ok(band.cells[0].start >= instant('2026-11-10T09:00:00Z'));
    assert.ok(band.cells[0].end <= instant('2026-11-10T10:00:00Z'));
  }
});

test('gaps remain empty and no facilitator is counted for a band they only partly cover', () => {
  const alice = entry('ob_Aaaaaa', 'p_alice', 'Alice');
  const bob = entry('ob_Bbbbbb', 'p_bob', 'Bob');
  const rows = [
    row('2026-11-10T09:00:00Z', '2026-11-10T09:15:00Z', [alice]),
    row('2026-11-10T09:45:00Z', '2026-11-10T10:00:00Z', [bob])
  ];
  const grid = buildAvailabilityGrid(rows, { ...options, to: DAY });
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60)), [alice.id]);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60 + 15)), []);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60 + 30)), []);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60 + 45)), [bob.id]);
  for (const band of grid.bands) {
    for (const cell of band.cells) {
      for (const facilitator of cell.entries) {
        assert.ok(rows.some(item => item.start <= cell.start && item.end >= cell.end && item.entries.some(p => p.id === facilitator.id)), 'each listed facilitator covers the entire cell');
      }
    }
  }
});

test('midnight ends at 24:00 on the first date and starts at 00:00 on the next date', () => {
  const alice = entry('ob_Aaaaaa', 'p_alice', 'Alice');
  const bob = entry('ob_Bbbbbb', 'p_bob', 'Bob');
  const grid = buildAvailabilityGrid([
    row('2026-11-10T23:00:00Z', '2026-11-11T00:00:00Z', [alice]),
    row('2026-11-11T00:00:00Z', '2026-11-11T01:00:00Z', [bob])
  ], { from: DAY, to: NEXT, timezone: 'UTC' });
  assert.deepEqual(grid.dates, [DAY, NEXT]);
  assert.equal(grid.bands[0].startMinute, 0);
  assert.equal(grid.bands.at(-1).endMinute, 1440);
  assert.deepEqual(ids(cellAt(grid, DAY, 23 * 60)), [alice.id]);
  assert.deepEqual(ids(cellAt(grid, NEXT, 23 * 60)), []);
  assert.deepEqual(ids(cellAt(grid, DAY, 0)), []);
  assert.deepEqual(ids(cellAt(grid, NEXT, 0)), [bob.id]);
  assert.equal(cellAt(grid, DAY, 23 * 60).end <= instant('2026-11-11T00:00:00Z'), true);
});

test('display dates use the chosen timezone rather than raw UTC dates', () => {
  const alice = entry('ob_Aaaaaa', 'p_alice', 'Alice');
  const grid = buildAvailabilityGrid([
    row('2026-11-10T22:00:00Z', '2026-11-10T23:00:00Z', [alice])
  ], { from: DAY, to: NEXT, timezone: 'Asia/Kolkata' });
  assert.deepEqual(ids(cellAt(grid, NEXT, 3 * 60 + 30)), [alice.id]);
  assert.deepEqual(ids(cellAt(grid, DAY, 3 * 60 + 30)), []);
  const cell = cellAt(grid, NEXT, 3 * 60 + 30);
  assert.equal(dateKey(cell.start, 'Asia/Kolkata'), NEXT);
});

test('distinct same-name entries survive while duplicate source rows do not inflate the count', () => {
  const first = entry('ob_Aaaaaa', 'p_shared', 'Alex');
  const second = entry('ob_Bbbbbb', 'p_shared', 'Alex');
  const duplicate = row('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z', [first, first, second]);
  const grid = buildAvailabilityGrid([duplicate, duplicate], { ...options, to: DAY });
  assert.equal(grid.maxCount, 2);
  assert.deepEqual(ids(cellAt(grid, DAY, 9 * 60)), [first.id, second.id]);
});

test('empty availability still supplies the selected date columns without invented hours', () => {
  const grid = buildAvailabilityGrid([], options);
  assert.deepEqual(grid.dates, [DAY, NEXT, THIRD]);
  assert.deepEqual(grid.bands, []);
  assert.equal(grid.maxCount, 0);
});
