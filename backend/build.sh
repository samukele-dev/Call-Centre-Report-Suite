#!/usr/bin/env bash
# Render build command for the backend web service (see render.yaml).
# set -o errexit: stop immediately on the first failing command, rather than
# limping into `migrate`/`runserver` with a half-installed environment.
set -o errexit

pip install -r requirements.txt

# Collects every app's static files (admin, DRF browsable API) into
# STATIC_ROOT for WhiteNoise to serve — see settings.py's STORAGES.
# --noinput: never prompt (this runs unattended in Render's build step).
python manage.py collectstatic --noinput

# Applies any migrations not yet run against DATABASE_URL. Safe to run on
# every deploy — a migration already applied is simply skipped.
python manage.py migrate
