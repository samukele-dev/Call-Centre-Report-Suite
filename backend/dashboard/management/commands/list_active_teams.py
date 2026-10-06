from django.core.management.base import BaseCommand

from dashboard.external_source import _get_connection
from dashboard.team_stats import day_window


class Command(BaseCommand):
    help = (
        "List the source-DB teams that made calls today (with sales and answered calls), so you know the exact "
        "names to put in a Dashboard team's 'source team names'."
    )

    def handle(self, *args, **options):
        start, end = day_window()
        conn = _get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SET statement_timeout = 60000")
            cur.execute(
                """
                SELECT t.name::text, c.name, COUNT(*),
                       COUNT(*) FILTER (WHERE oo.sale = 1),
                       COUNT(*) FILTER (WHERE iv.talk_time > interval '0')
                FROM reporting.interaction_voice iv
                JOIN reporting.teams t ON t.id = iv.team_id
                JOIN cxm.campaigns c ON c.id = iv.campaign_id
                LEFT JOIN reporting.outcomes oo ON oo.id = iv.outcome_id
                WHERE iv.start_time >= %s AND iv.start_time < %s
                GROUP BY t.name::text, c.name
                ORDER BY t.name::text, 4 DESC
                """,
                (start, end),
            )
            rows = cur.fetchall()
        finally:
            conn.close()

        self.stdout.write(f"Active source teams today ({start.date()}):")
        self.stdout.write(f"{'TEAM (use this exact name)':34} {'CAMPAIGN':32} {'CALLS':>6} {'SALES':>6} {'ANSWERED':>9}")
        for team, campaign, calls, sales, answered in rows:
            self.stdout.write(f"{team:34} {campaign:32} {calls:>6} {sales:>6} {answered:>9}")
