# System Overview — Call Centre Report Suite

What this system does today: a snapshot, not a history. For how it got
here, see [`CHANGELOG.md`](./CHANGELOG.md). For the QA Review page's
architecture and performance work specifically, see
[`qa-review.md`](./qa-review.md).

## What this is

A Django + DRF backend and a Create React App frontend for a call centre:
pulling/uploading call data per campaign, generating Excel reports against
templates, managing outcome-code reference data, and letting QA staff
browse real call records across campaigns for quality review. The two apps
run and deploy independently (`backend/`, `frontend/`); there is no shared
build tooling. Full dev commands are in the root `CLAUDE.md`.

## Architecture at a glance

- **Campaign-scoped data model.** `Campaign` is the top-level tenant.
  `CallDataFile` uploads, `ReportTemplate`s, and `GeneratedReport`s are
  scoped to a campaign. `OutcomeDescriptions` (outcome-code reference data)
  are scoped to an `OutcomeSet`, which one or more campaigns can share.
- **Two independent pipelines that deliberately don't share code:**
  1. **Campaign sync/report pipeline** (`dashboard/external_source.py`,
     `dashboard/views.py`'s `SimpleDataProcessor`/`_auto_generate_full_report`) —
     pulls a campaign's data from the source call-centre DB (or accepts a
     manual CSV/Excel upload), normalizes it, and generates the campaign's
     Excel report package.
  2. **QA Review pipeline** (`dashboard/qa_source.py`, `QARecordsView`/
     `QAOutcomesView`/`QASyncView`) — an independently-scoped, cross-campaign
     call record browser with its own local cache. See
     [`qa-review.md`](./qa-review.md) for why these two don't share a query
     path (short version: QA needs full outcome names and recording
     metadata that the report pipeline's abbreviation-based model doesn't
     carry).
- **No background task queue.** Uploads process synchronously in the
  request; QA cache syncs run synchronously too (see "Known limitations"
  below).
- **SQLite** locally (`db.sqlite3`, WAL mode enabled — see
  [`qa-review.md`](./qa-review.md#bug-found-and-fixed-a-large-sync-locked-out-the-entire-app-database-is-locked)),
  **PostgreSQL** for the external source call-centre database.

## Capabilities by area

### Campaigns (`/campaigns`, `/campaigns/:id/*`)

- List with search/filter/pagination (`Campaigns.js`).
- Detail page with stats, recent activity, doughnut chart of outcome mix
  (`CampaignDetail.js`).
- Create/edit a campaign, including linking it to a source-DB
  `cd_campaign_id` and an `OutcomeSet`.
- **Source-DB sync**: pull a campaign's call data directly from the
  external PostgreSQL DB by date range and/or specific source lists
  (`sync_from_database` action, `external_source.py`). Alternative to
  manual upload for campaigns wired to a `cd_campaign_id`.
- **Manual upload** (`/campaigns/:id/upload`): CSV/Excel upload with
  delimiter/header options, batch (source list) picker with select-all.
- Management commands: `import_source_campaigns` (bulk-imports all
  non-deleted source campaigns as local `Campaign` rows),
  `pull_campaign_data` (scheduled/scriptable sync, supports
  `--start-date`/`--end-date`/`--campaign`/`--all`), `check_records` (audits
  `ProcessedData` row counts against `CallDataFile.total_records`).

### Upload → process → auto-report pipeline

Documented in depth in the root `CLAUDE.md`. Summary: upload or sync →
`SimpleDataProcessor` normalizes columns and attaches outcome descriptions
→ rows saved to `ProcessedData` → `_auto_generate_full_report` builds a
4-sheet `.xlsx` (Processed Data, Pivot, Campaign Analysis, and a populated
copy of the campaign's template if one exists) automatically, saved as a
`GeneratedReport`. Failure in the auto-report step does not fail the
upload.

### Outcome Sets & Outcome Descriptions (`/outcomes`)

- `OutcomeSet` — a named, shareable group of outcome-code → description
  mappings (e.g. "Outcomes 1"). Campaigns reference one `OutcomeSet` via FK.
- `OutcomeDescription` — the actual code → description rows, scoped to an
  `OutcomeSet`. Bulk upload/export supported.
- Every campaign was backfilled onto a default "Outcomes 1" set when this
  model was introduced (migration `0005_default_outcome_set.py`) — no
  regression to pre-existing report generation.

### Reports & Templates (`/campaigns/:id/reports`, `/campaigns/:id/templates`)

- Upload a `ReportTemplate` (`.xlsx`), extract its sheets, configure column
  mappings.
- `TemplateBasedReportGenerator` (in `views.py`, separate from the
  auto-report flow) populates a template on demand outside the upload
  pipeline.
- Download generated reports; per-campaign report history.

### QA Review (`/qa`) — global, cross-campaign

Full detail in [`qa-review.md`](./qa-review.md). Summary of current
capabilities:
- Browse call records — Date, Customer, Phone Number, Agent Name, Campaign,
  Outcome, Recording (filename + duration, metadata only, never playable
  audio) — across one or more campaigns at once, with searchable
  multi-select campaign/outcome filters and a date range.
- Served entirely from a local cache (`QACallRecord`), synced on demand per
  campaign from the source DB via a "Sync Now" control with live
  per-campaign progress and a Stop button — not a live query per page load
  (that path was measured at 373s and is no longer used).
- Real pagination (exact count, page numbers) once cached.
- Deliberately independent of the Campaign sync pipeline: full outcome
  names (not abbreviations) and recording references, neither of which the
  report pipeline's data model carries.

### Dashboard (`/`)

Overview stats (`DashboardStatsView`), optionally scoped to a campaign via
`campaign_id` query param.

### Auth

Token auth via DRF (`rest_framework.authtoken`). **Permission scoping is
inconsistent** — most viewsets currently set `permission_classes =
[AllowAny]` despite the global DRF default being `IsAuthenticated`; check
each viewset individually before assuming it's protected. Auth endpoints
(`/api-token-auth/`, `/register/`, `/verify-token/`) are registered at both
the project and app URL level.

## Data model summary

| Model | Purpose |
|---|---|
| `Campaign` | Top-level tenant; optional `cd_campaign_id` (source DB link) and `outcome_set` FK |
| `OutcomeSet` | Named, shareable group of outcome code→description mappings |
| `OutcomeDescription` | Outcome code → human description, scoped to an `OutcomeSet` |
| `CallDataFile` | An uploaded/synced batch of call data for a campaign |
| `ProcessedData` | Normalized per-row call data from the upload/sync pipeline |
| `ProcessedFile` | (support model for the upload pipeline) |
| `ReportTemplate` | An uploaded `.xlsx` template with configured sheet mappings |
| `GeneratedReport` | A generated report file record (auto or on-demand) |
| `QACallRecord` | Local cache row for QA Review — one per (campaign, contact), full outcome name + recording metadata |

## API surface (selected)

| Endpoint | Purpose |
|---|---|
| `/api/campaigns/` (+ `source_lists`, `sync_from_database`, `stats`, `recent_activity` actions) | Campaign CRUD + source-DB sync |
| `/api/files/` | Upload/list call data files |
| `/api/templates/` (+ `sheets`, `extract-sheets`, `configure_mapping`) | Report template CRUD/config |
| `/api/reports/` (+ `generate_campaign`, `generate_campaign_analysis`, `download`) | Report CRUD/generation |
| `/api/outcome-sets/` | Outcome Set CRUD |
| `/api/outcomes/` (+ `bulk_upload`, `export`) | Outcome Description CRUD |
| `/api/qa/records/` | Paginated/filtered QA call records (local cache) |
| `/api/qa/outcomes/` | Distinct outcome names present in the QA cache for given campaigns |
| `/api/qa/sync/` | Trigger a QA cache sync for given campaigns (one campaign per call, from the frontend) |
| `/api/stats/` | Dashboard stats |
| `/api-token-auth/`, `/register/`, `/verify-token/` | Auth |

## Known limitations (current, as of this writing)

- **No background task queue** anywhere in the app — uploads, source syncs,
  and QA cache syncs all run synchronously inside the request. Large
  operations (a 300k-row campaign QA sync, e.g.) take real, visible time;
  the QA page's per-campaign sync loop with progress/stop was built
  specifically to make this tolerable rather than eliminate it.
- **Source DB missing index**: `cxm.cd_voice_meta` has no index with
  `last_called` as a leading column, making any *live, date-filtered* query
  against it prohibitively slow (373s measured). This is why QA Review
  reads from a local cache instead of the source DB directly. Full detail
  and the (blocked, needs DBA privileges) real fix in
  [`qa-review.md`](./qa-review.md).
- **SQLite in dev**: single-writer; WAL mode + chunked writes mitigate the
  worst case (a long sync blocking every other request) but this is still
  SQLite, not a fit for concurrent multi-user production write load as-is.
- **Auth permission scoping is inconsistent** across viewsets (see Auth
  above) — worth an audit before any deployment beyond internal/trusted use.
- **Disposition/outcome category lists** (`SALE_TERMS`, `TRUE_CONTACT_TERMS`,
  the `categories` dict, `ALIASES`) are duplicated literal lists in
  `views.py` for the report pipeline — adding/renaming an outcome means
  updating all of them together, not a single source of truth.
