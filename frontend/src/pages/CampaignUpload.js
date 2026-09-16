// src/pages/CampaignUpload.js - COMPLETE WORKING VERSION
import React, { useState, useEffect } from 'react';
import {
  Card, Button, Alert, Spinner,
  Form, Row, Col, Dropdown
} from 'react-bootstrap';
import { useParams, Link } from 'react-router-dom';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';
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
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [sourceLists, setSourceLists] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState(null);
  const [selectedListIds, setSelectedListIds] = useState([]);
  const [syncSheets, setSyncSheets] = useState(ALL_REPORT_SHEET_KEYS);
  const [syncFullOutcomeHistory, setSyncFullOutcomeHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    fetchCampaign();
  }, [id]);

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
        setListsError(typeof result.error === 'object' ? JSON.stringify(result.error) : result.error);
      }
    } catch (err) {
      setListsError('Error loading batches from the database');
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
          text: `Failed to load campaign: ${result.error}`
        });
      }
    } catch (err) {
      setMessage({
        type: 'danger',
        text: 'Error loading campaign'
      });
    }
  };

  const handleSyncFromDatabase = async () => {
    if (syncStartDate && syncEndDate) {
      const from = `${syncStartDate} ${syncStartTime || '00:00'}`;
      const to = `${syncEndDate} ${syncEndTime || '23:59'}`;
      if (from > to) {
        setMessage({ type: 'danger', text: 'From date/time must be before or equal to the To date/time.' });
        return;
      }
    }

    setSyncing(true);
    setMessage(null);
    setDebugInfo(null);
    setLatestReport(null);
    setReportGenerationMissing(false);

    try {
      const result = await DashboardService.syncCampaignFromDatabase(
        campaign.id,
        syncStartDate || null,
        syncEndDate || null,
        selectedListIds,
        syncStartTime || null,
        syncEndTime || null,
        syncSheets,
        syncFullOutcomeHistory
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

          // The auto-report is generated synchronously as part of the sync
          // itself, so it already exists by the time we get here — surface
          // it right away instead of making the user go find it on Reports.
          // But generation can still silently fail/not run (e.g. the dev
          // server restarting mid-build) while the sync itself still shows
          // as successful, so don't just grab whatever report happens to be
          // newest for this campaign — confirm it was actually built from
          // *this* sync's file (parameters.source_file, set in
          // ReportViewSet._auto_generate_full_report) before offering it.
          // Otherwise a stale report from an earlier sync would silently be
          // shown as if it reflected this one.
          const reportsResult = await DashboardService.getReports(campaign.id);
          const candidate = reportsResult.success ? reportsResult.data?.[0] : null;
          if (candidate && candidate.parameters?.source_file === file.original_name) {
            setLatestReport(candidate);
          } else {
            setReportGenerationMissing(true);
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
          text: typeof result.error === 'object' ? JSON.stringify(result.error) : result.error
        });
      }
    } catch (error) {
      setMessage({
        type: 'danger',
        text: `Database sync error: ${error.message}`
      });
      console.error('❌ Database sync error details:', error);
    } finally {
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
        alert('Failed to download report');
      }
    } catch (err) {
      alert('Error downloading report');
    } finally {
      setDownloadingReport(false);
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
                    className="mt-3"
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
                </>
              )}

              {reportGenerationMissing && (
                <Alert variant="warning" className="mt-3 mb-0 py-2">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  Data synced, but the report didn't finish generating. Go to{' '}
                  <Link to={`/campaigns/${id}/reports`}>Reports</Link> to build it.
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
                            <i className="bi bi-asterisk me-2"></i>Clear (use campaign's full history)
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
                  Pick specific upload batches (e.g. "Absa Insurance 20260618") pulled live from the database,
                  use "Select all" to check every one individually, or leave it cleared for the campaign's full history.
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
                    const locked = (sheet.key === 'pivot' || sheet.key === 'lead_count') &&
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
                disabled={syncing || syncSheets.length === 0}
              >
                {syncing ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2"></span>
                    Pulling from database...
                  </>
                ) : (
                  <>
                    <i className="bi bi-arrow-repeat me-2"></i>
                    Sync from Database
                  </>
                )}
              </Button>
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