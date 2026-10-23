// Dedupe rules for the Eventbrite poller fallback.
// Each export is a standalone function declaration (no closures, no require,
// no arrow functions) so build.js can inline it into an n8n Code node via fn.toString().

function cardKey(event) {
  if (event.is_series_parent) return String(event.id);
  return String(event.series_id || event.id);
}

function amIFirst(rows, myId, nowMs, staleMs) {
  var withId = rows.filter(function (r) { return r.id !== undefined && r.id !== null; });
  if (withId.some(function (r) { return r.outcome === 'carded'; })) return false;
  var live = withId.filter(function (r) {
    return r.outcome === 'claimed' && nowMs - Date.parse(r.createdAt) < staleMs;
  });
  if (live.length === 0) return false;
  var minId = Math.min.apply(null, live.map(function (r) { return r.id; }));
  return myId === minId;
}

function findExistingCard(messages, eventId) {
  var target = String(eventId);
  for (var i = 0; i < messages.length; i++) {
    var blocks = messages[i].blocks || [];
    for (var j = 0; j < blocks.length; j++) {
      if (blocks[j].block_id !== 'approval_actions') continue;
      var els = blocks[j].elements || [];
      for (var k = 0; k < els.length; k++) {
        if (String(els[k].value) === target) return messages[i].ts;
      }
    }
  }
  return null;
}

module.exports = { cardKey: cardKey, amIFirst: amIFirst, findExistingCard: findExistingCard };
