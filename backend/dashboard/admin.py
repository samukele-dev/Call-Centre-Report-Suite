from django.contrib import admin
from .models import Campaign


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ['display_name', 'name', 'sheet_name', 'cd_list_id', 'is_active', 'updated_at']
    search_fields = ['name', 'display_name', 'cd_list_id']
    list_filter = ['is_active']
