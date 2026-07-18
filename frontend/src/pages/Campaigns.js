// src/pages/Campaigns.js - COMPLETE WITH CAMPAIGN MENUS
import React, { useState, useEffect } from 'react';
import {
  Card, Row, Col, Button, Modal, Form,
  Badge, Spinner, Alert
} from 'react-bootstrap';
import { Link } from 'react-router-dom';
import DashboardService from '../api/dashboardService';

const Campaigns = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    display_name: '',
    description: '',
    sheet_name: ''
  });

  // Predefined campaigns
  const predefinedCampaigns = [
    { name: 'prepaid-funeral', display_name: 'Prepaid Funeral', sheet_name: 'Prepaid Funeral', icon: 'bi-heart', color: '#FF6B6B' },
    { name: 'funeral-upsell', display_name: 'Funeral Upsell', sheet_name: 'Funeral Upsell', icon: 'bi-arrow-up-circle', color: '#4ECDC4' },
    { name: 'funeral-vas', display_name: 'Funeral VAS', sheet_name: 'Funeral VAS', icon: 'bi-plus-circle', color: '#45B7D1' },
    { name: 'ussd-funeral-leads', display_name: 'USSD Funeral Leads', sheet_name: 'Ussd funeral leads', icon: 'bi-phone', color: '#96CEB4' },
    { name: 'media', display_name: 'Media', sheet_name: 'Media', icon: 'bi-play-circle', color: '#FFEAA7' },
    { name: 'vodacom-life', display_name: 'Vodacom Life', sheet_name: 'Vodacom Life', icon: 'bi-shield', color: '#D4A5A5' }
  ];

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const result = await DashboardService.getCampaigns();
      if (result.success) {
        setCampaigns(result.data || []);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to fetch campaigns');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCampaign = async () => {
    if (!formData.name || !formData.display_name || !formData.sheet_name) {
      alert('Please fill in all required fields');
      return;
    }

    setCreating(true);
    try {
      const result = await DashboardService.createCampaign(formData);
      if (result.success) {
        alert('Campaign created successfully!');
        setShowCreateModal(false);
        setFormData({ name: '', display_name: '', description: '', sheet_name: '' });
        fetchCampaigns();
      } else {
        alert(`Failed to create campaign: ${result.error}`);
      }
    } catch (err) {
      alert('Error creating campaign');
    } finally {
      setCreating(false);
    }
  };

  const handleQuickCreate = (campaign) => {
    setFormData({
      name: campaign.name,
      display_name: campaign.display_name,
      description: `Campaign for ${campaign.display_name}`,
      sheet_name: campaign.sheet_name
    });
    setShowCreateModal(true);
  };

  const getCampaignIcon = (campaignName) => {
    const found = predefinedCampaigns.find(c => c.name === campaignName);
    return found ? found.icon : 'bi-folder';
  };

  const getCampaignColor = (campaignName) => {
    const found = predefinedCampaigns.find(c => c.name === campaignName);
    return found ? found.color : '#6366f1';
  };

  const filteredCampaigns = campaigns.filter(campaign => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      campaign.display_name?.toLowerCase().includes(term) ||
      campaign.name?.toLowerCase().includes(term)
    );
  });

  const totalDataFiles = campaigns.reduce((sum, c) => sum + (c.data_files_count || 0), 0);
  const totalReports = campaigns.reduce((sum, c) => sum + (c.reports_count || 0), 0);
  const activeCount = campaigns.filter(c => c.is_active !== false).length;

  return (
    <div className="campaigns">
      <div className="page-header d-flex justify-content-between align-items-start flex-wrap gap-3">
        <h1 className="page-title mb-0">Campaign Manager</h1>
        <div className="d-flex align-items-center gap-3">
          <div className="page-search">
            <i className="bi bi-search"></i>
            <input
              type="text"
              placeholder="Search campaigns..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            onClick={() => setShowCreateModal(true)}
          >
            <i className="bi bi-plus-circle me-2"></i>
            New Campaign
          </Button>
        </div>
      </div>

      {/* Overview stat tiles */}
      <div className="stat-tile-row">
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Total Campaigns</span>
            <span className="stat-tile-chip chip-rose"><i className="bi bi-folder2-open"></i></span>
          </div>
          <div className="stat-tile-value">{campaigns.length}</div>
          <div className="stat-tile-foot">{activeCount} active</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Data Files</span>
            <span className="stat-tile-chip chip-teal"><i className="bi bi-file-earmark-text"></i></span>
          </div>
          <div className="stat-tile-value">{totalDataFiles}</div>
          <div className="stat-tile-foot">across all campaigns</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Reports Generated</span>
            <span className="stat-tile-chip chip-amber"><i className="bi bi-file-earmark-bar-graph"></i></span>
          </div>
          <div className="stat-tile-value">{totalReports}</div>
          <div className="stat-tile-foot">generated to date</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Active Now</span>
            <span className="stat-tile-chip chip-green"><i className="bi bi-broadcast"></i></span>
          </div>
          <div className="stat-tile-value">{activeCount}</div>
          <div className="stat-tile-foot">of {campaigns.length} total</div>
        </div>
      </div>

      {/* Quick Create Predefined Campaigns */}
      <div className="mb-4">
        <div className="d-flex align-items-baseline gap-2 mb-3">
          <h5 className="mb-0 fw-bold">Quick Create</h5>
          <span className="text-muted small">Spin up a standard campaign in one click</span>
        </div>
        <Row>
          {predefinedCampaigns.map(campaign => (
            <Col xs={6} md={4} lg={2} key={campaign.name} className="mb-3">
              <Card
                className="quick-campaign-card text-center h-100"
                style={{ cursor: 'pointer' }}
                onClick={() => handleQuickCreate(campaign)}
              >
                <Card.Body>
                  <div
                    className="quick-campaign-icon mb-3"
                    style={{ backgroundColor: campaign.color }}
                  >
                    <i className={`bi ${campaign.icon}`}></i>
                  </div>
                  <h6 className="mb-0">{campaign.display_name}</h6>
                  <small className="text-muted">+ Create</small>
                </Card.Body>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {error && (
        <Alert variant="danger" className="mb-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      <div className="d-flex align-items-baseline gap-2 mb-3">
        <h5 className="mb-0 fw-bold">Your Campaigns</h5>
        <span className="text-muted small">{filteredCampaigns.length} campaign{filteredCampaigns.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" variant="primary" />
          <p className="mt-3">Loading campaigns...</p>
        </div>
      ) : campaigns.length === 0 ? (
        <Card className="text-center py-5">
          <Card.Body>
            <i className="bi bi-megaphone" style={{ fontSize: '4rem', color: '#9ca3af' }}></i>
            <h3 className="mt-3">No Campaigns Yet</h3>
            <p className="text-muted">Create your first campaign to get started</p>
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
              <i className="bi bi-plus-circle me-2"></i>
              Create Campaign
            </Button>
          </Card.Body>
        </Card>
      ) : filteredCampaigns.length === 0 ? (
        <Card className="text-center py-5">
          <Card.Body>
            <i className="bi bi-search" style={{ fontSize: '3rem', color: '#9ca3af' }}></i>
            <p className="text-muted mt-3 mb-0">No campaigns match "{searchTerm}"</p>
          </Card.Body>
        </Card>
      ) : (
        <Row>
          {filteredCampaigns.map(campaign => (
            <Col md={6} lg={4} key={campaign.id} className="mb-4">
              <Card
                className="campaign-card h-100"
                style={{ '--campaign-accent': getCampaignColor(campaign.name) }}
              >
                <Card.Body>
                  <div className="d-flex align-items-center mb-3">
                    <div
                      className="campaign-icon me-3"
                      style={{ backgroundColor: getCampaignColor(campaign.name) }}
                    >
                      <i className={`bi ${getCampaignIcon(campaign.name)}`}></i>
                    </div>
                    <div className="flex-grow-1">
                      <h5 className="mb-1">{campaign.display_name}</h5>
                      <small className="text-muted">{campaign.name}</small>
                    </div>
                    <Badge bg={campaign.is_active !== false ? 'success' : 'secondary'} pill>
                      {campaign.is_active !== false ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>

                  {campaign.description && (
                    <p className="text-muted small mb-3">{campaign.description}</p>
                  )}

                  <div className="campaign-mini-stats mb-3">
                    <div className="campaign-mini-stat">
                      <div className="campaign-mini-stat-value">{campaign.data_files_count || 0}</div>
                      <div className="campaign-mini-stat-label">Data Files</div>
                    </div>
                    <div className="campaign-mini-stat">
                      <div className="campaign-mini-stat-value">{campaign.reports_count || 0}</div>
                      <div className="campaign-mini-stat-label">Reports</div>
                    </div>
                    <div className="campaign-mini-stat">
                      <div className="campaign-mini-stat-value">{campaign.templates_count || 0}</div>
                      <div className="campaign-mini-stat-label">Templates</div>
                    </div>
                  </div>

                  <div className="campaign-sheet-row mb-3">
                    <span><i className="bi bi-table me-2"></i>Sheet</span>
                    <code>{campaign.sheet_name}</code>
                  </div>

                  <div className="campaign-actions">
                    <Link
                      to={`/campaigns/${campaign.id}`}
                      className="btn btn-primary w-100 mb-2"
                    >
                      <i className="bi bi-folder2-open me-2"></i>
                      Open Dashboard
                    </Link>
                    <div className="campaign-icon-btn-row">
                      <Link
                        to={`/campaigns/${campaign.id}/upload`}
                        className="btn btn-outline-primary"
                        title="Upload Data"
                      >
                        <i className="bi bi-upload"></i>
                      </Link>
                      <Link
                        to={`/campaigns/${campaign.id}/templates`}
                        className="btn btn-outline-success"
                        title="Manage Templates"
                      >
                        <i className="bi bi-file-earmark-excel"></i>
                      </Link>
                      <Link
                        to={`/campaigns/${campaign.id}/reports`}
                        className="btn btn-outline-info"
                        title="Generate Report"
                      >
                        <i className="bi bi-file-earmark-bar-graph"></i>
                      </Link>
                      <Link
                        to={`/campaigns/${campaign.id}/analysis`}
                        className="btn btn-outline-warning"
                        title="Run Analysis"
                      >
                        <i className="bi bi-graph-up"></i>
                      </Link>
                    </div>
                  </div>
                </Card.Body>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* Create Campaign Modal */}
      <Modal show={showCreateModal} onHide={() => setShowCreateModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Create New Campaign</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Campaign Name (Internal)</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., prepaid-funeral"
                value={formData.name}
                onChange={(e) => setFormData({...formData, name: e.target.value})}
              />
              <Form.Text className="text-muted">
                Unique identifier for the campaign (lowercase, hyphens allowed)
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Display Name</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., Prepaid Funeral"
                value={formData.display_name}
                onChange={(e) => setFormData({...formData, display_name: e.target.value})}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Sheet Name in Templates</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., Prepaid Funeral"
                value={formData.sheet_name}
                onChange={(e) => setFormData({...formData, sheet_name: e.target.value})}
              />
              <Form.Text className="text-muted">
                Exact sheet name in your Excel templates for this campaign
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Description (Optional)</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                placeholder="Describe this campaign"
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
              />
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowCreateModal(false)}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={handleCreateCampaign}
            disabled={creating}
          >
            {creating ? (
              <>
                <span className="spinner-border spinner-border-sm me-2"></span>
                Creating...
              </>
            ) : (
              'Create Campaign'
            )}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default Campaigns;