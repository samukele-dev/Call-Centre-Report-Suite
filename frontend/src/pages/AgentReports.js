// src/pages/AgentReports.js
import React, { useState, useEffect, useRef } from 'react';
import { Form, Dropdown, Alert } from 'react-bootstrap';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';

const AgentReports = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(null); // { index, total, campaignName }
  const [results, setResults] = useState([]);
  const [downloadingId, setDownloadingId] = useState(null);
  const [error, setError] = useState(null);
  const stopRequestedRef = useRef(false);
  const runInFlightRef = useRef(false);

  useEffect(() => {
    DashboardService.getCampaigns().then(result => {
      if (result.success) setCampaigns(result.data || []);
    });
  }, []);

  // Only DB-connected campaigns can be pulled this way — a campaign with no
  // cd_campaign_id has no reporting-schema data to fetch (see backend
  // external_source.fetch_agent_performance).
  const connectedCampaigns = campaigns.filter(c => c.cd_campaign_id);
  const skippedCount = campaigns.length - connectedCampaigns.length;

  const filteredCampaignOptions = connectedCampaigns.filter(c =>
    c.display_name.toLowerCase().includes(campaignSearch.trim().toLowerCase())
  );

  const toggleCampaign = (id) => {
    setSelectedCampaignIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const allSelected = connectedCampaigns.length > 0 && selectedCampaignIds.length === connectedCampaigns.length;
  const toggleSelectAll = () => {
    setSelectedCampaignIds(allSelected ? [] : connectedCampaigns.map(c => c.id));
  };

  const handleGenerate = async () => {
    if (selectedCampaignIds.length === 0 || runInFlightRef.current) return;
    if (startDate && endDate) {
      const from = `${startDate} ${startTime || '00:00'}`;
      const to = `${endDate} ${endTime || '23:59'}`;
      if (from > to) {
        setError('From date/time must be before or equal to the To date/time.');
        return;
      }
    }

    runInFlightRef.current = true;
    setRunning(true);
    setStopping(false);
    stopRequestedRef.current = false;
    setError(null);
    setResults([]);

    const campaignIds = [...selectedCampaignIds];
    const total = campaignIds.length;
    const campaignById = new Map(campaigns.map(c => [c.id, c]));
    const newResults = [];

    for (let i = 0; i < total; i++) {
      if (stopRequestedRef.current) break;
      const campaignId = campaignIds[i];
      const campaignName = campaignById.get(campaignId)?.display_name || `Campaign ${campaignId}`;
      setProgress({ index: i + 1, total, campaignName });

      const syncResult = await DashboardService.syncCampaignFromDatabase(
        campaignId, startDate || null, endDate || null, null, startTime || null, endTime || null
      );

      let entry = { campaignId, campaignName };
      if (syncResult.success) {
        const file = syncResult.data;
        if (file.status === 'failed') {
          entry = { ...entry, status: 'error', message: file.processing_errors || 'Processing failed' };
        } else {
          const reportsResult = await DashboardService.getReports(campaignId);
          const latestReport = reportsResult.success && reportsResult.data?.length > 0 ? reportsResult.data[0] : null;
          entry = {
            ...entry,
            status: 'success',
            message: `${(file.processed_records || 0).toLocaleString()} of ${(file.total_records || 0).toLocaleString()} records processed`,
            report: latestReport,
            hasAgentPerformance: !!latestReport?.parameters?.has_agent_performance,
          };
        }
      } else {
        entry = {
          ...entry,
          status: 'error',
          message: typeof syncResult.error === 'object' ? JSON.stringify(syncResult.error) : syncResult.error,
        };
      }
      newResults.push(entry);
      setResults([...newResults]);
    }

    runInFlightRef.current = false;
    setProgress(null);
    setRunning(false);
    setStopping(false);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    setStopping(true);
  };

  const handleDownload = async (report, campaignName) => {
    if (!report) return;
    setDownloadingId(report.id);
    try {
      const result = await DashboardService.downloadReport(report.id);
      if (result.success) {
        const timestamp = new Date().toISOString().slice(0, 10);
        saveAs(result.data, `${campaignName.replace(/\s+/g, '_')}_Report_${timestamp}.xlsx`);
      } else {
        setError(`Download failed: ${result.error}`);
      }
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="agent-reports-page">
      <div className="page-header">
        <h1 className="page-title mb-1">Agent Reports</h1>
        <p className="page-subtitle mb-0">
          Pull one or more campaigns straight from the source database for a date range and generate their
          full reports — including the Agent Performance sheet — without going through Upload.
        </p>
      </div>

      <div className="qa-filter-grid mb-3">
        <Form.Group>
          <Form.Label>Campaigns</Form.Label>
          <Dropdown autoClose="outside" onToggle={(open) => { if (!open) setCampaignSearch(''); }}>
            <Dropdown.Toggle
              variant="outline-secondary"
              className="w-100 text-start d-flex justify-content-between align-items-center"
              disabled={running}
            >
              <span>
                {selectedCampaignIds.length === 0
                  ? 'Select campaigns...'
                  : allSelected
                    ? `All ${connectedCampaigns.length} campaigns selected`
                    : `${selectedCampaignIds.length} of ${connectedCampaigns.length} selected`}
              </span>
            </Dropdown.Toggle>
            <Dropdown.Menu className="w-100" style={{ maxHeight: '380px', overflowY: 'auto' }}>
              {connectedCampaigns.length === 0 ? (
                <Dropdown.ItemText className="text-muted">
                  No campaigns have a Source Database Campaign ID configured yet.
                </Dropdown.ItemText>
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
                  <Dropdown.Item as="button" onClick={toggleSelectAll}>
                    <Form.Check type="checkbox" readOnly checked={allSelected}
                      label={<strong>{allSelected ? 'Deselect all' : 'Select all'}</strong>} />
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
          {skippedCount > 0 && (
            <Form.Text className="text-muted d-block mt-1">
              {skippedCount} campaign{skippedCount === 1 ? '' : 's'} hidden — not connected to the source database.
            </Form.Text>
          )}
        </Form.Group>

        <Form.Group>
          <Form.Label>From (optional)</Form.Label>
          <div className="qa-date-time-group">
            <Form.Control
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={running}
              max={endDate || undefined}
            />
            <Form.Control
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              disabled={running}
              title="Optional — narrows the start date to a specific time (ignored unless a start date is also set)"
            />
          </div>
        </Form.Group>

        <Form.Group>
          <Form.Label>To (optional)</Form.Label>
          <div className="qa-date-time-group">
            <Form.Control
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={running}
              min={startDate || undefined}
            />
            <Form.Control
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              disabled={running}
              title="Optional — narrows the end date to a specific time (ignored unless an end date is also set)"
            />
          </div>
        </Form.Group>
      </div>
      <Form.Text className="text-muted d-block mb-3">
        Filters by interaction date. Leave everything blank to pull each campaign's full history. Wide date
        ranges may cause the Agent Performance sheet to be skipped for that campaign (see report notes) — the
        rest of the report still generates normally.
      </Form.Text>

      <div className="qa-sync-bar mb-3">
        <div className="qa-sync-status">
          {running && progress ? (
            <span className="text-muted small">
              <span className="spinner-border spinner-border-sm me-2"></span>
              Generating {progress.index} of {progress.total} — {progress.campaignName}
              {stopping ? ' (stopping after this one...)' : ''}
            </span>
          ) : (
            <span className="text-muted small">
              Pick campaigns and an optional date range, then generate.
            </span>
          )}
        </div>
        {running ? (
          <>
            {progress && (
              <div className="qa-sync-progress-bar" aria-hidden="true">
                <div
                  className="qa-sync-progress-fill"
                  style={{ width: `${Math.round(((progress.index - 1) / progress.total) * 100)}%` }}
                />
              </div>
            )}
            <button className="btn btn-sm btn-outline-danger" onClick={handleStop} disabled={stopping}>
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          </>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            onClick={handleGenerate}
            disabled={selectedCampaignIds.length === 0}
          >
            <i className="bi bi-file-earmark-bar-graph me-1"></i>Generate Reports
          </button>
        )}
      </div>

      {error && <Alert variant="danger" dismissible onClose={() => setError(null)} className="mb-3">{error}</Alert>}

      {results.length > 0 && (
        <div className="campaign-list agent-reports-list">
          <div className="campaign-list-head agent-reports-list-row">
            <span>Campaign</span>
            <span>Status</span>
            <span>Details</span>
            <span>Agent Performance</span>
            <span>Report</span>
          </div>
          {results.map(r => (
            <div className="campaign-row agent-reports-list-row" key={r.campaignId}>
              <span>{r.campaignName}</span>
              <span>
                {r.status === 'success' ? (
                  <span className="recent-chip" style={{ color: 'var(--chip-teal-fg)' }}>
                    <i className="bi bi-check-circle-fill me-1"></i>Success
                  </span>
                ) : (
                  <span className="recent-chip" style={{ color: '#c0392b' }}>
                    <i className="bi bi-x-circle-fill me-1"></i>Failed
                  </span>
                )}
              </span>
              <span className="text-muted small">{r.message}</span>
              <span className="text-muted small">
                {r.status !== 'success' ? '—' : r.hasAgentPerformance ? (
                  <span className="text-muted small"><i className="bi bi-check2 me-1"></i>Included</span>
                ) : (
                  <span className="text-muted small">Not available for this range</span>
                )}
              </span>
              <span>
                {r.status === 'success' && r.report ? (
                  <button
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => handleDownload(r.report, r.campaignName)}
                    disabled={downloadingId === r.report.id}
                  >
                    {downloadingId === r.report.id ? (
                      <span className="spinner-border spinner-border-sm"></span>
                    ) : (
                      <><i className="bi bi-download me-1"></i>Download</>
                    )}
                  </button>
                ) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentReports;
