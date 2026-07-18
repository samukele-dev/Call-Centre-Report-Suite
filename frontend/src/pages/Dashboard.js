// src/pages/Dashboard.js - FIXED VERSION
import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Spinner, Alert, Button, Badge } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import DashboardService from '../api/dashboardService';
import { Bar, Pie } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  Filler
} from 'chart.js';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  Filler
);

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
      // Fetch dashboard stats
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

      // Fetch campaigns separately
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

  // Modern gradient chart data
  const callDataChart = {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [
      {
        label: 'Successful Calls',
        data: [65, 59, 80, 81, 56, 55, 40],
        backgroundColor: 'rgba(99, 102, 241, 0.8)',
        borderColor: 'rgba(99, 102, 241, 1)',
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      },
      {
        label: 'Failed Calls',
        data: [28, 48, 40, 19, 86, 27, 90],
        backgroundColor: 'rgba(220, 53, 69, 0.8)',
        borderColor: 'rgba(220, 53, 69, 1)',
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      },
    ],
  };

  const outcomeDistributionChart = {
    labels: ['True Contacts', 'Unsuccessful', 'Unworkable'],
    datasets: [
      {
        data: [30, 50, 20],
        backgroundColor: [
          'rgba(99, 102, 241, 0.8)',
          'rgba(217, 119, 6, 0.8)',
          'rgba(220, 53, 69, 0.8)',
        ],
        borderColor: [
          'rgba(99, 102, 241, 1)',
          'rgba(217, 119, 6, 1)',
          'rgba(220, 53, 69, 1)',
        ],
        borderWidth: 2,
        hoverOffset: 15,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          font: {
            size: 12,
            family: "'Inter', sans-serif"
          },
          padding: 20,
          usePointStyle: true,
        }
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        cornerRadius: 8,
        titleFont: {
          size: 13,
          weight: '600'
        },
        bodyFont: {
          size: 13
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        grid: {
          color: 'rgba(0, 0, 0, 0.05)'
        },
        ticks: {
          font: {
            size: 11
          }
        }
      },
      x: {
        grid: {
          display: false
        },
        ticks: {
          font: {
            size: 11
          }
        }
      }
    }
  };

  const pieOptions = {
    ...chartOptions,
    plugins: {
      ...chartOptions.plugins,
      legend: {
        position: 'bottom',
        labels: {
          ...chartOptions.plugins.legend.labels,
          padding: 15
        }
      }
    }
  };

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
        <div className="error-icon">⚠️</div>
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
      </div>

      {/* Charts Section */}
      <Row className="dashboard-row">
        <Col lg={8} className="mb-4">
          <Card className="chart-card">
            <Card.Header>
              <Card.Title>Weekly Call Performance</Card.Title>
            </Card.Header>
            <Card.Body>
              <div className="chart-container">
                <Bar 
                  data={callDataChart} 
                  options={chartOptions}
                />
              </div>
            </Card.Body>
          </Card>
        </Col>
        
        <Col lg={4} className="mb-4">
          <Card className="chart-card">
            <Card.Header>
              <Card.Title>Outcome Distribution</Card.Title>
            </Card.Header>
            <Card.Body>
              <div className="chart-container">
                <Pie 
                  data={outcomeDistributionChart} 
                  options={pieOptions}
                />
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Recent Activity */}
      <Row className="dashboard-row">
        <Col lg={6} className="mb-4">
          <Card className="recent-card">
            <Card.Header>
              <Card.Title>Recent Reports</Card.Title>
              <Badge bg="primary" pill>{stats?.recent_reports?.length || 0}</Badge>
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
                            <Badge bg="info" className="ms-2">{report.campaign_name}</Badge>
                          )}
                          <span className="ms-2 badge bg-success">Excel</span>
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
        </Col>
        
        <Col lg={6} className="mb-4">
          <Card className="recent-card">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <Card.Title>Recent File Uploads</Card.Title>
              <Badge bg="success" pill>{stats?.recent_files?.length || 0}</Badge>
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
                            <Badge bg="info" className="ms-2">{file.campaign_name}</Badge>
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
        </Col>
      </Row>

      {/* Campaigns List */}
      {campaigns.length > 0 && (
        <Card className="mt-4">
          <Card.Header>
            <Card.Title>Your Campaigns</Card.Title>
          </Card.Header>
          <Card.Body>
            <Row>
              {campaigns.map(campaign => (
                <Col md={4} key={campaign.id} className="mb-3">
                  <Card className="h-100 campaign-mini-card">
                    <Card.Body>
                      <div className="d-flex align-items-center mb-2">
                        <div className="campaign-mini-icon me-2">
                          <i className="bi bi-megaphone"></i>
                        </div>
                        <h6 className="mb-0">{campaign.display_name}</h6>
                      </div>
                      <div className="small text-muted mb-2">
                        Sheet: <code>{campaign.sheet_name}</code>
                      </div>
                      <div className="campaign-mini-stats d-flex justify-content-between">
                        <span><Badge bg="info">{campaign.data_files_count || 0} files</Badge></span>
                        <span><Badge bg="success">{campaign.reports_count || 0} reports</Badge></span>
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
                </Col>
              ))}
            </Row>
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

      {/* Add some CSS for the new campaign cards */}
      <style jsx>{`
        .campaign-mini-card {
          transition: transform 0.2s;
          border: 1px solid #e9ecef;
        }
        .campaign-mini-card:hover {
          transform: translateY(-3px);
          box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .campaign-mini-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: #6366f1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 1rem;
        }
        .campaign-mini-stats {
          font-size: 0.85rem;
        }
      `}</style>
    </div>
  );
};

export default Dashboard;