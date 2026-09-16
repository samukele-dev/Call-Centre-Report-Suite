// src/components/ReportPreviewModal.js
import React, { useEffect, useState } from 'react';
import { Modal, Table, Form, Spinner, Alert } from 'react-bootstrap';
import DashboardService from '../api/dashboardService';

// Shared "Preview" companion to every per-report Download button — reads
// straight from the same .xlsx a download would fetch (see
// ReportViewSet.preview), so what's shown here always matches the file.
const formatCell = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') return String(value);
  return String(value);
};

const ReportPreviewModal = ({ show, onHide, reportId, title = 'Report Preview' }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sheets, setSheets] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const load = async (sheetName = null) => {
    if (!reportId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await DashboardService.previewReport(reportId, sheetName);
      if (result.success) {
        setSheets(result.data.sheets || []);
        setSheet(result.data.sheet);
        setColumns(result.data.columns || []);
        setRows(result.data.rows || []);
        setTotalRows(result.data.total_rows || 0);
        setTruncated(!!result.data.truncated);
      } else {
        setError(result.error || 'Failed to load preview');
      }
    } catch (err) {
      setError('Failed to load preview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (show && reportId) {
      load(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, reportId]);

  const handleSheetChange = (e) => {
    const next = e.target.value;
    setSheet(next);
    load(next);
  };

  return (
    <Modal show={show} onHide={onHide} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {loading && (
          <div className="d-flex align-items-center gap-2 mb-3">
            <Spinner animation="border" size="sm" />
            <span>Loading preview...</span>
          </div>
        )}
        {error && <Alert variant="danger">{error}</Alert>}

        {!error && sheets.length > 0 && (
          <div className="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
            <Form.Select
              size="sm"
              style={{ maxWidth: 260 }}
              value={sheet || ''}
              onChange={handleSheetChange}
              disabled={loading}
            >
              {sheets.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Form.Select>
            <small className="text-muted">
              {truncated
                ? `Showing first ${rows.length.toLocaleString()} of ${totalRows.toLocaleString()} rows`
                : `${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'}`}
            </small>
          </div>
        )}

        {!error && !loading && columns.length > 0 && (
          <div className="table-responsive" style={{ maxHeight: '60vh' }}>
            <Table striped bordered hover size="sm" className="mb-0">
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bs-body-bg)' }}>
                <tr>
                  {columns.map((c, i) => <th key={i}>{c || `Col ${i + 1}`}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {columns.map((_, ci) => <td key={ci}>{formatCell(row[ci])}</td>)}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {!error && !loading && rows.length === 0 && columns.length > 0 && (
          <p className="text-muted mb-0">This sheet has no data rows.</p>
        )}
      </Modal.Body>
    </Modal>
  );
};

export default ReportPreviewModal;
