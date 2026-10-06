import os

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand, CommandError
from rest_framework.authtoken.models import Token

ENV_VAR = 'DASHBOARD_API_TOKEN'


class Command(BaseCommand):
    help = (
        "Set up the API token the Altitude BPO online dashboard uses to read team stats from this backend.\n"
        f"If the {ENV_VAR} environment variable is set, that exact value becomes the token (no shell needed — "
        "put it in the host's environment settings and it is applied on every deploy). Otherwise a random token "
        "is created (or shown if it already exists)."
    )

    def add_arguments(self, parser):
        parser.add_argument('--username', default='dashboard-service')
        parser.add_argument('--rotate', action='store_true', help='Replace the existing token with a new random one.')
        parser.add_argument(
            '--from-env-only', action='store_true',
            help=f"Only apply {ENV_VAR} if it is set; otherwise do nothing (used by build.sh so deploys never print a token).",
        )

    def handle(self, *args, **options):
        wanted = (os.environ.get(ENV_VAR) or '').strip()
        if options['from_env_only'] and not wanted:
            self.stdout.write(f"{ENV_VAR} is not set — dashboard token not configured.")
            return

        user, created = User.objects.get_or_create(
            username=options['username'], defaults={'is_active': True, 'is_staff': False},
        )
        if created:
            user.set_unusable_password()  # token-only account; it can't log in to the web UI
            user.save()

        if wanted:
            # DRF's Token primary key is the token string itself, max 40 characters.
            if len(wanted) > 40 or len(wanted) < 20:
                raise CommandError(f"{ENV_VAR} must be 20-40 characters long (it is {len(wanted)}).")
            current = Token.objects.filter(user=user).first()
            if current and current.key == wanted:
                self.stdout.write(f"Dashboard token for '{user.username}' already matches {ENV_VAR}.")
                return
            Token.objects.filter(user=user).delete()
            Token.objects.create(user=user, key=wanted)
            self.stdout.write(self.style.SUCCESS(f"Dashboard token for '{user.username}' set from {ENV_VAR}."))
            return

        if options['rotate']:
            Token.objects.filter(user=user).delete()
        token, _ = Token.objects.get_or_create(user=user)
        self.stdout.write(f"User: {user.username}")
        self.stdout.write(f"Token: {token.key}")
