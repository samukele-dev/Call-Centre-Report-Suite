from django.contrib import admin
from .models import Campaign, OutcomeSet, DashboardTeam


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ['display_name', 'name', 'sheet_name', 'cd_campaign_id', 'outcome_set', 'is_active', 'updated_at']
    search_fields = ['name', 'display_name', 'cd_campaign_id']
    list_filter = ['is_active', 'outcome_set']


@admin.register(OutcomeSet)
class OutcomeSetAdmin(admin.ModelAdmin):
    list_display = ['name', 'created_at', 'updated_at']
    search_fields = ['name']


@admin.register(DashboardTeam)
class DashboardTeamAdmin(admin.ModelAdmin):
    """Rows of the Altitude BPO online dashboard: which source-DB teams each one counts."""
    list_display = ['display_name', 'floor', 'source_team_names', 'target', 'sort_order', 'is_active', 'updated_at']
    list_editable = ['target', 'sort_order', 'is_active']
    list_filter = ['floor', 'is_active']
    search_fields = ['display_name']
