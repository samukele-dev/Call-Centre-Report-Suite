// src/pages/CampaignUpload.js - COMPLETE WORKING VERSION
import React, { useState, useEffect } from 'react';
import {
  Card, Button, Alert, Spinner,
  Form, Row, Col, Dropdown, Badge
} from 'react-bootstrap';
import { useParams, Link } from 'react-router-dom';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';
import { describeError, validateDateRange } from '../utils/errorMessages';
import { REPORT_SHEETS, ALL_REPORT_SHEET_KEYS, toggleReportSheet, FULL_OUTCOME_HISTORY_OPTION } from '../utils/reportSheets';
import ReportPreviewModal from '../components/ReportPreviewModal';

const CampaignUpload = () => {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [message, setMessage] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncStartTime, setSyncStartTime] = useState('');
  const [syncEndTime, setSyncEndTime] = useState('');
  const [latestReport, setLatestReport] = useState(null);
  const [reportGenerationMissing, setReportGenerationMissing] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState(null);
  const [downloadingReport, setDownloadingReport] = useState(false);
  // The populated template is now its own separate file (see
  // _build_template_report on the backend) — built right after the main
  // report, not merged into it, so the main report no longer has to be
  // reopened just to attach a template to it. Tracked separately here so
  // it gets its own download button instead of silently becoming
  // "latestReport" (which must always stay the main/combined file).
  const [latestTemplateReport, setLatestTemplateReport] = useState(null);
  const [templateReportError, setTemplateReportError] = useState(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [sourceLists, setSourceLists] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState(null);
  const [selectedListIds, setSelectedListIds] = useState([]);
  const [syncSheets, setSyncSheets] = useState(ALL_REPORT_SHEET_KEYS);
  const [syncFullOutcomeHistory, setSyncFullOutcomeHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [templateSheetOptions, setTemplateSheetOptions] = useState([]);
  const [syncTemplateSheet, setSyncTemplateSheet] = useState('');
  const [templateSheetsError, setTemplateSheetsError] = useState(null);

  const syncTemplateSelected = syncSheets.includes('template');

  useEffect(() => {
    fetchCampaign();
  }, [id]);

  useEffect(() => {
    if (!syncTemplateSelected || templateSheetOptions.length > 0) return;
    DashboardService.getMasterTemplateSheets().then(result => {
      if (result.success) {
        setTemplateSheetOptions(result.data.sheets || []);
      } else {
        setTemplateSheetsError(result.error || 'Failed to load template sheet list.');
      }
    });
  }, [syncTemplateSelected, templateSheetOptions.length]);

  useEffect(() => {
    if (campaign?.cd_campaign_id) {
      fetchSourceLists();
    } else {
      setSourceLists([]);
      setSelectedListIds([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.cd_campaign_id]);

  const fetchSourceLists = async () => {
    setLoadingLists(true);
    setListsError(null);
    try {
      const result = await DashboardService.getCampaignSourceLists(campaign.id);
      if (result.success) {
        setSourceLists(result.data || []);
      } else {
        setListsError(describeError(result.error, 'Could not load batches from the database'));
      }
    } catch (err) {
      setListsError(describeError(err, 'Could not load batches from the database'));
    } finally {
      setLoadingLists(false);
    }
  };

  const toggleListId = (listId) => {
    setSelectedListIds(prev =>
      prev.includes(listId) ? prev.filter(x => x !== listId) : [...prev, listId]
    );
  };

  const allListsSelected = sourceLists.length > 0 && selectedListIds.length === sourceLists.length;

  const toggleSelectAllLists = () => {
    setSelectedListIds(allListsSelected ? [] : sourceLists.map(l => l.id));
  };

  const toggleSyncSheet = (key) => {
    setSyncSheets(prev => toggleReportSheet(prev, key));
  };

  const fetchCampaign = async () => {
    try {
      const result = await DashboardService.getCampaign(id);
      if (result.success) {
        setCampaign(result.data);
      } else {
        setMessage({
          type: 'danger',
          text: `Failed to load campaign: ${describeError(result.error, 'unknown error')}`
        });
      }
    } catch (err) {
      setMessage({
        type: 'danger',
        text: `Failed to load campaign: ${describeError(err, 'unknown error')}`
      });
    }
  };

  const handleSyncFromDatabase = async () => {
    const problem =
      (!campaign?.cd_campaign_id
        ? 'This campaign has no Source Database Campaign ID yet, so it cannot be synced. Set one on the Campaigns page first.'
        : null) ||
      (syncSheets.length === 0 ? 'Tick at least one report sheet before syncing.' : null) ||
      (syncTemplateSelected && !syncTemplateSheet
        ? 'You chose the Template report, so also pick which Template sheet matches this campaign.'
        : null) ||
      validateDateRange({
        startDate: syncStartDate, endDate: syncEndDate, startTime: syncStartTime, endTime: syncEndTime,
      });
    if (problem) {
      setMessage({ type: 'danger', text: problem });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setSyncing(true);
    setMessage(null);
    setDebugInfo(null);
    setLatestReport(null);
    setReportGenerationMissing(false);
    setReportError(null);
    setLatestTemplateReport(null);
    setTemplateReportError(null);

    try {
      // Two steps instead of one long request: the sync itself (pull + save,
      // usually seconds) returns as soon as the data is stored, and the
      // report is built by a second call below. Previously the report was
      // built inside the sync's own request (autoGenerateReport = true), so
      // that one request stayed open for minutes; if anything cut it off
      // (Render's proxy, a worker restart, a dropped connection) the page
      // showed a sync error even though the data was already saved and
      // showing as Processed under Data Files.
      const result = await DashboardService.syncCampaignFromDatabase(
        campaign.id,
        syncStartDate || null,
        syncEndDate || null,
        selectedListIds,
        syncStartTime || null,
        syncEndTime || null,
        syncSheets,
        syncFullOutcomeHistory,
        false,
        syncTemplateSelected ? syncTemplateSheet : null
      );

      if (result.success) {
        const file = result.data;
        if (file.status === 'failed') {
          setMessage({
            type: 'danger',
            text: `Database sync failed: ${file.processing_errors}`
          });
        } else {
          setMessage({
            type: 'success',
            text: `Pulled data from the database for ${campaign.display_name}!`
          });
          setDebugInfo({
            fileName: file.original_name,
            fileSize: file.file_size,
            totalRecords: file.total_records || 0,
            processedRecords: file.processed_records || 0,
            message: file.status_display || file.status
          });

          // Data is saved — say so now, then build the report as its own
          // step. The sync stays "in progress" (controls locked) until the
          // report finishes so a second sync can't start underneath it.
          setGeneratingReport(true);
          const reportResult = await DashboardService.generateCampaignReport(
            campaign.id,
            syncSheets,
            syncFullOutcomeHistory,
            syncTemplateSelected ? syncTemplateSheet : null,
            {
              startDate: syncStartDate, endDate: syncEndDate,
              startTime: syncStartTime, endTime: syncEndTime,
            }
          );
          setGeneratingReport(false);

          // Even on success, don't just grab whatever report happens to be
          // newest for this campaign — confirm it was actually built from
          // *this* sync's file (parameters.source_file, set in
          // ReportViewSet._auto_generate_full_report) before offering it.
          // Otherwise a stale report from an earlier sync would silently be
          // shown as if it reflected this one. A failed/timed-out report
          // request is checked the same way: the server can still finish
          // building it after the browser stopped waiting.
          //
          // Filtered to report_type 'campaign_analysis' specifically (not
          // just "newest") — the populated template is now saved as its
          // own, separate 'template_analysis' report right after this one
          // (see _build_template_report), so the newest row for this
          // campaign is sometimes the template, not the main report.
          const reportsResult = await DashboardService.getReports(campaign.id);
          const allReports = reportsResult.success ? (reportsResult.data || []) : [];
          const candidate = allReports.find(r => r.report_type === 'campaign_analysis');
          if (candidate && candidate.parameters?.source_file === file.original_name) {
            setLatestReport(candidate);
            const templateReportId = candidate.parameters?.template_report_id;
            const linkedTemplate = templateReportId
              ? allReports.find(r => r.id === templateReportId)
              : null;
            setLatestTemplateReport(linkedTemplate || null);
            setTemplateReportError(candidate.parameters?.template_error || null);
          } else {
            setReportGenerationMissing(true);
            setReportError(reportResult.success ? null : describeError(reportResult.error, 'Report generation failed'));
          }
        }
      } else {
        // result.error already comes fully worded from the backend (either
        // the raw ExternalSourceError message, or "Database sync failed:
        // <detail>" for an unexpected error — see sync_from_database's
        // except Exception branch) — prefixing it again here is what
        // produced the doubled "Database sync failed: Database sync
        // failed: ..." text.
        setMessage({
          type: 'danger',
          text: describeError(result.error, 'Database sync failed')
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (error) {
      setMessage({
        type: 'danger',
        text: describeError(error, 'Database sync failed')
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      console.error('❌ Database sync error details:', error);
    } finally {
      setGeneratingReport(false);
      setSyncing(false);
    }
  };

  const handleDownloadLatestReport = async () => {
    if (!latestReport) return;
    setDownloadingReport(true);
    try {
      const result = await DashboardService.downloadReport(latestReport.id);
      if (result.success) {
        const timestamp = new Date().toISOString().slice(0, 10);
        saveAs(result.data, `${campaign.name}_Report_${timestamp}.xlsx`);
      } else {
        alert(`Could not download the report: ${describeError(result.error, 'unknown error')}`);
      }
    } catch (err) {
      alert(`Could not download the report: ${describeError(err, 'unknown error')}`);
    } finally {
      setDownloadingReport(false);
    }
  };

  const handleDownloadLatestTemplate = async () => {
    if (!latestTemplateReport) return;
    setDownloadingTemplate(true);
    try {
      const result = await DashboardService.downloadReport(latestTemplateReport.id);
      if (result.success) {
        const timestamp = new Date().toISOString().slice(0, 10);
        saveAs(result.data, `${campaign.name}_Template_${timestamp}.xlsx`);
      } else {
        alert(`Could not download the template: ${describeError(result.error, 'unknown error')}`);
      }
    } catch (err) {
      alert(`Could not download the template: ${describeError(err, 'unknown error')}`);
    } finally {
      setDownloadingTemplate(false);
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (!campaign) {
    return (
      <div className="text-center py-5">
        <Spinner animation="border" variant="primary" />
        <p className="mt-3">Loading campaign...</p>
      </div>
    );
  }

  return (
    <div className="campaign-upload">
      <div className="upload-page-header">
        <Link to={`/campaigns/${id}`} className="btn btn-outline-secondary btn-icon-only" title="Back to campaign">
          <i className="bi bi-arrow-left"></i>
        </Link>
        <div>
          <h1 className="page-title mb-1">{campaign.display_name}</h1>
          <p className="page-subtitle mb-0">
            <span className="sheet-chip"><i className="bi bi-table"></i>{campaign.sheet_name}</span>
            Bring in call data for this campaign
          </p>
        </div>
      </div>

      {message && (
        <Alert variant={message.type} className="result-alert mb-4">
          <div className="result-alert-head">
            <i className={`bi ${message.type === 'success' ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'}`}></i>
            <span>{message.text}</span>
          </div>

          {debugInfo && (
            <>
              <div className="result-stat-grid">
                <div className="result-stat">
                  <span className="result-stat-label">File</span>
                  <span className="result-stat-value" title={debugInfo.fileName}>{debugInfo.fileName}</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Size</span>
                  <span className="result-stat-value">{formatFileSize(debugInfo.fileSize)}</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Records in file</span>
                  <span className="result-stat-value">{debugInfo.totalRecords?.toLocaleString() || 'Unknown'}</span>
                </div>
                <div className="result-stat">
                  <span className="result-stat-label">Processed</span>
                  <span className="result-stat-value">{debugInfo.processedRecords?.toLocaleString() || 'Unknown'}</span>
                </div>
              </div>

              {debugInfo.totalRecords && debugInfo.processedRecords &&
               debugInfo.processedRecords < debugInfo.totalRecords && (
                <Alert variant="warning" className="mt-3 mb-0 py-2">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  Only {debugInfo.processedRecords} out of {debugInfo.totalRecords} records were saved.
                </Alert>
              )}

              {latestReport && (
                <>
                  <Button
                    variant="outline-secondary"
                    className="mt-3 me-2"
                    onClick={() => setShowPreview(true)}
                  >
                    <i className="bi bi-eye me-2"></i>
                    Preview
                  </Button>
                  <Button
                    variant="primary"
                    className="mt-3 me-2"
                    onClick={handleDownloadLatestReport}
                    disabled={downloadingReport}
                  >
                    {downloadingReport ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-2"></span>
                        Downloading...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-file-earmark-arrow-down me-2"></i>
                        Download Report
                      </>
                    )}
                  </Button>

                  {/* The populated template is its own file now — see the
                      latestTemplateReport comment at its declaration — so it
                      gets its own button rather than being bundled into the
                      Download Report above. */}
                  {latestTemplateReport && (
                    <Button
                      variant="outline-primary"
                      className="mt-3"
                      onClick={handleDownloadLatestTemplate}
                      disabled={downloadingTemplate}
                    >
                      {downloadingTemplate ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2"></span>
                          Downloading...
                        </>
                      ) : (
                        <>
                          <i className="bi bi-file-earmark-spreadsheet me-2"></i>
                          Download Template
                        </>
                      )}
                    </Button>
                  )}

                  {!latestTemplateReport && templateReportError && (
                    <Alert variant="warning" className="mt-3 mb-0 py-2">
                      <i className="bi bi-exclamation-triangle me-2"></i>
                      The report is ready, but the Template couldn't be built
                      ({templateReportError}). Check{' '}
                      <Link to={`/campaigns/${id}/reports`}>Reports</Link> or try
                      generating it again from there.
                    </Alert>
                  )}
                </>
              )}

              {generatingReport && (
                <div className="mt-3 d-flex align-items-center">
                  <span className="spinner-border spinner-border-sm me-2"></span>
                  <span>Your data is saved. Building the report now — this can take a few minutes, and you can leave this page open.</span>
                </div>
              )}

              {reportGenerationMissing && (
                <Alert variant="warning" className="mt-3 mb-0 py-2">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  Data synced and saved, but the report isn't ready yet
                  {reportError ? ` (${reportError})` : ''}. Check{' '}
                  <Link to={`/campaigns/${id}/reports`}>Reports</Link> in a minute — it may still be
                  finishing — or build it from there.
                </Alert>
              )}
            </>
          )}
        </Alert>
      )}

      <Card className="mb-4 section-card">
        <Card.Header>
          <div className="section-card-title">
            <span className="section-card-icon"><i className="bi bi-database"></i></span>
            <div>
              <h5 className="mb-0">Sync from Database</h5>
              <span className="section-card-subtitle">Pull directly from the call-centre platform</span>
            </div>
          </div>
        </Card.Header>
        <Card.Body>
          {campaign.cd_campaign_id ? (
            <>
              <p className="text-muted mb-3">
                Pulls call data straight from the call-centre database
                (campaign <code>{campaign.cd_campaign_id}</code>, across every list it has ever
                had) and processes it into this campaign's report.
              </p>

              <Form.Group className="mb-3">
                <Form.Label>Batch(es) (optional)</Form.Label>
                {listsError ? (
                  <Alert variant="warning" className="py-2 px-3 mb-0">
                    Couldn't load batches from the database: {listsError}
                  </Alert>
                ) : (
                  <Dropdown autoClose="outside">
                    <Dropdown.Toggle
                      variant="outline-secondary"
                      className="w-100 text-start d-flex justify-content-between align-items-center"
                      disabled={syncing || loadingLists}
                    >
                      <span>
                        {loadingLists ? (
                          <><span className="spinner-border spinner-border-sm me-2"></span>Loading batches...</>
                        ) : selectedListIds.length === 0 ? (
                          `All batches (${sourceLists.length})`
                        ) : allListsSelected ? (
                          `All ${sourceLists.length} batches selected`
                        ) : (
                          `${selectedListIds.length} of ${sourceLists.length} batch${sourceLists.length !== 1 ? 'es' : ''} selected`
                        )}
                      </span>
                    </Dropdown.Toggle>
                    <Dropdown.Menu className="w-100" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                      {sourceLists.length === 0 ? (
                        <Dropdown.ItemText className="text-muted">No batches found for this campaign.</Dropdown.ItemText>
                      ) : (
                        <>
                          <Dropdown.Item as="button" onClick={toggleSelectAllLists}>
                            <Form.Check
                              type="checkbox"
                              readOnly
                              checked={allListsSelected}
                              label={<strong>{allListsSelected ? 'Deselect all' : 'Select all'}</strong>}
                            />
                          </Dropdown.Item>
                          <Dropdown.Item as="button" onClick={() => setSelectedListIds([])}>
                            <i className="bi bi-asterisk me-2"></i>Clear (use all Active batches)
                          </Dropdown.Item>
                          <Dropdown.Divider />
                          {sourceLists.map(list => (
                            <Dropdown.Item
                              as="button"
                              key={list.id}
                              onClick={() => toggleListId(list.id)}
                              active={selectedListIds.includes(list.id)}
                            >
                              <Form.Check
                                type="checkbox"
                                readOnly
                                checked={selectedListIds.includes(list.id)}
                                label={
                                  <>
                                    {list.name}
                                    {list.status && (
                                      <Badge
                                        bg={list.status === 'active' ? 'success' : 'secondary'}
                                        className="ms-2"
                                      >
                                        {list.status}
                                      </Badge>
                                    )}
                                    {list.created_at && (
                                      <span className="text-muted small ms-2">
                                        {new Date(list.created_at).toLocaleDateString()}
                                      </span>
                                    )}
                                  </>
                                }
                              />
                            </Dropdown.Item>
                          ))}
                        </>
                      )}
                    </Dropdown.Menu>
                  </Dropdown>
                )}
                <Form.Text className="text-muted d-block mt-1">
                  Pick specific upload batches (e.g. "Absa Insurance 20260618") pulled live from the database —
                  works even for an Inactive one — use "Select all" to check every one individually, or leave it
                  cleared to pull every batch currently marked Active (matching Manage Data Lists on the source
                  system), same as before this campaign had any batches manually picked.
                </Form.Text>
              </Form.Group>

              <Row className="mb-3">
                <Col md={5}>
                  <Form.Group>
                    <Form.Label>From (optional)</Form.Label>
                    <Row className="g-2">
                      <Col xs={7}>
                        <Form.Control
                          type="date"
                          value={syncStartDate}
                          onChange={(e) => setSyncStartDate(e.target.value)}
                          disabled={syncing}
                          max={syncEndDate || undefined}
                        />
                      </Col>
                      <Col xs={5}>
                        <Form.Control
                          type="time"
                          value={syncStartTime}
                          onChange={(e) => setSyncStartTime(e.target.value)}
                          disabled={syncing}
                          title="Optional — narrows the start date to a specific time (ignored unless a start date is also set)"
                        />
                      </Col>
                    </Row>
                  </Form.Group>
                </Col>
                <Col md={5}>
                  <Form.Group>
                    <Form.Label>To (optional)</Form.Label>
                    <Row className="g-2">
                      <Col xs={7}>
                        <Form.Control
                          type="date"
                          value={syncEndDate}
                          onChange={(e) => setSyncEndDate(e.target.value)}
                          disabled={syncing}
                          min={syncStartDate || undefined}
                        />
                      </Col>
                      <Col xs={5}>
                        <Form.Control
                          type="time"
                          value={syncEndTime}
                          onChange={(e) => setSyncEndTime(e.target.value)}
                          disabled={syncing}
                          title="Optional — narrows the end date to a specific time (ignored unless an end date is also set)"
                        />
                      </Col>
                    </Row>
                  </Form.Group>
                </Col>
              </Row>
              <Form.Text className="text-muted d-block mb-3">
                Filters by interaction date (when the call happened), on top of the batch selection above. Time is optional and narrows the from/to date to a specific moment. Leave everything blank for no date limit.
              </Form.Text>

              <div className="modal-section">
                <div className="modal-section-title">Sheets to include in the report</div>
                <p className="text-muted small mb-3">
                  The full report is generated automatically once the sync finishes — pick which
                  sheets it should build. Skipping Agent Performance/Call Count Breakdown also
                  skips their (slower) database queries.
                </p>
                <Row>
                  {REPORT_SHEETS.map(sheet => {
                    const dbUnavailable = sheet.dbOnly && !campaign?.cd_campaign_id;
                    const locked = sheet.key === 'campaign_analysis'
                      ? syncTemplateSelected
                      : (sheet.key === 'pivot' || sheet.key === 'lead_count') &&
                        (syncSheets.includes('campaign_analysis') || syncSheets.includes('template'));
                    return (
                      <Col md={6} key={sheet.key}>
                        <Form.Check
                          type="checkbox"
                          id={`sync-sheet-${sheet.key}`}
                          className="mb-2"
                          disabled={syncing || dbUnavailable || locked}
                          checked={syncSheets.includes(sheet.key)}
                          onChange={() => toggleSyncSheet(sheet.key)}
                          label={
                            <span>
                              <strong>{sheet.label}</strong> – {sheet.description}
                              {locked && <span className="text-muted"> (required by Campaign Analysis/Template)</span>}
                              {dbUnavailable && <span className="text-muted"> (requires a Source Database Campaign ID)</span>}
                            </span>
                          }
                        />
                      </Col>
                    );
                  })}
                </Row>
                {syncTemplateSelected && (
                  <div className="mb-3 mt-2">
                    <div className="fw-semibold mb-2">Template sheet</div>
                    {templateSheetsError ? (
                      <Alert variant="warning" className="py-2 mb-0">{templateSheetsError}</Alert>
                    ) : (
                      <>
                        <Form.Select
                          size="sm"
                          disabled={syncing || templateSheetOptions.length === 0}
                          value={syncTemplateSheet}
                          onChange={(e) => setSyncTemplateSheet(e.target.value)}
                        >
                          <option value="">
                            {templateSheetOptions.length === 0 ? 'Loading sheets…' : 'Select a sheet…'}
                          </option>
                          {templateSheetOptions.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </Form.Select>
                        <div className="form-text">
                          Which sheet of the Call Centre Report Template matches this campaign.
                        </div>
                      </>
                    )}
                  </div>
                )}
                <hr className="my-2" />
                <Form.Check
                  type="checkbox"
                  id="sync-full-outcome-history"
                  disabled={syncing || !campaign?.cd_campaign_id}
                  checked={syncFullOutcomeHistory}
                  onChange={(e) => setSyncFullOutcomeHistory(e.target.checked)}
                  label={
                    <span>
                      <strong>{FULL_OUTCOME_HISTORY_OPTION.label}</strong> – {FULL_OUTCOME_HISTORY_OPTION.description}
                      <span className="text-muted"> (slower — a full database scan)</span>
                    </span>
                  }
                />
              </div>

              <Button
                variant="primary"
                size="lg"
                onClick={handleSyncFromDatabase}
                disabled={syncing}
              >
                {syncing ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2"></span>
                    {generatingReport ? 'Building report...' : 'Pulling from database...'}
                  </>
                ) : (
                  <>
                    <i className="bi bi-arrow-repeat me-2"></i>
                    Sync from Database
                  </>
                )}
              </Button>
              {(() => {
                const dateProblem = validateDateRange({
                  startDate: syncStartDate, endDate: syncEndDate, startTime: syncStartTime, endTime: syncEndTime,
                });
                const hint = syncSheets.length === 0
                  ? 'Tick at least one report sheet above before syncing.'
                  : syncTemplateSelected && !syncTemplateSheet
                    ? 'Choose a Template sheet above to continue.'
                    : dateProblem;
                return hint ? (
                  <div className="text-danger small mt-2">
                    <i className="bi bi-exclamation-circle me-1"></i>{hint}
                  </div>
                ) : null;
              })()}
            </>
          ) : (
            <Alert variant="secondary" className="mb-0">
              No source database campaign is configured for this campaign yet.
              Set a <strong>Source Database Campaign ID</strong> on the campaign
              (via the Campaigns page or Django admin) to enable this.
            </Alert>
          )}
        </Card.Body>
      </Card>

      <ReportPreviewModal
        show={showPreview}
        onHide={() => setShowPreview(false)}
        reportId={latestReport?.id}
      />
    </div>
  );
};

export default CampaignUpload;