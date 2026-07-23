# backend/dashboard/serializers.py - COMPLETE FIXED VERSION
from rest_framework import serializers
from django.contrib.auth.models import User
from django.db import transaction, IntegrityError
from .models import (
    OutcomeDescription, CallDataFile, ProcessedData,
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


class OutcomeDescriptionSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source='created_by.username', read_only=True)
    created_by_email = serializers.CharField(source='created_by.email', read_only=True)

    class Meta:
        model = OutcomeDescription
        fields = [
            'id', 'last_outcome', 'description',
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
                has_headers=instance.has_headers
            )

            print(f"✅ Data processed: {len(processed_df)} rows, {len(processed_df.columns)} columns")
            print(f"📋 Columns: {list(processed_df.columns)}")

            # Save Excel copy
            output_dir = os.path.join(settings.MEDIA_ROOT, 'processed_files')
            os.makedirs(output_dir, exist_ok=True)
            original_name_without_ext = os.path.splitext(instance.original_name)[0]
            output_path = os.path.join(output_dir, f"processed_{original_name_without_ext}.xlsx")
            processed_df.to_excel(output_path, index=False)

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

            print(f"💾 Saving {len(processed_df)} records to database...")

            deleted_count, _ = ProcessedData.objects.filter(call_data_file=instance).delete()
            print(f"🧹 Cleared {deleted_count} existing records for file {instance.id}")

            processed_records = []
            records_saved = 0
            batch_size = 500
            errors = []

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

            for index, row in processed_df.iterrows():
                try:
                    processed_data = ProcessedData(call_data_file=instance)

                    for df_col, model_field in column_mapping.items():
                        if df_col not in processed_df.columns:
                            continue
                        value = row[df_col]
                        if pd.isna(value):
                            continue

                        try:
                            if model_field in ['last_called_date', 'created_at', 'updated_at']:
                                if value and str(value).strip():
                                    dt_value = pd.to_datetime(value, errors='coerce')
                                    if pd.notna(dt_value):
                                        setattr(processed_data, model_field, dt_value.to_pydatetime())

                            elif model_field == 'dob':
                                if value and str(value).strip():
                                    dt_value = pd.to_datetime(value, errors='coerce')
                                    if pd.notna(dt_value):
                                        setattr(processed_data, model_field, dt_value.date())

                            elif model_field == 'called_count':
                                try:
                                    setattr(processed_data, model_field, int(float(value)))
                                except Exception:
                                    setattr(processed_data, model_field, 0)

                            elif model_field == 'email_address':
                                if value and '@' in str(value):
                                    setattr(processed_data, model_field, str(value).strip()[:254])

                            elif model_field == 'website':
                                if value and str(value).strip():
                                    url_str = str(value).strip()
                                    if not url_str.startswith(('http://', 'https://')):
                                        url_str = 'http://' + url_str
                                    setattr(processed_data, model_field, url_str[:500])

                            elif model_field in [
                                'address1', 'address2', 'address3',
                                'security_phrase', 'outcome_description'
                            ]:
                                setattr(processed_data, model_field, str(value).strip())

                            else:
                                str_value = str(value).strip()
                                max_length = 500 if model_field in ['list_name', 'company_name'] else 255
                                setattr(processed_data, model_field, str_value[:max_length])

                        except Exception as field_error:
                            print(f"⚠️ Field error for {model_field}: {field_error}")
                            continue

                    if not processed_data.contact_id:
                        processed_data.contact_id = f"ID_{index}"
                    if not processed_data.last_outcome:
                        processed_data.last_outcome = 'UNKNOWN'

                    processed_records.append(processed_data)
                    records_saved += 1

                    if records_saved % 1000 == 0:
                        print(f"⏳ Processed {records_saved} records...")

                    if len(processed_records) >= batch_size:
                        try:
                            ProcessedData.objects.bulk_create(processed_records, ignore_conflicts=True)
                            processed_records = []
                        except Exception as bulk_error:
                            print(f"⚠️ Batch save error: {bulk_error}")
                            for record in processed_records:
                                try:
                                    record.save()
                                except Exception as e:
                                    errors.append(f"Record {index}: {e}")
                            processed_records = []

                except Exception as row_error:
                    errors.append(f"Row {index}: {str(row_error)}")
                    if len(errors) <= 10:
                        print(f"⚠️ Error in row {index}: {row_error}")
                    continue

            if processed_records:
                try:
                    ProcessedData.objects.bulk_create(processed_records, ignore_conflicts=True)
                except Exception as e:
                    print(f"⚠️ Final batch save error: {e}")
                    for record in processed_records:
                        try:
                            record.save()
                        except Exception:
                            pass

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

    class Meta:
        model = Campaign
        fields = [
            'id', 'name', 'display_name', 'description', 'sheet_name',
            'cd_list_id',
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