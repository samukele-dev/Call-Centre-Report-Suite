# backend/dashboard/qa_source.py
"""
Source-DB sync for the QA Review page's local cache (dashboard.QACallRecord).

Originally (and until this module was rewritten) this pulled each contact's
*current* state from cxm.cd_voice_meta (last_outcome_id/last_called) — one
row per contact, no history. That silently lost data: a contact QA Verified
last month and later called again for any reason (even just marked
"Answering Machine") would show only the newer outcome, with the QA Verify
gone from every count derived from that table — permanently, since
re-syncing only refreshes current state, it can't recover history that's
already been overwritten by a later call.

This now pulls from reporting.interaction_voice instead — a true
one-row-per-call log (external_source.fetch_qa_interactions), so QACallRecord
holds one row per historical interaction/disposition, not per contact. A
contact called twice with two different outcomes produces two rows, and
both are still there no matter how many times the contact is called again
after that.

reporting.interaction_voice has no campaign_id index (137M+ rows), so unlike
the old cxm-schema pull (fast, unbounded, no date filter needed), this one
must be windowed by date — see external_source.fetch_qa_interactions /
_run_windowed. A date range is still optional here (consistent with the
Campaign DB-sync date picker elsewhere in the app); when not given,
external_source.default_campaign_date_range() provides a bounded fallback
so an unbounded call never reaches the source DB as one unchunked query.
"""
import threading
from datetime import datetime as dt_class

from django.utils import timezone

from .external_source import (
    ExternalSourceError, default_campaign_date_range, fetch_qa_interactions,
)
from .models import QACallRecord

# Guards against two syncs for the same campaign running at once — e.g. a
# double-click, or the same campaign selected from two browser tabs. Without
# this, both requests independently run the full pull concurrently against
# the source DB, competing for the same disk I/O and making both far slower
# than either would be alone (observed in practice: three duplicate syncs
# for one 161k-row campaign, each still running after 5+ minutes,
# individually verified via pg_stat_activity as three identical queries
# stuck on DataFileRead — not stuck, just needlessly fighting each other).
# Process-local and in-memory is sufficient here: this app runs as a single
# Django dev server process, not multiple workers.
_syncing_campaign_ids = set()
_syncing_lock = threading.Lock()

# Django's bulk_create wraps *all* batches from a single call in one atomic
# transaction, regardless of batch_size. For a large window that means one
# continuous exclusive write lock on SQLite for the full duration — long
# enough to make every other request in the app fail with "database is
# locked" while it's running. Upserting in fixed-size slices instead gives
# each slice its own short-lived transaction, so the lock is only held for a
# fraction of a second at a time and other requests can interleave.
_UPSERT_CHUNK_SIZE = 1000


def sync_campaign_qa_cache(campaign, start_date=None, end_date=None, start_time=None, end_time=None):
    """
    Pull this campaign's interaction history from the source DB for the
    given range (or a bounded default when no range is given — see
    external_source.default_campaign_date_range) and upsert it into
    QACallRecord. Returns (records_synced, synced_at). Safe to call
    repeatedly, including with overlapping ranges: interactions are
    immutable historical facts once logged, so re-syncing the same window
    is just a no-op upsert (matched on campaign + interaction_id) and
    syncing a new window only adds rows — nothing is ever deleted here.
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
        # Building start_dt/end_dt: accept 'HH:MM' or 'HH:MM:SS' for the
        # optional time fields, same as every other date/time pair in this
        # app (see CampaignViewSet.sync_from_database).
        def _combine(date_str, time_str, default_time):
            if not date_str:
                return None
            raw = f"{date_str} {time_str or default_time}"
            fmt = '%Y-%m-%d %H:%M:%S' if (time_str or default_time).count(':') == 2 else '%Y-%m-%d %H:%M'
            dt = dt_class.strptime(raw, fmt)
            return timezone.make_aware(dt) if timezone.is_naive(dt) else dt

        start_dt = _combine(start_date, start_time, '00:00:00')
        end_dt = _combine(end_date, end_time, '23:59:59')

        if not start_dt or not end_dt:
            start_dt, end_dt = default_campaign_date_range(campaign)
            print(f"ℹ️  No date range given for QA sync of '{campaign.display_name}' — "
                  f"defaulting to {start_dt} .. {end_dt} (may take a while for a long history).")

        total_synced = 0

        def upsert_window(rows):
            nonlocal total_synced
            records = [
                QACallRecord(
                    campaign=campaign,
                    interaction_id=str(row['interaction_id']),
                    contact_id=str(row['contact_id']) if row['contact_id'] is not None else str(row['customer_id']),
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
            for i in range(0, len(records), _UPSERT_CHUNK_SIZE):
                QACallRecord.objects.bulk_create(
                    records[i:i + _UPSERT_CHUNK_SIZE],
                    batch_size=500,
                    update_conflicts=True,
                    unique_fields=['campaign', 'interaction_id'],
                    update_fields=[
                        'contact_id', 'customer', 'phone_number', 'agent_name', 'outcome',
                        'call_date', 'recording_key', 'recording_duration_seconds',
                    ],
                )
            total_synced += len(records)

        fetch_qa_interactions(campaign.cd_campaign_id, start_dt, end_dt, on_window=upsert_window)

        return total_synced, timezone.now()
    finally:
        with _syncing_lock:
            _syncing_campaign_ids.discard(campaign.id)
