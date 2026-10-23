# STC n8n Automation — Runbook

Operational reference for the Strong Towns Chicago event-publishing automation. Last updated: 2026-05-25.

For full design context, see [Plan 02](https://github.com/ZombieHunter386/stc-n8n-workflows/blob/main/) (in author's Claude project; not in this repo).

---

## What this system does

| Pipeline | Trigger | Result |
|---|---|---|
| **GCal Sync** | Eventbrite event published / edited / unpublished | Google Calendar entry auto-created / updated / deleted on `strongtownschicago@gmail.com` calendar within ~30 sec |
| **IG Approval (Slack)** | Eventbrite event published | Slack approval card in `#events-approval` with LLM-drafted caption + topic-channel dropdown |
| **Approve fan-out** | Click "Approve" button in Slack | Posts to chosen topic channel + `#events-calendar` announcement + IG-staged thread reply for manual posting |
| **Edit flow** | Click "Edit" button + reply in thread + react ✅ | Replaces caption with thread reply, runs same fan-out |
| **Website events** | (No automation — Squarespace Calendar Block subscribes to GCal) | Calendar auto-populates from Phase 2's GCal sync |

---

## Infrastructure

| Component | Location |
|---|---|
| n8n instance | `https://automate.strongtownschicago.org` (n8n owner login required) |
| Server | DigitalOcean droplet `stc-n8n` at `138.197.27.1`, NYC3, $6/mo + $1.20/mo backups |
| Stack files | `~/n8n-stack/` on the droplet (Docker Compose) |
| n8n data | Docker volume `n8n-stack_n8n_data` (SQLite DB + binary uploads) |
| Encryption key | `N8N_ENCRYPTION_KEY` env var in `~/n8n-stack/docker-compose.yml` AND in Hunter's password manager. **IRREPLACEABLE — losing both copies = total credential loss.** |
| Backup repo (this) | `github.com/ZombieHunter386/stc-n8n-workflows` — nightly cron `~/bin/backup-n8n.sh` runs at 06:00 UTC |
| DNS | Squarespace DNS for `strongtownschicago.org`; subdomain `automate.strongtownschicago.org` A record → 138.197.27.1 |

## How to SSH in

```bash
ssh stc@138.197.27.1
```

SSH key is in Hunter's `~/.ssh/id_ed25519` (passphrase-protected, in Keychain via `ssh-add --apple-use-keychain`). The droplet has key-only auth, no password.

For Claude Code sessions: Claude can SSH from the Bash tool because the launchd SSH agent has the key loaded — see [memory: ssh-agent-keychain-pattern].

---

## Common operations

### Restart the n8n container (zero data loss)

```bash
cd ~/n8n-stack
docker compose restart n8n
# n8n takes ~15-30 sec to fully boot. Verify with:
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://automate.strongtownschicago.org/
# Should return 200 once ready.
```

### View live logs

```bash
cd ~/n8n-stack
docker compose logs -f n8n          # follow mode (Ctrl+C to exit)
docker compose logs --tail=50 n8n   # last 50 lines, no follow
docker compose logs --since=10m n8n # last 10 minutes
```

### Stop / start the stack

```bash
cd ~/n8n-stack
docker compose stop n8n     # stops n8n; webhooks return errors during downtime
docker compose start n8n    # starts back up
docker compose up -d n8n    # use this after editing docker-compose.yml (recreates container)
```

### Update n8n version

Pinned at `n8nio/n8n:2.21.7` — edit the `image:` line in `docker-compose.yml`, then `docker compose pull n8n && docker compose up -d n8n`. **Test on a non-prod time** — n8n upgrades sometimes break workflows. The backup repo has snapshots if you need to roll back.

---

## Disaster recovery

### Restore from DigitalOcean snapshot

DO automatic backups run weekly (Sunday morning UTC). Manual snapshots can be taken anytime via the DO dashboard.

1. DO dashboard → Droplets → stc-n8n → Snapshots
2. Choose snapshot → **Restore Droplet** (replaces current state) OR **Create new Droplet from snapshot** (preserve current, spin up parallel)
3. If new droplet: update DNS A record at Squarespace from old IP to new IP, wait for DNS propagation (~15 min)

### Restore workflows from the GitHub backup repo

Use case: workflows accidentally deleted from n8n UI, or DB corruption that didn't trigger DO snapshot restore.

```bash
ssh stc@138.197.27.1
cd ~/n8n-backups
git pull   # ensure local is current
docker cp workflows/all.json n8n-stack-n8n-1:/tmp/all.json
docker compose -f ~/n8n-stack/docker-compose.yml exec -T n8n \
  n8n import:workflow --input=/tmp/all.json --projectId=4WonX20XyNi7Nvwj
docker compose -f ~/n8n-stack/docker-compose.yml restart n8n
```

Important: imported workflows come in deactivated. After import, activate via:

```bash
for id in EyMZ4dD9f7NMSB2J x91bE62LWVaIe43D wYuTZFSdH048EK7H fjXs6fdKTqGXkVpd; do
  docker compose -f ~/n8n-stack/docker-compose.yml exec -T n8n \
    n8n update:workflow --id=$id --active=true
done
docker compose -f ~/n8n-stack/docker-compose.yml restart n8n
```

### Restore credentials (requires N8N_ENCRYPTION_KEY)

Credentials are encrypted with `N8N_ENCRYPTION_KEY`. The encrypted blobs are in `workflows/credentials.json`. To restore:

1. **Verify the encryption key matches** the SHA256 in `workflows/encryption-key.sha256`:
   ```bash
   echo -n "<N8N_ENCRYPTION_KEY>" | sha256sum
   # Compare to: cat workflows/encryption-key.sha256
   ```
   If they don't match, the credentials are encrypted with a different key and CANNOT be decrypted. Re-create from source values stored in Hunter's password manager.

2. If the key matches, import:
   ```bash
   docker cp workflows/credentials.json n8n-stack-n8n-1:/tmp/credentials.json
   docker compose -f ~/n8n-stack/docker-compose.yml exec -T n8n \
     n8n import:credentials --input=/tmp/credentials.json --projectId=4WonX20XyNi7Nvwj
   docker compose -f ~/n8n-stack/docker-compose.yml restart n8n
   ```

### SQLite DB corruption recovery (learned 2026-05-25)

If `docker compose logs n8n` shows `SQLITE_CORRUPT: database disk image is malformed`:

This usually happens after modifying the SQLite DB while WAL files (`database.sqlite-wal`, `database.sqlite-shm`) are stale. Recovery:

```bash
ssh stc@138.197.27.1
cd ~/n8n-stack && docker compose stop n8n

# Copy current state to host for inspection
mkdir -p /tmp/recovery
docker cp n8n-stack-n8n-1:/home/node/.n8n/database.sqlite /tmp/recovery/main.sqlite

# Test if main DB is intact (without WAL replay)
# Install sqlite3 locally on your Mac if not on droplet
sqlite3 /tmp/recovery/main.sqlite "PRAGMA integrity_check;"
# If "ok" → main DB is fine, the WAL is the problem

# If integrity is OK, remove stale WAL via one-shot alpine container
docker cp /tmp/recovery/main.sqlite n8n-stack-n8n-1:/home/node/.n8n/database.sqlite
docker run --rm -v n8n-stack_n8n_data:/data alpine \
  rm -f /data/database.sqlite-wal /data/database.sqlite-shm

# Restart
docker compose up -d n8n
```

If integrity check is NOT ok, run SQLite's `.recover` command to extract data from corrupt pages:

```bash
sqlite3 /tmp/recovery/main.sqlite ".recover" > /tmp/recovery/recovered.sql
sqlite3 /tmp/recovery/restored.sqlite < /tmp/recovery/recovered.sql
# Inspect /tmp/recovery/restored.sqlite, then copy back if it looks complete
```

### Partial failure recovery

If GCal sync succeeded but IG flow failed (or vice versa) for a specific event:

- Re-publish the Eventbrite event (unpublish + republish triggers both webhooks again)
- OR retry via Eventbrite dashboard → Account Settings → Apps → Webhooks → click failing webhook → resend
- Both workflows are idempotent: GCal uses deterministic event IDs (`eventbrite{id}`), so no duplicates. IG approval card will repost — that's a real duplicate but easy to mark as duplicate in Slack.

---

## Eventbrite poller fallback (added 2026-10-23)

**Why it exists:** Eventbrite's webhook delivery for STC has stalled several times (Aug 2026 ~2h; 2026-10-16 → 10-20, four days). While stalled, new events never reached Google Calendar or got a Slack approval card, and when the queue finally drained it posted a *duplicate* card. The fallback makes both paths self-healing and makes duplicate cards impossible.

**Pieces:**
- **STC Eventbrite Poller (fallback)** (`stcEbPoller00001`): every 15 min it lists STC's live Eventbrite events, then:
  - re-sends an event to the GCal webhook if its Google Calendar entry is missing, cancelled, or older than the event's last Eventbrite change. This is safe because the GCal path is idempotent;
  - re-sends it to the IG webhook if the event went live more than 10 min ago and has no `carded` row. The 10-minute grace lets the normal webhook win when Eventbrite is healthy.
- **STC IG — Trigger** (`x91bE62LWVaIe43D`): before the AI draft it writes a *claim* row to the `stc_event_cards` Data Table. Only the earliest fresh claim continues, and it first checks the last 90 days of #events-approval for an existing card. Duplicates are recorded as `duplicate` and stop. Cards the poller rescued carry a grey ":satellite_antenna: Picked up by the fallback poller" line. **If you see that line, Eventbrite's webhooks are stalling.**
- **STC Error Alert** (`stcErrAlert00001`): any failure in the poller or the IG trigger posts to #events-approval with a link to the failed execution.
- **Source + tests:** `fallback/` in this repo. `node --test` runs the tests; `node build.js` regenerates the workflow JSON. The design spec is in Hunter's `~/Claude/docs/superpowers/specs/2026-10-16-stc-eventbrite-poller-fallback-design.md`.

**Common operations:**
- **Force a fresh approval card for an event:** in n8n → Data tables → `stc_event_cards`, delete that event's rows (match on `card_key` / `event_id`). Also delete the old card in #events-approval, because the trigger checks Slack for an existing card before posting. The next poll (≤15 min) posts a new card.
- **Run a poll right now:** `curl -X POST https://automate.strongtownschicago.org/webhook/stc-poller-run-1f1009ee31bd21ec`. Safe to run any time, because polls are idempotent.
- **Pause the fallback:** in the n8n UI, deactivate "STC Eventbrite Poller (fallback)". The IG trigger keeps deduping on its own.
- **Never delete the `__seeded__` row.** It tells the poller the table is already initialised. If the table is lost (e.g. a restore from this repo, which does not back up Data Table rows), the first poll recreates it and marks every currently-live event as carded without posting cards. It then posts a "seeded" note listing those events.

**Alerts you may see:**
- **"Poller: … still out of sync with Google Calendar after 3 runs":** the GCal workflow or the Google credential is failing. Check its executions.
- **"Poller: … went live over an hour ago and still has no approval card":** the IG trigger is failing. Check its executions.
- **":rotating_light: n8n workflow … failed":** follow the execution link. If Eventbrite's API or the Data Table is down, this repeats every 15 min until it is fixed.

**Known limitation:** if Slack accepts a card but recording it fails 3 times (or the post times out), *and* someone approves the card before the retry (~30–45 min later), a second card can appear. The error alert fires first.

**Deploy/redeploy:**
1. `node build.js`, then copy `out/*.json` into the container.
2. `n8n import:workflow --input=… --projectId=4WonX20XyNi7Nvwj` → `n8n publish:workflow --id=…` → `docker compose restart n8n`. The CLI changes only take effect after a restart.
3. Always deploy the poller before the IG trigger on a fresh instance, so the table exists and is seeded first.

---

## Credential map

What's in n8n and what each credential is used for:

| Credential | Type | Used by | Source for re-auth |
|---|---|---|---|
| Eventbrite (STC) | eventbriteApi | Native Eventbrite node (currently unused — kept for future) | Hunter's password manager (private token) |
| Eventbrite Bearer (STC) | httpHeaderAuth | All Eventbrite HTTP Request nodes (Phase 2 + Phase 3 trigger) | Same private token, prefixed `Bearer ` |
| Slack (STC Automation) | slackApi | All Slack HTTP Request nodes (Phase 3 action + reaction); also has signing secret field | Slack app `STC Automation` at api.slack.com/apps; bot token starts `xoxb-` |
| Anthropic (STC) | anthropicApi | LLM draft node in Phase 3 trigger workflow | console.anthropic.com (separate billing from Claude Max plan) |
| Google Calendar (STC) | googleCalendarOAuth2Api | GCal HTTP nodes in Phase 2 (PUT, POST, DELETE) | Google Cloud OAuth client `n8n` under project `stc-n8n`, signed in as `hunter@strongtownschicago.org` (NOT personal Gmail — critical for refresh token expiry avoidance) |

**Buffer credential is DEFERRED** — Phase 3 currently stubs IG publishing (posts to Slack thread for manual paste instead). To activate: see "swap IG stub for real publisher" below.

---

## Environment variables (in `~/n8n-stack/docker-compose.yml`)

| Var | Purpose |
|---|---|
| `N8N_HOST` | Public hostname; must match Caddy config |
| `N8N_PROTOCOL=https`, `N8N_PORT=5678` | Internal listening config |
| `WEBHOOK_URL` | Base URL for webhook URLs n8n generates |
| `N8N_ENCRYPTION_KEY` | Encrypts credentials at rest. **IRREPLACEABLE.** Also stored in password manager. |
| `GENERIC_TIMEZONE=America/Chicago`, `TZ=America/Chicago` | Date/time handling |
| `SLACK_SIGNING_SECRET` | For HMAC verification of Slack callbacks (currently unused — verification is BYPASSED; see open items) |
| `APPROVAL_CHANNEL_ID=C0B60JLNQ20` | `#events-approval` channel ID, used by Reaction workflow's filter |
| `ANNOUNCEMENT_CHANNEL_ID=C091KDN758X` | `#events-calendar` channel ID |
| `HUNTER_SLACK_USER_ID=U0B5ZNEKKPG` | **NOTE: This value is wrong** — it's the bot's user ID, not Hunter's. Unused currently. Replace with real ID or delete the line when convenient. |
| `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | Whitelists `require('crypto')` in Code nodes (needed when Slack signature verification is re-enabled) |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | Allows `$env.X` reads in Code nodes (used by Reaction workflow's filter) |

---

## Webhook URLs (record these in password manager — they're effectively auth)

| Webhook | URL | Subscribed actions |
|---|---|---|
| Eventbrite → GCal | `https://automate.strongtownschicago.org/webhook/eventbrite-gcal-fd60ecbd7c0e` | `event.published`, `event.updated`, `event.unpublished` |
| Eventbrite → IG approval | `https://automate.strongtownschicago.org/webhook/eventbrite-ig-45a751157392` | `event.published` only |
| Slack Interactivity | `https://automate.strongtownschicago.org/webhook/slack-interactivity` | Button clicks (Approve/Edit) |
| Slack Events | `https://automate.strongtownschicago.org/webhook/slack-events` | `reaction_added`, `message.groups` |

The random suffixes (`fd60ecbd7c0e`, `45a751157392`) are part of the URL-secrecy auth model. If they leak, regenerate via `openssl rand -hex 6`, update the workflow's webhook node, and re-register the new URL with Eventbrite.

---

## Open items (as of 2026-05-25)

### 1. Slack signature verification bypassed

Workflows `STC IG — Action` and `STC IG — Reaction` have their "Verify Slack Signature" Code nodes replaced with a TODO-marked pass-through. Anyone who knows the Slack webhook URLs (`slack-interactivity` and `slack-events`) could fire fake payloads.

**Bounded blast radius:** unauthorized bot messages only. No money, no IG (since IG is stubbed). Worst case = Slack channel spam from the bot.

**Re-enable when:** any high-stakes node is added (real Buffer/IG publish, financial actions, data deletion).

**Root cause of bypass:** n8n's webhook v2 with `rawBody: true` doesn't expose the original HTTP body bytes. Reconstructing form-encoded body via `encodeURIComponent` produces different bytes than Slack signed (likely `%20` vs `+` for spaces).

**Fix approaches to try:**
- Use URL constructor's `searchParams` to match form-encoding exactly: `new URL('http://x'); u.searchParams.set('payload', body.payload); rawBody = u.search.slice(1);`
- Investigate n8n options `binaryData: true` or `rawBody: true` field aliases
- Implement custom form-encoder that matches `application/x-www-form-urlencoded` spec

### 2. IG auto-publishing deferred

Currently when Approve fires, the workflow posts a thread reply on the approval card with the pre-formatted caption + image URL — Hunter manually pastes into IG (~30 sec/event).

**Why deferred:** Buffer's Meta OAuth flow returns "400 Session Invalid" for STC's account despite FB Page existing, IG (Creator) linked via Meta Business Suite, Hunter being Page admin. Buffer's OAuth migration to Meta's newer "Instagram Login for Business" API has STC's account in a broken half-state.

**To swap stub for real publisher:** modify the "IG Stub (Thread Reply)" node in the Action workflow and the "IG Stub (Reaction)" node in the Reaction workflow. Both currently POST to Slack `chat.postMessage`. Replace with whichever IG-publishing API ends up working (Buffer, Later, direct Meta Graph API, etc.). The pre-formatted caption is in `$json.caption_with_hashtags`; the image URL needs to be fetched from Eventbrite (currently truncated out of the card).

### 3. Bus factor

Every credential is tied to Hunter personally: DigitalOcean, GitHub backup repo (under `ZombieHunter386`), Squarespace DNS, the encryption key, n8n owner, Slack app admin, FB Page admin, Google Cloud OAuth client, Eventbrite organizer admin. If Hunter is unreachable, no one can re-auth or recover.

**Mitigation path** (parking lot):
- Migrate backup repo to `strongtownschicago` GitHub org (transfer + `git remote set-url` on droplet; deploy keys survive)
- Add second admin to Slack app, Google Cloud project, FB Page, Eventbrite organizer
- Document where the encryption key lives in password manager so a co-owner can retrieve it on incident
- Service-account migration for Google Calendar credential (eliminates token-tied-to-Hunter risk)

---

## Contact

- Hunter Heyman — `hsheyman@gmail.com` (primary admin, all credentials)
- STC contact email — `hello@strongtownschicago.org` or `info@strongtownschicago.org` (whichever STC uses)

---

## Change log

- **2026-05-24** Plan 01 complete — droplet, n8n, Caddy, backup pipeline live
- **2026-05-25** Plan 02 — Phase 2 (GCal sync) + Phase 3 (IG approval with IG stub) + Phase 5 (Squarespace) shipped. Runbook added.
- **2026-10-23** Eventbrite poller fallback + IG-trigger dedupe + error alert shipped (see "Eventbrite poller fallback"). Source in `fallback/`.
