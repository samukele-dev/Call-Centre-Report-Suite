// src/pages/CampaignDetail.js - FIXED WITH SEPARATE DOWNLOAD HANDLERS
import React, { useState, useEffect } from 'react';
import { 
  Card, Row, Col, Button, Tabs, Tab, Table, 
  Badge, Spinner, Alert, ProgressBar, ListGroup 
} from 'react-bootstrap';
import { useParams, Link } from 'react-router-dom';
import DashboardService from '../api/dashboardService';
import { Bar, Doughnut } from 'react-chartjs-2';
import { saveAs } from 'file-saver';

const CampaignDetail = () => {
  const { id } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [stats, setStats] = useState(null);
  const [recentActivity, setRecentActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    fetchCampaignData();
  }, [id]);

  const fetchCampaignData = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Fetch campaign details
      const campaignResult = await DashboardService.getCampaign(id);
      if (!campaignResult.success) {
        throw new Error(campaignResult.error);
      }
      setCampaign(campaignResult.data);

      // Fetch campaign stats
      const statsResult = await DashboardService.getCampaignStats(id);
      if (statsResult.success) {
        setStats(statsResult.data);
      }

      // Fetch recent activity
      const activityResult = await DashboardService.getCampaignActivity(id);
      if (activityResult.success) {
        setRecentActivity(activityResult.data);
      }

      setLastUpdated(new Date());

    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchCampaignData();
    setRefreshing(false);
  };

  // HANDLER FOR DOWNLOADING PROCESSED FILES (from uploads)
  const handleDownloadFile = async (fileId, fileName) => {
    try {
      console.log(`📥 Downloading processed file: ${fileId}`);
      const result = await DashboardService.downloadProcessedFile(fileId);
      if (result.success) {
        // Use the filename from the result or create one
        const downloadName = result.fileName || `processed_${fileName || 'data.xlsx'}`;
        saveAs(result.data, downloadName);
      } else {
        alert(`Error downloading file: ${result.error}`);
      }
    } catch (err) {
      console.error('Download error:', err);
      alert('Error downloading file');
    }
  };

  // HANDLER FOR DOWNLOADING GENERATED REPORTS (campaign analysis)
  const handleDownloadReport = async (reportId, filename) => {
    try {
      console.log(`📊 Downloading report: ${reportId}`);
      const result = await DashboardService.downloadReport(reportId);
      if (result.success) {
        const downloadName = result.fileName || filename || `report_${reportId}.xlsx`;
        saveAs(result.data, downloadName);
      } else {
        alert(`Error downloading report: ${result.error}`);
      }
    } catch (err) {
      console.error('Download error:', err);
      alert('Error downloading report');
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusBadge = (status) => {
    const statusConfig = {
      'uploaded': { variant: 'secondary', text: 'Uploaded' },
      'processing': { variant: 'warning', text: 'Processing' },
      'processed': { variant: 'success', text: 'Processed' },
      'failed': { variant: 'danger', text: 'Failed' }
    };
    const config = statusConfig[status] || { variant: 'secondary', text: status || 'Unknown' };
    return <Badge bg={config.variant}>{config.text}</Badge>;
  };

  // Chart data for campaign performance
  const performanceChartData = {
    labels: ['Uploaded', 'Processing', 'Processed', 'Failed'],
    datasets: [
      {
        label: 'File Status',
        data: stats ? [
          stats.data_files?.uploaded || 0,
          stats.data_files?.processing || 0,
          stats.data_files?.processed || 0,
          stats.data_files?.failed || 0
        ] : [0, 0, 0, 0],
        backgroundColor: [
          'rgba(255, 206, 86, 0.8)',
          'rgba(54, 162, 235, 0.8)',
          'rgba(75, 192, 192, 0.8)',
          'rgba(255, 99, 132, 0.8)'
        ],
        borderWidth: 0
      }
    ]
  };

  if (loading && !refreshing) {
    return (
      <div className="text-center py-5">
        <Spinner animation="border" variant="primary" />
        <p className="mt-3">Loading campaign data...</p>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <Alert variant="danger">
        <i className="bi bi-exclamation-triangle-fill me-2"></i>
        {error || 'Campaign not found'}
      </Alert>
    );
  }

  return (
    <div className="campaign-detail">
      {/* Header */}
      <div className="page-header mb-4">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center">
            <Link to="/campaigns" className="btn btn-outline-secondary me-3">
              <i className="bi bi-arrow-left"></i> Back
            </Link>
            <div>
              <h1 className="page-title mb-1">{campaign.display_name}</h1>
              <p className="text-muted mb-0">
                <code className="me-3">Sheet: {campaign.sheet_name}</code>
                {campaign.description}
              </p>
            </div>
          </div>
          <Button 
            variant="outline-primary" 
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <i className={`bi bi-arrow-clockwise ${refreshing ? 'spin' : ''}`}></i>
            {refreshing ? ' Refreshing...' : ' Refresh'}
          </Button>
        </div>
        {lastUpdated && (
          <small className="text-muted">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </small>
        )}
      </div>

      {/* Quick Action Cards */}
      <Row className="mb-4">
        <Col md={3}>
          <Link to={`/campaigns/${id}/upload`} className="text-decoration-none">
            <Card className="action-card upload-card">
              <Card.Body className="text-center">
                <div className="action-icon bg-primary">
                  <i className="bi bi-upload"></i>
                </div>
                <h6>Upload Data</h6>
                <small className="text-muted">Upload campaign data files</small>
              </Card.Body>
            </Card>
          </Link>
        </Col>
        <Col md={3}>
          <Link to={`/campaigns/${id}/templates`} className="text-decoration-none">
            <Card className="action-card template-card">
              <Card.Body className="text-center">
                <div className="action-icon bg-success">
                  <i className="bi bi-file-earmark-excel"></i>
                </div>
                <h6>Templates</h6>
                <small className="text-muted">Manage campaign templates</small>
              </Card.Body>
            </Card>
          </Link>
        </Col>
        <Col md={3}>
          <Link to={`/campaigns/${id}/reports`} className="text-decoration-none">
            <Card className="action-card report-card">
              <Card.Body className="text-center">
                <div className="action-icon bg-info">
                  <i className="bi bi-file-earmark-bar-graph"></i>
                </div>
                <h6>Reports</h6>
                <small className="text-muted">Generate campaign reports</small>
              </Card.Body>
            </Card>
          </Link>
        </Col>
        <Col md={3}>
          <Link to={`/campaigns/${id}/analysis`} className="text-decoration-none">
            <Card className="action-card analysis-card">
              <Card.Body className="text-center">
                <div className="action-icon bg-warning">
                  <i className="bi bi-graph-up"></i>
                </div>
                <h6>Analysis</h6>
                <small className="text-muted">Run campaign analysis</small>
              </Card.Body>
            </Card>
          </Link>
        </Col>
      </Row>

      {/* Stats Cards */}
      {stats && (
        <Row className="mb-4">
          <Col md={3}>
            <Card className="stat-card-sm">
              <Card.Body>
                <div className="d-flex align-items-center">
                  <div className="stat-icon-sm bg-info">
                    <i className="bi bi-file-earmark-text"></i>
                  </div>
                  <div className="ms-3">
                    <h3 className="mb-0">{stats.data_files?.total || 0}</h3>
                    <small className="text-muted">Total Files</small>
                  </div>
                </div>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card-sm">
              <Card.Body>
                <div className="d-flex align-items-center">
                  <div className="stat-icon-sm bg-success">
                    <i className="bi bi-check-circle"></i>
                  </div>
                  <div className="ms-3">
                    <h3 className="mb-0">{stats.data_files?.processed || 0}</h3>
                    <small className="text-muted">Processed</small>
                  </div>
                </div>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card-sm">
              <Card.Body>
                <div className="d-flex align-items-center">
                  <div className="stat-icon-sm bg-primary">
                    <i className="bi bi-file-bar-graph"></i>
                  </div>
                  <div className="ms-3">
                    <h3 className="mb-0">{stats.reports?.total || 0}</h3>
                    <small className="text-muted">Reports</small>
                  </div>
                </div>
              </Card.Body>
            </Card>
          </Col>
          <Col md={3}>
            <Card className="stat-card-sm">
              <Card.Body>
                <div className="d-flex align-items-center">
                  <div className="stat-icon-sm bg-warning">
                    <i className="bi bi-database"></i>
                  </div>
                  <div className="ms-3">
                    <h3 className="mb-0">{stats.total_records?.toLocaleString() || 0}</h3>
                    <small className="text-muted">Records</small>
                  </div>
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      )}

      {/* Main Content Tabs */}
      <Card>
        <Card.Header>
          <Tabs
            activeKey={activeTab}
            onSelect={(k) => setActiveTab(k)}
            className="border-0"
          >
            <Tab eventKey="overview" title="Overview">
              <div className="p-3">
                <Row>
                  <Col md={8}>
                    <h5>Recent Activity</h5>
                    {recentActivity ? (
                      <>
                        {/* Recent Files Section */}
                        <h6 className="mt-3">
                          <i className="bi bi-files me-2"></i>
                          Recent Files
                          {recentActivity.recent_files?.length > 0 && (
                            <Badge bg="secondary" className="ms-2">{recentActivity.recent_files.length}</Badge>
                          )}
                        </h6>
                        
                        {recentActivity.recent_files?.length > 0 ? (
                          <Table hover size="sm" responsive>
                            <thead>
                              <tr>
                                <th>File Name</th>
                                <th>Uploaded</th>
                                <th>Status</th>
                                <th>Size</th>
                                <th>Records</th>
                                <th>Download</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentActivity.recent_files.map(file => (
                                <tr key={file.id}>
                                  <td>
                                    <i className={`bi ${file.original_name?.toLowerCase().endsWith('.csv') ? 'bi-filetype-csv' : 'bi-filetype-xlsx'} me-2`}></i>
                                    {file.original_name || 'Unnamed File'}
                                  </td>
                                  <td>
                                    {file.uploaded_at ? new Date(file.uploaded_at).toLocaleString() : 'N/A'}
                                  </td>
                                  <td>{getStatusBadge(file.status)}</td>
                                  <td>{formatFileSize(file.file_size)}</td>
                                  <td>
                                    {file.total_records > 0 ? (
                                      <Badge bg="info">
                                        {file.total_records.toLocaleString()}
                                        {file.processed_records > 0 && file.processed_records !== file.total_records && (
                                          <small className="ms-1">({file.processed_records} processed)</small>
                                        )}
                                      </Badge>
                                    ) : '-'}
                                  </td>
                                  <td>
                                    {file.status === 'processed' && (
                                      <Button
                                        size="sm"
                                        variant="outline-success"
                                        onClick={() => handleDownloadFile(file.id, file.original_name)}
                                        title="Download processed file with Description column"
                                      >
                                        <i className="bi bi-download"></i>
                                      </Button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        ) : (
                          <Alert variant="info" className="text-center">
                            <i className="bi bi-cloud-upload me-2"></i>
                            No files uploaded yet. <Link to={`/campaigns/${id}/upload`}>Upload your first file</Link>
                          </Alert>
                        )}

                        {/* Recent Reports Section */}
                        <h6 className="mt-4">
                          <i className="bi bi-file-earmark-bar-graph me-2"></i>
                          Recent Reports
                          {recentActivity.recent_reports?.length > 0 && (
                            <Badge bg="secondary" className="ms-2">{recentActivity.recent_reports.length}</Badge>
                          )}
                        </h6>
                        
                        {recentActivity.recent_reports?.length > 0 ? (
                          <Table hover size="sm" responsive>
                            <thead>
                              <tr>
                                <th>Report Type</th>
                                <th>Generated</th>
                                <th>Records</th>
                                <th>Download</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentActivity.recent_reports.map(report => (
                                <tr key={report.id}>
                                  <td>
                                    <Badge bg="info">{report.report_type}</Badge>
                                  </td>
                                  <td>{new Date(report.generated_at).toLocaleString()}</td>
                                  <td>{report.parameters?.record_count?.toLocaleString() || '-'}</td>
                                  <td>
                                    <Button
                                      size="sm"
                                      variant="outline-success"
                                      onClick={() => handleDownloadReport(
                                        report.id, 
                                        `${campaign.name}_${report.report_type}_${new Date().toISOString().slice(0,10)}.xlsx`
                                      )}
                                      title="Download campaign report"
                                    >
                                      <i className="bi bi-download"></i>
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        ) : (
                          <p className="text-muted text-center py-3">
                            <i className="bi bi-file-earmark-excel me-2"></i>
                            No reports generated yet
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="text-center py-4">
                        <Spinner animation="border" size="sm" />
                        <p className="mt-2">Loading activity...</p>
                      </div>
                    )}
                  </Col>
                  
                  <Col md={4}>
                    <Card>
                      <Card.Header>
                        <h6 className="mb-0">File Status Distribution</h6>
                      </Card.Header>
                      <Card.Body>
                        <div style={{ height: '200px' }}>
                          <Doughnut 
                            data={performanceChartData}
                            options={{
                              responsive: true,
                              maintainAspectRatio: false,
                              plugins: {
                                legend: {
                                  position: 'bottom'
                                }
                              }
                            }}
                          />
                        </div>
                      </Card.Body>
                    </Card>

                    <Card className="mt-3">
                      <Card.Header>
                        <h6 className="mb-0">Quick Stats</h6>
                      </Card.Header>
                      <ListGroup variant="flush">
                        <ListGroup.Item className="d-flex justify-content-between">
                          <span>Templates</span>
                          <Badge bg="warning" pill>{stats?.templates || 0}</Badge>
                        </ListGroup.Item>
                        <ListGroup.Item className="d-flex justify-content-between">
                          <span>Processing Success Rate</span>
                          <Badge bg="success" pill>
                            {stats?.data_files?.total > 0 
                              ? Math.round((stats.data_files.processed / stats.data_files.total) * 100) 
                              : 0}%
                          </Badge>
                        </ListGroup.Item>
                        <ListGroup.Item className="d-flex justify-content-between">
                          <span>Avg Records/File</span>
                          <Badge bg="info" pill>
                            {stats?.data_files?.processed > 0 
                              ? Math.round(stats.total_records / stats.data_files.processed) 
                              : 0}
                          </Badge>
                        </ListGroup.Item>
                      </ListGroup>
                    </Card>
                  </Col>
                </Row>
              </div>
            </Tab>
            
            <Tab eventKey="files" title="Data Files">
              <div className="p-3">
                <h5>All Campaign Data Files</h5>
                {recentActivity?.recent_files?.length > 0 ? (
                  <Table hover responsive>
                    <thead>
                      <tr>
                        <th>File Name</th>
                        <th>Uploaded</th>
                        <th>Status</th>
                        <th>Size</th>
                        <th>Records</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentActivity.recent_files.map(file => (
                        <tr key={file.id}>
                          <td>{file.original_name}</td>
                          <td>{new Date(file.uploaded_at).toLocaleString()}</td>
                          <td>{getStatusBadge(file.status)}</td>
                          <td>{formatFileSize(file.file_size)}</td>
                          <td>{file.total_records?.toLocaleString() || '-'}</td>
                          <td>
                            {file.status === 'processed' && (
                              <Button
                                size="sm"
                                variant="outline-success"
                                onClick={() => handleDownloadFile(file.id, file.original_name)}
                                title="Download processed file with Description column"
                              >
                                <i className="bi bi-download me-1"></i>
                                Download Processed
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <Alert variant="info">
                    No files uploaded yet. <Link to={`/campaigns/${id}/upload`}>Upload your first file</Link>
                  </Alert>
                )}
              </div>
            </Tab>
            
            <Tab eventKey="templates" title="Templates">
              <div className="p-3">
                <h5>Campaign Templates</h5>
                <Alert variant="info">
                  <i className="bi bi-info-circle me-2"></i>
                  Template management coming soon.
                </Alert>
              </div>
            </Tab>
            
            <Tab eventKey="reports" title="Reports">
              <div className="p-3">
                <h5>Campaign Reports</h5>
                {recentActivity?.recent_reports?.length > 0 ? (
                  <Table hover responsive>
                    <thead>
                      <tr>
                        <th>Report Type</th>
                        <th>Generated</th>
                        <th>Records</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentActivity.recent_reports.map(report => (
                        <tr key={report.id}>
                          <td><Badge bg="info">{report.report_type}</Badge></td>
                          <td>{new Date(report.generated_at).toLocaleString()}</td>
                          <td>{report.parameters?.record_count?.toLocaleString() || '-'}</td>
                          <td>
                            <Button
                              size="sm"
                              variant="outline-success"
                              onClick={() => handleDownloadReport(report.id, `${campaign.name}_report.xlsx`)}
                              title="Download campaign report"
                            >
                              <i className="bi bi-download me-1"></i>
                              Download Report
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <Alert variant="info">
                    No reports generated yet.
                  </Alert>
                )}
              </div>
            </Tab>
            
            <Tab eventKey="analysis" title="Analysis">
              <div className="p-3">
                <h5>Campaign Analysis</h5>
                <Alert variant="info">
                  <i className="bi bi-info-circle me-2"></i>
                  Analysis features coming soon.
                </Alert>
              </div>
            </Tab>
          </Tabs>
        </Card.Header>
      </Card>
    </div>
  );
};

export default CampaignDetail;