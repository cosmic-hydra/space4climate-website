/* CommonBoard (Orbit Scheduler): find a workshop time that works for everyone.
   Front end for /api/orbit (see api/orbit.js). */
(() => {
  'use strict';

  const API = '/api/orbit';
  const POLL_MS = 4000;
  const POLL_MAX_MS = 30000;
  const SAVE_DELAY_MS = 450;
  const MAX_DAYS = 28;
  const BEST_SHOWN = 5;
  const ROLE_LABELS = { facilitator: 'Facilitator', teacher: 'Teacher', other: 'Other' };
  const ROLE_ORDER = { facilitator: 0, teacher: 1, other: 2 };
  const VIEWER_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  })();
  const ARROW = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M0 7.88384L7.72679e-08 6.11616L10.6061 6.11616L5.74495 1.25505L7 0L14 7L7 14L5.74495 12.7449L10.6061 7.88384H0Z" fill="currentColor"/></svg>';
  const DEFAULT_TITLE = document.title;

  /* ── Utilities ─────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtHour = (h) => `${pad2(h)}:00`;
  const slotKey = (date, hour) => `${date}T${pad2(hour)}`;
  const parseSlot = (slot) => ({ date: slot.slice(0, 10), hour: Number(slot.slice(11, 13)) });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  function randomKey(bytes = 18) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const newPid = () => 'p_' + randomKey(9);

  const local = {
    get(key) { try { const v = localStorage.getItem(key); return v == null ? null : JSON.parse(v); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} }
  };
  const K = {
    profile: 'cb:profile',
    recent: 'cb:recent',
    me: (id) => `cb:me:${id}`,
    admin: (id) => `cb:admin:${id}`,
    bookKey: (id) => `cb:bookkey:${id}`,
    pending: (id) => `cb:pending:${id}`,
    cache: (id) => `cb:cache:${id}`
  };

  function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.className = `show toast-${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.className = ''; }, kind === 'err' ? 4500 : 3000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const t = document.createElement('textarea');
        t.value = text;
        t.setAttribute('readonly', '');
        t.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(t);
        t.select();
        const ok = document.execCommand('copy');
        t.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function download(filename, href) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function setButtonLabel(btn, text) {
    const span = btn.querySelector('span');
    (span || btn).textContent = text;
  }

  function radioValue(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : 'other';
  }
  function setRadio(name, value) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((el) => { el.checked = el.value === value; });
  }

  /* ── Calendar dates (board dates are plain YYYY-MM-DD strings) ── */
  const isoToUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const utcToIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (iso, n) => utcToIso(isoToUtc(iso) + n * 86400000);
  function dateRange(start, end) {
    const out = [];
    for (let d = start; d <= end && out.length < MAX_DAYS; d = addDays(d, 1)) out.push(d);
    return out;
  }
  const fmtDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
    new Date(isoToUtc(iso)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  const fmtLongDate = (iso) => fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);

  /* ── Time zones ────────────────────────────────── */
  function dateIn(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    } catch {
      return utcToIso(ms);
    }
  }
  const timeIn = (ms, tz) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });

  function tzOffset(tz, ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
      }).formatToParts(new Date(ms));
      const v = (type) => Number((parts.find((p) => p.type === type) || {}).value);
      const wall = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'));
      return Math.round((wall - Math.floor(ms / 60000) * 60000) / 60000);
    } catch {
      return 0;
    }
  }

  // The real instant of a board's wall-clock hour, e.g. 10:00 on 2026-10-13 in Europe/Berlin.
  function boardInstant(date, hour, tz) {
    const naive = isoToUtc(date) + hour * 3600000;
    const first = naive - tzOffset(tz, naive) * 60000;
    return naive - tzOffset(tz, first) * 60000;
  }

  const CITY_ALIASES = { Calcutta: 'Kolkata', Saigon: 'Ho Chi Minh City', Kiev: 'Kyiv', Rangoon: 'Yangon', Katmandu: 'Kathmandu' };
  const cityOf = (tz) => {
    const city = (String(tz).split('/').pop() || tz).replace(/_/g, ' ');
    return CITY_ALIASES[city] || city;
  };
  function fmtOffset(mins) {
    const a = Math.abs(mins);
    return `UTC${mins < 0 ? '−' : '+'}${Math.floor(a / 60)}${a % 60 ? ':' + pad2(a % 60) : ''}`;
  }
  function fmtDiff(mins) {
    const a = Math.abs(mins);
    const span = [Math.floor(a / 60) ? `${Math.floor(a / 60)} h` : '', a % 60 ? `${a % 60} min` : ''].filter(Boolean).join(' ');
    return `${span} ${mins > 0 ? 'ahead' : 'behind'}`;
  }

  /* ── API ───────────────────────────────────────── */
  async function api(method, params, { key, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['X-Orbit-Key'] = key;
    let res;
    try {
      res = await fetch(API + (params ? '?' + new URLSearchParams(params) : ''), {
        method, headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      const err = new Error('You seem to be offline. We will keep trying.');
      err.offline = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Something went wrong (${res.status}).`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ── State ─────────────────────────────────────── */
  const S = {
    id: null,
    doc: null,            // { board, participants, booking, version }
    me: null,             // { pid, key } for this device
    adminKey: null,
    bookingKey: null,
    draft: null,          // my unsaved { name, role, slots: Set }
    draftSeq: 0,
    tab: 'mine',
    length: null,
    localTimes: false,
    showAllBest: false,
    saving: false,
    saveQueued: false,
    saveTimer: null,
    pollTimer: null,
    pollDelay: POLL_MS,
    status: '',
    storage: null,
    channel: null,
    drag: null,
    touch: null,
    cells: [],
    cellList: [],
    gridSig: '',
    avail: new Map(),
    ticketKey: null,
    seenVersion: 0,
    refParam: null,
    lastFocus: null
  };

  /* ── People and availability ───────────────────── */
  function slotOnBoard(b, slot) {
    const date = slot.slice(0, 10);
    const hour = Number(slot.slice(11, 13));
    return date >= b.startDate && date <= b.endDate && hour >= b.startHour && hour < b.endHour;
  }
  const inBoard = (slot) => slotOnBoard(S.doc.board, slot);
  const boardSlots = (slots) => new Set([...slots].filter(inBoard));
  const myEntry = () => (S.me && S.doc ? S.doc.participants[S.me.pid] || null : null);
  const isJoined = () => !!(S.draft || myEntry());
  function myProfile() {
    if (S.draft) return { name: S.draft.name, role: S.draft.role };
    const e = myEntry();
    return e ? { name: e.name, role: e.role } : null;
  }
  function mySlots() {
    if (S.draft) return boardSlots(S.draft.slots);
    const e = myEntry();
    return boardSlots(e ? e.slots : []);
  }

  // Everyone on the board, with this device's unsaved edits applied.
  function people() {
    const list = Object.values(S.doc.participants).map((p) => ({ ...p, slots: boardSlots(p.slots) }));
    if (S.me && S.draft) {
      const mine = { id: S.me.pid, name: S.draft.name, role: S.draft.role, slots: boardSlots(S.draft.slots) };
      const i = list.findIndex((p) => p.id === S.me.pid);
      if (i >= 0) list[i] = mine;
      else list.push(mine);
    }
    return list;
  }

  function availabilityMap(ps) {
    const map = new Map();
    ps.forEach((p) => p.slots.forEach((s) => {
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(p);
    }));
    return map;
  }

  function listNames(ps, max = 3) {
    const names = ps.map((p) => p.name);
    return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  }

  // Every session window of `length` hours where at least one person is free, best first.
  function windows(length) {
    const b = S.doc.board;
    const ps = people();
    if (!ps.length) return [];
    const needFac = ps.some((p) => p.role === 'facilitator');
    const needTea = ps.some((p) => p.role === 'teacher');
    const out = [];
    dateRange(b.startDate, b.endDate).forEach((date) => {
      for (let h = b.startHour; h + length <= b.endHour; h++) {
        const hours = Array.from({ length }, (_, i) => slotKey(date, h + i));
        const free = ps.filter((p) => hours.every((s) => p.slots.has(s)));
        if (!free.length) continue;
        const fac = free.filter((p) => p.role === 'facilitator').length;
        const tea = free.filter((p) => p.role === 'teacher').length;
        out.push({
          date, start: h, length, free, fac, tea, needFac, needTea,
          missing: ps.filter((p) => !free.includes(p)),
          covers: (!needFac || fac > 0) && (!needTea || tea > 0)
        });
      }
    });
    return out.sort((a, z) => (z.covers - a.covers) || (z.free.length - a.free.length) || a.date.localeCompare(z.date) || a.start - z.start);
  }

  function bookingWindow() {
    const bk = S.doc && S.doc.booking;
    if (!bk) return null;
    const { date, hour } = parseSlot(bk.slot);
    return { date, start: hour, length: bk.hours };
  }
  function bookedSlots() {
    const w = bookingWindow();
    const set = new Set();
    if (w) for (let i = 0; i < w.length; i++) set.add(slotKey(w.date, w.start + i));
    return set;
  }

  /* ── Time-zone display ─────────────────────────── */
  function diffOn(date, hour) {
    const tz = S.doc.board.timezone;
    const at = boardInstant(date, hour, tz);
    return tzOffset(VIEWER_TZ, at) - tzOffset(tz, at);
  }
  // Viewer-minus-board offset for each day, grouped into runs (they differ when clocks change).
  function tzInfo() {
    const b = S.doc.board;
    const runs = [];
    dateRange(b.startDate, b.endDate).forEach((date) => {
      const diff = diffOn(date, b.startHour);
      const last = runs[runs.length - 1];
      if (last && last.diff === diff) last.to = date;
      else runs.push({ from: date, to: date, diff });
    });
    return { runs, any: runs.some((r) => r.diff), varies: runs.length > 1, first: runs[0].diff };
  }
  const tzDiffMinutes = () => tzInfo().first;
  function viewerRange(date, start, length) {
    const tz = S.doc.board.timezone;
    const a = boardInstant(date, start, tz);
    const z = boardInstant(date, start + length, tz);
    const day = dateIn(a, VIEWER_TZ);
    return `${timeIn(a, VIEWER_TZ)}–${timeIn(z, VIEWER_TZ)}${day !== date ? ` on ${fmtDate(day)}` : ''}`;
  }
  function hourLabelHtml(date, hour) {
    if (!S.localTimes) return `<span>${fmtHour(hour)}</span>`;
    const at = boardInstant(date, hour, S.doc.board.timezone);
    const shift = Math.round((isoToUtc(dateIn(at, VIEWER_TZ)) - isoToUtc(date)) / 86400000);
    return `<span>${timeIn(at, VIEWER_TZ)}</span>${shift ? `<sup>${shift > 0 ? '+' : '−'}${Math.abs(shift)}d</sup>` : ''}`;
  }

  /* ── Status, banners and header ────────────────── */
  const STATUS = {
    connecting: ['Connecting…', ''],
    live: ['Live', 'is-live'],
    saving: ['Saving…', 'is-busy'],
    saved: ['Saved', 'is-live'],
    offline: ['Offline · retrying', 'is-warn'],
    error: ['Sync problem · retrying', 'is-warn']
  };
  function setStatus(kind) {
    S.status = kind;
    const [text, cls] = STATUS[kind] || STATUS.live;
    const el = $('bv-status');
    el.textContent = text;
    el.className = `cb-status ${cls}`;
    clearTimeout(setStatus.timer);
    if (kind === 'saved') setStatus.timer = setTimeout(() => { if (S.status === 'saved') setStatus('live'); }, 1600);
  }

  function renderHeader() {
    const b = S.doc.board;
    $('bv-title').textContent = b.title;
    $('bv-meta').innerHTML = [
      fmtRange(b.startDate, b.endDate),
      `${fmtHour(b.startHour)}–${fmtHour(b.endHour)} each day`,
      `${plural(b.sessionHours, 'hour')} per session`,
      `${cityOf(b.timezone)} time (${fmtOffset(tzOffset(b.timezone, boardInstant(b.startDate, b.startHour, b.timezone)))})`
    ].map((t) => `<span>${esc(t)}</span>`).join('');
    $('bv-edit-btn').hidden = !S.adminKey;
    document.title = `${b.title} · CommonBoard | Space4Climate`;
  }

  function renderBanner() {
    const msgs = [];
    if (S.storage === 'memory') {
      msgs.push(['warn', 'This server is not connected to permanent storage yet, so boards can disappear. Please don’t rely on it for real bookings yet.']);
    }
    if (S.refParam && S.doc) {
      if (S.doc.booking && S.doc.booking.ref === S.refParam) {
        msgs.push(['ok', `Booking <strong>${esc(S.refParam)}</strong> is confirmed on this board.`]);
      } else {
        msgs.push(['warn', `There is no booking with reference <strong>${esc(S.refParam)}</strong> on this board.`]);
      }
    }
    const el = $('bv-banner');
    el.hidden = !msgs.length;
    el.innerHTML = msgs.map(([kind, text]) => `<p class="is-${kind}">${text}</p>`).join('');
  }

  function renderTzBar() {
    const info = tzInfo();
    const bar = $('bv-tz');
    if (!info.any) {
      bar.hidden = true;
      S.localTimes = false;
      return;
    }
    const b = S.doc.board;
    const phrase = (d) => (d ? fmtDiff(d) : 'on the same time');
    const where = info.varies
      ? `${info.runs.map((r, i) => `${phrase(r.diff)} ${i === 0 ? `until ${fmtDate(r.to)}` : `from ${fmtDate(r.from)}`}`).join(', then ')}, because the clocks change`
      : phrase(info.first);
    bar.hidden = false;
    $('bv-tz-text').innerHTML = S.localTimes
      ? `Showing <strong>your time</strong> (${esc(cityOf(VIEWER_TZ))}). The board itself uses ${esc(cityOf(b.timezone))} time.` +
        (info.varies ? ` The clocks change during these dates: the times on the left are for ${esc(fmtDate(b.startDate))}, and days marked with a shift are offset from them.` : '')
      : `Times on this board are <strong>${esc(cityOf(b.timezone))} time</strong>. You are in ${esc(cityOf(VIEWER_TZ))}, ${esc(where)}.`;
    const btn = $('bv-tz-toggle');
    btn.textContent = S.localTimes ? `Show ${cityOf(b.timezone)} time` : 'Show my time';
    btn.setAttribute('aria-pressed', String(S.localTimes));
  }

  function renderMe() {
    const joined = isJoined();
    $('bv-join').hidden = joined;
    $('bv-me').hidden = !joined;
    if (!joined) {
      if (!S.joinPrefilled) {
        const profile = local.get(K.profile) || {};
        $('me-name').value = profile.name || '';
        setRadio('me-role', profile.role || 'other');
        S.joinPrefilled = true;
      }
      return;
    }
    const p = myProfile();
    const count = mySlots().size;
    const avatar = $('me-avatar');
    avatar.textContent = initials(p.name);
    avatar.dataset.role = p.role;
    $('me-label').textContent = `${p.name} · ${ROLE_LABELS[p.role]}`;
    $('me-sub').textContent = count ? `You have marked ${plural(count, 'hour')}.` : 'You have not marked any hours yet.';
  }

  /* ── Grid ──────────────────────────────────────── */
  const gridSignature = () => {
    const b = S.doc.board;
    return [b.startDate, b.endDate, b.startHour, b.endHour, S.tab, S.localTimes].join('|');
  };

  function buildGrid() {
    const b = S.doc.board;
    const days = dateRange(b.startDate, b.endDate);
    const interactive = S.tab === 'mine';
    const html = [`<div class="cb-corner">${esc(S.localTimes ? 'Your time' : cityOf(b.timezone))}</div>`];
    const firstDiff = S.localTimes ? diffOn(days[0], b.startHour) : 0;
    days.forEach((d, c) => {
      const shift = S.localTimes ? diffOn(d, b.startHour) - firstDiff : 0;
      const shiftNote = shift ? `<em>${shift > 0 ? '+' : '−'}${esc(fmtDiff(Math.abs(shift)).replace(/ (ahead|behind)$/, ''))}</em>` : '';
      html.push(`<button type="button" class="cb-day" data-day="${d}" data-col="${c}" ${interactive ? `aria-label="Select or clear all of ${esc(fmtDate(d))}"` : 'tabindex="-1" disabled'}><span>${esc(fmtDate(d, { weekday: 'short' }))}</span><strong>${esc(fmtDate(d, { day: 'numeric', month: 'short' }))}</strong>${shiftNote}</button>`);
    });
    for (let h = b.startHour, r = 0; h < b.endHour; h++, r++) {
      html.push(`<button type="button" class="cb-hour" data-row="${r}" ${interactive ? `aria-label="Select or clear ${fmtHour(h)} on every day"` : 'tabindex="-1" disabled'}>${hourLabelHtml(days[0], h)}</button>`);
      days.forEach((d, c) => html.push(`<div class="cb-cell" role="button" tabindex="-1" data-slot="${slotKey(d, h)}" data-col="${c}" data-row="${r}"></div>`));
    }
    const grid = $('grid');
    grid.innerHTML = html.join('');
    grid.style.gridTemplateColumns = `var(--cb-time-col) repeat(${days.length}, minmax(var(--cb-cell-min), 1fr))`;
    grid.classList.toggle('is-mine', interactive);
    grid.classList.toggle('is-group', !interactive);
    S.cellList = [...grid.querySelectorAll('.cb-cell')];
    S.cells = [];
    S.cellList.forEach((cell) => {
      const r = +cell.dataset.row;
      (S.cells[r] = S.cells[r] || [])[+cell.dataset.col] = cell;
    });
    if (S.cellList[0]) S.cellList[0].tabIndex = 0;
    S.gridSig = gridSignature();
    patchGrid();
  }

  function cellLabel(slot, n, total, isMine, isBooked) {
    const { date, hour } = parseSlot(slot);
    const parts = [`${fmtDate(date)}, ${fmtHour(hour)} to ${fmtHour(hour + 1)}`];
    if (S.tab === 'mine') parts.push(isMine ? 'you are free' : 'you are not marked as free');
    parts.push(total ? `${n} of ${total} people free` : 'nobody has joined yet');
    if (isBooked) parts.push('part of the booked session');
    return parts.join(', ');
  }

  function patchGrid() {
    const ps = people();
    const total = ps.length;
    const mine = mySlots();
    const booked = bookedSlots();
    S.avail = availabilityMap(ps);
    S.cellList.forEach((cell) => {
      const slot = cell.dataset.slot;
      const free = S.avail.get(slot) || [];
      const n = free.length;
      const isMine = mine.has(slot);
      const level = !n ? 0 : n === total ? 5 : Math.max(1, Math.min(4, Math.ceil((n / total) * 4)));
      cell.dataset.level = level;
      cell.classList.toggle('is-on', isMine);
      cell.classList.toggle('is-booked', booked.has(slot));
      if (S.tab === 'mine') {
        const others = n - (isMine ? 1 : 0);
        if (others > 0) cell.dataset.others = others;
        else delete cell.dataset.others;
        cell.textContent = '';
        cell.setAttribute('aria-pressed', String(isMine));
      } else {
        delete cell.dataset.others;
        cell.textContent = n ? String(n) : '';
        cell.removeAttribute('aria-pressed');
      }
      cell.setAttribute('aria-label', cellLabel(slot, n, total, isMine, booked.has(slot)));
    });
    $('clear-mine').hidden = !(S.tab === 'mine' && isJoined() && mine.size);
  }

  function renderTabs() {
    $('tab-mine').setAttribute('aria-selected', String(S.tab === 'mine'));
    $('tab-group').setAttribute('aria-selected', String(S.tab === 'group'));
    const coarse = matchMedia('(pointer: coarse)').matches;
    $('grid-hint').textContent = S.tab === 'group'
      ? `Brighter means more people are free. ${coarse ? 'Tap' : 'Point at'} an hour to see who.`
      : !isJoined()
        ? 'Add your name above, then mark the hours you can do.'
        : coarse
          ? 'Tap the hours you can do. Tap a day or a time to fill the whole row.'
          : 'Click or drag across the hours you can do. Click a day or a time to fill the whole row.';
  }

  function renderLegend() {
    $('grid-legend').innerHTML = S.tab === 'mine'
      ? '<span class="cb-key is-on"></span>You are free <span class="cb-key is-others"></span>Others are free <span class="cb-key is-booked"></span>Booked'
      : '<span class="cb-key" data-level="0"></span>Nobody <span class="cb-key" data-level="2"></span><span class="cb-key" data-level="4"></span>Some <span class="cb-key" data-level="5"></span>Everyone <span class="cb-key is-booked"></span>Booked';
  }

  function previewDrag() {
    S.cellList.forEach((c) => c.classList.remove('is-preview-add', 'is-preview-remove'));
    if (!S.drag) return;
    const cls = S.drag.add ? 'is-preview-add' : 'is-preview-remove';
    rectCells(S.drag.anchor, S.drag.current).forEach((c) => c.classList.add(cls));
  }

  function rectCells(a, z) {
    const c1 = Math.min(+a.dataset.col, +z.dataset.col);
    const c2 = Math.max(+a.dataset.col, +z.dataset.col);
    const r1 = Math.min(+a.dataset.row, +z.dataset.row);
    const r2 = Math.max(+a.dataset.row, +z.dataset.row);
    const out = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(S.cells[r][c]);
    return out;
  }

  function editMySlots(mutate) {
    if (!isJoined()) {
      promptJoin();
      return false;
    }
    if (!S.draft) {
      const e = myEntry();
      S.draft = { name: e.name, role: e.role, slots: boardSlots(e.slots) };
    } else {
      S.draft.slots = boardSlots(S.draft.slots);
    }
    mutate(S.draft.slots);
    S.draftSeq++;
    persistDraft();
    queueSave();
    patchGrid();
    renderBest();
    renderPeople();
    renderMe();
    return true;
  }

  function toggleCells(cells) {
    const mine = mySlots();
    const allOn = cells.every((c) => mine.has(c.dataset.slot));
    editMySlots((set) => cells.forEach((c) => (allOn ? set.delete(c.dataset.slot) : set.add(c.dataset.slot))));
  }

  function focusCell(cell) {
    S.cellList.forEach((c) => { c.tabIndex = -1; });
    cell.tabIndex = 0;
    cell.focus();
  }

  function showCellInfo(cell, sticky) {
    const slot = cell.dataset.slot;
    const { date, hour } = parseSlot(slot);
    const ps = people();
    const free = S.avail.get(slot) || [];
    const missing = ps.filter((p) => !p.slots.has(slot));
    const tz = S.doc.board.timezone;
    $('tt-time').textContent = S.localTimes
      ? `${fmtDate(date)} · ${viewerRange(date, hour, 1)} your time`
      : `${fmtDate(date)} · ${fmtHour(hour)}–${fmtHour(hour + 1)} ${cityOf(tz)} time`;
    $('tt-count').textContent = ps.length ? `${free.length} of ${ps.length} free` : 'Nobody has joined yet';
    $('tt-names').innerHTML =
      (free.length ? `<div><span>Free:</span> ${esc(free.map((p) => p.name).join(', '))}</div>` : '') +
      (missing.length ? `<div class="is-missing"><span>Not free:</span> ${esc(missing.map((p) => p.name).join(', '))}</div>` : '');
    const tt = $('tooltip');
    tt.hidden = false;
    const r = cell.getBoundingClientRect();
    const w = tt.offsetWidth;
    const hgt = tt.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + hgt > window.innerHeight - 8) top = r.top - hgt - 8;
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
    S.ttSticky = !!sticky;
  }
  function hideCellInfo() {
    $('tooltip').hidden = true;
    S.ttSticky = false;
  }

  function bindGrid() {
    const grid = $('grid');
    grid.addEventListener('pointerdown', (ev) => {
      const cell = ev.target.closest('.cb-cell');
      if (!cell) return;
      if (ev.pointerType === 'touch') {
        // Decide on pointerup, so a swipe that scrolls the grid never changes anything.
        S.touch = { cell, x: ev.clientX, y: ev.clientY };
        return;
      }
      if (S.tab === 'group') {
        if (ev.pointerType !== 'mouse') showCellInfo(cell, true);
        return;
      }
      if (ev.button !== 0) return;
      if (!isJoined()) {
        promptJoin();
        return;
      }
      ev.preventDefault();
      S.drag = { anchor: cell, current: cell, add: !mySlots().has(cell.dataset.slot) };
      try { grid.setPointerCapture(ev.pointerId); } catch {}
      previewDrag();
    });
    grid.addEventListener('pointermove', (ev) => {
      if (S.drag) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const cell = el && el.closest ? el.closest('.cb-cell') : null;
        if (cell && cell !== S.drag.current && grid.contains(cell)) {
          S.drag.current = cell;
          previewDrag();
        }
      } else if (S.tab === 'group' && ev.pointerType === 'mouse') {
        const cell = ev.target.closest('.cb-cell');
        if (cell) showCellInfo(cell);
        else hideCellInfo();
      }
    });
    const finish = (ev) => {
      if (S.drag) {
        const cells = rectCells(S.drag.anchor, S.drag.current);
        const add = S.drag.add;
        S.drag = null;
        previewDrag();
        editMySlots((set) => cells.forEach((c) => (add ? set.add(c.dataset.slot) : set.delete(c.dataset.slot))));
      } else if (S.touch) {
        const t = S.touch;
        S.touch = null;
        if (Math.hypot(ev.clientX - t.x, ev.clientY - t.y) >= 12) return;
        if (S.tab === 'group') showCellInfo(t.cell, true);
        else if (!isJoined()) promptJoin();
        else toggleCells([t.cell]);
      }
    };
    grid.addEventListener('pointerup', finish);
    grid.addEventListener('pointercancel', () => {
      S.touch = null;
      if (S.drag) {
        S.drag = null;
        previewDrag();
      }
    });
    grid.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse' && !S.ttSticky) hideCellInfo(); });
    grid.addEventListener('click', (ev) => {
      const head = ev.target.closest('.cb-day, .cb-hour');
      if (!head || S.tab !== 'mine') return;
      if (!isJoined()) return promptJoin();
      const cells = head.classList.contains('cb-day')
        ? S.cellList.filter((c) => c.dataset.col === head.dataset.col)
        : S.cellList.filter((c) => c.dataset.row === head.dataset.row);
      toggleCells(cells);
    });
    grid.addEventListener('keydown', (ev) => {
      const cell = ev.target.closest('.cb-cell');
      if (!cell) return;
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[ev.key]) {
        ev.preventDefault();
        const rows = S.cells.length;
        const cols = S.cells[0].length;
        const r = Math.max(0, Math.min(rows - 1, +cell.dataset.row + moves[ev.key][0]));
        const c = Math.max(0, Math.min(cols - 1, +cell.dataset.col + moves[ev.key][1]));
        focusCell(S.cells[r][c]);
        if (S.tab === 'group') showCellInfo(S.cells[r][c], true);
      } else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        if (S.tab === 'group') showCellInfo(cell, true);
        else if (!isJoined()) promptJoin();
        else toggleCells([cell]);
      } else if (ev.key === 'Escape') {
        hideCellInfo();
      }
    });
    document.addEventListener('pointerdown', (ev) => {
      if (S.ttSticky && !ev.target.closest('.cb-cell')) hideCellInfo();
    });
    $('grid-scroll').addEventListener('scroll', () => { if (!$('tooltip').hidden) hideCellInfo(); }, { passive: true });
  }

  /* ── Sidebar: best times, booking, people ──────── */
  function renderLengthPicker() {
    const b = S.doc.board;
    const max = b.endHour - b.startHour;
    const lens = Array.from({ length: Math.min(8, max) }, (_, i) => i + 1);
    if (!lens.includes(S.length)) S.length = Math.min(b.sessionHours, max);
    const sel = $('len-select');
    const sig = lens.join(',');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = lens.map((n) => `<option value="${n}">${plural(n, 'hour')}</option>`).join('');
      sel.dataset.sig = sig;
    }
    sel.value = String(S.length);
  }

  function roleNote(w) {
    const bits = [];
    if (w.needFac) bits.push(w.fac ? plural(w.fac, 'facilitator') : 'no facilitator');
    if (w.needTea) bits.push(w.tea ? plural(w.tea, 'teacher') : 'no teacher');
    return bits.length ? ` · ${bits.join(', ')}` : '';
  }

  function renderBest() {
    const booked = !!S.doc.booking;
    const note = $('best-note');
    note.hidden = !booked;
    note.textContent = booked ? 'This board is booked. Cancel the booking to choose a different time.' : '';
    $('book-other').hidden = booked;
    const ps = people();
    const list = windows(S.length);
    const el = $('best-list');
    if (!ps.length) {
      el.innerHTML = '<p class="cb-empty-note">Nobody has marked any hours yet. Invite facilitators and teachers, and the best times will appear here.</p>';
      return;
    }
    if (!list.length) {
      el.innerHTML = `<p class="cb-empty-note">No ${plural(S.length, 'hour')} window works for anyone yet. Try a shorter session, or ask people to mark more hours.</p>`;
      return;
    }
    const shown = S.showAllBest ? list.slice(0, 40) : list.slice(0, BEST_SHOWN);
    el.innerHTML = shown.map((w) => `
      <div class="cb-win${w.covers ? '' : ' is-partial'}">
        <div class="cb-win-main">
          <div class="cb-win-when"><strong>${esc(fmtDate(w.date))}</strong> <span>${fmtHour(w.start)}–${fmtHour(w.start + w.length)}</span></div>
          ${diffOn(w.date, w.start) ? `<div class="cb-win-local">${esc(viewerRange(w.date, w.start, w.length))} your time</div>` : ''}
          <div class="cb-win-who">${w.free.length === ps.length ? 'Everyone is free' : `${w.free.length} of ${ps.length} free`}${esc(roleNote(w))}</div>
          ${w.missing.length && w.free.length !== ps.length ? `<div class="cb-win-missing">Not free: ${esc(listNames(w.missing))}</div>` : ''}
        </div>
        ${booked ? '' : `<button type="button" class="cb-book-btn" data-book="${w.date}|${w.start}|${w.length}">Book</button>`}
      </div>`).join('') +
      (list.length > BEST_SHOWN ? `<button type="button" class="cb-ghost-btn is-small" id="best-more">${S.showAllBest ? 'Show fewer' : `Show all ${list.length} options`}</button>` : '');
  }

  function renderPeople() {
    const ps = people().sort((a, z) => (ROLE_ORDER[a.role] - ROLE_ORDER[z.role]) || a.name.localeCompare(z.name));
    $('people-count').textContent = ps.length ? String(ps.length) : '';
    $('people-list').innerHTML = !ps.length
      ? '<p class="cb-empty-note">Nobody yet. Share the link to invite facilitators and teachers.</p>'
      : ps.map((p) => {
        const isMe = S.me && p.id === S.me.pid;
        const canRemove = S.adminKey && !isMe;
        return `<div class="cb-person">
          <span class="cb-avatar" data-role="${p.role}">${esc(initials(p.name))}</span>
          <div class="cb-person-text"><strong>${esc(p.name)}${isMe ? ' <em>(you)</em>' : ''}</strong><span>${ROLE_LABELS[p.role]} · ${plural(p.slots.size, 'hour')}</span></div>
          ${canRemove ? `<button type="button" class="cb-x" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.name)} from this board">×</button>` : ''}
        </div>`;
      }).join('');
  }

  function renderBooking() {
    const card = $('booking-card');
    const bk = S.doc.booking;
    card.hidden = !bk;
    if (!bk) {
      S.ticketKey = null;
      card.innerHTML = '';
      return;
    }
    const b = S.doc.board;
    const w = bookingWindow();
    const canCancel = !!(S.adminKey || S.bookingKey);
    const diff = diffOn(w.date, w.start);
    const key = [bk.ref, bk.slot, bk.hours, bk.name, b.title, b.timezone, canCancel, diff].join('|');
    if (S.ticketKey === key) return;
    S.ticketKey = key;
    card.innerHTML = `
      <div class="tkt">
        <div class="tkt-top"><div class="tkt-brand"><span class="d"></span>Space4Climate</div><div class="tkt-status">Booked</div></div>
        <div class="tkt-event"><div class="tkt-eyebrow">Session booked</div><div class="tkt-title">${esc(b.title)}</div></div>
        <div class="tkt-rows">
          <div class="tkt-row"><span class="tkt-k">Date</span><span class="tkt-v">${esc(fmtDate(w.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span></div>
          <div class="tkt-row"><span class="tkt-k">Time</span><span class="tkt-v">${fmtHour(w.start)}–${fmtHour(w.start + w.length)} ${esc(cityOf(b.timezone))}</span></div>
          ${diff ? `<div class="tkt-row"><span class="tkt-k">Your time</span><span class="tkt-v">${esc(viewerRange(w.date, w.start, w.length))}</span></div>` : ''}
          <div class="tkt-row"><span class="tkt-k">Booked by</span><span class="tkt-v">${esc(bk.name)}</span></div>
          <div class="tkt-row"><span class="tkt-k">Reference</span><span class="tkt-v mono">${esc(bk.ref)}</span></div>
        </div>
        <div class="tkt-perf"></div>
        <div class="tkt-qrwrap">
          <div class="tkt-qr"><img id="booking-qr" alt="QR code linking to this booking"></div>
          <div class="tkt-qrcap">Quote ${esc(bk.ref)} when paying the registration fee</div>
        </div>
      </div>
      <div class="tkt-actions">
        <button class="tkt-btn primary" type="button" data-act="ics">Add to calendar</button>
        <button class="tkt-btn" type="button" data-act="ticket">Save ticket</button>
        <button class="tkt-btn" type="button" data-act="email">Email it</button>
        <button class="tkt-btn ghost" type="button" data-act="copy">Copy reference</button>
        ${canCancel ? '<button class="tkt-btn danger" type="button" data-act="cancel">Cancel booking</button>' : ''}
      </div>`;
    const qr = bookingQr();
    if (qr) $('booking-qr').src = qr.dataUrl;
  }

  /* ── Full render ───────────────────────────────── */
  function showBoardMessage(title, text) {
    $('bv-content').hidden = true;
    const el = $('bv-empty');
    el.hidden = false;
    el.innerHTML = `<h1 class="cb-title">${esc(title)}</h1><p>${esc(text)}</p><a class="s4c-btn" href="commonboard.html" data-home><span>Back to CommonBoard</span><span class="s4c-btn_icon">${ARROW}</span></a>`;
  }

  function renderBoard(forceGrid) {
    if (!S.doc) return;
    $('bv-empty').hidden = true;
    $('bv-content').hidden = false;
    renderHeader();
    renderTzBar();
    renderBanner();
    renderMe();
    renderTabs();
    renderLengthPicker();
    if (forceGrid || gridSignature() !== S.gridSig) buildGrid();
    else patchGrid();
    renderLegend();
    renderBooking();
    renderBest();
    renderPeople();
  }

  /* ── Sync ──────────────────────────────────────── */
  function applyDoc(doc) {
    if (!doc || !doc.board) return false;
    const version = doc.version || 0;
    if (S.doc && version < S.seenVersion) return false;
    S.seenVersion = Math.max(S.seenVersion, version);
    S.doc = { board: doc.board, participants: doc.participants || {}, booking: doc.booking || null, version };
    local.set(K.cache(S.id), S.doc);
    return true;
  }
  const noteVersion = (v) => { S.seenVersion = Math.max(S.seenVersion, Number(v) || 0); };

  function persistDraft() {
    local.set(K.pending(S.id), { name: S.draft.name, role: S.draft.role, slots: [...S.draft.slots] });
  }

  function queueSave(delay = SAVE_DELAY_MS) {
    clearTimeout(S.saveTimer);
    setStatus('saving');
    S.saveTimer = setTimeout(saveMe, delay);
  }

  async function saveMe() {
    if (!S.draft || !S.me || !S.doc) return;
    if (S.saving) {
      S.saveQueued = true;
      return;
    }
    S.saving = true;
    const id = S.id;
    const me = S.me;
    const seq = S.draftSeq;
    const before = S.doc.version;
    const body = { name: S.draft.name, role: S.draft.role, slots: [...boardSlots(S.draft.slots)] };
    const board = S.doc.board;
    // Only clear the stored draft if it is what we just sent; another tab may have queued newer edits.
    const clearPending = () => {
      const p = local.get(K.pending(id));
      if (!p || p.name !== body.name || p.role !== body.role) return;
      const pend = new Set((p.slots || []).filter((x) => slotOnBoard(board, x)));
      if (pend.size === body.slots.length && body.slots.every((x) => pend.has(x))) local.del(K.pending(id));
    };
    try {
      const res = await api('PUT', { id, p: me.pid }, { key: me.key, body });
      if (S.id !== id) {
        clearPending();
        return;
      }
      noteVersion(res.version);
      S.doc.participants[me.pid] = res.participant;
      // If someone else changed the board meanwhile, refetch everything on the next poll.
      S.doc.version = res.version === before + 1 ? res.version : -1;
      if (seq === S.draftSeq) {
        S.draft = null;
        clearPending();
      }
      local.set(K.cache(id), S.doc);
      setStatus('saved');
      broadcast();
      if (S.doc.version === -1) poll(true);
    } catch (e) {
      if (S.id !== id) return;
      if (e.status === 403) {
        S.me = { pid: newPid(), key: randomKey() };
        local.set(K.me(S.id), S.me);
        S.saveQueued = true;
      } else if (e.status === 400 || e.status === 404) {
        toast(e.message, 'err');
        S.draft = null;
        local.del(K.pending(S.id));
        setStatus('live');
        renderBoard();
      } else {
        setStatus(e.offline ? 'offline' : 'error');
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(saveMe, 5000);
      }
    } finally {
      S.saving = false;
      if (S.saveQueued) {
        S.saveQueued = false;
        queueSave(0);
      }
    }
  }

  function schedulePoll(delay = S.pollDelay) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(() => poll(), delay);
  }
  function stopPolling() {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }

  async function poll(force) {
    if (!S.id || !S.doc) return;
    if (!force && (document.hidden || S.drag)) return schedulePoll();
    const id = S.id;
    try {
      const params = { id };
      if (S.doc.version > 0) params.since = S.doc.version;
      const res = await api('GET', params);
      if (id !== S.id) return;
      if (!res.unchanged && applyDoc(res)) renderBoard();
      S.pollDelay = POLL_MS;
      if (!S.saving && !S.draft && S.status !== 'saved') setStatus('live');
    } catch (e) {
      if (id !== S.id) return;
      if (e.status === 404) {
        stopPolling();
        showBoardMessage('Board not found', 'This board no longer exists. Ask the organiser for a new link.');
        return;
      }
      S.pollDelay = Math.min(S.pollDelay * 2, POLL_MAX_MS);
      setStatus(e.offline ? 'offline' : 'error');
    }
    schedulePoll();
  }

  function bindChannel(id) {
    if (S.channel) { try { S.channel.close(); } catch {} }
    S.channel = null;
    if (!('BroadcastChannel' in window)) return;
    S.channel = new BroadcastChannel(`commonboard:${id}`);
    S.channel.onmessage = () => poll(true);
  }
  const broadcast = () => { try { if (S.channel) S.channel.postMessage('changed'); } catch {} };

  async function checkStorage() {
    if (!S.storage) {
      try { S.storage = (await api('GET')).storage; } catch {}
    }
    if (S.doc) renderBanner();
  }

  /* ── Boards: open, join, edit ──────────────────── */
  function rememberBoard(doc) {
    if (!doc) return;
    const list = local.get(K.recent) || [];
    const prev = list.find((r) => r.id === doc.board.id);
    const next = list.filter((r) => r.id !== doc.board.id);
    next.unshift({
      id: doc.board.id,
      title: doc.board.title,
      startDate: doc.board.startDate,
      endDate: doc.board.endDate,
      organiser: !!local.get(K.admin(doc.board.id)) || !!(prev && prev.organiser),
      openedAt: Date.now()
    });
    local.set(K.recent, next.slice(0, 12));
  }

  async function openBoard(id, initialDoc) {
    stopPolling();
    hideCellInfo();
    Object.assign(S, {
      id, doc: null, draft: null, draftSeq: 0, tab: 'mine', length: null, showAllBest: false,
      pollDelay: POLL_MS, gridSig: '', ticketKey: null, joinPrefilled: false, localTimes: false, seenVersion: 0
    });
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('admin')) {
      storeAdminKey(id, hash.get('admin'));
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    S.me = local.get(K.me(id));
    S.adminKey = local.get(K.admin(id));
    S.bookingKey = local.get(K.bookKey(id));
    S.refParam = new URLSearchParams(location.search).get('ref');
    const pending = local.get(K.pending(id));
    if (pending && S.me) S.draft = { name: pending.name, role: pending.role, slots: new Set(pending.slots || []) };

    showView('board');
    window.scrollTo(0, 0);
    setStatus('connecting');
    const cached = local.get(K.cache(id));
    if (initialDoc) applyDoc(initialDoc);
    else if (cached && cached.board) applyDoc(cached);
    if (S.doc) renderBoard(true);
    else showBoardMessage('Opening the board…', 'Just a moment.');

    try {
      if (!initialDoc) {
        const doc = await api('GET', { id });
        if (S.id !== id) return;
        applyDoc(doc);
        renderBoard(true);
      }
      setStatus(S.draft ? 'saving' : 'live');
    } catch (e) {
      if (S.id !== id) return;
      if (e.status === 404) {
        local.del(K.cache(id));
        showBoardMessage('Board not found', 'This link may be mistyped, or the board has expired. Ask the organiser for a fresh link, or launch a new board.');
        return;
      }
      if (!S.doc) {
        showBoardMessage('Can’t open this board right now', e.offline ? 'You seem to be offline. We will open it as soon as the connection is back.' : `${e.message} Trying again…`);
        clearTimeout(S.pollTimer);
        S.pollTimer = setTimeout(() => { if (S.id === id && !S.doc) openBoard(id); }, 5000);
        return;
      }
      setStatus(e.offline ? 'offline' : 'error');
    }
    rememberBoard(S.doc);
    if (S.draft) queueSave(0);
    bindChannel(id);
    schedulePoll();
    checkStorage();
  }

  function storeAdminKey(id, key) {
    const current = local.get(K.admin(id));
    if (current === key) return;
    if (current && !confirm('This device already has organiser access to this board. Replace it with the key from this link?')) return;
    local.set(K.admin(id), key);
    toast('Organiser access is now saved on this device.');
  }

  function promptJoin() {
    const card = $('bv-join');
    card.classList.remove('is-nudge');
    void card.offsetWidth;
    card.classList.add('is-nudge');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('me-name').focus({ preventScroll: true });
    toast('Add your name first, then mark your hours.', 'err');
  }

  function joinBoard(ev) {
    ev.preventDefault();
    const name = $('me-name').value.trim();
    const role = radioValue('me-role');
    if (!name) {
      $('me-name').focus();
      toast('Add your name first.', 'err');
      return;
    }
    local.set(K.profile, { name, role });
    if (!S.me) S.me = local.get(K.me(S.id));
    if (!S.me) {
      S.me = { pid: newPid(), key: randomKey() };
      local.set(K.me(S.id), S.me);
    }
    const existing = myEntry();
    S.draft = { name, role, slots: S.draft ? S.draft.slots : new Set(existing ? existing.slots : []) };
    S.draftSeq++;
    persistDraft();
    queueSave(0);
    S.tab = 'mine';
    renderBoard(true);
    toast(`Welcome, ${name}! Now mark the hours you can do.`);
  }

  function openMeModal() {
    const p = myProfile();
    if (!p) return;
    $('me-edit-name').value = p.name;
    setRadio('me-edit-role', p.role);
    openModal('modal-me');
  }

  function saveMeDetails(ev) {
    ev.preventDefault();
    const name = $('me-edit-name').value.trim();
    if (!name) {
      toast('Your name can’t be empty.', 'err');
      return;
    }
    const role = radioValue('me-edit-role');
    if (!S.draft) {
      const e = myEntry();
      S.draft = { name, role, slots: new Set(e ? e.slots : []) };
    }
    S.draft.name = name;
    S.draft.role = role;
    S.draftSeq++;
    persistDraft();
    local.set(K.profile, { name, role });
    queueSave(0);
    closeModal('modal-me');
    renderBoard();
  }

  async function leaveBoard() {
    if (!confirm('Remove your name and hours from this board?')) return;
    clearTimeout(S.saveTimer);
    S.saveQueued = false;
    S.draft = null;
    local.del(K.pending(S.id));
    for (let i = 0; S.saving && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
    try {
      if (myEntry()) await api('DELETE', { id: S.id, p: S.me.pid }, { key: S.me.key });
      delete S.doc.participants[S.me.pid];
      S.draft = null;
      S.joinPrefilled = false;
      local.del(K.pending(S.id));
      S.doc.version = -1;
      closeModal('modal-me');
      renderBoard(true);
      broadcast();
      poll(true);
      toast('You have been removed from this board.');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function removePerson(pid) {
    const p = S.doc.participants[pid];
    if (!p || !confirm(`Remove ${p.name} and their hours from this board?`)) return;
    try {
      await api('DELETE', { id: S.id, p: pid }, { key: S.adminKey });
      delete S.doc.participants[pid];
      S.doc.version = -1;
      renderBoard();
      broadcast();
      poll(true);
      toast(`${p.name} was removed.`);
    } catch (e) {
      if (e.status === 403) dropAdminKey();
      toast(e.status === 403 ? 'This device no longer has organiser access.' : e.message, 'err');
    }
  }

  function dropAdminKey() {
    local.del(K.admin(S.id));
    S.adminKey = null;
    renderBoard();
  }

  function fillHours(sel, from, to, selected) {
    sel.innerHTML = '';
    for (let h = from; h <= to; h++) sel.add(new Option(fmtHour(h), String(h), false, h === selected));
  }
  function fillLengths(sel, max, selected) {
    sel.innerHTML = '';
    for (let n = 1; n <= Math.min(8, max); n++) sel.add(new Option(plural(n, 'hour'), String(n), false, n === selected));
  }

  function openEdit() {
    const b = S.doc.board;
    $('edit-title').value = b.title;
    $('edit-start').value = b.startDate;
    $('edit-end').value = b.endDate;
    fillHours($('edit-sh'), 0, 23, b.startHour);
    fillHours($('edit-eh'), 1, 24, b.endHour);
    fillLengths($('edit-len'), 8, b.sessionHours);
    $('edit-tz-note').textContent = `Time zone: ${b.timezone}. It stays fixed so everyone’s hours keep their meaning.`;
    $('edit-err').textContent = '';
    openModal('modal-edit');
  }

  function boardProblem(f, existing) {
    if (!f.title) return 'Give the board a name.';
    if (!f.startDate || !f.endDate) return 'Choose the first and last day.';
    if (f.endDate < f.startDate) return 'The last day must be on or after the first day.';
    if ((!existing || f.endDate !== existing.endDate) && f.endDate < dateIn(Date.now(), VIEWER_TZ)) return 'The last day is in the past.';
    if ((isoToUtc(f.endDate) - isoToUtc(f.startDate)) / 86400000 + 1 > MAX_DAYS) return `Keep it to ${MAX_DAYS} days or fewer.`;
    if (f.endHour <= f.startHour) return 'The daily end time must be after the start time.';
    if (f.sessionHours > f.endHour - f.startHour) return 'The session is longer than the daily time window.';
    return '';
  }

  async function saveEdit(ev) {
    ev.preventDefault();
    const fields = {
      title: $('edit-title').value.trim(),
      startDate: $('edit-start').value,
      endDate: $('edit-end').value,
      startHour: Number($('edit-sh').value),
      endHour: Number($('edit-eh').value),
      sessionHours: Number($('edit-len').value)
    };
    const problem = boardProblem(fields, S.doc.board);
    if (problem) {
      $('edit-err').textContent = problem;
      return;
    }
    try {
      const res = await api('PATCH', { id: S.id }, { key: S.adminKey, body: fields });
      S.doc.board = res.board;
      S.doc.version = -1;
      S.length = res.board.sessionHours;
      closeModal('modal-edit');
      renderBoard(true);
      rememberBoard(S.doc);
      broadcast();
      poll(true);
      toast('Board updated.');
    } catch (e) {
      if (e.status === 403) {
        closeModal('modal-edit');
        dropAdminKey();
        toast('This device no longer has organiser access.', 'err');
        return;
      }
      $('edit-err').textContent = e.message;
    }
  }

  /* ── Booking ───────────────────────────────────── */
  function openBook(win) {
    if (S.doc.booking) {
      toast('This board is already booked.', 'err');
      return;
    }
    const b = S.doc.board;
    const days = dateRange(b.startDate, b.endDate);
    const best = windows(S.length)[0];
    const w = win || best || { date: days[0], start: b.startHour, length: Math.min(S.length, b.endHour - b.startHour) };
    $('book-date').innerHTML = days.map((d) => `<option value="${d}">${esc(fmtDate(d))}</option>`).join('');
    $('book-date').value = w.date;
    fillHours($('book-start'), b.startHour, b.endHour - 1, w.start);
    fillLengths($('book-len'), b.endHour - b.startHour, w.length);
    const profile = myProfile() || local.get(K.profile) || {};
    $('book-name').value = profile.name || '';
    updateBookSummary();
    openModal('modal-book');
  }

  function updateBookSummary() {
    const b = S.doc.board;
    const date = $('book-date').value;
    const start = Number($('book-start').value);
    const len = Number($('book-len').value);
    const fits = start + len <= b.endHour;
    const ps = people();
    const hours = Array.from({ length: len }, (_, i) => slotKey(date, start + i));
    const free = ps.filter((p) => hours.every((s) => p.slots.has(s)));
    const missing = ps.filter((p) => !free.includes(p));
    const diff = fits ? diffOn(date, start) : 0;
    const needFac = ps.some((p) => p.role === 'facilitator');
    const needTea = ps.some((p) => p.role === 'teacher');
    const fac = free.filter((p) => p.role === 'facilitator').length;
    const tea = free.filter((p) => p.role === 'teacher').length;
    let warn = '';
    if (fits && needFac && !fac) warn = 'No facilitator has marked this whole time as free.';
    else if (fits && needTea && !tea) warn = 'No teacher has marked this whole time as free.';
    $('book-summary').innerHTML = !fits
      ? `<p class="cb-error">This session would run past ${fmtHour(b.endHour)}. Choose an earlier start or a shorter session.</p>`
      : `<p class="cb-book-when">${esc(fmtLongDate(date))}<br><strong>${fmtHour(start)}–${fmtHour(start + len)}</strong> ${esc(cityOf(b.timezone))} time</p>
         ${diff ? `<p class="cb-book-local">That is ${esc(viewerRange(date, start, len))} your time.</p>` : ''}
         <p class="cb-book-free">${ps.length ? (free.length === ps.length ? 'Everyone is free for the whole session.' : `${free.length} of ${ps.length} people are free for the whole session.`) : 'Nobody has marked their hours yet.'}</p>
         ${missing.length && free.length !== ps.length ? `<p class="cb-book-missing">Not free: ${esc(missing.map((p) => p.name).join(', '))}</p>` : ''}
         ${warn ? `<p class="cb-warn">${esc(warn)}</p>` : ''}`;
    $('book-confirm').disabled = !fits;
  }

  async function confirmBooking(ev) {
    ev.preventDefault();
    const name = $('book-name').value.trim();
    if (!name) {
      $('book-name').focus();
      toast('Add your name to book.', 'err');
      return;
    }
    const slot = slotKey($('book-date').value, Number($('book-start').value));
    const hours = Number($('book-len').value);
    const btn = $('book-confirm');
    // Store the key first: if the response is lost, this device can still cancel its own booking.
    const key = randomKey();
    local.set(K.bookKey(S.id), key);
    btn.disabled = true;
    setButtonLabel(btn, 'Booking…');
    try {
      const res = await api('POST', { id: S.id, action: 'book' }, { key, body: { slot, hours, name } });
      S.bookingKey = key;
      noteVersion(res.version);
      S.doc.booking = res.booking;
      S.doc.version = -1;
      closeModal('modal-book');
      renderBoard();
      broadcast();
      poll(true);
      toast(`Booked! Your reference is ${res.booking.ref}.`);
      $('booking-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (e.status === 409) {
        if (e.data && e.data.booking) S.doc.booking = e.data.booking;
        closeModal('modal-book');
        renderBoard();
        poll(true);
        toast('Someone else booked this board a moment ago.', 'err');
      } else {
        if (!e.offline) local.del(K.bookKey(S.id));
        S.bookingKey = local.get(K.bookKey(S.id));
        toast(e.message, 'err');
      }
    } finally {
      btn.disabled = false;
      setButtonLabel(btn, 'Confirm booking');
    }
  }

  async function cancelBooking() {
    if (!confirm('Cancel this booking? The board becomes free to book again.')) return;
    const keys = [S.bookingKey, S.adminKey].filter(Boolean);
    let lastErr = null;
    for (const key of keys) {
      try {
        await api('DELETE', { id: S.id, action: 'book' }, { key });
        S.doc.booking = null;
        S.bookingKey = null;
        local.del(K.bookKey(S.id));
        S.doc.version = -1;
        renderBoard();
        broadcast();
        poll(true);
        toast('Booking cancelled.');
        return;
      } catch (e) {
        lastErr = e;
        if (e.status !== 403) break;
        if (key === S.bookingKey) {
          local.del(K.bookKey(S.id));
          S.bookingKey = null;
        }
      }
    }
    toast(lastErr && lastErr.status === 403 ? 'Only the person who booked or the organiser can cancel.' : (lastErr ? lastErr.message : 'Could not cancel.'), 'err');
  }

  function boardLink() {
    return `${location.origin}${location.pathname}?b=${encodeURIComponent(S.id)}`;
  }
  function bookingUrl() {
    return `${boardLink()}&ref=${encodeURIComponent(S.doc.booking.ref)}`;
  }

  /* QR code generator (byte mode, ECC level M, versions 1-10). */
  const QR = (() => {
    const EXP = new Array(256), LOG = new Array(256);
    (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } })();
    const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
    const ECC_M = { 1:[10,[[1,16]]], 2:[16,[[1,28]]], 3:[26,[[1,44]]], 4:[18,[[2,32]]], 5:[24,[[2,43]]],
      6:[16,[[4,27]]], 7:[18,[[4,31]]], 8:[22,[[2,38],[2,39]]], 9:[22,[[3,36],[2,37]]], 10:[26,[[4,43],[1,44]]] };
    const TOTAL = { 1:16,2:28,3:44,4:64,5:86,6:108,7:124,8:154,9:182,10:216 };
    const ALIGN = { 1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50] };
    const MASKS = [
      (r,c)=>((r+c)&1)===0, (r,c)=>(r&1)===0, (r,c)=>c%3===0, (r,c)=>(r+c)%3===0,
      (r,c)=>(((r/2|0)+(c/3|0))&1)===0, (r,c)=>((r*c)%2 + (r*c)%3)===0,
      (r,c)=>(((r*c)%2 + (r*c)%3)&1)===0, (r,c)=>((((r+c)%2) + (r*c)%3)&1)===0
    ];
    function genPoly(n){ let g=[1]; for(let i=0;i<n;i++){ const ng=new Array(g.length+1).fill(0); for(let j=0;j<g.length;j++){ ng[j]^=g[j]; ng[j+1]^=gmul(g[j],EXP[i]); } g=ng; } return g; }
    function ecCw(data,n){ const g=genPoly(n), res=data.concat(new Array(n).fill(0)); for(let i=0;i<data.length;i++){ const co=res[i]; if(co) for(let j=0;j<g.length;j++) res[i+j]^=gmul(g[j],co); } return res.slice(data.length); }
    function toBytes(str){ if(typeof TextEncoder!=='undefined') return Array.from(new TextEncoder().encode(str)); const e=unescape(encodeURIComponent(str)),o=[]; for(let i=0;i<e.length;i++)o.push(e.charCodeAt(i)&0xff); return o; }
    function chooseVersion(len){ for(let v=1;v<=10;v++){ const cb=v>=10?16:8; if(4+cb+8*len<=TOTAL[v]*8) return v; } return null; }
    function encodeData(bytes,version){ const cap=TOTAL[version]*8, bits=[]; const push=(val,len)=>{ for(let i=len-1;i>=0;i--) bits.push((val>>i)&1); };
      push(0b0100,4); push(bytes.length,version>=10?16:8); bytes.forEach(b=>push(b,8));
      push(0,Math.min(4,cap-bits.length)); while(bits.length%8) bits.push(0);
      let pad=0xEC; while(bits.length<cap){ push(pad,8); pad=pad===0xEC?0x11:0xEC; }
      const cw=[]; for(let i=0;i<bits.length;i+=8){ let v=0; for(let j=0;j<8;j++) v=(v<<1)|bits[i+j]; cw.push(v); } return cw; }
    function interleave(dataCw,version){ const [ecPer,groups]=ECC_M[version], blocks=[]; let idx=0;
      groups.forEach(([num,per])=>{ for(let b=0;b<num;b++){ const d=dataCw.slice(idx,idx+per); idx+=per; blocks.push({d,e:ecCw(d,ecPer)}); } });
      const out=[], maxD=Math.max(...blocks.map(b=>b.d.length));
      for(let i=0;i<maxD;i++) blocks.forEach(b=>{ if(i<b.d.length) out.push(b.d[i]); });
      for(let i=0;i<ecPer;i++) blocks.forEach(b=>out.push(b.e[i])); return out; }
    function fmtBits(mask){ let data=(0<<3)|mask, rem=data; for(let i=0;i<10;i++) rem=(rem<<1)^((rem>>>9)*0x537); return ((data<<10)|rem)^0x5412; }
    function verBits(version){ let rem=version; for(let i=0;i<12;i++) rem=(rem<<1)^((rem>>>11)*0x1f25); return (version<<12)|rem; }
    function buildBase(version){ const size=17+4*version;
      const m=Array.from({length:size},()=>new Array(size).fill(0)), fn=Array.from({length:size},()=>new Array(size).fill(false));
      const set=(r,c,v)=>{ m[r][c]=v?1:0; fn[r][c]=true; };
      const finder=(r,c)=>{ for(let dr=-1;dr<=7;dr++) for(let dc=-1;dc<=7;dc++){ const rr=r+dr,cc=c+dc; if(rr<0||rr>=size||cc<0||cc>=size) continue;
        const ring=(dr>=0&&dr<=6&&(dc===0||dc===6))||(dc>=0&&dc<=6&&(dr===0||dr===6)), ctr=dr>=2&&dr<=4&&dc>=2&&dc<=4; set(rr,cc,ring||ctr?1:0); } };
      finder(0,0); finder(0,size-7); finder(size-7,0);
      for(let i=8;i<size-8;i++){ if(!fn[6][i]) set(6,i,i%2===0?1:0); if(!fn[i][6]) set(i,6,i%2===0?1:0); }
      const pos=ALIGN[version], first=pos[0], last=pos[pos.length-1];
      pos.forEach(r=>pos.forEach(c=>{ if((r===first&&c===first)||(r===first&&c===last)||(r===last&&c===first)) return;
        for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++) set(r+dr,c+dc,(Math.max(Math.abs(dr),Math.abs(dc))%2===0)?1:0); }));
      set(size-8,8,1);
      for(let i=0;i<=8;i++){ if(!fn[8][i]) fn[8][i]=true; if(!fn[i][8]) fn[i][8]=true; }
      for(let i=0;i<8;i++){ fn[8][size-1-i]=true; fn[size-1-i][8]=true; }
      if(version>=7) for(let i=0;i<6;i++) for(let j=0;j<3;j++){ fn[size-11+j][i]=true; fn[i][size-11+j]=true; }
      return { m, fn, size }; }
    function placeData(base,codewords){ const {m,fn,size}=base, bits=[]; codewords.forEach(cw=>{ for(let i=7;i>=0;i--) bits.push((cw>>i)&1); });
      let bi=0, up=true; for(let col=size-1;col>0;col-=2){ if(col===6) col--;
        for(let i=0;i<size;i++){ const row=up?size-1-i:i; for(let c=0;c<2;c++){ const cc=col-c; if(!fn[row][cc]){ m[row][cc]=bi<bits.length?bits[bi]:0; bi++; } } } up=!up; } }
    function applyMask(m,fn,size,mask){ const out=m.map(r=>r.slice()); for(let r=0;r<size;r++) for(let c=0;c<size;c++) if(!fn[r][c]&&MASKS[mask](r,c)) out[r][c]^=1; return out; }
    function drawFmtVer(m,size,mask,version){ const fb=fmtBits(mask), gb=i=>(fb>>(14-i))&1;
      for(let i=0;i<=5;i++) m[8][i]=gb(i); m[8][7]=gb(6); m[8][8]=gb(7); m[7][8]=gb(8);
      for(let i=9;i<15;i++) m[14-i][8]=gb(i);
      for(let i=0;i<7;i++) m[size-1-i][8]=gb(i); for(let i=7;i<15;i++) m[8][size-15+i]=gb(i); m[size-8][8]=1;
      if(version>=7){ const vb=verBits(version), vg=i=>(vb>>i)&1; for(let i=0;i<18;i++){ const a=size-11+i%3, b=(i/3)|0; m[a][b]=vg(i); m[b][a]=vg(i); } } }
    function penalty(m,size){ let p=0;
      for(let r=0;r<size;r++){ let col=m[r][0],len=1; for(let c=1;c<size;c++){ if(m[r][c]===col)len++; else{ if(len>=5)p+=3+len-5; col=m[r][c];len=1; } } if(len>=5)p+=3+len-5; }
      for(let c=0;c<size;c++){ let col=m[0][c],len=1; for(let r=1;r<size;r++){ if(m[r][c]===col)len++; else{ if(len>=5)p+=3+len-5; col=m[r][c];len=1; } } if(len>=5)p+=3+len-5; }
      for(let r=0;r<size-1;r++) for(let c=0;c<size-1;c++){ const v=m[r][c]; if(v===m[r][c+1]&&v===m[r+1][c]&&v===m[r+1][c+1]) p+=3; }
      const p1=[1,0,1,1,1,0,1,0,0,0,0], p2=[0,0,0,0,1,0,1,1,1,0,1];
      const chk=g=>{ let a=true,b=true; for(let k=0;k<11;k++){ const v=g(k); if(v!==p1[k])a=false; if(v!==p2[k])b=false; } return a||b; };
      for(let r=0;r<size;r++) for(let c=0;c<=size-11;c++) if(chk(k=>m[r][c+k])) p+=40;
      for(let c=0;c<size;c++) for(let r=0;r<=size-11;r++) if(chk(k=>m[r+k][c])) p+=40;
      let dark=0; for(let r=0;r<size;r++) for(let c=0;c<size;c++) if(m[r][c]) dark++;
      p+=Math.floor(Math.abs(dark*100/(size*size)-50)/5)*10; return p; }
    function build(text){ const bytes=toBytes(text), version=chooseVersion(bytes.length);
      if(!version) throw new Error('data too long for QR');
      const codewords=interleave(encodeData(bytes,version),version), base=buildBase(version); placeData(base,codewords);
      let best=null, bestP=Infinity;
      for(let mask=0;mask<8;mask++){ const cand=applyMask(base.m,base.fn,base.size,mask); drawFmtVer(cand,base.size,mask,version); const p=penalty(cand,base.size); if(p<bestP){ bestP=p; best=cand; } }
      return best; }
    function toCanvas(text,{scale=6,margin=4,dark='#0b1020',light='#ffffff'}={}){ const m=build(text), size=m.length, dim=(size+margin*2)*scale;
      const cv=document.createElement('canvas'); cv.width=cv.height=dim; const x=cv.getContext('2d');
      x.fillStyle=light; x.fillRect(0,0,dim,dim); x.fillStyle=dark;
      for(let r=0;r<size;r++) for(let c=0;c<size;c++) if(m[r][c]) x.fillRect((c+margin)*scale,(r+margin)*scale,scale,scale); return cv; }
    return { build, toCanvas, toDataURL:(t,o)=>toCanvas(t,o).toDataURL('image/png') };
  })();

  function bookingQr() {
    const bk = S.doc.booking;
    const payloads = [bookingUrl(), `Space4Climate booking ${bk.ref}`];
    for (const payload of payloads) {
      try { return { dataUrl: QR.toDataURL(payload, { scale: 6, margin: 4 }), payload }; } catch {}
    }
    return null;
  }

  function icsStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function icsText(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsFold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) {
      out.push(rest.slice(0, 74));
      rest = ' ' + rest.slice(74);
    }
    out.push(rest);
    return out.join('\r\n');
  }

  function downloadIcs() {
    const bk = S.doc.booking;
    const b = S.doc.board;
    const w = bookingWindow();
    const start = boardInstant(w.date, w.start, b.timezone);
    const end = boardInstant(w.date, w.start + w.length, b.timezone);
    const url = bookingUrl();
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Space4Climate//CommonBoard//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${bk.ref}-${S.id}@space4climate.org`,
      `DTSTAMP:${icsStamp(Date.now())}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsText(b.title)}`,
      `DESCRIPTION:${icsText(`Space4Climate session booked on CommonBoard.\nReference: ${bk.ref}\nBooked by: ${bk.name}\n${url}`)}`,
      `URL:${url}`,
      'END:VEVENT', 'END:VCALENDAR'
    ];
    const blob = new Blob([lines.map(icsFold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    download(`space4climate-${bk.ref}.ics`, href);
    setTimeout(() => URL.revokeObjectURL(href), 5000);
    toast('Calendar file downloaded. Open it to add the session to your calendar.');
  }

  function emailBooking() {
    const bk = S.doc.booking;
    const b = S.doc.board;
    const w = bookingWindow();
    const lines = [
      `Space4Climate session booked: ${b.title}`, '',
      `Date:       ${fmtLongDate(w.date)}`,
      `Time:       ${fmtHour(w.start)}–${fmtHour(w.start + w.length)} (${b.timezone})`,
      `Booked by:  ${bk.name}`,
      `Reference:  ${bk.ref}`, '',
      'Please quote the reference when paying the registration fee.',
      `Board: ${bookingUrl()}`
    ];
    location.href = `mailto:?subject=${encodeURIComponent(`Space4Climate booking ${bk.ref}`)}&body=${encodeURIComponent(lines.join('\n'))}`;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // A printable ticket (details + QR) as one PNG.
  async function saveTicket() {
    const bk = S.doc.booking;
    const b = S.doc.board;
    const w = bookingWindow();
    const qr = bookingQr();
    const W = 360, SC = 3, P = 22;
    const FONT = 'Inter,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif';
    const MONO = 'ui-monospace,Menlo,Consolas,monospace';
    const rows = [
      ['Date', fmtDate(w.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })],
      ['Time', `${fmtHour(w.start)} - ${fmtHour(w.start + w.length)}`],
      ['Time zone', b.timezone],
      ['Booked by', bk.name],
      ['Reference', bk.ref]
    ];
    const rowsTop = 112, rowH = 32, qw = 150, qpad = 12, qbox = qw + qpad * 2;
    const perfY = rowsTop + rows.length * rowH + 16, qY = perfY + 20, capY = qY + qbox + 22, H = capY + 14;
    const cv = document.createElement('canvas');
    cv.width = W * SC;
    cv.height = H * SC;
    const x = cv.getContext('2d');
    x.scale(SC, SC);
    const rr = (rx, ry, rw, rh, r) => {
      x.beginPath(); x.moveTo(rx + r, ry); x.arcTo(rx + rw, ry, rx + rw, ry + rh, r); x.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      x.arcTo(rx, ry + rh, rx, ry, r); x.arcTo(rx, ry, rx + rw, ry, r); x.closePath();
    };
    const trunc = (t, maxW) => {
      let s = String(t);
      if (x.measureText(s).width <= maxW) return s;
      while (s.length > 1 && x.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      return s + '…';
    };
    x.fillStyle = '#111111'; rr(0.5, 0.5, W - 1, H - 1, 20); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.16)'; x.lineWidth = 1; rr(0.5, 0.5, W - 1, H - 1, 20); x.stroke();
    x.fillStyle = '#ebfd40'; x.beginPath(); x.arc(P + 4, 35, 4, 0, 7); x.fill();
    x.fillStyle = '#f5f5f5'; x.font = `600 14px ${FONT}`; x.fillText('Space4Climate', P + 14, 40);
    x.font = `600 11px ${FONT}`;
    const pill = 'Booked', pw = x.measureText(pill).width + 30, px = W - P - pw;
    x.fillStyle = 'rgba(235,253,64,0.16)'; rr(px, 25, pw, 21, 10.5); x.fill();
    x.fillStyle = '#ebfd40'; x.beginPath(); x.arc(px + 13, 35.5, 3, 0, 7); x.fill(); x.fillText(pill, px + 21, 39);
    x.fillStyle = 'rgba(255,255,255,0.5)'; x.font = `600 10px ${FONT}`; x.fillText('SESSION BOOKED', P, 72);
    x.fillStyle = '#f5f5f5'; x.font = `600 21px ${FONT}`; x.fillText(trunc(b.title, W - 2 * P), P, 97);
    rows.forEach((r, i) => {
      const y = rowsTop + i * rowH;
      if (i > 0) { x.strokeStyle = 'rgba(255,255,255,0.12)'; x.beginPath(); x.moveTo(P, y); x.lineTo(W - P, y); x.stroke(); }
      x.textAlign = 'left'; x.fillStyle = 'rgba(255,255,255,0.55)'; x.font = `13px ${FONT}`; x.fillText(r[0], P, y + 21);
      x.textAlign = 'right'; x.fillStyle = '#f5f5f5'; x.font = r[0] === 'Reference' ? `600 13px ${MONO}` : `500 13px ${FONT}`;
      x.fillText(trunc(r[1], W - 2 * P - 96), W - P, y + 21);
    });
    x.textAlign = 'left';
    x.strokeStyle = 'rgba(255,255,255,0.22)'; x.setLineDash([4, 4]); x.beginPath(); x.moveTo(P, perfY); x.lineTo(W - P, perfY); x.stroke(); x.setLineDash([]);
    const qx = (W - qbox) / 2;
    x.fillStyle = '#ffffff'; rr(qx, qY, qbox, qbox, 14); x.fill();
    if (qr) {
      try { const img = await loadImage(qr.dataUrl); x.imageSmoothingEnabled = false; x.drawImage(img, qx + qpad, qY + qpad, qw, qw); } catch {}
    }
    x.fillStyle = 'rgba(255,255,255,0.5)'; x.font = `11px ${FONT}`; x.textAlign = 'center';
    x.fillText(`Quote ${bk.ref} when paying · space4climate.org`, W / 2, capY);
    download(`space4climate-ticket-${bk.ref}.png`, cv.toDataURL('image/png'));
    toast('Ticket saved.');
  }

  /* ── Sharing ───────────────────────────────────── */
  function openShare() {
    const link = boardLink();
    const text = `Please mark when you’re free for “${S.doc.board.title}” on CommonBoard: ${link}`;
    $('share-link').value = link;
    $('share-whatsapp').href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    $('share-email').href = `mailto:?subject=${encodeURIComponent(`When are you free? ${S.doc.board.title}`)}&body=${encodeURIComponent(text)}`;
    $('share-native').hidden = !navigator.share;
    $('share-admin').hidden = !S.adminKey;
    if (S.adminKey) $('share-admin-link').value = `${link}#admin=${S.adminKey}`;
    openModal('modal-share');
  }

  /* ── Modals ────────────────────────────────────── */
  function openModal(id) {
    const m = $(id);
    S.lastFocus = document.activeElement;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    const first = m.querySelector('input:not([readonly]):not([type="radio"]), select, .s4c-btn');
    if (first) setTimeout(() => first.focus(), 40);
  }
  function closeModal(id) {
    const m = $(id);
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus();
  }

  /* ── Landing ───────────────────────────────────── */
  function renderRecent() {
    const list = local.get(K.recent) || [];
    $('orbit-recent').hidden = !list.length;
    $('recent-list').innerHTML = list.map((r) => `
      <div class="cb-recent-item">
        <a href="?b=${encodeURIComponent(r.id)}" data-open="${esc(r.id)}">
          <strong>${esc(r.title)}</strong>
          <span>${esc(fmtRange(r.startDate, r.endDate))}${r.organiser ? ' · You organise this' : ''}</span>
        </a>
        <button type="button" class="cb-x" data-forget="${esc(r.id)}" aria-label="Remove ${esc(r.title)} from this list">×</button>
      </div>`).join('');
  }

  function setupLanding() {
    const today = dateIn(Date.now(), VIEWER_TZ);
    $('create-start').value = today;
    $('create-start').min = today;
    $('create-end').value = addDays(today, 6);
    $('create-end').min = today;
    fillHours($('create-sh'), 0, 23, 9);
    fillHours($('create-eh'), 1, 24, 17);
    fillLengths($('create-len'), 8, 3);
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch {}
    if (!zones.includes(VIEWER_TZ)) zones.unshift(VIEWER_TZ);
    const now = Date.now();
    $('create-tz').innerHTML = zones
      .map((z) => `<option value="${esc(z)}"${z === VIEWER_TZ ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))} (${fmtOffset(tzOffset(z, now))})</option>`)
      .join('');
    const profile = local.get(K.profile) || {};
    $('create-me-name').value = profile.name || '';
    setRadio('create-role', profile.role || 'other');

    $('create-start').addEventListener('change', () => {
      const start = $('create-start').value;
      $('create-end').min = start;
      if ($('create-end').value < start) $('create-end').value = start;
    });
    $('create-form').addEventListener('submit', createBoard);
    $('join-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const id = idFromInput($('join-input').value);
      if (!id) {
        toast('Paste the full board link, or an ID that starts with ob_.', 'err');
        return;
      }
      navigate(`?b=${encodeURIComponent(id)}`);
    });
    $('recent-list').addEventListener('click', (ev) => {
      const forget = ev.target.closest('[data-forget]');
      if (forget) {
        local.set(K.recent, (local.get(K.recent) || []).filter((r) => r.id !== forget.dataset.forget));
        renderRecent();
        return;
      }
      const open = ev.target.closest('[data-open]');
      if (open) {
        ev.preventDefault();
        navigate(`?b=${encodeURIComponent(open.dataset.open)}`);
      }
    });
  }

  async function createBoard(ev) {
    ev.preventDefault();
    const err = $('create-err');
    const board = {
      title: $('create-name').value.trim(),
      startDate: $('create-start').value,
      endDate: $('create-end').value,
      startHour: Number($('create-sh').value),
      endHour: Number($('create-eh').value),
      sessionHours: Number($('create-len').value),
      timezone: $('create-tz').value
    };
    const problem = boardProblem(board);
    err.textContent = problem;
    if (problem) {
      toast(problem, 'err');
      if (!board.title) $('create-name').focus();
      return;
    }
    const name = $('create-me-name').value.trim();
    const role = radioValue('create-role');
    const btn = $('create-btn');
    btn.disabled = true;
    setButtonLabel(btn, 'Launching…');
    const adminKey = randomKey();
    try {
      const doc = await api('POST', null, { key: adminKey, body: { board } });
      const id = doc.board.id;
      local.set(K.admin(id), adminKey);
      if (name) {
        local.set(K.profile, { name, role });
        local.set(K.me(id), { pid: newPid(), key: randomKey() });
        local.set(K.pending(id), { name, role, slots: [] });
      }
      history.pushState({}, '', `?b=${encodeURIComponent(id)}`);
      await openBoard(id, doc);
      $('create-form').reset();
      setupDefaultsAfterReset();
      openShare();
      toast('Board launched! Share the link to invite people.');
    } catch (e) {
      err.textContent = e.message;
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      setButtonLabel(btn, 'Launch board');
    }
  }

  function setupDefaultsAfterReset() {
    const today = dateIn(Date.now(), VIEWER_TZ);
    $('create-start').value = today;
    $('create-end').value = addDays(today, 6);
    $('create-sh').value = '9';
    $('create-eh').value = '17';
    $('create-len').value = '3';
    $('create-tz').value = VIEWER_TZ;
    const profile = local.get(K.profile) || {};
    $('create-me-name').value = profile.name || '';
    setRadio('create-role', profile.role || 'other');
  }

  function idFromInput(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    try {
      const u = new URL(v, location.origin);
      const b = u.searchParams.get('b');
      if (b) return b;
    } catch {}
    return /^ob_[A-Za-z0-9_-]{6,24}$/.test(v) ? v : '';
  }

  /* ── Views and routing ─────────────────────────── */
  function showView(name) {
    $('view-landing').classList.toggle('active', name === 'landing');
    $('view-board').classList.toggle('active', name === 'board');
    document.body.classList.toggle('orbit-on-board', name === 'board');
    document.body.classList.toggle('orbit-on-landing', name === 'landing');
  }

  function navigate(url) {
    history.pushState({}, '', url);
    route();
  }

  function route() {
    const id = new URLSearchParams(location.search).get('b');
    if (id) {
      if (id !== S.id || !S.doc) openBoard(id);
      return;
    }
    stopPolling();
    hideCellInfo();
    if (S.channel) { try { S.channel.close(); } catch {} S.channel = null; }
    S.id = null;
    S.doc = null;
    document.title = DEFAULT_TITLE;
    showView('landing');
    renderRecent();
    if (location.hash === '#orbit-launch') {
      const el = $('orbit-launch');
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }

  /* ── Wiring ────────────────────────────────────── */
  function bindBoardUi() {
    bindGrid();
    $('me-form').addEventListener('submit', joinBoard);
    $('me-edit').addEventListener('click', openMeModal);
    $('me-edit-form').addEventListener('submit', saveMeDetails);
    $('me-leave').addEventListener('click', leaveBoard);
    $('bv-share-btn').addEventListener('click', openShare);
    $('invite-more').addEventListener('click', openShare);
    $('bv-edit-btn').addEventListener('click', openEdit);
    $('edit-form').addEventListener('submit', saveEdit);
    $('bv-back').addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate(location.pathname);
      window.scrollTo(0, 0);
    });
    $('bv-empty').addEventListener('click', (ev) => {
      if (!ev.target.closest('[data-home]')) return;
      ev.preventDefault();
      navigate(location.pathname);
    });
    $('bv-tz-toggle').addEventListener('click', () => {
      S.localTimes = !S.localTimes;
      renderBoard();
    });
    $('tab-mine').addEventListener('click', () => { S.tab = 'mine'; hideCellInfo(); renderBoard(); });
    $('tab-group').addEventListener('click', () => { S.tab = 'group'; renderBoard(); });
    $('clear-mine').addEventListener('click', () => {
      if (confirm('Clear all the hours you have marked on this board?')) editMySlots((set) => set.clear());
    });
    $('len-select').addEventListener('change', (ev) => {
      S.length = Number(ev.target.value);
      S.showAllBest = false;
      renderBest();
    });
    $('best-list').addEventListener('click', (ev) => {
      const book = ev.target.closest('[data-book]');
      if (book) {
        const [date, start, length] = book.dataset.book.split('|');
        openBook({ date, start: Number(start), length: Number(length) });
      } else if (ev.target.closest('#best-more')) {
        S.showAllBest = !S.showAllBest;
        renderBest();
      }
    });
    $('book-other').addEventListener('click', () => openBook(null));
    ['book-date', 'book-start', 'book-len'].forEach((id) => $(id).addEventListener('change', updateBookSummary));
    $('book-form').addEventListener('submit', confirmBooking);
    $('booking-card').addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]');
      if (!act) return;
      const actions = {
        ics: downloadIcs,
        ticket: saveTicket,
        email: emailBooking,
        copy: async () => toast((await copyText(S.doc.booking.ref)) ? `Copied ${S.doc.booking.ref}` : S.doc.booking.ref),
        cancel: cancelBooking
      };
      actions[act.dataset.act]();
    });
    $('people-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-remove]');
      if (btn) removePerson(btn.dataset.remove);
    });
    $('share-copy').addEventListener('click', async () => {
      const ok = await copyText($('share-link').value);
      toast(ok ? 'Link copied. Paste it into an email or chat.' : 'Select the link and copy it manually.', ok ? 'ok' : 'err');
    });
    $('share-admin-copy').addEventListener('click', async () => {
      const ok = await copyText($('share-admin-link').value);
      toast(ok ? 'Organiser link copied. Keep it private.' : 'Select the link and copy it manually.', ok ? 'ok' : 'err');
    });
    $('share-native').addEventListener('click', async () => {
      try {
        await navigator.share({ title: S.doc.board.title, text: `Please mark when you’re free for “${S.doc.board.title}”.`, url: boardLink() });
      } catch {}
    });
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay || ev.target.closest('[data-close]')) closeModal(overlay.id);
      });
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      document.querySelectorAll('.modal-overlay.open').forEach((m) => closeModal(m.id));
      hideCellInfo();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.id && S.doc) poll(true); });
    window.addEventListener('online', () => {
      if (S.id && !S.doc) return openBoard(S.id);
      if (!S.id || !S.doc) return;
      poll(true);
      if (S.draft) queueSave(0);
    });
    window.addEventListener('popstate', route);
    window.addEventListener('hashchange', () => {
      const key = new URLSearchParams(location.hash.slice(1)).get('admin');
      if (!key || !S.id || !S.doc) return;
      storeAdminKey(S.id, key);
      S.adminKey = local.get(K.admin(S.id));
      history.replaceState(history.state, '', location.pathname + location.search);
      rememberBoard(S.doc);
      renderBoard();
    });
    window.addEventListener('storage', (ev) => {
      if (!S.id || !S.doc) return;
      if (ev.key === K.admin(S.id)) {
        S.adminKey = local.get(K.admin(S.id));
        renderBoard();
      } else if (ev.key === K.me(S.id)) {
        S.me = local.get(K.me(S.id));
        renderBoard();
      }
    });
  }

  document.querySelectorAll('.s4c-btn_icon:empty').forEach((el) => { el.innerHTML = ARROW; });
  setupLanding();
  bindBoardUi();
  route();
})();
