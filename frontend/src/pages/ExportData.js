// src/pages/ExportData.js
import React, { useState, useEffect } from 'react';
import { Card, Spinner, Button, Form, Alert, Row, Col, Badge } from 'react-bootstrap';
import DashboardService from '../api/dashboardService';

const ExportData = () => {
  // ========== STATE ==========
  const [campaigns, setCampaigns] = useState([]);  // <-- THIS WAS MISSING!
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [campaignId, setCampaignId] = useState('');
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState('');
  
  // Sync from database states
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [listIds, setListIds] = useState([]);
  const [sourceLists, setSourceLists] = useState([]);
  const [selectAll, setSelectAll] = useState(false);

  // Export states
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [previewData, setPreviewData] = useState([]);  // <-- RENAMED from exportData
  const [showPreview, setShowPreview] = useState(false);

  // Upload states
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);

  // ========== EFFECTS ==========
  useEffect(() => {
    fetchCampaigns();
  }, []);

  useEffect(() => {
    if (campaignId) {
      fetchFiles(campaignId);
      fetchSourceLists(campaignId);
    } else {
      setFiles([]);
      setSourceLists([]);
    }
  }, [campaignId]);

  // ========== API CALLS ==========
  const fetchCampaigns = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await DashboardService.getCampaigns();
      if (result.success) {
        setCampaigns(result.data || []);
        if (result.data && result.data.length > 0) {
          // Auto-select first campaign
          setCampaignId(result.data[0].id);
          setSelectedCampaign(result.data[0]);
        }
      } else {
        setError('Failed to load campaigns');
      }
    } catch (err) {
      setError('Error loading campaigns');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchFiles = async (id) => {
    try {
      const result = await DashboardService.getUploadedFiles(id);
      if (result.success) {
        setFiles(result.data || []);
        // Auto-select the latest processed file
        const processed = result.data.filter(f => f.status === 'processed');
        if (processed.length > 0) {
          setSelectedFile(processed[0].id);
        }
      }
    } catch (err) {
      console.error('Error loading files:', err);
    }
  };

  const fetchSourceLists = async (id) => {
    try {
      const result = await DashboardService.getCampaignSourceLists(id);
      if (result.success) {
        setSourceLists(result.data || []);
      }
    } catch (err) {
      console.error('Error loading source lists:', err);
    }
  };

  // ========== HANDLERS ==========
  const handleCampaignChange = (e) => {
    const id = e.target.value;
    setCampaignId(id);
    setSelectedCampaign(campaigns.find(c => c.id === parseInt(id)));
    setSelectedFile('');
    setShowPreview(false);
    setPreviewData([]);
    setListIds([]);
    setSelectAll(false);
  };

  const handleSelectAll = () => {
    const newSelectAll = !selectAll;
    setSelectAll(newSelectAll);
    if (newSelectAll) {
      setListIds(sourceLists.map(list => list.id));
    } else {
      setListIds([]);
    }
  };

  const handleListToggle = (listId) => {
    setListIds(prev => {
      if (prev.includes(listId)) {
        return prev.filter(id => id !== listId);
      } else {
        return [...prev, listId];
      }
    });
    setSelectAll(false);
  };

  // ============================================================
  // SYNC FROM DATABASE
  // ============================================================
  const handleSyncFromDatabase = async () => {
    if (!campaignId) {
      setError('Please select a campaign first');
      return;
    }

    setSyncing(true);
    setSyncMessage(null);
    setError(null);

    try {
      const result = await DashboardService.syncCampaignFromDatabase(
        campaignId,
        startDate || null,
        endDate || null,
        listIds.length > 0 ? listIds : null,
        startDate ? startTime : null,
        endDate ? endTime : null
      );

      if (result.success) {
        setSyncMessage({
          type: 'success',
          text: 'Database sync completed successfully! Data is ready for export.'
        });
        await fetchFiles(campaignId);
        setTimeout(() => setSyncMessage(null), 8000);
      } else {
        setError(result.error || 'Database sync failed');
      }
    } catch (err) {
      setError(err.message || 'Database sync failed');
      console.error(err);
    } finally {
      setSyncing(false);
    }
  };

  // ============================================================
  // UPLOAD FILE
  // ============================================================
  const handleFileUpload = async () => {
    if (!campaignId) {
      setError('Please select a campaign first');
      return;
    }
    if (!uploadFile) {
      setError('Please select a file to upload');
      return;
    }

    setUploading(true);
    setError(null);
    setSyncMessage(null);

    try {
      const result = await DashboardService.uploadCallDataFile(
        uploadFile,
        campaignId,
        ',',
        true
      );

      if (result.success) {
        setSyncMessage({
          type: 'success',
          text: 'File uploaded and processed successfully! Data is ready for export.'
        });
        setUploadFile(null);
        document.getElementById('fileInput').value = '';
        await fetchFiles(campaignId);
        setTimeout(() => setSyncMessage(null), 8000);
      } else {
        setError(result.error || 'File upload failed');
      }
    } catch (err) {
      setError(err.message || 'File upload failed');
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  // ============================================================
  // EXPORT DATA
  // ============================================================
  const handleExport = async () => {
    if (!campaignId && !selectedFile) {
      setError('Please select a campaign or a specific file to export');
      return;
    }

    setExporting(true);
    setError(null);
    setSuccess(null);

    try {
      let result;
      if (selectedFile) {
        result = await DashboardService.exportFormattedData(null, selectedFile);
      } else {
        result = await DashboardService.exportFormattedData(campaignId, null);
      }
      
      if (result.success) {
        const url = window.URL.createObjectURL(result.data);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.filename || 'export_data.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        setSuccess(`Export successful! File downloaded as ${result.filename}`);
        setTimeout(() => setSuccess(null), 5000);
      } else {
        setError(result.error || 'Export failed');
      }
    } catch (err) {
      setError(err.message || 'Export failed');
      console.error(err);
    } finally {
      setExporting(false);
    }
  };

  // ============================================================
  // PREVIEW DATA
  // ============================================================
  const handlePreview = async () => {
    if (!selectedFile && !campaignId) {
      setError('Please select a campaign or file to preview');
      return;
    }

    setLoading(true);
    setError(null);
    setShowPreview(true);

    try {
      let result;
      if (selectedFile) {
        result = await DashboardService.getFilePreview(selectedFile);
      } else if (campaignId) {
        const filesResult = await DashboardService.getUploadedFiles(campaignId);
        if (filesResult.success && filesResult.data.length > 0) {
          const processed = filesResult.data.filter(f => f.status === 'processed');
          if (processed.length > 0) {
            result = await DashboardService.getFilePreview(processed[0].id);
          } else {
            setError('No processed files found for this campaign');
            setShowPreview(false);
            setLoading(false);
            return;
          }
        } else {
          setError('No files found for this campaign');
          setShowPreview(false);
          setLoading(false);
          return;
        }
      }

      if (result && result.success) {
        setPreviewData(result.data?.data || []);
      } else {
        setError(result?.error || 'Failed to preview data');
        setShowPreview(false);
      }
    } catch (err) {
      setError(err.message || 'Failed to preview data');
      setShowPreview(false);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return 'N/A';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // ========== RENDER ==========
  if (loading && campaigns.length === 0) {
    return (
      <div className="loading-container">
        <Spinner animation="border" variant="primary" />
        <p className="loading-text mt-3">Loading campaigns...</p>
      </div>
    );
  }

  const selectedCampaignData = campaigns.find(c => c.id === parseInt(campaignId));

  return (
    <div className="export-data-container">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 className="page-title">Export Data</h1>
          <p className="text-muted">Export processed data in formatted Excel with custom columns</p>
        </div>
        <Badge bg="info" className="fs-6 p-3">
          <i className="bi bi-database me-1"></i>
          {campaigns.length} Campaigns
        </Badge>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="danger" className="mb-3" onClose={() => setError(null)} dismissible>
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      {/* Success Alert */}
      {success && (
        <Alert variant="success" className="mb-3" onClose={() => setSuccess(null)} dismissible>
          <i className="bi bi-check-circle-fill me-2"></i>
          {success}
        </Alert>
      )}

      {/* Sync Message Alert */}
      {syncMessage && (
        <Alert variant="success" className="mb-3" onClose={() => setSyncMessage(null)} dismissible>
          <i className="bi bi-check-circle-fill me-2"></i>
          {syncMessage.text}
        </Alert>
      )}

      {/* Campaign Selector */}
      <Card className="mb-4">
        <Card.Header>
          <Card.Title>Select Campaign</Card.Title>
        </Card.Header>
        <Card.Body>
          <Form.Group>
            <Form.Label>Campaign</Form.Label>
            <Form.Select
              value={campaignId}
              onChange={handleCampaignChange}
            >
              <option value="">-- Select a campaign --</option>
              {campaigns.map(campaign => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.display_name} ({campaign.data_files_count || 0} files)
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          {selectedCampaignData && (
            <div className="mt-2 text-muted small">
              <i className="bi bi-info-circle me-1"></i>
              Campaign ID: {selectedCampaignData.id} | 
              Sheet: {selectedCampaignData.sheet_name || 'N/A'}
              {selectedCampaignData.cd_campaign_id && (
                <span className="ms-2 text-success">✓ Linked to source DB</span>
              )}
            </div>
          )}
        </Card.Body>
      </Card>

      <Row>
        <Col md={6}>
          {/* Sync from Database */}
          <Card className="h-100">
            <Card.Header>
              <Card.Title>Sync from Database</Card.Title>
              <small className="text-muted">Pull directly from the call-centre platform</small>
            </Card.Header>
            <Card.Body>
              <p className="text-muted small">
                Pulls call data straight from the call-centre database and processes it the same way an uploaded file would.
              </p>

              {/* Batch Selection */}
              {sourceLists.length > 0 && (
                <Form.Group className="mb-3">
                  <Form.Label>Batch(es) (optional)</Form.Label>
                  <Form.Text className="text-muted d-block mb-2">
                    Pick specific upload batches pulled live from the database.
                  </Form.Text>
                  <div className="batch-select-container" style={{ maxHeight: '150px', overflowY: 'auto', border: '1px solid #dee2e6', borderRadius: '4px', padding: '8px' }}>
                    <Form.Check
                      type="checkbox"
                      label="Select All"
                      checked={selectAll}
                      onChange={handleSelectAll}
                      className="mb-2"
                    />
                    {sourceLists.map(list => (
                      <Form.Check
                        key={list.id}
                        type="checkbox"
                        label={`${list.name} (${list.status || 'N/A'})`}
                        checked={listIds.includes(list.id)}
                        onChange={() => handleListToggle(list.id)}
                      />
                    ))}
                  </div>
                </Form.Group>
              )}

              {/* Date Range */}
              <Row className="mb-3">
                <Col xs={6}>
                  <Form.Group>
                    <Form.Label>From (optional)</Form.Label>
                    <Form.Control
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col xs={6}>
                  <Form.Group>
                    <Form.Label>Time (optional)</Form.Label>
                    <Form.Control
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      disabled={!startDate}
                    />
                  </Form.Group>
                </Col>
              </Row>

              <Row className="mb-3">
                <Col xs={6}>
                  <Form.Group>
                    <Form.Label>To (optional)</Form.Label>
                    <Form.Control
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </Form.Group>
                </Col>
                <Col xs={6}>
                  <Form.Group>
                    <Form.Label>Time (optional)</Form.Label>
                    <Form.Control
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      disabled={!endDate}
                    />
                  </Form.Group>
                </Col>
              </Row>

              <Form.Text className="text-muted d-block mb-3">
                Filters by interaction date (when the call happened). Time is optional. Leave everything blank for no date limit.
              </Form.Text>

              <Button
                variant="primary"
                onClick={handleSyncFromDatabase}
                disabled={syncing || !campaignId}
                className="w-100"
              >
                {syncing ? (
                  <>
                    <Spinner animation="border" size="sm" className="me-2" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <i className="bi bi-cloud-download me-2"></i>
                    Sync from Database
                  </>
                )}
              </Button>
            </Card.Body>
          </Card>
        </Col>

        <Col md={6}>
          {/* Upload File */}
          <Card className="h-100">
            <Card.Header>
              <Card.Title>Upload a File</Card.Title>
              <small className="text-muted">CSV or Excel</small>
            </Card.Header>
            <Card.Body>
              <p className="text-muted small">
                Upload a CSV or Excel file with call data. It will be processed the same way as a database sync.
              </p>

              <Form.Group className="mb-3">
                <Form.Label>Choose File</Form.Label>
                <Form.Control
                  id="fileInput"
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => setUploadFile(e.target.files[0])}
                />
                {uploadFile && (
                  <Form.Text className="text-success">
                    Selected: {uploadFile.name} ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                  </Form.Text>
                )}
              </Form.Group>

              <Button
                variant="success"
                onClick={handleFileUpload}
                disabled={uploading || !uploadFile || !campaignId}
                className="w-100"
              >
                {uploading ? (
                  <>
                    <Spinner animation="border" size="sm" className="me-2" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <i className="bi bi-upload me-2"></i>
                    Upload & Process
                  </>
                )}
              </Button>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Files List & Export */}
      <Card className="mt-4">
        <Card.Header>
          <Card.Title>Processed Files</Card.Title>
        </Card.Header>
        <Card.Body>
          {files.length === 0 ? (
            <div className="text-center py-4">
              <i className="bi bi-inbox text-muted" style={{ fontSize: '3rem' }}></i>
              <p className="text-muted mt-2">No processed files found for this campaign</p>
              <p className="text-muted small">Sync from database or upload a file above</p>
            </div>
          ) : (
            <>
              <Form.Group className="mb-3">
                <Form.Label>Select File to Export</Form.Label>
                <Form.Select
                  value={selectedFile}
                  onChange={(e) => setSelectedFile(e.target.value)}
                >
                  <option value="">-- Select a file --</option>
                  {files.filter(f => f.status === 'processed').map(file => (
                    <option key={file.id} value={file.id}>
                      {file.original_name} ({file.total_records || 0} records, {formatFileSize(file.file_size)})
                    </option>
                  ))}
                  {files.filter(f => f.status !== 'processed').map(file => (
                    <option key={file.id} value={file.id} disabled>
                      {file.original_name} - {file.status} ({file.total_records || 0} records)
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>

              <div className="d-flex gap-2 flex-wrap">
                <Button
                  variant="info"
                  onClick={handlePreview}
                  disabled={!selectedFile && !campaignId}
                >
                  <i className="bi bi-eye me-2"></i>
                  Preview
                </Button>
                <Button
                  variant="primary"
                  onClick={handleExport}
                  disabled={exporting || (!selectedFile && !campaignId)}
                >
                  {exporting ? (
                    <>
                      <Spinner animation="border" size="sm" className="me-2" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-download me-2"></i>
                      Export to Excel
                    </>
                  )}
                </Button>
                <Button
                  variant="success"
                  onClick={handleExport}
                  disabled={exporting || !selectedFile}
                >
                  <i className="bi bi-file-earmark-excel me-2"></i>
                  Download Selected
                </Button>
              </div>
            </>
          )}
        </Card.Body>
      </Card>

      {/* Preview Section */}
      {showPreview && previewData.length > 0 && (
        <Card className="mt-4">
          <Card.Header className="d-flex justify-content-between align-items-center">
            <Card.Title>Data Preview</Card.Title>
            <Button variant="secondary" size="sm" onClick={() => setShowPreview(false)}>
              <i className="bi bi-x-lg"></i>
            </Button>
          </Card.Header>
          <Card.Body>
            <div className="table-responsive" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <table className="table table-striped table-hover table-sm">
                <thead className="sticky-top bg-white">
                  <tr>
                    {previewData.length > 0 && Object.keys(previewData[0]).map(col => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.slice(0, 50).map((row, idx) => (
                    <tr key={idx}>
                      {Object.values(row).map((val, i) => (
                        <td key={i}>{val || '-'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewData.length > 50 && (
              <p className="text-muted mt-2">Showing first 50 of {previewData.length} records</p>
            )}
          </Card.Body>
        </Card>
      )}

      {/* Export Format Preview */}
      <Card className="mt-4">
        <Card.Header>
          <Card.Title>Export Format Preview</Card.Title>
        </Card.Header>
        <Card.Body>
          <p className="text-muted">The exported Excel file will contain the following columns:</p>
          <div className="export-columns-grid">
            <div className="column-tag">firstname</div>
            <div className="column-tag">lastname</div>
            <div className="column-tag">contact_id</div>
            <div className="column-tag">Client ID number</div>
            <div className="column-tag">Contact</div>
            <div className="column-tag">Right party contact</div>
            <div className="column-tag">Presentation</div>
            <div className="column-tag">Sale</div>
            <div className="column-tag">Policy number</div>
            <div className="column-tag">Disposition</div>
            <div className="column-tag">Call attempts</div>
            <div className="column-tag">Campaign</div>
            <div className="column-tag">FICA Reference</div>
            <div className="column-tag">Contact Number</div>
            <div className="column-tag">IMEI</div>
            <div className="column-tag">Agent Name</div>
            <div className="column-tag">LastCall Date</div>
            <div className="column-tag">batch</div>
            <div className="column-tag">Product Sold</div>
          </div>
        </Card.Body>
      </Card>

      {/* Quick Stats */}
      {selectedCampaignData && files.length > 0 && (
        <Card className="mt-4">
          <Card.Header>
            <Card.Title>Campaign Summary</Card.Title>
          </Card.Header>
          <Card.Body>
            <div className="stat-tile-row">
              <div className="stat-tile-small">
                <span className="stat-tile-label">Total Files</span>
                <span className="stat-tile-value">{files.length}</span>
              </div>
              <div className="stat-tile-small">
                <span className="stat-tile-label">Processed Files</span>
                <span className="stat-tile-value">
                  {files.filter(f => f.status === 'processed').length}
                </span>
              </div>
              <div className="stat-tile-small">
                <span className="stat-tile-label">Total Records</span>
                <span className="stat-tile-value">
                  {files.reduce((sum, f) => sum + (f.total_records || 0), 0).toLocaleString()}
                </span>
              </div>
            </div>
          </Card.Body>
        </Card>
      )}
    </div>
  );
};

export default ExportData;