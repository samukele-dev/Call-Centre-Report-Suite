# Changelog — narrative history

Everything built and fixed in this project so far, grouped by theme rather
than by date (the repo has no commits yet — everything below happened
before the first commit). For what the system does *right now*, see
[`system-overview.md`](./system-overview.md). For QA Review specifically,
in much more depth, see [`qa-review.md`](./qa-review.md).

## Foundation: source-DB integration for the Campaign pipeline

Started as a request to automate pulling call-centre data per campaign from
the HeidiSQL-managed PostgreSQL source DB, instead of relying solely on
manual CSV upload.

- Added `dashboard/external_source.py`: `_get_connection()`,
  `SOURCE_QUERY_TEMPLATE`, `fetch_call_data_from_source()`,
  `fetch_source_lists()`, `sync_campaign_from_database()`. Credentials live
  in a gitignored `backend/.env` (`SOURCE_DB_HOST/PORT/NAME/USER/PASSWORD`).
- Added `Campaign.cd_campaign_id` (a source-DB campaign UUID — renamed from
  an earlier `cd_list_id` once it became clear a campaign spans *multiple*
  source lists, not one) so a sync pulls everything across all of a
  campaign's lists, not just one batch.
- Frontend: date-range picker and a batch (source list) selector with
  select-all wired into the upload flow.
- **Bug: outcome field held the full name, not the shortcode.** Fixed —
  `oo.shortcode AS last_outcome` — so it matches what
  `OutcomeDescription`/report generation key on, with the full name
  available separately as `Description`.
- **Bug: `INNER JOIN` silently dropped un-dispositioned leads.** Verified
  empirically: up to 24.6% of a campaign's contacts (Vodacom Life,
  212,217 total) had no outcome yet and were being excluded from every
  report's totals. Fixed by switching `cd_voice_meta`/`outcomes`/`users` to
  `LEFT JOIN` in `SOURCE_QUERY_TEMPLATE` — un-dispositioned rows now come
  through as `last_outcome='UNKNOWN'` and count toward totals. Verified
  end-to-end with a real sync (2,540/2,540 processed, 3 correctly-flagged
  `UNKNOWN` rows).
- **Recurring bug pattern: `uuid = text` in `ANY(%s)` comparisons.**
  psycopg2 adapts a Python string list as `text[]`; Postgres won't
  implicitly cast that to `uuid[]` inside `ANY()` the way it does for a
  scalar `=`. Fixed by casting the column side explicitly:
  `cl.id::text = ANY(%s)`.
- Repository location was consolidated: all work now lives under
  `C:\Users\Admin\Documents\personal\Call-Centre-Report-Suite` (the only
  git repo in the tree), not the `automated_report_system` nested copy.
- Windows console fix: `manage.py` now reconfigures stdout/stderr to UTF-8
  (`errors='replace'`) so emoji `print()` statements in management commands
  don't raise `UnicodeEncodeError` and mask the real error underneath them.

## Outcome Sets

Original `OutcomeDescriptions` page was a flat, ungrouped list. Rebuilt
around a proper model instead of a page-level grouping hack:

- Added `OutcomeSet` (name, description, created_by, timestamps) and
  `OutcomeDescription.outcome_set` FK; `Campaign.outcome_set` FK.
- Zero-regression migration: every existing campaign and outcome row was
  backfilled onto a default "Outcomes 1" set
  (`0005_default_outcome_set.py`, a data migration) — no manual re-mapping
  needed, no change to existing report output.
- `OutcomeSetViewSet` + serializer (`descriptions_count`, `campaigns_count`)
  added; `OutcomeDescriptionSerializer`/`CampaignSerializer` extended with
  `outcome_set`/`outcome_set_name`.
- Frontend: Outcomes page redesigned around outcome sets (tabs/grouping)
  instead of one flat list.

## UI/UX redesign pass (Campaigns, Upload, Dashboard, Outcomes)

A sequence of "this looks like a toy, make it professional" requests,
resolved with a shared, restrained visual language reused across pages
(`App.css`): `.campaign-list` (list rows, not cards), `.pagination-bar`
with exact counts and page numbers, `.section-card`, `.stat-tile-row`,
`.count-pill`, `.recent-chip`, `.outcome-set-tabs`, `.dashboard-overview-row`,
`.status-proportion-bar`, `.top-campaign-list`, `.upload-steps`, a
restrained 3-4 colour palette in place of the original "ugly green."

- **Campaigns page**: switched from cards to a list layout with pagination,
  search, and filters.
- **Upload page**: redesigned layout and colour scheme; batch selector
  gained a select-all toggle.
- **Dashboard page**: redesigned to a "professional, not toy-like" overview
  layout.
- **Outcomes page**: redesigned around Outcome Sets (see above).
- Fixed a Chart.js regression along the way: `CampaignDetail.js`'s doughnut
  chart broke ("arc" is not a registered element) once `Dashboard.js`'s
  chart code was removed, because `CampaignDetail.js` had silently relied
  on `Dashboard.js` registering Chart.js elements as a module-load side
  effect. Fixed by making `CampaignDetail.js` self-contained
  (`ChartJS.register(ArcElement, Title, Tooltip, Legend)` directly in the
  file) and dropping an unused `Bar` import.

## QA Review — built from scratch, then made fast, then made robust

The largest single feature added. Full technical detail (schema notes,
`EXPLAIN` evidence, every bug found) lives in
[`qa-review.md`](./qa-review.md) — this is the short version.

**v1 — build.** A new `/qa` page and backend module, explicitly required to
be architecturally independent of the Campaign sync pipeline: full outcome
*names* (not abbreviations) and call recording *metadata* (filename +
duration — never playable audio, confirmed explicitly not to fetch or
serve audio), filterable by date range, outcome, and campaign
(multi-select), across campaigns at once — the one page in the app that
isn't scoped to a single campaign.

**v1 problems — too slow to use.** A live, per-request query against the
source DB:
- Outcome filter options: 10+ minutes, sometimes never returned (`SELECT
  DISTINCT` over the full interaction history, no date bound). Fixed first
  by querying `cxm.outcomes_to_campaigns` (a small config table) instead —
  48 outcomes in 0.084s.
- Records query: 373s for a 7-day window, 16,512 rows. Root-caused via
  `EXPLAIN`, not guessed: no index on `cxm.cd_voice_meta` with
  `last_called` as a leading column. The real fix
  (`CREATE INDEX CONCURRENTLY`) needs `CREATE` on the `cxm` schema, which
  the app's credentials don't have — confirmed via
  `has_schema_privilege(...)` returning `false`. Blocked on a DBA with no
  ETA.

**v2 — architecture pivot: local cache instead of a live query.**
Rather than wait on the index, `qa_source.py` was rewritten: pull a
campaign's *full current state* (no date filter — proven fast, same query
shape the Campaign pipeline already runs against 100k+ contact campaigns)
into a new `QACallRecord` model, on demand, and serve every QA page query
(date range, outcome, pagination, search) from that local cache instead.
Verified: the exact query that took 373s live dropped to 0.4s served
locally, identical data (`count: 16512`).

**v2 frontend catch-up.** `QA.js`/`dashboardService.js` updated to match:
real pagination (exact count/page numbers, replacing an interim
`has_more`/Prev-Next-only mitigation), a "Sync Now" trigger with a
freshness indicator, and — per explicit request — **searchable** campaign
and outcome filter dropdowns (a text box inside the dropdown filtering the
checkbox list) instead of scroll-only multi-selects.

**v2 bug — the cache sync itself locked out the whole app.**
`bulk_create(...)` looked batched (`batch_size=500`) but Django wraps
*every* batch from one call in a single atomic transaction regardless — a
161k-row sync held one continuous SQLite write lock for ~75s, during which
every other request in the app (campaigns, outcome sets, login) failed
with `OperationalError: database is locked`. This is also why outcomes
looked incomplete at one point — the outcome fetch failed silently
mid-sync and fell back to an empty list. Fixed three ways: chunked
`bulk_create` calls (one per 1,000 rows, each its own short transaction),
enabled SQLite WAL mode (reads no longer block on a writer at all), and
raised the SQLite busy-timeout to 30s as a writer-vs-writer safety net.
Verified under real load: 15 concurrent reads while a 161k-row sync ran,
zero lock errors (previously reliable failures).

**v2 UX gap — syncing many campaigns was one giant blocking request.**
Selecting a broad campaign set (e.g. "select all" across ~75 campaigns,
several 100k-300k+ rows) and clicking Sync ran every campaign
*sequentially inside one HTTP request* server-side — not broken, but could
take hours with zero progress feedback, easy to mistake for hung. Fixed by
moving the loop to the frontend: `handleSync()` now calls
`POST /api/qa/sync/` once per campaign, sequentially, showing live
progress ("Syncing 3 of 12 — Absa Insurance"), refreshing results after
each campaign so completed ones show up immediately, and offering a Stop
button (`AbortController`) that cancels cleanly without losing anything
already synced.

**v2 bug — duplicate concurrent syncs for the same campaign.** A single
campaign's sync (Hollard Edgars, normally ~75s) was observed still running
after 5+ minutes. `pg_stat_activity` on the source DB showed why: three,
then four, identical copies of the same pull query running concurrently
for the same campaign — not stuck, just competing with each other for
the same disk I/O (double-click, a retry, or the same campaign synced from
two tabs — nothing prevented it). Fixed on both ends: a process-local
`set()` + `threading.Lock` in `qa_source.py` rejects a second sync for a
campaign already in progress; the frontend's double-click guard was
tightened from a React state check (not guaranteed to have re-rendered
between two fast clicks) to a synchronous `useRef` flag.

## Where things stand

See [`system-overview.md`](./system-overview.md) for the current
capabilities snapshot and known limitations, and
[`qa-review.md`](./qa-review.md) for the QA Review page's full technical
record.
