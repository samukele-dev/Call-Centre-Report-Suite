// src/pages/QA.js
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Form, Dropdown, Spinner, Alert } from 'react-bootstrap';
import DashboardService from '../api/dashboardService';

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
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingOutcomes, setLoadingOutcomes] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null); // { index, total, campaignName }
  const [stopping, setStopping] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [error, setError] = useState(null);
  const syncAbortRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const syncInFlightRef = useRef(false);

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
    } else {
      setError(typeof result.error === 'object' ? JSON.stringify(result.error) : result.error);
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

  // Syncs one campaign per request, sequentially, instead of one giant
  // request for every selected campaign — a single request covering many
  // large campaigns can run for hours with zero feedback in between. This
  // way each campaign's progress shows up as it happens, already-synced
  // campaigns are visible in the results immediately, and the run can be
  // stopped between campaigns without losing anything already synced.
  const handleSync = async () => {
    // Guards against a fast double-click firing this twice: React state
    // updates are batched, so the `syncing` state alone isn't guaranteed to
    // have re-rendered between two click events fired close together. This
    // ref is set synchronously, before any await, so a second call in the
    // same tick sees it immediately.
    if (selectedCampaignIds.length === 0 || syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncing(true);
    setStopping(false);
    setSyncMessage(null);
    setError(null);
    stopRequestedRef.current = false;

    const campaignIds = [...selectedCampaignIds];
    const total = campaignIds.length;
    const campaignNameById = new Map(campaigns.map(c => [c.id, c.display_name]));
    const results = [];

    for (let i = 0; i < total; i++) {
      if (stopRequestedRef.current) break;
      const campaignId = campaignIds[i];
      setSyncProgress({ index: i + 1, total, campaignName: campaignNameById.get(campaignId) || `Campaign ${campaignId}` });

      const controller = new AbortController();
      syncAbortRef.current = controller;
      const result = await DashboardService.syncQACache([campaignId], controller.signal);
      syncAbortRef.current = null;

      if (result.aborted) break;

      if (result.success) {
        const entry = (result.data?.results || [])[0];
        if (entry) results.push(entry);
      } else {
        results.push({ campaign_id: campaignId, campaign: campaignNameById.get(campaignId), error: result.error });
      }

      // Refresh incrementally so campaigns already synced show up right away
      // instead of waiting for the whole run to finish.
      await Promise.all([fetchRecords(), fetchOutcomeOptions()]);
    }

    const stoppedEarly = stopRequestedRef.current;
    syncInFlightRef.current = false;
    setSyncProgress(null);
    setSyncing(false);
    setStopping(false);

    const failed = results.filter(r => r.error);
    const okCount = results.filter(r => !r.error).reduce((sum, r) => sum + (r.records_synced || 0), 0);
    const okCampaigns = results.filter(r => !r.error).length;

    if (failed.length > 0) {
      setError(`Sync failed for: ${failed.map(f => `${f.campaign} (${f.error})`).join('; ')}`);
    }
    if (results.length > 0) {
      setSyncMessage(
        `${stoppedEarly ? 'Stopped — s' : 'S'}ynced ${okCount.toLocaleString()} record${okCount === 1 ? '' : 's'} across ${okCampaigns} of ${total} campaign${total === 1 ? '' : 's'}.`
      );
    }
  };

  const handleStopSync = () => {
    stopRequestedRef.current = true;
    setStopping(true);
    if (syncAbortRef.current) {
      syncAbortRef.current.abort();
    }
  };

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
            <button className="btn btn-sm btn-outline-secondary" onClick={handleSync}>
              <i className="bi bi-arrow-repeat me-1"></i>Sync Now
            </button>
          )}
        </div>
      )}

      {syncMessage && <Alert variant="success" dismissible onClose={() => setSyncMessage(null)} className="mb-3">{syncMessage}</Alert>}
      {error && <Alert variant="danger" dismissible onClose={() => setError(null)} className="mb-3">{error}</Alert>}

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
