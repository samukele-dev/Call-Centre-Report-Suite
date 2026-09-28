# Picked up automatically by gunicorn when it starts from backend/ (Render's
# rootDir), so these apply even if the service's Start Command in the Render
# dashboard is just `gunicorn backend.wsgi:application` and never picked up
# the flags in render.yaml. Flags given explicitly on the command line still
# win over this file. Keep these in step with render.yaml's startCommand —
# see the comment there for why each value is what it is.
import os

worker_class = "gthread"
workers = 1      # qa_source.py's duplicate-sync guard is process-local
threads = 4
timeout = 5400   # just under Render's ~100 min HTTP request limit
bind = "0.0.0.0:" + os.environ.get("PORT", "10000")
