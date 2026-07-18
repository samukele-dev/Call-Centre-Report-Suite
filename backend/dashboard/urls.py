# dashboard/urls.py - FIXED VERSION
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
from .views import ReportTemplateViewSet, CampaignViewSet


router = DefaultRouter()
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
    
    # REMOVE these custom report endpoints - they conflict with the router
    # The router already creates these endpoints automatically:
    # - /api/reports/ (GET) - list reports
    # - /api/reports/{pk}/ (GET) - retrieve report
    # - /api/reports/{pk}/download/ (GET) - download report (from @action)
    # - /api/reports/generate_main/ (POST) - generate main report (from @action)
    
    # Additional custom endpoints
    path('outcomes/bulk_upload/', views.bulk_upload_outcomes, name='bulk_upload_outcomes'),
    path('outcomes/export/', views.export_outcomes, name='export_outcomes'),
    
    # Test endpoints
    path('test-upload/', views.test_upload, name='test_upload'),
    path('setup-test-user/', views.setup_test_user, name='setup_test_user'),
    
    # Auth endpoints
    path('api-token-auth/', views.CustomAuthToken.as_view(), name='api_token_auth'),
    path('register/', views.register_user, name='register_user'),
    path('verify-token/', views.verify_token, name='verify_token'),

]