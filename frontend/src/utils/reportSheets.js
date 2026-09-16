// Mirrors ReportViewSet.ALL_REPORT_SHEETS on the backend. Shared between
// every place that lets a user pick which sheets a single-campaign report
// builds (the manual "Generate Campaign Report" modal and the "Sync from
// Database" panel, which auto-generates the same report on completion).
export const REPORT_SHEETS = [
  { key: 'processed_data', label: 'Processed Data', description: 'All raw data from your latest upload' },
  { key: 'pivot', label: 'Pivot', description: 'Count of each outcome description — can exceed Lead Count when Full Outcome History is on' },
  { key: 'lead_count', label: 'Lead Count', description: 'Total leads + New/Sales/True Contacts/Unsuccessful/Unworkable breakdown — always matches Processed Data exactly' },
  { key: 'campaign_analysis', label: 'Campaign Analysis', description: 'Categorized metrics with Excel formulas', requiresPivot: true, requiresLeadCount: true },
  { key: 'call_count_breakdown', label: 'Call Count Breakdown', description: 'How many times each contact was called in range', dbOnly: true },
  { key: 'agent_performance', label: 'Agent Performance', description: 'Per-agent call stats, sorted by sales', dbOnly: true },
  { key: 'template', label: 'Template (Sheet1)', description: "The campaign's template, populated", requiresPivot: true, requiresLeadCount: true },
];

export const ALL_REPORT_SHEET_KEYS = REPORT_SHEETS.map(s => s.key);

// A separate opt-in toggle, not a sheet — it changes how Pivot/Campaign
// Analysis count outcomes (every historical disposition vs. each contact's
// latest only), rather than adding a worksheet. Off by default everywhere,
// including auto-generated reports after upload/sync, since it's a full
// external-database scan verified to take several minutes on a busy
// campaign (see ReportViewSet._auto_generate_full_report's docstring).
export const FULL_OUTCOME_HISTORY_OPTION = {
  label: 'Full Outcome History',
  description: "Count every historical disposition, not just each contact's latest — e.g. a sale made last month still counts even if the contact was called again since",
  slow: true,
};

// Toggles `key` in `selected`, then re-adds 'pivot'/'lead_count' whenever a
// requiresPivot/requiresLeadCount sheet ends up selected — Campaign
// Analysis's cells are live VLOOKUPs against Pivot and a direct reference
// to Lead Count's Total Leads cell, and the template population reads its
// category counts back out of the actual Pivot worksheet, so the backend
// silently forces both on whenever Campaign Analysis/Template is wanted.
// Mirroring that here means the checkbox UI never implies a combination
// the backend can't actually produce.
export function toggleReportSheet(selected, key) {
  let next = selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key];
  const needsPivot = REPORT_SHEETS.some(s => s.requiresPivot && next.includes(s.key));
  if (needsPivot && !next.includes('pivot')) next = [...next, 'pivot'];
  const needsLeadCount = REPORT_SHEETS.some(s => s.requiresLeadCount && next.includes(s.key));
  if (needsLeadCount && !next.includes('lead_count')) next = [...next, 'lead_count'];
  return next;
}
