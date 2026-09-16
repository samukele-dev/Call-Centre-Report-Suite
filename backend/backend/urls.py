# backend/backend/urls.py
from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from django.views.static import serve as static_serve
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
else:
    # static()'s helper above is a no-op outside DEBUG by design (Django
    # expects a real web server/CDN to serve media in production) — but
    # this app has no such thing in front of it on Render, and its whole
    # purpose is serving generated report files back for download, so
    # without a route here every "Download Report" click would 404 once
    # deployed. django.views.static.serve isn't recommended for
    # high-traffic production use (no caching headers, streams through the
    # Python process itself), but is an accepted, simple fit for an
    # internal/low-traffic tool like this one — the alternative (S3 +
    # django-storages) is real infrastructure this app doesn't have set up.
    # Files served this way must actually exist on disk at MEDIA_ROOT,
    # which on Render means the backend service's persistent disk (see
    # render.yaml) — without that disk, this route would just 404 for a
    # different reason (nothing there to serve).
    urlpatterns += [
        re_path(r'^media/(?P<path>.*)$', static_serve, {'document_root': settings.MEDIA_ROOT}),
    ]