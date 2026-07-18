import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
django.setup()

from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token

# Create test user
test_user, created = User.objects.get_or_create(
    username='test',
    defaults={
        'email': 'test@example.com',
        'is_active': True
    }
)

if created:
    test_user.set_password('test123')
    test_user.save()
    print(f"✅ Created test user: {test_user.username}")

# Create or get token
token, created = Token.objects.get_or_create(user=test_user)
print(f"✅ Token: {token.key}")
print(f"✅ Use this token for API requests: {token.key}")