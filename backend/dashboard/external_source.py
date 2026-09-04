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
SOURCE_QUERY_TEMPLATE = """
SELECT
    cd.contactid                AS contact_id,
    cd.id                       AS customer_id,
    cd.lead_reference           AS lead_reference,
    cl.id                       AS list_id,
    cl.name                     AS list_name,
    cd.title                    AS title,
    cd.firstname                AS firstname,
    cd.lastname                 AS lastname,
    cd.gender                   AS gender,
    oo.name                     AS last_outcome,
    cvm.interaction_attempts    AS called_count,
    cvm.created_at              AS last_called_date,
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
    to interactions (cvm.created_at) within that range, inclusive on both
    ends. Either or both may be omitted to leave that side of the range open.
    start_time/end_time (each 'HH:MM' strings) optionally narrow the
    start/end date to a specific time instead of the full day.
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
        where_clauses.append("cvm.created_at >= %s")
        params.append(f"{start_date} {start_time or '00:00:00'}")
    if end_date:
        where_clauses.append("cvm.created_at <= %s")
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
    starting within that range, inclusive. A range is required in practice:
    reporting.interaction_voice has no campaign_id index (137M+ rows), so an
    unbounded pull times out — only a date-bounded query is fast (verified:
    ~1s for a week of a large campaign via the start_time index). Every call
    on this connection gets a hard statement timeout so a caller can treat
    "too slow" the same as "no data" instead of hanging indefinitely.

    reporting.user_state_history (70M+ rows, pause/wait/wrap durations) is
    even less indexed — no usable campaign_id or date-range path at all, it
    times out regardless of window size. The only fast query shape found is
    filtering by an explicit, small user_id list (a handful of agents) plus
    the date range, which is why this function queries interaction_voice
    FIRST to get that agent list, then reuses it for user_state_history.

    Returns a list of dicts, one per agent with at least one call in range,
    sorted by display name. Raises ExternalSourceError on any failure
    (connection, timeout, query) — callers should treat this sheet as
    best-effort and not let it fail the wider report.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    conn = _get_connection()
    try:
        cur = conn.cursor()
        # 25s covers the ~1s/~5s queries observed for a week-wide window on a
        # large campaign with headroom for slower days, while still failing
        # fast enough not to meaningfully stall the synchronous upload path.
        cur.execute("SET statement_timeout = 25000")

        call_where = ["iv.campaign_id = %s", "iv.user_id IS NOT NULL"]
        call_params = [cd_campaign_id]
        if start_dt:
            call_where.append("iv.start_time >= %s")
            call_params.append(start_dt)
        if end_dt:
            call_where.append("iv.start_time <= %s")
            call_params.append(end_dt)

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
        call_rows = {row[0]: dict(zip(call_cols, row)) for row in cur.fetchall()}

        if not call_rows:
            return []

        user_ids = [str(u) for u in call_rows.keys()]

        state_where = ["ush.user_id::text = ANY(%s)", "ush.status IN ('pause', 'wait', 'wrap')"]
        state_params = [user_ids]
        if start_dt:
            state_where.append("ush.start_time >= %s")
            state_params.append(start_dt)
        if end_dt:
            state_where.append("ush.start_time <= %s")
            state_params.append(end_dt)

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
        state_rows = {row[0]: dict(zip(state_cols, row)) for row in cur.fetchall()}

        cur.execute(
            "SELECT id, display_name, team_name FROM reporting.users WHERE id::text = ANY(%s)",
            (user_ids,),
        )
        users = {row[0]: {'display_name': row[1], 'team_name': row[2]} for row in cur.fetchall()}
    except ExternalSourceError:
        raise
    except Exception as e:
        raise ExternalSourceError(f"Agent performance query against external database failed: {e}")
    finally:
        conn.close()

    results = []
    for uid, c in call_rows.items():
        s = state_rows.get(uid, {})
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

    results.sort(key=lambda r: r['display_name'].lower())
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
    campaign. Raises ExternalSourceError on any failure (including timeout);
    callers should treat this as best-effort, same as Agent Performance.

    Returns {customer_id_str: call_count}. customer_id here is the same
    value already pulled into ProcessedData.customer_id by
    fetch_call_data_from_source, so callers can join against records
    already loaded for that sync without a second lookup.
    """
    if not cd_campaign_id:
        raise ExternalSourceError("No cd_campaign_id provided.")

    where = ["campaign_id = %s", "customer_id IS NOT NULL"]
    params = [cd_campaign_id]
    if start_dt:
        where.append("start_time >= %s")
        params.append(start_dt)
    if end_dt:
        where.append("start_time <= %s")
        params.append(end_dt)

    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SET statement_timeout = 25000")
        cur.execute(
            f"""
            SELECT customer_id, COUNT(*) AS call_count
            FROM reporting.interaction_voice
            WHERE {" AND ".join(where)}
            GROUP BY customer_id
            """,
            params,
        )
        return {str(row[0]): row[1] for row in cur.fetchall()}
    except Exception as e:
        raise ExternalSourceError(f"Call count query against external database failed: {e}")
    finally:
        conn.close()


def _default_user():
    user, created = User.objects.get_or_create(
        username='test_user',
        defaults={'email': 'test@example.com', 'is_active': True}
    )
    if created:
        user.set_password('test123')
        user.save()
    return user


def sync_campaign_from_database(campaign, user=None, start_date=None, end_date=None, start_time=None, end_time=None, list_ids=None):
    """
    Pull this campaign's data from the external DB and run it through the
    same processing/auto-report pipeline a CSV upload uses. Returns the
    resulting CallDataFile instance. start_date/end_date optionally scope the
    pull to interactions within that range, further narrowed by start_time/
    end_time ('HH:MM', optional); list_ids optionally scopes it to specific
    upload batches instead of the campaign's full history (see
    fetch_call_data_from_source).
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
    original_name = f"db_sync_{campaign.name}{date_tag}_{timestamp}.xlsx"

    buffer_path = os.path.join(settings.MEDIA_ROOT, 'tmp')
    os.makedirs(buffer_path, exist_ok=True)
    tmp_file_path = os.path.join(buffer_path, original_name)
    df.to_excel(tmp_file_path, index=False)

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
    CallDataFileSerializer()._start_processing(instance)
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