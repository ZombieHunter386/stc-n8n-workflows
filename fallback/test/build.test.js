const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../build');

const RUN_PATH = 'stc-poller-run-0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const node = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, 'missing node ' + name);
  return n;
};

// Compile a Code node's jsCode the way n8n runs it: a function body with the n8n globals in scope.
const compile = (jsCode) => new Function('$', '$input', '$getWorkflowStaticData', '$execution', '$node', jsCode);

function checkConnections(wf) {
  const names = new Set(wf.nodes.map((n) => n.name));
  assert.equal(names.size, wf.nodes.length, 'node names must be unique');
  for (const [src, byType] of Object.entries(wf.connections)) {
    assert.ok(names.has(src), 'connection source ' + src + ' is not a node');
    for (const outputs of Object.values(byType)) {
      for (const targets of outputs) {
        for (const t of targets) assert.ok(names.has(t.node), 'connection target ' + t.node + ' is not a node');
      }
    }
  }
}

function checkShape(wf, id, name) {
  assert.equal(wf.id, id);
  assert.equal(wf.id.length, 16);
  assert.equal(wf.name, name);
  assert.equal(wf.active, false);
  assert.equal(wf.settings.executionOrder, 'v1');
  for (const n of wf.nodes) {
    assert.match(n.id, UUID, n.name + ' id');
    assert.ok(Array.isArray(n.position) && n.position.length === 2, n.name + ' position');
    if (n.type === 'n8n-nodes-base.webhook') assert.match(n.webhookId, UUID, n.name + ' webhookId');
  }
}

test('main writes both workflows as parseable JSON and persists the run path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-build-'));
  build.main(dir);
  const poller = JSON.parse(fs.readFileSync(path.join(dir, 'poller.json'), 'utf8'));
  const alert = JSON.parse(fs.readFileSync(path.join(dir, 'error-alert.json'), 'utf8'));
  assert.equal(poller.id, 'stcEbPoller00001');
  assert.equal(alert.id, 'stcErrAlert00001');

  const runPath = fs.readFileSync(path.join(dir, 'poller-run-path.txt'), 'utf8').trim();
  assert.match(runPath, /^stc-poller-run-[0-9a-f]{16}$/);
  assert.equal(node(poller, 'Run Now').parameters.path, runPath);

  // A rebuild reuses the persisted path, so the Run Now URL never changes.
  build.main(dir);
  const again = JSON.parse(fs.readFileSync(path.join(dir, 'poller.json'), 'utf8'));
  assert.equal(node(again, 'Run Now').parameters.path, runPath);
});

test('error alert workflow shape and wiring', () => {
  const wf = build.buildErrorAlert();
  checkShape(wf, 'stcErrAlert00001', 'STC Error Alert');
  checkConnections(wf);
  assert.equal(node(wf, 'Error Trigger').type, 'n8n-nodes-base.errorTrigger');
  assert.deepEqual(wf.connections['Error Trigger'].main[0].map((t) => t.node), ['Format']);
  assert.deepEqual(wf.connections['Format'].main[0].map((t) => t.node), ['Post Alert']);
  const post = node(wf, 'Post Alert');
  assert.equal(post.parameters.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(post.credentials.slackApi.id, 'WVijCeuzSgb5H1s5');
});

test('error alert Format builds the alert text, tolerating missing fields', () => {
  const fn = compile(node(build.buildErrorAlert(), 'Format').parameters.jsCode);
  const full = {
    workflow: { name: 'STC Eventbrite Poller (fallback)' },
    execution: { lastNodeExecuted: 'List Live Events', error: { message: 'boom' }, url: 'https://x/execution/9' },
  };
  const out = fn(null, { first: () => ({ json: full }), all: () => [{ json: full }] }, null);
  assert.equal(out[0].json.text,
    ':rotating_light: n8n workflow *STC Eventbrite Poller (fallback)* failed at node *List Live Events*: boom\nhttps://x/execution/9');

  const empty = fn(null, { first: () => ({ json: {} }), all: () => [{ json: {} }] }, null);
  assert.equal(typeof empty[0].json.text, 'string');
  assert.ok(empty[0].json.text.startsWith(':rotating_light: n8n workflow *'));
  assert.ok(!empty[0].json.text.includes('undefined'));
});

test('poller workflow shape, settings and wiring', () => {
  const wf = build.buildPoller({ runPath: RUN_PATH });
  checkShape(wf, 'stcEbPoller00001', 'STC Eventbrite Poller (fallback)');
  checkConnections(wf);
  assert.equal(wf.settings.errorWorkflow, 'stcErrAlert00001');

  const next = (name, out = 0) => wf.connections[name].main[out].map((t) => t.node);
  assert.deepEqual(next('Every 15 min'), ['Ensure Table']);
  assert.deepEqual(next('Run Now'), ['Ensure Table']);
  assert.deepEqual(next('Ensure Table'), ['List Live Events']);
  assert.deepEqual(next('List Live Events'), ['Events']);
  assert.deepEqual(next('Events'), ['GCal Get']);
  assert.deepEqual(next('GCal Get'), ['Read Card Table']);
  assert.deepEqual(next('Read Card Table'), ['Decide']);
  assert.deepEqual(next('Decide'), ['Route']);
  assert.deepEqual(next('Route', 0), ['Fire Webhook']);
  assert.deepEqual(next('Route', 1), ['Insert Seed Row']);
  assert.deepEqual(next('Route', 2), ['Post Slack Note']);

  const run = node(wf, 'Run Now');
  assert.equal(run.parameters.path, RUN_PATH);
  assert.equal(run.parameters.httpMethod, 'POST');
});

test('Route switches on kind with outputs fire, seed_row, slack in order', () => {
  const rules = node(build.buildPoller({ runPath: RUN_PATH }), 'Route').parameters.rules.values;
  assert.deepEqual(rules.map((r) => r.outputKey), ['fire', 'seed_row', 'slack']);
  rules.forEach((r) => {
    const c = r.conditions.conditions[0];
    assert.equal(c.leftValue, '={{ $json.kind }}');
    assert.equal(c.rightValue, r.outputKey);
  });
});

test('table and Eventbrite reads hard-fail (no error masking)', () => {
  const wf = build.buildPoller({ runPath: RUN_PATH });
  for (const name of ['List Live Events', 'Read Card Table', 'Ensure Table']) {
    const n = node(wf, name);
    assert.equal(n.continueOnFail, undefined, name + ' continueOnFail');
    assert.equal(n.onError, undefined, name + ' onError');
    assert.ok(!JSON.stringify(n.parameters).includes('neverError'), name + ' neverError');
  }
  assert.equal(node(wf, 'Read Card Table').alwaysOutputData, true);
});

test('poller node parameters', () => {
  const wf = build.buildPoller({ runPath: RUN_PATH });
  const list = node(wf, 'List Live Events');
  assert.equal(list.parameters.url, 'https://www.eventbriteapi.com/v3/organizations/2224611974573/events/?status=live');
  assert.equal(list.executeOnce, true);
  assert.equal(list.credentials.httpHeaderAuth.id, 'zClNC6mtULsSIeLj');
  const pg = list.parameters.options.pagination.pagination;
  assert.equal(pg.parameters.parameters[0].name, 'continuation');
  assert.equal(pg.completeExpression, '={{ !$response.body.pagination.has_more_items }}');

  const ensure = node(wf, 'Ensure Table');
  assert.equal(ensure.parameters.resource, 'table');
  assert.equal(ensure.parameters.operation, 'create');
  assert.equal(ensure.parameters.tableName, 'stc_event_cards');
  assert.deepEqual(ensure.parameters.columns.column.map((c) => c.name),
    ['card_key', 'event_id', 'source', 'outcome', 'slack_ts', 'execution_id']);
  assert.ok(ensure.parameters.columns.column.every((c) => c.type === 'string'));
  assert.equal(ensure.parameters.options.createIfNotExists, true);
  assert.equal(ensure.executeOnce, true);

  const gcal = node(wf, 'GCal Get');
  assert.ok(gcal.parameters.url.includes('/calendars/strongtownschicago%40gmail.com/events/eventbrite{{'));
  assert.deepEqual(gcal.parameters.options.response.response, { fullResponse: true, neverError: true });

  const read = node(wf, 'Read Card Table');
  assert.equal(read.parameters.operation, 'get');
  assert.equal(read.parameters.returnAll, true);
  assert.equal(read.executeOnce, true);
  assert.equal(read.parameters.dataTableId.value, 'stc_event_cards');

  assert.equal(node(wf, 'Events').alwaysOutputData, true);

  const fire = node(wf, 'Fire Webhook');
  assert.equal(fire.parameters.url, '={{ $json.url }}');
  assert.equal(fire.parameters.jsonBody, '={{ JSON.stringify($json.body) }}');

  const ins = node(wf, 'Insert Seed Row');
  assert.equal(ins.parameters.operation, 'insert');
  assert.deepEqual(Object.keys(ins.parameters.columns.value), ['card_key', 'event_id', 'source', 'outcome']);
  assert.equal(ins.parameters.columns.value.card_key, '={{ $json.card_key }}');

  const slack = node(wf, 'Post Slack Note');
  assert.equal(slack.parameters.jsonBody, '={{ JSON.stringify({channel: "C0B60JLNQ20", text: $json.text}) }}');
  assert.equal(slack.credentials.slackApi.id, 'WVijCeuzSgb5H1s5');
});

test('Events flattens pages into one item per event, empty -> []', () => {
  const fn = compile(node(build.buildPoller({ runPath: RUN_PATH }), 'Events').parameters.jsCode);
  const pages = [
    { json: { pagination: { has_more_items: true }, events: [{ id: '1' }, { id: '2' }] } },
    { json: { pagination: { has_more_items: false }, events: [{ id: '3' }] } },
  ];
  const out = fn(null, { all: () => pages }, null);
  assert.deepEqual(out, [{ json: { id: '1' } }, { json: { id: '2' } }, { json: { id: '3' } }]);
  assert.deepEqual(fn(null, { all: () => [{ json: { pagination: {}, events: [] } }] }, null), []);
  assert.deepEqual(fn(null, { all: () => [{ json: {} }] }, null), []);
});

test('Decide jsCode compiles and runs decide with n8n inputs, persisting state', () => {
  const jsCode = node(build.buildPoller({ runPath: RUN_PATH }), 'Decide').parameters.jsCode;
  assert.ok(jsCode.startsWith('const cardKey = function cardKey('), 'jsCode starts with inlined cardKey');
  assert.ok(jsCode.includes('const decide = function decide('));
  const fn = compile(jsCode);

  const now = Date.now();
  const ev = { id: '42', changed: new Date(now - 7200000).toISOString(), published: new Date(now - 1800000).toISOString(), is_series_parent: false, series_id: null, name: { text: 'E' } };
  const nodes = {
    Events: [{ json: ev }],
    'GCal Get': [{ json: { statusCode: 404, headers: {}, body: {} } }],
    'Read Card Table': [{ json: { id: 1, card_key: '__seeded__', outcome: 'carded', createdAt: new Date(now).toISOString() } }],
  };
  const $ = (name) => ({ all: () => nodes[name] });
  const sd = {};
  const out = fn($, null, () => sd);
  const kinds = out.map((i) => i.json.kind + ':' + (i.json.target || ''));
  assert.deepEqual(kinds.sort(), ['fire:gcal', 'fire:ig']);
  assert.deepEqual(sd.gcalStreak, { 42: 1 });
  assert.deepEqual(sd.alerted, {});

  // Placeholder run: Events is just {} (alwaysOutputData) and the table is empty -> seed, no GCal reads.
  const empty = { Events: [{ json: {} }], 'GCal Get': [{ json: {} }], 'Read Card Table': [{ json: {} }] };
  const seeded = fn((name) => ({ all: () => empty[name] }), null, () => ({}));
  assert.deepEqual(seeded.map((i) => i.json.kind), ['seed_row', 'slack']);
  assert.equal(seeded[0].json.card_key, '__seeded__');
});

test('inlineFns emits const declarations from fn.toString()', () => {
  function sample(a) { return a + 1; }
  const src = build.inlineFns(sample);
  assert.equal(src, 'const sample = ' + sample.toString() + ';\n');
  assert.equal(new Function(src + 'return sample(1);')(), 2);
});

test('GCal Get continues on thrown errors (OAuth/network) so Decide still runs', () => {
  const g = node(build.buildPoller({ runPath: RUN_PATH }), 'GCal Get');
  assert.equal(g.onError, 'continueRegularOutput');
  assert.deepEqual(g.parameters.options.response.response, { fullResponse: true, neverError: true });
});

test('Decide treats a GCal error item (no statusCode) as unknown, not a fire', () => {
  const fn = compile(node(build.buildPoller({ runPath: RUN_PATH }), 'Decide').parameters.jsCode);
  const now = Date.now();
  const ev = { id: '7', changed: new Date(now - 7200000).toISOString(), published: new Date(now - 1800000).toISOString(), is_series_parent: false, series_id: null, name: { text: 'E' } };
  const nodes = {
    Events: [{ json: ev }],
    'GCal Get': [{ json: { error: { message: 'invalid_grant' } } }],
    'Read Card Table': [{ json: { id: 1, card_key: '7', outcome: 'carded', createdAt: new Date(now).toISOString() } },
      { json: { id: 2, card_key: '__seeded__', outcome: 'carded', createdAt: new Date(now).toISOString() } }],
  };
  const sd = {};
  const out = fn((name) => ({ all: () => nodes[name] }), null, () => sd);
  assert.deepEqual(out, []);
  assert.deepEqual(sd.gcalStreak, { 7: 1 });
});

test('Route branches run Slack notes first, then seed rows, then fires (v1 order by y)', () => {
  const wf = build.buildPoller({ runPath: RUN_PATH });
  const y = (name) => node(wf, name).position[1];
  assert.ok(y('Post Slack Note') < y('Insert Seed Row'));
  assert.ok(y('Insert Seed Row') < y('Fire Webhook'));
});

test('builds are reproducible: identical JSON across builds, ids derived from workflow id + name', () => {
  assert.equal(JSON.stringify(build.buildPoller({ runPath: RUN_PATH })), JSON.stringify(build.buildPoller({ runPath: RUN_PATH })));
  assert.equal(JSON.stringify(build.buildErrorAlert()), JSON.stringify(build.buildErrorAlert()));
  const p = build.buildPoller({ runPath: RUN_PATH });
  const a = build.buildErrorAlert();
  const ids = [...p.nodes, ...a.nodes].flatMap((n) => [n.id, n.webhookId].filter(Boolean));
  ids.push(...node(p, 'Route').parameters.rules.values.map((r) => r.conditions.conditions[0].id));
  ids.forEach((id) => assert.match(id, UUID));
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

// ---------------------------------------------------------------------------
// IG trigger transform (Task 4). Needs the live export in in/ (gitignored); skipped without it.

const LIVE_FILE = path.join(__dirname, '..', 'in', 'ig-trigger.live.json');
const HAVE_LIVE = fs.existsSync(LIVE_FILE);
const loadLive = () => JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'))[0];
const igTest = (name, fn) => test(name, { skip: HAVE_LIVE ? false : 'in/ig-trigger.live.json missing' }, fn);

const ORIGINAL_NAMES = ['Webhook (Eventbrite IG)', 'Eventbrite Fetch', 'Anthropic LLM Draft', 'Parse LLM', 'Build Block Kit Card', 'Post Approval Card'];
const NEW_NAMES = ['Gate: Live?', 'Claim', 'Get Claims', 'Am I First?', 'First?', 'Mark Duplicate', 'Slack History',
  'Existing Card?', 'Already Carded?', 'Mark Carded (Found)', 'Carded Recorded (Found)?', 'Slack OK?', 'Mark Carded', 'Carded Recorded?'];
const POLLER_LINE = ":satellite_antenna: Picked up by the fallback poller — Eventbrite's webhook didn't arrive.";

// Every [src, output, dst] edge in a workflow.
const edges = (wf) => Object.entries(wf.connections).flatMap(([src, byType]) =>
  (byType.main || []).flatMap((targets, out) => targets.map((t) => [src, out, t.node])));

igTest('IG trigger keeps top-level fields, adds errorWorkflow, does not mutate input', () => {
  const live = loadLive();
  const before = JSON.stringify(live);
  const wf = build.buildIgTrigger(live);
  assert.equal(JSON.stringify(live), before, 'input must not be mutated');
  for (const k of Object.keys(live)) {
    if (['nodes', 'connections', 'settings', 'versionId', 'activeVersionId', 'active'].includes(k)) continue;
    assert.deepEqual(wf[k], live[k], 'top-level ' + k);
  }
  assert.equal(wf.id, 'x91bE62LWVaIe43D');
  // New content gets a new version id, so n8n can never treat it as the live 6-node version.
  assert.equal(live.versionId, '19186ced-9a97-4fc4-ac78-563a2746082b');
  assert.notEqual(wf.versionId, live.versionId);
  assert.match(wf.versionId, UUID);
  assert.equal(build.buildIgTrigger(loadLive()).versionId, wf.versionId, 'versionId stable across builds');
  assert.ok(!('activeVersionId' in wf), 'activeVersionId must be removed');
  assert.equal(wf.active, false);
  // Different content -> different versionId.
  const tweaked = loadLive();
  tweaked.nodes.find((n) => n.name === 'Parse LLM').parameters.jsCode += '\n// tweak';
  assert.notEqual(build.buildIgTrigger(tweaked).versionId, wf.versionId);
  assert.deepEqual(wf.settings, { ...live.settings, errorWorkflow: 'stcErrAlert00001' });
  assert.deepEqual(wf.nodes.map((n) => n.name).sort(), [...ORIGINAL_NAMES, ...NEW_NAMES].sort());
  checkConnections(wf);
});

igTest('every original node except Build Block Kit Card is deep-equal to the input', () => {
  const live = loadLive();
  const wf = build.buildIgTrigger(live);
  for (const orig of live.nodes) {
    if (orig.name === 'Build Block Kit Card') continue;
    assert.deepEqual(node(wf, orig.name), orig, orig.name);
  }
  // Build Block Kit Card: only jsCode changes.
  const origCard = live.nodes.find((n) => n.name === 'Build Block Kit Card');
  const card = node(wf, 'Build Block Kit Card');
  const strip = (n) => ({ ...n, parameters: { ...n.parameters, jsCode: null } });
  assert.deepEqual(strip(card), strip(origCard));
  assert.notEqual(card.parameters.jsCode, origCard.parameters.jsCode);
  assert.equal(card.parameters.jsCode.split(POLLER_LINE).length, 2, 'poller line appears exactly once');
});

igTest('IG trigger wiring matches the dedupe flow; Anthropic only via Already Carded? false', () => {
  const wf = build.buildIgTrigger(loadLive());
  const e = edges(wf).map(([s, o, d]) => s + '[' + o + '] -> ' + d).sort();
  assert.deepEqual(e, [
    'Webhook (Eventbrite IG)[0] -> Eventbrite Fetch',
    'Eventbrite Fetch[0] -> Gate: Live?',
    'Gate: Live?[0] -> Claim',
    'Claim[0] -> Get Claims',
    'Get Claims[0] -> Am I First?',
    'Am I First?[0] -> First?',
    'First?[0] -> Slack History',
    'First?[1] -> Mark Duplicate',
    'Slack History[0] -> Existing Card?',
    'Existing Card?[0] -> Already Carded?',
    'Already Carded?[0] -> Mark Carded (Found)',
    'Mark Carded (Found)[0] -> Carded Recorded (Found)?',
    'Already Carded?[1] -> Anthropic LLM Draft',
    'Anthropic LLM Draft[0] -> Parse LLM',
    'Parse LLM[0] -> Build Block Kit Card',
    'Build Block Kit Card[0] -> Post Approval Card',
    'Post Approval Card[0] -> Slack OK?',
    'Slack OK?[0] -> Mark Carded',
    'Mark Carded[0] -> Carded Recorded?',
  ].sort());
  const intoLlm = edges(wf).filter(([, , d]) => d === 'Anthropic LLM Draft');
  assert.deepEqual(intoLlm, [['Already Carded?', 1, 'Anthropic LLM Draft']]);
});

igTest('existing node positions unchanged; new nodes get stable UUIDs', () => {
  const live = loadLive();
  const wf = build.buildIgTrigger(live);
  for (const orig of live.nodes) assert.deepEqual(node(wf, orig.name).position, orig.position);
  const ids = wf.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const name of NEW_NAMES) assert.match(node(wf, name).id, UUID, name);
  assert.equal(JSON.stringify(build.buildIgTrigger(loadLive())), JSON.stringify(wf), 'reproducible');
});

igTest('IG trigger data table nodes: table, typeVersion, columns, filters, retry', () => {
  const wf = build.buildIgTrigger(loadLive());
  for (const name of ['Claim', 'Get Claims', 'Mark Duplicate', 'Mark Carded', 'Mark Carded (Found)']) {
    const n = node(wf, name);
    assert.equal(n.type, 'n8n-nodes-base.dataTable', name);
    assert.equal(n.typeVersion, 1.1, name);
    assert.deepEqual(n.parameters.dataTableId, { __rl: true, mode: 'name', value: 'stc_event_cards' }, name);
    assert.equal(n.parameters.resource, 'row', name);
  }
  const claim = node(wf, 'Claim');
  assert.equal(claim.parameters.operation, 'insert');
  assert.deepEqual(claim.parameters.columns.value, {
    card_key: '={{ $json.card_key }}',
    event_id: '={{ $json.event_id }}',
    source: '={{ $json.source }}',
    execution_id: '={{ $json.execution_id }}',
    outcome: 'claimed',
    slack_ts: '',
  });

  const get = node(wf, 'Get Claims');
  assert.equal(get.parameters.operation, 'get');
  assert.equal(get.parameters.returnAll, true);
  assert.deepEqual(get.parameters.filters.conditions,
    [{ keyName: 'card_key', condition: 'eq', keyValue: "={{ $('Gate: Live?').first().json.card_key }}" }]);
  assert.equal(get.alwaysOutputData, true, 'zero rows must still reach Am I First? so it can throw');

  const byId = [{ keyName: 'id', condition: 'eq', keyValue: "={{ $('Am I First?').first().json.my_id }}" }];
  const updates = {
    'Mark Duplicate': { outcome: 'duplicate' },
    'Mark Carded': { outcome: 'carded', slack_ts: "={{ $('Post Approval Card').first().json.ts }}" },
    'Mark Carded (Found)': { outcome: 'carded', slack_ts: "={{ $('Existing Card?').first().json.found_ts }}" },
  };
  for (const [name, value] of Object.entries(updates)) {
    const n = node(wf, name);
    assert.equal(n.parameters.operation, 'update', name);
    assert.equal(n.parameters.matchType, 'allConditions', name);
    assert.deepEqual(n.parameters.filters.conditions, byId, name);
    assert.deepEqual(n.parameters.columns.value, value, name);
  }
  const mc = node(wf, 'Mark Carded');
  assert.equal(mc.retryOnFail, true);
  assert.equal(mc.maxTries, 3);
  // A zero-row update emits nothing; alwaysOutputData lets the Carded Recorded checks see that and throw.
  assert.equal(mc.alwaysOutputData, true);
  assert.equal(node(wf, 'Mark Carded (Found)').alwaysOutputData, true);
});

igTest('Slack History reads 90 days of #events-approval with the Slack credential', () => {
  const n = node(build.buildIgTrigger(loadLive()), 'Slack History');
  assert.equal(n.type, 'n8n-nodes-base.httpRequest');
  assert.equal(n.typeVersion, 4.2);
  assert.equal(n.parameters.method, 'GET');
  assert.equal(n.parameters.url, 'https://slack.com/api/conversations.history');
  assert.equal(n.parameters.authentication, 'predefinedCredentialType');
  assert.equal(n.parameters.nodeCredentialType, 'slackApi');
  assert.equal(n.parameters.sendQuery, true);
  assert.deepEqual(n.parameters.queryParameters.parameters, [
    { name: 'channel', value: 'C0B60JLNQ20' },
    { name: 'limit', value: '999' },
    { name: 'oldest', value: '={{ Math.floor(Date.now()/1000) - 7776000 }}' },
  ]);
  assert.equal(n.credentials.slackApi.id, 'WVijCeuzSgb5H1s5');
});

igTest('First? and Already Carded? IF conditions', () => {
  const wf = build.buildIgTrigger(loadLive());
  const first = node(wf, 'First?');
  assert.equal(first.type, 'n8n-nodes-base.if');
  assert.equal(first.typeVersion, 2);
  const c1 = first.parameters.conditions.conditions[0];
  assert.equal(c1.leftValue, '={{ $json.first }}');
  assert.deepEqual(c1.operator, { type: 'boolean', operation: 'true', singleValue: true });
  const c2 = node(wf, 'Already Carded?').parameters.conditions.conditions[0];
  assert.equal(c2.leftValue, '={{ $json.found_ts }}');
  assert.deepEqual(c2.operator, { type: 'string', operation: 'notEmpty', singleValue: true });
});

igTest('Gate: Live? drops non-live events and tags source', () => {
  const fn = compile(node(build.buildIgTrigger(loadLive()), 'Gate: Live?').parameters.jsCode);
  const run = (event, body) => {
    const nodes = { 'Eventbrite Fetch': { json: event }, 'Webhook (Eventbrite IG)': { json: { body } } };
    return fn((name) => ({ first: () => nodes[name] }), null, null, { id: 77 }, null);
  };
  assert.deepEqual(run({ id: '5', status: 'draft' }, {}), []);
  assert.deepEqual(run({ id: '5', status: 'canceled' }, { source: 'poller' }), []);
  assert.deepEqual(run({ id: '5', status: 'live', series_id: '9' }, { api_url: 'x' }),
    [{ json: { card_key: '9', event_id: '5', source: 'webhook', execution_id: '77' } }]);
  assert.deepEqual(run({ id: 5, status: 'live', is_series_parent: true, series_id: '5' }, { source: 'poller' }),
    [{ json: { card_key: '5', event_id: '5', source: 'poller', execution_id: '77' } }]);
});

igTest('Am I First? coerces ids, picks lowest live claim, throws when own row missing', () => {
  const fn = compile(node(build.buildIgTrigger(loadLive()), 'Am I First?').parameters.jsCode);
  const now = new Date().toISOString();
  const run = (rows, myId) => {
    const nodes = { 'Get Claims': rows.map((json) => ({ json })), Claim: [{ json: { id: myId } }] };
    return fn((name) => ({ all: () => nodes[name], first: () => nodes[name][0] }), null, null, null, null);
  };
  const earlier = { id: '3', outcome: 'claimed', createdAt: now };
  const mine = { id: 4, outcome: 'claimed', createdAt: now };
  assert.deepEqual(run([earlier, mine], '4'), [{ json: { first: false, my_id: 4 } }]);
  assert.deepEqual(run([{ ...mine, id: '4' }], 4), [{ json: { first: true, my_id: 4 } }]);
  // Stale earlier claim (> 30 min) is ignored.
  const stale = { id: 3, outcome: 'claimed', createdAt: new Date(Date.now() - 1800001).toISOString() };
  assert.deepEqual(run([stale, mine], 4), [{ json: { first: true, my_id: 4 } }]);
  // A carded row means duplicate.
  assert.deepEqual(run([{ id: 1, outcome: 'carded', createdAt: now }, mine], 4), [{ json: { first: false, my_id: 4 } }]);
  assert.throws(() => run([earlier], 4), /Own claim row not found in stc_event_cards/);
  assert.throws(() => run([{}], 4), /Own claim row not found/); // alwaysOutputData placeholder
  // Own row with an unparseable or skewed createdAt must not silently become a duplicate.
  assert.throws(() => run([{ ...mine, createdAt: 'garbage' }], 4), /createdAt is unusable/);
  assert.throws(() => run([{ ...mine, createdAt: new Date(Date.now() - 5 * 3600000).toISOString() }], 4), /createdAt is unusable/);
  // UTC-without-Z read as Chicago local time looks ~5 h in the future: also loud.
  assert.throws(() => run([{ ...mine, createdAt: new Date(Date.now() + 5 * 3600000).toISOString() }], 4), /createdAt is unusable/);
  assert.throws(() => run([{ ...mine, createdAt: new Date(Date.now() + 121000).toISOString() }], 4), /createdAt is unusable/);
  // Small clock skew (under 2 min ahead) is tolerated.
  assert.deepEqual(run([{ ...mine, createdAt: new Date(Date.now() + 60000).toISOString() }], 4), [{ json: { first: true, my_id: 4 } }]);
});

igTest('Existing Card? finds a card for this event and throws when Slack history fails', () => {
  const fn = compile(node(build.buildIgTrigger(loadLive()), 'Existing Card?').parameters.jsCode);
  const run = (resp) => {
    const nodes = { 'Gate: Live?': { json: { event_id: '123' } } };
    const items = [{ json: resp }];
    return fn((name) => ({ first: () => nodes[name] }), { first: () => items[0], all: () => items }, null, null, null);
  };
  const card = (value, ts) => ({ ts, blocks: [{ block_id: 'approval_actions', elements: [{ value }] }] });
  assert.deepEqual(run({ ok: true, messages: [card('999', '1.1'), card('123', '2.2')] }), [{ json: { found_ts: '2.2' } }]);
  assert.deepEqual(run({ ok: true, messages: [card('999', '1.1')] }), [{ json: { found_ts: '' } }]);
  assert.throws(() => run({ ok: false, error: 'not_in_channel' }), /Slack conversations.history failed: not_in_channel/);
});

igTest('Slack OK? throws on ok:false and passes ok:true through', () => {
  const fn = compile(node(build.buildIgTrigger(loadLive()), 'Slack OK?').parameters.jsCode);
  const run = (json) => {
    const items = [{ json }];
    return fn(null, { first: () => items[0], all: () => items }, null, null, null);
  };
  assert.throws(() => run({ ok: false, error: 'channel_not_found' }), /Slack chat.postMessage failed: channel_not_found/);
  assert.deepEqual(run({ ok: true, ts: '5.5' }), [{ json: { ok: true, ts: '5.5' } }]);
});

igTest('Build Block Kit Card adds the poller context block after When/Where only for poller runs', () => {
  const fn = compile(node(build.buildIgTrigger(loadLive()), 'Build Block Kit Card').parameters.jsCode);
  const parsed = { event_id: 1, event_title: 'T', event_start_local: 's', event_venue: 'v', event_url: 'u', image_url: 'i', caption: 'c', hashtags: [], recommended_channel: '#x' };
  const run = (source) => fn((name) => {
    assert.equal(name, 'Gate: Live?');
    return { first: () => ({ json: { source } }) };
  }, null, null, null, { 'Parse LLM': { json: parsed } })[0].json.payload.blocks;
  const poller = run('poller');
  assert.deepEqual(poller.map((b) => b.type), ['header', 'section', 'context', 'image', 'section', 'section', 'actions']);
  assert.deepEqual(poller[2], { type: 'context', elements: [{ type: 'mrkdwn', text: POLLER_LINE }] });
  assert.deepEqual(run('webhook').map((b) => b.type), ['header', 'section', 'image', 'section', 'section', 'actions']);
});

igTest('buildIgTrigger throws if the Build Block Kit Card anchor is missing or duplicated', () => {
  const withCode = (f) => {
    const live = loadLive();
    const n = live.nodes.find((x) => x.name === 'Build Block Kit Card');
    n.parameters.jsCode = f(n.parameters.jsCode);
    return live;
  };
  assert.throws(() => build.buildIgTrigger(withCode((c) => c.replace('if (image_url) {', 'if (image_url){'))), /anchor/i);
  assert.throws(() => build.buildIgTrigger(withCode((c) => c + '\n];\nif (image_url) {\n')), /anchor/i);
});

igTest('main writes ig-trigger.json (single object) and a readable diff; no GCal output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-build-'));
  build.main(dir);
  const ig = JSON.parse(fs.readFileSync(path.join(dir, 'ig-trigger.json'), 'utf8'));
  assert.ok(!Array.isArray(ig));
  assert.equal(ig.id, 'x91bE62LWVaIe43D');
  assert.deepEqual(fs.readdirSync(dir).sort(),
    ['error-alert.json', 'ig-trigger.diff.md', 'ig-trigger.json', 'poller-run-path.txt', 'poller.json']);
  const md = fs.readFileSync(path.join(dir, 'ig-trigger.diff.md'), 'utf8');
  assert.ok(!md.includes('"connections"'), 'no raw JSON dump');
  assert.ok(md.includes('```diff'));
  assert.ok(md.includes("+if ($('Gate: Live?').first().json.source === 'poller') {"));
  assert.ok(md.includes('errorWorkflow'));
  assert.ok(md.includes('stcErrAlert00001'));
  for (const name of NEW_NAMES) assert.ok(md.includes(name), 'diff mentions ' + name);
  assert.ok(md.includes('sanity check'), 'Am I First? row mentions the createdAt guard');
  assert.ok(md.includes('stc_event_cards` table must already exist'), 'table prerequisite line');
  assert.ok(md.includes('Known limitation'), 'known limitation line');
  assert.ok(md.includes('times out'), 'limitation covers a Post Approval Card timeout');
  assert.ok(md.includes('30 to 45 minutes'), 'limitation window is the poller retry window');
  assert.ok(!md.includes('within 30 minutes'), 'old window wording removed');
});

test('main skips the IG trigger when the live export is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-build-'));
  const emptyIn = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-in-'));
  build.main(dir, emptyIn);
  assert.ok(!fs.existsSync(path.join(dir, 'ig-trigger.json')));
  assert.ok(fs.existsSync(path.join(dir, 'poller.json')));
});

test('unifiedDiff renders a unified hunk with 3 lines of context', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
  const b = ['1', '2', '3', '4', 'new', '5', '6', '7', '8'].join('\n');
  assert.equal(build.unifiedDiff(a, b, 'a', 'b'), [
    '--- a', '+++ b', '@@ -2,6 +2,7 @@', ' 2', ' 3', ' 4', '+new', ' 5', ' 6', ' 7',
  ].join('\n'));
  assert.equal(build.unifiedDiff('x\ny', 'x\nz', 'a', 'b'), ['--- a', '+++ b', '@@ -1,2 +1,2 @@', ' x', '-y', '+z'].join('\n'));
  assert.equal(build.unifiedDiff('same', 'same', 'a', 'b'), '--- a\n+++ b');
});

igTest('Carded Recorded checks throw when the carded update matched no row', () => {
  const wf = build.buildIgTrigger(loadLive());
  for (const name of ['Carded Recorded?', 'Carded Recorded (Found)?']) {
    const n = node(wf, name);
    assert.equal(n.type, 'n8n-nodes-base.code', name);
    const fn = compile(n.parameters.jsCode);
    const run = (items) => fn((nm) => {
      assert.equal(nm, 'Am I First?');
      return { first: () => ({ json: { first: true, my_id: 4 } }) };
    }, { all: () => items, first: () => items[0] }, null, null, null);
    // alwaysOutputData placeholder for a zero-row update.
    assert.throws(() => run([{ json: {} }]), /stc_event_cards update matched no row for claim 4/, name);
    assert.throws(() => run([{ json: { id: 5, outcome: 'carded' } }]), /matched no row for claim 4/, name + ' other row');
    assert.throws(() => run([{ json: { id: 4, outcome: 'claimed' } }]), /matched no row for claim 4/, name + ' not carded');
    const ok = [{ json: { id: '4', outcome: 'carded', slack_ts: '1.2' } }];
    assert.deepEqual(run(ok), ok, name + ' passes a matching row through');
  }
});

test('poller and error alert get content-derived versionIds', () => {
  const p = build.buildPoller({ runPath: RUN_PATH });
  const a = build.buildErrorAlert();
  assert.match(p.versionId, UUID);
  assert.match(a.versionId, UUID);
  assert.notEqual(p.versionId, a.versionId);
  assert.equal(build.buildPoller({ runPath: RUN_PATH }).versionId, p.versionId, 'stable');
  assert.equal(build.buildErrorAlert().versionId, a.versionId, 'stable');
  assert.notEqual(build.buildPoller({ runPath: 'stc-poller-run-fedcba9876543210' }).versionId, p.versionId, 'content-derived');
});

test('poller Slack Note OK? fails the execution when Slack refuses a note', () => {
  const wf = build.buildPoller({ runPath: RUN_PATH });
  assert.deepEqual(wf.connections['Post Slack Note'].main[0].map((t) => t.node), ['Slack Note OK?']);
  const fn = compile(node(wf, 'Slack Note OK?').parameters.jsCode);
  const run = (json) => {
    const items = [{ json }];
    return fn(null, { first: () => items[0], all: () => items }, null, null, null);
  };
  assert.throws(() => run({ ok: false, error: 'not_in_channel' }), /Slack chat.postMessage failed: not_in_channel/);
  assert.deepEqual(run({ ok: true, ts: '1.1' }), [{ json: { ok: true, ts: '1.1' } }]);
});
