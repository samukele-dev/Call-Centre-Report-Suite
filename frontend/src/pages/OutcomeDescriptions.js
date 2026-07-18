// src/pages/OutcomeDescriptions.js - UPDATED WITH FIXES
import React, { useState, useEffect } from 'react';
import { 
  Table, Button, Modal, Form, Alert, Spinner,
  InputGroup, Row, Col, Badge, Card, Pagination
} from 'react-bootstrap';
import DashboardService from '../api/dashboardService';
import { saveAs } from 'file-saver';

const OutcomeDescriptions = () => {
  const [outcomes, setOutcomes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editingOutcome, setEditingOutcome] = useState(null);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(50);
  const [uploadResult, setUploadResult] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    last_outcome: '',
    description: '',
  });

  useEffect(() => {
    fetchOutcomes();
  }, [searchTerm, currentPage]);

  const fetchOutcomes = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = {};
      if (searchTerm) params.search = searchTerm;
      
      console.log('📡 Fetching outcomes with params:', params);
      
      const result = await DashboardService.getOutcomeDescriptions(params);
      
      console.log('📦 API Response:', result);
      
      if (result.success) {
        // Check if data is an array
        if (Array.isArray(result.data)) {
          setOutcomes(result.data);
          setTotalCount(result.data.length);
        } else if (result.data && result.data.results) {
          // If using DRF pagination with results field
          setOutcomes(result.data.results);
          setTotalCount(result.data.count || result.data.results.length);
        } else if (result.data && Array.isArray(result.data.data)) {
          // If data is nested under data field
          setOutcomes(result.data.data);
          setTotalCount(result.data.total || result.data.data.length);
        } else {
          console.error('Unexpected data format:', result.data);
          setOutcomes([]);
          setTotalCount(0);
        }
      } else {
        setError(result.error || 'Failed to fetch outcomes');
        setOutcomes([]);
        setTotalCount(0);
      }
    } catch (err) {
      console.error('Error fetching outcomes:', err);
      setError(err.message || 'An error occurred while fetching outcomes');
      setOutcomes([]);
      setTotalCount(0);
    }
    
    setLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      if (editingOutcome) {
        // Update existing outcome
        const result = await DashboardService.updateOutcomeDescription(
          editingOutcome.id,
          {
            last_outcome: formData.last_outcome,
            description: formData.description,
          }
        );
        
        if (result.success) {
          fetchOutcomes();
          handleCloseModal();
        } else {
          setError(result.error || 'Failed to update outcome');
        }
      } else {
        // Create new outcome
        const result = await DashboardService.createOutcomeDescription({
          last_outcome: formData.last_outcome,
          description: formData.description,
        });
        
        if (result.success) {
          fetchOutcomes();
          handleCloseModal();
        } else {
          setError(result.error || 'Failed to create outcome');
        }
      }
    } catch (err) {
      console.error('Error saving outcome:', err);
      setError(err.message || 'An error occurred while saving');
    }
  };

  const handleEdit = (outcome) => {
    console.log('Editing outcome:', outcome);
    setEditingOutcome(outcome);
    setFormData({
      last_outcome: outcome.last_outcome || outcome.abbreviation || '',
      description: outcome.description || '',
    });
    setShowModal(true);
  };

  const handleDelete = async (id) => {
    if (window.confirm('Are you sure you want to delete this outcome?')) {
      try {
        const result = await DashboardService.deleteOutcomeDescription(id);
        
        if (result.success) {
          fetchOutcomes();
        } else {
          setError(result.error || 'Failed to delete outcome');
        }
      } catch (err) {
        console.error('Error deleting outcome:', err);
        setError(err.message || 'An error occurred while deleting');
      }
    }
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingOutcome(null);
    setFormData({
      last_outcome: '',
      description: '',
    });
  };

  const handleFileUpload = async (e) => {
    e.preventDefault();
    
    if (!uploadFile) {
      alert('Please select a file to upload');
      return;
    }
    
    setUploading(true);
    setUploadResult(null);
    console.log('📤 Uploading file:', uploadFile.name, uploadFile.type, uploadFile.size);
    
    try {
      // Check file size (limit to 10MB)
      if (uploadFile.size > 10 * 1024 * 1024) {
        throw new Error('File size exceeds 10MB limit');
      }
      
      const result = await DashboardService.bulkUploadOutcomes(uploadFile);
      console.log('📦 Upload result:', result);
      
      if (result.success) {
        setUploadResult({
          success: true,
          message: result.data.message || 'Upload successful',
          details: result.data
        });
        
        // Show success alert
        alert(`✅ ${result.data.message}\n\nCreated: ${result.data.created}\nUpdated: ${result.data.updated}\nTotal in DB: ${result.data.total_in_db}`);
        
        // Close modal after 2 seconds and refresh data
        setTimeout(() => {
          setShowUploadModal(false);
          setUploadFile(null);
          fetchOutcomes();
        }, 2000);
        
      } else {
        const errorMsg = result.error 
          ? (typeof result.error === 'object' ? JSON.stringify(result.error) : result.error)
          : 'Upload failed';
        
        setUploadResult({
          success: false,
          message: errorMsg
        });
        
        alert(`❌ Error: ${errorMsg}`);
      }
    } catch (error) {
      console.error('Upload error:', error);
      
      let errorMessage = error.message || 'Upload failed';
      
      // Handle specific error cases
      if (error.response) {
        // Server responded with error
        errorMessage = `Server error: ${error.response.status} - ${error.response.statusText}`;
        if (error.response.data) {
          if (typeof error.response.data === 'object') {
            errorMessage += `\n${JSON.stringify(error.response.data, null, 2)}`;
          } else {
            errorMessage += `\n${error.response.data}`;
          }
        }
      } else if (error.request) {
        // Request was made but no response
        errorMessage = 'No response from server. Please check your connection.';
      }
      
      setUploadResult({
        success: false,
        message: errorMessage
      });
      
      alert(`❌ Upload failed: ${errorMessage}`);
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async () => {
    try {
      const result = await DashboardService.exportOutcomes();
      
      if (result.success) {
        saveAs(result.data, `outcome_descriptions_${new Date().toISOString().split('T')[0]}.xlsx`);
      } else {
        alert('Failed to export outcomes');
      }
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export outcomes');
    }
  };

  // Calculate pagination
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentItems = outcomes.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(outcomes.length / itemsPerPage);

  const handlePageChange = (pageNumber) => {
    setCurrentPage(pageNumber);
  };

  const paginationItems = [];
  for (let number = 1; number <= totalPages; number++) {
    paginationItems.push(
      <Pagination.Item
        key={number}
        active={number === currentPage}
        onClick={() => handlePageChange(number)}
      >
        {number}
      </Pagination.Item>
    );
  }

  return (
    <div className="outcome-descriptions">
      <div className="page-header">
        <h1 className="page-title">Outcome Descriptions</h1>
        <p className="page-subtitle">
          Manage last_outcomes and their descriptions (File 1)
        </p>
      </div>

      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)}>
          <Alert.Heading>Error</Alert.Heading>
          <p>{error}</p>
        </Alert>
      )}

      <Card className="mb-4">
        <Card.Body>
          <Row className="align-items-center">
            <Col md={4}>
              <InputGroup>
                <InputGroup.Text>
                  <i className="bi bi-search"></i>
                </InputGroup.Text>
                <Form.Control
                  placeholder="Search last_outcomes or descriptions..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                {searchTerm && (
                  <Button
                    variant="outline-secondary"
                    onClick={() => setSearchTerm('')}
                  >
                    <i className="bi bi-x"></i>
                  </Button>
                )}
              </InputGroup>
            </Col>
            
            <Col md={3}>
              <Form.Select
              >
                <option value="">All Categories</option>
                <option value="TrueContact">True Contacts</option>
                <option value="Unsuccessful">Unsuccessful Contacts</option>
                <option value="Unworkable">Unworkable Leads</option>
              </Form.Select>
            </Col>
            
            <Col md={5} className="text-end">
              <div className="d-flex justify-content-end align-items-center gap-2">
                <div className="text-muted me-3">
                  <small>Total: <strong>{totalCount}</strong> outcomes</small>
                </div>
                <Button 
                  variant="primary" 
                  className="me-2"
                  onClick={() => setShowModal(true)}
                >
                  <i className="bi bi-plus-circle me-1"></i>
                  Add Outcome
                </Button>
                
                <Button 
                  variant="success" 
                  className="me-2"
                  onClick={() => setShowUploadModal(true)}
                >
                  <i className="bi bi-upload me-1"></i>
                  Bulk Upload
                </Button>
                
                <Button 
                  variant="outline-secondary"
                  onClick={handleExport}
                >
                  <i className="bi bi-download me-1"></i>
                  Export
                </Button>
              </div>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {loading ? (
        <div className="text-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        </div>
      ) : (
        <>
          <Card>
            <Card.Body>
              <div className="table-responsive">
                <Table hover striped>
                  <thead>
                    <tr>
                      <th>last_outcome</th>
                      <th>Description</th>
                      <th>Created By</th>
                      <th>Created At</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentItems.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="text-center py-4">
                          <i className="bi bi-inbox" style={{ fontSize: '3rem', color: '#6c757d' }}></i>
                          <p className="mt-2">No outcome descriptions found</p>
                          
                        </td>
                      </tr>
                    ) : (
                      currentItems.map((outcome) => (
                        <tr key={outcome.id}>
                          <td>
                            <strong>{outcome.last_outcome || outcome.abbreviation}</strong>
                          </td>
                          <td>
                            <div className="description-cell">
                              {outcome.description}
                            </div>
                          </td>
                          <td>
                          </td>
                          <td>
                            <small>{outcome.created_by_name || 'System'}</small>
                          </td>
                          <td>
                            <small>
                              {outcome.created_at ? new Date(outcome.created_at).toLocaleDateString() : 'N/A'}
                            </small>
                          </td>
                          <td>
                            <Button
                              variant="outline-primary"
                              size="sm"
                              className="me-2"
                              onClick={() => handleEdit(outcome)}
                            >
                              <i className="bi bi-pencil"></i>
                            </Button>
                            
                            <Button
                              variant="outline-danger"
                              size="sm"
                              onClick={() => handleDelete(outcome.id)}
                            >
                              <i className="bi bi-trash"></i>
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
              </div>
              
              <div className="d-flex justify-content-between align-items-center mt-3">
                <div>
                  <small className="text-muted">
                    Showing {currentItems.length} of {outcomes.length} outcome(s)
                    {totalCount > outcomes.length && ` (${totalCount} total in database)`}
                  </small>
                </div>
                <div>
                  <small className="text-muted">
                    Last updated: {new Date().toLocaleTimeString()}
                  </small>
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="d-flex justify-content-center mt-3">
              <Pagination>
                <Pagination.Prev 
                  onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                />
                {paginationItems}
                <Pagination.Next 
                  onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                />
              </Pagination>
            </div>
          )}
        </>
      )}

      {/* Add/Edit Modal */}
      <Modal show={showModal} onHide={handleCloseModal} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>
            {editingOutcome ? 'Edit Outcome' : 'Add New Outcome'}
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleSubmit}>
          <Modal.Body>
            <Form.Group className="mb-3">
              <Form.Label>last_outcome</Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., SALE, CB, AM"
                value={formData.last_outcome}
                onChange={(e) => setFormData({
                  ...formData,
                  last_outcome: e.target.value.toUpperCase()
                })}
                required
                disabled={!!editingOutcome}
              />
              <Form.Text className="text-muted">
                Unique last_outcome used in call data
              </Form.Text>
            </Form.Group>
            
            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                placeholder="Full description of the outcome"
                value={formData.description}
                onChange={(e) => setFormData({
                  ...formData,
                  description: e.target.value
                })}
                required
              />
            </Form.Group>
            

          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseModal}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {editingOutcome ? 'Update' : 'Save'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Bulk Upload Modal */}
      <Modal show={showUploadModal} onHide={() => setShowUploadModal(false)} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>Bulk Upload from Excel/CSV</Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleFileUpload}>
          <Modal.Body>
            {uploadResult && (
              <Alert variant={uploadResult.success ? "success" : "danger"}>
                <i className={`bi ${uploadResult.success ? "bi-check-circle" : "bi-exclamation-circle"} me-2`}></i>
                {uploadResult.message}
                {uploadResult.success && uploadResult.details && (
                  <div className="mt-2">
                    <small>
                      Created: {uploadResult.details.created}<br />
                      Updated: {uploadResult.details.updated}<br />
                      Total in DB: {uploadResult.details.total_in_db}
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
              <Form.Label>Select File</Form.Label>
              <Form.Control
                type="file"
                accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                onChange={(e) => {
                  setUploadFile(e.target.files[0]);
                  setUploadResult(null);
                }}
                required
              />
              <Form.Text className="text-muted">
                Make sure your file has headers matching the requirements
              </Form.Text>
            </Form.Group>
            
            {uploadFile && (
              <Alert variant="success">
                <i className="bi bi-check-circle me-2"></i>
                Selected: <strong>{uploadFile.name}</strong> 
                ({Math.round(uploadFile.size / 1024)} KB, {uploadFile.type || 'Unknown type'})
              </Alert>
            )}
            
            <div className="sample-file-link">
              <Button 
                variant="outline-secondary" 
                size="sm"
                onClick={() => {
                  const sampleData = [
                    ['last_outcome', 'Description'],
                    ['SALE', 'Sale made',],
                    ['CB', 'Call back requested',],
                    ['NA', 'No answer',],
                    ['AM', 'Answering machine'],
                    ['WM', 'Wrong number'],
                    ['DNC', 'Do not call']
                    ['NA', 'No Answer Autodial']
                  ];
                  
                  const csvContent = sampleData.map(row => 
                    row.map(cell => `"${cell}"`).join(',')
                  ).join('\n');
                  
                  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                  saveAs(blob, 'sample_outcome_descriptions.csv');
                }}
              >
                <i className="bi bi-download me-1"></i>
                Download Sample CSV
              </Button>
              
              <p className="small text-muted mt-2">
                <i className="bi bi-lightbulb me-1"></i>
                Tip: Save your Excel file as CSV (UTF-8) if you encounter encoding issues
              </p>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button 
              variant="secondary" 
              onClick={() => {
                setShowUploadModal(false);
                setUploadFile(null);
                setUploadResult(null);
              }}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button 
              variant="success" 
              type="submit"
              disabled={uploading || !uploadFile}
            >
              {uploading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2"></span>
                  Uploading...
                </>
              ) : (
                <>
                  <i className="bi bi-upload me-1"></i>
                  Upload & Process
                </>
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </div>
  );
};

export default OutcomeDescriptions;