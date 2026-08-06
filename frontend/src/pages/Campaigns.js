// src/pages/Campaigns.js
import React, { useState, useEffect } from 'react';
import {
  Card, Row, Col, Button, Modal, Form,
  Spinner, Alert, Dropdown
} from 'react-bootstrap';
import { Link } from 'react-router-dom';
import DashboardService from '../api/dashboardService';

const PAGE_SIZE = 10;

const Campaigns = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [syncFilter, setSyncFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingCampaignId, setEditingCampaignId] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const [outcomeSets, setOutcomeSets] = useState([]);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    display_name: '',
    description: '',
    sheet_name: '',
    cd_campaign_id: '',
    outcome_set: ''
  });

  // Predefined campaigns
  const predefinedCampaigns = [
    { name: 'prepaid-funeral', display_name: 'Prepaid Funeral', sheet_name: 'Prepaid Funeral', icon: 'bi-heart' },
    { name: 'funeral-upsell', display_name: 'Funeral Upsell', sheet_name: 'Funeral Upsell', icon: 'bi-arrow-up-circle' },
    { name: 'funeral-vas', display_name: 'Funeral VAS', sheet_name: 'Funeral VAS', icon: 'bi-plus-circle' },
    { name: 'ussd-funeral-leads', display_name: 'USSD Funeral Leads', sheet_name: 'Ussd funeral leads', icon: 'bi-phone' },
    { name: 'media', display_name: 'Media', sheet_name: 'Media', icon: 'bi-play-circle' },
    { name: 'vodacom-life', display_name: 'Vodacom Life', sheet_name: 'Vodacom Life', icon: 'bi-shield' }
  ];

  useEffect(() => {
    fetchCampaigns();
    fetchOutcomeSets();
  }, []);

  const fetchOutcomeSets = async () => {
    const result = await DashboardService.getOutcomeSets();
    if (result.success) setOutcomeSets(result.data || []);
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, syncFilter]);

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

  const handleSaveCampaign = async () => {
    if (!formData.name || !formData.display_name || !formData.sheet_name) {
      alert('Please fill in all required fields');
      return;
    }

    setCreating(true);
    try {
      const result = editingCampaignId
        ? await DashboardService.updateCampaign(editingCampaignId, formData)
        : await DashboardService.createCampaign(formData);

      if (result.success) {
        const wasEditing = !!editingCampaignId;
        closeModal();
        fetchCampaigns();
        setSaveMessage(wasEditing ? 'Campaign updated.' : 'Campaign created.');
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        alert(`Failed to save campaign: ${JSON.stringify(result.error)}`);
      }
    } catch (err) {
      alert('Error saving campaign');
    } finally {
      setCreating(false);
    }
  };

  const defaultOutcomeSetId = () => {
    const outcomes1 = outcomeSets.find(s => s.name === 'Outcomes 1');
    return outcomes1 ? outcomes1.id : (outcomeSets[0]?.id || '');
  };

  const handleNewCampaign = () => {
    setEditingCampaignId(null);
    setFormData({
      name: '', display_name: '', description: '', sheet_name: '',
      cd_campaign_id: '', outcome_set: defaultOutcomeSetId()
    });
    setShowCreateModal(true);
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setEditingCampaignId(null);
    setFormData({ name: '', display_name: '', description: '', sheet_name: '', cd_campaign_id: '', outcome_set: '' });
  };

  const handleQuickCreate = (campaign) => {
    setEditingCampaignId(null);
    setFormData({
      name: campaign.name,
      display_name: campaign.display_name,
      description: `Campaign for ${campaign.display_name}`,
      sheet_name: campaign.sheet_name,
      cd_campaign_id: '',
      outcome_set: defaultOutcomeSetId()
    });
    setShowCreateModal(true);
  };

  const handleEditCampaign = (campaign) => {
    setEditingCampaignId(campaign.id);
    setFormData({
      name: campaign.name || '',
      display_name: campaign.display_name || '',
      description: campaign.description || '',
      sheet_name: campaign.sheet_name || '',
      cd_campaign_id: campaign.cd_campaign_id || '',
      outcome_set: campaign.outcome_set || ''
    });
    setShowCreateModal(true);
  };

  const getCampaignIcon = (campaignName) => {
    const found = predefinedCampaigns.find(c => c.name === campaignName);
    return found ? found.icon : 'bi-folder';
  };

  const filteredCampaigns = campaigns.filter(campaign => {
    if (statusFilter === 'active' && campaign.is_active === false) return false;
    if (statusFilter === 'inactive' && campaign.is_active !== false) return false;

    const hasSync = !!campaign.cd_campaign_id;
    if (syncFilter === 'configured' && !hasSync) return false;
    if (syncFilter === 'unconfigured' && hasSync) return false;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const matches =
        campaign.display_name?.toLowerCase().includes(term) ||
        campaign.name?.toLowerCase().includes(term) ||
        campaign.sheet_name?.toLowerCase().includes(term);
      if (!matches) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredCampaigns.length / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageCampaigns = filteredCampaigns.slice(pageStart, pageStart + PAGE_SIZE);

  const totalDataFiles = campaigns.reduce((sum, c) => sum + (c.data_files_count || 0), 0);
  const totalReports = campaigns.reduce((sum, c) => sum + (c.reports_count || 0), 0);
  const activeCount = campaigns.filter(c => c.is_active !== false).length;

  const goToPage = (page) => {
    setCurrentPage(Math.min(Math.max(1, page), totalPages));
  };

  const pageNumbers = () => {
    const nums = [];
    const pageWindow = 1;
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= pageWindow) {
        nums.push(p);
      } else if (nums[nums.length - 1] !== '…') {
        nums.push('…');
      }
    }
    return nums;
  };

  return (
    <div className="campaigns">
      <div className="page-header d-flex justify-content-between align-items-start flex-wrap gap-3">
        <h1 className="page-title mb-0">Campaign Manager</h1>
        <Button
          variant="primary"
          onClick={handleNewCampaign}
        >
          <i className="bi bi-plus-circle me-2"></i>
          New Campaign
        </Button>
      </div>

      {/* Overview stat tiles */}
      <div className="stat-tile-row">
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Total Campaigns</span>
            <span className="stat-tile-chip chip-brand"><i className="bi bi-folder2-open"></i></span>
          </div>
          <div className="stat-tile-value">{campaigns.length}</div>
          <div className="stat-tile-foot">{activeCount} active</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Data Files</span>
            <span className="stat-tile-chip chip-brand"><i className="bi bi-file-earmark-text"></i></span>
          </div>
          <div className="stat-tile-value">{totalDataFiles}</div>
          <div className="stat-tile-foot">across all campaigns</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Reports Generated</span>
            <span className="stat-tile-chip chip-brand"><i className="bi bi-file-earmark-bar-graph"></i></span>
          </div>
          <div className="stat-tile-value">{totalReports}</div>
          <div className="stat-tile-foot">generated to date</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Active Now</span>
            <span className="stat-tile-chip chip-neutral"><i className="bi bi-broadcast"></i></span>
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
                  <div className="quick-campaign-icon mb-3">
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

      {saveMessage && (
        <Alert variant="success" className="mb-4">
          <i className="bi bi-check-circle-fill me-2"></i>
          {saveMessage}
        </Alert>
      )}

      {error && (
        <Alert variant="danger" className="mb-4">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {error}
        </Alert>
      )}

      <div className="d-flex align-items-baseline gap-2 mb-3">
        <h5 className="mb-0 fw-bold">Your Campaigns</h5>
        <span className="text-muted small">
          {filteredCampaigns.length} of {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter bar */}
      <div className="filter-bar mb-3">
        <div className="page-search filter-search">
          <i className="bi bi-search"></i>
          <input
            type="text"
            placeholder="Search by name or sheet..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <Form.Select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
          <option value="all">All statuses</option>
        </Form.Select>
        <Form.Select
          className="filter-select"
          value={syncFilter}
          onChange={(e) => setSyncFilter(e.target.value)}
        >
          <option value="all">All campaigns</option>
          <option value="configured">DB sync configured</option>
          <option value="unconfigured">DB sync not set up</option>
        </Form.Select>
      </div>

      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" variant="primary" />
          <p className="mt-3">Loading campaigns...</p>
        </div>
      ) : campaigns.length === 0 ? (
        <Card className="text-center py-5">
          <Card.Body>
            <i className="bi bi-megaphone" style={{ fontSize: '4rem', color: 'var(--text-faint)' }}></i>
            <h3 className="mt-3">No Campaigns Yet</h3>
            <p className="text-muted">Create your first campaign to get started</p>
            <Button variant="primary" onClick={handleNewCampaign}>
              <i className="bi bi-plus-circle me-2"></i>
              Create Campaign
            </Button>
          </Card.Body>
        </Card>
      ) : filteredCampaigns.length === 0 ? (
        <Card className="text-center py-5">
          <Card.Body>
            <i className="bi bi-search" style={{ fontSize: '3rem', color: 'var(--text-faint)' }}></i>
            <p className="text-muted mt-3 mb-0">No campaigns match these filters.</p>
          </Card.Body>
        </Card>
      ) : (
        <>
          <div className="campaign-list">
            <div className="campaign-list-head">
              <span className="cl-col-campaign">Campaign</span>
              <span className="cl-col-sheet">Sheet</span>
              <span className="cl-col-activity">Activity</span>
              <span className="cl-col-sync">DB Sync</span>
              <span className="cl-col-status">Status</span>
              <span className="cl-col-actions"></span>
            </div>

            {pageCampaigns.map(campaign => (
              <div className="campaign-row" key={campaign.id}>
                <div className="cl-col-campaign">
                  <div className="campaign-row-icon">
                    <i className={`bi ${getCampaignIcon(campaign.name)}`}></i>
                  </div>
                  <div className="campaign-row-info">
                    <Link to={`/campaigns/${campaign.id}`} className="campaign-row-title">
                      {campaign.display_name}
                    </Link>
                    <span className="campaign-row-subtitle">{campaign.name}</span>
                  </div>
                </div>

                <div className="cl-col-sheet">
                  <code>{campaign.sheet_name}</code>
                </div>

                <div className="cl-col-activity">
                  <span title="Data files">
                    <i className="bi bi-file-earmark-text"></i> {campaign.data_files_count || 0}
                  </span>
                  <span title="Reports">
                    <i className="bi bi-file-earmark-bar-graph"></i> {campaign.reports_count || 0}
                  </span>
                  <span title="Templates">
                    <i className="bi bi-file-earmark-excel"></i> {campaign.templates_count || 0}
                  </span>
                </div>

                <div className="cl-col-sync">
                  {campaign.cd_campaign_id ? (
                    <span className="sync-pill sync-on" title={campaign.cd_campaign_id}>
                      <i className="bi bi-database-check"></i> Connected
                    </span>
                  ) : (
                    <span className="sync-pill sync-off">
                      <i className="bi bi-database-slash"></i> Not set
                    </span>
                  )}
                </div>

                <div className="cl-col-status">
                  <span className={`campaign-status-pill ${campaign.is_active !== false ? 'is-active' : 'is-inactive'}`}>
                    {campaign.is_active !== false ? 'Active' : 'Inactive'}
                  </span>
                </div>

                <div className="cl-col-actions">
                  <Link
                    to={`/campaigns/${campaign.id}`}
                    className="btn btn-primary btn-sm"
                  >
                    Open
                  </Link>
                  <Dropdown align="end">
                    <Dropdown.Toggle
                      variant="outline-secondary"
                      size="sm"
                      className="campaign-row-menu-toggle"
                      id={`campaign-menu-${campaign.id}`}
                    >
                      <i className="bi bi-three-dots"></i>
                    </Dropdown.Toggle>
                    <Dropdown.Menu>
                      <Dropdown.Item as={Link} to={`/campaigns/${campaign.id}/upload`}>
                        <i className="bi bi-upload me-2"></i>Upload Data
                      </Dropdown.Item>
                      <Dropdown.Item as={Link} to={`/campaigns/${campaign.id}/templates`}>
                        <i className="bi bi-file-earmark-excel me-2"></i>Templates
                      </Dropdown.Item>
                      <Dropdown.Item as={Link} to={`/campaigns/${campaign.id}/reports`}>
                        <i className="bi bi-file-earmark-bar-graph me-2"></i>Reports
                      </Dropdown.Item>
                      <Dropdown.Item as={Link} to={`/campaigns/${campaign.id}/analysis`}>
                        <i className="bi bi-graph-up me-2"></i>Analysis
                      </Dropdown.Item>
                      <Dropdown.Divider />
                      <Dropdown.Item onClick={() => handleEditCampaign(campaign)}>
                        <i className="bi bi-pencil me-2"></i>Edit Campaign
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown>
                </div>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination-bar">
              <span className="pagination-summary">
                Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredCampaigns.length)} of {filteredCampaigns.length}
              </span>
              <div className="pagination-controls">
                <button
                  className="pagination-btn"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage === 1}
                >
                  <i className="bi bi-chevron-left"></i>
                </button>
                {pageNumbers().map((p, i) =>
                  p === '…' ? (
                    <span key={`ellipsis-${i}`} className="pagination-ellipsis">…</span>
                  ) : (
                    <button
                      key={p}
                      className={`pagination-btn ${p === currentPage ? 'active' : ''}`}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  )
                )}
                <button
                  className="pagination-btn"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage === totalPages}
                >
                  <i className="bi bi-chevron-right"></i>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create/Edit Campaign Modal */}
      <Modal show={showCreateModal} onHide={closeModal} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>{editingCampaignId ? 'Edit Campaign' : 'Create New Campaign'}</Modal.Title>
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

            <Form.Group className="mb-3">
              <Form.Label>Source Database Campaign ID (Optional)</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., f9f597f5-d6fa-4592-b73a-2fc7f86f328c"
                value={formData.cd_campaign_id}
                onChange={(e) => setFormData({...formData, cd_campaign_id: e.target.value})}
              />
              <Form.Text className="text-muted">
                Campaign UUID (cxm.campaigns.id) in the call-centre database. Set this to
                enable "Sync from Database" on this campaign's upload page instead of
                manual file upload — it pulls across every list that campaign has ever had.
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Outcome Set</Form.Label>
              <Form.Select
                value={formData.outcome_set}
                onChange={(e) => setFormData({...formData, outcome_set: e.target.value})}
              >
                <option value="">No set (Description column will be blank)</option>
                {outcomeSets.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.descriptions_count})</option>
                ))}
              </Form.Select>
              <Form.Text className="text-muted">
                Which named collection of outcome descriptions this campaign resolves
                codes against — manage sets on the Outcomes page. Campaigns don't share
                across sets, so this must be set for uploads/syncs to show real descriptions.
              </Form.Text>
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSaveCampaign}
            disabled={creating}
          >
            {creating ? (
              <>
                <span className="spinner-border spinner-border-sm me-2"></span>
                Saving...
              </>
            ) : editingCampaignId ? (
              'Save Changes'
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
