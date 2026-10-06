from django.core.management.base import BaseCommand

from dashboard.models import DashboardTeam

# (floor, display name, source-DB team names, sort order within the floor).
# Checked against the live source DB:
#
# Floor 1
#   - 1Life: two source teams, "1Life" and "1 Life", shown as ONE dashboard team.
#   - Assupol: two teams — "Assupol Tectical Unit" (sic: the DB spells it
#     "Tectical") and "Mighty Assupol". A third plain "Assupol" team exists
#     (1 agent) but isn't one of the two, so it's not counted.
#   - Hollard: "Hollard Edgars" is the only Hollard team with calls recently (it
#     works the Hollard Edgars, Funeral Upsell and Device insurance campaigns).
#     "Hollard Funeral", "Hollard Life", etc. exist but had no calls in the last 3
#     days — add them here if they start dialling.
#
# Floor 2 (Vodacom Funeral)
#   - TeamThemba, Team Thelma, TeamAyanda sell on the Vodacom Funeral campaign.
#   - Sandra's team in the DB is "Team_Sandra" (83 agents, active); "Team Sandra"
#     (with a space) exists but has no agents/calls — kept in case it's used later.
#   - Pat's calls on the Vodacom Funeral Upsell campaign are logged under the
#     "VodacomFuneralUpsell" team; "TeamPatricia" (26 agents) had no calls in the
#     last 3 days but is Pat's team by name, so both count.
#   - Anita's team is "Team Anita_Funeral" (8 agents, 3.5k calls in the last 3 days).
#     A separate "Team Media Anita" exists (1 agent, Media campaign) — not counted.
#
# Targets start at 0 — managers set them from the dashboard.
TEAMS = [
    ('Floor 1', '1Life', ['1Life', '1 Life']),
    ('Floor 1', 'Assupol Tactical', ['Assupol Tectical Unit']),
    ('Floor 1', 'Assupol Mighty', ['Mighty Assupol']),
    ('Floor 1', 'Hollard', ['Hollard Edgars']),
    ('Floor 2', 'Team Themba', ['TeamThemba']),
    ('Floor 2', 'Team Thelma', ['Team Thelma']),
    ('Floor 2', 'Team Ayanda', ['TeamAyanda']),
    ('Floor 2', 'Team Sandra', ['Team_Sandra', 'Team Sandra']),
    ('Floor 2', 'Team Pat', ['VodacomFuneralUpsell', 'TeamPatricia']),
    ('Floor 2', 'Team Anita', ['Team Anita_Funeral']),
]

# Placeholder rows an earlier version of this command created from the dashboard's
# sample spreadsheet; removed here if they are still unmapped (never touches a mapped row).
OLD_SAMPLE_NAMES = [
    'Team Pat Upsell', 'Team Tebogo Media', 'Team Sbu Funeral',
    'Team Glanton Funeral', 'Team Themba Funeral', 'Team Victus Funeral',
]


class Command(BaseCommand):
    help = "Create the dashboard teams for Floor 1 (1Life, Assupol x2, Hollard) and Floor 2 mapped to their source-DB teams."

    def handle(self, *args, **options):
        removed, _ = DashboardTeam.objects.filter(
            floor='Floor 2', display_name__in=OLD_SAMPLE_NAMES, source_team_names=[],
        ).delete()

        created = updated = 0
        order_in_floor = {}
        for floor, name, source_names in TEAMS:
            order = order_in_floor.get(floor, 0)
            order_in_floor[floor] = order + 1
            row, was_created = DashboardTeam.objects.get_or_create(
                floor=floor, display_name=name,
                defaults={'target': 0, 'sort_order': order, 'source_team_names': source_names},
            )
            if was_created:
                created += 1
            elif row.source_team_names != source_names or row.sort_order != order:
                # Re-running keeps the mapping/order current but never touches a target someone has set.
                row.source_team_names, row.sort_order = source_names, order
                row.save(update_fields=['source_team_names', 'sort_order', 'updated_at'])
                updated += 1

        self.stdout.write(self.style.SUCCESS(
            f"Dashboard teams: {created} created, {updated} updated, {removed} old placeholder row(s) removed. "
            "Set each team's target from the dashboard."
        ))
