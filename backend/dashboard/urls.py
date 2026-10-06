# dashboard/urls.py - FIXED VERSION
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
from .views import ReportTemplateViewSet, CampaignViewSet


router = DefaultRouter()
router.register(r'outcome-sets', views.OutcomeSetViewSet, basename='outcome-set')
router.register(r'outcomes', views.OutcomeDescriptionViewSet, basename='outcome')
router.register(r'files', views.CallDataFileViewSet, basename='file')
# Register reports with the fixed ReportViewSet
router.register(r'reports', views.ReportViewSet, basename='report')
router.register(r'templates', ReportTemplateViewSet, basename='template')

router.register(r'campaigns', CampaignViewSet, basename='campaign')

urlpatterns = [
    # Router URLs (this should come first)
    path('', include(router.urls)),
    
    # Stats endpoint
    path('stats/', views.DashboardStatsView.as_view(), name='dashboard_stats'),

    # QA review
    path('qa/records/', views.QARecordsView.as_view(), name='qa_records'),
    path('qa/outcomes/', views.QAOutcomesView.as_view(), name='qa_outcomes'),
    path('qa/sync/', views.QASyncView.as_view(), name='qa_sync'),
    path('qa/sync/cancel/', views.QASyncCancelView.as_view(), name='qa_sync_cancel'),
    path('qa/download/', views.QADownloadView.as_view(), name='qa_download'),
    # Altitude BPO online dashboard (separate app; reads team stats from here)
    path('dashboard/team-stats/', views.DashboardTeamStatsView.as_view(), name='dashboard_team_stats'),
    path('dashboard/team-targets/', views.DashboardTeamTargetView.as_view(), name='dashboard_team_targets'),
    path('qa/activity/', views.QAActivityView.as_view(), name='qa_activity'),
    path('qa/activity/<int:pk>/file/', views.QAActivityFileView.as_view(), name='qa_activity_file'),

    # REMOVE these custom report endpoints - they conflict with the router
    # The router already creates these endpoints automatically:
    # - /api/reports/ (GET) - list reports
    # - /api/reports/{pk}/ (GET) - retrieve report
    # - /api/reports/{pk}/download/ (GET) - download report (from @action)
    # - /api/reports/{pk}/preview/ (GET) - preview report data (from @action)
    # - /api/reports/generate_main/ (POST) - generate main report (from @action)
    
    # Additional custom endpoints
    path('outcomes/bulk_upload/', views.bulk_upload_outcomes, name='bulk_upload_outcomes'),
    path('outcomes/export/', views.export_outcomes, name='export_outcomes'),

    # Auth endpoints
    path('api-token-auth/', views.CustomAuthToken.as_view(), name='api_token_auth'),
    path('register/', views.register_user, name='register_user'),
    path('verify-token/', views.verify_token, name='verify_token'),

]