from django.contrib import admin
from .models import Campaign, OutcomeSet


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ['display_name', 'name', 'sheet_name', 'cd_campaign_id', 'outcome_set', 'is_active', 'updated_at']
    search_fields = ['name', 'display_name', 'cd_campaign_id']
    list_filter = ['is_active', 'outcome_set']


@admin.register(OutcomeSet)
class OutcomeSetAdmin(admin.ModelAdmin):
    list_display = ['name', 'created_at', 'updated_at']
    search_fields = ['name']
