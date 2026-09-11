# backend/dashboard/serializers.py - COMPLETE FIXED VERSION
from rest_framework import serializers
from django.contrib.auth.models import User
from django.db import transaction, IntegrityError
from .models import (
    OutcomeDescription, OutcomeSet, CallDataFile, ProcessedData,
    GeneratedReport, ReportTemplate, Campaign
)
import os
import pandas as pd
import numpy as np
from datetime import datetime
import traceback


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'username', 'email', 'first_name', 'last_name']


class OutcomeSetSerializer(serializers.ModelSerializer):
    descriptions_count = serializers.SerializerMethodField()
    campaigns_count = serializers.SerializerMethodField()

    class Meta:
        model = OutcomeSet
        fields = [
            'id', 'name', 'description',
            'descriptions_count', 'campaigns_count',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at']

    def get_descriptions_count(self, obj):
        return obj.descriptions.count()

    def get_campaigns_count(self, obj):
        return obj.campaigns.count()


class OutcomeDescriptionSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)
    created_by_email = serializers.CharField(source='created_by.email', read_only=True)
    outcome_set_name = serializers.CharField(source='outcome_set.name', read_only=True, default=None)

    class Meta:
        model = OutcomeDescription
        fields = [
            'id', 'last_outcome', 'description', 'outcome_set', 'outcome_set_name',
            'created_by', 'created_by_name', 'created_by_email',
            'created_at', 'updated_at', 'is_active'
        ]
        read_only_fields = ['created_by', 'created_at', 'updated_at']


class CallDataFileSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.username', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    campaign_name = serializers.CharField(
        source='campaign.display_name', read_only=True, allow_null=True
    )

    class Meta:
        model = CallDataFile
        fields = [
            'id', 'user', 'user_name', 'campaign', 'campaign_name', 'file',
            'file_size', 'total_records', 'processed_records',
            'status', 'status_display', 'uploaded_at', 'processed_at',
            'processing_errors', 'original_name',
            'delimiter', 'has_headers'
        ]
        read_only_fields = [
            'user', 'file_size', 'total_records', 'processed_records',
            'status', 'uploaded_at', 'processed_at', 'processing_errors',
            'original_name'
        ]

    def create(self, validated_data):
        request = self.context.get('request')

        print("=" * 50)
        print("📤 FILE UPLOAD REQUEST RECEIVED")
        print(f"Request data keys: {list(request.data.keys())}")
        print(f"Campaign from request: {request.data.get('campaign')}")

        # Extract file
        file_obj = validated_data.get('file')
        if not file_obj:
            raise serializers.ValidationError({"file": "No file provided"})

        # Get delimiter and has_headers
        delimiter = request.data.get('delimiter', ',') if request else ','
        has_headers_str = request.data.get('has_headers', 'true') if request else 'true'
        has_headers = has_headers_str.lower() == 'true'

        # Resolve campaign — accept 'campaign' or 'campaign_id'
        campaign_id = (
            request.data.get('campaign_id') or
            request.data.get('campaign')
        ) if request else None

        campaign = None
        if campaign_id:
            try:
                campaign = Campaign.objects.get(id=campaign_id)
                print(f"✅ Campaign found: {campaign.display_name} (ID: {campaign_id})")
            except Campaign.DoesNotExist:
                print(f"❌ Campaign with ID {campaign_id} not found")
            except Exception as e:
                print(f"❌ Error getting campaign: {e}")

        # Resolve user
        user = request.user if request and request.user.is_authenticated else None
        if not user:
            user, created = User.objects.get_or_create(
                username='test_user',
                defaults={'email': 'test@example.com', 'is_active': True}
            )
            if created:
                user.set_password('test123')
                user.save()

        # Create the file record
        instance = CallDataFile.objects.create(
            user=user,
            campaign=campaign,
            file=file_obj,
            original_name=file_obj.name,
            file_size=file_obj.size,
            delimiter=delimiter,
            has_headers=has_headers,
            status='uploaded'
        )

        print(f"✅ File created with ID: {instance.id}")
        print(f"📁 Campaign: {instance.campaign}")
        print("=" * 50)

        self._start_processing(instance)
        return instance

    def _start_processing(self, instance):
        try:
            instance.status = 'processing'
            instance.save()
            self._process_file_sync(instance)
        except Exception as e:
            instance.status = 'failed'
            instance.processing_errors = str(e)
            instance.save()

    def _process_file_sync(self, instance):
        try:
            from .views import SimpleDataProcessor
            from django.utils import timezone
            from django.conf import settings

            processor = SimpleDataProcessor()

            file_ext = os.path.splitext(instance.original_name)[1].lower()
            file_type = 'csv' if file_ext == '.csv' else 'excel'

            print(f"🔄 Processing file: {instance.original_name}")
            print(f"📊 File type: {file_type}, delimiter: {instance.delimiter}")

            processed_df = processor.process_call_data(
                instance.file.path,
                instance.user,
                file_type=file_type,
                delimiter=instance.delimiter,
                has_headers=instance.has_headers,
                campaign=instance.campaign
            )

            print(f"✅ Data processed: {len(processed_df)} rows, {len(processed_df.columns)} columns")
            print(f"📋 Columns: {list(processed_df.columns)}")

            # Save a processed copy to disk. CSV, not .xlsx: XLSX caps a sheet
            # at 1,048,576 rows (a hard limit of the file format, not
            # something openpyxl/pandas can be configured past), and a large
            # db-synced campaign can exceed that. CSV has no such ceiling.
            output_dir = os.path.join(settings.MEDIA_ROOT, 'processed_files')
            os.makedirs(output_dir, exist_ok=True)
            original_name_without_ext = os.path.splitext(instance.original_name)[0]
            output_path = os.path.join(output_dir, f"processed_{original_name_without_ext}.csv")
            processed_df.to_csv(output_path, index=False)

            records_saved = self._save_all_to_processed_data(instance, processed_df)

            instance.status = 'processed'
            instance.total_records = len(processed_df)
            instance.processed_records = records_saved
            instance.processed_at = timezone.now()
            instance.save()

            print(f"✅ Saved {records_saved} / {len(processed_df)} records")

            # ── AUTO-GENERATE the full 4-sheet report ──────────────────
            # Triggered immediately after file processing so the report
            # is ready by the time the user navigates to the Reports page.
            try:
                from .views import ReportViewSet
                print(f"🚀 Auto-generating full report for campaign "
                      f"{instance.campaign_id}...")
                ReportViewSet._auto_generate_full_report(instance)
                print(f"✅ Auto-report generation complete.")
            except Exception as auto_err:
                # Never fail the upload just because report generation failed
                print(f"⚠️  Auto-report failed (non-fatal): {auto_err}")
                import traceback as _tb
                _tb.print_exc()

        except Exception as e:
            print(f"❌ Error processing file: {e}")
            traceback.print_exc()
            instance.status = 'failed'
            instance.processing_errors = str(e)
            instance.save()
            raise

    def _save_all_to_processed_data(self, instance, processed_df):
        try:
            from .models import ProcessedData

            n_rows = len(processed_df)
            print(f"💾 Saving {n_rows} records to database...")

            deleted_count, _ = ProcessedData.objects.filter(call_data_file=instance).delete()
            print(f"🧹 Cleared {deleted_count} existing records for file {instance.id}")

            column_mapping = {
                'contact_id': 'contact_id',
                'customer_id': 'customer_id',
                'lead_reference': 'lead_reference',
                'list_id': 'list_id',
                'list_name': 'list_name',
                'title': 'title',
                'firstname': 'firstname',
                'lastname': 'lastname',
                'gender': 'gender',
                'last_outcome': 'last_outcome',
                'Description': 'outcome_description',
                'called_count': 'called_count',
                'last_called_date': 'last_called_date',
                'last_user': 'last_user',
                'created_at': 'created_at',
                'updated_at': 'updated_at',
                'address1': 'address1',
                'address2': 'address2',
                'address3': 'address3',
                'town': 'town',
                'county': 'county',
                'country': 'country',
                'postcode': 'postcode',
                'email_address': 'email_address',
                'tel1': 'tel1',
                'tel2': 'tel2',
                'tel3': 'tel3',
                'tel4': 'tel4',
                'tel5': 'tel5',
                'tel6': 'tel6',
                'owner_username': 'owner_username',
                'security_phrase': 'security_phrase',
                'source_reference': 'source_reference',
                'industry': 'industry',
                'company_name': 'company_name',
                'website': 'website',
                'customer_reference': 'customer_reference',
                'dob': 'dob',
            }

            # ------------------------------------------------------------------
            # Column-level (vectorized) prep, replacing the per-cell work that
            # used to run inside df.iterrows() below — including a fresh
            # pd.to_datetime() call for every single date cell. That's why a
            # big campaign sync (e.g. telkom-lte, hundreds of thousands of
            # rows) could run 30+ minutes and still not finish: the same
            # parsing now runs once per COLUMN instead of once per CELL, which
            # is orders of magnitude fewer Python-level operations for the
            # same result.
            # ------------------------------------------------------------------
            df = processed_df

            for date_col in ('last_called_date', 'created_at', 'updated_at'):
                if date_col in df.columns:
                    df[date_col] = pd.to_datetime(df[date_col], errors='coerce')

            if 'dob' in df.columns:
                df['dob'] = pd.to_datetime(df['dob'], errors='coerce').dt.date

            if 'called_count' in df.columns:
                df['called_count'] = pd.to_numeric(df['called_count'], errors='coerce').fillna(0).astype(int)

            if 'email_address' in df.columns:
                email = df['email_address'].astype(str).str.strip()
                has_at = email.str.contains('@', na=False)
                df['email_address'] = email.where(has_at, None).str.slice(0, 254)

            if 'website' in df.columns:
                website = df['website'].astype(str).str.strip()
                has_value = website.ne('')
                needs_scheme = has_value & ~website.str.startswith(('http://', 'https://'))
                website = website.where(~needs_scheme, 'http://' + website)
                df['website'] = website.where(has_value, None).str.slice(0, 500)

            specially_handled = {
                'last_called_date', 'created_at', 'updated_at', 'dob',
                'called_count', 'email_address', 'website',
            }
            wide_fields = {'list_name', 'company_name'}
            for df_col, model_field in column_mapping.items():
                if df_col not in df.columns or model_field in specially_handled:
                    continue
                max_length = 500 if model_field in wide_fields else 255
                df[df_col] = df[df_col].astype(str).str.strip().str.slice(0, max_length)

            if 'contact_id' in df.columns:
                missing = df['contact_id'].isna() | (df['contact_id'] == '')
                df.loc[missing, 'contact_id'] = [f"ID_{i}" for i in df.index[missing]]
            if 'last_outcome' in df.columns:
                missing_outcome = df['last_outcome'].isna() | (df['last_outcome'] == '')
                df.loc[missing_outcome, 'last_outcome'] = 'UNKNOWN'

            records = df.to_dict('records')

            processed_records = []
            records_saved = 0
            batch_size = 1000
            errors = []

            # One transaction for the whole sync instead of one auto-committed
            # transaction per batch (the old behaviour, with batch_size=500):
            # SQLite fsyncs on every commit, so a large sync used to pay that
            # cost hundreds or thousands of times over. This pays it once.
            with transaction.atomic():
                for index, row in enumerate(records):
                    try:
                        kwargs = {'call_data_file': instance}
                        for df_col, model_field in column_mapping.items():
                            if df_col not in row:
                                continue
                            value = row[df_col]
                            if value is None or value == '' or pd.isna(value):
                                continue
                            kwargs[model_field] = value

                        if not kwargs.get('contact_id'):
                            kwargs['contact_id'] = f"ID_{index}"
                        if not kwargs.get('last_outcome'):
                            kwargs['last_outcome'] = 'UNKNOWN'

                        processed_records.append(ProcessedData(**kwargs))
                        records_saved += 1

                        if records_saved % 20000 == 0:
                            print(f"⏳ Processed {records_saved} records...")

                        if len(processed_records) >= batch_size:
                            ProcessedData.objects.bulk_create(processed_records, ignore_conflicts=True)
                            processed_records = []

                    except Exception as row_error:
                        errors.append(f"Row {index}: {str(row_error)}")
                        if len(errors) <= 10:
                            print(f"⚠️ Error in row {index}: {row_error}")
                        continue

                if processed_records:
                    ProcessedData.objects.bulk_create(processed_records, ignore_conflicts=True)

            if errors:
                print(f"⚠️ Total errors during save: {len(errors)}")
                for err in errors[:10]:
                    print(f"  - {err}")

            print(f"✅ Saved {records_saved} records to ProcessedData table")
            return records_saved

        except Exception as e:
            print(f"❌ Error saving to ProcessedData table: {e}")
            traceback.print_exc()
            return 0


class ProcessedDataSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProcessedData
        fields = '__all__'
        read_only_fields = ['processed_at']


class GeneratedReportSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.username', read_only=True)
    report_type_display = serializers.CharField(source='get_report_type_display', read_only=True)
    campaign_name = serializers.CharField(
        source='campaign.display_name', read_only=True, allow_null=True
    )

    class Meta:
        model = GeneratedReport
        fields = [
            'id', 'user', 'user_name', 'campaign', 'campaign_name',
            'report_type', 'report_type_display', 'generated_at', 'file',
            'parameters', 'is_downloaded', 'download_count'
        ]
        read_only_fields = ['user', 'generated_at', 'is_downloaded', 'download_count']


class FileUploadSerializer(serializers.Serializer):
    file = serializers.FileField()
    description = serializers.CharField(required=False, allow_blank=True)


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(write_only=True)


class ReportTemplateSerializer(serializers.ModelSerializer):
    uploaded_by_name = serializers.SerializerMethodField()
    template_url = serializers.SerializerMethodField()
    campaign_name = serializers.CharField(
        source='campaign.display_name', read_only=True, allow_null=True
    )

    class Meta:
        model = ReportTemplate
        fields = '__all__'
        read_only_fields = ['uploaded_by', 'uploaded_at', 'sheet_names']

    def get_uploaded_by_name(self, obj):
        return obj.uploaded_by.username if obj.uploaded_by else 'System'

    def get_template_url(self, obj):
        return obj.template_file.url if obj.template_file else None

    def create(self, validated_data):
        request = self.context.get('request')
        file = request.FILES.get('file') if request else None

        if not file:
            raise serializers.ValidationError({"file": "No file provided"})

        # FIX: resolve campaign from request — accept 'campaign_id' or 'campaign'
        campaign_id = (
            request.data.get('campaign_id') or
            request.data.get('campaign')
        ) if request else None

        campaign = None
        if campaign_id:
            try:
                campaign = Campaign.objects.get(id=campaign_id, is_active=True)
                print(f"✅ Template linked to campaign: {campaign.display_name}")
            except Campaign.DoesNotExist:
                print(f"⚠️ Campaign ID {campaign_id} not found — template will be unscoped")

        instance = ReportTemplate.objects.create(
            name=validated_data.get('name'),
            description=validated_data.get('description', ''),
            template_file=file,
            campaign=campaign,          # FIX: now saved
            uploaded_by=(
                request.user
                if request and request.user and request.user.is_authenticated
                else None
            ),
        )

        return instance


class CampaignSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)
    data_files_count = serializers.SerializerMethodField()
    reports_count = serializers.SerializerMethodField()
    templates_count = serializers.SerializerMethodField()
    outcome_set_name = serializers.CharField(source='outcome_set.name', read_only=True, default=None)

    class Meta:
        model = Campaign
        fields = [
            'id', 'name', 'display_name', 'description', 'sheet_name',
            'cd_campaign_id', 'outcome_set', 'outcome_set_name',
            'is_active', 'created_at', 'updated_at', 'created_by', 'created_by_name',
            'data_files_count', 'reports_count', 'templates_count'
        ]
        read_only_fields = ['created_at', 'updated_at', 'created_by']

    def get_data_files_count(self, obj):
        return obj.data_files.count()

    def get_reports_count(self, obj):
        return obj.reports.count()

    def get_templates_count(self, obj):
        return obj.templates.count()