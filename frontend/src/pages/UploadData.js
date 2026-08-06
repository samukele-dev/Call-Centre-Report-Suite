// src/pages/UploadData.js - UPDATED WITH DEBUGGING
import React, { useState, useEffect } from 'react';
import { 
  Card, Button, Alert, Spinner, ProgressBar,
  Table, Badge, Row, Col, Tabs, Tab, Form,
  Accordion
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const UploadData = () => {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [previewData, setPreviewData] = useState(null);
  const [activeTab, setActiveTab] = useState('upload');
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeaders, setHasHeaders] = useState(true);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);

  useEffect(() => {
    fetchUploadedFiles();
  }, []);

  const fetchUploadedFiles = async () => {
    setLoading(true);
    try {
      const result = await DashboardService.getUploadedFiles();
      
      console.log('📁 Uploaded files result:', result);
      
      if (result.success) {
        if (Array.isArray(result.data)) {
          setUploadedFiles(result.data);
        } else {
          console.warn('⚠️ Expected array but got:', result.data);
          setUploadedFiles([]);
        }
      } else {
        console.error('❌ Failed to fetch files:', result.error);
        setUploadedFiles([]);
      }
    } catch (error) {
      console.error('❌ Error fetching files:', error);
      setUploadedFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e) => {
    e.preventDefault();
    setUploadMessage(null);
    setDebugInfo(null);
    
    const fileInput = document.getElementById('callDataFile');
    const file = fileInput?.files?.[0];
    
    if (!file) {
      alert('Please select a file to upload');
      return;
    }
    
    // Check file extension
    const validExtensions = /\.(csv|xlsx|xls)$/i;
    if (!file.name.match(validExtensions)) {
      alert('Please select a CSV or Excel file (.csv, .xlsx, or .xls)');
      return;
    }
    
    setUploading(true);
    setUploadProgress(10);
    
    // Simulate progress
    const progressInterval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return prev;
        }
        return prev + 10;
      });
    }, 300);
    
    try {
      console.log('📤 Uploading file:', file.name, 'Size:', file.size, 'Type:', file.type);
      
      const result = await DashboardService.uploadCallDataFile(file, delimiter, hasHeaders);
      
      clearInterval(progressInterval);
      setUploadProgress(100);
      
      console.log('📦 Upload result:', result);
      
      if (result.success) {
        setUploadMessage({
          type: 'success',
          text: 'File uploaded successfully! Processing has started.',
          details: result.data
        });
        
        // Set debug info
        setDebugInfo({
          fileName: file.name,
          fileSize: file.size,
          totalRecords: result.data.total_records || 0,
          processedRecords: result.data.processed_records || 0,
          message: result.data.message || 'Processing completed'
        });
        
        fetchUploadedFiles();
        setTimeout(() => {
          setUploading(false);
          setUploadProgress(0);
          if (fileInput) fileInput.value = '';
        }, 2000);
      } else {
        setUploadMessage({
          type: 'danger',
          text: `Upload failed: ${typeof result.error === 'object' ? JSON.stringify(result.error) : result.error}`
        });
        setUploading(false);
        setUploadProgress(0);
      }
    } catch (error) {
      clearInterval(progressInterval);
      setUploadMessage({
        type: 'danger',
        text: `Upload error: ${error.message}`
      });
      console.error('❌ Upload error details:', error);
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handlePreview = async (fileId) => {
    const result = await DashboardService.getFilePreview(fileId);
    
    console.log('👁️ Preview result:', result);
    
    if (result.success) {
      setPreviewData(result.data);
      setActiveTab('preview');
    } else {
      alert(`Failed to load preview: ${typeof result.error === 'object' ? JSON.stringify(result.error) : result.error}`);
    }
  };

  const handleDownload = async (fileId, fileName) => {
    const result = await DashboardService.downloadProcessedFile(fileId);
    
    if (result.success && result.data) {
      const originalExt = fileName?.split('.').pop()?.toLowerCase() || 'xlsx';
      const downloadName = originalExt === 'csv' 
        ? `processed_${fileName.replace('.csv', '.xlsx')}`
        : `processed_${fileName || 'file.xlsx'}`;
      
      const blob = new Blob([result.data], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      saveAs(blob, downloadName);
    } else {
      alert('Failed to download file');
    }
  };

  const getStatusBadge = (status) => {
    const statusConfig = {
      'uploaded': { variant: 'secondary', text: 'Uploaded' },
      'processing': { variant: 'warning', text: 'Processing' },
      'processed': { variant: 'success', text: 'Processed' },
      'failed': { variant: 'danger', text: 'Failed' }
    };
    
    const config = statusConfig[status] || { variant: 'secondary', text: 'Unknown' };
    
    return <Badge bg={config.variant}>{config.text}</Badge>;
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

  return (
    <div className="upload-data">
      <div className="page-header">
        <h1 className="page-title">Upload Call Data</h1>
        <p className="page-subtitle">
          Upload File 2 (Call Data CSV/Excel) - The system will add "Description" column
        </p>
      </div>

      {uploadMessage && (
        <Alert variant={uploadMessage.type} className="mb-3">
          <Alert.Heading>
            {uploadMessage.type === 'success' ? '✅ Success!' : '❌ Error'}
          </Alert.Heading>
          <p>{uploadMessage.text}</p>
          
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
                  were saved to the database. This might be due to data validation issues or duplicate records.
                </Alert>
              )}
            </div>
          )}
        </Alert>
      )}

      <Tabs
        activeKey={activeTab}
        onSelect={(k) => setActiveTab(k)}
        className="mb-4"
      >
        <Tab eventKey="upload" title="Upload File">
          <Card>
            <Card.Body>
              <div className="upload-instructions mb-4">
                <h5><i className="bi bi-info-circle text-primary me-2"></i>How It Works</h5>
                <ul>
                  <li><strong>Upload</strong> your call data CSV/Excel file</li>
                  <li><strong>Processing</strong>: System reads "last_outcome" and matches with descriptions</li>
                  <li><strong>Output</strong>: Adds a "Description" column after "last_outcome"</li>
                  <li><strong>Database</strong>: Saves all records to database for reporting</li>
                </ul>
              </div>
              
              <form onSubmit={handleFileUpload}>
                <div className="mb-3">
                  <label htmlFor="callDataFile" className="form-label">
                    <i className="bi bi-file-earmark-arrow-up me-2"></i>
                    Select Call Data File (CSV or Excel)
                  </label>
                  <input
                    className="form-control form-control-lg"
                    type="file"
                    id="callDataFile"
                    accept=".csv,.xlsx,.xls"
                    required
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file && isCSVFile(file.name)) {
                        setDelimiter(',');
                      }
                    }}
                  />
                  <Form.Text className="text-muted">
                    Supports CSV (.csv), Excel (.xlsx, .xls)
                  </Form.Text>
                </div>

                {/* File Format Information */}
                <Accordion className="mb-3">
                  <Accordion.Item eventKey="0">
                    <Accordion.Header>
                      <i className="bi bi-list-columns me-2"></i>
                      Expected File Format
                    </Accordion.Header>
                    <Accordion.Body>
                      <p>Your file must have a <code>last_outcome</code> column. Other columns are optional:</p>
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

                {/* CSV Options */}
                <div className="csv-options mb-3">
                  <h6><i className="bi bi-gear me-2"></i>CSV Options (if applicable):</h6>
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Delimiter (Separator)</Form.Label>
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
                        <Form.Label>First Row Contains Headers</Form.Label>
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
                </div>
                
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
                    <small className="text-muted d-block mt-1">
                      Processing large files may take a moment. Please don't close this page.
                    </small>
                  </div>
                )}
                
                <div className="d-grid gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    disabled={uploading}
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
                </div>
              </form>
            </Card.Body>
          </Card>
        </Tab>
        
        <Tab eventKey="files" title="Uploaded Files">
          <Card>
            <Card.Header>
              <div className="d-flex justify-content-between align-items-center">
                <h5 className="mb-0">
                  <i className="bi bi-folder me-2"></i>
                  Uploaded Files ({uploadedFiles?.length || 0})
                </h5>
                <div>
                  <Button
                    variant="outline-secondary"
                    size="sm"
                    onClick={fetchUploadedFiles}
                    disabled={loading}
                  >
                    <i className="bi bi-arrow-clockwise"></i> Refresh
                  </Button>
                </div>
              </div>
            </Card.Header>
            <Card.Body>
              {loading ? (
                <div className="text-center py-5">
                  <Spinner animation="border" role="status">
                    <span className="visually-hidden">Loading...</span>
                  </Spinner>
                </div>
              ) : !uploadedFiles || uploadedFiles.length === 0 ? (
                <div className="text-center py-5">
                  <i className="bi bi-cloud-upload" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
                  <h5 className="mt-3">No files uploaded yet</h5>
                  <Button 
                    variant="outline-primary"
                    onClick={() => setActiveTab('upload')}
                  >
                    <i className="bi bi-upload me-1"></i>
                    Go to Upload
                  </Button>
                </div>
              ) : (
                <>
                  <div className="table-responsive">
                    <Table hover>
                      <thead>
                        <tr>
                          <th>File Name</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Size</th>
                          <th>Records</th>
                          <th>Uploaded</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uploadedFiles.map((file) => (
                          <tr key={file.id}>
                            <td>
                              <div>
                                <strong>
                                  <i className={`bi ${isCSVFile(file.original_name) ? 'bi-filetype-csv text-primary' : 'bi-filetype-xlsx text-success'} me-2`}></i>
                                  {file.original_name || 'Unnamed File'}
                                </strong>
                                {file.status === 'processed' && (
                                  <div>
                                    <small className="text-success">
                                      <i className="bi bi-check-circle me-1"></i>
                                      Ready for reporting
                                    </small>
                                    {file.total_records > 0 && file.processed_records > 0 && 
                                     file.processed_records < file.total_records && (
                                      <div>
                                        <small className="text-warning">
                                          <i className="bi bi-exclamation-triangle me-1"></i>
                                          Only {file.processed_records} of {file.total_records} saved to DB
                                        </small>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td>
                              <Badge bg={isCSVFile(file.original_name) ? 'primary' : 'success'}>
                                {isCSVFile(file.original_name) ? 'CSV' : 'Excel'}
                              </Badge>
                            </td>
                            <td>{getStatusBadge(file.status)}</td>
                            <td>{formatFileSize(file.file_size)}</td>
                            <td>
                              {file.total_records > 0 ? (
                                <span className="badge bg-info">
                                  {file.total_records.toLocaleString()} rows
                                  {file.processed_records > 0 && file.processed_records !== file.total_records && (
                                    <span> ({file.processed_records} in DB)</span>
                                  )}
                                </span>
                              ) : (
                                '-'
                              )}
                            </td>
                            <td>
                              <small>
                                {file.uploaded_at ? new Date(file.uploaded_at).toLocaleDateString() : 'N/A'}
                                <br />
                                {file.uploaded_at ? new Date(file.uploaded_at).toLocaleTimeString() : ''}
                              </small>
                            </td>
                            <td>
                              <div className="action-buttons">
                                <Button
                                  variant="outline-info"
                                  size="sm"
                                  className="me-2 mb-1"
                                  onClick={() => handlePreview(file.id)}
                                  disabled={file.status !== 'processed'}
                                  title="Preview data"
                                >
                                  <i className="bi bi-eye"></i> Preview
                                </Button>
                                
                                <Button
                                  variant="outline-success"
                                  size="sm"
                                  className="mb-1"
                                  onClick={() => handleDownload(file.id, file.original_name)}
                                  disabled={file.status !== 'processed'}
                                  title="Download processed file"
                                >
                                  <i className="bi bi-download"></i> Download
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </>
              )}
            </Card.Body>
          </Card>
        </Tab>
        
        <Tab eventKey="preview" title="Data Preview" disabled={!previewData}>
          {previewData && (
            <Card>
              <Card.Header>
                <div className="d-flex justify-content-between align-items-center">
                  <h5 className="mb-0">
                    <i className="bi bi-eye me-2"></i>
                    Processed Data Preview
                  </h5>
                  <div>
                    <Button
                      variant="outline-primary"
                      size="sm"
                      onClick={() => setActiveTab('files')}
                      className="me-2"
                    >
                      <i className="bi bi-arrow-left me-1"></i>
                      Back to Files
                    </Button>
                  </div>
                </div>
              </Card.Header>
              <Card.Body>
                {previewData.columns && previewData.columns.includes('Description') && (
                  <Alert variant="success" className="mb-3">
                    <div className="d-flex align-items-center">
                      <i className="bi bi-check-circle-fill me-2" style={{ fontSize: '1.2rem' }}></i>
                      <div>
                        <strong>Success!</strong> The system has added the <code>Description</code> column.
                      </div>
                    </div>
                  </Alert>
                )}
                
                <div className="table-responsive" style={{ maxHeight: '500px', overflowY: 'auto' }}>
                  <Table striped bordered hover size="sm" className="mb-0">
                    <thead style={{ position: 'sticky', top: 0, backgroundColor: 'white', zIndex: 1 }}>
                      <tr>
                        {previewData.columns?.map((col, index) => (
                          <th key={index} className={col === 'Description' ? 'table-success' : ''}>
                            {col === 'Description' ? (
                              <>
                                <i className="bi bi-plus-circle-fill text-success me-1"></i>
                                {col}
                              </>
                            ) : (
                              col
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.data?.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {previewData.columns?.map((col, colIndex) => (
                            <td key={colIndex} className={col === 'Description' ? 'bg-light' : ''}>
                              {row[col] !== null && row[col] !== undefined ? String(row[col]) : ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Card.Body>
            </Card>
          )}
        </Tab>
      </Tabs>
    </div>
  );
};

export default UploadData;