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
from datetime import datetime as dt_class, timedelta

from django.db import transaction
from django.utils import timezone

from .external_source import (
    ExternalSourceError, default_campaign_date_range, fetch_qa_interactions,
)
from .models import QACallRecord, QASyncWindow

# Windows closer together than this are treated as touching: a sync ending
# at 23:59:59 and the next one starting at 00:00:00 leave no real gap, and a
# view ending a few seconds after the last sync's "now" isn't worth flagging.
_ADJACENT_TOLERANCE = timedelta(seconds=1)
_MIN_REPORTED_GAP = timedelta(minutes=1)


def combine_date_time(date_str, time_str, default_time):
    """'YYYY-MM-DD' + optional 'HH:MM'/'HH:MM:SS' -> aware datetime (None if no date).
    Same parsing for the sync and the page's coverage check, so they agree on
    exactly what range a filter means."""
    if not date_str:
        return None
    raw = f"{date_str} {time_str or default_time}"
    fmt = '%Y-%m-%d %H:%M:%S' if (time_str or default_time).count(':') == 2 else '%Y-%m-%d %H:%M'
    dt = dt_class.strptime(raw, fmt)
    return timezone.make_aware(dt) if timezone.is_naive(dt) else dt


def _merge_intervals(intervals):
    """Sort and merge overlapping/touching (start, end) pairs."""
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + _ADJACENT_TOLERANCE:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _subtract_intervals(base, cuts):
    """The parts of the (start, end) pair `base` not covered by any pair in `cuts`."""
    gaps = []
    cursor = base[0]
    for c_start, c_end in _merge_intervals(cuts):
        if c_end < cursor:
            continue
        if c_start > base[1]:
            break
        if c_start > cursor:
            gaps.append((cursor, c_start))
        cursor = max(cursor, c_end)
    if cursor < base[1]:
        gaps.append((cursor, base[1]))
    return gaps


def _record_synced_window(campaign, start_dt, end_dt, skipped=()):
    """
    Record [start_dt, end_dt] minus any skipped sub-ranges as synced for this
    campaign, merging with existing windows so the table stays at a handful
    of rows per campaign.
    """
    new = _subtract_intervals((start_dt, end_dt), list(skipped))
    if not new:
        return
    with transaction.atomic():
        existing = list(QASyncWindow.objects.select_for_update().filter(campaign=campaign))
        merged = _merge_intervals([(w.start, w.end) for w in existing] + new)
        QASyncWindow.objects.filter(campaign=campaign).delete()
        QASyncWindow.objects.bulk_create(
            [QASyncWindow(campaign=campaign, start=s, end=e) for s, e in merged]
        )


def compute_coverage(campaign, start_dt, end_dt):
    """
    Which parts of [start_dt, end_dt] have NOT been synced for this campaign,
    as a list of (gap_start, gap_end). The range is clamped to now first —
    calls that haven't happened yet can't be missing. Gaps under a minute are
    ignored (see _MIN_REPORTED_GAP).
    """
    end_dt = min(end_dt, timezone.now())
    if start_dt >= end_dt:
        return []
    windows = [(w.start, w.end) for w in QASyncWindow.objects.filter(campaign=campaign)]
    return [g for g in _subtract_intervals((start_dt, end_dt), windows) if g[1] - g[0] >= _MIN_REPORTED_GAP]

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

# Campaign ids whose running sync has been asked to stop (QA page "Stop").
# Checked between source-DB windows, so a stop takes effect within one
# window's query (seconds) instead of the sync running to completion in the
# background after the browser has already given up on the request.
_cancel_requested_ids = set()


class SyncCancelled(Exception):
    """Raised inside a running sync when a stop was requested for it."""


def request_cancel(campaign_id):
    """Ask a running sync for this campaign to stop. Returns True if one was running."""
    with _syncing_lock:
        if campaign_id in _syncing_campaign_ids:
            _cancel_requested_ids.add(campaign_id)
            return True
    return False

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
        start_dt = combine_date_time(start_date, start_time, '00:00:00')
        end_dt = combine_date_time(end_date, end_time, '23:59:59')

        if not start_dt or not end_dt:
            start_dt, end_dt = default_campaign_date_range(campaign)
            print(f"ℹ️  No date range given for QA sync of '{campaign.display_name}' — "
                  f"defaulting to {start_dt} .. {end_dt} (may take a while for a long history).")

        total_synced = 0

        def upsert_window(rows):
            nonlocal total_synced
            if campaign.id in _cancel_requested_ids:
                raise SyncCancelled()
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
                    lead_reference=row['lead_reference'],
                    id_number=row['id_number'],
                    alt_phone_number=row['alt_phone_number'],
                    batch_name=row['batch_name'],
                    call_end=row['call_end'],
                    direction=row['direction'],
                    talk_seconds=int(row['talk_time'].total_seconds()) if row['talk_time'] else None,
                    extension=row['extension'],
                    hangup_user=row['hangup_user'],
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
                        'lead_reference', 'id_number', 'alt_phone_number', 'batch_name',
                        'call_end', 'direction', 'talk_seconds', 'extension', 'hangup_user',
                    ],
                )
            total_synced += len(records)

        skipped = []
        try:
            fetch_qa_interactions(campaign.cd_campaign_id, start_dt, end_dt, on_window=upsert_window, skipped_out=skipped)
        except ExternalSourceError:
            # fetch_qa_interactions wraps whatever its callback raised (see its
            # `except Exception`), so a stop surfaces as ExternalSourceError.
            if campaign.id in _cancel_requested_ids:
                raise SyncCancelled()
            raise
        # Only reached when the whole pull succeeded (a failure or a Stop
        # raises/aborts before here), so a partial sync is never recorded as
        # complete; ranges that timed out even at one-day granularity are
        # left out of the recorded window so the page keeps flagging them.
        _record_synced_window(campaign, start_dt, end_dt, skipped)

        return total_synced, timezone.now()
    finally:
        with _syncing_lock:
            _syncing_campaign_ids.discard(campaign.id)
            _cancel_requested_ids.discard(campaign.id)
