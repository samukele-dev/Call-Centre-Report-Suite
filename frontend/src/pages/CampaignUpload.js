// src/pages/CampaignUpload.js - COMPLETE WORKING VERSION
import React, { useState, useEffect } from 'react';
import {
  Card, Button, Alert, Spinner, ProgressBar,
  Form, Row, Col, Badge, Accordion, Table, Dropdown
} from 'react-bootstrap';
import { useParams, Link } from 'react-router-dom';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';

const CampaignUpload = () => {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [message, setMessage] = useState(null);
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeaders, setHasHeaders] = useState(true);
  const [debugInfo, setDebugInfo] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncStartTime, setSyncStartTime] = useState('');
  const [syncEndTime, setSyncEndTime] = useState('');
  const [latestReport, setLatestReport] = useState(null);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [sourceLists, setSourceLists] = useState([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState(null);
  const [selectedListIds, setSelectedListIds] = useState([]);

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

  const handleFileUpload = async (e) => {
    e.preventDefault();
    if (!file) {
      alert('Please select a file');
      return;
    }

    setUploading(true);
    setUploadProgress(10);
    setMessage(null);
    setDebugInfo(null);

    const interval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 90) {
          clearInterval(interval);
          return prev;
        }
        return prev + 10;
      });
    }, 300);

    try {
      const result = await DashboardService.uploadCallDataFile(
        file,
        campaign.id,
        delimiter,
        hasHeaders
      );

      clearInterval(interval);
      setUploadProgress(100);

      if (result.success) {
        setMessage({
          type: 'success',
          text: `File uploaded successfully for ${campaign.display_name}! Processing has started.`
        });

        setDebugInfo({
          fileName: file.name,
          fileSize: file.size,
          totalRecords: result.data.total_records || 0,
          processedRecords: result.data.processed_records || 0,
          message: result.data.message || 'Processing completed'
        });
        
        setTimeout(() => {
          setUploading(false);
          setUploadProgress(0);
          setFile(null);
          const fileInput = document.getElementById('campaignFile');
          if (fileInput) fileInput.value = '';
        }, 2000);
      } else {
        setMessage({
          type: 'danger',
          text: `Upload failed: ${typeof result.error === 'object' ? JSON.stringify(result.error) : result.error}`
        });
        setUploading(false);
        setUploadProgress(0);
      }
    } catch (error) {
      clearInterval(interval);
      setMessage({
        type: 'danger',
        text: `Upload error: ${error.message}`
      });
      console.error('❌ Upload error details:', error);
      setUploading(false);
      setUploadProgress(0);
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

    try {
      const result = await DashboardService.syncCampaignFromDatabase(
        campaign.id,
        syncStartDate || null,
        syncEndDate || null,
        selectedListIds,
        syncStartTime || null,
        syncEndTime || null
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
          const reportsResult = await DashboardService.getReports(campaign.id);
          if (reportsResult.success && reportsResult.data?.length > 0) {
            setLatestReport(reportsResult.data[0]);
          }
        }
      } else {
        setMessage({
          type: 'danger',
          text: `Database sync failed: ${typeof result.error === 'object' ? JSON.stringify(result.error) : result.error}`
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

  const isCSVFile = (fileName) => {
    return fileName?.toLowerCase().endsWith('.csv');
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
                had) and processes it the same way an uploaded file would be.
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

              <Button
                variant="primary"
                size="lg"
                onClick={handleSyncFromDatabase}
                disabled={syncing || uploading}
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

      <Card className="section-card">
        <Card.Header>
          <div className="section-card-title">
            <span className="section-card-icon section-card-icon-neutral"><i className="bi bi-upload"></i></span>
            <div>
              <h5 className="mb-0">Upload a File</h5>
              <span className="section-card-subtitle">CSV or Excel, processed the same way as a database sync</span>
            </div>
          </div>
        </Card.Header>
        <Card.Body>
          <div className="upload-steps mb-4">
            <div className="upload-step">
              <span className="upload-step-num">1</span>
              <span>Upload your file</span>
            </div>
            <div className="upload-step">
              <span className="upload-step-num">2</span>
              <span>Match outcomes to descriptions</span>
            </div>
            <div className="upload-step">
              <span className="upload-step-num">3</span>
              <span>Add a Description column</span>
            </div>
            <div className="upload-step">
              <span className="upload-step-num">4</span>
              <span>Save &amp; generate report</span>
            </div>
          </div>

          <form onSubmit={handleFileUpload}>
            <Form.Group className="mb-3">
              <Form.Label>Select File for {campaign.display_name}</Form.Label>
              <Form.Control
                type="file"
                id="campaignFile"
                accept=".csv,.xlsx,.xls"
                onChange={(e) => {
                  const selectedFile = e.target.files[0];
                  setFile(selectedFile);
                  if (selectedFile && isCSVFile(selectedFile.name)) {
                    setDelimiter(',');
                  }
                }}
                disabled={uploading}
              />
              <Form.Text className="text-muted">
                Upload CSV or Excel files for this campaign
              </Form.Text>
            </Form.Group>

            <Accordion className="mb-3">
              <Accordion.Item eventKey="0">
                <Accordion.Header>
                  <i className="bi bi-list-columns me-2"></i>
                  Expected File Format
                </Accordion.Header>
                <Accordion.Body>
                  <p>Your file must have a <code>last_outcome</code> column:</p>
                  <div className="table-responsive">
                    <Table striped bordered size="sm">
                      <thead>
                        <tr>
                          <th>Column Name</th>
                          <th>Required</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td><code>contact_id</code></td>
                          <td><Badge bg="danger">Required</Badge></td>
                          <td>Unique identifier for each contact</td>
                        </tr>
                        <tr>
                          <td><code>last_outcome</code></td>
                          <td><Badge bg="danger">Required</Badge></td>
                          <td>Abbreviations like "CB", "SALE", "AM"</td>
                        </tr>
                        <tr>
                          <td><code>Description</code></td>
                          <td><Badge bg="info">Auto-added</Badge></td>
                          <td>Will be added automatically after processing</td>
                        </tr>
                      </tbody>
                    </Table>
                  </div>
                </Accordion.Body>
              </Accordion.Item>
            </Accordion>

            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Delimiter (for CSV)</Form.Label>
                  <Form.Select
                    value={delimiter}
                    onChange={(e) => setDelimiter(e.target.value)}
                    disabled={uploading}
                  >
                    <option value=",">Comma (,) - Standard CSV</option>
                    <option value=";">Semicolon (;)</option>
                    <option value="\t">Tab (\t) - TSV files</option>
                    <option value="|">Pipe (|)</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>First Row Headers</Form.Label>
                  <Form.Check
                    type="switch"
                    id="headers-switch"
                    label={hasHeaders ? "Yes, first row has column names" : "No, first row is data"}
                    checked={hasHeaders}
                    onChange={(e) => setHasHeaders(e.target.checked)}
                    disabled={uploading}
                  />
                </Form.Group>
              </Col>
            </Row>

            {uploading && (
              <div className="mb-3">
                <div className="d-flex justify-content-between mb-1">
                  <small>
                    <i className="bi bi-hourglass-split me-1"></i>
                    Uploading and processing...
                  </small>
                  <small>{uploadProgress}%</small>
                </div>
                <ProgressBar
                  now={uploadProgress}
                  animated
                  variant="primary"
                />
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={uploading || !file}
              className="w-100"
            >
              {uploading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2"></span>
                  Processing File...
                </>
              ) : (
                <>
                  <i className="bi bi-upload me-2"></i>
                  Upload & Process File
                </>
              )}
            </Button>
          </form>
        </Card.Body>
      </Card>
    </div>
  );
};

export default CampaignUpload;