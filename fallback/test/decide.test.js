const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../lib/decide');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const GCAL_URL = 'https://automate.strongtownschicago.org/webhook/eventbrite-gcal-fd60ecbd7c0e';
const IG_URL = 'https://automate.strongtownschicago.org/webhook/eventbrite-ig-45a751157392';

const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

function ev(id, over = {}) {
  return {
    id,
    status: 'live',
    changed: minsAgo(120),
    published: minsAgo(120),
    created: minsAgo(130),
    is_series: false,
    is_series_parent: false,
    series_id: null,
    name: { text: 'Event ' + id },
    ...over,
  };
}

const inSync = (over = {}) => ({ statusCode: 200, body: { status: 'confirmed', updated: minsAgo(60), ...over } });
const notFound = () => ({ statusCode: 404, body: { error: { code: 404 } } });

let rowId = 100;
const row = (card_key, outcome, createdAt = minsAgo(90)) => ({
  id: rowId++, card_key, event_id: card_key, source: 'webhook', outcome, slack_ts: '', execution_id: '', createdAt,
});
const MARKER = () => row('__seeded__', 'carded');
const emptyState = () => ({ gcalStreak: {}, alerted: {} });

const fires = (out, target) => out.actions.filter((a) => a.kind === 'fire' && a.target === target);
const slacks = (out) => out.actions.filter((a) => a.kind === 'slack');

test('seeds when no marker (stray claimed rows present)', () => {
  const events = [ev('1'), ev('2'), ev('3')];
  const rows = [row('1', 'claimed', minsAgo(60)), row('2', 'claimed', minsAgo(5))];
  const out = decide({ events, gcal: events.map(() => inSync()), rows, nowMs: NOW, state: emptyState() });
  assert.equal(out.seed, true);
  const seedRows = out.actions.filter((a) => a.kind === 'seed_row');
  assert.equal(seedRows.length, 4);
  assert.deepEqual(seedRows.slice(0, 3), [
    { kind: 'seed_row', card_key: '1', event_id: '1', source: 'seed', outcome: 'carded' },
    { kind: 'seed_row', card_key: '2', event_id: '2', source: 'seed', outcome: 'carded' },
    { kind: 'seed_row', card_key: '3', event_id: '3', source: 'seed', outcome: 'carded' },
  ]);
  assert.deepEqual(seedRows[3], { kind: 'seed_row', card_key: '__seeded__', event_id: '', source: 'seed', outcome: 'carded' });
  const notes = slacks(out);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Event 1/);
  assert.match(notes[0].text, /Event 3/);
  assert.equal(fires(out, 'ig').length, 0);
});

test('seed mode still runs gcal checks but raises no ig stuck alert', () => {
  const events = [ev('1', { published: minsAgo(300) })];
  const out = decide({ events, gcal: [notFound()], rows: [{}], nowMs: NOW, state: emptyState() });
  assert.equal(out.seed, true);
  assert.equal(fires(out, 'gcal').length, 1);
  assert.equal(fires(out, 'ig').length, 0);
  assert.equal(slacks(out).length, 1); // the seed note only
  assert.equal(out.state.alerted['ig:1'], undefined);
});

test('no fires when in sync', () => {
  const events = [ev('1'), ev('2')];
  const rows = [MARKER(), row('1', 'carded'), row('2', 'carded')];
  const out = decide({ events, gcal: [inSync(), inSync()], rows, nowMs: NOW, state: emptyState() });
  assert.equal(out.seed, false);
  assert.deepEqual(out.actions, []);
});

test('gcal 404 fires', () => {
  const out = decide({ events: [ev('7')], gcal: [notFound()], rows: [MARKER(), row('7', 'carded')], nowMs: NOW, state: emptyState() });
  assert.deepEqual(fires(out, 'gcal'), [{
    kind: 'fire', target: 'gcal', event_id: '7', url: GCAL_URL,
    body: { api_url: 'https://www.eventbriteapi.com/v3/events/7/', config: { action: 'event.published' }, source: 'poller' },
  }]);
  assert.equal(fires(out, 'ig').length, 0);
});

test('gcal cancelled fires', () => {
  const out = decide({ events: [ev('7')], gcal: [inSync({ status: 'cancelled' })], rows: [MARKER(), row('7', 'carded')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'gcal').length, 1);
});

test('gcal stale updated fires', () => {
  const events = [ev('7', { changed: minsAgo(10) })];
  const out = decide({ events, gcal: [inSync({ updated: minsAgo(20) })], rows: [MARKER(), row('7', 'carded')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'gcal').length, 1);
  assert.equal(out.state.gcalStreak['7'], 1);
});

test('gcal non-200/404 counts as unknown, no fire, streak increments', () => {
  for (const code of [401, 500, 503]) {
    const out = decide({
      events: [ev('7')], gcal: [{ statusCode: code, body: { error: {} } }],
      rows: [MARKER(), row('7', 'carded')], nowMs: NOW, state: { gcalStreak: { 7: 1 }, alerted: {} },
    });
    assert.equal(fires(out, 'gcal').length, 0, 'code ' + code);
    assert.equal(out.state.gcalStreak['7'], 2, 'code ' + code);
  }
});

test('gcal alert exactly once at 3rd consecutive run, cleared after resync', () => {
  const events = [ev('7')];
  const rows = [MARKER(), row('7', 'carded')];
  let state = emptyState();
  const alertsPerRun = [];
  for (let i = 0; i < 5; i++) {
    const out = decide({ events, gcal: [notFound()], rows, nowMs: NOW, state });
    alertsPerRun.push(slacks(out).length);
    if (i === 2) assert.match(slacks(out)[0].text, /Event 7/);
    state = out.state;
  }
  assert.deepEqual(alertsPerRun, [0, 0, 1, 0, 0]);
  assert.equal(state.alerted['gcal:7'], true);

  // resync clears the streak and the alert key
  let out = decide({ events, gcal: [inSync()], rows, nowMs: NOW, state });
  assert.equal(slacks(out).length, 0);
  assert.equal(out.state.gcalStreak['7'] || 0, 0);
  assert.equal(out.state.alerted['gcal:7'], undefined);

  // a later outage alerts again on its own 3rd run
  state = out.state;
  const again = [];
  for (let i = 0; i < 3; i++) {
    out = decide({ events, gcal: [{ statusCode: 401, body: {} }], rows, nowMs: NOW, state });
    again.push(slacks(out).length);
    state = out.state;
  }
  assert.deepEqual(again, [0, 0, 1]);
});

test('decide does not mutate the input state', () => {
  const state = { gcalStreak: { 7: 2 }, alerted: {} };
  decide({ events: [ev('7')], gcal: [notFound()], rows: [MARKER(), row('7', 'carded')], nowMs: NOW, state });
  assert.deepEqual(state, { gcalStreak: { 7: 2 }, alerted: {} });
});

test('skips series parent for gcal', () => {
  const parent = ev('50', { is_series: true, is_series_parent: true });
  const out = decide({ events: [parent], gcal: [notFound()], rows: [MARKER(), row('50', 'carded')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'gcal').length, 0);
  assert.equal(out.state.gcalStreak['50'], undefined);
});

test('ig fires after 10 min grace, not before', () => {
  const rows = [MARKER()];
  const young = decide({ events: [ev('8', { published: minsAgo(9) })], gcal: [inSync()], rows, nowMs: NOW, state: emptyState() });
  assert.equal(fires(young, 'ig').length, 0);
  const old = decide({ events: [ev('8', { published: minsAgo(11) })], gcal: [inSync()], rows, nowMs: NOW, state: emptyState() });
  assert.deepEqual(fires(old, 'ig'), [{
    kind: 'fire', target: 'ig', event_id: '8', url: IG_URL,
    body: { api_url: 'https://www.eventbriteapi.com/v3/events/8/', config: { action: 'event.published' }, source: 'poller' },
  }]);
});

test('ig not fired when carded row exists', () => {
  const out = decide({ events: [ev('8')], gcal: [inSync()], rows: [MARKER(), row('8', 'carded')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'ig').length, 0);
});

test('ig: duplicate row does not count as carded', () => {
  const out = decide({ events: [ev('8')], gcal: [inSync()], rows: [MARKER(), row('8', 'duplicate')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'ig').length, 1);
});

test('ig not fired when fresh claim in flight, fired when claim stale', () => {
  const fresh = decide({ events: [ev('8')], gcal: [inSync()], rows: [MARKER(), row('8', 'claimed', minsAgo(29))], nowMs: NOW, state: emptyState() });
  assert.equal(fires(fresh, 'ig').length, 0);
  const stale = decide({ events: [ev('8')], gcal: [inSync()], rows: [MARKER(), row('8', 'claimed', minsAgo(31))], nowMs: NOW, state: emptyState() });
  assert.equal(fires(stale, 'ig').length, 1);
});

test('ig fires once per series card_key', () => {
  const events = [
    ev('51', { is_series: true, series_id: '50' }),
    ev('52', { is_series: true, series_id: '50' }),
    ev('53', { is_series: true, series_id: '50' }),
  ];
  const out = decide({ events, gcal: events.map(() => inSync()), rows: [MARKER()], nowMs: NOW, state: emptyState() });
  const ig = fires(out, 'ig');
  assert.equal(ig.length, 1);
  assert.equal(ig[0].event_id, '51');
});

test('ig fire for a series child is suppressed by a carded row for the parent key', () => {
  const events = [ev('51', { is_series: true, series_id: '50' })];
  const out = decide({ events, gcal: [inSync()], rows: [MARKER(), row('50', 'carded')], nowMs: NOW, state: emptyState() });
  assert.equal(fires(out, 'ig').length, 0);
});

test('uses created when published missing', () => {
  const young = decide({ events: [ev('9', { published: undefined, created: minsAgo(5) })], gcal: [inSync()], rows: [MARKER()], nowMs: NOW, state: emptyState() });
  assert.equal(fires(young, 'ig').length, 0);
  const old = decide({ events: [ev('9', { published: null, created: minsAgo(15) })], gcal: [inSync()], rows: [MARKER()], nowMs: NOW, state: emptyState() });
  assert.equal(fires(old, 'ig').length, 1);
  const neither = decide({ events: [ev('9', { published: undefined, created: undefined })], gcal: [inSync()], rows: [MARKER()], nowMs: NOW, state: emptyState() });
  assert.equal(fires(neither, 'ig').length, 1, 'no timestamps at all is treated as old');
});

test('ig stuck alert once after 60 min', () => {
  const rows = [MARKER()];
  const before = decide({ events: [ev('8', { published: minsAgo(59) })], gcal: [inSync()], rows, nowMs: NOW, state: emptyState() });
  assert.equal(slacks(before).length, 0);

  const events = [ev('8', { published: minsAgo(61) })];
  const first = decide({ events, gcal: [inSync()], rows, nowMs: NOW, state: emptyState() });
  assert.equal(slacks(first).length, 1);
  assert.match(slacks(first)[0].text, /Event 8/);
  assert.equal(first.state.alerted['ig:8'], true);

  const second = decide({ events, gcal: [inSync()], rows, nowMs: NOW, state: first.state });
  assert.equal(slacks(second).length, 0);

  // once carded, the alert key is cleared
  const carded = decide({ events, gcal: [inSync()], rows: [MARKER(), row('8', 'carded')], nowMs: NOW, state: second.state });
  assert.equal(slacks(carded).length, 0);
  assert.equal(carded.state.alerted['ig:8'], undefined);
});

test('ignores rows without id', () => {
  // n8n alwaysOutputData emits one empty {} item when the table is empty
  const out = decide({ events: [ev('1')], gcal: [inSync()], rows: [{}], nowMs: NOW, state: emptyState() });
  assert.equal(out.seed, true);
  // a marker or carded row lacking an id is not trusted either
  const ghost = decide({
    events: [ev('1')], gcal: [inSync()],
    rows: [MARKER(), { card_key: '1', outcome: 'carded' }], nowMs: NOW, state: emptyState(),
  });
  assert.equal(fires(ghost, 'ig').length, 1);
});

test('missing state and gcal entry are tolerated', () => {
  const out = decide({ events: [ev('1')], gcal: [], rows: [MARKER(), row('1', 'carded')], nowMs: NOW });
  assert.equal(fires(out, 'gcal').length, 0);
  assert.equal(out.state.gcalStreak['1'], 1);
});

test('state for events no longer live is pruned', () => {
  const state = { gcalStreak: { 99: 4 }, alerted: { 'gcal:99': true, 'ig:99': true } };
  const out = decide({ events: [ev('1')], gcal: [inSync()], rows: [MARKER(), row('1', 'carded')], nowMs: NOW, state });
  assert.deepEqual(out.state, { gcalStreak: {}, alerted: {} });
});

test('action order: seed rows, IG fires, GCal fires, slack (a failing GCal fire cannot block IG rescues)', () => {
  const events = [ev('1'), ev('2')];
  const out = decide({ events, gcal: [notFound(), notFound()], rows: [MARKER()], nowMs: NOW, state: emptyState() });
  const order = out.actions.map((a) => a.kind + (a.target ? ':' + a.target : ''));
  assert.deepEqual(order, ['fire:ig', 'fire:ig', 'fire:gcal', 'fire:gcal', 'slack', 'slack']);

  const seeded = decide({ events, gcal: [notFound(), inSync()], rows: [], nowMs: NOW, state: emptyState() });
  assert.deepEqual(seeded.actions.map((a) => a.kind + (a.target ? ':' + a.target : '')),
    ['seed_row', 'seed_row', 'seed_row', 'fire:gcal', 'slack']);
});
