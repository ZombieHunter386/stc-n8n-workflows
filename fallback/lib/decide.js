// Poller decision for the Eventbrite fallback. Pure: no I/O, the clock is passed in.
// decide is a standalone function declaration with every constant inside its body,
// so build.js can inline it (plus cardKey from ./claims) into an n8n Code node via fn.toString().

const { cardKey } = require('./claims');

function decide(input) {
  var IG_GRACE_MS = 10 * 60 * 1000;
  var STALE_CLAIM_MS = 30 * 60 * 1000;
  var IG_STUCK_MS = 60 * 60 * 1000;
  var GCAL_STUCK_RUNS = 3;
  var SEED_MARKER = '__seeded__';
  var GCAL_URL = 'https://automate.strongtownschicago.org/webhook/eventbrite-gcal-fd60ecbd7c0e';
  var IG_URL = 'https://automate.strongtownschicago.org/webhook/eventbrite-ig-45a751157392';

  var events = input.events || [];
  var gcal = input.gcal || [];
  var nowMs = input.nowMs;
  var prev = input.state || {};
  var prevStreak = prev.gcalStreak || {};
  var prevAlerted = prev.alerted || {};

  // n8n's alwaysOutputData emits one empty {} item for an empty table; only real rows have an id.
  var rows = (input.rows || []).filter(function (r) { return r && r.id !== undefined && r.id !== null; });

  var seed = !rows.some(function (r) { return r.card_key === SEED_MARKER; });
  var actions = [];
  var slack = [];
  var gcalFires = []; // emitted after IG fires: Fire Webhook stops at the first throw, so GCal must not block IG
  var streak = {};
  var alerted = {};
  var liveIds = {};
  var liveKeys = {};

  function title(e) { return (e.name && e.name.text) || String(e.id); }
  function fireBody(id) {
    return { api_url: 'https://www.eventbriteapi.com/v3/events/' + id + '/', config: { action: 'event.published' }, source: 'poller' };
  }
  // Missing timestamps (published, then created) are treated as old.
  function ageMs(ts) {
    var t = Date.parse(ts);
    return isNaN(t) ? Infinity : nowMs - t;
  }

  events.forEach(function (e) {
    liveIds[String(e.id)] = true;
    liveKeys[cardKey(e)] = true;
  });

  // Carry over alert keys only for events that are still live; anything else has resolved.
  Object.keys(prevAlerted).forEach(function (k) {
    if (!prevAlerted[k]) return;
    if (k.indexOf('gcal:') === 0 && liveIds[k.slice(5)]) alerted[k] = true;
    if (k.indexOf('ig:') === 0 && liveKeys[k.slice(3)]) alerted[k] = true;
  });

  // Seed: mark every live event as carded so the IG path never re-cards history.
  if (seed) {
    events.forEach(function (e) {
      actions.push({ kind: 'seed_row', card_key: cardKey(e), event_id: String(e.id), source: 'seed', outcome: 'carded' });
    });
    actions.push({ kind: 'seed_row', card_key: SEED_MARKER, event_id: '', source: 'seed', outcome: 'carded' });
    slack.push('Poller fallback seeded ' + events.length + ' already-live event(s) as carded' +
      (events.length ? ': ' + events.map(title).join(', ') : '') + '. No Instagram cards were fired for them.');
  }

  // GCal: Google Calendar is the source of truth; the GCal workflow is idempotent, so no grace period.
  events.forEach(function (e, i) {
    if (e.is_series_parent) return;
    var id = String(e.id);
    var key = 'gcal:' + id;
    var g = gcal[i] || {};
    var body = g.body || {};
    var outOfSync = false;
    if (g.statusCode === 404) {
      gcalFires.push({ kind: 'fire', target: 'gcal', event_id: id, url: GCAL_URL, body: fireBody(id) });
      outOfSync = true;
    } else if (g.statusCode === 200) {
      if (body.status === 'cancelled' || Date.parse(body.updated) < Date.parse(e.changed)) {
        gcalFires.push({ kind: 'fire', target: 'gcal', event_id: id, url: GCAL_URL, body: fireBody(id) });
        outOfSync = true;
      }
    } else {
      outOfSync = true; // unknown (401 expired OAuth, 5xx, missing): don't fire, but count it
    }

    if (!outOfSync) {
      delete alerted[key];
      return;
    }
    streak[id] = (prevStreak[id] || 0) + 1;
    if (streak[id] >= GCAL_STUCK_RUNS && !alerted[key]) {
      alerted[key] = true;
      slack.push(':warning: Poller: "' + title(e) + '" (' + id + ') still out of sync with Google Calendar after ' +
        streak[id] + ' runs. Check the GCal workflow / Google credential.');
    }
  });

  // IG: skipped entirely on a seed run (every live event was just marked carded).
  if (seed) {
    events.forEach(function (e) { delete alerted['ig:' + cardKey(e)]; });
  } else {
    var seen = {};
    events.forEach(function (e) {
      var ck = cardKey(e);
      if (seen[ck]) return; // series children share a card_key
      seen[ck] = true;
      var key = 'ig:' + ck;
      var mine = rows.filter(function (r) { return String(r.card_key) === ck; });
      var carded = mine.some(function (r) { return r.outcome === 'carded'; });
      if (carded) {
        delete alerted[key];
        return;
      }
      var inFlight = mine.some(function (r) {
        return r.outcome === 'claimed' && nowMs - Date.parse(r.createdAt) < STALE_CLAIM_MS;
      });
      var age = ageMs(e.published || e.created);
      if (!inFlight && age > IG_GRACE_MS) {
        actions.push({ kind: 'fire', target: 'ig', event_id: String(e.id), url: IG_URL, body: fireBody(String(e.id)) });
      }
      if (age > IG_STUCK_MS && !alerted[key]) {
        alerted[key] = true;
        slack.push(':warning: Poller: "' + title(e) + '" (' + e.id + ') went live over an hour ago and still has no approval card. Check the IG trigger.');
      }
    });
  }

  // Order: seed rows, IG fires (already in actions), GCal fires, slack.
  gcalFires.forEach(function (a) { actions.push(a); });
  slack.forEach(function (text) { actions.push({ kind: 'slack', text: text }); });
  return { seed: seed, actions: actions, state: { gcalStreak: streak, alerted: alerted } };
}

module.exports = { decide: decide };
