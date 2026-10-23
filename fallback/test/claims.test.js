const test = require('node:test');
const assert = require('node:assert/strict');
const { cardKey, amIFirst, findExistingCard } = require('../lib/claims');

test('cardKey uses the event id for a plain event', () => {
  assert.equal(cardKey({ id: 5 }), '5');
});

test('cardKey uses series_id for a series child', () => {
  assert.equal(cardKey({ id: 7, series_id: '5' }), '5');
});

test('cardKey uses own id for a series parent', () => {
  assert.equal(cardKey({ id: 5, is_series_parent: true, series_id: null }), '5');
});

const NOW = Date.parse('2026-10-16T12:00:00Z');
const STALE = 1800000;
const claimed = (id, createdAt) => ({ id, card_key: '5', outcome: 'claimed', createdAt });

test('amIFirst true for a lone own claimed row', () => {
  assert.equal(amIFirst([claimed(9, '2026-10-16T11:59:00.000Z')], 9, NOW, STALE), true);
});

test('amIFirst: lower id wins against a fresh claim', () => {
  const rows = [claimed(5, '2026-10-16T11:59:00.000Z'), claimed(6, '2026-10-16T11:59:30.000Z')];
  assert.equal(amIFirst(rows, 6, NOW, STALE), false);
  assert.equal(amIFirst(rows, 5, NOW, STALE), true);
});

test('amIFirst: a stale earlier claim does not block', () => {
  const rows = [claimed(5, '2026-10-16T11:29:00.000Z'), claimed(6, '2026-10-16T11:59:30.000Z')];
  assert.equal(amIFirst(rows, 6, NOW, STALE), true);
});

test('amIFirst false when any row is carded', () => {
  const rows = [
    { id: 4, card_key: '5', outcome: 'carded', createdAt: '2026-10-16T10:00:00.000Z' },
    claimed(6, '2026-10-16T11:59:30.000Z'),
  ];
  assert.equal(amIFirst(rows, 6, NOW, STALE), false);
});

test('amIFirst ignores rows without id', () => {
  const rows = [{}, claimed(6, '2026-10-16T11:59:30.000Z')];
  assert.equal(amIFirst(rows, 6, NOW, STALE), true);
});

test('amIFirst: duplicate rows do not block', () => {
  const rows = [
    { id: 5, card_key: '5', outcome: 'duplicate', createdAt: '2026-10-16T11:59:00.000Z' },
    claimed(6, '2026-10-16T11:59:30.000Z'),
  ];
  assert.equal(amIFirst(rows, 6, NOW, STALE), true);
});

const cardMsg = (ts, value) => ({
  ts,
  text: 'card',
  blocks: [
    { type: 'header' },
    {
      type: 'actions',
      block_id: 'approval_actions',
      elements: [
        { type: 'button', action_id: 'approve', value },
        { type: 'button', action_id: 'approve_no_ig', value },
        { type: 'button', action_id: 'edit', value },
      ],
    },
  ],
});

test('findExistingCard returns ts of the matching card', () => {
  const msgs = [cardMsg('1.1', '999'), cardMsg('1792485154.452369', '2003522858804')];
  assert.equal(findExistingCard(msgs, '2003522858804'), '1792485154.452369');
});

test('findExistingCard returns null when nothing matches', () => {
  assert.equal(findExistingCard([cardMsg('1.1', '999')], '2003522858804'), null);
});

test('findExistingCard skips messages without blocks', () => {
  assert.equal(findExistingCard([{ ts: '1' }, { ts: '2', blocks: [{ type: 'section' }] }], '5'), null);
});
