import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
django.setup()

from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token

# Username/password/email are overridable via env vars (see
# backend/.env.example and backend/render.yaml) rather than hardcoded, so
# this can run unattended on every deploy (see build.sh) without baking a
# fixed, guessable password into an automated pipeline for a backend that
# now handles real PII (contact ID numbers, names, phone numbers) on a
# public URL. Defaults below match this script's original hardcoded
# values, so local/dev use is unchanged if these are left unset.
TEST_USER_USERNAME = os.environ.get('TEST_USER_USERNAME', 'admin')
TEST_USER_PASSWORD = os.environ.get('TEST_USER_PASSWORD', 'Admin123')
TEST_USER_EMAIL = os.environ.get('TEST_USER_EMAIL', 'admin@altitudebpo.co.za')


# Create admin user
admin_user, created = User.objects.get_or_create(
    username=TEST_USER_USERNAME,
    defaults={
        'email': TEST_USER_EMAIL,
        'is_active': True
    }
)

if created:
    admin_user.set_password(TEST_USER_PASSWORD)
    admin_user.save()
    print(f"Created user '{TEST_USER_USERNAME}'.")
else:
    print(f"User '{TEST_USER_USERNAME}' already exists — left untouched "
          f"(password not reset on repeat runs, e.g. every deploy).")

# Create or get token
token, created = Token.objects.get_or_create(user=admin_user)
