#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys

# Windows' console defaults stdout/stderr to a legacy codepage (cp1252) that
# can't encode the emoji used throughout this codebase's print()-based
# logging (e.g. "❌"). Without this, any code path that prints one on Windows
# raises UnicodeEncodeError and masks the real underlying error.
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def main():
    """Run administrative tasks."""
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
