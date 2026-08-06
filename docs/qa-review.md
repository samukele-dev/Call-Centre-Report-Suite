# QA Review — architecture, known issue, and resolution

For the system-wide capabilities snapshot, see
[`system-overview.md`](./system-overview.md); for the full change history
across the whole project, see [`CHANGELOG.md`](./CHANGELOG.md).

## What this page is

`/qa` (frontend: `src/pages/QA.js`, backend: `dashboard/qa_source.py` +
`QARecordsView`/`QAOutcomesView`/`QASyncView` in `dashboard/views.py`) lets QA
staff browse real call records — Date, Customer, Phone Number, Agent Name,
Campaign, Outcome, Recording — across one or more campaigns at once, with
date-range and outcome filters.

It does not read from the locally-synced `ProcessedData` table that the
Campaign upload/sync pipeline populates, and it does not share query code
with `dashboard/external_source.py`. This was a deliberate requirement, not a
style choice — two things QA needs aren't available in the local sync at
all:

1. **Full outcome names.** The Campaign sync pipeline deliberately uses the
   outcome *abbreviation* (`oo.shortcode`, e.g. `"A"`) because that's what
   `OutcomeDescription`/Outcome Sets are keyed on for report generation. QA
   wants the human-readable name (`oo.name`, e.g. `"Answering Machine"`)
   directly, with no lookup step.
2. **Call recordings.** Never synced or stored locally at all.

## Schema notes (source DB, `cxm`/`cnx_users` schemas)

- `cxm.cd_voice_meta` is **1 row per contact**, not a per-interaction log —
  it tracks each contact's *current* state (`last_outcome_id`,
  `last_user_id`, `last_called`, `last_interaction_id`, etc.), overwritten
  on every call. Confirmed via `cd_voice_meta_pkey` being a unique index on
  `contact_data_id` alone.
- `cxm.cd_voice_meta.last_interaction_id → cxm.recording_log.interaction_id`
  is the verified link from a contact to its most recent call's recording.
  `recording_log.recording` is a filename/key (e.g.
  `EliJoa_+27832188846_20260727154814_8687c2`), **not a URL** — there's a
  storage layer behind it (`server_fqdn`/`archived_key`/`waveform_key`) this
  app has no visibility into, so QA shows the reference and duration, not a
  playable link or audio player. No audio is ever pulled or served — data
  (filename + duration) only.

## Two real bugs found and fixed while building this

### 1. Un-dispositioned leads were silently dropped (fixed)

The original query (and `external_source.py`'s campaign-sync query) used
`INNER JOIN` for `cd_voice_meta`/`outcomes`/`users`. Verified empirically
across three campaigns:

| Campaign | Total contacts | Has cvm row but no outcome |
|---|---|---|
| Hollard Edgars | 161,063 | 20,710 (12.9%) |
| Vodacom Funeral Upsell | 118,302 | 0 |
| Vodacom Life | 212,217 | 52,137 (24.6%) |

An `INNER JOIN` on `outcomes` requires `last_outcome_id` to be non-null —
excluding everyone still sitting un-dispositioned in the dialer queue from
every report's "Total Leads". Fixed by switching to `LEFT JOIN` for
`cd_voice_meta`/`outcomes`/`users` in `external_source.py`'s
`SOURCE_QUERY_TEMPLATE` (the Campaign sync path) and in the QA pull query
below. Un-dispositioned rows now come through with `last_outcome='UNKNOWN'`
(Campaign path) or a null outcome (QA path), and still count toward totals.

### 2. QA outcome filter took 10+ minutes and never finished (fixed)

Original outcome-options query derived the filter list via `SELECT DISTINCT
oo.name` across `contact_data → cd_voice_meta → outcomes`, scanning the full
interaction history with no date bound. On a single campaign this ran for
over 10 minutes without completing.

This is now moot for the live path (see architecture change below) — the QA
outcome filter reads distinct values out of the local `QACallRecord` cache,
which is small and indexed. Confirmed: near-instant for campaigns with
100k+ cached rows.

## Root cause of the slowness, and why the fix changed direction

Measured against the **live** source DB: **373 seconds** for a single
campaign, 7-day date range, 16,512 matching rows. Root cause confirmed via
`EXPLAIN`, not guessed: **there is no index on `cxm.cd_voice_meta` with
`last_called` as a leading column.** The only index touching it is
`(contact_data_id, last_called) WHERE last_called IS NOT NULL` — usable only
for "look up the date for one known contact", not for "find every contact
called in this date range". Because `cd_voice_meta` has ~13.5 million rows,
it dominates the whole query regardless of join order (two different join
orderings in `EXPLAIN` produced the same underlying cost).

The real fix — `CREATE INDEX CONCURRENTLY cd_voice_meta_last_called_idx ON
cxm.cd_voice_meta (last_called) WHERE last_called IS NOT NULL;` — needs
`CREATE` privilege on the `cxm` schema. Confirmed blocked:
`has_schema_privilege(current_user, 'cxm', 'CREATE')` returns `false` for
the credentials this app connects with. That's a DBA-only change on
someone else's database, with no ETA. Rather than wait on it, the QA
architecture was changed to not need it.

## Current architecture: local cache, synced on demand

`dashboard/qa_source.py`'s `sync_campaign_qa_cache(campaign)` pulls a
campaign's **full current state, no date filter**, and upserts it into the
local `QACallRecord` model (see `dashboard/models.py`) keyed on
`(campaign, contact_id)`. A full, unfiltered pull is the same query shape
the Campaign sync pipeline already runs successfully against 100k+ contact
campaigns — proven fast because it isn't filtering `last_called` at all, so
the missing index never comes into play.

Once synced, every QA page request (date range, outcome filter, pagination,
search) queries `QACallRecord` — a local table this app fully controls,
indexed on `(campaign, call_date)` and `(campaign, outcome)`. Sync is
triggered on demand (`POST /api/qa/sync/` with `campaign_ids`, wired to a
"Sync Now" button in the UI) rather than automatically on every page load,
since a first sync of a large campaign takes real time (see below) —
re-syncing is safe and idempotent (upsert), so it can be run again any time
to pick up new calls.

Endpoints (`dashboard/urls.py`):
- `POST /api/qa/sync/` — `{campaign_ids: [...]}` → per-campaign
  `records_synced` / `synced_at`, or an `error` string per campaign that
  failed (e.g. missing `cd_campaign_id`).
- `GET /api/qa/records/` — `campaign_ids`, `start_date`, `end_date`,
  `outcomes`, `search`, `page`, `page_size` → `{count, results, page,
  num_pages, last_synced}`. `last_synced` is the most recent `synced_at`
  across the matched rows, so the UI can show a "data as of" freshness
  indicator (or prompt to sync if null — no cached rows yet).
- `GET /api/qa/outcomes/` — `campaign_ids` → array of distinct outcome
  names present in the local cache for those campaigns.

### Verified performance (real production data, not estimated)

- Sync, small campaign (Absa Vehicle and Asset Finance Ai, 75 contacts):
  **2.6s**.
- Sync, large campaign (Hollard Edgars, 161,071 contacts): **75s** — a
  one-time (or occasional refresh) cost, not per-request.
- The exact query that took 373s live — same campaign, same 7-day date
  filter, same 16,512-row result — served from the local cache: **0.4s**.
  Confirmed identical data (`count: 16512`).

### Bug found and fixed: a large sync locked out the entire app ("database is locked")

`QACallRecord.objects.bulk_create(records, batch_size=500, update_conflicts=True, ...)`
looks like it inserts in 500-row batches, but Django wraps **every** batch
from a single `bulk_create()` call in one `transaction.atomic()` block
regardless of `batch_size` — so a 161k-row sync held one continuous
exclusive write lock on the SQLite file for its full ~75s duration. Every
other request in the app (campaigns list, outcome sets, login) tried to open
a new connection during that window, hit SQLite's default 5s busy-timeout,
and failed with `OperationalError: database is locked` — including QA's own
outcome/record fetches, which fail "gracefully" client-side (empty
list/results), so the visible symptom was outcomes silently looking
incomplete, not an obvious error.

Fixed three ways in `qa_source.py` / `backend/settings.py`:
1. **Chunked writes.** `sync_campaign_qa_cache()` now calls `bulk_create()`
   once per 1,000-row chunk instead of once for the whole campaign, so each
   transaction — and the lock it holds — lasts a fraction of a second
   instead of the full sync duration.
2. **WAL journal mode**, enabled once on `db.sqlite3` (`PRAGMA
   journal_mode=WAL`). This is the real fix for the read-vs-write
   collision: in WAL mode, reads never block on a writer at all, so normal
   page loads are unaffected by a sync running concurrently regardless of
   how long it takes.
3. **`DATABASES['default']['OPTIONS']['timeout'] = 30`** in `settings.py` as
   a safety net for writer-vs-writer contention (e.g. two syncs kicked off
   at once), raised from SQLite's 5s default.

Verified under real load: ran a 161k-row sync while firing 15 concurrent
requests against `/api/campaigns/` and `/api/outcome-sets/` every second —
all returned 200 (previously this reliably produced lock errors). Also
confirmed outcome completeness post-fix: a 298k-row campaign (Clientele
Perks) returned 62 distinct outcome names with no gaps.

### Multi-campaign sync: one request per campaign, not one giant request

`QASyncView.post()` still accepts a list of `campaign_ids` and syncs
whichever ones it's given — that part didn't change. What changed is who
does the looping. It originally allowed the frontend to pass every selected
campaign in a single `POST`, which the view then processed sequentially
server-side inside one HTTP request; for a broad selection (e.g. "select
all" across ~75 campaigns, several at 100k-300k+ rows) that meant a single
blocking request that could run for hours with no progress feedback at all
in the UI — not broken, just opaque and easy to mistake for hung (this
happened in practice; see the sync-time investigation above).

There is no background task queue in this app (consistent with the rest of
the codebase; see root `CLAUDE.md`), so the fix is on the frontend:
`src/pages/QA.js`'s `handleSync()` now loops over `selectedCampaignIds`
itself and calls `DashboardService.syncQACache([campaignId], signal)`
**once per campaign, sequentially**, awaiting each before starting the
next. This gets three things the single-request version couldn't:

- **Live progress** — "Syncing 3 of 12 — Absa Insurance" plus a thin
  progress bar, updated between every campaign.
- **Incremental results** — records/outcomes are refetched after each
  campaign finishes, so already-synced campaigns show up in QA Review
  immediately rather than waiting for the whole run.
- **Cancellation** — a "Stop" button aborts the in-flight campaign's
  request (via `AbortController`, wired through `syncQACache`'s `signal`
  param in `dashboardService.js`) and skips the rest. Nothing already
  synced is lost — each campaign (and each 1,000-row chunk within it, see
  above) commits independently.

Observed real-world rate: roughly 1-5 minutes per campaign depending on
size. Syncing all ~75 campaigns is still a genuinely long operation — this
change makes that visible and interruptible, it doesn't make the underlying
per-campaign pull any faster. Recommended usage is still to sync only the
campaigns you're actively reviewing.

### Bug found and fixed: duplicate concurrent syncs for the same campaign

A single campaign's sync (Hollard Edgars, campaign 28, normally ~75s) was
observed still running after 5+ minutes. `pg_stat_activity` on the source
DB showed the cause directly: **three, then four, identical copies of
`QA_FULL_PULL_QUERY` running concurrently** for the same campaign, all
stuck on `DataFileRead`, none actually deadlocked — just competing with
each other for the same disk I/O and making all of them far slower than
one alone. Nothing in the code prevented two sync requests for the same
campaign from running at once — a double-click, a stale/retried request,
or the same campaign synced from two browser tabs would each independently
kick off the full external-DB pull.

Fixed on both ends:
- **Backend** (`qa_source.py`): a process-local `set()` + `threading.Lock`
  tracks which campaign IDs are currently syncing. A second sync request
  for a campaign already in progress fails fast with "A sync for '{campaign}'
  is already running" instead of starting a competing query — surfaced
  through the existing per-campaign `error` field in `QASyncView`'s
  response, no new API shape needed.
- **Frontend** (`QA.js`): `handleSync()` now checks and sets a `useRef`
  flag synchronously, before any `await`. The previous guard only checked
  the `syncing` state variable, which is not guaranteed to have re-rendered
  between two click events fired close together (React batches state
  updates) — a ref is set immediately, in the same tick, so it can't race.

### Frontend (`src/pages/QA.js`)

- Campaign and Outcome filters are multi-select dropdowns with a
  "Select all / Deselect all" toggle and a **search box inside the
  dropdown** to filter the visible checkbox list by typing, instead of
  scrolling through all campaigns/outcomes.
- A "Sync Now" button sits above the results table alongside a freshness
  indicator — "Data last synced X ago" (or a prompt to sync if nothing's
  cached yet for the current selection). While syncing it's replaced by a
  live per-campaign progress line, a small progress bar, and a "Stop"
  button.
- Pagination is real (exact total count, page numbers), matching the
  pattern used on Campaigns.js — restored now that local queries are cheap
  enough to compute an exact count on every request.

## Status

Resolved. The missing-index limitation on the source DB no longer affects
QA page performance day to day — it would only matter if `sync_campaign_qa_cache`
were changed back to a live, date-filtered query. If a DBA ever adds the
index, it's a nice-to-have (faster syncs of very large campaigns), not a
blocker for anything currently built. The SQLite lock contention bug is
fixed and verified under real load, and multi-campaign syncs now run
per-campaign with visible progress and a way to stop early. Syncing a very
broad campaign selection is still a genuinely long operation — that's
inherent to pulling real data with no background task queue, not a bug —
so the recommended usage remains: sync only the campaigns you're actively
reviewing.
