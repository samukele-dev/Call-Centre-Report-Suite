# backend/dashboard/management/commands/import_source_campaigns.py
"""
Pulls every campaign from the external call-centre database (cxm.campaigns)
and creates/updates matching local Campaign rows, so they show up on the
frontend's Campaigns page without being created by hand one at a time.

    python manage.py import_source_campaigns
    python manage.py import_source_campaigns --include-inactive=false
"""
import re

from django.core.management.base import BaseCommand
from django.db import IntegrityError

from dashboard.models import Campaign
from dashboard.external_source import _get_connection, ExternalSourceError


def _slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', name.strip().lower()).strip('-')
    return slug[:100] or 'campaign'


def _unique_name(base_slug, taken):
    slug = base_slug
    n = 2
    while slug in taken:
        suffix = f'-{n}'
        slug = f'{base_slug[:100 - len(suffix)]}{suffix}'
        n += 1
    taken.add(slug)
    return slug


class Command(BaseCommand):
    help = "Import all campaigns from the external source database's cxm.campaigns table."

    def add_arguments(self, parser):
        parser.add_argument(
            '--include-inactive', default='true',
            help="Import 'inactive' source campaigns too, not just 'active' ones (default: true). "
                 "'deleted' source campaigns are never imported."
        )

    def handle(self, *args, **options):
        include_inactive = options['include_inactive'].lower() not in ('false', '0', 'no')

        try:
            conn = _get_connection()
        except ExternalSourceError as e:
            self.stderr.write(self.style.ERROR(str(e)))
            return

        try:
            cur = conn.cursor()
            statuses = ['active', 'inactive'] if include_inactive else ['active']
            cur.execute(
                "SELECT id, name, rstatus::text FROM cxm.campaigns WHERE rstatus::text = ANY(%s) ORDER BY name;",
                (statuses,)
            )
            source_campaigns = cur.fetchall()
        finally:
            conn.close()

        existing_by_cd_id = {
            c.cd_campaign_id: c
            for c in Campaign.objects.exclude(cd_campaign_id__isnull=True).exclude(cd_campaign_id='')
        }
        taken_names = set(Campaign.objects.values_list('name', flat=True))

        created, updated, skipped = 0, 0, 0

        for source_id, raw_name, rstatus in source_campaigns:
            name = raw_name.strip()
            is_active = rstatus == 'active'
            source_id = str(source_id)

            existing = existing_by_cd_id.get(source_id)
            if existing:
                if existing.display_name != name or existing.is_active != is_active:
                    existing.display_name = name
                    existing.is_active = is_active
                    existing.save()
                    updated += 1
                else:
                    skipped += 1
                continue

            slug = _unique_name(_slugify(name), taken_names)
            try:
                Campaign.objects.create(
                    name=slug,
                    display_name=name,
                    sheet_name=name,
                    description=f"Imported from source database campaign '{name}'.",
                    cd_campaign_id=source_id,
                    is_active=is_active,
                )
                created += 1
            except IntegrityError as e:
                self.stderr.write(self.style.ERROR(f"   ❌ Failed to create '{name}': {e}"))

        self.stdout.write(self.style.SUCCESS(
            f"Done. Created {created}, updated {updated}, unchanged {skipped} "
            f"(of {len(source_campaigns)} source campaigns considered)."
        ))
