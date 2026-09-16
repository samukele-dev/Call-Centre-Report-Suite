import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
django.setup()

from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token

# Username/password/email come from env vars (see backend/.env.example and
# backend/render.yaml) — no literal password lives in this file, not even
# as a fallback default (an earlier version of this file had one, which is
# exactly the kind of hardcoded-credential pattern GitHub's push
# protection flags — making it overridable wasn't enough on its own; the
# literal string itself had to go too). If TEST_USER_PASSWORD isn't set,
# this skips creating a user entirely (with a clear message) instead of
# silently falling back to anything guessable, since this backend runs on
# a public URL handling real PII.
TEST_USER_USERNAME = os.environ.get('TEST_USER_USERNAME', 'admin')
TEST_USER_PASSWORD = os.environ.get('TEST_USER_PASSWORD')
TEST_USER_EMAIL = os.environ.get('TEST_USER_EMAIL', 'admin@altitudebpo.co.za')

admin_user = User.objects.filter(username=TEST_USER_USERNAME).first()

if admin_user is None and not TEST_USER_PASSWORD:
    print(
        f"TEST_USER_PASSWORD is not set — skipping login user creation. "
        f"Set it (see backend/.env.example) and re-run/redeploy to create "
        f"'{TEST_USER_USERNAME}'."
    )
elif admin_user is None:
    admin_user = User.objects.create(
        username=TEST_USER_USERNAME,
        email=TEST_USER_EMAIL,
        is_active=True,
    )
    admin_user.set_password(TEST_USER_PASSWORD)
    admin_user.save()
    Token.objects.get_or_create(user=admin_user)
    print(f"Created user '{TEST_USER_USERNAME}'.")
else:
    # Already exists — left untouched (password not reset on repeat runs,
    # e.g. every deploy), but still ensure it has a token: a user created
    # before this script managed tokens, or one whose token row was lost
    # some other way, would otherwise be stuck without one forever, since
    # this branch never used to run get_or_create on Token at all.
    Token.objects.get_or_create(user=admin_user)
    print(f"User '{TEST_USER_USERNAME}' already exists — left untouched.")
