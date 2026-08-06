# backend/dashboard/management/commands/check_records.py
from django.core.management.base import BaseCommand
from dashboard.models import ProcessedData, CallDataFile

class Command(BaseCommand):
    help = 'Check records in ProcessedData table'

    def handle(self, *args, **options):
        # Get all files
        files = CallDataFile.objects.all()
        
        for file in files:
            records_count = ProcessedData.objects.filter(call_data_file=file).count()
            self.stdout.write(
                f"📁 File: {file.original_name} (ID: {file.id})"
            )
            self.stdout.write(
                f"   Total in file: {file.total_records}"
            )
            self.stdout.write(
                f"   Saved to DB: {records_count}"
            )
            
            if file.total_records > 0 and records_count < file.total_records:
                missing = file.total_records - records_count
                percentage = (records_count / file.total_records) * 100
                self.stdout.write(
                    f"   ⚠️ Missing: {missing} records ({percentage:.1f}% saved)"
                )
            
            self.stdout.write("")