# backend/dashboard/views.py - COMPLETE FIXED VERSION WITH CAMPAIGN SYNC
from xlsxwriter.utility import xl_rowcol_to_cell
from django.conf import settings
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.authtoken.models import Token
from django.utils import timezone
from rest_framework import viewsets, status, generics, mixins
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.parsers import MultiPartParser, FormParser
from django.shortcuts import get_object_or_404
from django.http import HttpResponse, JsonResponse, HttpRequest
from django.contrib.auth.models import User
from django.db.models import Q, Count, Sum, Avg, Max
from django.db import IntegrityError
import pandas as pd
import numpy as np
from io import BytesIO, StringIO
import json
import os
import re
import uuid
from datetime import datetime, timedelta
import csv
import xlsxwriter
import openpyxl
from openpyxl.utils import get_column_letter
import traceback
from openpyxl import load_workbook

from .models import (
    OutcomeDescription, OutcomeSet, CallDataFile, ProcessedData,
    GeneratedReport, ReportTemplate, Campaign, QACallRecord
)
from .serializers import (
    OutcomeDescriptionSerializer, OutcomeSetSerializer, CallDataFileSerializer,
    ProcessedDataSerializer, GeneratedReportSerializer,
    ReportTemplateSerializer, FileUploadSerializer, CampaignSerializer
)


# ===========================================================
# AUTH VIEWS
# ===========================================================

class CustomAuthToken(ObtainAuthToken):
    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(
            data=request.data, context={'request': request}
        )
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data['user']
        token, created = Token.objects.get_or_create(user=user)
        return Response({
            'token': token.key,
            'user_id': user.pk,
            'username': user.username,
            'email': user.email
        })


@api_view(['POST'])
@permission_classes([AllowAny])
def register_user(request):
    """Register a new user"""
    username = request.data.get('username')
    email = request.data.get('email')
    password = request.data.get('password')

    if not all([username, email, password]):
        return Response({'error': 'All fields are required'}, status=400)
    if User.objects.filter(username=username).exists():
        return Response({'error': 'Username already exists'}, status=400)
    if User.objects.filter(email=email).exists():
        return Response({'error': 'Email already exists'}, status=400)

    user = User.objects.create_user(username=username, email=email, password=password)
    user.is_active = True
    user.save()
    token = Token.objects.create(user=user)

    return Response({
        'message': 'User created successfully',
        'token': token.key,
        'user_id': user.id,
        'username': user.username,
        'email': user.email
    })


@api_view(['GET'])
@permission_classes([AllowAny])
def verify_token(request):
    """Verify if the token is valid"""
    return Response({
        'valid': True,
        'user': {
            'username': request.user.username,
            'email': request.user.email,
        }
    })


# ===========================================================
# DATA PROCESSOR
# ===========================================================

def _build_outcome_map(campaign):
    """
    last_outcome -> description lookup, strictly scoped to this campaign's
    assigned OutcomeSet. No fallback across sets: a campaign with no
    outcome_set assigned, or a code missing from its set, resolves to
    nothing here (callers fall back to showing the raw code).
    """
    if not campaign or not campaign.outcome_set_id:
        return {}
    return {
        o.last_outcome: o.description
        for o in OutcomeDescription.objects.filter(outcome_set_id=campaign.outcome_set_id)
    }


# id_number is an acronym, not a regular word — field.replace('_', ' ').title()
# would otherwise render it as "Id Number" on Processed Data sheet headers.
COLUMN_HEADER_OVERRIDES = {'id_number': 'ID Number'}


def _column_header(field_name):
    return COLUMN_HEADER_OVERRIDES.get(field_name, field_name.replace('_', ' ').title())


class SimpleDataProcessor:
    @staticmethod
    def process_call_data(file_path, user, file_type='excel', delimiter=',', has_headers=True, campaign=None):
        """Process call data file and add Description column after last_outcome"""
        try:
            print(f"📁 Processing file: {file_path}")
            file_ext = os.path.splitext(file_path)[1].lower()

            if file_ext == '.csv':
                print("🔍 Examining CSV file structure...")
                with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                    first_line = f.readline().strip()
                    second_line = f.readline().strip()
                    header_cols = first_line.split(delimiter)
                    print(f"🔢 Columns detected: {len(header_cols)}")
                    print(f"📋 Columns: {header_cols}")

                try:
                    read_kwargs = dict(
                        delimiter=delimiter, dtype=str, encoding='utf-8',
                        on_bad_lines='warn', quotechar='"',
                        skipinitialspace=True, keep_default_na=False
                    )
                    if has_headers:
                        df = pd.read_csv(file_path, **read_kwargs)
                    else:
                        df = pd.read_csv(file_path, header=None, **read_kwargs)
                except Exception:
                    read_kwargs['engine'] = 'python'
                    if has_headers:
                        df = pd.read_csv(file_path, **read_kwargs)
                    else:
                        df = pd.read_csv(file_path, header=None, **read_kwargs)
            else:
                df = pd.read_excel(file_path, dtype=str, keep_default_na=False)

            df.columns = [str(col).strip() for col in df.columns]
            df = df.fillna('')

            # Normalise last_outcome column
            last_outcome_col = None
            for col in df.columns:
                if 'last_outcome' in col.lower():
                    last_outcome_col = col
                    break
            if not last_outcome_col:
                for col in df.columns:
                    if any(t in col.lower() for t in ['outcome', 'result', 'status', 'disposition']):
                        last_outcome_col = col
                        break

            if last_outcome_col and last_outcome_col != 'last_outcome':
                df = df.rename(columns={last_outcome_col: 'last_outcome'})
            elif not last_outcome_col:
                df['last_outcome'] = ''

            # Normalise contact_id column
            contact_id_col = None
            for col in df.columns:
                if 'contact_id' in col.lower() or col.lower() == 'contact':
                    contact_id_col = col
                    break
            if contact_id_col and contact_id_col != 'contact_id':
                df = df.rename(columns={contact_id_col: 'contact_id'})
            elif not contact_id_col:
                df['contact_id'] = [f"ID_{i + 1}" for i in range(len(df))]

            # Normalise ID/passport number column. The DB-synced path
            # (external_source.SOURCE_QUERY_TEMPLATE) already COALESCEs across
            # every spelling observed on the source DB — 'idn', 'id_num',
            # 'idno', 'id_no', 'idnumber', 'id_number' — for the same reason:
            # different campaigns (and upload batches within a campaign) use
            # different lead-form field names for a contact's 13-digit ID
            # number. Manually uploaded sheets carry that same variance, so
            # match on the same spellings here (case/spacing/underscore
            # insensitive) rather than requiring an exact 'id_number' header.
            id_number_aliases = {'idn', 'idnum', 'idno', 'idnumber'}
            id_number_col = None
            for col in df.columns:
                if re.sub(r'[^a-z0-9]', '', col.lower()) in id_number_aliases:
                    id_number_col = col
                    break
            if id_number_col and id_number_col != 'id_number':
                df = df.rename(columns={id_number_col: 'id_number'})

            # Build outcome map — strictly scoped to this campaign's outcome
            # set (see _build_outcome_map). No cross-set fallback: a code
            # missing from the set just shows its raw value below.
            outcome_map = _build_outcome_map(campaign)
            print(f"📚 Loaded {len(outcome_map)} outcome descriptions"
                  f"{f' for outcome set {campaign.outcome_set_id}' if campaign and campaign.outcome_set_id else ' (no outcome set assigned)'}")

            # Insert Description column right after last_outcome
            if 'last_outcome' in df.columns:
                col_idx = list(df.columns).index('last_outcome') + 1

                def get_description(outcome_code):
                    if outcome_code is None or str(outcome_code).strip() == '':
                        return ''
                    value_str = str(outcome_code)
                    return outcome_map.get(value_str, value_str)

                df.insert(col_idx, 'Description', df['last_outcome'].apply(get_description))

            print(f"✅ Processed {len(df)} records")
            return df

        except Exception as e:
            print(f"❌ Error processing file {file_path}: {e}")
            traceback.print_exc()
            raise Exception(f"Error processing file {file_path}: {e}")


DataProcessor = SimpleDataProcessor


# ===========================================================
# CALL DATA FILE VIEWSET
# ===========================================================

class CallDataFileViewSet(viewsets.ModelViewSet):
    """Manage call data file uploads"""
    serializer_class = CallDataFileSerializer
    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_queryset(self):
        queryset = CallDataFile.objects.all().order_by('-uploaded_at')
        campaign_id = self.request.query_params.get('campaign_id')
        if campaign_id:
            queryset = queryset.filter(campaign_id=campaign_id)
        return queryset

    def perform_create(self, serializer):
        serializer.save()

    @action(detail=True, methods=['get'])
    def preview(self, request, pk=None):
        """Preview processed data"""
        try:
            file_obj = self.get_object()
            processed_data = ProcessedData.objects.filter(call_data_file=file_obj)

            if not processed_data.exists():
                return Response(
                    {'success': False, 'error': 'No processed data found for this file'},
                    status=status.HTTP_404_NOT_FOUND
                )

            data = []
            for record in processed_data[:100]:
                row = {
                    'contact_id': record.contact_id,
                    'last_outcome': record.last_outcome,
                    'Description': record.outcome_description
                }
                data.append(row)

            return Response({
                'success': True,
                'data': {
                    'columns': list(data[0].keys()) if data else [],
                    'data': data,
                    'total_records': processed_data.count()
                }
            })
        except Exception as e:
            traceback.print_exc()
            return Response({'success': False, 'error': str(e)},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=True, methods=['get'], url_path='download_processed')
    def download_processed(self, request, pk=None):
        """Download the processed version of a file as Excel"""
        try:
            file_obj = self.get_object()
            processed_data = ProcessedData.objects.filter(
                call_data_file=file_obj
            ).order_by('id')

            if not processed_data.exists():
                return Response(
                    {'success': False, 'error': 'No processed data found for this file.'},
                    status=status.HTTP_404_NOT_FOUND
                )

            field_names = [
                f.name for f in ProcessedData._meta.fields
                if f.name not in ['id', 'call_data_file', 'processed_at', 'outcome_description']
            ]

            data = []
            for record in processed_data:
                row = {}
                for field in field_names:
                    value = getattr(record, field, None)
                    if value is not None and value != '':
                        row[field] = value.strftime('%Y-%m-%d %H:%M:%S') if hasattr(value, 'strftime') else value
                    else:
                        row[field] = ''
                data.append(row)

            df = pd.DataFrame(data)
            descriptions = [record.outcome_description or '' for record in processed_data]

            columns = list(df.columns)
            last_outcome_pos = next(
                (i for i, col in enumerate(columns) if col == 'last_outcome'), -1
            )
            if last_outcome_pos != -1:
                df.insert(last_outcome_pos + 1, 'Description', descriptions)
            else:
                df['Description'] = descriptions

            base_name = os.path.splitext(file_obj.original_name or 'data')[0]

            # XLSX caps a sheet at 1,048,576 rows (a hard limit of the file
            # format itself, not something openpyxl/pandas can be configured
            # past — see the same ceiling hit during db sync). A campaign
            # this large can't fit in one sheet, so fall back to CSV, which
            # has no such ceiling, rather than 500ing on the download.
            if len(df) > 2**20 - 1:
                output = df.to_csv(index=False).encode('utf-8')
                response = HttpResponse(output, content_type='text/csv')
                response['Content-Disposition'] = f'attachment; filename="{base_name}_processed.csv"'
                return response

            output = BytesIO()
            with pd.ExcelWriter(output, engine='openpyxl') as writer:
                df.to_excel(writer, sheet_name='Processed Data', index=False)
            output.seek(0)

            response = HttpResponse(
                output.getvalue(),
                content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            )
            response['Content-Disposition'] = f'attachment; filename="{base_name}_processed.xlsx"'
            return response

        except CallDataFile.DoesNotExist:
            return Response({'success': False, 'error': 'File not found'},
                            status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            traceback.print_exc()
            return Response({'success': False, 'error': f'Error generating file: {e}'},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    
    # ============================================================
    # ADD THE export_formatted ACTION HERE
    # ============================================================
    @action(detail=False, methods=['get'], url_path='export_formatted')
    def export_formatted(self, request):
        """
        Export processed data in the specified format with custom columns.
        GET /api/files/export_formatted/?campaign_id=X&file_id=Y
        
        Returns Excel file with columns:
        firstname, lastname, contact_id, Client ID number, Contact, 
        Right party contact, Presentation, Sale, Policy number,
        Disposition, Call attempts, Campaign, FICA Reference,
        Contact Number, IMEI, Agent Name, LastCall Date, batch, Product Sold
        """
        from io import BytesIO
        import pandas as pd
        from django.db.models import Q
        from datetime import datetime
        
        try:
            campaign_id = request.query_params.get('campaign_id')
            file_id = request.query_params.get('file_id')
            
            # Query processed data
            qs = ProcessedData.objects.all()
            
            if file_id:
                qs = qs.filter(call_data_file_id=file_id)
            elif campaign_id:
                qs = qs.filter(call_data_file__campaign_id=campaign_id)
            else:
                return Response(
                    {'error': 'Either campaign_id or file_id is required'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            qs = qs.order_by('-last_called_date')
            
            if not qs.exists():
                return Response(
                    {'error': 'No processed data found for the specified criteria'},
                    status=status.HTTP_404_NOT_FOUND
                )
            
            # Build the data with the specified columns
            data = []
            for record in qs:
                row = {
                    'firstname': record.firstname or '',
                    'lastname': record.lastname or '',
                    'contact_id': record.contact_id or '',
                    'Client ID number': record.customer_id or '',
                    'Contact': f"{record.firstname or ''} {record.lastname or ''}".strip() or '',
                    'Right party contact': '',
                    'Presentation': '',
                    'Sale': 'Yes' if record.last_outcome and 'sale' in record.last_outcome.lower() else 'No',
                    'Policy number': '',
                    'Disposition': record.last_outcome or '',
                    'Call attempts': record.called_count or 0,
                    'Campaign': record.call_data_file.campaign.display_name if record.call_data_file and record.call_data_file.campaign else '',
                    'FICA Reference': '',
                    'Contact Number': record.tel1 or record.tel2 or '',
                    'IMEI': '',
                    'Agent Name': record.last_user or '',
                    'LastCall Date': record.last_called_date.strftime('%Y-%m-%d %H:%M:%S') if record.last_called_date else '',
                    'batch': record.list_name or '',
                    'Product Sold': '',
                }
                data.append(row)
            
            df = pd.DataFrame(data)
            
            # Create Excel file
            output = BytesIO()
            with pd.ExcelWriter(output, engine='openpyxl') as writer:
                df.to_excel(writer, sheet_name='Export Data', index=False)
                
                # Auto-adjust column widths
                worksheet = writer.sheets['Export Data']
                for idx, col in enumerate(df.columns):
                    max_length = max(
                        df[col].astype(str).map(len).max(),
                        len(str(col))
                    ) + 2
                    col_letter = chr(65 + idx) if idx < 26 else chr(65 + idx // 26 - 1) + chr(65 + idx % 26)
                    worksheet.column_dimensions[col_letter].width = min(max_length, 50)
            
            output.seek(0)
            
            # Generate filename
            filename = f"export_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
            if campaign_id:
                try:
                    campaign = Campaign.objects.get(id=campaign_id)
                    filename = f"export_{campaign.name}_{datetime.now().strftime('%Y%m%d')}.xlsx"
                except Campaign.DoesNotExist:
                    pass
            
            response = HttpResponse(
                output.getvalue(),
                content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            )
            response['Content-Disposition'] = f'attachment; filename="{filename}"'
            return response
            
        except Exception as e:
            traceback.print_exc()
            return Response(
                {'error': f'Export failed: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


# ===========================================================
# OUTCOME SET VIEWSET
# ===========================================================

class OutcomeSetViewSet(viewsets.ModelViewSet):
    """Manage named outcome sets (e.g. 'Outcomes 1', 'Outcomes 2')."""
    queryset = OutcomeSet.objects.all().order_by('name')
    serializer_class = OutcomeSetSerializer
    permission_classes = [AllowAny]

    def perform_create(self, serializer):
        user = self.request.user if self.request.user.is_authenticated else None
        serializer.save(created_by=user)


# ===========================================================
# OUTCOME DESCRIPTION VIEWSET
# ===========================================================

class OutcomeDescriptionViewSet(viewsets.ModelViewSet):
    """Manage outcome descriptions"""
    queryset = OutcomeDescription.objects.all()
    serializer_class = OutcomeDescriptionSerializer
    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_queryset(self):
        queryset = OutcomeDescription.objects.all()
        search = self.request.query_params.get('search')
        if search:
            queryset = queryset.filter(
                Q(last_outcome__icontains=search) | Q(description__icontains=search)
            )
        outcome_set = self.request.query_params.get('outcome_set')
        if outcome_set:
            queryset = queryset.filter(outcome_set_id=outcome_set)
        return queryset.order_by('last_outcome')

    def perform_create(self, serializer):
        user = self.request.user if self.request.user.is_authenticated else None
        serializer.save(created_by=user)

    @action(detail=False, methods=['post'], parser_classes=[MultiPartParser, FormParser])
    def bulk_upload(self, request):
        """Bulk upload outcomes from Excel/CSV into a specific outcome set."""
        if 'file' not in request.FILES:
            return Response({'error': 'No file provided'}, status=status.HTTP_400_BAD_REQUEST)

        outcome_set_id = request.data.get('outcome_set')
        if outcome_set_id:
            try:
                outcome_set = OutcomeSet.objects.get(id=outcome_set_id)
            except OutcomeSet.DoesNotExist:
                return Response({'error': f'Outcome set {outcome_set_id} not found.'}, status=status.HTTP_400_BAD_REQUEST)
        else:
            outcome_set, _ = OutcomeSet.objects.get_or_create(name='Outcomes 1')

        file = request.FILES['file']
        try:
            if file.name.endswith(('.xlsx', '.xls')):
                df = pd.read_excel(file, dtype=str, engine='openpyxl', keep_default_na=False)
            elif file.name.endswith('.csv'):
                df = pd.read_csv(file, dtype=str, encoding='utf-8',
                                 on_bad_lines='skip', keep_default_na=False)
            else:
                return Response({'error': 'Unsupported format. Use CSV or Excel.'},
                                status=status.HTTP_400_BAD_REQUEST)

            required_columns = ['last_outcome', 'Description']
            missing = [c for c in required_columns if c not in df.columns]
            if missing:
                return Response(
                    {'error': f'Missing columns: {", ".join(missing)}. Found: {list(df.columns)}'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            df = df.fillna('')
            df['last_outcome'] = df['last_outcome'].astype(str).str.strip()
            df['Description'] = df['Description'].astype(str).str.strip()

            initial_count = OutcomeDescription.objects.count()
            batch_size = 500
            created_count = 0
            errors = []
            outcomes_to_create = []

            for i in range(0, len(df), batch_size):
                batch = df.iloc[i:i + batch_size]
                for index, row in batch.iterrows():
                    try:
                        last_outcome = row['last_outcome']
                        description = row['Description']
                        if last_outcome == '' and description == '':
                            continue
                        outcomes_to_create.append(OutcomeDescription(
                            last_outcome=last_outcome,
                            description=description,
                            outcome_set=outcome_set,
                            created_by=request.user if request.user.is_authenticated else None,
                            is_active=True
                        ))
                        created_count += 1
                    except Exception as e:
                        errors.append(f"Row {index + 2}: {e}")

                try:
                    OutcomeDescription.objects.bulk_create(
                        outcomes_to_create, batch_size=100, ignore_conflicts=True
                    )
                    outcomes_to_create = []
                except Exception as e:
                    for outcome in outcomes_to_create:
                        try:
                            outcome.save()
                        except IntegrityError:
                            pass
                        except Exception as e2:
                            errors.append(f"Save error: {e2}")
                    outcomes_to_create = []

            if outcomes_to_create:
                try:
                    OutcomeDescription.objects.bulk_create(
                        outcomes_to_create, batch_size=100, ignore_conflicts=True
                    )
                except Exception as e:
                    for outcome in outcomes_to_create:
                        try:
                            outcome.save()
                        except Exception:
                            pass

            final_count = OutcomeDescription.objects.count()
            response_data = {
                'message': f"Processed {len(df)} rows from file into outcome set '{outcome_set.name}'.",
                'details': {
                    'outcome_set': outcome_set.name,
                    'file_rows': len(df),
                    'processed_rows': created_count,
                    'initial_db_count': initial_count,
                    'final_db_count': final_count,
                    'total_added_to_db': final_count - initial_count,
                }
            }
            if errors:
                response_data['errors'] = errors[:20]
                response_data['error_count'] = len(errors)

            return Response(response_data, status=status.HTTP_200_OK)

        except Exception as e:
            traceback.print_exc()
            return Response({'error': f'Error processing file: {e}'},
                            status=status.HTTP_400_BAD_REQUEST)

    @action(detail=False, methods=['get'])
    def export(self, request):
        """Export outcomes to Excel"""
        try:
            outcomes = OutcomeDescription.objects.all().order_by('last_outcome', 'id')
            data = [{
                'last_outcome': o.last_outcome,
                'Description': o.description,
                'Created By': o.created_by.username if o.created_by else '',
                'Created At': o.created_at.strftime('%Y-%m-%d %H:%M:%S') if o.created_at else '',
                'ID': o.id
            } for o in outcomes]

            df = pd.DataFrame(data)
            output = BytesIO()
            with pd.ExcelWriter(output, engine='openpyxl') as writer:
                df.to_excel(writer, sheet_name='Outcome Descriptions', index=False)
            output.seek(0)

            response = HttpResponse(
                output.getvalue(),
                content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            )
            response['Content-Disposition'] = 'attachment; filename="outcome_descriptions.xlsx"'
            return response
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(['POST'])
@permission_classes([AllowAny])
def bulk_upload_outcomes(request):
    """Standalone bulk upload outcomes endpoint"""
    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=status.HTTP_400_BAD_REQUEST)

    file = request.FILES['file']
    try:
        if file.name.endswith(('.xlsx', '.xls')):
            df = pd.read_excel(file, dtype=str, engine='openpyxl', keep_default_na=False)
        elif file.name.endswith('.csv'):
            df = pd.read_csv(file, dtype=str, encoding='utf-8',
                             on_bad_lines='skip', keep_default_na=False)
        else:
            return Response({'error': 'Unsupported format. Use CSV or Excel.'},
                            status=status.HTTP_400_BAD_REQUEST)

        required_columns = ['last_outcome', 'Description']
        missing = [c for c in required_columns if c not in df.columns]
        if missing:
            return Response(
                {'error': f'Missing columns: {", ".join(missing)}. Found: {list(df.columns)}'},
                status=status.HTTP_400_BAD_REQUEST
            )

        df = df.fillna('')
        df['last_outcome'] = df['last_outcome'].astype(str).str.strip()
        df['Description'] = df['Description'].astype(str).str.strip()

        initial_count = OutcomeDescription.objects.count()
        outcomes_to_create = []
        created_count = 0
        skipped_count = 0
        errors = []

        for index, row in df.iterrows():
            last_outcome = str(row['last_outcome']).strip()
            description = str(row['Description']).strip()
            if last_outcome == '' and description == '':
                skipped_count += 1
                continue
            outcomes_to_create.append(OutcomeDescription(
                last_outcome=last_outcome,
                description=description,
                created_by=request.user if request.user.is_authenticated else None,
                is_active=True
            ))
            created_count += 1

            if len(outcomes_to_create) >= 500:
                try:
                    OutcomeDescription.objects.bulk_create(
                        outcomes_to_create, batch_size=100, ignore_conflicts=True
                    )
                    outcomes_to_create = []
                except Exception as e:
                    for outcome in outcomes_to_create:
                        try:
                            outcome.save()
                        except Exception:
                            pass
                    outcomes_to_create = []

        if outcomes_to_create:
            try:
                OutcomeDescription.objects.bulk_create(
                    outcomes_to_create, batch_size=100, ignore_conflicts=True
                )
            except Exception:
                for outcome in outcomes_to_create:
                    try:
                        outcome.save()
                    except Exception:
                        pass

        final_count = OutcomeDescription.objects.count()
        return Response({
            'message': f'Processed {len(df)} rows.',
            'details': {
                'file_rows': len(df),
                'attempted_to_create': created_count,
                'skipped_empty_rows': skipped_count,
                'initial_db_count': initial_count,
                'final_db_count': final_count,
                'total_added_to_db': final_count - initial_count,
            }
        }, status=status.HTTP_200_OK)

    except Exception as e:
        traceback.print_exc()
        return Response({'error': f'Error processing file: {e}'},
                        status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET'])
@permission_classes([AllowAny])
def export_outcomes(request):
    """Export outcomes to Excel"""
    try:
        outcomes = OutcomeDescription.objects.all().order_by('last_outcome', 'id')
        data = [{
            'last_outcome': o.last_outcome,
            'Description': o.description,
            'Created By': o.created_by.username if o.created_by else '',
            'Created At': o.created_at.strftime('%Y-%m-%d %H:%M:%S') if o.created_at else '',
            'ID': o.id
        } for o in outcomes]

        df = pd.DataFrame(data)
        output = BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='Outcome Descriptions', index=False)
        output.seek(0)

        response = HttpResponse(
            output.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = 'attachment; filename="outcome_descriptions.xlsx"'
        return response
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

# ===========================================================
# REPORT VIEWSET
# ===========================================================

class ReportViewSet(
    viewsets.GenericViewSet,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin
):
    """Generate and manage reports — campaign-scoped."""
    queryset = GeneratedReport.objects.all().order_by('-generated_at')
    serializer_class = GeneratedReportSerializer
    permission_classes = [AllowAny]

    def get_queryset(self):
        queryset = GeneratedReport.objects.all().order_by('-generated_at')
        # FIX: filter by campaign when requested
        campaign_id = self.request.query_params.get('campaign_id')
        if campaign_id:
            queryset = queryset.filter(campaign_id=campaign_id)
        elif self.request.user.is_authenticated:
            queryset = queryset.filter(user=self.request.user)
        return queryset

    # ----------------------------------------------------------
    # HELPER: EXCEL FORMAT DEFINITIONS
    # ----------------------------------------------------------

    def _get_workbook_formats(self, workbook):
        return {
            'title': workbook.add_format({
                'bold': True, 'font_size': 18, 'align': 'center',
                'valign': 'vcenter', 'font_color': '#1F4E78'
            }),
            'header': workbook.add_format({
                'bold': True, 'bg_color': '#366092', 'font_color': 'white',
                'border': 1, 'align': 'center', 'valign': 'vcenter'
            }),
            'subheader': workbook.add_format({
                'bold': True, 'bg_color': '#4F81BD', 'font_color': 'white',
                'border': 1, 'align': 'center', 'valign': 'vcenter'
            }),
            'cell': workbook.add_format({
                'border': 1, 'align': 'left', 'valign': 'vcenter'
            }),
            'number': workbook.add_format({
                'border': 1, 'align': 'center', 'valign': 'vcenter',
                'num_format': '#,##0'
            }),
            'percent': workbook.add_format({
                'border': 1, 'align': 'center', 'valign': 'vcenter',
                'num_format': '0.00%'
            }),
            'formula_cell': workbook.add_format({
                'border': 1, 'align': 'center', 'valign': 'vcenter',
                'num_format': '#,##0', 'bg_color': '#F2F2F2', 'bold': True
            }),
            'pivot_label': workbook.add_format({
                'bold': True, 'bg_color': '#D9E1F2', 'border': 1
            }),
            'grand_total': workbook.add_format({
                'bold': True, 'bg_color': '#8EA9DB', 'border': 1,
                'num_format': '#,##0'
            }),
            'summary_label': workbook.add_format({
                'bold': True, 'border': 1, 'align': 'left', 'valign': 'vcenter',
                'bg_color': '#E2EFDA'
            }),
            'summary_value': workbook.add_format({
                'bold': True, 'border': 1, 'align': 'center', 'valign': 'vcenter',
                'num_format': '#,##0', 'bg_color': '#E2EFDA'
            }),
            'summary_percent': workbook.add_format({
                'bold': True, 'border': 1, 'align': 'center', 'valign': 'vcenter',
                'num_format': '0.00%', 'bg_color': '#E2EFDA'
            }),
        }

    # ----------------------------------------------------------
    # DOWNLOAD
    # ----------------------------------------------------------

    @action(detail=True, methods=['get'])
    def download(self, request, pk=None):
        """Download a generated report file."""
        try:
            report = self.get_object()
            if not report.file or not os.path.exists(report.file.path):
                return Response(
                    {'success': False, 'error': 'Report file not found on server.'},
                    status=status.HTTP_404_NOT_FOUND
                )
            with open(report.file.path, 'rb') as f:
                file_data = f.read()
            response = HttpResponse(
                file_data,
                content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            )
            filename = os.path.basename(report.file.path)
            response['Content-Disposition'] = f'attachment; filename="{filename}"'
            return response
        except GeneratedReport.DoesNotExist:
            return Response({'success': False, 'error': 'Report not found'},
                            status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            traceback.print_exc()
            return Response({'success': False, 'error': str(e)},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    # Hard cap on rows returned per preview request — this reads the sheet
    # into a browser table, not a download; a Processed Data sheet can run
    # to hundreds of thousands of rows (see external_source.py's csv-not-xlsx
    # comment) and there is no reason to ship more than a human will
    # actually look at in a preview.
    PREVIEW_ROW_LIMIT = 200

    @action(detail=True, methods=['get'])
    def preview(self, request, pk=None):
        """
        Preview a generated report's data without downloading the file —
        read straight from the same .xlsx a "Download" button would fetch,
        so the preview is always exactly what's in the file (no separate
        recomputation from the DB that could drift from it).

        GET /api/reports/<id>/preview/?sheet=<name> — sheet optional,
        defaults to 'Processed Data' when present (the most useful sheet
        to eyeball before downloading), else the workbook's first sheet.

        Returns {sheet, sheets, columns, rows, total_rows, truncated} —
        rows/total_rows/truncated describe `sheet`; `sheets` lists every
        sheet name in the workbook so the frontend can offer a switcher.
        Formula cells (e.g. Campaign Analysis's VLOOKUPs) come back as
        their formula text rather than a computed number — this workbook
        is written by xlsxwriter, which never calculates formulas or
        caches a result, so data_only=True would show these cells as
        blank instead; the raw formula string is at least visible content.
        Sheets with no formulas (Processed Data, Pivot, Lead Count's
        values, Call Count Breakdown) are unaffected and preview exactly
        as their real values either way.
        """
        try:
            report = self.get_object()
            if not report.file or not os.path.exists(report.file.path):
                return Response(
                    {'success': False, 'error': 'Report file not found on server.'},
                    status=status.HTTP_404_NOT_FOUND
                )

            wb = load_workbook(report.file.path, read_only=True, data_only=False)
            try:
                sheet_names = wb.sheetnames
                requested = request.query_params.get('sheet')
                if requested and requested in sheet_names:
                    sheet_name = requested
                elif 'Processed Data' in sheet_names:
                    sheet_name = 'Processed Data'
                else:
                    sheet_name = sheet_names[0]

                ws = wb[sheet_name]
                row_iter = ws.iter_rows(values_only=True)
                header = next(row_iter, None) or []
                columns = ['' if c is None else str(c) for c in header]

                rows = []
                total_rows = 0
                for row in row_iter:
                    total_rows += 1
                    if len(rows) < ReportViewSet.PREVIEW_ROW_LIMIT:
                        rows.append(['' if c is None else c for c in row])

                return Response({
                    'success': True,
                    'data': {
                        'sheet': sheet_name,
                        'sheets': sheet_names,
                        'columns': columns,
                        'rows': rows,
                        'total_rows': total_rows,
                        'truncated': total_rows > len(rows),
                    }
                })
            finally:
                wb.close()
        except GeneratedReport.DoesNotExist:
            return Response({'success': False, 'error': 'Report not found'},
                            status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            traceback.print_exc()
            return Response({'success': False, 'error': str(e)},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    # ----------------------------------------------------------
    # GENERATE CAMPAIGN REPORT  ← FIX: fully campaign-scoped
    # ----------------------------------------------------------

    ALL_REPORT_SHEETS = {
        'processed_data', 'pivot', 'lead_count', 'campaign_analysis',
        'call_count_breakdown', 'agent_performance', 'template',
    }

    @staticmethod
    def _auto_generate_full_report(file_instance, sheets=None, full_outcome_history=False):
        """
        Automatically called after a data file is processed.
        Generates ONE workbook with up to 7 sheets and saves it as a GeneratedReport:

            Sheet 1: Processed Data       — every record from this upload
            Sheet 2: Pivot                — count per outcome description;
                                             every historical disposition
                                             when full_outcome_history is on,
                                             so this can legitimately exceed
                                             Lead Count's Total Leads
            Sheet 3: Lead Count           — total leads + New/Sales/True
                                             Contacts/Unsuccessful/Unworkable
                                             breakdown, always one row per
                                             contact's CURRENT outcome — never
                                             inflated by full_outcome_history,
                                             so this always matches Processed
                                             Data's row count exactly. Forced
                                             into `wanted` whenever
                                             'campaign_analysis'/'template' is,
                                             since Campaign Analysis's %
                                             formulas reference this sheet's
                                             Total Leads cell directly instead
                                             of showing/holding that number
                                             itself (previously the two could
                                             visually look inconsistent with
                                             each other and with Processed
                                             Data whenever full_outcome_history
                                             was on).
            Sheet 4: Campaign Analysis    — summary metrics + category tables,
                                             each Lead Count paired with its %
                                             of Total Leads (from the Lead
                                             Count sheet, see above)
            Sheet 5: Call Count Breakdown — how many times each contact was
                                             called in this date range (only if
                                             the campaign has a cd_campaign_id;
                                             see external_source.fetch_contact_call_counts)
            Sheet 6: Agent Performance    — per-agent call stats, sorted by
                                             sales descending (only if the
                                             campaign has a cd_campaign_id; see
                                             external_source.fetch_agent_performance)
            Sheet 7: Sheet1               — the campaign's template, populated

        This replaces the old two-step flow (Generate Report → Run Analysis).
        Everything is ready to download as soon as the upload completes.

        `sheets`, when given, is an iterable of keys from ALL_REPORT_SHEETS
        limiting which sheets get built — the auto-generate-after-upload
        call site leaves it as None (build everything, the historical
        behaviour). Skipping 'agent_performance'/'call_count_breakdown' also
        skips their external-database queries entirely, not just the
        worksheet — that's the actual point, since those two are the slow,
        sometimes-timing-out ones (see external_source.fetch_agent_performance/
        fetch_contact_call_counts).

        Two dependencies are enforced regardless of what's requested:
        'campaign_analysis' needs 'pivot' (its cells are live VLOOKUPs against
        the Pivot sheet), and 'template' needs 'pivot' too (Sheet1 population
        reads its category counts back out of the actual Pivot worksheet
        cells, not from the Python dict). Requesting one without the other
        silently includes Pivot rather than producing a broken workbook.

        full_outcome_history (default False, opt-in): when True, Pivot/
        Campaign Analysis count every historical disposition for the
        campaign (via external_source.fetch_outcome_history_counts) instead
        of each contact's current/latest outcome only. This is the
        *correct* number — ProcessedData.last_outcome loses a contact's
        earlier dispositions (e.g. a sale made last month) the moment
        they're called again for any reason — but it's a full external-DB
        scan of every interaction, verified to take several minutes even
        on one campaign (a 90-day range took ~8 minutes on a
        ~25k-interactions/day campaign), so it's opt-in rather than run on
        every report generation (including the automatic one after every
        upload/sync, which needs to stay fast). False falls back to the
        original ProcessedData-based counting, same as before this existed.
        """
        from django.conf import settings
        import xlsxwriter, openpyxl, os, traceback
        from io import BytesIO
        from datetime import datetime
        from django.db.models import Count, Min, Max
        from openpyxl import load_workbook
        from openpyxl.utils import get_column_letter

        wanted = set(sheets) if sheets else set(ReportViewSet.ALL_REPORT_SHEETS)
        wanted &= ReportViewSet.ALL_REPORT_SHEETS
        if not wanted:
            wanted = set(ReportViewSet.ALL_REPORT_SHEETS)
        if 'campaign_analysis' in wanted or 'template' in wanted:
            wanted.add('pivot')
            # Campaign Analysis's %-of-total-leads formulas reference the
            # Lead Count sheet's Total Leads cell directly (see below) —
            # it no longer shows that number itself, so it can't work
            # without Lead Count also existing in the same workbook.
            wanted.add('lead_count')

        campaign = file_instance.campaign
        if not campaign:
            print("⚠️  File has no campaign — skipping auto-report.")
            return

        print(f"\n{'='*60}")
        print(f"AUTO-REPORT: campaign='{campaign.display_name}' "
              f"file='{file_instance.original_name}'")

        # ── 1. Build outcome map (strictly scoped to this campaign's set) ──
        outcome_map = _build_outcome_map(campaign)
        print(f"Outcome map: {len(outcome_map)} entries")

        # ── 2. Load processed data for this file ───────────────────────
        processed_data_query = ProcessedData.objects.filter(
            call_data_file=file_instance
        )
        total_count = processed_data_query.count()
        print(f"Processed records: {total_count}")

        if total_count == 0:
            print("⚠️ No processed data — skipping auto-report.")
            return

        # date_span — the actual min/max last_called_date across THIS
        # file's processed rows. Used to scope every external-DB query this
        # function makes (Full Outcome History below, and Agent Performance/
        # Call Count Breakdown further down) to whatever range the sync/
        # upload that produced this file was itself scoped to — a sync run
        # for "yesterday" should have its outcome history counted for
        # yesterday too, not the campaign's entire lifetime. Computed once,
        # unconditionally, since every one of those three consumers needs
        # the same thing and this query is cheap (an indexed aggregate over
        # this file's own rows, not an external-DB round trip).
        date_span = processed_data_query.aggregate(
            min_date=Min('last_called_date'), max_date=Max('last_called_date')
        )

        # ── 3. Build Pivot counts ──────────────────────────────────────
        # description_counts reflects every historical disposition for this
        # campaign (via reporting.interaction_voice), not just each
        # contact's current/latest outcome. ProcessedData.last_outcome only
        # ever holds the latter — a contact who made a sale last month and
        # was called again since (for any reason, even just "Answering
        # Machine") silently lost that sale from every count derived from
        # ProcessedData, permanently, since the sync only refreshes current
        # state. total_leads stays a contact count (unchanged meaning — see
        # every Campaign Analysis %/total below, which all still divide by
        # it) computed separately, since disposition counts can now
        # legitimately sum to more than total_leads (one contact can
        # contribute several outcomes over its call history).
        #
        # Falls back to the old ProcessedData-based (latest-outcome-only)
        # counting when the campaign isn't DB-connected or the external
        # query fails outright — an under-counted Pivot beats none at all.
        total_leads = total_count
        description_counts = None
        outcome_history_skipped_ranges = []
        if full_outcome_history and campaign.cd_campaign_id:
            try:
                from .external_source import fetch_outcome_history_counts, default_campaign_date_range
                # Scope the scan to this file's own date_span (see above) —
                # i.e. whatever range the sync/upload that produced this
                # file was itself scoped to — rather than always the
                # campaign's entire lifetime. Previously this always called
                # default_campaign_date_range(campaign) unconditionally,
                # which ignored any date range the sync panel was given
                # entirely: picking "yesterday" and checking Full Outcome
                # History still scanned the campaign's full history (back
                # to 2015 — see default_campaign_date_range's docstring),
                # which is both the slow "full database scan" this option
                # is warned for and not what "yesterday" implied. Falls
                # back to default_campaign_date_range only when this file's
                # rows have no last_called_date at all to derive a range
                # from (both None) — same "never silently miss data" reasoning
                # as everywhere else this fallback is used.
                if date_span['min_date'] and date_span['max_date']:
                    hist_start, hist_end = date_span['min_date'], date_span['max_date']
                else:
                    hist_start, hist_end = default_campaign_date_range(campaign)
                raw_history_counts, outcome_history_skipped_ranges = fetch_outcome_history_counts(
                    campaign.cd_campaign_id, start_dt=hist_start, end_dt=hist_end
                )
                description_counts = {}
                for key, count in raw_history_counts.items():
                    desc = outcome_map.get(key, key)
                    description_counts[desc] = description_counts.get(desc, 0) + count
                print(f"📊 Outcome history: {sum(description_counts.values())} dispositions "
                      f"({hist_start} .. {hist_end}), {len(outcome_history_skipped_ranges)} range(s) skipped")
            except Exception as e:
                print(f"⚠️  Outcome history query failed, falling back to latest-outcome counting: {e}")
                description_counts = None

        if description_counts is None:
            raw_counts = processed_data_query.values('last_outcome').annotate(count=Count('id'))
            description_counts = {}
            for item in raw_counts:
                key  = item['last_outcome'] or 'Unknown'
                desc = outcome_map.get(key, key)
                description_counts[desc] = description_counts.get(desc, 0) + item['count']

        total_dispositions = sum(description_counts.values())
        sorted_desc_counts = sorted(
            description_counts.items(), key=lambda x: x[1], reverse=True
        )

        # ── 4. Compute summary metrics ─────────────────────────────────
        SALE_TERMS = [
            'sale made', 'upsell', 'tyme bank account sale',
            'sale made - completed mandate', 'sale made - pending mandate',
            'qa verify',  # this campaign's real sale-completion step, pending QA sign-off
        ]
        TRUE_CONTACT_TERMS = [
            'not interested', 'callback', 'call back', 'client hung up',
            'affordability', 'cannot afford', 'declined sale', 'qa rework',
            'qa fail', 'quoted client not interested', 'not interested upfront',
            'call back hold', 'not interested transaction fees',
            'cannot afford premium', 'not interested household contents',
            'not interested sms', 'call back via ms teams',
        ]

        # SALE_TERMS is a generic name-keyword guess and can miss a
        # campaign's real conversions outright when its outcome names don't
        # happen to contain a sales word (verified live: Vodacom Retentions'
        # actual wins are 'Change debit date'/'Client Contacted For
        # Documents'/'Special Debit'/'Still Active' — Campaign Analysis
        # showed 0 sales from SALE_TERMS alone while Agent Performance,
        # which reads the dialer's own sale=1 flag per outcome, correctly
        # showed 64). Fetching that authoritative flag set here and OR-ing
        # it into the same classification closes that gap without touching
        # anything for campaigns where the keyword list already matched.
        sale_outcome_names = set()
        if campaign.cd_campaign_id:
            try:
                from .external_source import fetch_sale_outcome_names
                sale_outcome_names = fetch_sale_outcome_names()
            except Exception as e:
                print(f"⚠️  Could not fetch authoritative sale outcome names, "
                      f"falling back to SALE_TERMS only: {e}")

        true_sales = 0
        true_contacts = 0
        unworked_leads = 0

        for desc, count in description_counts.items():
            d = desc.lower().strip()
            if any(t in d for t in SALE_TERMS) or d in sale_outcome_names:
                true_sales += count
            elif any(t in d for t in TRUE_CONTACT_TERMS):
                true_contacts += count
            elif any(t == d or d.startswith(t) for t in ['new', 'not contacted']):
                unworked_leads += count

        successful_contacts = true_contacts + true_sales
        conversion_value    = (true_sales / total_leads * 100) if total_leads > 0 else 0
        conversion_decimal  = conversion_value / 100

        print(f"Metrics: TL={total_leads} SC={successful_contacts} "
              f"TC={true_contacts} TS={true_sales} Conv={conversion_value:.2f}%")

        # ── 4c. Lead Count categories — ALWAYS contact-based ────────────
        # Same 4 status-category term lists Campaign Analysis uses for its
        # per-outcome breakdown (hoisted here so the Lead Count sheet below
        # can share them without duplicating the lists a third time).
        LEAD_COUNT_CATEGORIES = {
            'unsuccessful': [
                'Answering Machine Autodial','No Answer Autodial','Auto Engaged',
                'Disconnected Number Auto','Answering Machine','Selected','No Answer',
                'Busy Tone','Dropped','New','Call Dropped','Inbound After Hours Drop',
                'TPS Registered Number','Temporary Disconnected Number','Bad Line Quality',
                'Inbound Abandon','Outbound Pre-Routing Drop','Engaged','Disconnected',
                'CONGESTED','Flow Inbound Abandon','Multiple Calls','Missed','Answered',
                'Customer drop','Auto Dial Disconnected','Disconnected Number Temporary'
            ],
            'successful': [
                'Sale Made - Completed Mandate','Sale Made - Pending Mandate',
                'Sale Made','Tyme Bank Account Sale','QA Rework','QA Verify'
            ],
            'unworkable': [
                'Already Contacted','Existing Client','Unemployed','Wrong Number',
                'Do Not Call','No Smartphones','Client Deceased',
                'Right Party Not Available','Client Overage Limit','Language Barrier',
                'Non SA Citizen','No Bank Account','Client Underage','Go To The Branch',
                'Completed','Cannot Afford Upfront Payment','Account Suspended',
                'Insured at another company','Scheduled Appointment','Refund Request',
                'Does Not Qualify','NTU Policy','Does Not Have a Business',
                "Refer To Store - Doesn't want to complete online",
                'Does Not Need It Now','Technical Issue','Unsuccessful Application'
            ],
            'true_contacts': [
                'Client Hung Up','CallBack','Not Interested','Not Interested Upfront',
                'Cannot Afford Premium','Not interested - Pitched','Affordability',
                'Quoted Client Not Interested',
                'Not interested business does not use speed point mac',
                'Call Back Technical Error','Not Interested Transaction Fees',
                'Cannot Afford','Not Interested Household Contents',
                'Call Back Hold','Declined Sale'
            ]
        }
        # Extend 'successful' with this campaign's own dispositions that
        # carry the dialer's authoritative sale=1 flag (see
        # sale_outcome_names above) but aren't already covered by name —
        # otherwise a real conversion outcome with no sales keyword in its
        # name (e.g. Vodacom Retentions' 'Still Active'/'Special Debit')
        # would fall into 'other' here, undercounting Lead Count/Campaign
        # Analysis's Sales row even after true_sales above was fixed, since
        # this dict drives both sheets' own row labels independently.
        if sale_outcome_names:
            _already_categorized = {t.lower() for terms in LEAD_COUNT_CATEGORIES.values() for t in terms}
            for desc in description_counts.keys():
                d = desc.lower().strip()
                if d in sale_outcome_names and d not in _already_categorized:
                    LEAD_COUNT_CATEGORIES['successful'].append(desc)
                    _already_categorized.add(d)
        _category_lookup = {
            term.lower(): cat for cat, terms in LEAD_COUNT_CATEGORIES.items() for term in terms
        }

        # contact_status_counts: one row per contact's CURRENT outcome only
        # (never the full call-history version — see description_counts
        # above) — a straight GROUP BY over this file's own ProcessedData,
        # so it is mathematically guaranteed to sum to exactly total_leads,
        # regardless of whether full_outcome_history is on. This is what
        # the new Lead Count sheet is built from, so "lead count" stays
        # trustworthy and matches Processed Data even when Pivot is
        # deliberately showing an inflated full-history view.
        raw_contact_counts = processed_data_query.values('last_outcome').annotate(count=Count('id'))
        contact_status_counts = {}
        for item in raw_contact_counts:
            key = item['last_outcome'] or 'Unknown'
            desc = outcome_map.get(key, key)
            contact_status_counts[desc] = contact_status_counts.get(desc, 0) + item['count']

        lead_count_breakdown = {'new': 0, 'successful': 0, 'true_contacts': 0, 'unsuccessful': 0, 'unworkable': 0, 'other': 0}
        for desc, count in contact_status_counts.items():
            d = desc.lower().strip()
            if d in _category_lookup:
                lead_count_breakdown[_category_lookup[d]] += count
            elif d == 'new' or d.startswith('not contacted'):
                lead_count_breakdown['new'] += count
            else:
                lead_count_breakdown['other'] += count
        # Guaranteed by construction (every contact lands in exactly one
        # bucket), asserted rather than silently trusted — if this ever
        # fails it means a contact's outcome got double-counted or dropped
        # above, which is exactly the class of bug this sheet exists to
        # rule out.
        assert sum(lead_count_breakdown.values()) == total_leads, (
            f"Lead Count breakdown ({sum(lead_count_breakdown.values())}) "
            f"!= total_leads ({total_leads})"
        )

        # ── 4b. Agent Performance + Call Count Breakdown (best-effort —
        #        only for DB-connected campaigns, and neither is allowed to
        #        fail the report; each is independent of the other) ──────
        agent_rows = None
        call_counts = None
        # Set only when the sheet was actually requested AND actively
        # failed (both the live attempt and its one retry — see
        # fetch_agent_performance/fetch_contact_call_counts) — never for a
        # sheet that simply wasn't asked for. Carried into the saved
        # report's parameters (below) and the sync/generate response, so a
        # failure is visible where the user actually looks instead of only
        # in a server console print nobody sees — this is what previously
        # made Agent Performance/Call Count Breakdown disappear from a
        # report with zero indication anything had gone wrong.
        agent_performance_error = None
        call_count_breakdown_error = None
        if campaign.cd_campaign_id and ('agent_performance' in wanted or 'call_count_breakdown' in wanted):
            # date_span computed once, above, right after total_count is
            # confirmed non-zero — shared with the Full Outcome History
            # block for the same reason it's used here.
            if 'agent_performance' in wanted:
                try:
                    from .external_source import fetch_agent_performance
                    agent_rows = fetch_agent_performance(
                        campaign.cd_campaign_id,
                        start_dt=date_span['min_date'],
                        end_dt=date_span['max_date'],
                    )
                    print(f"👥 Agent Performance: {len(agent_rows)} agents")
                except Exception as e:
                    print(f"⚠️  Agent Performance sheet skipped: {e}")
                    agent_rows = None
                    agent_performance_error = str(e) or type(e).__name__

            if 'call_count_breakdown' in wanted:
                try:
                    from .external_source import fetch_contact_call_counts
                    call_counts = fetch_contact_call_counts(
                        campaign.cd_campaign_id,
                        start_dt=date_span['min_date'],
                        end_dt=date_span['max_date'],
                    )
                    print(f"📞 Call Count Breakdown: {len(call_counts)} contacts")
                except Exception as e:
                    print(f"⚠️  Call Count Breakdown sheet skipped: {e}")
                    call_counts = None
                    call_count_breakdown_error = str(e) or type(e).__name__

        # ── 5. Build workbook ──────────────────────────────────────────
        output = BytesIO()
        workbook = xlsxwriter.Workbook(output, {'nan_inf_to_errors': True})

        # Formats
        fmts = {}
        fmts['title'] = workbook.add_format({
            'bold': True, 'font_size': 18, 'align': 'center',
            'valign': 'vcenter', 'font_color': '#1F4E78'
        })
        fmts['header'] = workbook.add_format({
            'bold': True, 'bg_color': '#366092', 'font_color': 'white',
            'border': 1, 'align': 'center', 'valign': 'vcenter'
        })
        fmts['subheader'] = workbook.add_format({
            'bold': True, 'bg_color': '#4F81BD', 'font_color': 'white',
            'border': 1, 'align': 'center', 'valign': 'vcenter'
        })
        fmts['cell'] = workbook.add_format({
            'border': 1, 'align': 'left', 'valign': 'vcenter'
        })
        fmts['number'] = workbook.add_format({
            'border': 1, 'align': 'center', 'num_format': '#,##0'
        })
        fmts['percent'] = workbook.add_format({
            'border': 1, 'align': 'center', 'num_format': '0.00%'
        })
        fmts['duration'] = workbook.add_format({
            'border': 1, 'align': 'center', 'num_format': '[h]:mm:ss'
        })
        fmts['formula_cell'] = workbook.add_format({
            'border': 1, 'align': 'center', 'num_format': '#,##0',
            'bg_color': '#F2F2F2', 'bold': True
        })
        fmts['grand_total'] = workbook.add_format({
            'bold': True, 'bg_color': '#8EA9DB', 'border': 1,
            'num_format': '#,##0'
        })
        fmts['summary_label'] = workbook.add_format({
            'bold': True, 'border': 1, 'align': 'left',
            'bg_color': '#E2EFDA'
        })
        fmts['summary_value'] = workbook.add_format({
            'bold': True, 'border': 1, 'align': 'center',
            'num_format': '#,##0', 'bg_color': '#E2EFDA'
        })
        fmts['summary_percent'] = workbook.add_format({
            'bold': True, 'border': 1, 'align': 'center',
            'num_format': '0.00%', 'bg_color': '#E2EFDA'
        })
        fmts['ca_title'] = workbook.add_format({
            'bold': True, 'font_size': 16, 'align': 'center', 'valign': 'vcenter',
            'bg_color': '#D9D9D9', 'font_color': '#000000', 'border': 1
        })
        fmts['ca_super_header'] = workbook.add_format({
            'bold': True, 'align': 'center', 'valign': 'vcenter',
            'bg_color': '#D9D9D9', 'font_color': '#000000', 'border': 1
        })
        fmts['ca_total_number'] = workbook.add_format({
            'bold': True, 'font_size': 32, 'align': 'center', 'valign': 'vcenter',
            'border': 1, 'num_format': '#,##0'
        })
        fmts['ca_italic_note'] = workbook.add_format({
            'italic': True, 'align': 'left', 'valign': 'vcenter', 'border': 1
        })
        fmts['ca_grand_total'] = workbook.add_format({
            'bold': True, 'font_size': 14, 'align': 'left', 'valign': 'vcenter'
        })

        # ── SHEET 1: PROCESSED DATA ────────────────────────────────────
        # Streamed via .values(...).iterator() rather than list()-ed into
        # memory, and used two ways in one pass: writing the Processed Data
        # sheet(s) themselves, and — when Call Count Breakdown is wanted —
        # building a lightweight (contact_id, name, phone) lookup keyed by
        # customer_id. .values() returns plain dicts instead of full
        # ProcessedData model instances, which matters at this scale: a
        # 1.1M-row campaign (Telkom LTE) constructing 1.1M live ORM objects
        # — each with ~35 fields worth of descriptor overhead — was slow
        # enough to make report generation look hung for well over an hour.
        # write_row() (one call per row) replaces 35 individual .write()
        # calls per row for the same reason: fewer, cheaper Python-level
        # calls across ~35M cells.
        #
        # This sheet used to hard-cap at 10,000 rows regardless of how many
        # records actually existed (silently showing only the first 10,000
        # while Pivot/Campaign Analysis reflected the true total). XLSX caps
        # a single SHEET at 1,048,576 rows (the same format ceiling fixed
        # elsewhere in this codebase — see serializers.py's CSV switch), so
        # a campaign whose processed data exceeds that now spills into
        # "Processed Data (2)", "Processed Data (3)", etc. instead of
        # silently dropping rows.
        MAX_SHEET_DATA_ROWS = 1_000_000  # safely under Excel's 1,048,576-row ceiling, room for the header
        contact_lookup = {}  # customer_id (str) -> (contact_id, name, phone); only filled if call_count_breakdown is wanted
        total_processed_rows = 0

        if 'processed_data' in wanted or 'call_count_breakdown' in wanted:
            field_names = [
                f.name for f in ProcessedData._meta.fields
                # outcome_description dropped: now that last_outcome is pulled as the
                # source DB's full name (see external_source.SOURCE_QUERY_TEMPLATE),
                # it's just a duplicate of last_outcome, not a separate abbreviation
                # lookup — same exclusion download_processed already applies.
                if f.name not in ['id', 'call_data_file', 'processed_at', 'outcome_description']
            ]
            date_fields = {'last_called_date', 'created_at', 'updated_at', 'dob'}

            def _new_processed_data_sheet(idx):
                sheet_name = 'Processed Data' if idx == 1 else f'Processed Data ({idx})'
                ws = workbook.add_worksheet(sheet_name)
                for col, field in enumerate(field_names):
                    ws.write(0, col, _column_header(field), fmts['header'])
                return ws

            data_ws = None
            data_sheet_index = 1
            data_row_num = 1
            if 'processed_data' in wanted:
                data_ws = _new_processed_data_sheet(data_sheet_index)

            for record in processed_data_query.values(*field_names).iterator(chunk_size=5000):
                if 'processed_data' in wanted:
                    if data_row_num > MAX_SHEET_DATA_ROWS:
                        data_sheet_index += 1
                        data_ws = _new_processed_data_sheet(data_sheet_index)
                        data_row_num = 1
                    row_values = [
                        record[field].strftime('%Y-%m-%d %H:%M:%S') if field in date_fields and record[field] else record[field]
                        for field in field_names
                    ]
                    data_ws.write_row(data_row_num, 0, row_values)
                    data_row_num += 1

                if 'call_count_breakdown' in wanted and record['customer_id']:
                    name = f"{(record['firstname'] or '').strip()} {(record['lastname'] or '').strip()}".strip()
                    contact_lookup[str(record['customer_id'])] = (record['contact_id'], name, record['tel1'] or '')

                total_processed_rows += 1

            if 'processed_data' in wanted:
                print(f"✅ Processed Data: {total_processed_rows} rows across {data_sheet_index} sheet(s)")

        # ── SHEET 2: PIVOT ─────────────────────────────────────────────
        # pivot_range stays undefined when this sheet is skipped, which is
        # safe: it's only read inside the Campaign Analysis block below, and
        # 'campaign_analysis' in wanted forces 'pivot' into wanted too (see
        # docstring), so that block never runs without pivot_range existing.
        if 'pivot' in wanted:
            pivot_ws = workbook.add_worksheet('Pivot')
            pivot_ws.set_column('A:A', 40)
            pivot_ws.set_column('B:B', 20)
            pivot_ws.write('A1', 'Outcome Description', fmts['header'])
            pivot_ws.write('B1', 'Count', fmts['header'])
            curr_row = 1
            for desc, count in sorted_desc_counts:
                pivot_ws.write(curr_row, 0, desc, fmts['cell'])
                pivot_ws.write(curr_row, 1, count, fmts['number'])
                curr_row += 1
            pivot_ws.write(curr_row, 0, 'Grand Total', fmts['grand_total'])
            pivot_ws.write(curr_row, 1, total_dispositions, fmts['grand_total'])
            pivot_range = f"Pivot!$A$2:$B${curr_row}"
            print(f"Pivot: {curr_row - 1} unique outcomes")

            # Surfaced in the sheet itself, not just a server console log —
            # a handful of individual days can be too dense for even the
            # finest chunking to scan in time (verified live), so counts
            # here may slightly undercount those specific ranges.
            if outcome_history_skipped_ranges:
                note_row = curr_row + 2
                ranges_str = "; ".join(
                    f"{s.strftime('%Y-%m-%d')} to {e.strftime('%Y-%m-%d')}"
                    for s, e in outcome_history_skipped_ranges
                )
                pivot_ws.merge_range(
                    note_row, 0, note_row, 1,
                    f"⚠ {len(outcome_history_skipped_ranges)} date range(s) could not be fully "
                    f"scanned in time and may be undercounted: {ranges_str}",
                    fmts['ca_italic_note']
                )

        # ── SHEET: LEAD COUNT ────────────────────────────────────────────
        # Always contact-based (see lead_count_breakdown, computed earlier
        # alongside the other summary metrics) — the one leads figure in
        # this whole report guaranteed to equal Processed Data's row count,
        # no matter what full_outcome_history is set to. Forced into
        # `wanted` whenever Campaign Analysis/Template is (see the wanted
        # setup near the top of this function), since Campaign Analysis no
        # longer shows/holds its own Total Leads number — its %-of-total
        # formulas reference LEAD_COUNT_TOTAL_CELL below instead, so the
        # two sheets can never visually disagree with each other.
        LEAD_COUNT_TOTAL_CELL = "'Lead Count'!$B$3"
        if 'lead_count' in wanted:
            lc_ws = workbook.add_worksheet('Lead Count')
            lc_ws.set_column('A:A', 26)
            lc_ws.set_column('B:B', 16)
            lc_ws.set_column('C:C', 14)
            lc_ws.merge_range(0, 0, 0, 2, f'{campaign.display_name} Lead Count', fmts['ca_title'])

            lc_ws.write(2, 0, 'Total Leads', fmts['header'])
            lc_ws.write(2, 1, total_leads, fmts['ca_total_number'])  # B3 — see LEAD_COUNT_TOTAL_CELL above

            LC_HEADER_ROW = 4
            lc_ws.write(LC_HEADER_ROW, 0, 'Status', fmts['header'])
            lc_ws.write(LC_HEADER_ROW, 1, 'Lead Count', fmts['header'])
            lc_ws.write(LC_HEADER_ROW, 2, '% of Total', fmts['header'])

            lc_rows = [
                ('New / Not Contacted', lead_count_breakdown['new']),
                ('Sales', lead_count_breakdown['successful']),
                ('True Contacts', lead_count_breakdown['true_contacts']),
                ('Unsuccessful', lead_count_breakdown['unsuccessful']),
                ('Unworkable', lead_count_breakdown['unworkable']),
            ]
            if lead_count_breakdown['other']:
                lc_rows.append(('Other', lead_count_breakdown['other']))

            r = LC_HEADER_ROW + 1
            first_lc_row = r
            for label, count in lc_rows:
                lc_ws.write(r, 0, label, fmts['cell'])
                lc_ws.write(r, 1, count, fmts['number'])
                lc_ws.write(r, 2, (count / total_leads) if total_leads else 0, fmts['percent'])
                r += 1
            last_lc_row = r - 1

            # A live SUM formula, not a repeated literal — this is the
            # sheet's own visible proof that the breakdown really does add
            # up to Total Leads above (also asserted in Python when this
            # is computed, but that assertion is invisible to anyone who
            # isn't reading the server console).
            lc_ws.write(r, 0, 'TOTAL', fmts['grand_total'])
            lc_ws.write_formula(r, 1, f'=SUM(B{first_lc_row + 1}:B{last_lc_row + 1})', fmts['grand_total'])
            lc_ws.write_formula(r, 2, f'=B{r + 1}/$B$3', fmts['summary_percent'])

            print(f"Lead Count sheet built: {total_leads} total leads across {len(lc_rows)} categories")

        # ── SHEET 3: CAMPAIGN ANALYSIS ─────────────────────────────────
        if 'campaign_analysis' in wanted:
            ca_ws = workbook.add_worksheet('Campaign Analysis')
            for i, w in enumerate([18,32,12,10,32,12,10,32,12,10,32,12,10]):
                ca_ws.set_column(i, i, w)

            title_suffix = 'Campaign Analysis' if campaign.display_name.strip().lower().endswith('leads') \
                else 'Leads Campaign Analysis'
            ca_ws.merge_range(
                'A1:M2',
                f'{campaign.display_name} {title_suffix}',
                fmts['ca_title']
            )

            # Same 4 term lists the Lead Count sheet uses (hoisted earlier
            # as LEAD_COUNT_CATEGORIES, alongside lead_count_breakdown) —
            # reused here rather than redefined a second time.
            categories = LEAD_COUNT_CATEGORIES

            # Super-header row: "Customers Reached" spans the True Contacts triple only
            SUPER_HDR = 2
            ca_ws.merge_range(SUPER_HDR, 10, SUPER_HDR, 12, 'Customers Reached', fmts['ca_super_header'])

            # Each category is a label/count/% triple — % is the count's share of
            # Total Leads, which now lives on the Lead Count sheet (see
            # LEAD_COUNT_TOTAL_CELL) rather than a number shown here, so
            # this sheet can't visually drift from Lead Count/Processed
            # Data even when Pivot's own counts are running inflated
            # (full_outcome_history on).
            HEADER_ROW = 3
            ca_ws.write(HEADER_ROW, 0,  'Total Leads',                    fmts['header'])
            ca_ws.write(HEADER_ROW, 1,  'Unsuccessful Contacts',            fmts['header'])
            ca_ws.write(HEADER_ROW, 2,  'Lead Count',                       fmts['header'])
            ca_ws.write(HEADER_ROW, 3,  '%',                                fmts['header'])
            ca_ws.write(HEADER_ROW, 4,  'Was customer interested in deal?', fmts['header'])
            ca_ws.write(HEADER_ROW, 5,  'Lead Count',                       fmts['header'])
            ca_ws.write(HEADER_ROW, 6,  '%',                                fmts['header'])
            ca_ws.write(HEADER_ROW, 7,  'Succesful Contacts',                fmts['header'])
            ca_ws.write(HEADER_ROW, 8,  'Lead Count',                       fmts['header'])
            ca_ws.write(HEADER_ROW, 9,  '%',                                fmts['header'])
            ca_ws.write(HEADER_ROW, 10, 'True Contacts',                    fmts['header'])
            ca_ws.write(HEADER_ROW, 11, 'Lead Count',                       fmts['header'])
            ca_ws.write(HEADER_ROW, 12, '%',                                fmts['header'])

            DATA_START = HEADER_ROW + 1

            def fill_section(desc_list, col_label, col_val, col_pct, start_row):
                for i, text in enumerate(desc_list):
                    r = start_row + i
                    ca_ws.write(r, col_label, text, fmts['cell'])
                    ca_ws.write_formula(
                        r, col_val,
                        f'=IFERROR(VLOOKUP("{text}",{pivot_range},2,FALSE),0)',
                        fmts['formula_cell']
                    )
                    count_cell = f'{get_column_letter(col_val + 1)}{r + 1}'
                    ca_ws.write_formula(
                        r, col_pct,
                        f'=IFERROR({count_cell}/{LEAD_COUNT_TOTAL_CELL},0)',
                        fmts['percent']
                    )
                return start_row + len(desc_list)

            u_end = fill_section(categories['unsuccessful'], 1,  2,  3,  DATA_START)
            s_end = fill_section(categories['successful'],   4,  5,  6,  DATA_START)
            w_end = fill_section(categories['unworkable'],   7,  8,  9,  DATA_START)
            t_end = fill_section(categories['true_contacts'],10, 11, 12, DATA_START)

            # The two longest columns (Unsuccessful / Succesful Contacts) set where every
            # column's subtotal row sits.
            SUBTOTAL_ROW = DATA_START + max(
                len(categories['unsuccessful']), len(categories['unworkable'])
            )

            # "If not, why not?" note fills the gap between the 5 sale rows and the subtotal
            # row, holding the count of everyone who was reached but didn't buy.
            gap_start, gap_end = s_end, SUBTOTAL_ROW - 1
            why_not_formula = f'=I{SUBTOTAL_ROW+1}+L{SUBTOTAL_ROW+1}'
            if gap_end > gap_start:
                ca_ws.merge_range(gap_start, 4, gap_end, 4, 'If not, why not?', fmts['ca_italic_note'])
                ca_ws.merge_range(gap_start, 5, gap_end, 5, why_not_formula, fmts['formula_cell'])
            elif gap_end == gap_start:
                ca_ws.write(gap_start, 4, 'If not, why not?', fmts['ca_italic_note'])
                ca_ws.write_formula(gap_start, 5, why_not_formula, fmts['formula_cell'])

            # Subtotal row — one number per category, aligned under the longest columns
            ca_ws.write_formula(SUBTOTAL_ROW, 2, f'=SUM(C{DATA_START+1}:C{u_end})', fmts['formula_cell'])
            ca_ws.write(SUBTOTAL_ROW, 4, "Successful Take Up's", fmts['subheader'])
            ca_ws.write_formula(SUBTOTAL_ROW, 5, f'=SUM(F{DATA_START+1}:F{s_end})', fmts['formula_cell'])
            ca_ws.write_formula(SUBTOTAL_ROW, 8, f'=SUM(I{DATA_START+1}:I{w_end})', fmts['formula_cell'])
            ca_ws.write_formula(SUBTOTAL_ROW, 11, f'=SUM(L{DATA_START+1}:L{t_end})', fmts['formula_cell'])

            # This column used to hold a big literal Total Leads number
            # (Processed Data's row count) written straight from Python —
            # now a live formula referencing the Lead Count sheet's own
            # Total Leads cell instead, so the number is still visible here
            # but can never silently disagree with Lead Count (always
            # contact-based, never inflated by full_outcome_history) since
            # it's the exact same cell, not a second copy of the number.
            ca_ws.merge_range(
                DATA_START, 0, SUBTOTAL_ROW, 0,
                f'={LEAD_COUNT_TOTAL_CELL}',
                fmts['ca_total_number']
            )

            # Grand total of the "successful pipeline": Take Ups + Succesful Contacts + True Contacts
            GRAND_ROW = SUBTOTAL_ROW + 2
            ca_ws.write_formula(
                GRAND_ROW, 0,
                f'=F{SUBTOTAL_ROW+1}+I{SUBTOTAL_ROW+1}+L{SUBTOTAL_ROW+1}',
                fmts['ca_grand_total']
            )

            # ── SUMMARY + ranked status tables ─────────────────────────────
            def top_n_from_category(cat_list, n):
                """Top n (description, count) pairs from sorted_desc_counts that
                belong to the given category list, case-insensitive."""
                cat_lower = {c.lower() for c in cat_list}
                matched = [(d, c) for d, c in sorted_desc_counts if d.lower() in cat_lower]
                return matched[:n]

            SUMMARY_ROW = GRAND_ROW + 3
            ca_ws.merge_range(SUMMARY_ROW, 0, SUMMARY_ROW, 1, 'SUMMARY', fmts['subheader'])
            conversion_ratio = (true_sales / true_contacts) if true_contacts else 0
            contact_ratio = (successful_contacts / total_leads) if total_leads else 0
            summary_items = [
                ('Successful Contacts',      successful_contacts, fmts['formula_cell']),
                ('True Contacts (TC)',       true_contacts,        fmts['formula_cell']),
                ('Conversions',              true_sales,           fmts['formula_cell']),
                ('Conversion Ratio (vs TC)', conversion_ratio,     fmts['percent']),
                ('Contact Ratio',            contact_ratio,        fmts['percent']),
            ]
            for i, (label, value, fmt) in enumerate(summary_items):
                r = SUMMARY_ROW + 1 + i
                ca_ws.write(r, 0, label, fmts['cell'])
                ca_ws.write(r, 1, value, fmt)

            # Row kept as spacing only (downstream layout still anchors off
            # it) — used to also write a literal "TOTAL LEADS" number here;
            # removed per the same "Lead Count sheet is the one place this
            # number lives" reasoning as the big tile above.
            TOTAL_LEADS_ROW = SUMMARY_ROW + len(summary_items) + 2

            def write_ranked_table(title, rows_data, start_row):
                ca_ws.merge_range(start_row, 0, start_row, 2, title, fmts['subheader'])
                ca_ws.write(start_row + 1, 0, 'Status',        fmts['header'])
                ca_ws.write(start_row + 1, 1, 'Lead Count',    fmts['header'])
                ca_ws.write(start_row + 1, 2, 'Lead % Result', fmts['header'])
                r = start_row + 2
                total_count = 0
                for desc, count in rows_data:
                    ca_ws.write(r, 0, desc, fmts['cell'])
                    ca_ws.write(r, 1, count, fmts['number'])
                    ca_ws.write(r, 2, (count / total_leads) if total_leads else 0, fmts['percent'])
                    total_count += count
                    r += 1
                ca_ws.write(r, 0, 'TOTAL', fmts['subheader'])
                ca_ws.write(r, 1, total_count, fmts['formula_cell'])
                ca_ws.write(r, 2, (total_count / total_leads) if total_leads else 0, fmts['percent'])
                return r + 2  # next block starts 1 blank row below

            next_row = write_ranked_table(
                'Top 5 Failed Status Codes',
                top_n_from_category(categories['unsuccessful'], 5),
                TOTAL_LEADS_ROW + 2
            )
            write_ranked_table(
                'Successful Leads',
                top_n_from_category(categories['successful'], 3),
                next_row
            )

            print(f"Campaign Analysis sheet built")

        # ── SHEET: CALL COUNT BREAKDOWN (only if the campaign is DB-connected
        #    and the fetch above succeeded — see external_source.py) ─────
        if call_counts is not None:
            ccb_ws = workbook.add_worksheet('Call Count Breakdown')
            ccb_ws.set_column(0, 0, 26)
            ccb_ws.set_column(1, 3, 18)

            # How many contacts were called exactly N times
            distribution = {}
            for count in call_counts.values():
                distribution[count] = distribution.get(count, 0) + 1

            ccb_ws.merge_range(0, 0, 0, 1, 'Contact Frequency Distribution', fmts['ca_super_header'])
            ccb_ws.write(1, 0, 'Times Contacted', fmts['header'])
            ccb_ws.write(1, 1, 'Number of Contacts', fmts['header'])
            dist_row = 2
            for times, n_contacts in sorted(distribution.items()):
                ccb_ws.write(dist_row, 0, times, fmts['number'])
                ccb_ws.write(dist_row, 1, n_contacts, fmts['number'])
                dist_row += 1
            ccb_ws.write(dist_row, 0, 'Total Contacts', fmts['grand_total'])
            ccb_ws.write(dist_row, 1, len(call_counts), fmts['grand_total'])

            # Per-contact list, sorted by call count descending. Names/phone
            # come from contact_lookup, built alongside the Processed Data
            # sheet above (see SHEET 1) — a full pass over every processed
            # record, not just the first 10,000, so every contact gets a
            # name/phone here regardless of campaign size.
            list_start = dist_row + 3
            ccb_ws.merge_range(list_start, 0, list_start, 3, 'Contacts by Call Count', fmts['ca_super_header'])
            list_header_row = list_start + 1
            ccb_ws.write(list_header_row, 0, 'Contact ID', fmts['header'])
            ccb_ws.write(list_header_row, 1, 'Name', fmts['header'])
            ccb_ws.write(list_header_row, 2, 'Phone', fmts['header'])
            ccb_ws.write(list_header_row, 3, 'Times Contacted', fmts['header'])

            sorted_contacts = sorted(call_counts.items(), key=lambda kv: kv[1], reverse=True)
            for i, (customer_id, count) in enumerate(sorted_contacts):
                r = list_header_row + 1 + i
                looked_up = contact_lookup.get(customer_id)
                contact_id, name, phone = looked_up if looked_up else (customer_id, '', '')
                ccb_ws.write(r, 0, contact_id, fmts['cell'])
                ccb_ws.write(r, 1, name or '—', fmts['cell'])
                ccb_ws.write(r, 2, phone or '—', fmts['cell'])
                ccb_ws.write(r, 3, count, fmts['number'])

            print(f"✅ Call Count Breakdown sheet built: {len(call_counts)} contacts")
        elif call_count_breakdown_error:
            # Requested but failed (even after fetch_contact_call_counts's
            # own retry) — build the sheet anyway, as a visible error
            # placeholder, rather than silently dropping it. Previously
            # this case produced no sheet at all and nothing but a server
            # console print, so a genuine failure looked identical to
            # "user didn't ask for this sheet."
            ccb_ws = workbook.add_worksheet('Call Count Breakdown')
            ccb_ws.set_column(0, 0, 100)
            ccb_ws.merge_range(
                0, 0, 2, 0,
                f"⚠ Call Count Breakdown could not be built — the database "
                f"query failed even after a retry:\n{call_count_breakdown_error}\n\n"
                f"Try Generate Report again; if it keeps failing, the source "
                f"database may be under heavy load or unreachable.",
                fmts['ca_italic_note']
            )
            print(f"⚠️  Call Count Breakdown sheet shows an error placeholder: {call_count_breakdown_error}")

        # ── SHEET: AGENT PERFORMANCE (only if the campaign is DB-connected
        #    and the fetch above succeeded — see external_source.py) ─────
        # Columns match the source platform's own "Combined Summary" report
        # (Reports > Voice > Combined Summary) exactly, verified against a
        # live screenshot of its header row — no data-source change needed,
        # this is purely the visual layer: a KPI-tile summary banner above
        # the existing per-agent table, native Excel table banding, and a
        # red/yellow/green scale on the three rate columns.
        if agent_rows is not None:
            ap_ws = workbook.add_worksheet('Agent Performance')
            ap_headers = [
                'User', 'Team', 'Outbound', 'Inbound', 'Combined',
                'Connects Combined', 'Connect Rate Combined', 'DMCs', 'DMC Rate',
                'Sales', 'Conversion', 'Completed', 'Talk', 'Avg Talk',
                'DMC Talk', 'Avg DMC Talk', 'Pause', 'Wait', 'Avg Wait',
                'Wrap', 'Avg Wrap',
            ]
            n_cols = len(ap_headers)  # 21 — matches 7 KPI tiles at 3 columns each below
            ap_ws.set_column(0, 1, 22)
            ap_ws.set_column(2, n_cols - 1, 13)

            def _as_day_fraction(seconds):
                # Excel stores elapsed time as a fraction of a 24h day; the
                # [h]:mm:ss format then displays cumulative hours past 24
                # correctly instead of wrapping like a real clock would.
                return (seconds or 0) / 86400

            if not agent_rows:
                ap_ws.merge_range(0, 0, 2, n_cols - 1,
                                   'No agent activity found for this campaign in range.',
                                   fmts['ca_italic_note'])
            else:
                # ── Dashboard formats (local to this sheet) ──────────────
                navy, navy_light = '#1F4E78', '#DCE6F1'
                green, green_light = '#375623', '#E2EFDA'
                ap_title_fmt = workbook.add_format({
                    'bold': True, 'font_size': 18, 'font_color': 'white',
                    'bg_color': navy, 'align': 'center', 'valign': 'vcenter'
                })
                kpi_label = workbook.add_format({
                    'bold': True, 'font_size': 10, 'font_color': 'white', 'bg_color': navy,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                })
                kpi_value = workbook.add_format({
                    'bold': True, 'font_size': 22, 'font_color': navy, 'bg_color': navy_light,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                })
                kpi_value_pct = workbook.add_format({
                    'bold': True, 'font_size': 22, 'font_color': navy, 'bg_color': navy_light,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                    'num_format': '0.0%',
                })
                kpi_label_good = workbook.add_format({
                    'bold': True, 'font_size': 10, 'font_color': 'white', 'bg_color': green,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                })
                kpi_value_good = workbook.add_format({
                    'bold': True, 'font_size': 22, 'font_color': green, 'bg_color': green_light,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                })
                kpi_value_good_pct = workbook.add_format({
                    'bold': True, 'font_size': 22, 'font_color': green, 'bg_color': green_light,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                    'num_format': '0.0%',
                })
                kpi_value_good_dur = workbook.add_format({
                    'bold': True, 'font_size': 18, 'font_color': green, 'bg_color': green_light,
                    'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': 'white',
                    'num_format': '[h]:mm:ss',
                })

                # ── Title banner ──────────────────────────────────────
                ap_ws.merge_range(0, 0, 1, n_cols - 1, 'Agent Performance Dashboard', ap_title_fmt)

                # ── KPI tiles: 7 tiles × 3 columns = 21, spanning the
                #    full table width below ──────────────────────────
                total_combined = sum(a['combined'] for a in agent_rows)
                total_connects = sum(a['connects'] for a in agent_rows)
                total_dmcs = sum(a['dmcs'] for a in agent_rows)
                total_sales = sum(a['sales'] for a in agent_rows)
                total_talk_seconds = sum(a['talk_seconds'] for a in agent_rows)
                kpi_connect_rate = (total_connects / total_combined) if total_combined else 0
                kpi_dmc_rate = (total_dmcs / total_connects) if total_connects else 0
                kpi_conversion = (total_sales / total_dmcs) if total_dmcs else 0
                kpi_avg_talk = _as_day_fraction(total_talk_seconds / total_combined) if total_combined else 0

                kpis = [
                    ('AGENTS', len(agent_rows), kpi_label, kpi_value),
                    ('TOTAL CALLS', total_combined, kpi_label, kpi_value),
                    ('CONNECT RATE', kpi_connect_rate, kpi_label, kpi_value_pct),
                    ('DMC RATE', kpi_dmc_rate, kpi_label, kpi_value_pct),
                    ('SALES', total_sales, kpi_label_good, kpi_value_good),
                    ('CONVERSION', kpi_conversion, kpi_label_good, kpi_value_good_pct),
                    ('AVG TALK TIME', kpi_avg_talk, kpi_label_good, kpi_value_good_dur),
                ]
                KPI_LABEL_ROW = 3
                KPI_VALUE_ROW = 4
                for i, (label, value, label_fmt, value_fmt) in enumerate(kpis):
                    col_start, col_end = i * 3, i * 3 + 2
                    ap_ws.merge_range(KPI_LABEL_ROW, col_start, KPI_LABEL_ROW, col_end, label, label_fmt)
                    ap_ws.merge_range(KPI_VALUE_ROW, col_start, KPI_VALUE_ROW + 1, col_end, value, value_fmt)

                # ── Data table (native Excel Table — banded rows, filter
                #    dropdowns on headers — instead of a plain range) ───
                TABLE_HEADER_ROW = KPI_VALUE_ROW + 3  # one blank row below the tiles
                first_data_row = TABLE_HEADER_ROW + 1
                for row_num, a in enumerate(agent_rows, start=first_data_row):
                    ap_ws.write(row_num, 0, a['display_name'], fmts['cell'])
                    ap_ws.write(row_num, 1, a['team_name'], fmts['cell'])
                    ap_ws.write(row_num, 2, a['outbound'], fmts['number'])
                    ap_ws.write(row_num, 3, a['inbound'], fmts['number'])
                    ap_ws.write(row_num, 4, a['combined'], fmts['number'])
                    ap_ws.write(row_num, 5, a['connects'], fmts['number'])
                    ap_ws.write(row_num, 6, a['connect_rate'], fmts['percent'])
                    ap_ws.write(row_num, 7, a['dmcs'], fmts['number'])
                    ap_ws.write(row_num, 8, a['dmc_rate'], fmts['percent'])
                    ap_ws.write(row_num, 9, a['sales'], fmts['number'])
                    ap_ws.write(row_num, 10, a['conversion'], fmts['percent'])
                    ap_ws.write(row_num, 11, a['completed'], fmts['number'])
                    ap_ws.write(row_num, 12, _as_day_fraction(a['talk_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 13, _as_day_fraction(a['avg_talk_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 14, _as_day_fraction(a['dmc_talk_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 15, _as_day_fraction(a['avg_dmc_talk_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 16, _as_day_fraction(a['pause_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 17, _as_day_fraction(a['wait_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 18, _as_day_fraction(a['avg_wait_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 19, _as_day_fraction(a['wrap_seconds']), fmts['duration'])
                    ap_ws.write(row_num, 20, _as_day_fraction(a['avg_wrap_seconds']), fmts['duration'])
                last_data_row = first_data_row + len(agent_rows) - 1

                ap_ws.add_table(TABLE_HEADER_ROW, 0, last_data_row, n_cols - 1, {
                    'columns': [{'header': h} for h in ap_headers],
                    'style': 'Table Style Medium 2',
                    'banded_rows': True,
                })
                ap_ws.freeze_panes(first_data_row, 0)

                # Red/yellow/green scale on the three rate columns — lets a
                # reader spot strong/weak agents at a glance without reading
                # every number.
                for col in (6, 8, 10):  # Connect Rate Combined, DMC Rate, Conversion
                    ap_ws.conditional_format(first_data_row, col, last_data_row, col, {
                        'type': '3_color_scale',
                        'min_color': '#F8696B', 'mid_color': '#FFEB84', 'max_color': '#63BE7B',
                    })

            print(f"Agent Performance sheet built: {len(agent_rows)} agents")
        elif agent_performance_error:
            # Requested but failed (even after fetch_agent_performance's
            # own retry) — same reasoning as Call Count Breakdown's
            # identical elif above: a visible error placeholder instead of
            # silently vanishing.
            ap_ws = workbook.add_worksheet('Agent Performance')
            ap_ws.set_column(0, 0, 100)
            ap_ws.merge_range(
                0, 0, 2, 0,
                f"⚠ Agent Performance could not be built — the database "
                f"query failed even after a retry:\n{agent_performance_error}\n\n"
                f"Try Generate Report again; if it keeps failing, the source "
                f"database may be under heavy load or unreachable.",
                fmts['ca_italic_note']
            )
            print(f"⚠️  Agent Performance sheet shows an error placeholder: {agent_performance_error}")

        # ── SHEET 4: TEMPLATE (Sheet1) populated from Pivot ────────────
        # Find the newest template for this campaign
        template_obj = ReportTemplate.objects.filter(
            campaign=campaign, is_active=True
        ).order_by('-uploaded_at').first()

        if 'template' in wanted and template_obj and os.path.exists(template_obj.template_file.path):
            print(f"Populating template: {template_obj.name}")

            # Save and re-open the workbook so Pivot data is readable
            # by openpyxl (xlsxwriter can't be read while open)
            workbook.close()
            output.seek(0)
            xl_wb = load_workbook(output)
            xl_pivot = xl_wb['Pivot']

            # ══════════════════════════════════════════════════════════
            # Build Sheet1's lookup FROM THE CAMPAIGN ANALYSIS SHEET DATA
            # ══════════════════════════════════════════════════════════
            # Sheet1 mirrors the Campaign Analysis sheet exactly:
            #
            #   1. The SUMMARY BLOCK values (Total Leads, Successful
            #      Contacts, True Contacts, Conversion, True Sales,
            #      Unworked Leads) — the same numbers written to the
            #      Campaign Analysis summary rows.
            #
            #   2. EVERY disposition listed in the Campaign Analysis
            #      category tables (Unsuccessful / Interested in Deal /
            #      Successful / True Contacts columns) — with the same
            #      count its VLOOKUP resolves to. Dispositions with no
            #      Pivot entry get 0, exactly like IFERROR(VLOOKUP,0)
            #      shows 0 in the Campaign Analysis sheet.
            #
            # (The Campaign Analysis sheet's Lead Count cells are live
            #  VLOOKUP formulas that Excel hasn't calculated yet, so we
            #  can't literally read them with openpyxl — instead we use
            #  the SAME source data that produces them, which guarantees
            #  identical values.)

            # Case-insensitive view of the Pivot counts
            desc_counts_lower = {
                k.strip().lower(): v for k, v in description_counts.items()
            }

            pivot_data_by_description = {}

            # 2a. Every disposition in the Campaign Analysis category
            #     tables — count mirrors the CA sheet's VLOOKUP result
            for cat_list in categories.values():
                for desc in cat_list:
                    key   = desc.strip().lower()
                    count = desc_counts_lower.get(key, 0)   # IFERROR(...,0)
                    pivot_data_by_description[key] = [desc, count]

            # 2b. Also include any Pivot description NOT in the category
            #     lists, so unusual dispositions still match in Sheet1
            for i, row in enumerate(xl_pivot.iter_rows(values_only=True)):
                if i == 0:
                    continue
                if row and row[0]:
                    key = str(row[0]).strip().lower()
                    if key not in pivot_data_by_description and key != 'grand total':
                        pivot_data_by_description[key] = list(row)

            # 1. SUMMARY BLOCK values — identical to what the Campaign
            #    Analysis sheet's summary rows show
            summary_entries = {
                'total leads':                 ('total leads',                total_leads),
                'unworked leads (new leads)':  ('unworked leads (new leads)', unworked_leads),
                'succesful contacts':           ('succesful contacts',         successful_contacts),
                'successful contacts':          ('successful contacts',        successful_contacts),
                'true contacts':               ('true contacts',               true_contacts),
                'conversion':                   ('conversion',                 conversion_decimal),
                'true sales (post qa)':        ('true sales (post qa)',        true_sales),
            }
            # Calculated ratios
            if total_leads > 0:
                summary_entries['contactability']         = ('contactability',         successful_contacts / total_leads)
                summary_entries['lead to sale conversion'] = ('lead to sale conversion', true_sales / total_leads)
            if successful_contacts > 0:
                summary_entries['conversion to true sale'] = ('conversion to true sale', true_sales / successful_contacts)
            if true_contacts > 0:
                summary_entries['true contacts to sales']  = ('true contacts to sales',  true_sales / true_contacts)

            # Aliases for common template typos/name differences
            ALIASES = {
                'succesful contacts':        'successful contacts',
                'under age':                 'client underage',
                'go to branch':              'go to the branch',
                'qa fail':                   'qa rework',
                'upsell':                    'tyme bank account sale',
                'not working cannot afford': 'cannot afford',
            }
            for alias, real_key in ALIASES.items():
                if real_key in pivot_data_by_description and alias not in pivot_data_by_description:
                    pivot_data_by_description[alias] = pivot_data_by_description[real_key]

            for label, row_data in summary_entries.items():
                pivot_data_by_description[label] = list(row_data)

            # Load template and recreate with values
            src_wb    = load_workbook(template_obj.template_file.path)
            new_wb    = openpyxl.Workbook()
            new_wb.remove(new_wb.active)

            for sheet_name in src_wb.sheetnames:
                src_sheet = src_wb[sheet_name]
                new_sheet = new_wb.create_sheet(title=sheet_name)

                for row in src_sheet.iter_rows():
                    for cell in row:
                        nc = new_sheet.cell(row=cell.row, column=cell.column)
                        if cell.has_style:
                            try:
                                nc.font          = cell.font.copy()
                                nc.border        = cell.border.copy()
                                nc.fill          = cell.fill.copy()
                                nc.number_format = cell.number_format
                                nc.alignment     = cell.alignment.copy()
                            except Exception:
                                pass
                        # Preserve formulas; keep col-1 labels; clear everything else
                        if cell.data_type == 'f' and cell.value and str(cell.value).startswith('='):
                            nc.value = cell.value
                        elif cell.column == 1:
                            nc.value = cell.value
                        else:
                            nc.value = None

                for mr in src_sheet.merged_cells.ranges:
                    new_sheet.merge_cells(str(mr))
                for col_idx in range(1, src_sheet.max_column + 1):
                    cl = get_column_letter(col_idx)
                    if cl in src_sheet.column_dimensions:
                        new_sheet.column_dimensions[cl].width = src_sheet.column_dimensions[cl].width
                for ri in range(1, src_sheet.max_row + 1):
                    if ri in src_sheet.row_dimensions:
                        new_sheet.row_dimensions[ri].height = src_sheet.row_dimensions[ri].height

            # Populate matching rows in the first sheet of the template.
            #
            # RULES (per user requirements):
            #   - NEVER touch column A — the template's labels stay exactly
            #     as uploaded (no overwriting, no case changes)
            #   - Write ONLY the VALUE, into the template's real data column.
            #     Templates often merge column A across many columns (e.g.
            #     A:JK merged, data at JL) — so the data column is detected
            #     as (widest col-A merge end) + 1, falling back to col 2.
            #   - If the target cell is inside another merge, redirect the
            #     write to that merge's master (top-left) cell.
            #   - Formula cells are never overwritten.
            target_sheet_name = src_wb.sheetnames[0]
            tws = new_wb[target_sheet_name]
            rows_populated = 0

            # Detect the data column from column-A merges
            a_merge_end = 1
            for mr in tws.merged_cells.ranges:
                if mr.min_col == 1 and mr.max_col > a_merge_end:
                    a_merge_end = mr.max_col
            data_col = a_merge_end + 1 if a_merge_end > 1 else 2
            print(f"📌 Sheet1 data column: {data_col} "
                  f"({get_column_letter(data_col)}) — "
                  f"col A merges end at {a_merge_end}")

            # Merge-master lookup so writes inside merges go to the
            # top-left (writable) cell of that merge
            merge_master = {}
            for mr in tws.merged_cells.ranges:
                master = (mr.min_row, mr.min_col)
                for r in range(mr.min_row, mr.max_row + 1):
                    for c in range(mr.min_col, mr.max_col + 1):
                        merge_master[(r, c)] = master

            for row_idx in range(1, tws.max_row + 1):
                desc_cell = tws.cell(row=row_idx, column=1)
                desc = str(desc_cell.value).strip().lower() if desc_cell.value else ""
                if not desc:
                    continue
                if desc not in pivot_data_by_description:
                    continue

                row_data = pivot_data_by_description[desc]
                # row_data shape: [description, value] — we only want the VALUE
                val = row_data[1] if len(row_data) > 1 else None
                if val is None:
                    continue

                # Resolve merge master for the target cell
                write_row, write_col = merge_master.get(
                    (row_idx, data_col), (row_idx, data_col)
                )
                cell = tws.cell(row=write_row, column=write_col)

                # Never overwrite formulas
                if cell.data_type == 'f' or (
                    cell.value is not None
                    and isinstance(cell.value, str)
                    and cell.value.strip().startswith('=')
                ):
                    continue

                try:
                    if isinstance(val, float) and val != int(val):
                        cell.value = float(val)     # ratios/percentages
                    elif isinstance(val, (int, float)):
                        cell.value = int(val)
                    else:
                        cell.value = val
                except Exception:
                    cell.value = val

                rows_populated += 1
                print(f"  ✅ row {row_idx:3d} → "
                      f"{get_column_letter(write_col)}{write_row}: "
                      f"'{desc_cell.value}' = {val}")

            print(f"✅ Sheet1 populated: {rows_populated} rows matched "
                  f"(labels untouched, values in col "
                  f"{get_column_letter(data_col)})")

            # Add the existing sheets (Processed Data, Pivot, Lead Count,
            # Campaign Analysis, Call Count Breakdown/Agent Performance if
            # built) from the xlsxwriter output into new_wb. Lead Count
            # must be included here — Campaign Analysis's %-of-total-leads
            # formulas reference 'Lead Count'!$B$3 directly, so omitting it
            # would leave those formulas pointing at a sheet that doesn't
            # exist in the final merged workbook.
            for extra_name in ['Processed Data', 'Pivot', 'Lead Count', 'Campaign Analysis', 'Call Count Breakdown', 'Agent Performance']:
                if extra_name in xl_wb.sheetnames:
                    src_extra = xl_wb[extra_name]
                    dst_extra = new_wb.create_sheet(title=extra_name)
                    for row in src_extra.iter_rows():
                        for cell in row:
                            nc = dst_extra.cell(row=cell.row, column=cell.column)
                            nc.value = cell.value
                            if cell.has_style:
                                try:
                                    nc.font = cell.font.copy()
                                    nc.border = cell.border.copy()
                                    nc.fill = cell.fill.copy()
                                    nc.number_format = cell.number_format
                                    nc.alignment = cell.alignment.copy()
                                except Exception:
                                    pass
                    for mr in src_extra.merged_cells.ranges:
                        dst_extra.merge_cells(str(mr))
                    # Column widths / row heights aren't cell properties — copy them
                    # separately, or wide merged headers (e.g. Campaign Analysis) come
                    # out at Excel's default width and truncate.
                    for col_letter, dim in src_extra.column_dimensions.items():
                        if dim.width:
                            dst_extra.column_dimensions[col_letter].width = dim.width
                    for row_idx, dim in src_extra.row_dimensions.items():
                        if dim.height:
                            dst_extra.row_dimensions[row_idx].height = dim.height

            # Reorder sheets EXACTLY as requested:
            # 1. Processed Data  2. Sheet1  3. Lead Count  4. Campaign Analysis
            # 5. Call Count Breakdown (if built)  6. Agent Performance (if built)  7. Pivot
            desired_order = ['Processed Data', target_sheet_name, 'Lead Count', 'Campaign Analysis', 'Call Count Breakdown', 'Agent Performance', 'Pivot']
            for i, name in enumerate(desired_order):
                if name in new_wb.sheetnames:
                    idx = new_wb.sheetnames.index(name)
                    new_wb.move_sheet(name, offset=i - idx)

            # Save final combined workbook
            final_output = BytesIO()
            new_wb.save(final_output)
            final_output.seek(0)
            file_bytes = final_output.getvalue()

        else:
            # No template — save the 3-sheet workbook (no Sheet1)
            print(f"⚠️  No template found for campaign '{campaign.display_name}' "
                  f"— saving 3-sheet report (no Sheet1)")
            workbook.close()
            output.seek(0)
            file_bytes = output.getvalue()

        # ── Save the report to disk ────────────────────────────────────
        reports_dir = os.path.join(settings.MEDIA_ROOT, 'reports')
        os.makedirs(reports_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename  = f"full_report_{campaign.name}_{timestamp}.xlsx"
        filepath  = os.path.join(reports_dir, filename)

        with open(filepath, 'wb') as f:
            f.write(file_bytes)

        # ── Save GeneratedReport record ────────────────────────────────
        report = GeneratedReport.objects.create(
            user=file_instance.user,
            campaign=campaign,
            report_type='campaign_analysis',
            file=f"reports/{filename}",
            parameters={
                'campaign_id':     campaign.id,
                'campaign_name':   campaign.display_name,
                'source_file':     file_instance.original_name,
                'record_count':    total_leads,
                'auto_generated':  True,
                'has_sheet1':      'template' in wanted and template_obj is not None,
                'template_name':   template_obj.name if ('template' in wanted and template_obj) else None,
                'rows_populated':  rows_populated if ('template' in wanted and template_obj) else 0,
                'has_agent_performance': agent_rows is not None,
                'agent_count':     len(agent_rows) if agent_rows else 0,
                'agent_performance_error': agent_performance_error,
                'has_call_count_breakdown': call_counts is not None,
                'call_count_breakdown_error': call_count_breakdown_error,
                'metrics': {
                    'total_leads':         total_leads,
                    'total_dispositions':  total_dispositions,
                    'unworked_leads':      unworked_leads,
                    'successful_contacts': successful_contacts,
                    'true_contacts':       true_contacts,
                    'conversion_pct':      round(conversion_value, 2),
                    'true_sales':          true_sales,
                }
            }
        )

        print(f"Report saved: {filename} (ID: {report.id})")
        print(f"Sheets: {new_wb.sheetnames if template_obj else '3-sheet (no template)'}")
        print(f"{'='*60}\n")
        return report

    @action(detail=False, methods=['post'])
    def generate_campaign(self, request):
        """
        Generate the FULL 4-sheet campaign report on demand.

        Produces ONE workbook with sheets in this exact order:
          1. Processed Data     – raw records from the latest upload
          2. Sheet1 (template)  – the campaign's template, populated with values
          3. Campaign Analysis  – summary metrics + category breakdowns
          4. Pivot              – counts per outcome description

        This is the SAME file that gets auto-generated when a data file is
        uploaded — this endpoint just regenerates it on demand (e.g. after
        uploading a new template or re-uploading data).

        Required POST body field: campaign_id
        Optional POST body field: sheets — a list of sheet keys from
        ReportViewSet.ALL_REPORT_SHEETS limiting which sheets get built.
        Omitted/empty means all sheets, the historical behaviour.
        Optional POST body field: full_outcome_history (bool, default
        False) — when True, Pivot/Campaign Analysis count every historical
        disposition instead of each contact's latest only. Opt-in because
        it's a full external-DB scan that can take several minutes on a
        busy campaign (see _auto_generate_full_report's docstring).
        """
        try:
            print("=" * 50)
            print("GENERATE REPORT (manual trigger)")

            campaign_id = request.data.get('campaign_id')
            if not campaign_id:
                return Response(
                    {'success': False,
                     'error': 'campaign_id is required in the request body.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            sheets = request.data.get('sheets')
            if sheets is not None:
                invalid = set(sheets) - ReportViewSet.ALL_REPORT_SHEETS
                if invalid:
                    return Response(
                        {'success': False,
                         'error': f'Unknown sheet(s): {", ".join(sorted(invalid))}. '
                                  f'Valid values: {", ".join(sorted(ReportViewSet.ALL_REPORT_SHEETS))}.'},
                        status=status.HTTP_400_BAD_REQUEST
                    )

            full_outcome_history = bool(request.data.get('full_outcome_history', False))

            try:
                campaign_obj = Campaign.objects.get(id=campaign_id, is_active=True)
            except Campaign.DoesNotExist:
                return Response(
                    {'success': False,
                     'error': f'Campaign with ID {campaign_id} not found.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            user = request.user if request.user.is_authenticated else None

            # Find the latest processed file for THIS campaign
            qs = CallDataFile.objects.filter(
                campaign=campaign_obj,
                status='processed'
            )
            if user:
                qs = qs.filter(user=user)
            latest_file = qs.order_by('-uploaded_at').first()

            if not latest_file:
                return Response(
                    {'success': False,
                     'error': f'No processed files found for campaign '
                              f'"{campaign_obj.display_name}". '
                              f'Upload a data file first.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            print(f"Campaign : {campaign_obj.display_name}")
            print(f"Source   : {latest_file.original_name}")

            # Delegate to the SAME generator used by auto-generation,
            # so manual and automatic reports are always identical.
            report = ReportViewSet._auto_generate_full_report(
                latest_file, sheets=sheets, full_outcome_history=full_outcome_history
            )

            if report is None:
                return Response(
                    {'success': False,
                     'error': 'Report generation produced no output. '
                              'Check that the file has processed records.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            metrics = report.parameters.get('metrics', {})

            return Response({
                'success': True,
                'data': {
                    'report_id':    report.id,
                    'download_url': f'/api/reports/{report.id}/download/',
                    'campaign':     campaign_obj.display_name,
                    'record_count': report.parameters.get('record_count', 0),
                    'has_sheet1':   report.parameters.get('has_sheet1', False),
                    'metrics':      metrics,
                    'message':      'Full 4-sheet report generated successfully.',
                }
            })

        except Exception as e:
            print(f"❌ REPORT ERROR: {e}")
            traceback.print_exc()
            return Response(
                {'success': False, 'error': f'Generation failed: {e}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    COMBINED_REPORT_SHEETS = {
        'processed_data', 'pivot', 'campaign_analysis',
        'agent_performance', 'call_count_breakdown',
    }

    @staticmethod
    def _generate_combined_report(campaigns, file_ids=None, sheets=None, user=None,
                                   start_date=None, end_date=None, start_time=None, end_time=None,
                                   full_outcome_history=False, sync_missing=True):
        """
        Builds one workbook combining several campaigns' processed data into
        comparison-style sheets — every sheet gets a leading Campaign column
        rather than each campaign getting its own tab.

        Unlike _auto_generate_full_report this doesn't clone a per-campaign
        template (there's no single coherent template across campaigns that
        may each have their own), so 'template' isn't a valid sheet here,
        and Campaign Analysis is a plain per-campaign comparison table with
        computed values rather than live VLOOKUPs against a per-campaign
        Pivot sheet — there's no single Pivot range that could serve every
        campaign's formulas at once.

        file_ids: optional explicit list of CallDataFile ids to pull from,
        spanning any mix of the given campaigns — lets a caller pick which
        upload/sync batch(es) to include per campaign instead of always the
        latest. Campaigns with none of their files represented here fall
        back to their single latest processed file (the original default
        behaviour), so omitting file_ids entirely preserves it for every
        campaign.

        start_date/end_date/start_time/end_time: optional strings (dates as
        'YYYY-MM-DD', times as 'HH:MM' or 'HH:MM:SS') scoping every sheet to
        records whose last_called_date falls in that range — same fields
        CampaignViewSet.sync_from_database already takes. When given, this
        range is also used directly as the Agent Performance/Call Count
        Breakdown external-database query window instead of aggregating
        min/max from the (now range-filtered) processed data.

        sheets: iterable of keys from COMBINED_REPORT_SHEETS. None means
        {'processed_data','pivot','campaign_analysis'} — Agent Performance
        and Call Count Breakdown are opt-in only even by default, since each
        is N external-database round trips (one or two per campaign, see
        external_source.fetch_agent_performance/fetch_contact_call_counts).

        full_outcome_history (default False, opt-in): same meaning as
        _auto_generate_full_report's parameter of the same name — counts
        every historical disposition per campaign instead of each contact's
        latest only. Verified to take several minutes per campaign on a
        busy one, so it's opt-in here too, applied per campaign (skipped
        for any campaign without a cd_campaign_id, same fallback as the
        single-campaign report).

        sync_missing (default True): when a selected campaign has no
        processed CallDataFile at all (and none of file_ids covers it
        either), pull its data from the external source database on the
        spot — same sync_campaign_from_database call the single-campaign
        Upload page's "Sync from Database" button makes, with
        auto_generate_report=False since this method builds its own
        workbook rather than needing a separate per-campaign report. Scoped
        by start_date/end_date/start_time/end_time like everything else
        here. Pass False to instead skip such campaigns immediately, same
        as this method's older behaviour.

        Returns (report, skipped) where report is the GeneratedReport (or
        None if no campaign had any matching processed data at all) and
        skipped is a list of {'campaign_id','display_name','reason'} for
        campaigns left out.
        """
        from django.conf import settings
        import xlsxwriter, os
        from io import BytesIO
        from datetime import datetime
        from django.db.models import Count, Min, Max
        from django.utils.dateparse import parse_datetime
        from django.utils import timezone as dj_timezone
        from .external_source import sync_campaign_from_database, ExternalSourceError

        wanted = set(sheets) if sheets else {'processed_data', 'pivot', 'campaign_analysis'}
        wanted &= ReportViewSet.COMBINED_REPORT_SHEETS
        if not wanted:
            wanted = {'processed_data', 'pivot', 'campaign_analysis'}

        def _bound(date_str, time_str, default_time):
            if not date_str:
                return None
            dt = parse_datetime(f"{date_str} {time_str or default_time}")
            if dt is None:
                return None
            if dj_timezone.is_naive(dt):
                dt = dj_timezone.make_aware(dt)
            return dt

        range_start = _bound(start_date, start_time, '00:00:00')
        range_end = _bound(end_date, end_time, '23:59:59')

        files_by_campaign = {}
        if file_ids:
            for f in CallDataFile.objects.filter(id__in=file_ids, status='processed').select_related('campaign'):
                files_by_campaign.setdefault(f.campaign_id, []).append(f)

        # Same category terms _auto_generate_full_report uses for its
        # single-campaign summary metrics — duplicated here rather than
        # shared because the single-campaign version computes them inline
        # rather than as a module-level constant.
        SALE_TERMS = [
            'sale made', 'upsell', 'tyme bank account sale',
            'sale made - completed mandate', 'sale made - pending mandate',
            'qa verify',
        ]
        TRUE_CONTACT_TERMS = [
            'not interested', 'callback', 'call back', 'client hung up',
            'affordability', 'cannot afford', 'declined sale', 'qa rework',
            'qa fail', 'quoted client not interested', 'not interested upfront',
            'call back hold', 'not interested transaction fees',
            'cannot afford premium', 'not interested household contents',
            'not interested sms', 'call back via ms teams',
        ]
        # See _auto_generate_full_report's identical fetch for why: SALE_TERMS
        # is a name-keyword guess that can miss a campaign's real
        # conversions outright (e.g. Vodacom Retentions' actual sale=1
        # outcomes contain no sales keyword at all) — OR-ing in the
        # dialer's own authoritative flag closes that gap without changing
        # anything for campaigns the keyword list already matched.
        try:
            from .external_source import fetch_sale_outcome_names
            sale_outcome_names = fetch_sale_outcome_names()
        except Exception as e:
            print(f"⚠️  Could not fetch authoritative sale outcome names, "
                  f"falling back to SALE_TERMS only: {e}")
            sale_outcome_names = set()

        # ── Resolve which file(s) + per-campaign data ────────────────────
        entries = []
        skipped = []
        outcome_history_skipped_ranges = []  # (campaign_display_name, start, end) tuples, across all campaigns
        for campaign in campaigns:
            campaign_files = files_by_campaign.get(campaign.id)
            if campaign_files:
                query = ProcessedData.objects.filter(call_data_file__in=campaign_files)
            else:
                latest_file = CallDataFile.objects.filter(
                    campaign=campaign, status='processed'
                ).order_by('-uploaded_at').first()
                if not latest_file and sync_missing:
                    if not campaign.cd_campaign_id:
                        skipped.append({'campaign_id': campaign.id, 'display_name': campaign.display_name,
                                         'reason': 'No processed data file for this campaign, and no '
                                                    'cd_campaign_id configured to sync one from the database.'})
                        continue
                    try:
                        latest_file = sync_campaign_from_database(
                            campaign, user=user, start_date=start_date, end_date=end_date,
                            start_time=start_time, end_time=end_time, auto_generate_report=False,
                        )
                    except ExternalSourceError as e:
                        skipped.append({'campaign_id': campaign.id, 'display_name': campaign.display_name,
                                         'reason': f'Database sync failed: {e}'})
                        continue
                    except Exception as e:
                        skipped.append({'campaign_id': campaign.id, 'display_name': campaign.display_name,
                                         'reason': f'Database sync failed: {e}'})
                        continue
                if not latest_file:
                    skipped.append({'campaign_id': campaign.id, 'display_name': campaign.display_name,
                                     'reason': 'No processed data file for this campaign.'})
                    continue
                query = ProcessedData.objects.filter(call_data_file=latest_file)

            if range_start:
                query = query.filter(last_called_date__gte=range_start)
            if range_end:
                query = query.filter(last_called_date__lte=range_end)

            if not query.exists():
                reason = ('No processed records in the selected date range.' if (range_start or range_end)
                          else 'Selected file(s) have no processed records.')
                skipped.append({'campaign_id': campaign.id, 'display_name': campaign.display_name,
                                 'reason': reason})
                continue

            outcome_map = _build_outcome_map(campaign)
            total_leads = query.count()

            # description_counts reflects every historical disposition for
            # this campaign, not just each contact's current/latest outcome
            # — same reasoning as _auto_generate_full_report's identical
            # fallback chain (see its comments). Reuses the combined
            # report's own date range when one was given (range_start/
            # range_end, from the modal's Date & Time Range fields) so the
            # outcome history matches whatever scope the caller asked for;
            # falls back to default_campaign_date_range otherwise.
            description_counts = None
            if full_outcome_history and campaign.cd_campaign_id:
                try:
                    from .external_source import fetch_outcome_history_counts, default_campaign_date_range
                    if range_start or range_end:
                        hist_start, hist_end = range_start, range_end
                    else:
                        hist_start, hist_end = default_campaign_date_range(campaign)
                    raw_history_counts, campaign_skipped_ranges = fetch_outcome_history_counts(
                        campaign.cd_campaign_id, start_dt=hist_start, end_dt=hist_end
                    )
                    description_counts = {}
                    for key, count in raw_history_counts.items():
                        desc = outcome_map.get(key, key)
                        description_counts[desc] = description_counts.get(desc, 0) + count
                    for s, e in campaign_skipped_ranges:
                        outcome_history_skipped_ranges.append((campaign.display_name, s, e))
                except Exception as e:
                    print(f"⚠️  Outcome history query failed for '{campaign.display_name}', "
                          f"falling back to latest-outcome counting: {e}")
                    description_counts = None

            if description_counts is None:
                raw_counts = query.values('last_outcome').annotate(count=Count('id'))
                description_counts = {}
                for item in raw_counts:
                    key = item['last_outcome'] or 'Unknown'
                    desc = outcome_map.get(key, key)
                    description_counts[desc] = description_counts.get(desc, 0) + item['count']

            true_sales = true_contacts = unworked_leads = 0
            for desc, count in description_counts.items():
                d = desc.lower().strip()
                if any(t in d for t in SALE_TERMS) or d in sale_outcome_names:
                    true_sales += count
                elif any(t in d for t in TRUE_CONTACT_TERMS):
                    true_contacts += count
                elif any(t == d or d.startswith(t) for t in ['new', 'not contacted']):
                    unworked_leads += count
            successful_contacts = true_contacts + true_sales
            conversion_value = (true_sales / total_leads) if total_leads else 0

            entries.append({
                'campaign': campaign,
                'query': query,
                'description_counts': description_counts,
                'total_leads': total_leads,
                'total_dispositions': sum(description_counts.values()),
                'true_sales': true_sales,
                'true_contacts': true_contacts,
                'successful_contacts': successful_contacts,
                'conversion_value': conversion_value,
            })

        if not entries:
            return None, skipped

        print(f"\n{'='*60}")
        print(f"COMBINED REPORT: {len(entries)} campaign(s), "
              f"{len(skipped)} skipped, sheets={sorted(wanted)}")

        # ── Build workbook ───────────────────────────────────────────
        output = BytesIO()
        workbook = xlsxwriter.Workbook(output, {'nan_inf_to_errors': True})
        fmts = {
            'header': workbook.add_format({
                'bold': True, 'bg_color': '#366092', 'font_color': 'white',
                'border': 1, 'align': 'center', 'valign': 'vcenter'
            }),
            'cell': workbook.add_format({'border': 1, 'align': 'left', 'valign': 'vcenter'}),
            'number': workbook.add_format({'border': 1, 'align': 'center', 'num_format': '#,##0'}),
            'percent': workbook.add_format({'border': 1, 'align': 'center', 'num_format': '0.00%'}),
            'grand_total': workbook.add_format({
                'bold': True, 'bg_color': '#8EA9DB', 'border': 1, 'num_format': '#,##0'
            }),
            'italic_note': workbook.add_format({'italic': True, 'align': 'left', 'valign': 'vcenter'}),
        }

        # ── Processed Data (+ Call Count Breakdown's contact lookup) ────
        # Streamed via .values(...).iterator() per campaign rather than
        # materializing every record into a Python list or full ORM model
        # instances — a combined pull across several large campaigns (e.g.
        # Telkom LTE alone was 1.1M+ records) is easily too much to hold in
        # memory, and constructing that many live model instances (~35
        # fields of descriptor overhead each) is slow enough on its own to
        # make report generation look hung for well over an hour. .values()
        # returns plain dicts instead, and write_row() (one call per row)
        # replaces ~35 individual .write() calls per row for the same
        # reason: fewer, cheaper Python-level calls across tens of millions
        # of cells.
        #
        # This used to hard-cap at 10,000 rows total regardless of how many
        # records actually existed, while Pivot/Campaign Analysis kept
        # showing the true totals — the same sheet-to-sheet mismatch, just
        # here across every selected campaign at once. XLSX caps a single
        # SHEET at 1,048,576 rows, so once the combined total exceeds that
        # it now spills into "Processed Data (2)", "Processed Data (3)",
        # etc. (numbered continuously across campaigns) instead of silently
        # dropping rows.
        MAX_SHEET_DATA_ROWS = 1_000_000  # safely under Excel's 1,048,576-row ceiling, room for the header
        need_records_pass = 'processed_data' in wanted or 'call_count_breakdown' in wanted

        if need_records_pass:
            field_names = [
                f.name for f in ProcessedData._meta.fields
                if f.name not in ['id', 'call_data_file', 'processed_at', 'outcome_description']
            ]
            date_fields = {'last_called_date', 'created_at', 'updated_at', 'dob'}

            def _new_combined_data_sheet(idx):
                sheet_name = 'Processed Data' if idx == 1 else f'Processed Data ({idx})'
                ws = workbook.add_worksheet(sheet_name)
                ws.set_column(0, 0, 24)
                ws.write(0, 0, 'Campaign', fmts['header'])
                for col, field in enumerate(field_names, start=1):
                    ws.write(0, col, _column_header(field), fmts['header'])
                return ws

            data_ws = None
            data_sheet_index = 1
            data_row_num = 1
            if 'processed_data' in wanted:
                data_ws = _new_combined_data_sheet(data_sheet_index)

            total_processed_rows = 0
            for entry in entries:
                # Keyed by customer_id, only within this campaign — the same
                # raw id can mean different contacts across different source
                # campaigns, so this deliberately isn't merged into one
                # cross-campaign dict.
                entry['contact_lookup'] = {}

                for record in entry['query'].values(*field_names).iterator(chunk_size=5000):
                    if 'processed_data' in wanted:
                        if data_row_num > MAX_SHEET_DATA_ROWS:
                            data_sheet_index += 1
                            data_ws = _new_combined_data_sheet(data_sheet_index)
                            data_row_num = 1
                        data_ws.write(data_row_num, 0, entry['campaign'].display_name, fmts['cell'])
                        row_values = [
                            record[field].strftime('%Y-%m-%d %H:%M:%S') if field in date_fields and record[field] else record[field]
                            for field in field_names
                        ]
                        data_ws.write_row(data_row_num, 1, row_values)
                        data_row_num += 1

                    if 'call_count_breakdown' in wanted and record['customer_id']:
                        name = f"{(record['firstname'] or '').strip()} {(record['lastname'] or '').strip()}".strip()
                        entry['contact_lookup'][str(record['customer_id'])] = (record['contact_id'], name, record['tel1'] or '')

                    total_processed_rows += 1

            if 'processed_data' in wanted:
                print(f"✅ Combined Processed Data: {total_processed_rows} rows across {data_sheet_index} sheet(s)")

        if 'pivot' in wanted:
            pivot_ws = workbook.add_worksheet('Pivot')
            pivot_ws.set_column(0, 0, 24)
            pivot_ws.set_column(1, 1, 40)
            pivot_ws.set_column(2, 2, 14)
            pivot_ws.write(0, 0, 'Campaign', fmts['header'])
            pivot_ws.write(0, 1, 'Outcome Description', fmts['header'])
            pivot_ws.write(0, 2, 'Count', fmts['header'])
            r = 1
            grand_all = 0
            for entry in entries:
                for desc, count in sorted(entry['description_counts'].items(), key=lambda x: x[1], reverse=True):
                    pivot_ws.write(r, 0, entry['campaign'].display_name, fmts['cell'])
                    pivot_ws.write(r, 1, desc, fmts['cell'])
                    pivot_ws.write(r, 2, count, fmts['number'])
                    r += 1
                grand_all += entry['total_dispositions']
            pivot_ws.write(r, 1, 'Grand Total', fmts['grand_total'])
            pivot_ws.write(r, 2, grand_all, fmts['grand_total'])
            print(f"✅ Combined Pivot: {r - 1} rows")

            # Surfaced in the sheet itself, not just a server console log —
            # see _auto_generate_full_report's identical note for why.
            if outcome_history_skipped_ranges:
                note_row = r + 2
                ranges_str = "; ".join(
                    f"{name}: {s.strftime('%Y-%m-%d')} to {e.strftime('%Y-%m-%d')}"
                    for name, s, e in outcome_history_skipped_ranges
                )
                pivot_ws.merge_range(
                    note_row, 0, note_row, 2,
                    f"⚠ {len(outcome_history_skipped_ranges)} date range(s) could not be fully "
                    f"scanned in time and may be undercounted: {ranges_str}",
                    fmts['italic_note']
                )

        if 'campaign_analysis' in wanted:
            ca_ws = workbook.add_worksheet('Campaign Analysis')
            ca_ws.set_column(0, 0, 28)
            ca_ws.set_column(1, 5, 18)
            headers = ['Campaign', 'Total Leads', 'Successful Contacts',
                       'True Contacts', 'True Sales', 'Conversion %']
            for col, h in enumerate(headers):
                ca_ws.write(0, col, h, fmts['header'])
            r = 1
            totals = {'leads': 0, 'sc': 0, 'tc': 0, 'ts': 0}
            for entry in entries:
                ca_ws.write(r, 0, entry['campaign'].display_name, fmts['cell'])
                ca_ws.write(r, 1, entry['total_leads'], fmts['number'])
                ca_ws.write(r, 2, entry['successful_contacts'], fmts['number'])
                ca_ws.write(r, 3, entry['true_contacts'], fmts['number'])
                ca_ws.write(r, 4, entry['true_sales'], fmts['number'])
                ca_ws.write(r, 5, entry['conversion_value'], fmts['percent'])
                totals['leads'] += entry['total_leads']
                totals['sc'] += entry['successful_contacts']
                totals['tc'] += entry['true_contacts']
                totals['ts'] += entry['true_sales']
                r += 1
            ca_ws.write(r, 0, 'GRAND TOTAL', fmts['grand_total'])
            ca_ws.write(r, 1, totals['leads'], fmts['grand_total'])
            ca_ws.write(r, 2, totals['sc'], fmts['grand_total'])
            ca_ws.write(r, 3, totals['tc'], fmts['grand_total'])
            ca_ws.write(r, 4, totals['ts'], fmts['grand_total'])
            overall_conv = (totals['ts'] / totals['leads']) if totals['leads'] else 0
            ca_ws.write(r, 5, overall_conv, fmts['grand_total'])
            print(f"✅ Combined Campaign Analysis: {len(entries)} campaign row(s)")

        if 'agent_performance' in wanted:
            from .external_source import fetch_agent_performance
            ap_ws = workbook.add_worksheet('Agent Performance')
            headers = ['Campaign', 'User', 'Team', 'Outbound', 'Inbound', 'Combined',
                       'Connects', 'Connect Rate', 'DMCs', 'DMC Rate', 'Sales',
                       'Conversion', 'Completed']
            for col, h in enumerate(headers):
                ap_ws.write(0, col, h, fmts['header'])
            ap_ws.set_column(0, 1, 22)
            r = 1
            for entry in entries:
                campaign = entry['campaign']
                if not campaign.cd_campaign_id:
                    continue
                if range_start or range_end:
                    span_start, span_end = range_start, range_end
                else:
                    date_span = entry['query'].aggregate(min_date=Min('last_called_date'), max_date=Max('last_called_date'))
                    span_start, span_end = date_span['min_date'], date_span['max_date']
                try:
                    agent_rows = fetch_agent_performance(
                        campaign.cd_campaign_id,
                        start_dt=span_start, end_dt=span_end,
                    )
                except Exception as e:
                    print(f"⚠️  Agent Performance skipped for '{campaign.display_name}': {e}")
                    continue
                for a in agent_rows:
                    ap_ws.write(r, 0, campaign.display_name, fmts['cell'])
                    ap_ws.write(r, 1, a['display_name'], fmts['cell'])
                    ap_ws.write(r, 2, a['team_name'], fmts['cell'])
                    ap_ws.write(r, 3, a['outbound'], fmts['number'])
                    ap_ws.write(r, 4, a['inbound'], fmts['number'])
                    ap_ws.write(r, 5, a['combined'], fmts['number'])
                    ap_ws.write(r, 6, a['connects'], fmts['number'])
                    ap_ws.write(r, 7, a['connect_rate'], fmts['percent'])
                    ap_ws.write(r, 8, a['dmcs'], fmts['number'])
                    ap_ws.write(r, 9, a['dmc_rate'], fmts['percent'])
                    ap_ws.write(r, 10, a['sales'], fmts['number'])
                    ap_ws.write(r, 11, a['conversion'], fmts['percent'])
                    ap_ws.write(r, 12, a['completed'], fmts['number'])
                    r += 1
            print(f"✅ Combined Agent Performance: {r - 1} rows")

        if 'call_count_breakdown' in wanted:
            from .external_source import fetch_contact_call_counts
            ccb_ws = workbook.add_worksheet('Call Count Breakdown')
            headers = ['Campaign', 'Contact ID', 'Name', 'Phone', 'Times Contacted']
            for col, h in enumerate(headers):
                ccb_ws.write(0, col, h, fmts['header'])
            ccb_ws.set_column(0, 0, 22)
            ccb_ws.set_column(2, 2, 26)
            r = 1
            for entry in entries:
                campaign = entry['campaign']
                if not campaign.cd_campaign_id:
                    continue
                if range_start or range_end:
                    span_start, span_end = range_start, range_end
                else:
                    date_span = entry['query'].aggregate(min_date=Min('last_called_date'), max_date=Max('last_called_date'))
                    span_start, span_end = date_span['min_date'], date_span['max_date']
                try:
                    call_counts = fetch_contact_call_counts(
                        campaign.cd_campaign_id,
                        start_dt=span_start, end_dt=span_end,
                    )
                except Exception as e:
                    print(f"⚠️  Call Count Breakdown skipped for '{campaign.display_name}': {e}")
                    continue
                contact_lookup = entry.get('contact_lookup', {})
                for customer_id, count in sorted(call_counts.items(), key=lambda kv: kv[1], reverse=True):
                    looked_up = contact_lookup.get(customer_id)
                    contact_id, name, phone = looked_up if looked_up else (customer_id, '', '')
                    ccb_ws.write(r, 0, campaign.display_name, fmts['cell'])
                    ccb_ws.write(r, 1, contact_id, fmts['cell'])
                    ccb_ws.write(r, 2, name or '—', fmts['cell'])
                    ccb_ws.write(r, 3, phone or '—', fmts['cell'])
                    ccb_ws.write(r, 4, count, fmts['number'])
                    r += 1
            print(f"✅ Combined Call Count Breakdown: {r - 1} rows")

        workbook.close()
        output.seek(0)
        file_bytes = output.getvalue()

        # ── Save to disk + GeneratedReport ───────────────────────────
        reports_dir = os.path.join(settings.MEDIA_ROOT, 'reports')
        os.makedirs(reports_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        names_slug = '_'.join(e['campaign'].name for e in entries)[:80]
        filename = f"combined_report_{names_slug}_{timestamp}.xlsx"
        filepath = os.path.join(reports_dir, filename)
        with open(filepath, 'wb') as f:
            f.write(file_bytes)

        total_leads_all = sum(e['total_leads'] for e in entries)
        total_dispositions_all = sum(e['total_dispositions'] for e in entries)
        report = GeneratedReport.objects.create(
            user=user,
            campaign=None,
            report_type='campaign_data',
            file=f"reports/{filename}",
            parameters={
                'combined': True,
                'campaign_ids': [e['campaign'].id for e in entries],
                'campaign_names': [e['campaign'].display_name for e in entries],
                'skipped': skipped,
                'sheets': sorted(wanted),
                'file_ids': list(file_ids) if file_ids else None,
                'date_range': {'start': start_date, 'end': end_date,
                                'start_time': start_time, 'end_time': end_time},
                'record_count': total_leads_all,
                'metrics': {
                    'total_leads': total_leads_all,
                    'total_dispositions': total_dispositions_all,
                    'successful_contacts': sum(e['successful_contacts'] for e in entries),
                    'true_contacts': sum(e['true_contacts'] for e in entries),
                    'true_sales': sum(e['true_sales'] for e in entries),
                },
            }
        )
        print(f"Combined report saved: {filename} (ID: {report.id})")
        print(f"{'='*60}\n")
        return report, skipped

    @action(detail=False, methods=['post'])
    def generate_combined(self, request):
        """
        Generate one report combining several campaigns at once — see
        ReportViewSet._generate_combined_report for the sheet layout and
        why it differs from the single-campaign report.

        Required POST body field: campaign_ids (non-empty list).
        Optional: sheets (list of keys from ReportViewSet.COMBINED_REPORT_SHEETS;
        'template' is not valid for a combined report — there's no single
        template to clone across campaigns that may each have their own).
        Optional: file_ids (list of CallDataFile ids — which upload/sync
        batch(es) to pull from per campaign; a campaign with none of its
        files listed here falls back to its single latest processed file).
        Optional: start_date/end_date ('YYYY-MM-DD') and start_time/end_time
        ('HH:MM' or 'HH:MM:SS') — scopes every sheet to records whose
        last_called_date falls in that range.
        Optional: full_outcome_history (bool, default False) — see
        _generate_combined_report's docstring; opt-in since it's a full
        external-DB scan per campaign that can take several minutes each.
        Optional: sync_missing (bool, default True) — see
        _generate_combined_report's docstring; auto-syncs any selected
        campaign with no processed data yet from the external database,
        same as the single-campaign Upload page's "Sync from Database".
        Pass False to skip such campaigns instead, as this used to always do.
        """
        try:
            campaign_ids = request.data.get('campaign_ids')
            if not campaign_ids or not isinstance(campaign_ids, list):
                return Response(
                    {'success': False, 'error': 'campaign_ids (a non-empty list) is required.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            sheets = request.data.get('sheets')
            if sheets is not None:
                invalid = set(sheets) - ReportViewSet.COMBINED_REPORT_SHEETS
                if invalid:
                    return Response(
                        {'success': False,
                         'error': f'Unknown sheet(s) for a combined report: {", ".join(sorted(invalid))}. '
                                  f'Valid values: {", ".join(sorted(ReportViewSet.COMBINED_REPORT_SHEETS))}.'},
                        status=status.HTTP_400_BAD_REQUEST
                    )

            file_ids = request.data.get('file_ids') or None
            start_date = request.data.get('start_date') or None
            end_date = request.data.get('end_date') or None
            start_time = request.data.get('start_time') or None
            end_time = request.data.get('end_time') or None
            full_outcome_history = bool(request.data.get('full_outcome_history', False))
            sync_missing = bool(request.data.get('sync_missing', True))

            campaigns = list(Campaign.objects.filter(id__in=campaign_ids, is_active=True))
            if not campaigns:
                return Response(
                    {'success': False, 'error': 'None of the given campaign_ids matched an active campaign.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            user = request.user if request.user.is_authenticated else None
            report, skipped = ReportViewSet._generate_combined_report(
                campaigns, file_ids=file_ids, sheets=sheets, user=user,
                start_date=start_date, end_date=end_date,
                start_time=start_time, end_time=end_time,
                full_outcome_history=full_outcome_history, sync_missing=sync_missing,
            )

            if report is None:
                return Response(
                    {'success': False,
                     'error': 'None of the selected campaigns have processed data yet.',
                     'skipped': skipped},
                    status=status.HTTP_400_BAD_REQUEST
                )

            return Response({
                'success': True,
                'data': {
                    'report_id':    report.id,
                    'download_url': f'/api/reports/{report.id}/download/',
                    'campaigns':    report.parameters.get('campaign_names', []),
                    'skipped':      skipped,
                    'metrics':      report.parameters.get('metrics', {}),
                    'message':      f'Combined report generated for {len(campaigns) - len(skipped)} of '
                                     f'{len(campaigns)} selected campaign(s).',
                }
            })

        except Exception as e:
            print(f"❌ COMBINED REPORT ERROR: {e}")
            traceback.print_exc()
            return Response(
                {'success': False, 'error': f'Generation failed: {e}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @action(detail=False, methods=['get'], url_path='debug_analysis')
    def debug_analysis(self, request):
        """
        Debug endpoint: shows what's in the Pivot vs what's in the template.
        Call: GET /api/reports/debug_analysis/?campaign_id=X&template_id=Y
        """
        campaign_id = request.query_params.get('campaign_id')
        template_id = request.query_params.get('template_id')

        result = {}

        # Show Pivot content
        if campaign_id:
            report = GeneratedReport.objects.filter(
                report_type='campaign_analysis',
                campaign_id=campaign_id
            ).order_by('-generated_at').first()

            if report:
                try:
                    wb = load_workbook(report.file.path)
                    result['campaign_report_id'] = report.id
                    result['campaign_report_sheets'] = wb.sheetnames

                    if 'Pivot' in wb.sheetnames:
                        pivot_ws = wb['Pivot']
                        pivot_rows = []
                        for i, row in enumerate(pivot_ws.iter_rows(values_only=True)):
                            if i > 50: break  # limit output
                            pivot_rows.append({'col_a': row[0], 'col_b': row[1]})
                        result['pivot_rows'] = pivot_rows
                        result['pivot_row_count'] = pivot_ws.max_row
                    else:
                        result['pivot_error'] = 'No Pivot sheet found'
                except Exception as e:
                    result['campaign_report_error'] = str(e)
            else:
                result['campaign_report_error'] = f'No campaign_analysis report found for campaign {campaign_id}'

        # Show template content
        if template_id:
            try:
                template = ReportTemplate.objects.get(id=template_id)
                result['template_name'] = template.name
                result['template_sheets'] = template.sheet_names

                wb2 = load_workbook(template.template_file.path)
                result['template_actual_sheets'] = wb2.sheetnames

                # Show column A of first sheet
                first_sheet = wb2.active
                sheet_labels = []
                for row_idx in range(1, min(first_sheet.max_row + 1, 100)):
                    cell_a = first_sheet.cell(row=row_idx, column=1).value
                    cell_b = first_sheet.cell(row=row_idx, column=2).value
                    sheet_labels.append({
                        'row': row_idx,
                        'col_a': str(cell_a) if cell_a is not None else None,
                        'col_b_type': 'formula' if (cell_b and str(cell_b).startswith('=')) else 'value',
                        'col_b_val': str(cell_b)[:50] if cell_b is not None else None,
                    })
                result['template_first_sheet_labels'] = sheet_labels
            except Exception as e:
                result['template_error'] = str(e)

        return Response(result)

    @action(detail=False, methods=['post'], url_path='generate_campaign_analysis')
    def generate_campaign_analysis(self, request):
        """
        Generate a template-based campaign analysis report.

        Required POST body fields:
          - template_id   : ID of the uploaded ReportTemplate
          - campaign_name : Name of the sheet to populate in the template
          - campaign_id   : ID of the Campaign (for scoping)
        """
        try:
            template_id   = request.data.get('template_id')
            campaign_name = request.data.get('campaign_name')
            campaign_id   = request.data.get('campaign_id')

            print(f"generate_campaign_analysis: template={template_id}, "
                  f"sheet={campaign_name}, campaign_id={campaign_id}")

            if not template_id:
                return Response({'success': False, 'error': 'template_id is required'},
                                status=status.HTTP_400_BAD_REQUEST)
            if not campaign_name:
                return Response({'success': False, 'error': 'campaign_name is required'},
                                status=status.HTTP_400_BAD_REQUEST)
            if not campaign_id:
                return Response({'success': False, 'error': 'campaign_id is required'},
                                status=status.HTTP_400_BAD_REQUEST)

            result = TemplateBasedReportGenerator.generate_analysis_report(
                template_id=template_id,
                data_mappings={'campaign': campaign_name},
                campaign_id=campaign_id,
                user=request.user if request.user.is_authenticated else None
            )
            return Response(result)

        except Exception as e:
            print(f"❌ Error in generate_campaign_analysis: {e}")
            traceback.print_exc()
            return Response({'success': False, 'error': str(e)},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ===========================================================
# REPORT TEMPLATE VIEWSET
# ===========================================================

class ReportTemplateViewSet(viewsets.ModelViewSet):
    """Manage report templates — campaign-scoped."""
    serializer_class = ReportTemplateSerializer
    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser]

    def get_queryset(self):
        """FIX: filter by campaign_id when provided so templates don't leak across campaigns."""
        queryset = ReportTemplate.objects.filter(is_active=True)
        campaign_id = self.request.query_params.get('campaign_id')
        if campaign_id:
            queryset = queryset.filter(campaign_id=campaign_id)
        return queryset.order_by('-uploaded_at')

    def perform_create(self, serializer):
        serializer.save(
            uploaded_by=self.request.user if self.request.user.is_authenticated else None
        )

    def create(self, request, *args, **kwargs):
        """Handle template upload with sheet extraction."""
        print("=" * 50)
        print("📤 TEMPLATE UPLOAD REQUEST RECEIVED")
        print(f"Data keys: {list(request.data.keys())}")
        print(f"Campaign ID: {request.data.get('campaign_id') or request.data.get('campaign')}")

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        instance = serializer.save()

        print(f"✅ Template ID={instance.id}, Campaign={instance.campaign}")

        # Extract sheet names after file is saved
        try:
            import time
            time.sleep(0.5)
            file_path = instance.template_file.path
            if os.path.exists(file_path):
                excel_file = pd.ExcelFile(file_path)
                instance.sheet_names = excel_file.sheet_names
                instance.save(update_fields=['sheet_names'])
                print(f"📑 Sheets: {instance.sheet_names}")
        except Exception as e:
            print(f"⚠️ Could not extract sheet names: {e}")

        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

    @action(detail=True, methods=['post'], url_path='extract-sheets', url_name='extract-sheets')
    def extract_sheets(self, request, pk=None):
        """Manually trigger sheet name extraction."""
        template = self.get_object()
        try:
            if not template.template_file:
                return Response({'success': False, 'error': 'No template file found'},
                                status=status.HTTP_400_BAD_REQUEST)
            file_path = template.template_file.path
            if not os.path.exists(file_path):
                return Response(
                    {'success': False, 'error': f'File not found at: {file_path}'},
                    status=status.HTTP_404_NOT_FOUND
                )
            excel_file = pd.ExcelFile(file_path)
            sheet_names = excel_file.sheet_names
            template.sheet_names = sheet_names
            template.save(update_fields=['sheet_names'])
            return Response({
                'success': True,
                'message': f'Extracted {len(sheet_names)} sheets',
                'sheets': sheet_names
            })
        except Exception as e:
            traceback.print_exc()
            return Response({'success': False, 'error': str(e)},
                            status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=True, methods=['post'])
    def configure_mapping(self, request, pk=None):
        """Configure sheet-to-data mappings."""
        template = self.get_object()
        sheet_mappings = request.data.get('sheet_mappings', {})

        if not template.sheet_names:
            return Response(
                {'error': 'Template has no sheet names. Extract sheets first.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        for sheet_name in sheet_mappings.values():
            if sheet_name and sheet_name not in template.sheet_names:
                return Response(
                    {'error': f"Sheet '{sheet_name}' not found. "
                              f"Available: {template.sheet_names}"},
                    status=status.HTTP_400_BAD_REQUEST
                )

        template.sheet_mappings = sheet_mappings
        template.save()
        return Response({
            'success': True,
            'message': 'Mapping configured successfully',
            'sheet_mappings': template.sheet_mappings
        })

    @action(detail=True, methods=['get'])
    def sheets(self, request, pk=None):
        """Return sheet names for a template."""
        template = self.get_object()
        return Response({
            'template_name': template.name,
            'sheets': template.sheet_names,
            'has_sheets': bool(template.sheet_names)
        })


@api_view(['POST'])
@permission_classes([AllowAny])
def upload_report_template(request):
    """Standalone endpoint to upload a report template."""
    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)

    file = request.FILES['file']
    name = request.data.get('name', file.name)
    description = request.data.get('description', '')

    # FIX: resolve campaign
    campaign_id = request.data.get('campaign_id') or request.data.get('campaign')
    campaign = None
    if campaign_id:
        try:
            campaign = Campaign.objects.get(id=campaign_id, is_active=True)
        except Campaign.DoesNotExist:
            pass

    try:
        template = ReportTemplate.objects.create(
            name=name,
            description=description,
            template_file=file,
            campaign=campaign,
            uploaded_by=request.user if request.user.is_authenticated else None
        )

        try:
            import time
            time.sleep(0.5)
            file_path = template.template_file.path
            if os.path.exists(file_path):
                excel_file = pd.ExcelFile(file_path)
                sheet_names = excel_file.sheet_names
                template.sheet_names = sheet_names
                template.save(update_fields=['sheet_names'])
        except Exception as e:
            print(f"⚠️ Could not extract sheets: {e}")

        return Response({
            'success': True,
            'message': 'Template uploaded successfully',
            'template': {
                'id': template.id,
                'name': template.name,
                'campaign': campaign.display_name if campaign else None,
                'sheets': template.sheet_names or []
            }
        })
    except Exception as e:
        traceback.print_exc()
        return Response({'error': str(e)}, status=500)


# ===========================================================
# TEMPLATE-BASED REPORT GENERATOR
# ===========================================================

class TemplateBasedReportGenerator:
    """Generate reports by populating an uploaded Excel template with Pivot data."""

    @staticmethod
    def generate_analysis_report(template_id, data_mappings, campaign_id=None, user=None):
        """
        Generate campaign analysis by recreating the template structure,
        preserving ALL formulas, and populating matching rows with Pivot data.

        This restores the ORIGINAL working approach (which produced correct
        values), with ONE addition: campaign_id scoping, so the Pivot data
        used always belongs to the correct campaign — no more mixing data
        across campaigns.

        data_mappings: {
            'campaign': 'Sheet Name'  # The campaign sheet to populate
        }

        How it works:
        1. Takes the uploaded template and recreates it COMPLETELY
        2. PRESERVES ALL FORMULAS exactly as they are
        3. CLEARS ALL VALUES (except descriptions for matching)
        4. Takes ALL rows from the Pivot sheet data — SCOPED TO campaign_id
        5. For each row in the campaign sheet, looks for matching description
           in Pivot (column 1 = description)
        6. If match found, populates the ENTIRE row with Pivot data
           (so if Pivot has multiple columns, they all get copied across)
        7. If no match found, leaves the row with only the description
           (formulas preserved)
        8. ALL formulas remain in place, nothing is ever deleted
        """
        try:
            # Get template
            template = ReportTemplate.objects.get(id=template_id, is_active=True)

            print(f"📊 Generating campaign analysis using template: {template.name}")
            print(f"📑 Template sheets: {template.sheet_names}")
            print(f"📋 Data mappings: {data_mappings}")
            print(f"🎯 Campaign ID: {campaign_id}")

            # Get the campaign sheet name from mappings
            campaign_sheet_name = data_mappings.get('campaign')
            if not campaign_sheet_name:
                raise Exception("No campaign sheet specified in mappings")

            if not campaign_id:
                raise Exception(
                    "campaign_id is required so the correct campaign's Pivot "
                    "data is used (prevents mixing data across campaigns)."
                )

            # ── FIX: scope the campaign report lookup to THIS campaign ──
            latest_campaign_report = GeneratedReport.objects.filter(
                report_type='campaign_analysis',
                campaign_id=campaign_id
            ).order_by('-generated_at').first()

            if not latest_campaign_report:
                raise Exception(
                    f"No campaign report found for campaign ID {campaign_id}. "
                    "Please generate a campaign report for this campaign first."
                )

            print(f"📊 Using campaign report: {latest_campaign_report.id} "
                  f"(campaign_id={latest_campaign_report.campaign_id})")
            print(f"📁 Report file: {latest_campaign_report.file.path}")

            # STEP 1: Load the campaign report workbook and get its Pivot sheet
            campaign_wb = load_workbook(latest_campaign_report.file.path)

            if 'Pivot' not in campaign_wb.sheetnames:
                raise Exception("Pivot sheet not found in campaign report")

            pivot_sheet = campaign_wb['Pivot']
            print(f"📑 Pivot sheet has {pivot_sheet.max_row} rows and "
                  f"{pivot_sheet.max_column} columns")

            # STEP 2: Extract ALL Pivot data with descriptions as the key
            pivot_data_by_description = {}
            headers = []

            for i, row in enumerate(pivot_sheet.iter_rows(values_only=True)):
                if i == 0:
                    headers = [str(cell) if cell else f"Col_{i+1}" for i, cell in enumerate(row)]
                    print(f"📋 Pivot headers: {headers}")
                else:
                    if len(row) > 0 and row[0]:
                        description_key = str(row[0]).strip().lower()
                        pivot_data_by_description[description_key] = list(row)

            print(f"📊 Extracted {len(pivot_data_by_description)} rows of Pivot data "
                  f"with descriptions")
            if len(pivot_data_by_description) > 0:
                sample_key = list(pivot_data_by_description.keys())[0]
                print(f"📋 Sample - Description: '{sample_key}', "
                      f"Data: {pivot_data_by_description[sample_key]}")

            # ── STEP 2b: Inject SUMMARY METRICS as extra lookup entries ─────
            # The Pivot sheet only has disposition descriptions (Callback,
            # Not Interested, etc.) — it does NOT have rows for "Total Leads",
            # "Successful Contacts", "Conversion" etc. Those summary numbers
            # live in the Campaign Analysis sheet of the same campaign report,
            # at FIXED row numbers (this is exactly how generate_campaign()
            # writes them, so reading the same fixed rows is reliable).
            #
            #   row 4 (col B): Total Leads
            #   row 5 (col B): Unworked Leads (New Leads)
            #   row 6 (col B): Successful Contacts
            #   row 7 (col B): True Contacts
            #   row 8 (col B): Conversion (decimal, e.g. 0.0159)
            #   row 9 (col B): True Sales (post QA)
            #
            # We add these into pivot_data_by_description using the SAME
            # 2-column shape as Pivot rows: [description, value]. This lets
            # them flow through the exact same matching/writing logic below
            # as every disposition row — no separate code path needed.

            if 'Campaign Analysis' in campaign_wb.sheetnames:
                # Open a data_only copy so formula results (not formula text)
                # are what we read.
                value_wb = load_workbook(latest_campaign_report.file.path, data_only=True)
                analysis_value_ws = value_wb['Campaign Analysis']

                def read_summary_cell(row_num):
                    v = analysis_value_ws.cell(row=row_num, column=2).value
                    return v if isinstance(v, (int, float)) else 0

                summary_total_leads   = read_summary_cell(4)
                summary_unworked      = read_summary_cell(5)
                summary_successful    = read_summary_cell(6)
                summary_true_contacts = read_summary_cell(7)
                summary_conversion    = read_summary_cell(8)   # decimal
                summary_true_sales    = read_summary_cell(9)

                summary_entries = {
                    'total leads':                      summary_total_leads,
                    'unworked leads (new leads)':       summary_unworked,
                    'succesful contacts':               summary_successful,  # template typo (1 's')
                    'successful contacts':              summary_successful,
                    'true contacts':                    summary_true_contacts,
                    'conversion':                        summary_conversion,
                    'true sales (post qa)':             summary_true_sales,
                }

                for label, val in summary_entries.items():
                    # Use the SAME 2-column row shape as Pivot: [description, value]
                    pivot_data_by_description[label] = [label, val]

                print(f"📊 Injected {len(summary_entries)} summary metric entries:")
                for k, v in summary_entries.items():
                    print(f"   '{k}' = {v}")

                # ── Calculated ratio rows (Contactability, Lead to Sale, etc.) ──
                if summary_total_leads > 0:
                    contactability         = summary_successful / summary_total_leads
                    lead_to_sale_conv      = summary_true_sales / summary_total_leads
                    pivot_data_by_description['contactability'] = ['contactability', contactability]
                    pivot_data_by_description['lead to sale conversion'] = [
                        'lead to sale conversion', lead_to_sale_conv
                    ]
                if summary_successful > 0:
                    conv_to_true_sale = summary_true_sales / summary_successful
                    pivot_data_by_description['conversion to true sale'] = [
                        'conversion to true sale', conv_to_true_sale
                    ]
                if summary_true_contacts > 0:
                    true_contacts_to_sales = summary_true_sales / summary_true_contacts
                    pivot_data_by_description['true contacts to sales'] = [
                        'true contacts to sales', true_contacts_to_sales
                    ]

                print(f"📊 pivot_data_by_description now has "
                      f"{len(pivot_data_by_description)} total entries "
                      f"(disposition rows + summary metrics + calculated ratios)")
            else:
                print("⚠️  'Campaign Analysis' sheet not found in campaign report — "
                      "summary metrics (Total Leads, Successful Contacts, etc.) "
                      "will be left blank.")

            # STEP 3: Load the template workbook (this is our source template)
            template_path = template.template_file.path
            source_wb = load_workbook(template_path)

            # STEP 4: Create a NEW workbook with the COMPLETE template structure
            new_wb = openpyxl.Workbook()
            default_sheet = new_wb.active
            new_wb.remove(default_sheet)

            print(f"📝 Recreating template structure with {len(source_wb.sheetnames)} "
                  f"sheets (preserving formulas)...")

            for sheet_name in source_wb.sheetnames:
                source_sheet = source_wb[sheet_name]
                new_sheet = new_wb.create_sheet(title=sheet_name)

                for row in source_sheet.iter_rows():
                    for cell in row:
                        new_cell = new_sheet.cell(row=cell.row, column=cell.column)

                        if cell.has_style:
                            try:
                                new_cell.font = cell.font.copy()
                                new_cell.border = cell.border.copy()
                                new_cell.fill = cell.fill.copy()
                                new_cell.number_format = cell.number_format
                                new_cell.alignment = cell.alignment.copy()
                            except Exception:
                                pass

                        # Preserve formulas
                        if cell.data_type == 'f' and cell.value and str(cell.value).startswith('='):
                            new_cell.value = cell.value
                        else:
                            # For the campaign sheet, preserve description column (col 1) values
                            if sheet_name == campaign_sheet_name and cell.column == 1:
                                new_cell.value = cell.value
                            else:
                                new_cell.value = None  # clear all other values

                for merged_range in source_sheet.merged_cells.ranges:
                    new_sheet.merge_cells(str(merged_range))

                for col_idx, column in enumerate(source_sheet.columns, 1):
                    col_letter = get_column_letter(col_idx)
                    if col_letter in source_sheet.column_dimensions:
                        new_sheet.column_dimensions[col_letter].width = (
                            source_sheet.column_dimensions[col_letter].width
                        )

                for row_idx in range(1, source_sheet.max_row + 1):
                    if row_idx in source_sheet.row_dimensions:
                        new_sheet.row_dimensions[row_idx].height = (
                            source_sheet.row_dimensions[row_idx].height
                        )

                print(f"  ✅ Recreated sheet: {sheet_name} - {source_sheet.max_row} rows "
                      f"(formulas preserved)")

            print(f"✅ Template structure successfully recreated with "
                  f"{len(source_wb.sheetnames)} sheets (all formulas preserved)")

            # STEP 5: Get the campaign sheet from the NEW workbook
            if campaign_sheet_name not in new_wb.sheetnames:
                raise Exception(
                    f"Campaign sheet '{campaign_sheet_name}' not found in recreated template"
                )

            campaign_sheet = new_wb[campaign_sheet_name]

            # STEP 6: Description column is column 1
            description_column = 1
            total_rows = campaign_sheet.max_row

            print(f"📝 Processing campaign sheet '{campaign_sheet_name}' with "
                  f"{total_rows} rows...")

            # STEP 7: Populate ONLY matching rows with data from Pivot
            rows_populated = 0
            rows_without_match = 0

            for row_idx in range(1, total_rows + 1):
                desc_cell = campaign_sheet.cell(row=row_idx, column=description_column)
                description = str(desc_cell.value).strip().lower() if desc_cell.value else ""

                if description and description in pivot_data_by_description:
                    pivot_row_data = pivot_data_by_description[description]
                    rows_populated += 1

                    print(f"  ✅ Matching row {row_idx}: '{description}' - "
                          f"populating with Pivot data")

                    for col_idx, value in enumerate(pivot_row_data, start=1):
                        if col_idx <= campaign_sheet.max_column:
                            cell = campaign_sheet.cell(row=row_idx, column=col_idx)

                            # Skip formula cells — never overwrite formulas
                            if cell.data_type == 'f':
                                continue

                            try:
                                if value is None:
                                    cell.value = None
                                elif isinstance(value, float) and np.isnan(value):
                                    cell.value = None
                                elif isinstance(value, (np.integer, int)):
                                    cell.value = int(value)
                                elif isinstance(value, (np.floating, float)):
                                    cell.value = float(value)
                                elif isinstance(value, (pd.Timestamp, datetime)):
                                    cell.value = value
                                else:
                                    cell.value = str(value)
                            except Exception as e:
                                print(f"⚠️ Error writing to cell ({row_idx},{col_idx}): {e}")
                else:
                    rows_without_match += 1
                    if description:
                        print(f"  ⚠️ No match for row {row_idx}: '{description}' - "
                              f"keeping formulas only")

            print(f"✅ Campaign sheet '{campaign_sheet_name}' results:")
            print(f"   - Total rows: {total_rows}")
            print(f"   - Rows populated with Pivot data: {rows_populated}")
            print(f"   - Rows with formulas only (no match): {rows_without_match}")

            # STEP 8: Add the original Pivot sheet as a separate sheet for reference
            pivot_data_sheet = new_wb.create_sheet(title="Pivot_Data")

            for row in pivot_sheet.iter_rows():
                for cell in row:
                    new_cell = pivot_data_sheet.cell(row=cell.row, column=cell.column)
                    new_cell.value = cell.value
                    if cell.has_style:
                        try:
                            new_cell.font = cell.font.copy()
                            new_cell.border = cell.border.copy()
                            new_cell.fill = cell.fill.copy()
                            new_cell.number_format = cell.number_format
                            new_cell.alignment = cell.alignment.copy()
                        except Exception:
                            pass

            for merged_range in pivot_sheet.merged_cells.ranges:
                pivot_data_sheet.merge_cells(str(merged_range))

            for col_idx, column in enumerate(pivot_sheet.columns, 1):
                col_letter = get_column_letter(col_idx)
                if col_letter in pivot_sheet.column_dimensions:
                    pivot_data_sheet.column_dimensions[col_letter].width = (
                        pivot_sheet.column_dimensions[col_letter].width
                    )

            print(f"✅ Added 'Pivot_Data' sheet with {pivot_sheet.max_row-1} rows "
                  f"of reference data")

            # STEP 8b: Also copy "Processed Data", "Lead Count" and
            # "Campaign Analysis" sheets from the campaign report, so the
            # final download has the full sheet set: Processed Data,
            # Pivot_Data, Lead Count, Campaign Analysis, and the populated
            # template sheet. Lead Count must be included — Campaign
            # Analysis's %-of-total-leads formulas reference
            # 'Lead Count'!$B$3 directly, so omitting it here would leave
            # those formulas pointing at a sheet that doesn't exist in
            # this derived workbook.
            for extra_sheet_name in ['Processed Data', 'Lead Count', 'Campaign Analysis']:
                if extra_sheet_name in campaign_wb.sheetnames and extra_sheet_name not in new_wb.sheetnames:
                    src_extra = campaign_wb[extra_sheet_name]
                    dst_extra = new_wb.create_sheet(title=extra_sheet_name)

                    for row in src_extra.iter_rows():
                        for cell in row:
                            new_cell = dst_extra.cell(row=cell.row, column=cell.column)
                            new_cell.value = cell.value
                            if cell.has_style:
                                try:
                                    new_cell.font = cell.font.copy()
                                    new_cell.border = cell.border.copy()
                                    new_cell.fill = cell.fill.copy()
                                    new_cell.number_format = cell.number_format
                                    new_cell.alignment = cell.alignment.copy()
                                except Exception:
                                    pass

                    for merged_range in src_extra.merged_cells.ranges:
                        dst_extra.merge_cells(str(merged_range))

                    for col_idx, column in enumerate(src_extra.columns, 1):
                        col_letter = get_column_letter(col_idx)
                        if col_letter in src_extra.column_dimensions:
                            dst_extra.column_dimensions[col_letter].width = (
                                src_extra.column_dimensions[col_letter].width
                            )

                    print(f"✅ Added '{extra_sheet_name}' sheet "
                          f"({src_extra.max_row} rows) for reference")

            # STEP 9: Save the new workbook
            output = BytesIO()
            new_wb.save(output)
            output.seek(0)

            reports_dir = os.path.join(settings.MEDIA_ROOT, 'campaign_analysis')
            os.makedirs(reports_dir, exist_ok=True)

            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f"campaign_analysis_{campaign_sheet_name}_{timestamp}.xlsx"
            filepath = os.path.join(reports_dir, filename)

            with open(filepath, 'wb') as f:
                f.write(output.getvalue())

            campaign_obj = None
            try:
                campaign_obj = Campaign.objects.get(id=campaign_id)
            except Exception:
                pass

            # Create report record — FIX: campaign attached for scoping
            report = GeneratedReport.objects.create(
                user=user,
                campaign=campaign_obj,
                report_type='analysis',
                file=f"campaign_analysis/{filename}",
                parameters={
                    'template_id': template.id,
                    'template_name': template.name,
                    'campaign_id': campaign_id,
                    'report_name': f"Analysis - {campaign_sheet_name} - "
                                    f"{datetime.now().strftime('%Y-%m-%d')}",
                    'campaign_name': campaign_sheet_name,
                    'source_report_id': latest_campaign_report.id,
                    'pivot_data_sheet': 'Pivot_Data',
                    'total_template_rows': total_rows,
                    'rows_populated': rows_populated,
                    'rows_with_formulas_only': rows_without_match,
                    'template_sheets': source_wb.sheetnames,
                    'sheets_included': new_wb.sheetnames,
                    'all_formulas_preserved': True,
                    'values_cleared': True
                }
            )

            return {
                'success': True,
                'data': {
                    'report_id': report.id,
                    'download_url': f'/api/reports/{report.id}/download/',
                    'message': (
                        f'Campaign analysis generated for "{campaign_sheet_name}" - '
                        f'Populated {rows_populated} rows with Pivot data, '
                        f'{rows_without_match} rows with formulas only'
                    ),
                    'campaign_name': campaign_sheet_name,
                    'rows_populated': rows_populated,
                    'rows_formulas_only': rows_without_match,
                    'total_rows': total_rows,
                    'pivot_sheet': 'Pivot_Data',
                    'sheets': new_wb.sheetnames,
                }
            }

        except ReportTemplate.DoesNotExist:
            raise Exception(f"Template with ID {template_id} not found")
        except Exception as e:
            print(f"❌ Error generating campaign analysis: {str(e)}")
            traceback.print_exc()
            raise


    @staticmethod
    def _clear_data_preserve_structure(sheet, start_row=2):
        """
        Placeholder — we no longer pre-clear cells before writing.
        The write step handles preservation by checking each cell individually.
        Kept so any external callers don't break.
        """
        print(f"📝 Preserving all template content — only data cells will be updated")

    @staticmethod
    def _write_data_preserve_structure(sheet, df, start_row=2, start_col=1):
        """
        Write a DataFrame to a sheet while preserving the EXACT template structure.

        Rules:
        - NEVER removes or adds rows — template structure is sacred.
        - Never writes beyond the template's existing row count.
        - Skips formula cells (preserves them unchanged).
        - Skips non-master cells of merged ranges.
        - For empty (NaN/None) values, only clears the cell if it was already empty;
          existing template text is left alone.
        """
        if df.empty:
            print("⚠️ No data to write — template remains unchanged")
            return

        merged_ranges = list(sheet.merged_cells.ranges)
        merged_top_left_cells = {
            mr.start_cell.coordinate: mr for mr in merged_ranges
        }

        max_template_rows = sheet.max_row
        data_rows = len(df)

        print(f"📝 Template rows: {max_template_rows}  |  Data rows: {data_rows}  |  Start: {start_row}")

        for i in range(data_rows):
            row_idx = start_row + i

            if row_idx > max_template_rows:
                print(f"⚠️ Stopped at row {row_idx} — template only has {max_template_rows} rows. "
                      f"{data_rows - i} extra data rows NOT written.")
                break

            row_data = df.iloc[i]

            for col_offset, value in enumerate(row_data):
                col_idx = start_col + col_offset
                cell = sheet.cell(row=row_idx, column=col_idx)
                cell_coord = cell.coordinate

                # Never overwrite formula cells
                if cell.data_type == 'f':
                    continue

                # Determine if this cell is inside a merged range (but not the master)
                is_non_master_merged = False
                if cell_coord not in merged_top_left_cells:
                    for mr in merged_ranges:
                        if cell_coord in mr and cell_coord != mr.start_cell.coordinate:
                            is_non_master_merged = True
                            break

                if is_non_master_merged:
                    continue  # can't write to non-master merged cells

                try:
                    is_empty_value = (
                        value is None
                        or (isinstance(value, float) and np.isnan(value))
                        or (isinstance(value, str) and value.strip() == '')
                    )

                    if is_empty_value:
                        # Only clear if the cell has no existing template content
                        if cell.value is None:
                            cell.value = None
                        # else: preserve existing template content
                    else:
                        if isinstance(value, (np.integer, int)):
                            cell.value = int(value)
                        elif isinstance(value, (np.floating, float)):
                            cell.value = float(value)
                        elif isinstance(value, (pd.Timestamp, datetime)):
                            cell.value = value
                        else:
                            cell.value = str(value)

                except Exception as e:
                    print(f"⚠️ Error writing to cell {cell_coord}: {e}")

    @staticmethod
    def get_available_sheets(template_id):
        try:
            template = ReportTemplate.objects.get(id=template_id, is_active=True)
            return template.sheet_names
        except ReportTemplate.DoesNotExist:
            return []


# ===========================================================
# DASHBOARD STATS VIEW
# ===========================================================

class DashboardStatsView(generics.GenericAPIView):
    """Get dashboard statistics, optionally scoped to a campaign."""
    permission_classes = [AllowAny]

    def get(self, request):
        user = request.user
        campaign_id = request.query_params.get('campaign_id')

        total_outcomes = OutcomeDescription.objects.count()

        base_files_qs   = CallDataFile.objects.all()
        base_reports_qs = GeneratedReport.objects.all()

        if campaign_id:
            base_files_qs   = base_files_qs.filter(campaign_id=campaign_id)
            base_reports_qs = base_reports_qs.filter(campaign_id=campaign_id)
        elif user.is_authenticated:
            base_files_qs   = base_files_qs.filter(user=user)
            base_reports_qs = base_reports_qs.filter(user=user)

        total_files     = base_files_qs.count()
        processed_files = base_files_qs.filter(status='processed').count()
        total_reports   = base_reports_qs.count()

        total_records = sum(
            f.total_records for f in base_files_qs.filter(status='processed')
        )

        stats = {
            'overview': {
                'total_outcomes':  total_outcomes,
                'total_files':     total_files,
                'processed_files': processed_files,
                'total_reports':   total_reports,
                'total_records':   total_records,
            },
            'recent_reports': GeneratedReportSerializer(
                base_reports_qs[:5], many=True
            ).data,
            'recent_files': CallDataFileSerializer(
                base_files_qs[:5], many=True
            ).data,
            'file_status': {
                'uploaded':   base_files_qs.filter(status='uploaded').count(),
                'processing': base_files_qs.filter(status='processing').count(),
                'processed':  processed_files,
                'failed':     base_files_qs.filter(status='failed').count(),
            }
        }
        return Response(stats)


# ===========================================================
# QA REVIEW
# ===========================================================
#
# Deliberately separate from the Campaign upload/sync pipeline (ProcessedData
# never carries full outcome names or recording refs). Records/Outcomes views
# below query the LOCAL QACallRecord cache — fast, our own indexes — which is
# populated by QASyncView hitting the source DB live (see qa_source.py for
# why: no supporting index for date-filtered live queries on that schema).

class QASyncView(generics.GenericAPIView):
    """
    Trigger an on-demand refresh of the local QA cache for one or more
    campaigns. Optional POST body fields: start_date/end_date ('YYYY-MM-DD')
    and start_time/end_time ('HH:MM' or 'HH:MM:SS') scope the sync to
    interactions in that range — omitted entirely, sync_campaign_qa_cache
    falls back to a bounded default (see external_source.default_campaign_date_range).
    """
    permission_classes = [AllowAny]

    def post(self, request):
        from .qa_source import sync_campaign_qa_cache, ExternalSourceError

        local_campaign_ids = request.data.get('campaign_ids') or []
        campaigns = Campaign.objects.filter(id__in=local_campaign_ids)

        start_date = request.data.get('start_date') or None
        end_date = request.data.get('end_date') or None
        start_time = request.data.get('start_time') or None
        end_time = request.data.get('end_time') or None

        results = []
        for campaign in campaigns:
            try:
                count, synced_at = sync_campaign_qa_cache(
                    campaign, start_date=start_date, end_date=end_date,
                    start_time=start_time, end_time=end_time,
                )
                results.append({
                    'campaign_id': campaign.id,
                    'campaign': campaign.display_name,
                    'records_synced': count,
                    'synced_at': synced_at,
                })
            except ExternalSourceError as e:
                results.append({'campaign_id': campaign.id, 'campaign': campaign.display_name, 'error': str(e)})
            except Exception as e:
                results.append({'campaign_id': campaign.id, 'campaign': campaign.display_name, 'error': f'Sync failed: {e}'})

        return Response({'results': results})


def _build_qa_queryset(request):
    """
    Shared QACallRecord filtering for QARecordsView and QADownloadView —
    campaign_ids (required, comma-separated local Campaign ids), optional
    start_date/end_date/start_time/end_time, outcomes (comma-separated),
    and search. Returns QACallRecord.objects.none() if no campaign_ids are
    given, same as QARecordsView's own empty-state handling used to.
    """
    local_campaign_ids = [c for c in request.query_params.get('campaign_ids', '').split(',') if c]
    if not local_campaign_ids:
        return QACallRecord.objects.none()

    qs = QACallRecord.objects.filter(campaign_id__in=local_campaign_ids)

    start_date = request.query_params.get('start_date')
    end_date = request.query_params.get('end_date')
    start_time = request.query_params.get('start_time')
    end_time = request.query_params.get('end_time')
    if start_date:
        qs = qs.filter(call_date__gte=f"{start_date} {start_time or '00:00:00'}")
    if end_date:
        qs = qs.filter(call_date__lte=f"{end_date} {end_time or '23:59:59'}")

    outcomes = [o for o in request.query_params.get('outcomes', '').split(',') if o]
    if outcomes:
        qs = qs.filter(outcome__in=outcomes)

    search = request.query_params.get('search')
    if search:
        qs = qs.filter(
            Q(customer__icontains=search) | Q(phone_number__icontains=search) | Q(agent_name__icontains=search)
        )
    return qs


class QARecordsView(generics.GenericAPIView):
    """
    Paginated, filterable call-record listing for QA review, across one or
    more campaigns at once, unlike everything else in this app which is
    scoped to a single campaign — reads the local QACallRecord cache.
    """
    permission_classes = [AllowAny]

    def get(self, request):
        empty = {'count': 0, 'results': [], 'page': 1, 'num_pages': 1, 'last_synced': None}
        if not request.query_params.get('campaign_ids'):
            return Response(empty)

        qs = _build_qa_queryset(request)
        last_synced = qs.aggregate(Max('synced_at'))['synced_at__max']

        try:
            page = int(request.query_params.get('page', 1))
            page_size = min(int(request.query_params.get('page_size', 50)), 200)
        except ValueError:
            return Response({'error': 'page and page_size must be integers'}, status=status.HTTP_400_BAD_REQUEST)

        total = qs.count()
        qs = qs.select_related('campaign').order_by('-call_date')
        offset = (page - 1) * page_size
        page_rows = qs[offset:offset + page_size]

        results = [
            {
                'id': r.id,
                'date': r.call_date,
                'customer': r.customer,
                'phone_number': r.phone_number,
                'agent_name': r.agent_name,
                'campaign': r.campaign.display_name,
                'outcome': r.outcome,
                'recording_key': r.recording_key,
                'recording_duration_seconds': r.recording_duration_seconds,
            }
            for r in page_rows
        ]
        return Response({
            'count': total,
            'results': results,
            'page': page,
            'num_pages': max(1, -(-total // page_size)),
            'last_synced': last_synced,
        })


class QAOutcomesView(generics.GenericAPIView):
    """Distinct full outcome names actually present in the local QA cache for the given campaign(s)."""
    permission_classes = [AllowAny]

    def get(self, request):
        local_campaign_ids = [c for c in request.query_params.get('campaign_ids', '').split(',') if c]
        if not local_campaign_ids:
            return Response([])

        outcomes = (
            QACallRecord.objects.filter(campaign_id__in=local_campaign_ids)
            .exclude(outcome__isnull=True).exclude(outcome='')
            .order_by('outcome')
            .values_list('outcome', flat=True)
            .distinct()
        )
        return Response(list(outcomes))


class QADownloadView(generics.GenericAPIView):
    """
    Download every QA record matching the current filters as one .xlsx file
    — the same filters QARecordsView takes (campaign_ids, start_date/
    end_date/start_time/end_time, outcomes, search), but every matching
    record instead of one page of them, since the on-screen table only ever
    shows 50 rows at a time.
    """
    permission_classes = [AllowAny]

    def get(self, request):
        import xlsxwriter
        from io import BytesIO
        from datetime import datetime

        qs = _build_qa_queryset(request)
        if not qs.exists():
            return Response({'error': 'No records match these filters.'}, status=status.HTTP_400_BAD_REQUEST)

        qs = qs.order_by('-call_date').values(
            'call_date', 'customer', 'phone_number', 'agent_name',
            'campaign__display_name', 'outcome', 'recording_key', 'recording_duration_seconds',
        )

        output = BytesIO()
        workbook = xlsxwriter.Workbook(output, {'nan_inf_to_errors': True})
        header_fmt = workbook.add_format({
            'bold': True, 'bg_color': '#366092', 'font_color': 'white',
            'border': 1, 'align': 'center', 'valign': 'vcenter'
        })
        headers = ['Date', 'Customer', 'Phone Number', 'Agent Name', 'Campaign', 'Outcome',
                   'Recording Key', 'Recording Duration (seconds)']

        # Same XLSX row ceiling as everywhere else in this codebase
        # (1,048,576 rows/sheet) — QA exports are normally far smaller than
        # a campaign's full processed data, but split the same way rather
        # than risk it for a very wide date range across many campaigns.
        MAX_SHEET_DATA_ROWS = 1_000_000

        def _new_sheet(idx):
            sheet_name = 'QA Records' if idx == 1 else f'QA Records ({idx})'
            ws = workbook.add_worksheet(sheet_name)
            for col, h in enumerate(headers):
                ws.write(0, col, h, header_fmt)
            ws.set_column(0, 0, 20)
            ws.set_column(1, 3, 22)
            ws.set_column(4, 5, 22)
            ws.set_column(6, 6, 32)
            return ws

        ws = _new_sheet(1)
        sheet_index = 1
        row_num = 1
        for r in qs.iterator(chunk_size=5000):
            if row_num > MAX_SHEET_DATA_ROWS:
                sheet_index += 1
                ws = _new_sheet(sheet_index)
                row_num = 1
            ws.write_row(row_num, 0, [
                r['call_date'].strftime('%Y-%m-%d %H:%M:%S') if r['call_date'] else '',
                r['customer'] or '',
                r['phone_number'] or '',
                r['agent_name'] or '',
                r['campaign__display_name'] or '',
                r['outcome'] or '',
                r['recording_key'] or '',
                r['recording_duration_seconds'],
            ])
            row_num += 1

        workbook.close()
        output.seek(0)

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"qa_records_{timestamp}.xlsx"
        response = HttpResponse(
            output.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response


# ===========================================================
# CAMPAIGN VIEWSET
# ===========================================================

class CampaignViewSet(viewsets.ModelViewSet):
    """Manage campaigns. Lists every campaign (active and inactive) — the
    frontend filters/searches client-side; other endpoints that should only
    ever touch active campaigns look them up with their own is_active=True
    guard, so this doesn't loosen anything for them."""
    queryset = Campaign.objects.all().order_by('name')
    serializer_class = CampaignSerializer
    permission_classes = [AllowAny]

    def perform_create(self, serializer):
        serializer.save(
            created_by=self.request.user if self.request.user.is_authenticated else None
        )

    @action(detail=True, methods=['get'])
    def stats(self, request, pk=None):
        """Campaign-specific statistics."""
        campaign = self.get_object()
        return Response({
            'campaign': {
                'id':         campaign.id,
                'name':       campaign.display_name,
                'sheet_name': campaign.sheet_name,
            },
            'data_files': {
                'total':      campaign.data_files.count(),
                'processed':  campaign.data_files.filter(status='processed').count(),
                'uploaded':   campaign.data_files.filter(status='uploaded').count(),
                'processing': campaign.data_files.filter(status='processing').count(),
                'failed':     campaign.data_files.filter(status='failed').count(),
            },
            'reports': {
                'total':             campaign.reports.count(),
                'campaign_analysis': campaign.reports.filter(
                    report_type='campaign_analysis'
                ).count(),
                'template_analysis': campaign.reports.filter(
                    report_type='analysis'
                ).count(),
            },
            'templates':     campaign.templates.count(),
            'total_records': sum(
                f.total_records
                for f in campaign.data_files.filter(status='processed')
            ),
        })

    @action(detail=True, methods=['get'])
    def recent_activity(self, request, pk=None):
        """Recent files and reports for this campaign."""
        campaign = self.get_object()
        recent_files   = CallDataFile.objects.filter(
            campaign=campaign
        ).order_by('-uploaded_at')[:5]
        recent_reports = GeneratedReport.objects.filter(
            campaign=campaign
        ).order_by('-generated_at')[:5]
        return Response({
            'recent_files':   CallDataFileSerializer(recent_files, many=True).data,
            'recent_reports': GeneratedReportSerializer(recent_reports, many=True).data,
        })

    @action(detail=True, methods=['get'])
    def source_lists(self, request, pk=None):
        """List this campaign's upload batches (cd_lists) in the external source database."""
        from .external_source import fetch_source_lists, ExternalSourceError

        campaign = self.get_object()
        if not campaign.cd_campaign_id:
            return Response({'error': 'This campaign has no cd_campaign_id configured.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            lists = fetch_source_lists(campaign.cd_campaign_id)
        except ExternalSourceError as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return Response({'error': f'Fetching source lists failed: {e}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(lists)

    @action(detail=True, methods=['post'])
    def sync_from_database(self, request, pk=None):
        """
        Pull this campaign's call data from the external source database.
        Optional POST body field: auto_generate_report (bool, default
        True) — when True (the historical default, kept for callers like
        AgentReports.js's bulk sync-then-download-report flow that rely on
        it), the full report is built as part of this same request, same
        as a CSV/Excel upload. Pass False to have this return as soon as
        the data itself is pulled and saved, without also waiting on the
        report's own Agent Performance/Call Count Breakdown sheets (each
        re-queries the external DB across the campaign's full history —
        verified live at 25+ minutes on a large campaign); build the
        report afterward via generate_campaign instead. The
        CampaignUpload.js "Sync from Database" panel does this.
        Optional POST body field: sheets — a list of keys from
        ReportViewSet.ALL_REPORT_SHEETS limiting which sheets the report
        builds (only relevant when auto_generate_report is True).
        Omitted/empty means all sheets.
        Optional POST body field: full_outcome_history (bool, default
        False) — see ReportViewSet._auto_generate_full_report's docstring
        (only relevant when auto_generate_report is True).
        """
        from .external_source import sync_campaign_from_database, ExternalSourceError

        campaign = self.get_object()
        user = request.user if request.user.is_authenticated else None
        start_date = request.data.get('start_date') or None
        end_date = request.data.get('end_date') or None
        start_time = request.data.get('start_time') or None
        end_time = request.data.get('end_time') or None
        list_ids = request.data.get('list_ids') or None
        auto_generate_report = bool(request.data.get('auto_generate_report', True))
        full_outcome_history = bool(request.data.get('full_outcome_history', False))

        sheets = request.data.get('sheets')
        if sheets is not None:
            invalid = set(sheets) - ReportViewSet.ALL_REPORT_SHEETS
            if invalid:
                return Response(
                    {'error': f'Unknown sheet(s): {", ".join(sorted(invalid))}. '
                              f'Valid values: {", ".join(sorted(ReportViewSet.ALL_REPORT_SHEETS))}.'},
                    status=status.HTTP_400_BAD_REQUEST
                )

        try:
            instance = sync_campaign_from_database(
                campaign, user=user, start_date=start_date, end_date=end_date,
                start_time=start_time, end_time=end_time, list_ids=list_ids, sheets=sheets,
                full_outcome_history=full_outcome_history, auto_generate_report=auto_generate_report,
            )
        except ExternalSourceError as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            # Anything landing here is, by definition, a failure mode
            # ExternalSourceError didn't anticipate — print the full
            # traceback (previously silent: nothing was logged server-side
            # for this branch, so a report like "Database sync failed: "
            # with nothing after the colon was undiagnosable after the
            # fact). str(e) can legitimately be empty (e.g. a bare
            # Exception()/AssertionError() with no message) — fall back to
            # the exception's type name so the user-facing message is
            # never just a trailing colon.
            traceback.print_exc()
            detail = str(e) or type(e).__name__
            return Response({'error': f'Database sync failed: {detail}'}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(CallDataFileSerializer(instance).data)

    # ============================================================
    # NEW: CAMPAIGN METADATA SYNC ACTIONS
    # ============================================================

    @action(detail=False, methods=['get'])
    def test_connection(self, request):
        """
        Test the connection to the external database.
        GET /api/campaigns/test_connection/
        """
        from .external_source import test_connection, ExternalSourceError
        
        try:
            success, message, details = test_connection()
            return Response({
                'success': success,
                'message': message,
                'details': details
            })
        except Exception as e:
            traceback.print_exc()
            return Response({
                'success': False,
                'error': f'Connection test failed: {str(e)}'
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'])
    def sync_campaigns(self, request):
        """
        Sync campaign metadata from the external source database.
        This updates campaign names, sheet names, and creates new campaigns.
        
        POST body (optional):
            - only_active: bool (default: True) - if False, syncs all campaigns
            - dry_run: bool (default: False) - if True, only previews changes without saving
        """
        from .external_source import sync_campaigns_from_source, ExternalSourceError, test_connection
        import traceback
        
        try:
            only_active = request.data.get('only_active', True)
            dry_run = request.data.get('dry_run', False)
            
            print(f"🔄 Starting campaign sync (only_active={only_active})...")
            
            # Test connection first
            conn_ok, conn_msg, conn_details = test_connection()
            if not conn_ok:
                print(f"❌ Connection test failed: {conn_msg}")
                return Response({
                    'success': False,
                    'error': f'Cannot connect to external database: {conn_msg}',
                    'details': conn_details
                }, status=status.HTTP_400_BAD_REQUEST)
            
            print(f"✅ Connection test passed")
            
            if dry_run:
                # Preview what would be synced without saving
                from .external_source import fetch_campaigns_from_source
                campaigns = fetch_campaigns_from_source(only_active=only_active)
                return Response({
                    'success': True,
                    'dry_run': True,
                    'message': f'Preview: {len(campaigns)} campaigns would be synced from source.',
                    'campaigns': campaigns
                })
            
            results = sync_campaigns_from_source(only_active=only_active)
            
            # Build a human-readable message
            parts = []
            if results['created']:
                parts.append(f"{results['created']} created")
            if results['updated']:
                parts.append(f"{results['updated']} updated")
            if results['deactivated']:
                parts.append(f"{results['deactivated']} deactivated")
            if results['unchanged']:
                parts.append(f"{results['unchanged']} unchanged")
            
            message = f"Synced {results['total_synced']} campaigns from source. " + ", ".join(parts) + "."
            print(f"✅ {message}")
            
            return Response({
                'success': True,
                'message': message,
                'results': results
            })
            
        except ExternalSourceError as e:
            print(f"❌ External source error: {e}")
            traceback.print_exc()
            return Response(
                {'success': False, 'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as e:
            print(f"❌ Sync failed: {e}")
            traceback.print_exc()
            return Response(
                {'success': False, 'error': f'Sync failed: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @action(detail=False, methods=['get'])
    def source_campaigns(self, request):
        """
        Preview campaigns from the external source without syncing.
        Useful for seeing what would be synced.
        
        Query params:
            - only_active: true/false (default: true)
        """
        from .external_source import fetch_campaigns_from_source, ExternalSourceError
        
        try:
            only_active = request.query_params.get('only_active', 'true').lower() == 'true'
            campaigns = fetch_campaigns_from_source(only_active=only_active)
            return Response({
                'success': True,
                'count': len(campaigns),
                'campaigns': campaigns
            })
        except ExternalSourceError as e:
            return Response(
                {'success': False, 'error': str(e)},
                status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as e:
            return Response(
                {'success': False, 'error': f'Failed to fetch campaigns: {e}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )



# ===========================================================
# UTILITY VIEWS
# ===========================================================

@api_view(['POST'])
@permission_classes([AllowAny])
def test_upload(request):
    """Test endpoint for file upload."""
    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)
    file_obj = request.FILES['file']
    try:
        df = pd.read_excel(file_obj)
        return Response({
            'success':   True,
            'filename':  file_obj.name,
            'columns':   list(df.columns),
            'row_count': len(df)
        })
    except Exception as e:
        return Response({'error': str(e)}, status=400)


@api_view(['GET'])
@permission_classes([AllowAny])
def setup_test_user(request):
    """Create a test user for quick setup."""
    if not User.objects.filter(username='test').exists():
        user = User.objects.create_user(
            username='test', email='test@example.com', password='test123'
        )
        user.is_active = True
        user.save()
        return Response({
            'message': 'Test user created successfully!',
            'credentials': {'username': 'test', 'password': 'test123'}
        })
    return Response({
        'message': 'Test user already exists',
        'credentials': {'username': 'test', 'password': 'test123'}
    })