// src/pages/CampaignUpload.js - COMPLETE WORKING VERSION
import React, { useState, useEffect } from 'react';
import { 
  Card, Button, Alert, Spinner, ProgressBar,
  Form, Row, Col, Badge, Accordion, Table
} from 'react-bootstrap';
import { useParams, Link } from 'react-router-dom';
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

  useEffect(() => {
    fetchCampaign();
  }, [id]);

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
      <div className="page-header mb-4">
        <div className="d-flex align-items-center">
          <Link to={`/campaigns/${id}`} className="btn btn-outline-secondary me-3">
            <i className="bi bi-arrow-left"></i> Back
          </Link>
          <div>
            <h1 className="page-title mb-1">Upload Data - {campaign.display_name}</h1>
            <p className="text-muted mb-0">
              <Badge bg="info" className="me-2">Sheet: {campaign.sheet_name}</Badge>
              Upload campaign-specific data files
            </p>
          </div>
        </div>
      </div>

      {message && (
        <Alert variant={message.type} className="mb-3">
          <Alert.Heading>
            {message.type === 'success' ? '✅ Success!' : '❌ Error'}
          </Alert.Heading>
          <p>{message.text}</p>
          
          {debugInfo && (
            <div className="mt-3">
              <h6>📊 Processing Details:</h6>
              <Table striped bordered size="sm">
                <tbody>
                  <tr>
                    <td><strong>File Name:</strong></td>
                    <td>{debugInfo.fileName}</td>
                  </tr>
                  <tr>
                    <td><strong>File Size:</strong></td>
                    <td>{formatFileSize(debugInfo.fileSize)}</td>
                  </tr>
                  <tr>
                    <td><strong>Records in File:</strong></td>
                    <td>{debugInfo.totalRecords?.toLocaleString() || 'Unknown'}</td>
                  </tr>
                  <tr>
                    <td><strong>Records Processed:</strong></td>
                    <td>{debugInfo.processedRecords?.toLocaleString() || 'Unknown'}</td>
                  </tr>
                  <tr>
                    <td><strong>Status:</strong></td>
                    <td>
                      <Badge bg="success">
                        {debugInfo.message}
                      </Badge>
                    </td>
                  </tr>
                </tbody>
              </Table>
              
              {debugInfo.totalRecords && debugInfo.processedRecords && 
               debugInfo.processedRecords < debugInfo.totalRecords && (
                <Alert variant="warning" className="mt-2">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  <strong>Note:</strong> Only {debugInfo.processedRecords} out of {debugInfo.totalRecords} records 
                  were saved to the database.
                </Alert>
              )}
            </div>
          )}
        </Alert>
      )}

      <Card>
        <Card.Body>
          <div className="upload-instructions mb-4">
            <h5><i className="bi bi-info-circle text-primary me-2"></i>How It Works</h5>
            <ul>
              <li><strong>Upload</strong> your call data CSV/Excel file for this campaign</li>
              <li><strong>Processing</strong>: System reads "last_outcome" and matches with descriptions from database</li>
              <li><strong>Output</strong>: Adds a "Description" column after "last_outcome"</li>
              <li><strong>Database</strong>: Saves all records to database for reporting</li>
            </ul>
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
                          <td><Badge bg="success">Auto-added</Badge></td>
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
                  variant="success"
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