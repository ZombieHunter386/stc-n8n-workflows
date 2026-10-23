// Generates the n8n workflow JSON for the Eventbrite poller fallback.
// Builders are exported so tests can run them in-process; `node build.js` writes out/.
// Parameter shapes follow n8n 2.21.7 (see .superpowers/sdd/.../n8n-reference.md).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cardKey, amIFirst, findExistingCard } = require('./lib/claims');
const { decide } = require('./lib/decide');

const ERROR_WORKFLOW_ID = 'stcErrAlert00001';
const POLLER_WORKFLOW_ID = 'stcEbPoller00001';
const TABLE_NAME = 'stc_event_cards';
const TABLE_COLUMNS = ['card_key', 'event_id', 'source', 'outcome', 'slack_ts', 'execution_id'];
const SLACK_CHANNEL = 'C0B60JLNQ20';

const CREDS = {
  eventbrite: { httpHeaderAuth: { id: 'zClNC6mtULsSIeLj', name: 'Eventbrite Bearer (STC)' } },
  gcal: { googleCalendarOAuth2Api: { id: 'NTUMT4g7hpZHQlBd', name: 'Google Calendar (STC)' } },
  slack: { slackApi: { id: 'WVijCeuzSgb5H1s5', name: 'Slack (STC Automation)' } },
};

// Inline standalone function declarations as `const name = <source>;` for a Code node's jsCode.
function inlineFns(...fns) {
  return fns.map((fn) => 'const ' + fn.name + ' = ' + fn.toString() + ';\n').join('');
}

// Deterministic UUID-formatted id (sha256 of the seed) so rebuilds produce identical JSON
// and re-imports keep stable node ids and webhook registrations.
function stableUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' + variant + h.slice(17, 20) + '-' + h.slice(20, 32);
}

// id (and webhookId for webhook nodes) are filled in by workflow() from workflow id + node name.
function mkNode(name, type, typeVersion, position, parameters, extra = {}) {
  return { parameters, id: null, name, type, typeVersion, position, ...extra };
}

// connections: [[src, dst, srcOutput = 0], ...]
function wire(links) {
  const out = {};
  for (const [src, dst, idx = 0] of links) {
    out[src] = out[src] || { main: [] };
    while (out[src].main.length <= idx) out[src].main.push([]);
    out[src].main[idx].push({ node: dst, type: 'main', index: 0 });
  }
  return out;
}

// Content-derived versionId: identical builds share it; any change to nodes/wiring/settings gets a new one.
// Never reuse a live versionId: n8n 2.x keys workflow history by it.
function contentVersionId(workflowId, nodes, connections, settings) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ nodes, connections, settings })).digest('hex');
  return stableUuid(workflowId + ':version:' + hash);
}

function workflow(id, name, nodes, links, settings = {}) {
  for (const n of nodes) {
    n.id = stableUuid(id + ':' + n.name);
    if (n.type === 'n8n-nodes-base.webhook') n.webhookId = stableUuid(id + ':' + n.name + ':webhookId');
  }
  const connections = wire(links);
  const allSettings = { executionOrder: 'v1', ...settings };
  return {
    id,
    name,
    nodes,
    connections,
    settings: allSettings,
    versionId: contentVersionId(id, nodes, connections, allSettings),
    active: false,
    pinData: {},
    staticData: null,
  };
}

function slackPost(name, position, textExpr) {
  return mkNode(name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'slackApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({channel: "' + SLACK_CHANNEL + '", text: ' + textExpr + '}) }}',
    options: {},
  }, { credentials: CREDS.slack });
}

const tableRef = () => ({ __rl: true, mode: 'name', value: TABLE_NAME });

// Shared by Slack OK? (IG trigger) and Slack Note OK? (poller).
const SLACK_OK_JS = [
  '// Slack answers HTTP 200 with ok:false on errors; without this a failed post looks like a success.',
  'for (const item of $input.all()) {',
  "  if (item.json.ok !== true) throw new Error('Slack chat.postMessage failed: ' + item.json.error);",
  '}',
  'return $input.all();',
].join('\n');

const FORMAT_JS = [
  'const j = $input.first().json || {};',
  'const wf = j.workflow || {};',
  'const ex = j.execution || {};',
  'const err = ex.error || {};',
  "const text = ':rotating_light: n8n workflow *' + (wf.name || 'unknown workflow') + '* failed at node *' +",
  "  (ex.lastNodeExecuted || 'unknown node') + '*: ' + (err.message || 'no error message') +",
  "  (ex.url ? '\\n' + ex.url : '');",
  'return [{ json: { text } }];',
].join('\n');

function buildErrorAlert() {
  const nodes = [
    mkNode('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {}),
    mkNode('Format', 'n8n-nodes-base.code', 2, [220, 0], { jsCode: FORMAT_JS }),
    slackPost('Post Alert', [440, 0], '$json.text'),
  ];
  return workflow(ERROR_WORKFLOW_ID, 'STC Error Alert', nodes, [
    ['Error Trigger', 'Format'],
    ['Format', 'Post Alert'],
  ]);
}

// Each input item is one Eventbrite page {pagination, events: [...]}; emit one item per event.
// Zero events -> [] (the node's alwaysOutputData then yields one {} placeholder).
const EVENTS_JS = [
  'const out = [];',
  'for (const item of $input.all()) {',
  '  const events = (item.json && item.json.events) || [];',
  '  for (const e of events) out.push({ json: e });',
  '}',
  'return out;',
].join('\n');

const DECIDE_GLUE = [
  "const events = $('Events').all().map(i => i.json).filter(e => e && e.id);",
  '// GCal Get emits one item per Events item, in order. With only the {} placeholder there are no events to align.',
  "const gcal = events.length ? $('GCal Get').all().map(i => ({ statusCode: i.json.statusCode, body: i.json.body })) : [];",
  "const rows = $('Read Card Table').all().map(i => i.json);",
  "const sd = $getWorkflowStaticData('global');",
  'const state = { gcalStreak: sd.gcalStreak || {}, alerted: sd.alerted || {} };',
  'const res = decide({ events, gcal, rows, nowMs: Date.now(), state });',
  'sd.gcalStreak = res.state.gcalStreak;',
  'sd.alerted = res.state.alerted;',
  'return res.actions.map(a => ({ json: a }));',
].join('\n');

function routeRules(workflowId, nodeName, kinds) {
  return {
    values: kinds.map((k) => ({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: stableUuid(workflowId + ':' + nodeName + ':' + k),
          leftValue: '={{ $json.kind }}',
          rightValue: k,
          operator: { type: 'string', operation: 'equals' },
        }],
        combinator: 'and',
      },
      renameOutput: true,
      outputKey: k,
    })),
  };
}

function buildPoller({ runPath }) {
  if (!runPath) throw new Error('buildPoller: runPath is required');
  const nodes = [
    mkNode('Every 15 min', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
      rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] },
    }),
    mkNode('Run Now', 'n8n-nodes-base.webhook', 2, [0, 200], {
      httpMethod: 'POST', path: runPath, responseMode: 'onReceived', responseCode: 200, options: {},
    }),
    mkNode('Ensure Table', 'n8n-nodes-base.dataTable', 1.1, [220, 100], {
      resource: 'table',
      operation: 'create',
      tableName: TABLE_NAME,
      columns: { column: TABLE_COLUMNS.map((name) => ({ name, type: 'string' })) },
      options: { createIfNotExists: true },
    }, { executeOnce: true }),
    // Hard-fail: no neverError / continueOnFail, so an Eventbrite outage triggers the error workflow.
    mkNode('List Live Events', 'n8n-nodes-base.httpRequest', 4.2, [440, 100], {
      method: 'GET',
      url: 'https://www.eventbriteapi.com/v3/organizations/2224611974573/events/?status=live',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        pagination: {
          pagination: {
            paginationMode: 'updateAParameterInEachRequest',
            parameters: { parameters: [{ type: 'qs', name: 'continuation', value: '={{ $response.body.pagination.continuation }}' }] },
            paginationCompleteWhen: 'other',
            completeExpression: '={{ !$response.body.pagination.has_more_items }}',
          },
        },
      },
    }, { executeOnce: true, credentials: CREDS.eventbrite }),
    mkNode('Events', 'n8n-nodes-base.code', 2, [660, 100], { jsCode: EVENTS_JS }, { alwaysOutputData: true }),
    mkNode('GCal Get', 'n8n-nodes-base.httpRequest', 4.2, [880, 100], {
      method: 'GET',
      url: '=https://www.googleapis.com/calendar/v3/calendars/strongtownschicago%40gmail.com/events/eventbrite{{ $json.id }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleCalendarOAuth2Api',
      options: { response: { response: { fullResponse: true, neverError: true } } },
    // neverError only covers HTTP status codes; OAuth refresh failures (invalid_grant) and network
    // errors still throw. continueRegularOutput turns those into one {error} item per input, keeping
    // alignment with Events, so Decide counts them as unknown instead of the whole poller halting.
    }, { credentials: CREDS.gcal, onError: 'continueRegularOutput' }),
    // Hard-fail: a failed read must never look like an empty table (Decide would re-seed).
    // alwaysOutputData only covers the genuinely empty table, so Decide still runs.
    mkNode('Read Card Table', 'n8n-nodes-base.dataTable', 1.1, [1100, 100], {
      resource: 'row',
      operation: 'get',
      dataTableId: tableRef(),
      matchType: 'allConditions',
      returnAll: true,
    }, { alwaysOutputData: true, executeOnce: true }),
    mkNode('Decide', 'n8n-nodes-base.code', 2, [1320, 100], {
      jsCode: inlineFns(cardKey, decide) + DECIDE_GLUE,
    }),
    mkNode('Route', 'n8n-nodes-base.switch', 3, [1540, 100], {
      rules: routeRules(POLLER_WORKFLOW_ID, 'Route', ['fire', 'seed_row', 'slack']),
      options: {},
    }),
    // executionOrder v1 runs Route's branches top to bottom (smallest y first). Fire Webhook is lowest
    // so a throwing fire cannot skip the Slack notes (whose alerted flag Decide already set) or seed rows.
    mkNode('Fire Webhook', 'n8n-nodes-base.httpRequest', 4.2, [1780, 300], {
      method: 'POST',
      url: '={{ $json.url }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: {},
    }),
    mkNode('Insert Seed Row', 'n8n-nodes-base.dataTable', 1.1, [1780, 100], {
      resource: 'row',
      operation: 'insert',
      dataTableId: tableRef(),
      columns: {
        mappingMode: 'defineBelow',
        value: {
          card_key: '={{ $json.card_key }}',
          event_id: '={{ $json.event_id }}',
          source: '={{ $json.source }}',
          outcome: '={{ $json.outcome }}',
        },
        matchingColumns: [],
        schema: [],
      },
      options: {},
    }),
    slackPost('Post Slack Note', [1780, -100], '$json.text'),
    // A refused note (ok:false on HTTP 200) must show up as a failed execution, not a silent success.
    mkNode('Slack Note OK?', 'n8n-nodes-base.code', 2, [2000, -100], { jsCode: SLACK_OK_JS }),
  ];

  return workflow(POLLER_WORKFLOW_ID, 'STC Eventbrite Poller (fallback)', nodes, [
    ['Every 15 min', 'Ensure Table'],
    ['Run Now', 'Ensure Table'],
    ['Ensure Table', 'List Live Events'],
    ['List Live Events', 'Events'],
    ['Events', 'GCal Get'],
    ['GCal Get', 'Read Card Table'],
    ['Read Card Table', 'Decide'],
    ['Decide', 'Route'],
    ['Route', 'Fire Webhook', 0],
    ['Route', 'Insert Seed Row', 1],
    ['Route', 'Post Slack Note', 2],
    ['Post Slack Note', 'Slack Note OK?'],
  ], { errorWorkflow: ERROR_WORKFLOW_ID });
}

// ---------------------------------------------------------------------------
// IG trigger (existing workflow x91bE62LWVaIe43D): add the claim/dedupe gate in front of the LLM call.
// Input is the live export's workflow object; existing nodes are kept byte-for-byte except one anchored
// insertion in Build Block Kit Card. See spec §2 "IG trigger changes".

const IG = {
  webhook: 'Webhook (Eventbrite IG)',
  fetch: 'Eventbrite Fetch',
  llm: 'Anthropic LLM Draft',
  parse: 'Parse LLM',
  card: 'Build Block Kit Card',
  post: 'Post Approval Card',
};
const STALE_MS = 1800000; // 30 min: claims older than this that never reached `carded` are failed attempts.
const SLACK_HISTORY_WINDOW_S = 7776000; // 90 days
const MAX_FUTURE_SKEW_MS = 120000; // own claim's createdAt may be at most 2 min ahead of the Code node's clock

const POLLER_CONTEXT_LINE = ":satellite_antenna: Picked up by the fallback poller — Eventbrite's webhook didn't arrive.";
// The poller line goes right after the When/Where section (end of the initial `blocks` array), before the image.
const CARD_ANCHOR = '\n];\nif (image_url) {';
const CARD_INSERT = '\n];\n' +
  "if ($('Gate: Live?').first().json.source === 'poller') {\n" +
  '  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ' + JSON.stringify(POLLER_CONTEXT_LINE) + ' }] });\n' +
  '}\n' +
  'if (image_url) {';

const GATE_GLUE = [
  "const event = $('Eventbrite Fetch').first().json;",
  '// A stale or late delivery for an event that is no longer live must not card or claim.',
  "if (event.status !== 'live') return [];",
  "const body = $('Webhook (Eventbrite IG)').first().json.body || {};",
  "const source = body.source === 'poller' ? 'poller' : 'webhook';",
  'return [{ json: { card_key: cardKey(event), event_id: String(event.id), source, execution_id: String($execution.id) } }];',
].join('\n');

const AM_I_FIRST_GLUE = [
  '// Data Table ids are numbers, but coerce defensively: amIFirst compares with ===.',
  "const rows = $('Get Claims').all().map(i => i.json)",
  '  .filter(r => r && r.id !== undefined && r.id !== null)',
  '  .map(r => Object.assign({}, r, { id: Number(r.id) }));',
  "const myId = Number($('Claim').first().json.id);",
  "const mine = rows.find(r => r.id === myId);",
  "if (!mine) throw new Error('Own claim row not found in stc_event_cards');",
  '// Our row was just inserted. If it does not look fresh, createdAt is unparseable or skewed (e.g. a UTC time',
  '// without Z read as Chicago local, ~5 h off either way), and amIFirst could silently call us a duplicate.',
  "const ageMs = Date.now() - Date.parse(mine.createdAt);",
  "if (!(ageMs < " + STALE_MS + " && ageMs > -" + MAX_FUTURE_SKEW_MS + ")) throw new Error('Own claim row createdAt is unusable: ' + mine.createdAt);",
  'return [{ json: { first: amIFirst(rows, myId, Date.now(), ' + STALE_MS + '), my_id: myId } }];',
].join('\n');

const EXISTING_CARD_GLUE = [
  'const res = $input.first().json || {};',
  '// Never post on a failed history read: an unseen existing card would be double-posted.',
  "if (res.ok !== true) throw new Error('Slack conversations.history failed: ' + res.error);",
  "const event_id = $('Gate: Live?').first().json.event_id;",
  "return [{ json: { found_ts: findExistingCard(res.messages || [], event_id) || '' } }];",
].join('\n');

// A Data Table update whose filter matches nothing emits zero items without throwing. With alwaysOutputData
// on the update, this check sees the {} placeholder and fails loudly instead of leaving the row `claimed`
// (which would let the poller retry and, after an approval rewrote the card, post a second one).
const CARDED_RECORDED_JS = [
  "const claimId = $('Am I First?').first().json.my_id;",
  'const myId = Number(claimId);',
  'const items = $input.all();',
  'const ok = items.some(i => i.json && i.json.id !== undefined && i.json.id !== null &&',
  "  Number(i.json.id) === myId && i.json.outcome === 'carded');",
  "if (!ok) throw new Error('stc_event_cards update matched no row for claim ' + claimId);",
  'return items;',
].join('\n');

function ifNode(workflowId, name, position, leftValue, operator) {
  return mkNode(name, 'n8n-nodes-base.if', 2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: stableUuid(workflowId + ':' + name + ':cond'), leftValue, rightValue: '', operator }],
      combinator: 'and',
    },
    options: {},
  });
}

const rowColumns = (value) => ({ mappingMode: 'defineBelow', value, matchingColumns: [], schema: [] });
const byMyId = () => ({ conditions: [{ keyName: 'id', condition: 'eq', keyValue: "={{ $('Am I First?').first().json.my_id }}" }] });

function rowUpdate(name, position, value, extra) {
  return mkNode(name, 'n8n-nodes-base.dataTable', 1.1, position, {
    resource: 'row',
    operation: 'update',
    dataTableId: tableRef(),
    matchType: 'allConditions',
    filters: byMyId(),
    columns: rowColumns(value),
    options: {},
  }, extra);
}

function patchCardCode(jsCode) {
  const count = jsCode.split(CARD_ANCHOR).length - 1;
  if (count !== 1) {
    throw new Error('Build Block Kit Card: expected the insertion anchor exactly once, found ' + count +
      '. The live node changed upstream; update CARD_ANCHOR in build.js.');
  }
  return jsCode.replace(CARD_ANCHOR, CARD_INSERT);
}

// The new nodes, in flow order. Placed on rows below the existing y=300 line so existing positions stay put.
function igNewNodes(wfId) {
  return [
    mkNode('Gate: Live?', 'n8n-nodes-base.code', 2, [440, 520], { jsCode: inlineFns(cardKey) + GATE_GLUE }),
    mkNode('Claim', 'n8n-nodes-base.dataTable', 1.1, [660, 520], {
      resource: 'row',
      operation: 'insert',
      dataTableId: tableRef(),
      columns: rowColumns({
        card_key: '={{ $json.card_key }}',
        event_id: '={{ $json.event_id }}',
        source: '={{ $json.source }}',
        execution_id: '={{ $json.execution_id }}',
        outcome: 'claimed',
        slack_ts: '',
      }),
      options: {},
    }),
    // alwaysOutputData: if the read somehow misses our own row, Am I First? still runs and throws.
    mkNode('Get Claims', 'n8n-nodes-base.dataTable', 1.1, [880, 520], {
      resource: 'row',
      operation: 'get',
      dataTableId: tableRef(),
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'card_key', condition: 'eq', keyValue: "={{ $('Gate: Live?').first().json.card_key }}" }] },
      returnAll: true,
    }, { alwaysOutputData: true }),
    mkNode('Am I First?', 'n8n-nodes-base.code', 2, [1100, 520], { jsCode: inlineFns(amIFirst) + AM_I_FIRST_GLUE }),
    ifNode(wfId, 'First?', [1320, 520], '={{ $json.first }}', { type: 'boolean', operation: 'true', singleValue: true }),
    rowUpdate('Mark Duplicate', [1540, 700], { outcome: 'duplicate' }),
    mkNode('Slack History', 'n8n-nodes-base.httpRequest', 4.2, [1540, 520], {
      method: 'GET',
      url: 'https://slack.com/api/conversations.history',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'channel', value: SLACK_CHANNEL },
          { name: 'limit', value: '999' },
          { name: 'oldest', value: '={{ Math.floor(Date.now()/1000) - ' + SLACK_HISTORY_WINDOW_S + ' }}' },
        ],
      },
      options: {},
    }, { credentials: CREDS.slack }),
    mkNode('Existing Card?', 'n8n-nodes-base.code', 2, [1760, 520], { jsCode: inlineFns(findExistingCard) + EXISTING_CARD_GLUE }),
    ifNode(wfId, 'Already Carded?', [1980, 520], '={{ $json.found_ts }}', { type: 'string', operation: 'notEmpty', singleValue: true }),
    rowUpdate('Mark Carded (Found)', [2200, 700], { outcome: 'carded', slack_ts: "={{ $('Existing Card?').first().json.found_ts }}" },
      { alwaysOutputData: true }),
    mkNode('Carded Recorded (Found)?', 'n8n-nodes-base.code', 2, [2420, 700], { jsCode: CARDED_RECORDED_JS }),
    mkNode('Slack OK?', 'n8n-nodes-base.code', 2, [1640, 300], { jsCode: SLACK_OK_JS }),
    rowUpdate('Mark Carded', [1880, 300], { outcome: 'carded', slack_ts: "={{ $('Post Approval Card').first().json.ts }}" },
      { retryOnFail: true, maxTries: 3, alwaysOutputData: true }),
    mkNode('Carded Recorded?', 'n8n-nodes-base.code', 2, [2100, 300], { jsCode: CARDED_RECORDED_JS }),
  ];
}

const IG_LINKS = [
  [IG.webhook, IG.fetch],
  [IG.fetch, 'Gate: Live?'],
  ['Gate: Live?', 'Claim'],
  ['Claim', 'Get Claims'],
  ['Get Claims', 'Am I First?'],
  ['Am I First?', 'First?'],
  ['First?', 'Slack History', 0],
  ['First?', 'Mark Duplicate', 1],
  ['Slack History', 'Existing Card?'],
  ['Existing Card?', 'Already Carded?'],
  ['Already Carded?', 'Mark Carded (Found)', 0],
  ['Mark Carded (Found)', 'Carded Recorded (Found)?'],
  ['Already Carded?', IG.llm, 1],
  [IG.llm, IG.parse],
  [IG.parse, IG.card],
  [IG.card, IG.post],
  [IG.post, 'Slack OK?'],
  ['Slack OK?', 'Mark Carded'],
  ['Mark Carded', 'Carded Recorded?'],
];

function buildIgTrigger(liveWorkflow) {
  const live = structuredClone(liveWorkflow);
  const names = live.nodes.map((n) => n.name);
  for (const required of Object.values(IG)) {
    if (!names.includes(required)) throw new Error('IG trigger export is missing node "' + required + '"');
  }
  if (names.length !== Object.keys(IG).length) {
    throw new Error('IG trigger export has unexpected nodes: ' + names.join(', ') + '. Review before transforming.');
  }
  const card = live.nodes.find((n) => n.name === IG.card);
  card.parameters.jsCode = patchCardCode(card.parameters.jsCode);

  const added = igNewNodes(live.id);
  for (const n of added) n.id = stableUuid(live.id + ':' + n.name);

  const nodes = [...live.nodes, ...added];
  const connections = wire(IG_LINKS);
  const settings = { ...live.settings, errorWorkflow: ERROR_WORKFLOW_ID };
  // Never reuse the live versionId/activeVersionId: n8n 2.x keys workflow history by versionId, and reusing it
  // could let a publish re-activate the old 6-node trigger (two cards per event once the poller runs).
  const out = {
    ...live,
    nodes,
    connections,
    settings,
    versionId: contentVersionId(live.id, nodes, connections, settings),
    active: false,
  };
  delete out.activeVersionId;
  return out;
}

// --- Diff for Hunter -------------------------------------------------------

// Minimal LCS line diff rendered as unified hunks with 3 lines of context.
function unifiedDiff(aText, bText, aName, bName) {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = []; // [type, line, aIdx, bIdx]
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; }
    else if (i < a.length && (j >= b.length || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', a[i], i, j]); i++; }
    else { ops.push(['+', b[j], i, j]); j++; }
  }
  const CTX = 3;
  const out = ['--- ' + aName, '+++ ' + bName];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    let start = Math.max(0, k - CTX);
    let end = k;
    // Extend the hunk while changes are within 2*CTX of each other.
    while (end < ops.length) {
      if (ops[end][0] !== ' ') { end++; continue; }
      let next = end;
      while (next < ops.length && ops[next][0] === ' ') next++;
      if (next < ops.length && next - end <= 2 * CTX) { end = next; continue; }
      end = Math.min(ops.length, end + CTX);
      break;
    }
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o[0] !== '+').length;
    const bCount = hunk.filter((o) => o[0] !== '-').length;
    out.push('@@ -' + (hunk[0][2] + 1) + ',' + aCount + ' +' + (hunk[0][3] + 1) + ',' + bCount + ' @@');
    for (const o of hunk) out.push(o[0] + o[1]);
    k = end;
  }
  return out.join('\n');
}

const NEW_NODE_WHY = {
  'Gate: Live?': 'Stops if the event is no longer live (a late, stale delivery). Works out the card key and whether the poller or Eventbrite sent this.',
  'Claim': 'Writes a "claimed" row to the stc_event_cards table before the slow AI step, so two simultaneous runs race for milliseconds, not seconds.',
  'Get Claims': 'Reads every row for this event (or series).',
  'Am I First?': 'Decides who wins: if the event was already carded, or an earlier claim is still fresh (under 30 min), this run is a duplicate. Errors loudly if its own claim row is missing, or if its timestamp fails a sanity check (unreadable, or a clock/timezone mix-up), rather than quietly skipping the card.',
  'First?': 'Yes/no branch on that decision.',
  'Mark Duplicate': 'Losing runs mark their row "duplicate" and stop. That leaves an audit trail of every suppressed double.',
  'Slack History': 'Reads the last 90 days of #events-approval.',
  'Existing Card?': 'Looks for an approval card whose buttons carry this event id. This catches "Slack posted but we failed to record it" and a lost table. Errors if Slack refuses the read, rather than risk a double post.',
  'Already Carded?': 'Yes/no branch on that search.',
  'Mark Carded (Found)': 'A card already exists: record its Slack timestamp and stop without posting.',
  'Carded Recorded (Found)?': 'Confirms the table really saved that. If the update quietly matched no row, it errors (and alerts) instead of leaving the event looking unfinished.',
  'Slack OK?': 'Slack replies "200 OK" even when a post fails. This step turns that into a real error, so a failed post is never recorded as carded and the error alert fires.',
  'Mark Carded': 'Records the posted card (outcome "carded" + Slack timestamp). Retries up to 3 times.',
  'Carded Recorded?': 'Confirms the table really saved it. A save that quietly matched no row would let the poller retry later and post a second card, so this errors (and alerts) instead.',
};

const IG_DIAGRAM = [
  'Webhook (Eventbrite IG)',
  '  -> Eventbrite Fetch',
  '  -> [Gate: Live?] ------------------------ not live: stop (nothing written)',
  '  -> [Claim]',
  '  -> [Get Claims]',
  '  -> [Am I First?]',
  '  -> [First?]',
  '       |- no  -> [Mark Duplicate]          (stop)',
  '       `- yes -> [Slack History]',
  '                  -> [Existing Card?]',
  '                  -> [Already Carded?]',
  '                       |- yes -> [Mark Carded (Found)] -> [Carded Recorded (Found)?]   (stop, no post)',
  '                       `- no  -> Anthropic LLM Draft',
  '                                 -> Parse LLM',
  '                                 -> Build Block Kit Card   (+1 line for poller runs)',
  '                                 -> Post Approval Card',
  '                                 -> [Slack OK?]',
  '                                 -> [Mark Carded]',
  '                                 -> [Carded Recorded?]',
  '',
  '[brackets] = new step',
].join('\n');

function buildIgDiffMarkdown(live, next) {
  const liveCode = live.nodes.find((n) => n.name === IG.card).parameters.jsCode;
  const nextCode = next.nodes.find((n) => n.name === IG.card).parameters.jsCode;
  const liveNames = live.nodes.map((n) => n.name);
  const newNames = next.nodes.map((n) => n.name).filter((n) => !liveNames.includes(n));
  const explained = Object.keys(NEW_NODE_WHY);
  if (JSON.stringify([...newNames].sort()) !== JSON.stringify([...explained].sort())) {
    throw new Error('NEW_NODE_WHY must explain exactly the new nodes: ' + newNames.join(', '));
  }
  const flowOrder = (wf, names) => {
    // Order by walking the wiring from the webhook, so lists read in run order.
    const seen = [];
    const visit = (name) => {
      if (seen.includes(name)) return;
      seen.push(name);
      for (const targets of ((wf.connections[name] || {}).main || [])) for (const t of targets) visit(t.node);
    };
    visit(IG.webhook);
    return seen.filter((n) => names.includes(n));
  };
  const lines = [
    '# IG trigger change: what, why, and the exact diff',
    '',
    'Workflow: **' + live.name + '** (`' + live.id + '`), built from live version `' + live.versionId + '`.',
    '',
    '## In plain English',
    '',
    'Today every "event published" message from Eventbrite goes straight to the AI draft and posts a Slack approval card. ' +
      'The new fallback poller can also send that message, and Eventbrite sometimes delivers late or twice, so the trigger now makes sure there is **exactly one card per event**. ' +
      'Before the AI step it records a claim in a small table; only the earliest claim goes on, and it first checks Slack for a card that already exists. ' +
      'The AI prompt, card buttons and channel are untouched; the only visible difference is one extra line on cards the poller picked up.',
    '',
    '## Steps before and after',
    '',
    '**Before** (' + liveNames.length + ' steps): ' + flowOrder(live, liveNames).join(' -> '),
    '',
    '**After** (' + next.nodes.length + ' steps): all ' + liveNames.length + ' existing steps are kept unchanged, except one line added to Build Block Kit Card. New steps:',
    '',
    '| New step | Why it is there |',
    '|---|---|',
    ...Object.keys(NEW_NODE_WHY).map((n) => '| ' + n + ' | ' + NEW_NODE_WHY[n] + ' |'),
    '',
    '## New wiring',
    '',
    '```',
    IG_DIAGRAM,
    '```',
    '',
    '## Code change in Build Block Kit Card',
    '',
    'This is the only edit to an existing step. When the poller sent the event, the card gets a small grey line under When/Where ' +
      'reading "' + POLLER_CONTEXT_LINE + '" If you see it, Eventbrite\'s webhooks are stalling.',
    '',
    '```diff',
    unifiedDiff(liveCode, nextCode, 'Build Block Kit Card (live)', 'Build Block Kit Card (new)'),
    '```',
    '',
    '## Settings change',
    '',
    '```diff',
    ...Object.keys({ ...live.settings, ...next.settings }).map((k) => {
      const a = live.settings[k];
      const b = next.settings[k];
      if (JSON.stringify(a) === JSON.stringify(b)) return '  ' + k + ': ' + JSON.stringify(a);
      return (a === undefined ? '' : '- ' + k + ': ' + JSON.stringify(a) + '\n') + '+ ' + k + ': ' + JSON.stringify(b);
    }),
    '```',
    '',
    '`errorWorkflow` points at "STC Error Alert" (`' + ERROR_WORKFLOW_ID + '`). Any failure in this workflow (Slack refusing a post, the table being unreachable, a missing claim row) then posts an alert to Slack, instead of failing silently.',
    '',
    '## Before publishing',
    '',
    '- The `' + TABLE_NAME + '` table must already exist before this version is published. The poller creates it and seeds it with the current live events on its first run, so publish and run the poller first.',
    '- This file gets a new version id (`' + next.versionId + '`) and imports switched off, so n8n cannot mix it up with the live version. It goes live only when it is explicitly published.',
    '',
    '## Known limitation',
    '',
    'One rare case can still produce a second card. Slack accepts a card but the workflow never records it, either because Post Approval Card times out waiting for Slack\'s reply or because saving to the table fails all 3 tries. ' +
      'If someone then approves that card before the poller\'s retry (about 30 to 45 minutes later), the retry cannot recognise it, because approving rewrites the card, and posts again. ' +
      'The error alert fires first, so you would already know something is wrong.',
    '',
  ];
  return lines.join('\n');
}

// The Run Now path is generated once and persisted so rebuilds keep the same URL.
function loadRunPath(outDir) {
  const file = path.join(outDir, 'poller-run-path.txt');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^stc-poller-run-[0-9a-f]{16}$/.test(existing)) return existing;
    throw new Error('Unexpected contents in ' + file + ': ' + existing);
  }
  const fresh = 'stc-poller-run-' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(file, fresh + '\n');
  return fresh;
}

function main(outDir = path.join(__dirname, 'out'), inDir = path.join(__dirname, 'in')) {
  fs.mkdirSync(outDir, { recursive: true });
  const runPath = loadRunPath(outDir);
  const write = (name, wf) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(wf, null, 2) + '\n');
  write('error-alert.json', buildErrorAlert());
  write('poller.json', buildPoller({ runPath }));
  const written = ['error-alert.json', 'poller.json'];

  // The IG trigger is a transform of the live export (`n8n export:workflow` -> a one-element array).
  const liveFile = path.join(inDir, 'ig-trigger.live.json');
  if (fs.existsSync(liveFile)) {
    const exported = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
    const live = Array.isArray(exported) ? exported : [exported];
    if (live.length !== 1) throw new Error(liveFile + ': expected exactly one workflow, found ' + live.length);
    const ig = buildIgTrigger(live[0]);
    write('ig-trigger.json', ig);
    fs.writeFileSync(path.join(outDir, 'ig-trigger.diff.md'), buildIgDiffMarkdown(live[0], ig));
    written.push('ig-trigger.json', 'ig-trigger.diff.md');
  }
  return { outDir, runPath, written };
}

module.exports = { buildErrorAlert, buildPoller, buildIgTrigger, buildIgDiffMarkdown, unifiedDiff, inlineFns, main };

if (require.main === module) {
  const { outDir, runPath, written } = main();
  console.log('Wrote ' + outDir + '/{' + written.join(', ') + '} (Run Now path: ' + runPath + ')');
}
