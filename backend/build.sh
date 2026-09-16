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

# Creates a login user if one doesn't already exist yet (get_or_create —
# see create_test_user.py), so there's always something to log in with on
# a fresh deploy without a manual Shell step. Safe to run on every deploy:
# a no-op once the user already exists (and does NOT reset its password on
# later runs, even if TEST_USER_PASSWORD changes afterward — see that
# script's own comment). Configure TEST_USER_USERNAME/PASSWORD/EMAIL in
# the Render dashboard (see render.yaml, backend/.env.example) rather than
# leaving this at its hardcoded-default credentials on a real deployment.
python create_test_user.py
