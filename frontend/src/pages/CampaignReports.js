// src/pages/CampaignReports.js - FIXED: reports scoped to campaign
import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { 
  Card, Button, Alert, Spinner,
  Row, Col, Table, Badge, Modal, ProgressBar
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const CampaignReports = () => {
  const { id } = useParams();  // campaign ID from URL
  const [campaign, setCampaign] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [showGenerateModal, setShowGenerateModal] = useState(false);

  useEffect(() => {
    fetchCampaign();
    fetchReports();
  }, [id]);

  const fetchCampaign = async () => {
    try {
      const result = await DashboardService.getCampaign(id);
      if (result.success) {
        setCampaign(result.data);
      }
    } catch (err) {
      console.error('Error fetching campaign:', err);
    }
  };

  const fetchReports = async () => {
    setLoading(true);
    try {
      // FIX: pass campaign id so we only see reports for THIS campaign
      const result = await DashboardService.getReports(id);
      if (result.success) {
        setReports(result.data || []);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to fetch reports');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateCampaignReport = async () => {
    setGenerating(true);
    try {
      // FIX: pass campaign id so the report is generated for THIS campaign
      const result = await DashboardService.generateCampaignReport(id);
      
      if (result.success) {
        alert(`Campaign report for "${campaign?.display_name}" generated successfully!`);
        setShowGenerateModal(false);
        fetchReports();
        
        if (result.data && result.data.data && result.data.data.report_id) {
          await handleDownloadReport(
            result.data.data.report_id,
            `${campaign?.name || 'Campaign'}_Report`
          );
        }
      } else {
        alert(`Failed to generate report: ${result.error}`);
      }
    } catch (err) {
      alert('Error generating report');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadReport = async (reportId, defaultName) => {
    try {
      const result = await DashboardService.downloadReport(reportId);
      if (result.success) {
        const timestamp = new Date().toISOString().slice(0, 10);
        saveAs(result.data, `${defaultName}_${timestamp}.xlsx`);
      } else {
        alert('Failed to download report');
      }
    } catch (err) {
      alert('Error downloading report');
    }
  };

  const getReportTypeBadge = (type) => {
    const types = {
      'campaign_report':   { variant: 'primary',   text: 'Campaign Report' },
      'campaign_analysis': { variant: 'success',   text: 'Campaign Analysis' },
      'analysis':          { variant: 'info',      text: 'Template Analysis' },
    };
    const config = types[type] || { variant: 'secondary', text: type || 'Unknown' };
    return <Badge bg={config.variant}>{config.text}</Badge>;
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  };

  return (
    <div className="reports">
      <div className="page-header mb-4">
        <div className="d-flex align-items-center justify-content-between">
          <div className="d-flex align-items-center">
            <Link to={`/campaigns/${id}`} className="btn btn-outline-secondary me-3">
              <i className="bi bi-arrow-left"></i> Back
            </Link>
            <div>
              <h1 className="page-title mb-1">Campaign Reports</h1>
              {campaign && (
                <p className="text-muted mb-0">
                  <Badge bg="info" className="me-2">Campaign: {campaign.display_name}</Badge>
                  Only reports for this campaign are shown
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Generate Button */}
      <Row className="mb-4">
        <Col md={{ span: 6, offset: 3 }}>
          <Card className="h-100 text-center">
            <Card.Body>
              <div style={{ fontSize: '3rem', marginBottom: '1rem', color: '#0d6efd' }}>
                <i className="bi bi-file-earmark-bar-graph"></i>
              </div>
              <h4>Generate Campaign Report</h4>
              <p className="text-muted mb-4">
                Create a comprehensive report for <strong>{campaign?.display_name || 'this campaign'}</strong> with:
                <br />• Processed Data sheet (raw data)
                <br />• Pivot sheet (counts by outcome description)
                <br />• Campaign Analysis sheet (categorized metrics with formulas)
              </p>
              <Button 
                variant="primary" 
                size="lg"
                onClick={() => setShowGenerateModal(true)}
                disabled={generating}
                className="px-5"
              >
                <i className="bi bi-file-earmark-plus me-2"></i>
                Generate Report
              </Button>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Reports List */}
      <Card>
        <Card.Header>
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">
              {campaign ? `${campaign.display_name} Reports` : 'Generated Reports'} ({reports.length})
            </h5>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={fetchReports}
              disabled={loading}
            >
              <i className="bi bi-arrow-clockwise"></i> Refresh
            </Button>
          </div>
        </Card.Header>
        <Card.Body>
          {loading ? (
            <div className="text-center py-5">
              <Spinner animation="border" />
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-5">
              <i className="bi bi-file-earmark-excel" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
              <h5 className="mt-3">No reports for {campaign?.display_name || 'this campaign'} yet</h5>
              <p className="text-muted">
                Click "Generate Report" above to create the first one
              </p>
            </div>
          ) : (
            <div className="table-responsive">
              <Table hover>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Campaign</th>
                    <th>Generated</th>
                    <th>Records</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={report.id}>
                      <td>{getReportTypeBadge(report.report_type)}</td>
                      <td>
                        <strong>{report.parameters?.campaign_name || campaign?.display_name || 'Campaign'}</strong>
                        {report.parameters?.source_file && (
                          <div>
                            <small className="text-muted">
                              Source: {report.parameters.source_file}
                            </small>
                          </div>
                        )}
                      </td>
                      <td><small>{formatDate(report.generated_at)}</small></td>
                      <td>
                        {report.parameters?.record_count ? (
                          <Badge bg="info">
                            {report.parameters.record_count.toLocaleString()}
                          </Badge>
                        ) : (
                          <Badge bg="secondary">-</Badge>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="outline-success"
                          size="sm"
                          onClick={() => handleDownloadReport(
                            report.id,
                            report.parameters?.campaign_name || campaign?.name || 'Campaign_Report'
                          )}
                        >
                          <i className="bi bi-download me-1"></i>
                          Download
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card.Body>
      </Card>

      {error && (
        <Alert variant="danger" className="mt-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      {/* Generate Modal */}
      <Modal show={showGenerateModal} onHide={() => setShowGenerateModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Generate Campaign Report</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            This will generate a report for <strong>{campaign?.display_name}</strong> using
            the latest uploaded data file for this campaign.
            <ul className="mt-2 mb-0">
              <li><strong>Processed Data</strong> – All raw data from your latest upload</li>
              <li><strong>Pivot</strong> – Count of each outcome description</li>
              <li><strong>Campaign Analysis</strong> – Categorized metrics with Excel formulas</li>
            </ul>
          </Alert>
          {generating && (
            <div className="mb-3">
              <ProgressBar animated now={100} variant="primary" />
              <p className="text-center mt-2">Generating report...</p>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowGenerateModal(false)}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={handleGenerateCampaignReport}
            disabled={generating}
          >
            {generating ? (
              <>
                <span className="spinner-border spinner-border-sm me-2"></span>
                Generating...
              </>
            ) : 'Generate Report'}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default CampaignReports;