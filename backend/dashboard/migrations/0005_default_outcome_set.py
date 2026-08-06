from django.db import migrations


def create_default_set_and_backfill(apps, schema_editor):
    OutcomeSet = apps.get_model('dashboard', 'OutcomeSet')
    OutcomeDescription = apps.get_model('dashboard', 'OutcomeDescription')
    Campaign = apps.get_model('dashboard', 'Campaign')

    default_set, _ = OutcomeSet.objects.get_or_create(
        name='Outcomes 1',
        defaults={'description': 'Default outcome set — every existing outcome description and campaign was assigned here on rollout.'}
    )

    OutcomeDescription.objects.filter(outcome_set__isnull=True).update(outcome_set=default_set)
    Campaign.objects.filter(outcome_set__isnull=True).update(outcome_set=default_set)


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('dashboard', '0004_outcomeset_campaign_outcome_set_and_more'),
    ]

    operations = [
        migrations.RunPython(create_default_set_and_backfill, noop_reverse),
    ]
