// src/pages/CampaignAnalysis.js - FIXED: templates and reports scoped to campaign
import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { 
  Card, Button, Alert, Spinner, Row, Col, 
  Modal, Form, ProgressBar, Badge, Table 
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const CampaignAnalysis = () => {
  const { id } = useParams();  // campaign ID from URL
  const [campaign, setCampaign] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  
  // Modal state
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [showExtractModal, setShowExtractModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [availableCampaigns, setAvailableCampaigns] = useState([]);
  const [extractedSheets, setExtractedSheets] = useState([]);

  useEffect(() => {
    fetchCampaign();
    fetchTemplates();
    fetchReports();
  }, [id]);

  const fetchCampaign = async () => {
    try {
      const result = await DashboardService.getCampaign(id);
      if (result.success) {
        setCampaign(result.data);
      } else {
        setError(`Failed to load campaign: ${result.error}`);
      }
    } catch (err) {
      setError('Error loading campaign');
    }
  };

  const fetchTemplates = async () => {
    try {
      // FIX: pass campaign id — only load templates for THIS campaign
      const result = await DashboardService.getTemplates(id);
      if (result.success) {
        setTemplates(result.data || []);
      } else {
        console.error('Error fetching templates:', result.error);
      }
    } catch (err) {
      console.error('Error fetching templates:', err);
    }
  };

  const fetchReports = async () => {
    try {
      // FIX: pass campaign id — only load reports for THIS campaign
      const result = await DashboardService.getReports(id);
      if (result.success) {
        setReports(result.data || []);
      } else {
        console.error('Error fetching reports:', result.error);
      }
    } catch (err) {
      console.error('Error fetching reports:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectTemplateForAnalysis = async (template) => {
    setSelectedTemplate(template);
    
    if (template.sheet_names && template.sheet_names.length > 0) {
      setAvailableCampaigns(template.sheet_names);
      setSelectedCampaign('');
      setShowAnalysisModal(true);
      return;
    }
    
    try {
      const sheetsResult = await DashboardService.getTemplateSheets(template.id);
      if (sheetsResult && sheetsResult.sheets) {
        setAvailableCampaigns(sheetsResult.sheets);
      } else if (sheetsResult && sheetsResult.data && sheetsResult.data.sheets) {
        setAvailableCampaigns(sheetsResult.data.sheets);
      } else {
        setAvailableCampaigns([]);
        alert('No sheets found in this template. Click "Extract Sheets" first.');
      }
    } catch (error) {
      console.error('Error fetching template sheets:', error);
      setAvailableCampaigns([]);
    }
    
    setSelectedCampaign('');
    setShowAnalysisModal(true);
  };

  const handleExtractSheets = async (template) => {
    setSelectedTemplate(template);
    setGenerating(true);
    try {
      const result = await DashboardService.extractTemplateSheets(template.id);
      if (result.success) {
        setExtractedSheets(result.sheets || []);
        setShowExtractModal(true);
        fetchTemplates();
      } else {
        alert('Failed to extract sheets: ' + result.error);
      }
    } catch (err) {
      alert('Error extracting sheets');
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateCampaignAnalysis = async () => {
    if (!selectedTemplate) {
      alert('Please select a template first');
      return;
    }
    if (!selectedCampaign) {
      alert('Please select a campaign sheet');
      return;
    }
    
    setGenerating(true);
    try {
      console.log('Generating analysis:', {
        templateId: selectedTemplate.id,
        campaignName: selectedCampaign,
        campaignId: id   // FIX: always pass the current campaign ID
      });
      
      // FIX: pass campaign id (id from URL) so backend scopes everything correctly
      const result = await DashboardService.generateCampaignAnalysis(
        selectedTemplate.id,
        selectedCampaign,
        id   // campaign_id
      );
      
      if (result && result.success) {
        alert('Campaign analysis generated successfully!');
        setShowAnalysisModal(false);
        setSelectedTemplate(null);
        setSelectedCampaign('');
        setAvailableCampaigns([]);
        fetchReports();
        
        if (result.data && result.data.data && result.data.data.report_id) {
          await handleDownloadReport(result.data.data.report_id, `${selectedCampaign}_Analysis`);
        }
      } else {
        alert(`Failed: ${result.error || result.message || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Error generating campaign analysis:', err);
      alert('Error generating campaign analysis');
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
      'analysis': { variant: 'success', text: 'Campaign Analysis' },
      'campaign_analysis': { variant: 'primary', text: 'Campaign Report' }
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

  if (loading && !campaign) {
    return (
      <div className="text-center py-5">
        <Spinner animation="border" variant="primary" />
        <p className="mt-3">Loading campaign analysis...</p>
      </div>
    );
  }

  return (
    <div className="campaign-analysis">
      <div className="page-header mb-4">
        <div className="d-flex align-items-center justify-content-between">
          <div className="d-flex align-items-center">
            <Link to={`/campaigns/${id}`} className="btn btn-outline-secondary me-3">
              <i className="bi bi-arrow-left"></i> Back
            </Link>
            <div>
              <h1 className="page-title mb-1">Campaign Analysis</h1>
              {campaign && (
                <p className="text-muted mb-0">
                  <Badge bg="info" className="me-2">Campaign: {campaign.display_name}</Badge>
                  Only templates and reports for this campaign are shown
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="danger" className="mb-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      {/* Templates List */}
      <Card className="mb-4">
        <Card.Header>
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">
              <i className="bi bi-files me-2"></i>
              {campaign ? `${campaign.display_name} Templates` : 'Templates'} ({templates.length})
            </h5>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={fetchTemplates}
              disabled={loading}
            >
              <i className="bi bi-arrow-clockwise"></i> Refresh
            </Button>
          </div>
        </Card.Header>
        <Card.Body>
          {templates.length === 0 ? (
            <div className="text-center py-4">
              <i className="bi bi-file-earmark-excel" style={{ fontSize: '2.5rem', color: '#6c757d' }}></i>
              <p className="mt-3 mb-1">No templates for {campaign?.display_name || 'this campaign'}</p>
              <small className="text-muted">
                Upload templates in the Templates section for this campaign first.
              </small>
              <div className="mt-3">
                <Link to={`/campaigns/${id}/templates`} className="btn btn-outline-primary btn-sm">
                  <i className="bi bi-cloud-upload me-2"></i>
                  Go to Templates
                </Link>
              </div>
            </div>
          ) : (
            <Row>
              {templates.map(template => (
                <Col md={4} key={template.id} className="mb-3">
                  <Card className="h-100 template-card">
                    <Card.Body>
                      <div className="d-flex align-items-center mb-2">
                        <i className="bi bi-file-earmark-excel text-success me-2" style={{ fontSize: '1.5rem' }}></i>
                        <div>
                          <h6 className="mb-0">{template.name}</h6>
                          <small className="text-muted">
                            {template.sheet_names?.length || 0} sheets
                          </small>
                        </div>
                      </div>
                      {template.description && (
                        <p className="small text-muted">{template.description}</p>
                      )}
                      <div className="mt-3">
                        <Button
                          variant="outline-info"
                          size="sm"
                          onClick={() => handleSelectTemplateForAnalysis(template)}
                          className="w-100 mb-2"
                          disabled={generating}
                        >
                          <i className="bi bi-graph-up me-1"></i>
                          Run Analysis
                        </Button>
                        <Button
                          variant="outline-warning"
                          size="sm"
                          onClick={() => handleExtractSheets(template)}
                          className="w-100"
                          disabled={generating}
                        >
                          <i className="bi bi-grid-3x3-gap-fill me-1"></i>
                          Extract Sheets
                        </Button>
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Card.Body>
      </Card>

      {/* Generated Analysis Reports */}
      <Card>
        <Card.Header>
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">
              <i className="bi bi-file-earmark-bar-graph me-2"></i>
              {campaign ? `${campaign.display_name} Reports` : 'Analysis Reports'} ({reports.length})
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
          {reports.length === 0 ? (
            <div className="text-center py-4">
              <i className="bi bi-file-earmark-excel" style={{ fontSize: '2.5rem', color: '#6c757d' }}></i>
              <p className="mt-3 mb-0">No analysis reports for {campaign?.display_name || 'this campaign'}</p>
              <small className="text-muted">
                Select a template above to generate your first analysis
              </small>
            </div>
          ) : (
            <div className="table-responsive">
              <Table hover>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Campaign / Template</th>
                    <th>Generated</th>
                    <th>Details</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={report.id}>
                      <td>{getReportTypeBadge(report.report_type)}</td>
                      <td>
                        <strong>{report.parameters?.campaign_name || 'Campaign Analysis'}</strong>
                        {report.parameters?.template_name && (
                          <div>
                            <small className="text-muted">
                              Template: {report.parameters.template_name}
                            </small>
                          </div>
                        )}
                      </td>
                      <td><small>{formatDate(report.generated_at)}</small></td>
                      <td>
                        {report.parameters?.record_count && (
                          <Badge bg="secondary" className="me-1">
                            {report.parameters.record_count} records
                          </Badge>
                        )}
                        {report.parameters?.rows_populated && (
                          <Badge bg="info">
                            {report.parameters.rows_populated} rows
                          </Badge>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="outline-success"
                          size="sm"
                          onClick={() => handleDownloadReport(
                            report.id,
                            report.parameters?.campaign_name || 'Analysis'
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

      {/* Analysis Modal */}
      <Modal show={showAnalysisModal} onHide={() => setShowAnalysisModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Generate Campaign Analysis</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            Select a sheet from your template. The system will populate it with data
            from the latest upload for <strong>{campaign?.display_name}</strong>.
          </Alert>
          
          <Form>
            <Form.Group className="mb-4">
              <Form.Label><strong>Selected Template:</strong></Form.Label>
              <Form.Control
                type="text"
                value={selectedTemplate?.name || ''}
                readOnly
                disabled
              />
            </Form.Group>

            {selectedTemplate && (
              <Form.Group className="mb-4">
                <Form.Label><strong>Select Campaign Sheet to Analyze</strong></Form.Label>
                <Form.Select
                  value={selectedCampaign}
                  onChange={(e) => setSelectedCampaign(e.target.value)}
                  size="lg"
                >
                  <option value="">-- Choose a sheet --</option>
                  {availableCampaigns.length > 0 ? (
                    availableCampaigns.map(sheet => (
                      <option key={sheet} value={sheet}>{sheet}</option>
                    ))
                  ) : (
                    <option value="" disabled>No sheets available — extract sheets first</option>
                  )}
                </Form.Select>
                {availableCampaigns.length === 0 && (
                  <Form.Text className="text-warning">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    No sheets found. Click "Extract Sheets" on the template first.
                  </Form.Text>
                )}
              </Form.Group>
            )}

            {selectedTemplate && selectedCampaign && (
              <Alert variant="success">
                <i className="bi bi-check-circle-fill me-2"></i>
                Ready to generate analysis for sheet: <strong>{selectedCampaign}</strong>
                {' '}using <strong>{campaign?.display_name}</strong> data.
              </Alert>
            )}
          </Form>
          
          {generating && (
            <div className="mb-3">
              <ProgressBar animated now={100} variant="info" />
              <p className="text-center mt-2">Generating campaign analysis...</p>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => {
            setShowAnalysisModal(false);
            setSelectedTemplate(null);
            setSelectedCampaign('');
            setAvailableCampaigns([]);
          }}>
            Cancel
          </Button>
          <Button 
            variant="info" 
            onClick={handleGenerateCampaignAnalysis}
            disabled={generating || !selectedTemplate || !selectedCampaign}
          >
            {generating ? 'Generating...' : 'Generate Analysis'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Extracted Sheets Modal */}
      <Modal show={showExtractModal} onHide={() => setShowExtractModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Extracted Sheets</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {selectedTemplate && (
            <>
              <p><strong>Template:</strong> {selectedTemplate.name}</p>
              {extractedSheets.length > 0 ? (
                <>
                  <p>Found {extractedSheets.length} sheets:</p>
                  <div className="sheet-list">
                    {extractedSheets.map((sheet, index) => (
                      <Card key={index} className="mb-2">
                        <Card.Body className="py-2">
                          <i className="bi bi-file-earmark-spreadsheet text-success me-2"></i>
                          {sheet}
                        </Card.Body>
                      </Card>
                    ))}
                  </div>
                </>
              ) : (
                <Alert variant="warning">
                  No sheets found. Make sure it's a valid Excel file.
                </Alert>
              )}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowExtractModal(false)}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default CampaignAnalysis;