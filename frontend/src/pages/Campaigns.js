// src/pages/Campaigns.js
import React, { useState, useEffect } from 'react';
import {
  Card, Row, Col, Button, Modal, Form,
  Spinner, Alert, Dropdown, ProgressBar
} from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';
import { FULL_OUTCOME_HISTORY_OPTION } from '../utils/reportSheets';
import ReportPreviewModal from '../components/ReportPreviewModal';

const PAGE_SIZE = 10;

// Mirrors ReportViewSet.COMBINED_REPORT_SHEETS on the backend. There's no
// 'template' option here — a combined report has no single per-campaign
// template to clone across campaigns that may each have their own.
const COMBINED_SHEETS = [
  { key: 'processed_data', label: 'Processed Data', description: "Raw records from each campaign's latest upload, tagged with a Campaign column" },
  { key: 'pivot', label: 'Pivot', description: 'Outcome counts per campaign' },
  { key: 'campaign_analysis', label: 'Campaign Analysis', description: 'One comparison row per campaign, plus a grand total' },
  { key: 'agent_performance', label: 'Agent Performance', description: 'Per-agent stats per campaign', slow: true },
  { key: 'call_count_breakdown', label: 'Call Count Breakdown', description: 'Per-contact call counts per campaign', slow: true },
];

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

  // Multi-select + bulk/combined report state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showCombinedModal, setShowCombinedModal] = useState(false);
  const [combinedSheets, setCombinedSheets] = useState(['processed_data', 'pivot', 'campaign_analysis']);
  const [combinedGenerating, setCombinedGenerating] = useState(false);
  const [combinedResult, setCombinedResult] = useState(null);
  const [combinedStartDate, setCombinedStartDate] = useState('');
  const [combinedEndDate, setCombinedEndDate] = useState('');
  const [combinedStartTime, setCombinedStartTime] = useState('');
  const [combinedEndTime, setCombinedEndTime] = useState('');
  const [campaignFiles, setCampaignFiles] = useState({}); // { [campaignId]: file[] }
  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [combinedFullOutcomeHistory, setCombinedFullOutcomeHistory] = useState(false);
  const [combinedSyncMissing, setCombinedSyncMissing] = useState(true);
  const [previewReportId, setPreviewReportId] = useState(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [bulkResults, setBulkResults] = useState([]);

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

  const toggleSelectMode = () => {
    setSelectMode(prev => !prev);
    setSelectedIds([]);
  };

  const toggleCampaignSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAllFiltered = () => {
    const allSelected = filteredCampaigns.length > 0 && selectedIds.length === filteredCampaigns.length;
    setSelectedIds(allSelected ? [] : filteredCampaigns.map(c => c.id));
  };

  const toggleCombinedSheet = (key) => {
    setCombinedSheets(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
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

  const openCombinedModal = async () => {
    setCombinedResult(null);
    setCombinedStartDate('');
    setCombinedEndDate('');
    setCombinedStartTime('');
    setCombinedEndTime('');
    setCombinedFullOutcomeHistory(false);
    setShowCombinedModal(true);
    setLoadingFiles(true);
    try {
      const responses = await Promise.all(
        selectedIds.map(campaignId => DashboardService.getUploadedFiles(campaignId))
      );
      const filesMap = {};
      const defaultFileIds = [];
      selectedIds.forEach((campaignId, i) => {
        const res = responses[i];
        const processed = (res.success ? (res.data || []) : [])
          .filter(f => f.status === 'processed')
          .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
        filesMap[campaignId] = processed;
        // Default to the latest batch per campaign — matches the backend's
        // own fallback when no file_ids are sent at all.
        if (processed.length > 0) defaultFileIds.push(processed[0].id);
      });
      setCampaignFiles(filesMap);
      setSelectedFileIds(defaultFileIds);
    } catch (err) {
      setCampaignFiles({});
      setSelectedFileIds([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  const toggleFileId = (fileId) => {
    setSelectedFileIds(prev => prev.includes(fileId) ? prev.filter(x => x !== fileId) : [...prev, fileId]);
  };

  const handleGenerateCombined = async () => {
    setCombinedGenerating(true);
    setCombinedResult(null);
    try {
      const result = await DashboardService.generateCombinedReport(selectedIds, combinedSheets, {
        fileIds: selectedFileIds,
        startDate: combinedStartDate,
        endDate: combinedEndDate,
        startTime: combinedStartTime,
        endTime: combinedEndTime,
        fullOutcomeHistory: combinedFullOutcomeHistory,
        syncMissing: combinedSyncMissing,
      });
      if (result.success) {
        setCombinedResult({ success: true, data: result.data.data });
      } else {
        setCombinedResult({ success: false, error: result.error });
      }
    } catch (err) {
      setCombinedResult({ success: false, error: 'Error generating combined report' });
    } finally {
      setCombinedGenerating(false);
    }
  };

  const handleBulkGenerate = async () => {
    setBulkGenerating(true);
    const selectedCampaigns = campaigns.filter(c => selectedIds.includes(c.id));
    const results = [];
    for (const c of selectedCampaigns) {
      try {
        const result = await DashboardService.generateCampaignReport(c.id);
        if (result.success && result.data?.data?.report_id) {
          results.push({ campaign: c, status: 'success', reportId: result.data.data.report_id });
        } else {
          results.push({ campaign: c, status: 'error', error: result.error || 'Unknown error' });
        }
      } catch (err) {
        results.push({ campaign: c, status: 'error', error: 'Request failed' });
      }
      setBulkResults([...results]);
    }
    setBulkGenerating(false);
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
        <div className="d-flex gap-2">
          <Button
            variant={selectMode ? 'secondary' : 'outline-secondary'}
            onClick={toggleSelectMode}
          >
            <i className="bi bi-check2-square me-2"></i>
            {selectMode ? 'Done Selecting' : 'Select Campaigns'}
          </Button>
          <Button
            variant="primary"
            onClick={handleNewCampaign}
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

      {selectMode && (
        <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
          <span className="text-muted small">
            {selectedIds.length} of {filteredCampaigns.length} selected
          </span>
          <Button size="sm" variant="outline-secondary" onClick={toggleSelectAllFiltered}>
            {filteredCampaigns.length > 0 && selectedIds.length === filteredCampaigns.length
              ? 'Deselect all'
              : `Select all ${filteredCampaigns.length}`}
          </Button>
          {selectedIds.length > 0 && (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={openCombinedModal}
              >
                <i className="bi bi-collection me-1"></i>Generate Combined Report
              </Button>
              <Button
                size="sm"
                variant="outline-primary"
                onClick={() => { setBulkResults([]); setShowBulkModal(true); }}
              >
                <i className="bi bi-stack me-1"></i>Bulk Generate/Download
              </Button>
            </>
          )}
        </div>
      )}

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
          <div className={`campaign-list ${selectMode ? 'has-select-column' : ''}`}>
            <div className="campaign-list-head">
              {selectMode && (
                <span className="cl-col-select">
                  <Form.Check
                    type="checkbox"
                    checked={filteredCampaigns.length > 0 && selectedIds.length === filteredCampaigns.length}
                    onChange={toggleSelectAllFiltered}
                  />
                </span>
              )}
              <span className="cl-col-campaign">Campaign</span>
              <span className="cl-col-sheet">Sheet</span>
              <span className="cl-col-activity">Activity</span>
              <span className="cl-col-sync">DB Sync</span>
              <span className="cl-col-status">Status</span>
              <span className="cl-col-actions"></span>
            </div>

            {pageCampaigns.map(campaign => (
              <div className="campaign-row" key={campaign.id}>
                {selectMode && (
                  <div className="cl-col-select">
                    <Form.Check
                      type="checkbox"
                      checked={selectedIds.includes(campaign.id)}
                      onChange={() => toggleCampaignSelect(campaign.id)}
                    />
                  </div>
                )}
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

      {/* Combined Report Modal */}
      <Modal
        show={showCombinedModal}
        onHide={() => setShowCombinedModal(false)}
        size="xl"
        centered
      >
        <Modal.Header closeButton>
          <Modal.Title>Generate Combined Report</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="modal-section">
            <div className="modal-section-title">
              {selectedIds.length} campaign{selectedIds.length !== 1 ? 's' : ''} selected
            </div>
            <div className="campaign-chip-row">
              {campaigns.filter(c => selectedIds.includes(c.id)).map(c => (
                <span key={c.id} className="campaign-chip">{c.display_name}</span>
              ))}
            </div>
          </div>

          <Row className="g-4">
            <Col md={6}>
              <div className="modal-section h-100">
                <div className="modal-section-title">Date &amp; Time Range</div>
                <p className="text-muted small mb-3">
                  Optional — scopes every sheet to records called within this range.
                  Leave blank to include each batch's full history.
                </p>
                <Form.Label className="small text-muted mb-1">From</Form.Label>
                <Row className="g-2 mb-3">
                  <Col xs={7}>
                    <Form.Control
                      type="date"
                      value={combinedStartDate}
                      onChange={(e) => setCombinedStartDate(e.target.value)}
                      disabled={combinedGenerating}
                      max={combinedEndDate || undefined}
                    />
                  </Col>
                  <Col xs={5}>
                    <Form.Control
                      type="time"
                      value={combinedStartTime}
                      onChange={(e) => setCombinedStartTime(e.target.value)}
                      disabled={combinedGenerating}
                      title="Optional — narrows the start date to a specific time"
                    />
                  </Col>
                </Row>
                <Form.Label className="small text-muted mb-1">To</Form.Label>
                <Row className="g-2">
                  <Col xs={7}>
                    <Form.Control
                      type="date"
                      value={combinedEndDate}
                      onChange={(e) => setCombinedEndDate(e.target.value)}
                      disabled={combinedGenerating}
                      min={combinedStartDate || undefined}
                    />
                  </Col>
                  <Col xs={5}>
                    <Form.Control
                      type="time"
                      value={combinedEndTime}
                      onChange={(e) => setCombinedEndTime(e.target.value)}
                      disabled={combinedGenerating}
                      title="Optional — narrows the end date to a specific time"
                    />
                  </Col>
                </Row>
              </div>
            </Col>

            <Col md={6}>
              <div className="modal-section h-100">
                <div className="modal-section-title">Sheets to include</div>
                {COMBINED_SHEETS.map(sheet => (
                  <Form.Check
                    key={sheet.key}
                    type="checkbox"
                    id={`combined-sheet-${sheet.key}`}
                    className="mb-2"
                    disabled={combinedGenerating}
                    checked={combinedSheets.includes(sheet.key)}
                    onChange={() => toggleCombinedSheet(sheet.key)}
                    label={
                      <span>
                        <strong>{sheet.label}</strong> – {sheet.description}
                        {sheet.slow && <span className="text-muted"> (slower — a separate database call per campaign)</span>}
                      </span>
                    }
                  />
                ))}
                <hr className="my-2" />
                <Form.Check
                  type="checkbox"
                  id="combined-full-outcome-history"
                  disabled={combinedGenerating}
                  checked={combinedFullOutcomeHistory}
                  onChange={(e) => setCombinedFullOutcomeHistory(e.target.checked)}
                  label={
                    <span>
                      <strong>{FULL_OUTCOME_HISTORY_OPTION.label}</strong> – {FULL_OUTCOME_HISTORY_OPTION.description}
                      <span className="text-muted"> (slower — a full database scan per campaign)</span>
                    </span>
                  }
                />
                <Form.Check
                  type="checkbox"
                  id="combined-sync-missing"
                  disabled={combinedGenerating}
                  checked={combinedSyncMissing}
                  onChange={(e) => setCombinedSyncMissing(e.target.checked)}
                  label={
                    <span>
                      <strong>Sync missing campaigns from database</strong> – any selected campaign with
                      no processed data yet is pulled from the source database first, same as
                      "Sync from Database" on its Upload page
                      <span className="text-muted"> (slower — a database sync per campaign with no data yet)</span>
                    </span>
                  }
                />
              </div>
            </Col>
          </Row>

          <div className="modal-section">
            <div className="modal-section-title">Batch files</div>
            <p className="text-muted small mb-3">
              Defaults to each campaign's latest upload/sync — check more to combine several
              batches from the same campaign.
            </p>
            {loadingFiles ? (
              <div className="text-center py-3">
                <Spinner animation="border" size="sm" variant="primary" />
              </div>
            ) : (
              <div className="combined-batch-list">
                {campaigns.filter(c => selectedIds.includes(c.id)).map(c => {
                  const files = campaignFiles[c.id] || [];
                  return (
                    <div key={c.id} className="combined-batch-group">
                      <div className="combined-batch-group-title">{c.display_name}</div>
                      {files.length === 0 ? (
                        <div className="text-muted small">No processed files for this campaign.</div>
                      ) : (
                        files.map(f => (
                          <Form.Check
                            key={f.id}
                            type="checkbox"
                            id={`combined-file-${f.id}`}
                            className="mb-1"
                            disabled={combinedGenerating}
                            checked={selectedFileIds.includes(f.id)}
                            onChange={() => toggleFileId(f.id)}
                            label={
                              <span>
                                {f.original_name}
                                <span className="text-muted small">
                                  {' '}— {new Date(f.uploaded_at).toLocaleDateString()},{' '}
                                  {(f.processed_records || 0).toLocaleString()} records
                                </span>
                              </span>
                            }
                          />
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {combinedGenerating && (
            <div className="mb-3">
              <ProgressBar animated now={100} variant="primary" />
              <p className="text-center mt-2">Generating combined report...</p>
            </div>
          )}
          {combinedResult && !combinedResult.success && (
            <Alert variant="danger" className="mb-0">{combinedResult.error}</Alert>
          )}
          {combinedResult && combinedResult.success && (
            <Alert variant="success" className="mb-0">
              {combinedResult.data.message}
              {combinedResult.data.skipped?.length > 0 && (
                <div className="mt-2 small">
                  Skipped: {combinedResult.data.skipped.map(s => s.display_name).join(', ')}
                </div>
              )}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowCombinedModal(false)}>
            Close
          </Button>
          {combinedResult?.success ? (
            <>
              <Button
                variant="outline-secondary"
                onClick={() => setPreviewReportId(combinedResult.data.report_id)}
              >
                <i className="bi bi-eye me-2"></i>Preview
              </Button>
              <Button
                variant="primary"
                onClick={() => handleDownloadReport(combinedResult.data.report_id, 'Combined_Report')}
              >
                <i className="bi bi-download me-2"></i>Download
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={handleGenerateCombined}
              disabled={combinedGenerating || combinedSheets.length === 0 || loadingFiles}
            >
              {combinedGenerating ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2"></span>
                  Generating...
                </>
              ) : 'Generate'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      {/* Bulk Generate/Download Modal */}
      <Modal show={showBulkModal} onHide={() => setShowBulkModal(false)} size="lg" centered>
        <Modal.Header closeButton>
          <Modal.Title>Bulk Generate/Download Reports</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-muted">
            Generates a separate, full report for each of the {selectedIds.length} selected
            campaign{selectedIds.length !== 1 ? 's' : ''}, one at a time.
          </p>
          {bulkResults.length > 0 && (
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {bulkResults.map(r => (
                  <tr key={r.campaign.id}>
                    <td>{r.campaign.display_name}</td>
                    <td>
                      {r.status === 'success' ? (
                        <span className="text-success"><i className="bi bi-check-circle me-1"></i>Done</span>
                      ) : (
                        <span className="text-danger" title={r.error}>
                          <i className="bi bi-x-circle me-1"></i>Failed
                        </span>
                      )}
                    </td>
                    <td>
                      {r.status === 'success' && (
                        <>
                          <Button
                            size="sm"
                            variant="outline-secondary"
                            className="me-2"
                            onClick={() => setPreviewReportId(r.reportId)}
                          >
                            Preview
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-primary"
                            onClick={() => handleDownloadReport(r.reportId, `${r.campaign.name}_Report`)}
                          >
                            Download
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bulkGenerating && (
            <div className="mb-3">
              <ProgressBar
                animated
                now={selectedIds.length ? (bulkResults.length / selectedIds.length) * 100 : 0}
                variant="primary"
              />
              <p className="text-center mt-2">
                Generated {bulkResults.length} of {selectedIds.length}...
              </p>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowBulkModal(false)}>
            Close
          </Button>
          <Button variant="primary" onClick={handleBulkGenerate} disabled={bulkGenerating}>
            {bulkGenerating ? (
              <>
                <span className="spinner-border spinner-border-sm me-2"></span>
                Generating...
              </>
            ) : bulkResults.length > 0 ? 'Regenerate All' : 'Start'}
          </Button>
        </Modal.Footer>
      </Modal>

      <ReportPreviewModal
        show={!!previewReportId}
        onHide={() => setPreviewReportId(null)}
        reportId={previewReportId}
      />
    </div>
  );
};

export default Campaigns;
