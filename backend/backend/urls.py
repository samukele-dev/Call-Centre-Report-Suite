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

# DEBUG-only, matching Django's own recommended default — and deliberately
# NOT added back for production this time (an earlier version of this file
# did, via django.views.static.serve, reasoning that report downloads
# needed it). That reasoning turned out to be wrong: verified that every
# real download already goes through an authenticated DRF action
# (ReportViewSet.download, CallDataFileViewSet.download_processed) which
# reads the file off disk and streams it through the response directly —
# neither ever links to or redirects through MEDIA_URL. A raw, unauthenticated
# static-file route here would have bypassed the auth those endpoints
# enforce entirely: anyone who could guess or enumerate a filename (report/
# upload names include the campaign name and a timestamp — not exactly
# hard to guess) could pull real contact PII (names, phone numbers, ID
# numbers) straight off disk with no login at all. Nothing in this app
# needs MEDIA_URL to be browser-reachable outside local dev.
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)