// src/pages/Reports.js - CORRECTED VERSION
import React, { useState, useEffect } from 'react';
import { 
  Card, Button, Alert, Spinner,
  Row, Col, Table, Badge, Modal, ProgressBar,
  Form
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const Reports = () => {
  const [reports, setReports] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  
  // Modals
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  
  // Template state
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const [templateFile, setTemplateFile] = useState(null);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  
  // Available campaigns from selected template
  const [availableCampaigns, setAvailableCampaigns] = useState([]);

  useEffect(() => {
    fetchReports();
    fetchTemplates();
  }, []);

  // Add this useEffect to monitor templates
  useEffect(() => {
    console.log('Current templates:', templates);
    if (templates.length > 0) {
      console.log('First template sheet_names:', templates[0].sheet_names);
    }
  }, [templates]);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const result = await DashboardService.getReports();
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

  const fetchTemplates = async () => {
    try {
      const result = await DashboardService.getTemplates();
      if (result.success) {
        console.log('Templates loaded:', result.data);
        setTemplates(result.data || []);
      } else {
        console.error('Error fetching templates:', result.error);
      }
    } catch (err) {
      console.error('Error fetching templates:', err);
    }
  };

  const handleGenerateMainReport = async () => {
    setGenerating(true);
    try {
      const result = await DashboardService.generateMainReport();
      
      if (result.success) {
        alert('Campaign report generated successfully!');
        setShowGenerateModal(false);
        fetchReports();
        
        if (result.data && result.data.data && result.data.data.report_id) {
          await handleDownloadReport(result.data.data.report_id, 'Campaign_Report');
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

  const handleTemplateUpload = async () => {
    if (!templateFile) {
      alert('Please select a template file');
      return;
    }
    
    setUploadingTemplate(true);
    try {
      const result = await DashboardService.uploadTemplate(
        templateFile,
        templateName || templateFile.name,
        templateDescription
      );
      
      if (result && result.id) {
        alert('Template uploaded successfully!');
        setShowUploadModal(false);
        
        // Refresh templates to show the new one
        setTimeout(() => {
          fetchTemplates();
        }, 2000);
        
        // Reset form
        setTemplateFile(null);
        setTemplateName('');
        setTemplateDescription('');
      } else {
        alert(`Failed to upload template: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert('Error uploading template');
      console.error(err);
    } finally {
      setUploadingTemplate(false);
    }
  };

  const handleSelectTemplateForCampaign = async (template) => {
    console.log('Selected template:', template);
    setSelectedTemplate(template);
    
    // First check if template already has sheet_names
    if (template.sheet_names && template.sheet_names.length > 0) {
      console.log('Using existing sheet names:', template.sheet_names);
      setAvailableCampaigns(template.sheet_names);
      setSelectedCampaign('');
      setShowCampaignModal(true);
      return;
    }
    
    // If no sheet names, try to fetch them
    try {
      console.log('Fetching sheets for template:', template.id);
      const sheetsResult = await DashboardService.getTemplateSheets(template.id);
      console.log('Sheets result:', sheetsResult);
      
      if (sheetsResult && sheetsResult.sheets) {
        setAvailableCampaigns(sheetsResult.sheets);
      } else if (sheetsResult && sheetsResult.data && sheetsResult.data.sheets) {
        setAvailableCampaigns(sheetsResult.data.sheets);
      } else {
        setAvailableCampaigns([]);
        alert('No campaigns found in this template. Make sure the Excel file has sheets.');
      }
    } catch (error) {
      console.error('Error fetching template sheets:', error);
      setAvailableCampaigns([]);
    }
    
    setSelectedCampaign('');
    setShowCampaignModal(true);
  };

  const handleGenerateCampaignAnalysis = async () => {
    if (!selectedTemplate) {
      alert('Please select a template first');
      return;
    }
    
    if (!selectedCampaign) {
      alert('Please select a campaign');
      return;
    }
    
    setGenerating(true);
    try {
      console.log('Generating campaign analysis for:', {
        templateId: selectedTemplate.id,
        campaign: selectedCampaign
      });
      
      const result = await DashboardService.generateCampaignAnalysis(
        selectedTemplate.id,
        selectedCampaign
      );
      
      console.log('Generation result:', result);
      
      if (result && result.success) {
        alert('Campaign analysis generated successfully!');
        setShowCampaignModal(false);
        setSelectedTemplate(null);
        setSelectedCampaign('');
        setAvailableCampaigns([]);
        fetchReports();
        
        if (result.data && result.data.data && result.data.data.report_id) {
          await handleDownloadReport(result.data.data.report_id, `${selectedCampaign}_Analysis`);
        }
      } else {
        alert(`Failed to generate campaign analysis: ${result.error || result.message || 'Unknown error'}`);
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
        const timestamp = new Date().toISOString().slice(0,10);
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
      'campaign_analysis': { variant: 'primary', text: 'Campaign Report' },
      'analysis': { variant: 'success', text: 'Campaign Analysis' },
      'main': { variant: 'info', text: 'Main Report' }
    };
    
    const config = types[type] || { variant: 'secondary', text: type || 'Unknown' };
    
    return <Badge bg={config.variant}>{config.text}</Badge>;
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
  };

  return (
    <div className="reports">
      <div className="page-header mb-4">
        <h1 className="page-title">Reports</h1>
        <p className="page-subtitle">
          Generate and download call center reports
        </p>
      </div>

      {/* Action Buttons */}
      <Row className="mb-4">
        <Col md={4}>
          <Card className="h-100">
            <Card.Body className="text-center">
              <div className="report-action-icon bg-primary">
                <i className="bi bi-file-earmark-bar-graph"></i>
              </div>
              <h5>Generate Campaign Report</h5>
              <p className="text-muted small">
                Create the main campaign report with all metrics
              </p>
              <Button 
                variant="primary" 
                onClick={() => setShowGenerateModal(true)}
                disabled={generating}
              >
                Generate Report
              </Button>
            </Card.Body>
          </Card>
        </Col>
        
        <Col md={4}>
          <Card className="h-100">
            <Card.Body className="text-center">
              <div className="report-action-icon bg-success">
                <i className="bi bi-file-earmark-plus"></i>
              </div>
              <h5>Upload Template</h5>
              <p className="text-muted small">
                Upload Excel template with campaign sheets
              </p>
              <Button 
                variant="success" 
                onClick={() => {
                  setTemplateFile(null);
                  setTemplateName('');
                  setTemplateDescription('');
                  setShowUploadModal(true);
                }}
              >
                Upload Template
              </Button>
            </Card.Body>
          </Card>
        </Col>
        
        <Col md={4}>
          <Card className="h-100">
            <Card.Body className="text-center">
              <div className="report-action-icon bg-info">
                <i className="bi bi-graph-up"></i>
              </div>
              <h5>Campaign Analysis</h5>
              <p className="text-muted small">
                Select a template and campaign to analyze
              </p>
              <Button 
                variant="info" 
                onClick={() => {
                  if (templates.length === 0) {
                    alert('Please upload a template first');
                    return;
                  }
                  setShowCampaignModal(true);
                }}
                disabled={generating || templates.length === 0}
              >
                Select Campaign
              </Button>
              {templates.length === 0 && (
                <div className="mt-2">
                  <small className="text-warning">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    Upload a template first
                  </small>
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Templates List */}
      {templates.length > 0 && (
        <Card className="mb-4">
          <Card.Header>
            <h5 className="mb-0">Your Templates ({templates.length})</h5>
          </Card.Header>
          <Card.Body>
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
                            {template.sheet_names?.length || 0} campaigns
                          </small>
                        </div>
                      </div>
                      {template.description && (
                        <p className="small text-muted">{template.description}</p>
                      )}
                      <div className="mt-2">
                        <Button
                          variant="outline-info"
                          size="sm"
                          onClick={() => handleSelectTemplateForCampaign(template)}
                        >
                          Use for Analysis
                        </Button>
                        <Button
                          variant="outline-warning"
                          size="sm"
                          className="mt-2"
                          onClick={async () => {
                            try {
                              const result = await DashboardService.extractTemplateSheets(template.id);
                              if (result.success) {
                                alert(`Extracted ${result.sheets.length} sheets: ${result.sheets.join(', ')}`);
                                fetchTemplates(); // Refresh templates
                              } else {
                                alert('Failed to extract sheets: ' + result.error);
                              }
                            } catch (err) {
                              alert('Error extracting sheets');
                            }
                          }}
                        >
                          Extract Sheets
                        </Button>
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card.Body>
        </Card>
      )}

      {/* Reports List */}
      <Card>
        <Card.Header>
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">Generated Reports ({reports.length})</h5>
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
              <Spinner animation="border" role="status">
                <span className="visually-hidden">Loading...</span>
              </Spinner>
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-5">
              <i className="bi bi-file-earmark-excel" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
              <h5 className="mt-3">No reports generated yet</h5>
              <p className="text-muted">
                Generate your first report using the buttons above
              </p>
            </div>
          ) : (
            <div className="table-responsive">
              <Table hover>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Name / Campaign</th>
                    <th>Generated</th>
                    <th>Details</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr key={report.id}>
                      <td>
                        {getReportTypeBadge(report.report_type)}
                      </td>
                      <td>
                        <strong>{report.name || 'Untitled'}</strong>
                        {report.parameters?.campaign_name && (
                          <div>
                            <Badge bg="info" pill>
                              {report.parameters.campaign_name}
                            </Badge>
                          </div>
                        )}
                        {report.parameters?.template_name && !report.parameters?.campaign_name && (
                          <div>
                            <small className="text-muted">
                              Template: {report.parameters.template_name}
                            </small>
                          </div>
                        )}
                      </td>
                      <td>
                        <small>{formatDate(report.generated_at)}</small>
                      </td>
                      <td>
                        {report.parameters?.record_count && (
                          <Badge bg="secondary">
                            {report.parameters.record_count} records
                          </Badge>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="outline-success"
                          size="sm"
                          onClick={() => handleDownloadReport(report.id, 
                            report.parameters?.campaign_name || 
                            (report.report_type === 'campaign_analysis' ? 'Campaign_Report' : 'Report'))}
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
        <Alert variant="danger" className="mb-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      {/* Generate Main Report Modal */}
      <Modal show={showGenerateModal} onHide={() => setShowGenerateModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Generate Campaign Report</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            This will create the main campaign report with all metrics using your latest uploaded data.
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
          <Button variant="primary" onClick={handleGenerateMainReport} disabled={generating}>
            {generating ? 'Generating...' : 'Generate Report'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Upload Template Modal */}
      <Modal show={showUploadModal} onHide={() => setShowUploadModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Upload Campaign Template</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            Upload an Excel file where each sheet represents a different campaign.
            The sheet names will be used as campaign names.
          </Alert>
          
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Template File (Excel)</Form.Label>
              <Form.Control
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => setTemplateFile(e.target.files[0])}
              />
              <Form.Text className="text-muted">
                Upload an Excel file with sheets named after your campaigns
              </Form.Text>
            </Form.Group>
            
            <Form.Group className="mb-3">
              <Form.Label>Template Name</Form.Label>
              <Form.Control
                type="text"
                placeholder="Enter template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </Form.Group>
            
            <Form.Group className="mb-3">
              <Form.Label>Description (Optional)</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                placeholder="Describe this template"
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
              />
            </Form.Group>
          </Form>
          
          {uploadingTemplate && (
            <div className="mb-3">
              <ProgressBar animated now={100} variant="success" />
              <p className="text-center mt-2">Uploading template...</p>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => {
            setShowUploadModal(false);
            setTemplateFile(null);
          }}>
            Cancel
          </Button>
          <Button 
            variant="success" 
            onClick={handleTemplateUpload}
            disabled={uploadingTemplate || !templateFile}
          >
            {uploadingTemplate ? 'Uploading...' : 'Upload Template'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Campaign Selection Modal */}
      <Modal show={showCampaignModal} onHide={() => setShowCampaignModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Select Campaign for Analysis</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            First select a template, then choose which campaign to analyze.
            The system will populate the selected campaign sheet with the latest data.
          </Alert>
          
          <Form>
            <Form.Group className="mb-4">
              <Form.Label>
                <strong>1. Select Template</strong>
              </Form.Label>
              <Form.Select
                value={selectedTemplate?.id || ''}
                onChange={async (e) => {
                  const templateId = e.target.value;
                  const template = templates.find(t => t.id.toString() === templateId.toString());
                  if (template) {
                    setSelectedTemplate(template);
                    
                    // Get sheet names for this template
                    try {
                      const sheetsResult = await DashboardService.getTemplateSheets(template.id);
                      if (sheetsResult && sheetsResult.sheets) {
                        setAvailableCampaigns(sheetsResult.sheets);
                      } else if (sheetsResult && sheetsResult.data && sheetsResult.data.sheets) {
                        setAvailableCampaigns(sheetsResult.data.sheets);
                      } else if (template.sheet_names) {
                        setAvailableCampaigns(template.sheet_names);
                      } else {
                        setAvailableCampaigns([]);
                      }
                    } catch (error) {
                      console.error('Error fetching sheets:', error);
                      setAvailableCampaigns(template.sheet_names || []);
                    }
                  }
                }}
              >
                <option value="">-- Choose a template --</option>
                {templates.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.name} ({template.sheet_names?.length || 0} campaigns)
                  </option>
                ))}
              </Form.Select>
            </Form.Group>

            {selectedTemplate && (
              <Form.Group className="mb-4">
                <Form.Label>
                  <strong>2. Select Campaign Sheet</strong>
                </Form.Label>
                <Form.Select
                  value={selectedCampaign}
                  onChange={(e) => setSelectedCampaign(e.target.value)}
                  size="lg"
                >
                  <option value="">-- Choose a campaign --</option>
                  {availableCampaigns.length > 0 ? (
                    availableCampaigns.map(sheet => (
                      <option key={sheet} value={sheet}>{sheet}</option>
                    ))
                  ) : (
                    <option value="" disabled>No campaigns available</option>
                  )}
                </Form.Select>
                {availableCampaigns.length === 0 && (
                  <Form.Text className="text-warning">
                    <i className="bi bi-exclamation-triangle me-1"></i>
                    No campaigns found in this template. Make sure the Excel file has sheets.
                  </Form.Text>
                )}
              </Form.Group>
            )}

            {selectedTemplate && selectedCampaign && (
              <Alert variant="success">
                <i className="bi bi-check-circle-fill me-2"></i>
                Ready to generate analysis for campaign: <strong>{selectedCampaign}</strong>
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
            setShowCampaignModal(false);
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
            {generating ? 'Generating...' : 'Generate Campaign Analysis'}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default Reports;