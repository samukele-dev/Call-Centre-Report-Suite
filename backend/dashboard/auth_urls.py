# dashboard/auth_urls.py
from django.urls import path
from .views import CustomAuthToken, register_user, verify_token

urlpatterns = [
    path('api-token-auth/', CustomAuthToken.as_view(), name='api_token_auth'),
    path('register/', register_user, name='register'),
    path('verify-token/', verify_token, name='verify_token'),
]