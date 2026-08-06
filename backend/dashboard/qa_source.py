# backend/dashboard/qa_source.py
"""
Source-DB sync for the QA Review page's local cache (dashboard.QACallRecord).

Originally this module queried the external call-centre database live, on
every QA page request. That's no longer how it works: filtering
cd_voice_meta by date has no supporting index on the source DB (see
docs/qa-review.md for the full investigation), so any live, date-filtered
QA query took minutes and sometimes never returned. Pulling a campaign's
*full* current state with no date filter is fast (proven — this is the same
shape of query the Campaign sync pipeline already runs successfully against
100k+ contact campaigns), so that's what this module does now: pull
everything for a campaign, cache it locally, and let the QA page query the
local cache — where we can index however we like — instead of the source DB
directly.

Deliberately independent of dashboard/external_source.py and the Campaign
upload/sync pipeline (ProcessedData, CallDataFile): QA needs full outcome
names (not the abbreviation external_source.py uses for report processing)
and call recording references, neither of which that pipeline carries.
"""
import threading

from django.utils import timezone

from .external_source import _get_connection, ExternalSourceError
from .models import QACallRecord

# Guards against two syncs for the same campaign running at once — e.g. a
# double-click, or the same campaign selected from two browser tabs. Without
# this, both requests independently run the full QA_FULL_PULL_QUERY
# concurrently against the source DB, competing for the same disk I/O and
# making both far slower than either would be alone (observed in practice:
# three duplicate syncs for one 161k-row campaign, each still running after
# 5+ minutes, individually verified via pg_stat_activity as three identical
# queries stuck on DataFileRead — not stuck, just needlessly fighting each
# other). Process-local and in-memory is sufficient here: this app runs as a
# single Django dev server process, not multiple workers.
_syncing_campaign_ids = set()
_syncing_lock = threading.Lock()

# cd_voice_meta.last_interaction_id -> recording_log.interaction_id is the
# verified link between a contact's most recent call and its recording.
# No date filter and no LIMIT/OFFSET here deliberately — this is a full
# per-campaign pull for the local cache, not a per-request page fetch.
QA_FULL_PULL_QUERY = """
SELECT
    cd.contactid    AS contact_id,
    cd.firstname    AS firstname,
    cd.lastname     AS lastname,
    cd.tel1         AS phone_number,
    cvm.last_called AS call_date,
    uu.display_name AS agent_name,
    oo.name         AS outcome,
    rl.recording    AS recording_key,
    rl.audio_length AS recording_duration
FROM cxm.contact_data cd
JOIN cxm.cd_to_cd_lists cdl      ON cdl.contact_data_id = cd.id
JOIN cxm.cd_lists cl             ON cl.id = cdl.cd_list_id
LEFT JOIN cxm.cd_voice_meta cvm  ON cvm.contact_data_id = cd.id
LEFT JOIN cxm.outcomes oo        ON oo.id = cvm.last_outcome_id
LEFT JOIN cnx_users.users uu     ON uu.id = cvm.last_user_id
LEFT JOIN cxm.recording_log rl   ON rl.interaction_id = cvm.last_interaction_id
WHERE cl.campaign_id = %s
"""


def sync_campaign_qa_cache(campaign):
    """
    Pull this campaign's full current call data from the source DB (live,
    no date filter — the fast path) and upsert it into QACallRecord. Returns
    (records_synced, synced_at). Safe to call repeatedly; re-syncing just
    refreshes existing rows (matched on campaign + contact_id) and adds any
    new ones.
    """
    if not campaign.cd_campaign_id:
        raise ExternalSourceError(
            f"Campaign '{campaign.display_name}' has no cd_campaign_id configured."
        )

    with _syncing_lock:
        if campaign.id in _syncing_campaign_ids:
            raise ExternalSourceError(
                f"A sync for '{campaign.display_name}' is already running — "
                "please wait for it to finish before starting another."
            )
        _syncing_campaign_ids.add(campaign.id)

    try:
        conn = _get_connection()
        try:
            cur = conn.cursor()
            cur.execute(QA_FULL_PULL_QUERY, (campaign.cd_campaign_id,))
            columns = [d[0] for d in cur.description]
            rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        except Exception as e:
            raise ExternalSourceError(f"QA cache sync failed: {e}")
        finally:
            conn.close()

        records = [
            QACallRecord(
                campaign=campaign,
                contact_id=str(row['contact_id']),
                customer=(f"{row['firstname'] or ''} {row['lastname'] or ''}".strip() or None),
                phone_number=row['phone_number'],
                agent_name=row['agent_name'],
                outcome=row['outcome'],
                call_date=row['call_date'],
                recording_key=row['recording_key'],
                recording_duration_seconds=(
                    int(row['recording_duration'].total_seconds()) if row['recording_duration'] else None
                ),
            )
            for row in rows
        ]

        # Django's bulk_create wraps *all* batches from a single call in one
        # atomic transaction, regardless of batch_size. For a large campaign
        # (100k+ rows) that means one continuous exclusive write lock on
        # SQLite for the full duration of the sync (~75s for 161k rows) —
        # long enough to make every other request in the app fail with
        # "database is locked" while it's running. Calling bulk_create
        # separately per chunk instead gives each chunk its own short-lived
        # transaction, so the lock is only held for a fraction of a second
        # at a time and other requests can interleave between chunks.
        CHUNK_SIZE = 1000
        for i in range(0, len(records), CHUNK_SIZE):
            QACallRecord.objects.bulk_create(
                records[i:i + CHUNK_SIZE],
                batch_size=500,
                update_conflicts=True,
                unique_fields=['campaign', 'contact_id'],
                update_fields=[
                    'customer', 'phone_number', 'agent_name', 'outcome',
                    'call_date', 'recording_key', 'recording_duration_seconds',
                ],
            )

        return len(records), timezone.now()
    finally:
        with _syncing_lock:
            _syncing_campaign_ids.discard(campaign.id)
