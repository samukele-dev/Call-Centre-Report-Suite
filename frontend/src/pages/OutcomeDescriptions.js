// src/pages/OutcomeDescriptions.js
import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Modal, Form, Alert, Spinner
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const PAGE_SIZE = 50;

const OutcomeDescriptions = () => {
  const [outcomes, setOutcomes] = useState([]);
  const [outcomeSets, setOutcomeSets] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showSetModal, setShowSetModal] = useState(false);
  const [editingOutcome, setEditingOutcome] = useState(null);
  const [editingSet, setEditingSet] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadSetId, setUploadSetId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSetId, setActiveSetId] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [uploadResult, setUploadResult] = useState(null);
  const [savingSet, setSavingSet] = useState(false);

  const [formData, setFormData] = useState({
    last_outcome: '',
    description: '',
    outcome_set: '',
  });
  const [outcomeSetForm, setOutcomeSetForm] = useState({ name: '', description: '' });

  const fetchOutcomeSets = useCallback(async () => {
    const result = await DashboardService.getOutcomeSets();
    if (result.success) setOutcomeSets(result.data || []);
  }, []);

  const fetchCampaigns = useCallback(async () => {
    const result = await DashboardService.getCampaigns();
    if (result.success) setCampaigns(result.data || []);
  }, []);

  const fetchOutcomes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (searchTerm) params.search = searchTerm;
      if (activeSetId !== 'all') params.outcome_set = activeSetId;

      const result = await DashboardService.getOutcomeDescriptions(params);
      if (result.success) {
        const data = Array.isArray(result.data) ? result.data : [];
        if (activeSetId === 'all') {
          data.sort((a, b) => {
            const setCompare = (a.outcome_set_name || '').localeCompare(b.outcome_set_name || '');
            return setCompare !== 0 ? setCompare : (a.last_outcome || '').localeCompare(b.last_outcome || '');
          });
        }
        setOutcomes(data);
      } else {
        setError(typeof result.error === 'object' ? JSON.stringify(result.error) : (result.error || 'Failed to fetch outcomes'));
        setOutcomes([]);
      }
    } catch (err) {
      setError(err.message || 'An error occurred while fetching outcomes');
      setOutcomes([]);
    }
    setLoading(false);
  }, [searchTerm, activeSetId]);

  useEffect(() => {
    fetchOutcomeSets();
    fetchCampaigns();
  }, [fetchOutcomeSets, fetchCampaigns]);

  useEffect(() => {
    fetchOutcomes();
  }, [fetchOutcomes]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, activeSetId]);

  const defaultSetId = () => {
    if (activeSetId !== 'all') return activeSetId;
    const outcomes1 = outcomeSets.find(s => s.name === 'Outcomes 1');
    return outcomes1 ? outcomes1.id : (outcomeSets[0]?.id || '');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      last_outcome: formData.last_outcome,
      description: formData.description,
      outcome_set: formData.outcome_set || null,
    };
    const result = editingOutcome
      ? await DashboardService.updateOutcomeDescription(editingOutcome.id, payload)
      : await DashboardService.createOutcomeDescription(payload);

    if (result.success) {
      fetchOutcomes();
      fetchOutcomeSets();
      handleCloseModal();
    } else {
      setError(typeof result.error === 'object' ? JSON.stringify(result.error) : result.error);
    }
  };

  const handleEdit = (outcome) => {
    setEditingOutcome(outcome);
    setFormData({
      last_outcome: outcome.last_outcome || '',
      description: outcome.description || '',
      outcome_set: outcome.outcome_set || '',
    });
    setShowModal(true);
  };

  const handleAddNew = () => {
    setEditingOutcome(null);
    setFormData({ last_outcome: '', description: '', outcome_set: defaultSetId() });
    setShowModal(true);
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this outcome?')) {
      const result = await DashboardService.deleteOutcomeDescription(id);
      if (result.success) {
        fetchOutcomes();
        fetchOutcomeSets();
      } else {
        setError(typeof result.error === 'object' ? JSON.stringify(result.error) : result.error);
      }
    }
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingOutcome(null);
    setFormData({ last_outcome: '', description: '', outcome_set: '' });
  };

  const handleFileUpload = async (e) => {
    e.preventDefault();
    if (!uploadFile) return;

    setUploading(true);
    setUploadResult(null);
    try {
      if (uploadFile.size > 10 * 1024 * 1024) {
        throw new Error('File size exceeds 10MB limit');
      }
      const result = await DashboardService.bulkUploadOutcomes(uploadFile, uploadSetId || null);
      if (result.success) {
        setUploadResult({ success: true, message: result.data.message, details: result.data.details });
        setTimeout(() => {
          setShowUploadModal(false);
          setUploadFile(null);
          setUploadResult(null);
          fetchOutcomes();
          fetchOutcomeSets();
        }, 1800);
      } else {
        setUploadResult({
          success: false,
          message: typeof result.error === 'object' ? JSON.stringify(result.error) : result.error
        });
      }
    } catch (error) {
      setUploadResult({ success: false, message: error.message || 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async () => {
    const result = await DashboardService.exportOutcomes();
    if (result.success) {
      saveAs(result.data, `outcome_descriptions_${new Date().toISOString().split('T')[0]}.xlsx`);
    } else {
      setError('Failed to export outcomes');
    }
  };

  const handleOpenNewSet = () => {
    setEditingSet(null);
    setOutcomeSetForm({ name: '', description: '' });
    setShowSetModal(true);
  };

  const handleSaveSet = async (e) => {
    e.preventDefault();
    setSavingSet(true);
    const result = editingSet
      ? await DashboardService.updateOutcomeSet(editingSet.id, outcomeSetForm)
      : await DashboardService.createOutcomeSet(outcomeSetForm);

    if (result.success) {
      await fetchOutcomeSets();
      if (!editingSet) setActiveSetId(result.data.id);
      setShowSetModal(false);
    } else {
      setError(typeof result.error === 'object' ? JSON.stringify(result.error) : result.error);
    }
    setSavingSet(false);
  };

  const campaignsWithoutSet = campaigns.filter(c => !c.outcome_set);
  const activeSet = outcomeSets.find(s => s.id === activeSetId);

  const totalPages = Math.max(1, Math.ceil(outcomes.length / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageItems = outcomes.slice(pageStart, pageStart + PAGE_SIZE);

  const goToPage = (page) => setCurrentPage(Math.min(Math.max(1, page), totalPages));
  const pageNumbers = () => {
    const nums = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) nums.push(p);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    return nums;
  };

  return (
    <div className="outcome-descriptions">
      <div className="page-header d-flex justify-content-between align-items-start flex-wrap gap-3">
        <div>
          <h1 className="page-title mb-1">Outcome Descriptions</h1>
          <p className="page-subtitle mb-0">
            What each <code>last_outcome</code> code means — grouped into sets, since some campaigns use their own.
          </p>
        </div>
        <div className="d-flex gap-2">
          <Button variant="outline-secondary" onClick={handleExport}>
            <i className="bi bi-download me-1"></i>Export
          </Button>
          <Button variant="outline-secondary" onClick={() => setShowUploadModal(true)}>
            <i className="bi bi-upload me-1"></i>Bulk Upload
          </Button>
          <Button variant="primary" onClick={handleAddNew}>
            <i className="bi bi-plus-circle me-1"></i>Add Outcome
          </Button>
        </div>
      </div>

      {/* Overview stat tiles */}
      <div className="stat-tile-row">
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Outcome Sets</span>
            <span className="stat-tile-chip chip-indigo"><i className="bi bi-collection"></i></span>
          </div>
          <div className="stat-tile-value">{outcomeSets.length}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Total Descriptions</span>
            <span className="stat-tile-chip chip-teal"><i className="bi bi-list-check"></i></span>
          </div>
          <div className="stat-tile-value">
            {outcomeSets.reduce((sum, s) => sum + (s.descriptions_count || 0), 0).toLocaleString()}
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Campaigns Assigned</span>
            <span className="stat-tile-chip chip-blue"><i className="bi bi-folder-check"></i></span>
          </div>
          <div className="stat-tile-value">{campaigns.length - campaignsWithoutSet.length}</div>
          <div className="stat-tile-foot">of {campaigns.length} total</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Needs a Set</span>
            <span className="stat-tile-chip chip-rose"><i className="bi bi-exclamation-triangle"></i></span>
          </div>
          <div className="stat-tile-value">{campaignsWithoutSet.length}</div>
          <div className="stat-tile-foot">campaigns with no descriptions at all</div>
        </div>
      </div>

      {campaignsWithoutSet.length > 0 && (
        <Alert variant="warning" className="mb-4">
          <i className="bi bi-exclamation-triangle me-2"></i>
          <strong>{campaignsWithoutSet.length} campaign{campaignsWithoutSet.length !== 1 ? 's have' : ' has'}</strong> no
          outcome set assigned — their Description column will be blank until you assign one on the Campaigns page.
          {' '}({campaignsWithoutSet.slice(0, 5).map(c => c.display_name).join(', ')}{campaignsWithoutSet.length > 5 ? ', …' : ''})
        </Alert>
      )}

      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)} className="mb-4">
          {error}
        </Alert>
      )}

      {/* Outcome set tabs */}
      <div className="outcome-set-tabs">
        <button
          className={`outcome-set-tab ${activeSetId === 'all' ? 'active' : ''}`}
          onClick={() => setActiveSetId('all')}
        >
          All Sets
        </button>
        {outcomeSets.map(s => (
          <button
            key={s.id}
            className={`outcome-set-tab ${activeSetId === s.id ? 'active' : ''}`}
            onClick={() => setActiveSetId(s.id)}
          >
            {s.name} <span className="outcome-set-tab-count">{s.descriptions_count}</span>
          </button>
        ))}
        <button className="outcome-set-tab outcome-set-tab-new" onClick={handleOpenNewSet}>
          <i className="bi bi-plus-lg"></i> New Set
        </button>
      </div>

      {activeSet && (
        <div className="outcome-set-meta mb-3">
          <div>
            {activeSet.description && <span className="text-muted small me-3">{activeSet.description}</span>}
            <span className="recent-chip me-2">{activeSet.campaigns_count} campaign{activeSet.campaigns_count !== 1 ? 's' : ''} using this set</span>
          </div>
          <button
            className="btn btn-sm btn-outline-secondary"
            onClick={() => {
              setEditingSet(activeSet);
              setOutcomeSetForm({ name: activeSet.name, description: activeSet.description || '' });
              setShowSetModal(true);
            }}
          >
            <i className="bi bi-pencil me-1"></i>Rename
          </button>
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar mb-3">
        <div className="page-search filter-search">
          <i className="bi bi-search"></i>
          <input
            type="text"
            placeholder="Search codes or descriptions..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <span className="text-muted small">{outcomes.length.toLocaleString()} result{outcomes.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" variant="primary" />
        </div>
      ) : (
        <>
          <div className={`campaign-list outcome-list ${activeSetId === 'all' ? 'has-set-column' : ''}`}>
            <div className="campaign-list-head outcome-list-head">
              <span>Code</span>
              <span>Description</span>
              {activeSetId === 'all' && <span>Set</span>}
              <span>Updated</span>
              <span></span>
            </div>

            {pageItems.length === 0 ? (
              <div className="text-center py-5">
                <i className="bi bi-inbox" style={{ fontSize: '2.5rem', color: 'var(--text-faint)' }}></i>
                <p className="text-muted mt-2 mb-0">No outcome descriptions found</p>
              </div>
            ) : (
              pageItems.map((outcome) => (
                <div className="campaign-row outcome-list-row" key={outcome.id}>
                  <span><code>{outcome.last_outcome}</code></span>
                  <span className="outcome-description-cell">{outcome.description}</span>
                  {activeSetId === 'all' && (
                    <span>
                      {outcome.outcome_set_name
                        ? <span className="recent-chip">{outcome.outcome_set_name}</span>
                        : <span className="recent-chip" style={{ opacity: 0.6 }}>Unassigned</span>}
                    </span>
                  )}
                  <span className="text-muted small">
                    {outcome.updated_at ? new Date(outcome.updated_at).toLocaleDateString() : 'N/A'}
                  </span>
                  <span className="cl-col-actions">
                    <Button variant="outline-primary" size="sm" onClick={() => handleEdit(outcome)}>
                      <i className="bi bi-pencil"></i>
                    </Button>
                    <Button variant="outline-danger" size="sm" onClick={() => handleDelete(outcome.id)}>
                      <i className="bi bi-trash"></i>
                    </Button>
                  </span>
                </div>
              ))
            )}
          </div>

          {totalPages > 1 && (
            <div className="pagination-bar">
              <span className="pagination-summary">
                Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, outcomes.length)} of {outcomes.length}
              </span>
              <div className="pagination-controls">
                <button className="pagination-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1}>
                  <i className="bi bi-chevron-left"></i>
                </button>
                {pageNumbers().map((p, i) => p === '…' ? (
                  <span key={`e-${i}`} className="pagination-ellipsis">…</span>
                ) : (
                  <button key={p} className={`pagination-btn ${p === currentPage ? 'active' : ''}`} onClick={() => goToPage(p)}>
                    {p}
                  </button>
                ))}
                <button className="pagination-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages}>
                  <i className="bi bi-chevron-right"></i>
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Add/Edit Outcome Modal */}
      <Modal show={showModal} onHide={handleCloseModal} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>{editingOutcome ? 'Edit Outcome' : 'Add New Outcome'}</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleSubmit}>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Outcome Set</Form.Label>
              <Form.Select
                value={formData.outcome_set}
                onChange={(e) => setFormData({ ...formData, outcome_set: e.target.value })}
                required
              >
                <option value="" disabled>Select a set...</option>
                {outcomeSets.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Form.Select>
              <Form.Text className="text-muted">
                Only campaigns assigned to this set will use this description.
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>last_outcome</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., SALE, CB, AM"
                value={formData.last_outcome}
                onChange={(e) => setFormData({ ...formData, last_outcome: e.target.value.toUpperCase() })}
                required
                disabled={!!editingOutcome}
              />
              <Form.Text className="text-muted">Unique code used in call data</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                placeholder="Full description of the outcome"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseModal}>Cancel</Button>
            <Button variant="primary" type="submit">{editingOutcome ? 'Update' : 'Save'}</Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* New/Rename Set Modal */}
      <Modal show={showSetModal} onHide={() => setShowSetModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>{editingSet ? 'Rename Outcome Set' : 'New Outcome Set'}</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleSaveSet}>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., Outcomes 2"
                value={outcomeSetForm.name}
                onChange={(e) => setOutcomeSetForm({ ...outcomeSetForm, name: e.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label>Description (optional)</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                placeholder="What's this set for?"
                value={outcomeSetForm.description}
                onChange={(e) => setOutcomeSetForm({ ...outcomeSetForm, description: e.target.value })}
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShowSetModal(false)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={savingSet}>
              {savingSet ? 'Saving...' : editingSet ? 'Save' : 'Create'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Bulk Upload Modal */}
      <Modal show={showUploadModal} onHide={() => { setShowUploadModal(false); setUploadFile(null); setUploadResult(null); }} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Bulk Upload from Excel/CSV</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleFileUpload}>
          <Modal.Body>
            {uploadResult && (
              <Alert variant={uploadResult.success ? 'success' : 'danger'}>
                <i className={`bi ${uploadResult.success ? 'bi-check-circle' : 'bi-exclamation-circle'} me-2`}></i>
                {uploadResult.message}
                {uploadResult.success && uploadResult.details && (
                  <div className="mt-2">
                    <small>
                      Outcome set: {uploadResult.details.outcome_set}<br />
                      Processed: {uploadResult.details.processed_rows}<br />
                      Total added to DB: {uploadResult.details.total_added_to_db}
                    </small>
                  </div>
                )}
              </Alert>
            )}

            <Alert variant="info">
              <i className="bi bi-info-circle me-2"></i>
              <strong>File Requirements:</strong>
              <ul className="mb-0 mt-2">
                <li>Excel (.xlsx, .xls) or CSV (.csv) format</li>
                <li>Required columns: <strong>last_outcome</strong>, <strong>Description</strong></li>
                <li>File size limit: 10MB</li>
              </ul>
            </Alert>

            <Form.Group className="mb-3">
              <Form.Label>Outcome Set</Form.Label>
              <Form.Select value={uploadSetId} onChange={(e) => setUploadSetId(e.target.value)}>
                <option value="">Outcomes 1 (default)</option>
                {outcomeSets.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Form.Select>
              <Form.Text className="text-muted">
                Every row in this file will be tagged to the set you pick here.
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Select File</Form.Label>
              <Form.Control
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => { setUploadFile(e.target.files[0]); setUploadResult(null); }}
                required
              />
            </Form.Group>

            {uploadFile && (
              <Alert variant="secondary" className="py-2">
                Selected: <strong>{uploadFile.name}</strong> ({Math.round(uploadFile.size / 1024)} KB)
              </Alert>
            )}

            <Button
              variant="outline-secondary"
              size="sm"
              onClick={() => {
                const sampleData = [
                  ['last_outcome', 'Description'],
                  ['SALE', 'Sale made'],
                  ['CB', 'Call back requested'],
                  ['NA', 'No answer'],
                  ['AM', 'Answering machine'],
                  ['WN', 'Wrong number'],
                  ['DNC', 'Do not call'],
                ];
                const csvContent = sampleData.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                saveAs(blob, 'sample_outcome_descriptions.csv');
              }}
            >
              <i className="bi bi-download me-1"></i>Download Sample CSV
            </Button>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => { setShowUploadModal(false); setUploadFile(null); setUploadResult(null); }}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={uploading || !uploadFile}>
              {uploading ? (
                <><span className="spinner-border spinner-border-sm me-2"></span>Uploading...</>
              ) : (
                <><i className="bi bi-upload me-1"></i>Upload &amp; Process</>
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </div>
  );
};

export default OutcomeDescriptions;
