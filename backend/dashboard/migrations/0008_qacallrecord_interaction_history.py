from django.db import migrations, models


def clear_stale_qa_cache(apps, schema_editor):
    """
    Existing QACallRecord rows were synced under the old one-row-per-contact
    model (current state only, no interaction_id) and are being replaced by
    one-row-per-historical-interaction. There's no way to backfill a real
    interaction_id for rows synced under the old query, and the data itself
    is exactly what's being fixed (it only ever reflected each contact's
    latest disposition) — so it's cleared rather than migrated in place.
    QACallRecord is a cache; re-syncing from the QA Review page repopulates
    it correctly under the new model.
    """
    QACallRecord = apps.get_model('dashboard', 'QACallRecord')
    QACallRecord.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('dashboard', '0007_campaign_end_date_campaign_last_synced_at_and_more'),
    ]

    operations = [
        migrations.RunPython(clear_stale_qa_cache, reverse_code=migrations.RunPython.noop),
        migrations.RemoveConstraint(
            model_name='qacallrecord',
            name='unique_qa_record_per_contact',
        ),
        migrations.AddField(
            model_name='qacallrecord',
            name='interaction_id',
            field=models.CharField(db_index=True, default='', max_length=64),
            preserve_default=False,
        ),
        migrations.AddIndex(
            model_name='qacallrecord',
            index=models.Index(fields=['campaign', 'contact_id'], name='dashboard_q_campaig_52f15e_idx'),
        ),
        migrations.AddConstraint(
            model_name='qacallrecord',
            constraint=models.UniqueConstraint(fields=('campaign', 'interaction_id'), name='unique_qa_record_per_interaction'),
        ),
    ]
