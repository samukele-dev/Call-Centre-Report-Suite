# backend/backend/urls.py
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from dashboard.views import CustomAuthToken, register_user, verify_token

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('dashboard.urls')),

    path('api-token-auth/', CustomAuthToken.as_view(), name='api_token_auth'),
    path('register/', register_user, name='register'),
    path('verify-token/', verify_token, name='verify_token'),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)