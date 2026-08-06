// src/pages/Dashboard.js
import React, { useState, useEffect } from 'react';
import { Card, Spinner, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import DashboardService from '../api/dashboardService';

const STATUS_META = {
  uploaded:   { label: 'Uploaded',   chip: 'chip-blue' },
  processing: { label: 'Processing', chip: 'chip-amber' },
  processed:  { label: 'Processed',  chip: 'chip-green' },
  failed:     { label: 'Failed',     chip: 'chip-rose' },
};

const Dashboard = () => {
  const [stats, setStats] = useState({
    overview: {
      total_outcomes: 0,
      total_files: 0,
      total_reports: 0,
      total_records: 0
    },
    recent_reports: [],
    recent_files: [],
    file_status: {
      uploaded: 0,
      processing: 0,
      processed: 0,
      failed: 0
    }
  });

  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    fetchDashboardData();

    // Refresh every 30 seconds
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchDashboardData = async () => {
    setLoading(true);
    setError(null);

    try {
      const statsResult = await DashboardService.getDashboardStats();

      if (statsResult.success) {
        const data = statsResult.data || {};
        setStats({
          overview: data.overview || {
            total_outcomes: 0,
            total_files: 0,
            total_reports: 0,
            total_records: 0
          },
          recent_reports: Array.isArray(data.recent_reports) ? data.recent_reports : [],
          recent_files: Array.isArray(data.recent_files) ? data.recent_files : [],
          file_status: data.file_status || {
            uploaded: 0,
            processing: 0,
            processed: 0,
            failed: 0
          }
        });
      } else {
        console.error('Failed to load stats:', statsResult.error);
      }

      const campaignsResult = await DashboardService.getCampaigns();
      if (campaignsResult.success) {
        setCampaigns(campaignsResult.data || []);
      }

      setLastUpdated(new Date());
    } catch (error) {
      console.error('Dashboard fetch error:', error);
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const fileStatusTotal = Object.values(stats.file_status).reduce((a, b) => a + b, 0);

  const topCampaigns = [...campaigns]
    .sort((a, b) => (b.data_files_count || 0) - (a.data_files_count || 0))
    .slice(0, 5);
  const topCampaignMax = Math.max(1, ...topCampaigns.map(c => c.data_files_count || 0));

  if (loading && !stats.overview.total_outcomes && campaigns.length === 0) {
    return (
      <div className="loading-container">
        <Spinner animation="border" variant="primary" />
        <p className="loading-text mt-3">Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-container">
        <i className="bi bi-exclamation-triangle-fill error-icon"></i>
        <h3 className="error-title">Error Loading Dashboard</h3>
        <p className="error-message">{error}</p>
        <Button
          className="retry-button"
          onClick={fetchDashboardData}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h1 className="page-title">Dashboard Overview</h1>
        {lastUpdated && (
          <small className="text-muted">
            Last updated: {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </small>
        )}
      </div>

      {/* Stats Cards */}
      <div className="stat-tile-row dashboard-row">
        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Outcome Descriptions</span>
            <span className="stat-tile-chip chip-indigo"><i className="bi bi-list-check"></i></span>
          </div>
          <div className="stat-tile-value">{stats?.overview?.total_outcomes?.toLocaleString() || 0}</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Active Campaigns</span>
            <span className="stat-tile-chip chip-teal"><i className="bi bi-folder"></i></span>
          </div>
          <div className="stat-tile-value">{campaigns?.length?.toLocaleString() || 0}</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Uploaded Files</span>
            <span className="stat-tile-chip chip-amber"><i className="bi bi-file-earmark-text"></i></span>
          </div>
          <div className="stat-tile-value">{stats?.overview?.total_files?.toLocaleString() || 0}</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Generated Reports</span>
            <span className="stat-tile-chip chip-blue"><i className="bi bi-file-bar-graph"></i></span>
          </div>
          <div className="stat-tile-value">{stats?.overview?.total_reports?.toLocaleString() || 0}</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile-top">
            <span className="stat-tile-label">Records Processed</span>
            <span className="stat-tile-chip chip-rose"><i className="bi bi-database-check"></i></span>
          </div>
          <div className="stat-tile-value">{stats?.overview?.total_records?.toLocaleString() || 0}</div>
        </div>
      </div>

      {/* Real-data overview: file pipeline health + top campaigns */}
      <div className="dashboard-row dashboard-overview-row">
        <Card className="chart-card">
          <Card.Header>
            <Card.Title>File Processing Status</Card.Title>
          </Card.Header>
          <Card.Body>
            {fileStatusTotal === 0 ? (
              <div className="text-center py-4">
                <i className="bi bi-inbox text-muted" style={{ fontSize: '2.5rem' }}></i>
                <p className="text-muted mt-3 mb-0">No files uploaded yet</p>
              </div>
            ) : (
              <>
                <div className="status-proportion-bar">
                  {Object.entries(stats.file_status).map(([key, count]) => (
                    count > 0 && (
                      <div
                        key={key}
                        className={`status-proportion-segment ${STATUS_META[key].chip}`}
                        style={{ width: `${(count / fileStatusTotal) * 100}%` }}
                        title={`${STATUS_META[key].label}: ${count}`}
                      />
                    )
                  ))}
                </div>
                <div className="status-legend">
                  {Object.entries(stats.file_status).map(([key, count]) => (
                    <div className="status-legend-item" key={key}>
                      <span className={`status-legend-dot ${STATUS_META[key].chip}`}></span>
                      <span className="status-legend-label">{STATUS_META[key].label}</span>
                      <span className="status-legend-value">{count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card.Body>
        </Card>

        <Card className="chart-card">
          <Card.Header>
            <Card.Title>Top Campaigns by Files</Card.Title>
          </Card.Header>
          <Card.Body>
            {topCampaigns.length === 0 ? (
              <div className="text-center py-4">
                <i className="bi bi-folder text-muted" style={{ fontSize: '2.5rem' }}></i>
                <p className="text-muted mt-3 mb-0">No campaigns yet</p>
              </div>
            ) : (
              <div className="top-campaign-list">
                {topCampaigns.map(c => (
                  <Link to={`/campaigns/${c.id}`} className="top-campaign-row" key={c.id}>
                    <span className="top-campaign-name">{c.display_name}</span>
                    <div className="top-campaign-bar-track">
                      <div
                        className="top-campaign-bar-fill"
                        style={{ width: `${((c.data_files_count || 0) / topCampaignMax) * 100}%` }}
                      />
                    </div>
                    <span className="top-campaign-count">{c.data_files_count || 0}</span>
                  </Link>
                ))}
              </div>
            )}
          </Card.Body>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="dashboard-row dashboard-recent-row">
        <Card className="recent-card">
          <Card.Header className="d-flex justify-content-between align-items-center">
            <Card.Title>Recent Reports</Card.Title>
            <span className="count-pill">{stats?.recent_reports?.length || 0}</span>
          </Card.Header>
          <Card.Body>
            {stats?.recent_reports?.length > 0 ? (
              <div className="recent-list">
                {stats.recent_reports.slice(0, 5).map((report) => (
                  <div key={report.id} className="recent-item">
                    <div className="recent-item-icon">
                      <i className="bi bi-file-earmark-excel"></i>
                    </div>
                    <div className="recent-item-content">
                      <h6>{report.parameters?.report_name || 'Unnamed Report'}</h6>
                      <small className="text-muted">
                        {report.generated_at ? new Date(report.generated_at).toLocaleDateString() : 'N/A'}
                        {report.campaign_name && (
                          <span className="recent-chip ms-2">{report.campaign_name}</span>
                        )}
                      </small>
                    </div>
                    <div className="recent-item-action">
                      <a
                        href={`/api/reports/${report.id}/download/`}
                        className="btn btn-sm btn-primary"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <i className="bi bi-download"></i>
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-5">
                <i className="bi bi-file-earmark-excel text-muted" style={{ fontSize: '3rem' }}></i>
                <p className="text-muted mt-3">No reports generated yet</p>
              </div>
            )}
          </Card.Body>
        </Card>

        <Card className="recent-card">
          <Card.Header className="d-flex justify-content-between align-items-center">
            <Card.Title>Recent File Uploads</Card.Title>
            <span className="count-pill">{stats?.recent_files?.length || 0}</span>
          </Card.Header>
          <Card.Body>
            {stats?.recent_files?.length > 0 ? (
              <div className="recent-list">
                {stats.recent_files.slice(0, 5).map((file) => (
                  <div key={file.id} className="recent-item">
                    <div className="recent-item-icon">
                      <i className="bi bi-file-earmark-excel"></i>
                    </div>
                    <div className="recent-item-content">
                      <h6 title={file.original_name}>
                        {file.original_name?.slice(0, 30) || 'Unnamed File'}
                        {file.original_name?.length > 30 ? '...' : ''}
                      </h6>
                      <small className="text-muted">
                        {file.uploaded_at ? new Date(file.uploaded_at).toLocaleDateString() : 'N/A'}
                        {file.campaign_name && (
                          <span className="recent-chip ms-2">{file.campaign_name}</span>
                        )}
                        <span className={`ms-2 status-badge ${file.status || 'unknown'}`}>
                          {file.status || 'unknown'}
                        </span>
                      </small>
                    </div>
                    <div className="recent-item-action">
                      <span className="file-size-badge">
                        {file.file_size ? `${(file.file_size / 1024 / 1024).toFixed(1)} MB` : 'N/A'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-5">
                <i className="bi bi-upload text-muted" style={{ fontSize: '3rem' }}></i>
                <p className="text-muted mt-3">No files uploaded yet</p>
              </div>
            )}
          </Card.Body>
        </Card>
      </div>

      {/* Campaigns List */}
      {campaigns.length > 0 && (
        <Card className="mt-4">
          <Card.Header>
            <Card.Title>Your Campaigns</Card.Title>
          </Card.Header>
          <Card.Body>
            <div className="dashboard-campaign-grid">
              {campaigns.slice(0, 9).map(campaign => (
                <Card className="campaign-mini-card" key={campaign.id}>
                  <Card.Body>
                    <div className="d-flex align-items-center mb-2">
                      <div className="campaign-mini-icon me-2">
                        <i className="bi bi-megaphone"></i>
                      </div>
                      <h6 className="mb-0">{campaign.display_name}</h6>
                    </div>
                    <div className="small text-muted mb-3">
                      Sheet: <code>{campaign.sheet_name}</code>
                    </div>
                    <div className="campaign-mini-stats d-flex gap-2">
                      <span className="recent-chip">{campaign.data_files_count || 0} files</span>
                      <span className="recent-chip">{campaign.reports_count || 0} reports</span>
                    </div>
                    <div className="mt-3">
                      <Link
                        to={`/campaigns/${campaign.id}`}
                        className="btn btn-sm btn-outline-primary w-100"
                      >
                        View Campaign
                      </Link>
                    </div>
                  </Card.Body>
                </Card>
              ))}
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Quick Actions */}
      <Card className="quick-actions-card mt-4">
        <Card.Header>
          <Card.Title>Quick Actions</Card.Title>
        </Card.Header>
        <Card.Body>
          <div className="quick-action-grid">
            <Link to="/outcomes" className="quick-action-link">
              <div className="quick-action-icon">
                <i className="bi bi-plus-circle"></i>
              </div>
              <h6>Add Outcome</h6>
            </Link>

            <Link to="/campaigns" className="quick-action-link">
              <div className="quick-action-icon">
                <i className="bi bi-folder"></i>
              </div>
              <h6>View Campaigns</h6>
            </Link>

            <Link to="/campaigns" className="quick-action-link">
              <div className="quick-action-icon">
                <i className="bi bi-upload"></i>
              </div>
              <h6>Upload Data</h6>
            </Link>

            <Link to="/campaigns" className="quick-action-link">
              <div className="quick-action-icon">
                <i className="bi bi-file-earmark-bar-graph"></i>
              </div>
              <h6>Generate Report</h6>
            </Link>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
};

export default Dashboard;
