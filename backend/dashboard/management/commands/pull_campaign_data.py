# backend/dashboard/management/commands/pull_campaign_data.py
"""
Runs the "Sync from database" pull outside the API, for scheduling via
Windows Task Scheduler / cron, e.g.:

    python manage.py pull_campaign_data --all
    python manage.py pull_campaign_data --campaign prepaid-funeral
"""
from django.core.management.base import BaseCommand, CommandError

from dashboard.models import Campaign
from dashboard.external_source import sync_campaign_from_database, ExternalSourceError


class Command(BaseCommand):
    help = "Pull call data from the external source database for one or all campaigns with a cd_list_id configured."

    def add_arguments(self, parser):
        parser.add_argument(
            '--campaign', help='Campaign name (the internal "name" field) to sync. Omit to use --all.'
        )
        parser.add_argument(
            '--all', action='store_true', help='Sync every active campaign that has a cd_list_id set.'
        )

    def handle(self, *args, **options):
        if not options['campaign'] and not options['all']:
            raise CommandError('Pass --campaign <name> or --all.')

        if options['campaign']:
            campaigns = Campaign.objects.filter(name=options['campaign'])
            if not campaigns.exists():
                raise CommandError(f"No campaign found with name '{options['campaign']}'.")
        else:
            campaigns = Campaign.objects.filter(is_active=True).exclude(cd_list_id__isnull=True).exclude(cd_list_id='')

        if not campaigns:
            self.stdout.write(self.style.WARNING('No campaigns to sync (none have a cd_list_id set).'))
            return

        for campaign in campaigns:
            self.stdout.write(f"🔄 Syncing '{campaign.display_name}' (list {campaign.cd_list_id})...")
            try:
                instance = sync_campaign_from_database(campaign)
            except ExternalSourceError as e:
                self.stderr.write(self.style.ERROR(f"   ❌ {e}"))
                continue
            except Exception as e:
                self.stderr.write(self.style.ERROR(f"   ❌ Unexpected error: {e}"))
                continue

            self.stdout.write(self.style.SUCCESS(
                f"   ✅ {instance.processed_records}/{instance.total_records} records processed "
                f"(CallDataFile {instance.id})"
            ))
