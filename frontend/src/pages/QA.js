// src/pages/QA.js
import React, { useState, useEffect, useCallback } from 'react';
import { Form, Dropdown, Spinner, Alert } from 'react-bootstrap';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';
import { useQASync } from '../context/QASyncContext';
import { describeError, requireSelections, validateDateRange } from '../utils/errorMessages';

const PAGE_SIZE = 50;

const QA = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [outcomeOptions, setOutcomeOptions] = useState([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [selectedOutcomes, setSelectedOutcomes] = useState([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [outcomeSearch, setOutcomeSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [records, setRecords] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [numPages, setNumPages] = useState(1);
  const [lastSynced, setLastSynced] = useState(null);
  // Per selected campaign: [{ campaign_id, campaign, gaps: [{start_date, start_time, end_date, end_time}] }]
  // — the parts of the current date filter that were never synced.
  const [coverage, setCoverage] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingOutcomes, setLoadingOutcomes] = useState(false);
  const [error, setError] = useState(null);
  // Syncs and downloads live in QASyncProvider (app level), not here, so they keep
  // running — and their progress/Stop stays visible — when you open another page.
  const {
    syncing, downloading, progress: syncProgress, stopping, completedTick, activityTick,
    runSync, runDownload, stopSync: handleStopSync,
  } = useQASync();

  useEffect(() => {
    DashboardService.getCampaigns().then(result => {
      if (result.success) setCampaigns(result.data || []);
    });
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    setEndDate(today.toISOString().slice(0, 10));
    setStartDate(weekAgo.toISOString().slice(0, 10));
  }, []);

  const fetchOutcomeOptions = useCallback(() => {
    if (selectedCampaignIds.length === 0) {
      setOutcomeOptions([]);
      setSelectedOutcomes([]);
      return;
    }
    setLoadingOutcomes(true);
    DashboardService.getQAOutcomes(selectedCampaignIds).then(result => {
      const options = result.success ? (result.data || []) : [];
      setOutcomeOptions(options);
      const validNames = new Set(options);
      setSelectedOutcomes(prev => prev.filter(name => validNames.has(name)));
      setLoadingOutcomes(false);
    });
  }, [selectedCampaignIds]);

  // Outcome options are scoped to whichever campaigns are selected — refetch
  // whenever that changes, and drop any selected outcome that no longer applies.
  useEffect(() => {
    fetchOutcomeOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCampaignIds]);

  const fetchRecords = useCallback(async () => {
    if (selectedCampaignIds.length === 0) {
      setRecords([]);
      setTotalCount(0);
      setNumPages(1);
      setLastSynced(null);
      setCoverage([]);
      return;
    }
    const dateProblem = validateDateRange({ startDate, endDate, startTime, endTime });
    if (dateProblem) {
      setError(dateProblem);
      setRecords([]);
      setTotalCount(0);
      setNumPages(1);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await DashboardService.getQARecords({
      campaignIds: selectedCampaignIds,
      startDate: startDate || null,
      endDate: endDate || null,
      startTime: startTime || null,
      endTime: endTime || null,
      outcomes: selectedOutcomes,
      page: currentPage,
      pageSize: PAGE_SIZE,
    });
    if (result.success) {
      setRecords(result.data.results || []);
      setTotalCount(result.data.count || 0);
      setNumPages(result.data.num_pages || 1);
      setLastSynced(result.data.last_synced || null);
      setCoverage(result.data.coverage || []);
    } else {
      setError(describeError(result.error, 'Could not load QA records'));
      setRecords([]);
      setTotalCount(0);
      setNumPages(1);
    }
    setLoading(false);
  }, [selectedCampaignIds, startDate, endDate, startTime, endTime, selectedOutcomes, currentPage]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCampaignIds, startDate, endDate, startTime, endTime, selectedOutcomes]);

  // Refetch whenever the shared sync finishes a job (it keeps running when
  // this page isn't mounted, so this also catches up after coming back to it).
  useEffect(() => {
    if (completedTick > 0) {
      fetchRecords();
      fetchOutcomeOptions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedTick]);

  // Starts the sync in the shared provider: one request per job, sequentially,
  // with progress, Stop and incremental refresh handled there. `plan`
  // (optional) is a list of { campaignId, startDate, startTime, endDate,
  // endTime } jobs — used by "Sync missing range" to pull just the uncovered
  // gaps. Without it, each selected campaign is synced for the page's own
  // date filter (defaults to the last 7 days on load; reporting.
  // interaction_voice has no campaign index, so widening the filter and
  // re-syncing is what pulls more history).
  const handleSync = (plan = null) => {
    const problem =
      requireSelections([[selectedCampaignIds, 'at least one campaign (Campaigns dropdown)']]) ||
      validateDateRange({ startDate, endDate, startTime, endTime });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const campaignNameById = new Map(campaigns.map(c => [c.id, c.display_name]));
    const jobs = (Array.isArray(plan)
      ? plan
      : selectedCampaignIds.map(campaignId => ({ campaignId, startDate, startTime, endDate, endTime }))
    ).map(job => ({ ...job, campaignName: campaignNameById.get(job.campaignId) }));
    runSync(jobs);
  };
  // Downloads every record matching the current filters (campaigns,
  // outcomes, date range) as one .xlsx file — not just the current 50-row
  // page shown on screen.
  // The download itself runs in the shared provider, so it finishes (and
  // notifies you) even if you switch to another page while it's preparing.
  const handleDownload = () => {
    if (downloading) return;
    const problem =
      requireSelections([[selectedCampaignIds, 'at least one campaign (Campaigns dropdown)']]) ||
      validateDateRange({ startDate, endDate, startTime, endTime });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    runDownload({
      campaignIds: selectedCampaignIds,
      startDate: startDate || null,
      endDate: endDate || null,
      startTime: startTime || null,
      endTime: endTime || null,
      outcomes: selectedOutcomes,
    });
  };

  // ----- Recent activity (the user's past syncs / downloads, kept server-side) -----
  const [activity, setActivity] = useState([]);
  const [activityOpen, setActivityOpen] = useState(true);

  useEffect(() => {
    DashboardService.getQAActivity().then(result => {
      if (result.success) setActivity(result.data || []);
    });
  }, [activityTick]);

  // Puts the filter bar back to exactly what a past sync/download used.
  const applyActivityFilters = (a) => {
    const f = a.filters || {};
    const known = new Set(campaigns.map(c => c.id));
    const ids = (f.campaign_ids || []).filter(id => known.has(id));
    if (ids.length === 0) {
      setError('The campaign(s) for that entry are no longer in the campaign list.');
      return;
    }
    setError(null);
    setSelectedCampaignIds(ids);
    setStartDate(f.start_date || '');
    setEndDate(f.end_date || '');
    setStartTime(f.start_time ? f.start_time.slice(0, 5) : '');
    setEndTime(f.end_time ? f.end_time.slice(0, 5) : '');
    setSelectedOutcomes(f.outcomes || []);
  };

  const redownloadActivityFile = async (a) => {
    setError(null);
    const result = await DashboardService.downloadQAActivityFile(a.id);
    if (result.success) {
      saveAs(result.data, `QA_Records_${(a.created_at || '').slice(0, 10) || 'file'}.xlsx`);
    } else {
      setError(result.error);
    }
  };

  const describeActivityFilters = (a) => {
    const f = a.filters || {};
    const parts = [];
    if (f.start_date || f.end_date) parts.push(`${f.start_date || '…'} → ${f.end_date || '…'}`);
    if (f.outcomes && f.outcomes.length > 0) parts.push(`${f.outcomes.length} outcome${f.outcomes.length === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'No date filter';
  };

  const activityStatusBadge = (s) => ({
    running: <span className="badge bg-info text-dark">Running</span>,
    done: <span className="badge bg-success">Done</span>,
    stopped: <span className="badge bg-warning text-dark">Stopped</span>,
    failed: <span className="badge bg-danger">Failed</span>,
  }[s] || <span className="badge bg-secondary">{s}</span>);

  const toggleCampaign = (id) => {
    setSelectedCampaignIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const allCampaignsSelected = campaigns.length > 0 && selectedCampaignIds.length === campaigns.length;
  const toggleSelectAllCampaigns = () => {
    setSelectedCampaignIds(allCampaignsSelected ? [] : campaigns.map(c => c.id));
  };
  const filteredCampaignOptions = campaigns.filter(c =>
    c.display_name.toLowerCase().includes(campaignSearch.trim().toLowerCase())
  );

  const toggleOutcome = (name) => {
    setSelectedOutcomes(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);
  };
  const allOutcomesSelected = outcomeOptions.length > 0 && selectedOutcomes.length === outcomeOptions.length;
  const toggleSelectAllOutcomes = () => {
    setSelectedOutcomes(allOutcomesSelected ? [] : outcomeOptions);
  };
  const filteredOutcomeOptions = outcomeOptions.filter(name =>
    name.toLowerCase().includes(outcomeSearch.trim().toLowerCase())
  );

  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const goToPage = (p) => setCurrentPage(Math.min(Math.max(1, p), numPages));

  const pageNumbers = () => {
    const nums = [];
    const pageWindow = 1;
    for (let p = 1; p <= numPages; p++) {
      if (p === 1 || p === numPages || Math.abs(p - currentPage) <= pageWindow) {
        nums.push(p);
      } else if (nums[nums.length - 1] !== '…') {
        nums.push('…');
      }
    }
    return nums;
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (seconds) => {
    if (seconds === null || seconds === undefined) return null;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  // Uncovered parts of the current date filter, one sync job per gap.
  const campaignsWithGaps = coverage.filter(c => c.gaps && c.gaps.length > 0);
  const missingRangePlan = campaignsWithGaps.flatMap(c =>
    c.gaps.map(g => ({
      campaignId: c.campaign_id,
      startDate: g.start_date, startTime: g.start_time,
      endDate: g.end_date, endTime: g.end_time,
    }))
  );

  const formatGapDate = (dateStr, timeStr, isEnd) => {
    const d = new Date(`${dateStr}T00:00:00`);
    const label = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    const wholeDay = isEnd ? timeStr === '23:59:59' : timeStr === '00:00:00';
    return wholeDay ? label : `${label} ${timeStr.slice(0, 5)}`;
  };
  const formatGap = (g) => {
    const from = formatGapDate(g.start_date, g.start_time, false);
    const to = formatGapDate(g.end_date, g.end_time, true);
    return from === to ? from : `${from} – ${to}`;
  };

  const formatSyncedAt = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr ago`;
    return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="qa-page">
      <div className="page-header">
        <h1 className="page-title mb-1">QA Review</h1>
        <p className="page-subtitle mb-0">
          Browse real call records across one or more campaigns for quality checks — pick campaigns, narrow by date or outcome.
        </p>
      </div>

      {/* Filter bar */}
      <div className="qa-filter-grid mb-3">
        <Form.Group>
          <Form.Label>Campaigns</Form.Label>
          <Dropdown autoClose="outside" onToggle={(open) => { if (!open) setCampaignSearch(''); }}>
            <Dropdown.Toggle variant="outline-secondary" className="w-100 text-start d-flex justify-content-between align-items-center">
              <span>
                {selectedCampaignIds.length === 0
                  ? 'Select campaigns...'
                  : allCampaignsSelected
                    ? `All ${campaigns.length} campaigns selected`
                    : `${selectedCampaignIds.length} of ${campaigns.length} selected`}
              </span>
            </Dropdown.Toggle>
            <Dropdown.Menu className="w-100" style={{ maxHeight: '380px', overflowY: 'auto' }}>
              {campaigns.length === 0 ? (
                <Dropdown.ItemText className="text-muted">No campaigns found.</Dropdown.ItemText>
              ) : (
                <>
                  <div className="qa-dropdown-search">
                    <Form.Control
                      type="text"
                      size="sm"
                      placeholder="Search campaigns..."
                      value={campaignSearch}
                      onChange={(e) => setCampaignSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  </div>
                  <Dropdown.Item as="button" onClick={toggleSelectAllCampaigns}>
                    <Form.Check type="checkbox" readOnly checked={allCampaignsSelected}
                      label={<strong>{allCampaignsSelected ? 'Deselect all' : 'Select all'}</strong>} />
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  {filteredCampaignOptions.length === 0 ? (
                    <Dropdown.ItemText className="text-muted">No campaigns match "{campaignSearch}".</Dropdown.ItemText>
                  ) : (
                    filteredCampaignOptions.map(c => (
                      <Dropdown.Item as="button" key={c.id} onClick={() => toggleCampaign(c.id)} active={selectedCampaignIds.includes(c.id)}>
                        <Form.Check type="checkbox" readOnly checked={selectedCampaignIds.includes(c.id)} label={c.display_name} />
                      </Dropdown.Item>
                    ))
                  )}
                </>
              )}
            </Dropdown.Menu>
          </Dropdown>
        </Form.Group>

        <Form.Group>
          <Form.Label>Outcomes</Form.Label>
          <Dropdown autoClose="outside" onToggle={(open) => { if (!open) setOutcomeSearch(''); }}>
            <Dropdown.Toggle
              variant="outline-secondary"
              className="w-100 text-start d-flex justify-content-between align-items-center"
              disabled={selectedCampaignIds.length === 0}
            >
              <span>
                {selectedCampaignIds.length === 0 ? (
                  'Pick campaigns first'
                ) : loadingOutcomes ? (
                  <><span className="spinner-border spinner-border-sm me-2"></span>Loading...</>
                ) : outcomeOptions.length === 0 && !lastSynced ? (
                  'Sync required'
                ) : selectedOutcomes.length === 0 ? (
                  `All outcomes (${outcomeOptions.length})`
                ) : allOutcomesSelected ? (
                  `All ${outcomeOptions.length} outcomes selected`
                ) : (
                  `${selectedOutcomes.length} of ${outcomeOptions.length} selected`
                )}
              </span>
            </Dropdown.Toggle>
            <Dropdown.Menu className="w-100" style={{ maxHeight: '380px', overflowY: 'auto' }}>
              {outcomeOptions.length === 0 ? (
                <Dropdown.ItemText className="text-muted">
                  {lastSynced
                    ? 'No outcomes found for these campaigns.'
                    : 'These campaigns haven’t been synced yet — click "Sync Now" above to pull data first.'}
                </Dropdown.ItemText>
              ) : (
                <>
                  <div className="qa-dropdown-search">
                    <Form.Control
                      type="text"
                      size="sm"
                      placeholder="Search outcomes..."
                      value={outcomeSearch}
                      onChange={(e) => setOutcomeSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  </div>
                  <Dropdown.Item as="button" onClick={toggleSelectAllOutcomes}>
                    <Form.Check type="checkbox" readOnly checked={allOutcomesSelected}
                      label={<strong>{allOutcomesSelected ? 'Deselect all' : 'Select all'}</strong>} />
                  </Dropdown.Item>
                  <Dropdown.Item as="button" onClick={() => setSelectedOutcomes([])}>
                    <i className="bi bi-asterisk me-2"></i>Clear (show every outcome)
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  {filteredOutcomeOptions.length === 0 ? (
                    <Dropdown.ItemText className="text-muted">No outcomes match "{outcomeSearch}".</Dropdown.ItemText>
                  ) : (
                    filteredOutcomeOptions.map(name => (
                      <Dropdown.Item as="button" key={name} onClick={() => toggleOutcome(name)} active={selectedOutcomes.includes(name)}>
                        <Form.Check type="checkbox" readOnly checked={selectedOutcomes.includes(name)} label={name} />
                      </Dropdown.Item>
                    ))
                  )}
                </>
              )}
            </Dropdown.Menu>
          </Dropdown>
        </Form.Group>

        <Form.Group>
          <Form.Label>From</Form.Label>
          <div className="qa-date-time-group">
            <Form.Control type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} max={endDate || undefined} />
            <Form.Control
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={!startDate}
              title={!startDate ? 'Pick a start date first' : 'Optional — narrows the start date to a specific time'}
            />
          </div>
        </Form.Group>

        <Form.Group>
          <Form.Label>To</Form.Label>
          <div className="qa-date-time-group">
            <Form.Control type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate || undefined} />
            <Form.Control
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={!endDate}
              title={!endDate ? 'Pick an end date first' : 'Optional — narrows the end date to a specific time'}
            />
          </div>
        </Form.Group>
      </div>

      {selectedCampaignIds.length > 0 && !syncing && campaignsWithGaps.length > 0 && (
        <Alert variant="warning" className="mb-3">
          <div className="d-flex justify-content-between align-items-start gap-3">
            <div>
              <strong>These results are incomplete for the dates you picked.</strong> Some of the date range
              has never been synced, so counts (including sales) can be lower than the real numbers:
              <ul className="mb-1 mt-2">
                {campaignsWithGaps.map(c => (
                  <li key={c.campaign_id}>
                    <strong>{c.campaign}</strong> — not synced for {c.gaps.map(formatGap).join(', ')}
                  </li>
                ))}
              </ul>
              <span className="small text-muted">
                Data synced before this check existed also shows here — syncing the missing range confirms it.
              </span>
            </div>
            <button className="btn btn-sm btn-warning flex-shrink-0" onClick={() => handleSync(missingRangePlan)}>
              <i className="bi bi-arrow-repeat me-1"></i>Sync missing range
            </button>
          </div>
        </Alert>
      )}

      {selectedCampaignIds.length > 0 && (
        <div className="qa-sync-bar mb-3">
          <div className="qa-sync-status">
            {syncing && syncProgress ? (
              <span className="text-muted small">
                <span className="spinner-border spinner-border-sm me-2"></span>
                Syncing {syncProgress.index} of {syncProgress.total} — {syncProgress.campaignName}
                {stopping ? ' (stopping after this one...)' : ''}
              </span>
            ) : lastSynced ? (
              <span className="text-muted small">
                <i className="bi bi-check-circle-fill me-1" style={{ color: 'var(--chip-teal-fg)' }}></i>
                Data last synced {formatSyncedAt(lastSynced)}
              </span>
            ) : (
              <span className="text-muted small">
                <i className="bi bi-exclamation-circle-fill me-1" style={{ color: '#c98a1f' }}></i>
                No data synced yet for these campaigns — click Sync to pull records.
              </span>
            )}
          </div>
          {syncing ? (
            <>
              {syncProgress && (
                <div className="qa-sync-progress-bar" aria-hidden="true">
                  <div
                    className="qa-sync-progress-fill"
                    style={{ width: `${Math.round(((syncProgress.index - 1) / syncProgress.total) * 100)}%` }}
                  />
                </div>
              )}
              <button className="btn btn-sm btn-outline-danger" onClick={handleStopSync} disabled={stopping}>
                {stopping ? 'Stopping...' : 'Stop'}
              </button>
            </>
          ) : (
            <button className="btn btn-sm btn-outline-secondary" onClick={() => handleSync()}>
              <i className="bi bi-arrow-repeat me-1"></i>Sync Now
            </button>
          )}
          <button
            className="btn btn-sm btn-primary"
            onClick={handleDownload}
            disabled={downloading || totalCount === 0}
            title={totalCount === 0 ? 'No records match the current filters' : 'Download every matching record as .xlsx'}
          >
            {downloading ? (
              <><span className="spinner-border spinner-border-sm me-1"></span>Downloading...</>
            ) : (
              <><i className="bi bi-download me-1"></i>Download ({totalCount.toLocaleString()})</>
            )}
          </button>
        </div>
      )}

      {error && <Alert variant="danger" dismissible onClose={() => setError(null)} className="mb-3">{error}</Alert>}

      {/* Recent activity — what you asked for, even if you left the page while it ran */}
      <div className="qa-activity mb-3">
        <button
          type="button"
          className="qa-activity-toggle"
          onClick={() => setActivityOpen(o => !o)}
          aria-expanded={activityOpen}
        >
          <span>
            <i className={`bi ${activityOpen ? 'bi-chevron-down' : 'bi-chevron-right'} me-2`}></i>
            <strong>Recent activity</strong>
            <span className="text-muted small ms-2">your latest syncs and downloads</span>
          </span>
          <span className="text-muted small">{activity.length} item{activity.length === 1 ? '' : 's'}</span>
        </button>
        {activityOpen && (
          activity.length === 0 ? (
            <div className="text-muted small p-3">Nothing yet — syncs and downloads you run will be listed here.</div>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm align-middle mb-0 qa-activity-table">
                <thead>
                  <tr>
                    <th>When</th><th>What</th><th>Campaign</th><th>Filters</th><th>Status</th><th className="text-end">Records</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {activity.slice(0, 10).map(a => (
                    <tr key={a.id}>
                      <td className="text-nowrap">{formatDate(a.created_at)}</td>
                      <td>{a.kind === 'download' ? 'Download' : 'Sync'}</td>
                      <td>{a.campaign || '—'}</td>
                      <td className="small text-muted">{describeActivityFilters(a)}</td>
                      <td title={a.message || ''}>{activityStatusBadge(a.status)}</td>
                      <td className="text-end">{a.records != null ? a.records.toLocaleString() : '—'}</td>
                      <td className="text-end text-nowrap">
                        <button className="btn btn-sm btn-outline-secondary me-1" onClick={() => applyActivityFilters(a)}>
                          Use filters
                        </button>
                        {a.has_file && (
                          <button className="btn btn-sm btn-outline-primary" onClick={() => redownloadActivityFile(a)}>
                            <i className="bi bi-download me-1"></i>File
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {selectedCampaignIds.length === 0 ? (
        <div className="text-center py-5">
          <i className="bi bi-funnel" style={{ fontSize: '2.5rem', color: 'var(--text-faint)' }}></i>
          <p className="text-muted mt-3 mb-0">Select at least one campaign to pull records.</p>
        </div>
      ) : loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" variant="primary" />
        </div>
      ) : (
        <>
          <div className="d-flex justify-content-between align-items-center mb-2">
            <span className="text-muted small">
              {totalCount === 0 ? 'No records' : `Showing ${(pageStart + 1).toLocaleString()}–${(pageStart + records.length).toLocaleString()} of ${totalCount.toLocaleString()}`}
            </span>
          </div>

          <div className="campaign-list qa-list">
            <div className="campaign-list-head qa-list-head">
              <span>Date</span>
              <span>Customer</span>
              <span>Phone Number</span>
              <span>Agent Name</span>
              <span>Campaign</span>
              <span>Outcome</span>
              <span>Recording</span>
            </div>

            {records.length === 0 ? (
              <div className="text-center py-5">
                <i className="bi bi-inbox" style={{ fontSize: '2.5rem', color: 'var(--text-faint)' }}></i>
                <p className="text-muted mt-2 mb-0">No records match these filters.</p>
              </div>
            ) : (
              records.map(r => (
                <div className="campaign-row qa-list-row" key={r.id}>
                  <span className="text-muted small">{formatDate(r.date)}</span>
                  <span>{r.customer || '—'}</span>
                  <span className="qa-phone">{r.phone_number || '—'}</span>
                  <span>{r.agent_name || '—'}</span>
                  <span><span className="recent-chip">{r.campaign || '—'}</span></span>
                  <span>{r.outcome || '—'}</span>
                  <span>
                    {r.recording_key ? (
                      <span className="qa-recording" title={r.recording_key}>
                        <i className="bi bi-mic-fill me-1"></i>
                        {formatDuration(r.recording_duration_seconds)}
                      </span>
                    ) : (
                      <span className="text-muted small">No recording</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>

          {numPages > 1 && (
            <div className="pagination-bar">
              <span className="pagination-summary">
                Showing {(pageStart + 1).toLocaleString()}–{(pageStart + records.length).toLocaleString()} of {totalCount.toLocaleString()}
              </span>
              <div className="pagination-controls">
                <button className="pagination-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>
                  <i className="bi bi-chevron-left"></i>
                </button>
                {pageNumbers().map((p, i) =>
                  p === '…' ? (
                    <span key={`ellipsis-${i}`} className="pagination-ellipsis">…</span>
                  ) : (
                    <button
                      key={p}
                      className={`pagination-btn ${p === currentPage ? 'active' : ''}`}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  )
                )}
                <button className="pagination-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage === numPages}>
                  <i className="bi bi-chevron-right"></i>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default QA;
