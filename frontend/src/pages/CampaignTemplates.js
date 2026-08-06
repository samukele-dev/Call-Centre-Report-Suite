// src/pages/CampaignTemplates.js - FIXED: templates scoped to campaign
import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { 
  Card, Button, Alert, Spinner, Row, Col, 
  Modal, Form, ProgressBar, Badge 
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';

const CampaignTemplates = () => {
  const { id } = useParams();  // campaign ID from URL
  const [campaign, setCampaign] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const [error, setError] = useState(null);
  
  // Modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showExtractModal, setShowExtractModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [extractedSheets, setExtractedSheets] = useState([]);
  
  // Form state
  const [templateFile, setTemplateFile] = useState(null);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');

  useEffect(() => {
    fetchCampaign();
    fetchTemplates();
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
    setLoading(true);
    try {
      // FIX: pass campaign_id so we only get templates for THIS campaign
      const result = await DashboardService.getTemplates(id);
      if (result.success) {
        setTemplates(result.data || []);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to fetch templates');
    } finally {
      setLoading(false);
    }
  };

  const handleTemplateUpload = async () => {
    if (!templateFile) {
      alert('Please select a template file');
      return;
    }
    
    setUploadingTemplate(true);
    try {
      // FIX: pass campaign id so the template is linked to this campaign
      const result = await DashboardService.uploadTemplate(
        templateFile,
        templateName || templateFile.name,
        templateDescription,
        id  // campaign_id
      );
      
      if (result && (result.id || result.success)) {
        alert('Template uploaded successfully!');
        setShowUploadModal(false);
        fetchTemplates();
        
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

  const handleExtractSheets = async (template) => {
    setSelectedTemplate(template);
    setUploadingTemplate(true);
    try {
      const result = await DashboardService.extractTemplateSheets(template.id);
      if (result.success) {
        setExtractedSheets(result.sheets || []);
        setShowExtractModal(true);
        fetchTemplates(); // Refresh to get updated sheet names
      } else {
        alert('Failed to extract sheets: ' + result.error);
      }
    } catch (err) {
      alert('Error extracting sheets');
    } finally {
      setUploadingTemplate(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  if (loading && !campaign) {
    return (
      <div className="text-center py-5">
        <Spinner animation="border" variant="primary" />
        <p className="mt-3">Loading campaign templates...</p>
      </div>
    );
  }

  return (
    <div className="campaign-templates">
      <div className="page-header mb-4">
        <div className="d-flex align-items-center justify-content-between">
          <div className="d-flex align-items-center">
            <Link to={`/campaigns/${id}`} className="btn btn-outline-secondary me-3">
              <i className="bi bi-arrow-left"></i> Back
            </Link>
            <div>
              <h1 className="page-title mb-1">Campaign Templates</h1>
              {campaign && (
                <p className="text-muted mb-0">
                  <Badge bg="info" className="me-2">Campaign: {campaign.display_name}</Badge>
                  Manage templates for this campaign only
                </p>
              )}
            </div>
          </div>
          <Button 
            variant="primary" 
            onClick={() => {
              setTemplateFile(null);
              setTemplateName('');
              setTemplateDescription('');
              setShowUploadModal(true);
            }}
          >
            <i className="bi bi-cloud-upload me-2"></i>
            Upload Template
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="danger" className="mb-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      {/* Templates List */}
      <Card>
        <Card.Header>
          <div className="d-flex justify-content-between align-items-center">
            <h5 className="mb-0">
              <i className="bi bi-files me-2"></i>
              {campaign ? `${campaign.display_name} Templates` : 'Your Templates'} ({templates.length})
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
          {loading ? (
            <div className="text-center py-5">
              <Spinner animation="border" variant="primary" />
              <p className="mt-3">Loading templates...</p>
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-5">
              <i className="bi bi-file-earmark-excel" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
              <h5 className="mt-3">No templates for {campaign?.display_name || 'this campaign'}</h5>
              <p className="text-muted">
                Upload your first Excel template for this campaign to get started.
                Templates are campaign-specific and won't appear in other campaigns.
              </p>
              <Button 
                variant="primary" 
                onClick={() => {
                  setTemplateFile(null);
                  setTemplateName('');
                  setTemplateDescription('');
                  setShowUploadModal(true);
                }}
              >
                <i className="bi bi-cloud-upload me-2"></i>
                Upload Template
              </Button>
            </div>
          ) : (
            <Row>
              {templates.map(template => (
                <Col md={4} key={template.id} className="mb-4">
                  <Card className="h-100 template-card">
                    <Card.Body>
                      <div className="d-flex align-items-center mb-3">
                        <div className="template-icon bg-success text-white rounded-circle p-3 me-3">
                          <i className="bi bi-file-earmark-excel" style={{ fontSize: '1.5rem' }}></i>
                        </div>
                        <div>
                          <h6 className="mb-1">{template.name}</h6>
                          <small className="text-muted">
                            Uploaded: {formatDate(template.uploaded_at)}
                          </small>
                        </div>
                      </div>
                      
                      {template.description && (
                        <p className="small text-muted mb-3">{template.description}</p>
                      )}
                      
                      <div className="mb-3">
                        <Badge bg="info" className="me-2">
                          <i className="bi bi-grid-3x3-gap-fill me-1"></i>
                          {template.sheet_names?.length || 0} sheets
                        </Badge>
                        {template.campaign_name && (
                          <Badge bg="secondary">
                            {template.campaign_name}
                          </Badge>
                        )}
                        {template.sheet_names && template.sheet_names.length > 0 && (
                          <div className="mt-2">
                            <small className="text-muted">Sheets:</small>
                            <div className="sheet-list mt-1">
                              {template.sheet_names.slice(0, 3).map((sheet, idx) => (
                                <Badge key={idx} bg="light" text="dark" className="me-1 mb-1">
                                  {sheet}
                                </Badge>
                              ))}
                              {template.sheet_names.length > 3 && (
                                <Badge bg="light" text="dark">+{template.sheet_names.length - 3} more</Badge>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="d-flex gap-2">
                        <Button
                          variant="outline-info"
                          size="sm"
                          onClick={() => handleExtractSheets(template)}
                          disabled={uploadingTemplate}
                          className="flex-fill"
                        >
                          <i className="bi bi-grid-3x3-gap-fill me-1"></i>
                          Extract Sheets
                        </Button>
                        {template.sheet_names && template.sheet_names.length > 0 && (
                          <Button
                            variant="outline-success"
                            size="sm"
                            onClick={() => {
                              alert(`Template "${template.name}" is ready to use with ${template.sheet_names.length} sheets`);
                            }}
                            className="flex-fill"
                          >
                            <i className="bi bi-graph-up me-1"></i>
                            Use Template
                          </Button>
                        )}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Card.Body>
      </Card>

      {/* Upload Template Modal */}
      <Modal show={showUploadModal} onHide={() => setShowUploadModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>
            Upload Template for {campaign?.display_name || 'Campaign'}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="info">
            <i className="bi bi-info-circle me-2"></i>
            This template will be linked exclusively to <strong>{campaign?.display_name}</strong>.
            It will not appear in other campaigns.
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
                Upload an Excel file with sheets named after your campaigns or data categories
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

export default CampaignTemplates;