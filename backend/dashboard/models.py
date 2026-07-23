# backend/dashboard/models.py - COMPLETE FIXED VERSION
from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone
import uuid
import os


def get_upload_path(instance, filename):
    """Generate upload path for files"""
    ext = filename.split('.')[-1]
    filename = f"{uuid.uuid4()}.{ext}"
    return os.path.join('uploads', filename)


# ========== CAMPAIGN MODEL ==========
class Campaign(models.Model):
    """Campaign model to organize all campaign-specific data"""
    name = models.CharField(max_length=100, unique=True)
    display_name = models.CharField(max_length=100)
    description = models.TextField(blank=True, null=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='created_campaigns'
    )

    # Campaign-specific settings
    sheet_name = models.CharField(
        max_length=100,
        help_text="Sheet name in templates for this campaign"
    )

    # External source-database list this campaign pulls call data from
    cd_list_id = models.CharField(
        max_length=64, null=True, blank=True,
        help_text="cd_list_id (UUID) in the external call-centre database "
                   "used to scope 'Sync from database' pulls for this campaign"
    )

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.display_name


# ========== OUTCOME DESCRIPTION ==========
class OutcomeDescription(models.Model):
    last_outcome = models.CharField(max_length=100)
    description = models.TextField()
    created_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['last_outcome']
        verbose_name = "Outcome Description"
        verbose_name_plural = "Outcome Descriptions"

    def __str__(self):
        return f"{self.last_outcome} - {self.description[:50]}"


# ========== CALL DATA FILE ==========
class CallDataFile(models.Model):
    FILE_STATUS = [
        ('uploaded', 'Uploaded'),
        ('processing', 'Processing'),
        ('processed', 'Processed'),
        ('failed', 'Failed'),
    ]

    user = models.ForeignKey(User, on_delete=models.CASCADE)
    campaign = models.ForeignKey(
        Campaign, on_delete=models.SET_NULL,
        related_name='data_files', null=True, blank=True
    )
    original_name = models.CharField(max_length=255, blank=True, null=True)
    file = models.FileField(upload_to=get_upload_path)
    file_size = models.IntegerField()
    total_records = models.IntegerField(default=0)
    processed_records = models.IntegerField(default=0)
    status = models.CharField(max_length=20, choices=FILE_STATUS, default='uploaded')
    uploaded_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)
    processing_errors = models.TextField(blank=True)
    delimiter = models.CharField(max_length=10, default=',', blank=True)
    has_headers = models.BooleanField(default=True)

    class Meta:
        ordering = ['-uploaded_at']

    def __str__(self):
        campaign_name = f" [{self.campaign.display_name}]" if self.campaign else ""
        return f"{self.original_name}{campaign_name}"


# ========== PROCESSED DATA ==========
class ProcessedData(models.Model):
    """Stores processed data with descriptions"""
    call_data_file = models.ForeignKey(
        CallDataFile, on_delete=models.CASCADE, related_name='processed_data'
    )

    contact_id = models.CharField(max_length=255, db_index=True, null=True, blank=True)
    customer_id = models.CharField(max_length=255, null=True, blank=True)
    lead_reference = models.CharField(max_length=255, null=True, blank=True)
    list_id = models.CharField(max_length=255, null=True, blank=True)
    list_name = models.CharField(max_length=500, null=True, blank=True)
    title = models.CharField(max_length=100, null=True, blank=True)
    firstname = models.CharField(max_length=200, null=True, blank=True)
    lastname = models.CharField(max_length=200, null=True, blank=True)
    gender = models.CharField(max_length=50, null=True, blank=True)
    last_outcome = models.CharField(max_length=255, db_index=True, null=True, blank=True)
    outcome_description = models.TextField(null=True, blank=True)
    called_count = models.IntegerField(null=True, blank=True)
    last_called_date = models.DateTimeField(null=True, blank=True)
    last_user = models.CharField(max_length=255, null=True, blank=True)
    created_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(null=True, blank=True)
    address1 = models.TextField(null=True, blank=True)
    address2 = models.TextField(null=True, blank=True)
    address3 = models.TextField(null=True, blank=True)
    town = models.CharField(max_length=200, null=True, blank=True)
    county = models.CharField(max_length=200, null=True, blank=True)
    country = models.CharField(max_length=200, null=True, blank=True)
    postcode = models.CharField(max_length=100, null=True, blank=True)
    email_address = models.EmailField(null=True, blank=True, max_length=254)
    tel1 = models.CharField(max_length=100, null=True, blank=True)
    tel2 = models.CharField(max_length=100, null=True, blank=True)
    tel3 = models.CharField(max_length=100, null=True, blank=True)
    tel4 = models.CharField(max_length=100, null=True, blank=True)
    tel5 = models.CharField(max_length=100, null=True, blank=True)
    tel6 = models.CharField(max_length=100, null=True, blank=True)
    owner_username = models.CharField(max_length=255, null=True, blank=True)
    security_phrase = models.TextField(null=True, blank=True)
    source_reference = models.CharField(max_length=255, null=True, blank=True)
    industry = models.CharField(max_length=255, null=True, blank=True)
    company_name = models.CharField(max_length=500, null=True, blank=True)
    website = models.URLField(null=True, blank=True, max_length=500)
    customer_reference = models.CharField(max_length=255, null=True, blank=True)
    dob = models.DateField(null=True, blank=True)
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['last_outcome']),
            models.Index(fields=['last_called_date']),
        ]
        ordering = ['-last_called_date']

    def __str__(self):
        return f"{self.contact_id} - {self.last_outcome}"


# ========== PROCESSED FILE ==========
class ProcessedFile(models.Model):
    """Stores processed Excel files"""
    original_file = models.ForeignKey(
        CallDataFile, on_delete=models.CASCADE, related_name='processed_files'
    )
    file = models.FileField(upload_to='processed_files/%Y/%m/%d/')
    total_records = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Processed: {self.original_file.original_name}"


# ========== GENERATED REPORT ==========
class GeneratedReport(models.Model):
    REPORT_TYPES = [
        ('campaign_analysis', 'Campaign Analysis Report'),
        ('campaign_data', 'Campaign Data Report'),
        ('template_analysis', 'Template Analysis Report'),
        ('analysis', 'Analysis Report'),
    ]

    user = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True
    )
    campaign = models.ForeignKey(
        Campaign, on_delete=models.SET_NULL,
        related_name='reports', null=True, blank=True
    )
    report_type = models.CharField(max_length=50, choices=REPORT_TYPES)
    generated_at = models.DateTimeField(auto_now_add=True)
    file = models.FileField(upload_to='reports/')
    parameters = models.JSONField(default=dict)
    is_downloaded = models.BooleanField(default=False)
    download_count = models.IntegerField(default=0)

    class Meta:
        ordering = ['-generated_at']

    def __str__(self):
        campaign_name = f" [{self.campaign.display_name}]" if self.campaign else ""
        return f"{self.report_type}{campaign_name} – {self.generated_at:%Y-%m-%d}"


# ========== REPORT TEMPLATE ==========
class ReportTemplate(models.Model):
    """Store uploaded report templates — scoped to a campaign"""
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True, null=True)

    # FIX: campaign FK ensures templates belong to a single campaign
    campaign = models.ForeignKey(
        Campaign, on_delete=models.SET_NULL,
        related_name='templates', null=True, blank=True
    )

    template_file = models.FileField(upload_to='templates/', null=True, blank=True)
    sheet_names = models.JSONField(
        default=list, help_text="List of sheet names in the template"
    )

    uploaded_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    sheet_mappings = models.JSONField(
        default=dict, blank=True,
        help_text="Mapping of data types to sheet names"
    )

    def __str__(self):
        campaign_name = f" [{self.campaign.display_name}]" if self.campaign else ""
        return f"{self.name}{campaign_name} – {len(self.sheet_names)} sheets"

    class Meta:
        ordering = ['-uploaded_at']