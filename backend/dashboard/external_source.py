# backend/dashboard/external_source.py
"""
Pulls call data for a campaign directly from the call-centre platform's own
database (the one browsed via HeidiSQL), instead of requiring a manual
CSV/Excel upload.

The fetched rows are aliased to the exact column names the existing upload
pipeline already expects (see `column_mapping` in
CallDataFileSerializer._save_all_to_processed_data), written out as a
worksheet, and then run through that same pipeline (SimpleDataProcessor,
ProcessedData save, auto-report) so there is exactly one code path for
"data came in" regardless of source.
"""
import os

import pandas as pd
import pymysql
from django.conf import settings
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
from django.utils import timezone

from .models import CallDataFile

# Column aliases match column_mapping in
# CallDataFileSerializer._save_all_to_processed_data exactly, so the
# resulting DataFrame needs no further renaming before saving.
SOURCE_QUERY = """
SELECT
    cd.contactid                AS contact_id,
    cd.id                       AS customer_id,
    cd.lead_reference           AS lead_reference,
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
JOIN cxm.cd_voice_meta cvm  ON cvm.contact_data_id = cd.id
JOIN cnx_users.users uu     ON uu.id = cvm.last_user_id
JOIN cxm.outcomes oo        ON oo.id = cvm.last_outcome_id
JOIN cxm.cd_to_cd_lists cdl ON cdl.contact_data_id = cd.id
WHERE cdl.cd_list_id = %s
"""


class ExternalSourceError(Exception):
    """Raised for anything that stops a database sync (config, connection, empty result)."""


def _get_connection():
    cfg = settings.EXTERNAL_DB
    if not cfg.get('HOST') or not cfg.get('NAME') or not cfg.get('USER'):
        raise ExternalSourceError(
            "External database is not configured. Set SOURCE_DB_HOST, "
            "SOURCE_DB_NAME, SOURCE_DB_USER and SOURCE_DB_PASSWORD in "
            "backend/.env (see backend/.env.example)."
        )
    try:
        return pymysql.connect(
            host=cfg['HOST'],
            port=cfg['PORT'],
            user=cfg['USER'],
            password=cfg['PASSWORD'],
            database=cfg['NAME'],
            connect_timeout=15,
        )
    except pymysql.MySQLError as e:
        raise ExternalSourceError(f"Could not connect to the external database: {e}")


def fetch_call_data_from_source(cd_list_id):
    """Run SOURCE_QUERY for one list UUID and return a DataFrame ready for the upload pipeline."""
    if not cd_list_id:
        raise ExternalSourceError("No cd_list_id provided.")

    conn = _get_connection()
    try:
        df = pd.read_sql(SOURCE_QUERY, conn, params=(cd_list_id,))
    except Exception as e:
        raise ExternalSourceError(f"Query against external database failed: {e}")
    finally:
        conn.close()

    df = df.fillna('')
    df.insert(list(df.columns).index('lead_reference') + 1, 'list_id', cd_list_id)
    return df


def _default_user():
    user, created = User.objects.get_or_create(
        username='test_user',
        defaults={'email': 'test@example.com', 'is_active': True}
    )
    if created:
        user.set_password('test123')
        user.save()
    return user


def sync_campaign_from_database(campaign, user=None):
    """
    Pull this campaign's cd_list_id from the external DB and run it through
    the same processing/auto-report pipeline a CSV upload uses. Returns the
    resulting CallDataFile instance.
    """
    if not campaign.cd_list_id:
        raise ExternalSourceError(
            f"Campaign '{campaign.display_name}' has no cd_list_id configured."
        )

    df = fetch_call_data_from_source(campaign.cd_list_id)
    if df.empty:
        raise ExternalSourceError(
            f"No records returned from the external database for list "
            f"{campaign.cd_list_id}."
        )

    timestamp = timezone.now().strftime('%Y%m%d_%H%M%S')
    original_name = f"db_sync_{campaign.name}_{timestamp}.xlsx"

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
