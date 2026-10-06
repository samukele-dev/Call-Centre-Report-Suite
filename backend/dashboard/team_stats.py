# backend/dashboard/team_stats.py
"""
Today's per-team stats for the Altitude BPO online dashboard (a separate app).
That app calls this backend (see TeamStatsView) instead of the source DB, so
only this backend's IP has to be allowlisted there.

For each DashboardTeam row: Current = sales today (calls whose outcome carries
the source DB's own sale=1 flag — the same definition Agent Performance uses),
and average talk time = total talk time of all the team's agents / number of
agents live in the team today (agents with at least one call since midnight).
A floor's total is weighted the same way (total talk seconds / total live
agents), never an average of per-team averages, which would let a 3-agent team
count as much as a 30-agent one.
"""
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from .external_source import ExternalSourceError, _get_connection
from .models import DashboardTeam

FLOORS = ['Floor 1', 'Floor 2']

# Always listed first on its floor, whatever its sales.
PINNED_TEAM = 'Team Pat'

# "Today" means today at the call centre (South Africa), not UTC — the app's
# TIME_ZONE is UTC, which would roll the dashboard's day over at 02:00.
CALL_CENTRE_TZ = ZoneInfo('Africa/Johannesburg')

# Many dashboard screens can be open at once; one source-DB query per name set
# per this many seconds is plenty (the numbers move by a handful of sales/min).
CACHE_SECONDS = 45
_cache = {}
_cache_lock = threading.Lock()


def day_window(now=None):
    """(start of today, now) in call-centre time."""
    now = now or datetime.now(CALL_CENTRE_TZ)
    return now.replace(hour=0, minute=0, second=0, microsecond=0), now


def fetch_team_day_stats(team_names, start_dt, end_dt):
    """
    {source team name: {'calls', 'sales', 'answered', 'talk_seconds', 'agents'}} for
    calls started in [start_dt, end_dt). A one-day window keeps this on the
    start_time index (measured ~0.2s) — reporting.interaction_voice has no
    team/campaign index, so never call this with a wide range.
    """
    if not team_names:
        return {}
    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SET statement_timeout = 25000")
        cur.execute(
            """
            SELECT t.name::text,
                   COUNT(*)                                                        AS calls,
                   COUNT(*) FILTER (WHERE oo.sale = 1)                             AS sales,
                   COUNT(*) FILTER (WHERE iv.talk_time > interval '0')             AS answered,
                   COALESCE(SUM(EXTRACT(EPOCH FROM iv.talk_time))
                            FILTER (WHERE iv.talk_time > interval '0'), 0)         AS talk_seconds,
                   COUNT(DISTINCT iv.user_id)                                      AS agents
            FROM reporting.interaction_voice iv
            JOIN reporting.teams t         ON t.id = iv.team_id
            LEFT JOIN reporting.outcomes oo ON oo.id = iv.outcome_id
            WHERE iv.start_time >= %s AND iv.start_time < %s
              AND t.name::text = ANY(%s)
            GROUP BY t.name::text
            """,
            (start_dt, end_dt, list(team_names)),
        )
        return {
            name: {'calls': calls, 'sales': sales, 'answered': answered, 'talk_seconds': float(talk), 'agents': agents}
            for name, calls, sales, answered, talk, agents in cur.fetchall()
        }
    except Exception as e:
        raise ExternalSourceError(f"Team stats query against external database failed: {e}")
    finally:
        conn.close()


def _cached_day_stats(team_names, start_dt, end_dt):
    key = (tuple(sorted(team_names)), start_dt.date())
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
    stats = fetch_team_day_stats(team_names, start_dt, end_dt)
    with _cache_lock:
        _cache[key] = (time.monotonic(), stats)
    return stats


def _avg(talk_seconds, agents):
    return round(talk_seconds / agents, 1) if agents else None


def build_stats(floor, now=None):
    """
    The dashboard payload for 'Floor 1', 'Floor 2' or 'Global' (both floors,
    one total). Raises ValueError for an unknown floor, ExternalSourceError if
    the source DB can't be queried.
    """
    if floor == 'Global':
        floors = FLOORS
    elif floor in FLOORS:
        floors = [floor]
    else:
        raise ValueError(f"Unknown floor '{floor}'")

    start_dt, end_dt = day_window(now)
    rows = list(DashboardTeam.objects.filter(floor__in=floors, is_active=True).order_by('floor', 'sort_order', 'display_name'))
    names = sorted({n for r in rows for n in (r.source_team_names or [])})
    by_name = _cached_day_stats(names, start_dt, end_dt) if names else {}

    teams = []
    t_target = t_current = t_answered = t_agents = 0
    t_talk = 0.0
    for r in rows:
        mine = [by_name[n] for n in (r.source_team_names or []) if n in by_name]
        current = sum(m['sales'] for m in mine)
        answered = sum(m['answered'] for m in mine)
        agents = sum(m['agents'] for m in mine)
        talk = sum(m['talk_seconds'] for m in mine)
        teams.append({
            'floor': r.floor,
            'team': r.display_name,
            'target': r.target,
            'current': current,
            'shortfall': r.target - current,
            'avg_talk_seconds': _avg(talk, agents),
            'agents_live': agents,
            'calls_answered': answered,
            'talk_seconds': round(talk, 1),
            'mapped': bool(r.source_team_names),
        })
        t_target += r.target
        t_current += current
        t_answered += answered
        t_agents += agents
        t_talk += talk

    # Floors stay grouped; within a floor Team Pat is pinned first, then the
    # rest by sales today (most first). sorted() is stable, so ties keep their
    # configured sort_order.
    teams.sort(key=lambda t: (t['floor'], t['team'] != PINNED_TEAM, -t['current']))

    return {
        'floor': floor,
        'date': start_dt.date().isoformat(),
        'as_of': end_dt.isoformat(),
        'teams': teams,
        'totals': {
            'target': t_target,
            'current': t_current,
            'shortfall': t_target - t_current,
            'avg_talk_seconds': _avg(t_talk, t_agents),
            'agents_live': t_agents,
            'calls_answered': t_answered,
            'talk_seconds': round(t_talk, 1),
        },
    }
