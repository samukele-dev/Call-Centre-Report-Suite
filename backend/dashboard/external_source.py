# backend/dashboard/external_source.py
"""
Pulls call data for a campaign directly from the call-centre platform's own
PostgreSQL database (the one browsed via HeidiSQL), instead of requiring a
manual CSV/Excel upload.

The fetched rows are aliased to the exact column names the existing upload
pipeline already expects (see `column_mapping` in
CallDataFileSerializer._save_all_to_processed_data), written out as a
worksheet, and then run through that same pipeline (SimpleDataProcessor,
ProcessedData save, auto-report) so there is exactly one code path for
"data came in" regardless of source.
"""
import os
import socket
from datetime import datetime, timedelta

import pandas as pd
import psycopg2
from django.conf import settings
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.utils import timezone

from .models import CallDataFile

# Column aliases match column_mapping in
# CallDataFileSerializer._save_all_to_processed_data exactly, so the
# resulting DataFrame needs no further renaming before saving.
# {where_clause} is filled in by fetch_call_data_from_source() — always at
# least the campaign filter, optionally ANDed with an interaction-date range.
#
# A source "campaign" (cxm.campaigns) owns many cd_lists (one per upload
# batch over time, e.g. a new list every time leads are loaded), so pulling
# "this campaign's data" means joining through cd_lists on campaign_id rather
# than filtering to one specific list.
#
# cd_voice_meta/users/outcomes are LEFT JOINed deliberately: cd_voice_meta
# rows exist for every contact the moment it's queued (verified — 0 missing
# across sampled campaigns), but last_outcome_id/last_user_id are only set
# once an agent actually dispositions the call. Real campaigns have had up to
# ~25% of leads sitting un-dispositioned; an INNER JOIN here silently drops
# them from every pull, undercounting Total Leads. Undispositioned rows come
# through with last_outcome/last_user NULL, become 'UNKNOWN'/blank downstream
# (see _save_all_to_processed_data), and still count toward totals.
#
# last_outcome pulls oo.name (the source DB's own full outcome text, e.g.
# "Client Hung Up"), not oo.shortcode (e.g. "CU"). The OutcomeDescription
# table/lookup only existed to translate abbreviations from manually
# uploaded CSVs, which only ever carried the shortcode — now that every
# campaign is pulled from this DB, the full description is already right
# here, so downstream (SimpleDataProcessor.get_description,
# _build_outcome_map) that lookup simply misses and passes the value through
# unchanged, same as qa_source.py's QA_FULL_PULL_QUERY already does.
#
# id_number has no dedicated column on cxm.contact_data — every campaign
# (and, within a campaign, often every list/upload-batch) stuffs its own
# lead-form fields into cd.custom (jsonb), and the key used for a contact's
# ID/passport number varies accordingly. Verified live by counting
# cd.custom's actual keys: Telkom LTE alone spreads its ~2.78M contacts
# across 'id_num' (1.13M), 'idn' (886k), 'idno' (413k), 'id_no' (255k) and
# 'idnumber' (~1k) — different upload batches over the campaign's history
# evidently used different field names for the same thing — while other
# campaigns use yet other spellings ('id_number' for the ABSA/Hollard/
# TymeBank campaigns). COALESCE across every variant observed anywhere in
# the source DB so each campaign's column is populated wherever its data
# has it, rather than hardcoding just one spelling; together these five
# cover ~96% of Telkom LTE's contacts (vs. ~32% for 'idn' alone).
# Deliberately excludes lookalike keys that name someone other than the
# contact themselves (e.g. Avbob's 'applicant_id_number'/
# 'main_assured_id_number', or the bare 'id' a handful of campaigns use for
# an unrelated internal reference) — wrong-person data here is worse than a
# blank cell.
SOURCE_QUERY_TEMPLATE = """
SELECT
    cd.contactid                AS contact_id,
    cd.id                       AS customer_id,
    COALESCE(
        cd.custom->>'idn', cd.custom->>'id_num', cd.custom->>'idno',
        cd.custom->>'id_no', cd.custom->>'idnumber', cd.custom->>'id_number'
    )                            AS id_number,
    cd.lead_reference           AS lead_reference,
    cl.id                       AS list_id,
    cl.name                     AS list_name,
    cd.title                    AS title,
    cd.firstname                AS firstname,
    cd.lastname                 AS lastname,
    cd.gender                   AS gender,
    oo.name                     AS last_outcome,
    cvm.interaction_attempts    AS called_count,
    cvm.last_called             AS last_called_date,
    uu.display_name             AS last_user,
    cd.created_at               AS created_at,
    cd.updated_at               AS updated_at,
    cd.address1                 AS address1,
    cd.address2                 AS address2,
    cd.address3                 AS address3,
    cd.town                     AS town,
    cd.county                   AS county,
    cd.country                  AS country,
    cd.postcode                 AS postcode,
    cd.email                    AS email_address,
    cd.tel1                     AS tel1,
    cd.tel2                     AS tel2,
    cd.tel3                     AS tel3,
    cd.tel4                     AS tel4,
    cd.tel5                     AS tel5,
    cd.tel6                     AS tel6,
    cd.owned_by                 AS owner_username,
    cd.security_phrase          AS security_phrase,
    cd.source_reference         AS source_reference,
    cd.industry                 AS industry,
    cd.company_name             AS company_name
FROM cxm.contact_data cd
JOIN cxm.cd_to_cd_lists cdl      ON cdl.contact_data_id = cd.id
JOIN cxm.cd_lists cl             ON cl.id = cdl.cd_list_id
LEFT JOIN cxm.cd_voice_meta cvm  ON cvm.contact_data_id = cd.id
LEFT JOIN cnx_users.users uu     ON uu.id = cvm.last_user_id
LEFT JOIN cxm.outcomes oo        ON oo.id = cvm.last_outcome_id
WHERE {where_clause}
"""


class ExternalSourceError(Exception):
    """Raised for anything that stops a database sync (config, connection, empty result)."""


def _get_connection():
    """Get connection to external database with better error handling."""
    cfg = settings.EXTERNAL_DB
    
    # Check if external DB is configured
    if not cfg.get('HOST') or not cfg.get('NAME') or not cfg.get('USER'):
        raise ExternalSourceError(
            "External database is not configured. Set SOURCE_DB_HOST, "
            "SOURCE_DB_NAME, SOURCE_DB_USER and SOURCE_DB_PASSWORD in "
            "backend/.env (see backend/.env.example)."
        )
    
    # Log connection attempt (without password)
    print(f"🔌 Connecting to external DB: {cfg['HOST']}:{cfg.get('PORT', 5432)}/{cfg['NAME']} as {cfg['USER']}")
    
    try:
        conn = psycopg2.connect(
            host=cfg['HOST'],
            port=cfg.get('PORT', 5432),
            user=cfg['USER'],
            password=cfg['PASSWORD'],
            dbname=cfg['NAME'],
            connect_timeout=10,
            # Add these for better connection handling
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )
        print("✅ Connected to external database successfully")
        return conn
    except psycopg2.OperationalError as e:
        error_msg = f"Could not connect to external database: {e}"
        print(f"❌ {error_msg}")
        raise ExternalSourceError(error_msg)
    except psycopg2.Error as e:
        error_msg = f"Database error: {e}"
        print(f"❌ {error_msg}")
        raise ExternalSourceError(error_msg)
    except Exception as e:
        error_msg = f"Unexpected connection error: {e}"
        print(f"❌ {error_msg}")
        raise ExternalSourceError(error_msg)


def test_connection():
    """
    Test the connection to the external database without making any queries.
    Returns (success, message, details).
    """
    cfg = settings.EXTERNAL_DB
    
    # Check configuration
    if not cfg.get('HOST') or not cfg.get('NAME') or not cfg.get('USER'):
        return False, "External database is not configured", {
            'configured': False,
            'missing': [k for k in ['HOST', 'NAME', 'USER'] if not cfg.get(k)]
        }
    
    # Test network connectivity first
    try:
        socket.create_connection(
            (cfg['HOST'], cfg.get('PORT', 5432)),
            timeout=5
        )
        network_ok = True
    except Exception as e:
        network_ok = False
        network_error = str(e)
    
    if not network_ok:
        return False, f"Cannot reach database server: {network_error}", {
            'network_ok': False,
            'error': network_error
        }
    
    # Test database connection
    try:
        conn = _get_connection()
        conn.close()
        return True, "Successfully connected to external database", {
            'network_ok': True,
            'connected': True,
            'host': cfg['HOST'],
            'port': cfg.get('PORT', 5432),
            'database': cfg['NAME'],
            'user': cfg['USER']
        }
    except ExternalSourceError as e:
        return False, str(e), {
            'network_ok': True,
            'connected': False,
            'error': str(e)
        }
    except Exception as e:
        return False, f"Unexpected error: {e}", {
            'network_ok': True,
            'connected': False,
            'error': str(e)
        }


def fetch_source_lists(cd_campaign_id):
    """
    Return every list (upload batch) that belongs to this source campaign,
    newest first — e.g. "Absa Insurance 20260618". Lets the frontend offer a
    specific-batch picker instead of always pulling the campaign's full
    history.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, name, rstatus::text, created_at
            FROM cxm.cd_lists
            WHERE campaign_id = %s
            ORDER BY created_at DESC
            """,
            (cd_campaign_id,)
        )
        rows = cur.fetchall()
    except Exception as e:
        raise ExternalSourceError(f"Query against external database failed: {e}")
    finally:
        conn.close()

    return [
        {
            'id': str(row[0]),
            'name': row[1],
            'status': row[2],
            'created_at': row[3].isoformat() if row[3] else None,
        }
        for row in rows
    ]


def fetch_call_data_from_source(cd_campaign_id, start_date=None, end_date=None, start_time=None, end_time=None, list_ids=None):
    """
    Run the source query for one campaign UUID (cxm.campaigns.id) and return
    a DataFrame ready for the upload pipeline, covering every list that
    campaign has ever had — unless list_ids is given, in which case only
    those specific lists (batches) are pulled. start_date/end_date (each
    'YYYY-MM-DD' strings or date/datetime objects) optionally scope results
    to cvm.last_called (the contact's most recent call — cvm.created_at is
    set once, when the contact's voice_meta row is first created on its
    very first-ever call, and never moves after that, so filtering on it
    silently drops every later recall of an already-dialled contact;
    verified live on Vodacom Retentions: a same-day window matched 13 rows
    on created_at vs. 806 on last_called) within that range, inclusive on
    both ends. Either or both may be omitted to leave that side of the
    range open. start_time/end_time (each 'HH:MM' strings) optionally
    narrow the start/end date to a specific time instead of the full day.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    where_clauses = ["cl.campaign_id = %s"]
    params = [cd_campaign_id]

    if list_ids:
        # cl.id is uuid; list_ids arrives as plain strings (JSON from the
        # frontend), which psycopg2 adapts as text[]. Postgres won't
        # implicitly cast uuid = text inside ANY() (unlike a lone scalar
        # comparison), so cast the column side explicitly.
        where_clauses.append("cl.id::text = ANY(%s)")
        params.append([str(x) for x in list_ids])
    if start_date:
        where_clauses.append("cvm.last_called >= %s")
        params.append(f"{start_date} {start_time or '00:00:00'}")
    if end_date:
        where_clauses.append("cvm.last_called <= %s")
        params.append(f"{end_date} {end_time or '23:59:59'}")

    sql = SOURCE_QUERY_TEMPLATE.format(where_clause=" AND ".join(where_clauses))

    conn = _get_connection()
    try:
        df = pd.read_sql(sql, conn, params=tuple(params))
    except Exception as e:
        raise ExternalSourceError(f"Query against external database failed: {e}")
    finally:
        conn.close()

    # Postgres 'timestamp with time zone' columns (last_called_date, created_at,
    # updated_at) come back tz-aware; Excel/xlsxwriter can't write those at all
    # (raises ValueError), so strip the tzinfo before anything downstream touches it.
    for col in df.columns:
        if pd.api.types.is_datetime64tz_dtype(df[col]):
            df[col] = df[col].dt.tz_localize(None)

    return df.fillna('')


# reporting.outcomes has no campaign_id column at all — it's one small
# (~500-row), global table of outcome *types* shared by every campaign, each
# carrying the dialer's own authoritative connect/dmc/sale flags. sale=1 is
# the real, business-defined "was this a conversion" flag; it's frequently
# NOT reflected in the outcome's name at all (verified live: Vodacom
# Retentions' actual sale=1 outcomes are 'Change debit date', 'Client
# Contacted For Documents', 'Special Debit' and 'Still Active' — none of
# which contain the word "sale"), which is exactly why a hardcoded
# name-keyword list (see ReportViewSet's SALE_TERMS) can and does miss a
# campaign's real conversions while Agent Performance — which reads this
# flag directly instead of guessing from names — counts them correctly.
# Cached in-process since it rarely changes and would otherwise cost an
# extra external-DB round trip on every single report generation.
_SALE_OUTCOME_NAMES_CACHE = {'names': None, 'fetched_at': None}
_SALE_OUTCOME_NAMES_TTL = timedelta(hours=1)


def fetch_sale_outcome_names():
    """
    The set of outcome names (lowercased, stripped) flagged sale=1 in
    reporting.outcomes — global across every campaign, see module comment
    above. Used alongside (never instead of) the hardcoded SALE_TERMS
    keyword list when classifying a campaign's dispositions as sales, so a
    campaign whose real conversion outcomes don't happen to contain a
    generic sales keyword still gets counted correctly, matching Agent
    Performance's own sale=1-based count. Raises ExternalSourceError on
    failure — callers should treat this as best-effort and fall back to
    the hardcoded list alone rather than let it fail report generation.
    """
    cached = _SALE_OUTCOME_NAMES_CACHE
    now = timezone.now()
    if cached['names'] is not None and now - cached['fetched_at'] < _SALE_OUTCOME_NAMES_TTL:
        return cached['names']

    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT name FROM reporting.outcomes WHERE sale = 1")
        names = {row[0].strip().lower() for row in cur.fetchall() if row[0]}
    except Exception as e:
        raise ExternalSourceError(f"Fetching sale outcome names failed: {e}")
    finally:
        conn.close()

    cached['names'] = names
    cached['fetched_at'] = now
    return names


def _run_windowed(conn, start_dt, end_dt, run_window, chunk_days=7, min_chunk_days=1):
    """
    Calls run_window(cur, window_start, window_end, is_last) once per
    chunk_days-wide slice of [start_dt, end_dt], instead of one query
    spanning the whole range. reporting.interaction_voice/user_state_history
    have no campaign_id index (137M+/70M+ rows) — a query bounded to a
    verified-fast window (~1s for a week on a large campaign, see
    fetch_agent_performance) stays under the statement timeout; the same
    query spanning months does not, which is what made a 20-month sync
    time out outright.

    is_last is True only for the slice reaching the overall end_dt — that
    slice's upper bound should be inclusive (<=), matching the original
    unchunked query. Every other slice should use an exclusive upper bound
    (<), so two back-to-back slices don't both count a row that falls
    exactly on the boundary timestamp.

    If a slice times out, it's halved and retried (down to min_chunk_days)
    rather than failing the whole pull — a handful of unusually busy days
    shouldn't sink an otherwise-fine multi-month range. A slice that still
    times out at min_chunk_days is skipped (only that slice's rows are
    missing from the result); a non-timeout error propagates immediately,
    same as before chunking existed.

    run_window is expected to accumulate its results into variables the
    caller closes over. With no start_dt/end_dt to chunk on, run_window is
    simply called once, unbounded.

    Returns a list of (window_start, window_end) tuples for slices that
    were skipped entirely (still timing out at min_chunk_days) — empty when
    everything succeeded. Callers that care about completeness (e.g.
    surfacing "this range may be undercounted" in a report) should check
    this; callers that don't can just ignore the return value, same as
    before this existed.
    """
    cur = conn.cursor()
    # 25s covers the ~1s/~5s queries observed for a week-wide window on a
    # large campaign with headroom for slower days, while still failing
    # fast enough to trigger a halve-and-retry instead of stalling.
    cur.execute("SET statement_timeout = 25000")

    skipped_ranges = []

    if not start_dt or not end_dt:
        run_window(cur, start_dt, end_dt, True)
        return skipped_ranges

    def process(w_start, w_end, days):
        is_last = (w_end == end_dt)
        try:
            run_window(cur, w_start, w_end, is_last)
        except Exception as e:
            conn.rollback()
            cur.execute("SET statement_timeout = 25000")
            if 'statement timeout' not in str(e).lower():
                raise
            if days <= min_chunk_days:
                print(f"⚠️  Skipping {w_start}–{w_end}: still timing out at a "
                      f"{days}-day window")
                skipped_ranges.append((w_start, w_end))
                return
            half = max(min_chunk_days, days // 2)
            mid = min(w_start + timedelta(days=half), w_end)
            process(w_start, mid, half)
            if mid < w_end:
                process(mid, w_end, half)

    if start_dt >= end_dt:
        process(start_dt, end_dt, chunk_days)
        return skipped_ranges

    cursor_start = start_dt
    while cursor_start < end_dt:
        cursor_end = min(cursor_start + timedelta(days=chunk_days), end_dt)
        process(cursor_start, cursor_end, chunk_days)
        cursor_start = cursor_end

    return skipped_ranges


def fetch_agent_performance(cd_campaign_id, start_dt=None, end_dt=None):
    """
    Per-agent call performance for one campaign — User/Team identity, call
    counts (outbound/inbound/connects/DMCs/sales/completed) and talk time
    from reporting.interaction_voice + reporting.outcomes, plus pause/wait/
    wrap durations from reporting.user_state_history. This lives entirely in
    the `reporting` schema, a separate purpose-built reporting mirror of the
    cxm.* tables the rest of this module reads — the raw upload pipeline
    (cxm.contact_data/cd_voice_meta, see fetch_call_data_from_source) has no
    per-call timing or agent-state data at all.

    start_dt/end_dt (datetime, optional) scope both queries to interactions
    starting within that range, inclusive. reporting.interaction_voice has
    no campaign_id index (137M+ rows), so an unbounded pull times out —
    only a date-bounded query is fast (verified: ~1s for a week of a large
    campaign via the start_time index). When start_dt/end_dt span more than
    a few days, the range is walked in weekly slices via _run_windowed
    instead of run as one query, so a wide range (e.g. a 20-month db sync)
    stays fast per-query instead of timing out outright.

    reporting.user_state_history (70M+ rows, pause/wait/wrap durations) is
    even less indexed — no usable campaign_id or date-range path at all, it
    times out regardless of window size. The only fast query shape found is
    filtering by an explicit, small user_id list (a handful of agents) plus
    the date range, which is why this function queries interaction_voice
    FIRST to get that agent list, then reuses it for user_state_history.

    Returns a list of dicts, one per agent with at least one call in range,
    sorted by sales descending (ties broken alphabetically by display name)
    — read as a leaderboard, top sellers first. Raises ExternalSourceError
    on any failure (connection, non-timeout query error) — callers should
    treat this sheet as best-effort and not let it fail the wider report.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    call_totals = {}   # user_id -> summed call/talk-time metrics
    state_totals = {}  # user_id -> summed pause/wait/wrap seconds
    call_sum_fields = [
        'outbound', 'inbound', 'connects', 'dmcs', 'sales', 'completed',
        'talk_seconds', 'dmc_talk_seconds',
    ]
    state_sum_fields = ['pause_seconds', 'wait_seconds', 'wrap_seconds']

    def add_totals(acc, uid, row, sum_fields):
        bucket = acc.setdefault(uid, {f: 0 for f in sum_fields})
        for f in sum_fields:
            bucket[f] += row.get(f) or 0

    def run_window(cur, w_start, w_end, is_last):
        end_op = "<=" if is_last else "<"

        call_where = ["iv.campaign_id = %s", "iv.user_id IS NOT NULL"]
        call_params = [cd_campaign_id]
        if w_start:
            call_where.append("iv.start_time >= %s")
            call_params.append(w_start)
        if w_end:
            call_where.append(f"iv.start_time {end_op} %s")
            call_params.append(w_end)

        cur.execute(
            f"""
            SELECT
                iv.user_id,
                COUNT(*) FILTER (WHERE iv.direction = 'outbound')                    AS outbound,
                COUNT(*) FILTER (WHERE iv.direction = 'inbound')                     AS inbound,
                COUNT(*) FILTER (WHERE o.connect = 1)                                AS connects,
                COUNT(*) FILTER (WHERE o.dmc = 1)                                    AS dmcs,
                COUNT(*) FILTER (WHERE o.sale = 1)                                   AS sales,
                COUNT(*) FILTER (WHERE iv.outcome_id IS NOT NULL)                    AS completed,
                COALESCE(SUM(EXTRACT(EPOCH FROM iv.talk_time)), 0)                   AS talk_seconds,
                COALESCE(SUM(EXTRACT(EPOCH FROM iv.talk_time)) FILTER (WHERE o.dmc = 1), 0) AS dmc_talk_seconds
            FROM reporting.interaction_voice iv
            LEFT JOIN reporting.outcomes o ON o.id = iv.outcome_id
            WHERE {" AND ".join(call_where)}
            GROUP BY iv.user_id
            """,
            call_params,
        )
        call_cols = [d[0] for d in cur.description]
        window_call_rows = {row[0]: dict(zip(call_cols, row)) for row in cur.fetchall()}
        for uid, row in window_call_rows.items():
            add_totals(call_totals, uid, row, call_sum_fields)

        if not window_call_rows:
            return

        user_ids = [str(u) for u in window_call_rows.keys()]
        state_where = ["ush.user_id::text = ANY(%s)", "ush.status IN ('pause', 'wait', 'wrap')"]
        state_params = [user_ids]
        if w_start:
            state_where.append("ush.start_time >= %s")
            state_params.append(w_start)
        if w_end:
            state_where.append(f"ush.start_time {end_op} %s")
            state_params.append(w_end)

        cur.execute(
            f"""
            SELECT
                ush.user_id,
                COALESCE(SUM(EXTRACT(EPOCH FROM ush.duration)) FILTER (WHERE ush.status = 'pause'), 0) AS pause_seconds,
                COALESCE(SUM(EXTRACT(EPOCH FROM ush.duration)) FILTER (WHERE ush.status = 'wait'), 0)  AS wait_seconds,
                COALESCE(SUM(EXTRACT(EPOCH FROM ush.duration)) FILTER (WHERE ush.status = 'wrap'), 0)  AS wrap_seconds
            FROM reporting.user_state_history ush
            WHERE {" AND ".join(state_where)}
            GROUP BY ush.user_id
            """,
            state_params,
        )
        state_cols = [d[0] for d in cur.description]
        for row in cur.fetchall():
            add_totals(state_totals, row[0], dict(zip(state_cols, row)), state_sum_fields)

    def _fetch_users(connection, user_ids):
        cur = connection.cursor()
        cur.execute(
            "SELECT id, display_name, team_name FROM reporting.users WHERE id::text = ANY(%s)",
            (user_ids,),
        )
        return {row[0]: {'display_name': row[1], 'team_name': row[2]} for row in cur.fetchall()}

    conn = _get_connection()
    try:
        try:
            _run_windowed(conn, start_dt, end_dt, run_window)
        except Exception:
            # Retry the whole windowed scan once on a fresh connection.
            # _run_windowed already retries an individual window on a
            # statement *timeout*, but re-raises immediately on anything
            # else — including a dropped/killed connection mid-scan
            # (verified live in this codebase's own history: "server
            # closed the connection unexpectedly" during a heavy query),
            # which previously meant one transient blip silently discarded
            # this entire sheet with no visible warning (see
            # ReportViewSet._auto_generate_full_report's agent_rows except
            # block). Reset the accumulators first — some windows may have
            # already written into them before the drop, and re-running
            # into a dirty dict would double-count those.
            call_totals.clear()
            state_totals.clear()
            conn.close()
            conn = _get_connection()
            _run_windowed(conn, start_dt, end_dt, run_window)

        if not call_totals:
            return []

        user_ids = [str(u) for u in call_totals.keys()]
        # A wide date range can make the windowed scan above run for many
        # minutes (verified live: ~26 minutes against a busy campaign) —
        # long enough for the connection to die from a server-side idle/
        # session timeout or a network blip before this final, otherwise
        # tiny lookup runs. That used to silently discard everything the
        # scan had already gathered; retrying once on a fresh connection
        # is cheap insurance against losing a 26-minute result over one
        # dropped connection right at the finish line.
        try:
            users = _fetch_users(conn, user_ids)
        except Exception:
            conn.close()
            conn = _get_connection()
            users = _fetch_users(conn, user_ids)
    except ExternalSourceError:
        raise
    except Exception as e:
        raise ExternalSourceError(f"Agent performance query against external database failed: {e}")
    finally:
        conn.close()

    results = []
    for uid, c in call_totals.items():
        s = state_totals.get(uid, {})
        u = users.get(uid, {})

        outbound = c['outbound'] or 0
        inbound = c['inbound'] or 0
        combined = outbound + inbound
        connects = c['connects'] or 0
        dmcs = c['dmcs'] or 0
        sales = c['sales'] or 0
        talk_seconds = float(c['talk_seconds'] or 0)
        dmc_talk_seconds = float(c['dmc_talk_seconds'] or 0)
        pause_seconds = float(s.get('pause_seconds', 0) or 0)
        wait_seconds = float(s.get('wait_seconds', 0) or 0)
        wrap_seconds = float(s.get('wrap_seconds', 0) or 0)

        results.append({
            'user_id': str(uid),
            'display_name': u.get('display_name') or 'Unknown Agent',
            'team_name': u.get('team_name') or '',
            'outbound': outbound,
            'inbound': inbound,
            'combined': combined,
            'connects': connects,
            'connect_rate': (connects / combined) if combined else 0,
            'dmcs': dmcs,
            'dmc_rate': (dmcs / connects) if connects else 0,
            'sales': sales,
            'conversion': (sales / dmcs) if dmcs else 0,
            'completed': c['completed'] or 0,
            'talk_seconds': talk_seconds,
            'avg_talk_seconds': (talk_seconds / combined) if combined else 0,
            'dmc_talk_seconds': dmc_talk_seconds,
            'avg_dmc_talk_seconds': (dmc_talk_seconds / dmcs) if dmcs else 0,
            'pause_seconds': pause_seconds,
            'wait_seconds': wait_seconds,
            'avg_wait_seconds': (wait_seconds / combined) if combined else 0,
            'wrap_seconds': wrap_seconds,
            'avg_wrap_seconds': (wrap_seconds / combined) if combined else 0,
        })

    # Highest sales first (ties broken alphabetically by name, for a
    # stable/predictable order among agents with equal sales — e.g. both
    # with 0) — the sheet is read as a leaderboard, so the strongest agents
    # should be at the top rather than buried alphabetically.
    results.sort(key=lambda r: (-r['sales'], r['display_name'].lower()))
    return results


def fetch_contact_call_counts(cd_campaign_id, start_dt=None, end_dt=None):
    """
    How many times each contact was actually called within a date range —
    for the "Call Count Breakdown" report sheet. Deliberately not derived
    from ProcessedData.called_count: that field is cvm.interaction_attempts,
    a lifetime cumulative counter from the source DB, not scoped to any
    particular sync's date range. This counts actual call rows instead.

    Same schema/performance profile as fetch_agent_performance (see its
    docstring): reporting.interaction_voice has no campaign_id index, so
    only a date-bounded query is fast — verified ~1s for a week of a large
    campaign. A start_dt/end_dt spanning more than a few days is walked in
    weekly slices via _run_windowed instead of run as one query, for the
    same reason as fetch_agent_performance. Raises ExternalSourceError on
    any failure (connection, non-timeout query error); callers should treat
    this as best-effort, same as Agent Performance.

    Returns {customer_id_str: call_count}. customer_id here is the same
    value already pulled into ProcessedData.customer_id by
    fetch_call_data_from_source, so callers can join against records
    already loaded for that sync without a second lookup.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    counts = {}

    def run_window(cur, w_start, w_end, is_last):
        end_op = "<=" if is_last else "<"
        where = ["campaign_id = %s", "customer_id IS NOT NULL"]
        params = [cd_campaign_id]
        if w_start:
            where.append("start_time >= %s")
            params.append(w_start)
        if w_end:
            where.append(f"start_time {end_op} %s")
            params.append(w_end)

        cur.execute(
            f"""
            SELECT customer_id, COUNT(*) AS call_count
            FROM reporting.interaction_voice
            WHERE {" AND ".join(where)}
            GROUP BY customer_id
            """,
            params,
        )
        for customer_id, call_count in cur.fetchall():
            key = str(customer_id)
            counts[key] = counts.get(key, 0) + call_count

    conn = _get_connection()
    try:
        try:
            _run_windowed(conn, start_dt, end_dt, run_window)
        except Exception:
            # Retry the whole scan once on a fresh connection — see
            # fetch_agent_performance's identical retry for why (a dropped
            # connection mid-scan, not just a per-window statement
            # timeout, previously discarded this sheet silently).
            counts.clear()
            conn.close()
            conn = _get_connection()
            _run_windowed(conn, start_dt, end_dt, run_window)
        return counts
    except Exception as e:
        raise ExternalSourceError(f"Call count query against external database failed: {e}")
    finally:
        conn.close()


def fetch_outcome_history_counts(cd_campaign_id, start_dt=None, end_dt=None):
    """
    Full outcome-disposition history for a campaign — every interaction's
    outcome, not just each contact's current/latest one. ProcessedData.
    last_outcome (and, before this function existed, cxm.cd_voice_meta.
    last_outcome_id more generally) only ever holds a contact's most recent
    disposition — a contact QA Verified last month and later called again
    for any reason loses that QA Verify from every count derived from that
    table, permanently, since re-syncing only refreshes current state. This
    function counts every logged interaction instead, so that contact still
    counts under both outcomes.

    Returns (counts, skipped_ranges). counts is {outcome_name: count},
    summed across every interaction in range — can legitimately exceed the
    campaign's contact count, since one contact can contribute multiple
    outcomes over its call history. skipped_ranges is a list of
    (window_start, window_end) tuples for date ranges that couldn't be
    scanned in time even at _run_windowed's finest chunking (see its
    docstring) — a genuinely busy campaign (verified live: one generating
    ~20-28k interactions/day still had a handful of individual days time
    out even at 1-day granularity) can hit this. Non-empty means the
    returned counts are a slight undercount for those specific ranges;
    callers that show these counts to a user should surface that rather
    than let the numbers look silently authoritative.

    Same schema/performance profile as fetch_agent_performance/
    fetch_contact_call_counts: reporting.interaction_voice has no
    campaign_id index, so a wide start_dt/end_dt is walked in weekly
    slices via _run_windowed — and, because this scans *every* disposition
    rather than aggregating over an already-loaded local queryset, a wide
    range on a busy campaign can still take several minutes even with
    chunking (verified live: a 90-day range took ~8 minutes on a
    ~25k-interactions/day campaign). Callers should treat this as
    opt-in/best-effort, not something to run unconditionally on every
    report generation (see ReportViewSet._auto_generate_full_report's
    full_outcome_history parameter). Raises ExternalSourceError on any
    failure.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    counts = {}

    def run_window(cur, w_start, w_end, is_last):
        end_op = "<=" if is_last else "<"
        where = ["iv.campaign_id = %s"]
        params = [cd_campaign_id]
        if w_start:
            where.append("iv.start_time >= %s")
            params.append(w_start)
        if w_end:
            where.append(f"iv.start_time {end_op} %s")
            params.append(w_end)

        cur.execute(
            f"""
            SELECT COALESCE(oo.name::text, 'Unknown') AS outcome_name, COUNT(*) AS n
            FROM reporting.interaction_voice iv
            LEFT JOIN reporting.outcomes oo ON oo.id = iv.outcome_id
            WHERE {" AND ".join(where)}
            GROUP BY oo.name
            """,
            params,
        )
        for outcome_name, n in cur.fetchall():
            counts[outcome_name] = counts.get(outcome_name, 0) + n

    conn = _get_connection()
    try:
        skipped_ranges = _run_windowed(conn, start_dt, end_dt, run_window)
        return counts, skipped_ranges
    except Exception as e:
        raise ExternalSourceError(f"Outcome history query against external database failed: {e}")
    finally:
        conn.close()


def fetch_qa_interactions(cd_campaign_id, start_dt=None, end_dt=None, on_window=None):
    """
    Full per-interaction call history for a campaign — contact info,
    outcome, agent, and recording for every logged call, not just each
    contact's current state (see fetch_outcome_history_counts's docstring
    for why that distinction matters). Used to populate QACallRecord with
    one row per historical disposition instead of one per contact.

    on_window, when given, is called with each window's list of row dicts
    as soon as that window's query completes, so the caller (QA sync) can
    upsert incrementally instead of holding a campaign's entire history in
    memory at once. The full concatenated list is also returned, for
    smaller callers that don't need incremental handling.

    Same windowed/chunked approach as fetch_agent_performance/
    fetch_contact_call_counts — reporting.interaction_voice has no
    campaign_id index. Raises ExternalSourceError on any failure.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    all_rows = []

    def run_window(cur, w_start, w_end, is_last):
        end_op = "<=" if is_last else "<"
        where = ["iv.campaign_id = %s"]
        params = [cd_campaign_id]
        if w_start:
            where.append("iv.start_time >= %s")
            params.append(w_start)
        if w_end:
            where.append(f"iv.start_time {end_op} %s")
            params.append(w_end)

        cur.execute(
            f"""
            SELECT
                iv.interaction_id  AS interaction_id,
                iv.customer_id     AS customer_id,
                cd.contactid       AS contact_id,
                cd.firstname       AS firstname,
                cd.lastname        AS lastname,
                cd.tel1            AS phone_number,
                iv.start_time      AS call_date,
                uu.display_name    AS agent_name,
                oo.name::text      AS outcome,
                rl.recording       AS recording_key,
                rl.audio_length    AS recording_duration
            FROM reporting.interaction_voice iv
            LEFT JOIN cxm.contact_data cd    ON cd.id = iv.customer_id
            LEFT JOIN reporting.outcomes oo  ON oo.id = iv.outcome_id
            LEFT JOIN reporting.users uu     ON uu.id = iv.user_id
            LEFT JOIN cxm.recording_log rl   ON rl.interaction_id = iv.interaction_id
            WHERE {" AND ".join(where)}
            """,
            params,
        )
        columns = [d[0] for d in cur.description]
        window_rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        all_rows.extend(window_rows)
        if on_window and window_rows:
            on_window(window_rows)

    conn = _get_connection()
    try:
        _run_windowed(conn, start_dt, end_dt, run_window)
        return all_rows
    except Exception as e:
        raise ExternalSourceError(f"QA interaction query against external database failed: {e}")
    finally:
        conn.close()


#  Fallback lower bound for default_campaign_date_range when a campaign has
#  no start_date set — deliberately NOT campaign.created_at (verified live:
#  for Telkom LTE, created_at was ~10 days ago — when this app's Campaign
#  record was administratively created — while that campaign's actual synced
#  call history goes back to 2025-01-01; using created_at silently missed
#  over a year of real disposition history, the exact class of bug this
#  whole change exists to fix). This app's call-centre source predates this
#  constant by a wide margin, so it's a safe "beginning of time" anchor.
_EARLIEST_PLAUSIBLE_CALL_DATE = datetime(2015, 1, 1)


def default_campaign_date_range(campaign):
    """
    A wide-but-bounded (start_dt, end_dt) for windowed queries against
    reporting.interaction_voice when a caller doesn't supply an explicit
    range — used by both the QA sync and the Campaign report's outcome-
    history lookup, so the two stay consistent. Prefers campaign.start_date/
    end_date when both are set; otherwise falls back to
    _EARLIEST_PLAUSIBLE_CALL_DATE through now — wide on purpose, since the
    entire point is to never silently miss older history (see the
    module-level constant's comment for why campaign.created_at is the
    wrong anchor here). Deliberately not None/None ("no filter at all")
    either: passed to _run_windowed, an actually-unbounded pair skips
    chunking entirely and runs one query with no date filter against a
    137M+-row table with no campaign_id index — exactly the slow/
    timeout-prone shape this whole windowed-query approach exists to avoid.
    """
    if campaign.start_date and campaign.end_date:
        start_dt = timezone.make_aware(datetime.combine(campaign.start_date, datetime.min.time()))
        end_dt = timezone.make_aware(datetime.combine(campaign.end_date, datetime.max.time()))
        return start_dt, end_dt
    return timezone.make_aware(_EARLIEST_PLAUSIBLE_CALL_DATE), timezone.now()


def _default_user():
    user, created = User.objects.get_or_create(
        username='test_user',
        defaults={'email': 'test@example.com', 'is_active': True}
    )
    if created:
        user.set_password('test123')
        user.save()
    return user


def sync_campaign_from_database(campaign, user=None, start_date=None, end_date=None, start_time=None, end_time=None,
                                 list_ids=None, sheets=None, full_outcome_history=False, auto_generate_report=True):
    """
    Pull this campaign's data from the external DB and run it through the
    same processing pipeline a CSV upload uses. Returns the resulting
    CallDataFile instance. start_date/end_date optionally scope the pull to
    interactions within that range, further narrowed by start_time/end_time
    ('HH:MM', optional); list_ids optionally scopes it to specific upload
    batches instead of the campaign's full history (see
    fetch_call_data_from_source).

    auto_generate_report (default True, for backward compatibility — see
    below) controls whether the full report is built as part of this same
    call, same as a CSV/Excel upload does. sheets/full_outcome_history are
    only relevant when it's True — see ReportViewSet._auto_generate_full_report.

    Why this defaults to True despite being slow: report generation used to
    always run synchronously as part of this call, which meant the sync's
    HTTP response stayed blocked for however long the report's own Agent
    Performance/Call Count Breakdown sheets took on top of the actual sync
    (each re-queries the external DB in weekly windows across the
    campaign's full history; verified live at 25+ minutes on a large
    campaign, on top of an already-complete sync) — surprising for a button
    labelled "Sync". But at least one caller (AgentReports.js's bulk
    sync-then-download-report flow) depends on exactly that: it syncs a
    campaign and immediately fetches the report that pull just produced.
    Flipping the default would silently break it. So this is opt-in per
    caller instead: pass auto_generate_report=False to get a sync that
    returns as soon as its own data is saved, and build the report
    afterward on its own timing via ReportViewSet.generate_campaign — used
    by ExportData.js's "Sync from Database" panel, which only needs the
    synced data for export and never builds a report from it.
    CampaignUpload.js's "Sync from Database" panel deliberately keeps the
    default (True): that panel's sheet-picker/full-outcome-history controls
    and its "generated automatically once the sync finishes" messaging are
    built around the report existing immediately after sync, not a
    leftover — verified as the intended behavior, not changed here.
    """
    if not campaign.cd_campaign_id:
        raise ExternalSourceError(
            f"Campaign '{campaign.display_name}' has no cd_campaign_id configured."
        )

    df = fetch_call_data_from_source(
        campaign.cd_campaign_id, start_date=start_date, end_date=end_date,
        start_time=start_time, end_time=end_time, list_ids=list_ids
    )
    if df.empty:
        range_note = f" between {start_date or '…'} and {end_date or '…'}" if (start_date or end_date) else ""
        list_note = f" (scoped to {len(list_ids)} selected list(s))" if list_ids else ""
        raise ExternalSourceError(
            f"No records returned from the external database for campaign "
            f"{campaign.cd_campaign_id}{range_note}{list_note}."
        )

    timestamp = timezone.now().strftime('%Y%m%d_%H%M%S')
    date_tag = ''
    if start_date or end_date:
        date_tag = f"_{start_date or 'start'}_to_{end_date or 'end'}"
    if list_ids:
        date_tag += f"_{len(list_ids)}lists"
    # CSV, not .xlsx: a large campaign (e.g. a 20-month telkom-lte pull) can
    # run to hundreds of thousands of rows. df.to_excel()/pd.read_excel() go
    # through openpyxl's per-cell Python writer/reader, which is orders of
    # magnitude slower than pandas' C-based CSV path for a frame this wide
    # (35 columns) — this alone was enough to make a sync take 30+ minutes
    # and still not finish. It also has a hard ceiling: Excel caps a sheet at
    # 1,048,576 rows, so a pull past that raises outright. This file is only
    # a hand-off buffer for the upload pipeline, which reads both formats the
    # same way (dtype=str — see SimpleDataProcessor.process_call_data), so
    # CSV loses nothing and has no row limit.
    original_name = f"db_sync_{campaign.name}{date_tag}_{timestamp}.csv"

    buffer_path = os.path.join(settings.MEDIA_ROOT, 'tmp')
    os.makedirs(buffer_path, exist_ok=True)
    tmp_file_path = os.path.join(buffer_path, original_name)
    df.to_csv(tmp_file_path, index=False, encoding='utf-8')

    try:
        with open(tmp_file_path, 'rb') as f:
            file_bytes = f.read()

        instance = CallDataFile(
            user=user or _default_user(),
            campaign=campaign,
            original_name=original_name,
            file_size=len(file_bytes),
            delimiter=',',
            has_headers=True,
            status='uploaded',
        )
        instance.file.save(original_name, ContentFile(file_bytes), save=False)
        instance.save()
    finally:
        os.remove(tmp_file_path)

    from .serializers import CallDataFileSerializer
    CallDataFileSerializer()._start_processing(
        instance, sheets=sheets, full_outcome_history=full_outcome_history,
        auto_generate_report=auto_generate_report
    )
    instance.refresh_from_db()

    if instance.status == 'failed':
        raise ExternalSourceError(
            f"Database sync fetched {len(df)} records but processing failed: "
            f"{instance.processing_errors}"
        )

    return instance


# ============================================================
# CAMPAIGN METADATA SYNC FUNCTIONS
# ============================================================
def fetch_campaigns_from_source(only_active=True):
    """
    Fetch all campaigns from the external source database (cxm.campaigns).
    
    Args:
        only_active: If True, only return active campaigns (is_active=1)
    
    Returns:
        List of dicts with campaign metadata from the source database
    """
    conn = _get_connection()
    try:
        cur = conn.cursor()
        
        # Get actual column names from the campaigns table
        cur.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'cxm' 
            AND table_name = 'campaigns'
            ORDER BY ordinal_position
        """)
        available = [row[0] for row in cur.fetchall()]
        print(f"📋 Available columns in cxm.campaigns: {available}")
        
        # Build query with only columns that exist
        select_parts = ['id', 'name']
        
        # Add created_at if it exists
        if 'created_at' in available:
            select_parts.append('created_at')
        else:
            select_parts.append('NULL AS created_at')
        
        # Add updated_at if it exists
        if 'updated_at' in available:
            select_parts.append('updated_at')
        else:
            select_parts.append('NULL AS updated_at')
        
        # Add display_name - use name as fallback
        if 'display_name' in available:
            select_parts.append('display_name')
        else:
            select_parts.append('name AS display_name')
        
        # Add sheet_name with fallback
        if 'sheet_name' in available:
            select_parts.append('sheet_name')
        else:
            select_parts.append("'' AS sheet_name")
        
        # Add description with fallback
        if 'description' in available:
            select_parts.append('description')
        else:
            select_parts.append("'' AS description")
        
        # Add dates with fallback
        if 'start_date' in available:
            select_parts.append('start_date')
        else:
            select_parts.append('NULL AS start_date')
        
        if 'end_date' in available:
            select_parts.append('end_date')
        else:
            select_parts.append('NULL AS end_date')
        
        # Add is_active - use 1 as default since we don't know
        if 'is_active' in available:
            select_parts.append('is_active')
        else:
            select_parts.append('1 AS is_active')
        
        # Build WHERE clause - if is_active doesn't exist, don't filter by it
        if 'is_active' in available:
            where_clause = "WHERE is_active = %s OR %s = false"
            params = (1 if only_active else 0, only_active)
        else:
            # No is_active column - ignore the only_active filter
            where_clause = ""
            params = ()
            print("⚠️ 'is_active' column not found - ignoring only_active filter")
        
        query = f"""
            SELECT 
                {', '.join(select_parts)}
            FROM cxm.campaigns
            {where_clause}
            ORDER BY name
        """
        
        print(f"📝 Query: {query}")
        cur.execute(query, params)
        
        columns = [desc[0] for desc in cur.description]
        results = []
        for row in cur.fetchall():
            row_dict = dict(zip(columns, row))
            # Convert datetime objects to strings for JSON serialization
            for key in ['created_at', 'updated_at', 'start_date', 'end_date']:
                if row_dict.get(key) and hasattr(row_dict[key], 'isoformat'):
                    row_dict[key] = row_dict[key].isoformat()
            # Ensure display_name is set
            if not row_dict.get('display_name'):
                row_dict['display_name'] = row_dict.get('name', '')
            # Ensure is_active is set
            if 'is_active' not in row_dict:
                row_dict['is_active'] = True
            results.append(row_dict)
        return results
    except Exception as e:
        raise ExternalSourceError(f"Failed to fetch campaigns: {e}")
    finally:
        conn.close()


def sync_campaigns_from_source(only_active=True):
    """
    Sync campaign metadata from external source to Django.
    
    - Creates new campaigns that don't exist in Django
    - Updates existing campaigns with new metadata from source
    - Leaves campaigns untouched if they don't have cd_campaign_id set
    - Optionally deactivates campaigns that no longer exist in source
    
    Args:
        only_active: If True, only sync active campaigns from source
    
    Returns:
        dict with sync statistics
    """
    from .models import Campaign
    from django.utils import timezone
    
    source_campaigns = fetch_campaigns_from_source(only_active=only_active)
    
    results = {
        'created': 0,
        'updated': 0,
        'deactivated': 0,
        'unchanged': 0,
        'total_synced': len(source_campaigns),
        'details': []
    }
    
    # Get existing campaign IDs that are linked to source
    existing_campaigns = Campaign.objects.filter(
        cd_campaign_id__isnull=False
    )
    existing_ids = set(existing_campaigns.values_list('cd_campaign_id', flat=True))
    source_ids = set()
    
    for src in source_campaigns:
        source_ids.add(src['id'])
        
        try:
            # Try to find by cd_campaign_id
            campaign = Campaign.objects.get(cd_campaign_id=src['id'])
            
            # Check for changes
            changed = False
            updates = {}
            
            # Map source fields to Django fields
            field_mapping = {
                'name': 'name',
                'display_name': 'display_name',
                'sheet_name': 'sheet_name',
                'is_active': 'is_active',
                'description': 'description',
                'start_date': 'start_date',
                'end_date': 'end_date',
            }
            
            for source_field, django_field in field_mapping.items():
                source_value = src.get(source_field)
                current_value = getattr(campaign, django_field)
                
                # Handle None/empty string comparisons consistently
                if source_value is None:
                    source_value = '' if django_field != 'is_active' else False
                if current_value is None:
                    current_value = '' if django_field != 'is_active' else False
                
                if source_value != current_value:
                    setattr(campaign, django_field, source_value)
                    changed = True
                    updates[django_field] = {'old': current_value, 'new': source_value}
            
            if changed:
                campaign.last_synced_at = timezone.now()
                campaign.save()
                results['updated'] += 1
                results['details'].append({
                    'id': campaign.id,
                    'cd_campaign_id': src['id'],
                    'action': 'updated',
                    'name': campaign.display_name,
                    'changes': updates
                })
            else:
                results['unchanged'] += 1
                
        except Campaign.DoesNotExist:
            # Create new campaign
            campaign = Campaign.objects.create(
                cd_campaign_id=src['id'],
                name=src.get('name', ''),
                display_name=src.get('display_name', src.get('name', '')),
                sheet_name=src.get('sheet_name', ''),
                is_active=src.get('is_active', True),
                description=src.get('description', ''),
                start_date=src.get('start_date'),
                end_date=src.get('end_date'),
                last_synced_at=timezone.now(),
                created_by=None,  # System-created
            )
            results['created'] += 1
            results['details'].append({
                'id': campaign.id,
                'cd_campaign_id': src['id'],
                'action': 'created',
                'name': campaign.display_name,
            })
    
    # Deactivate campaigns that no longer exist in source
    # (Only if we're syncing all campaigns, not just active ones)
    if not only_active:
        deactivated_count = 0
        for existing_id in existing_ids:
            if existing_id not in source_ids:
                Campaign.objects.filter(cd_campaign_id=existing_id).update(
                    is_active=False,
                    last_synced_at=timezone.now()
                )
                deactivated_count += 1
        results['deactivated'] = deactivated_count
    
    return results
    """
    Sync campaign metadata from external source to Django.
    
    - Creates new campaigns that don't exist in Django
    - Updates existing campaigns with new metadata from source
    - Leaves campaigns untouched if they don't have cd_campaign_id set
    - Optionally deactivates campaigns that no longer exist in source
    
    Args:
        only_active: If True, only sync active campaigns from source
    
    Returns:
        dict with sync statistics
    """
    from .models import Campaign
    from django.utils import timezone
    
    source_campaigns = fetch_campaigns_from_source(only_active=only_active)
    
    results = {
        'created': 0,
        'updated': 0,
        'deactivated': 0,
        'unchanged': 0,
        'total_synced': len(source_campaigns),
        'details': []
    }
    
    # Get existing campaign IDs that are linked to source
    existing_campaigns = Campaign.objects.filter(
        cd_campaign_id__isnull=False
    )
    existing_ids = set(existing_campaigns.values_list('cd_campaign_id', flat=True))
    source_ids = set()
    
    for src in source_campaigns:
        source_ids.add(src['id'])
        
        try:
            # Try to find by cd_campaign_id
            campaign = Campaign.objects.get(cd_campaign_id=src['id'])
            
            # Check for changes
            changed = False
            updates = {}
            
            # Map source fields to Django fields
            field_mapping = {
                'name': 'name',
                'display_name': 'display_name',
                'sheet_name': 'sheet_name',
                'is_active': 'is_active',
                'description': 'description',
                'start_date': 'start_date',
                'end_date': 'end_date',
            }
            
            for source_field, django_field in field_mapping.items():
                source_value = src.get(source_field)
                current_value = getattr(campaign, django_field)
                
                # Handle None/empty string comparisons consistently
                if source_value is None:
                    source_value = '' if django_field != 'is_active' else False
                if current_value is None:
                    current_value = '' if django_field != 'is_active' else False
                
                if source_value != current_value:
                    setattr(campaign, django_field, source_value)
                    changed = True
                    updates[django_field] = {'old': current_value, 'new': source_value}
            
            if changed:
                campaign.last_synced_at = timezone.now()
                campaign.save()
                results['updated'] += 1
                results['details'].append({
                    'id': campaign.id,
                    'cd_campaign_id': src['id'],
                    'action': 'updated',
                    'name': campaign.display_name,
                    'changes': updates
                })
            else:
                results['unchanged'] += 1
                
        except Campaign.DoesNotExist:
            # Create new campaign
            campaign = Campaign.objects.create(
                cd_campaign_id=src['id'],
                name=src.get('name', ''),
                display_name=src.get('display_name', src.get('name', '')),
                sheet_name=src.get('sheet_name', ''),
                is_active=src.get('is_active', True),
                description=src.get('description', ''),
                start_date=src.get('start_date'),
                end_date=src.get('end_date'),
                last_synced_at=timezone.now(),
                created_by=None,  # System-created
            )
            results['created'] += 1
            results['details'].append({
                'id': campaign.id,
                'cd_campaign_id': src['id'],
                'action': 'created',
                'name': campaign.display_name,
            })
    
    # Deactivate campaigns that no longer exist in source
    # (Only if we're syncing all campaigns, not just active ones)
    if not only_active:
        deactivated_count = 0
        for existing_id in existing_ids:
            if existing_id not in source_ids:
                Campaign.objects.filter(cd_campaign_id=existing_id).update(
                    is_active=False,
                    last_synced_at=timezone.now()
                )
                deactivated_count += 1
        results['deactivated'] = deactivated_count
    
    return results