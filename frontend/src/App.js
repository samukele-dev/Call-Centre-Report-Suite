// src/App.js - FINAL VERSION
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import './App.css';

// Layout
import Layout from './components/Layout/Layout';

// Global Pages
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import OutcomeDescriptions from './pages/OutcomeDescriptions';  // Keep this global

// Campaign Pages
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import CampaignUpload from './pages/CampaignUpload';
import CampaignTemplates from './pages/CampaignTemplates';
import CampaignReports from './pages/CampaignReports';
import CampaignAnalysis from './pages/CampaignAnalysis';

// REMOVED: UploadData, Reports (standalone pages)

// Components
import ProtectedRoute from './components/ProtectedRoute';

function App() {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          {/* Public route */}
          <Route path="/login" element={<Login />} />
          
          {/* Protected routes - Dashboard */}
          <Route path="/" element={
            <ProtectedRoute>
              <Layout>
                <Dashboard />
              </Layout>
            </ProtectedRoute>
          } />
          
          {/* Global Outcomes Page */}
          <Route path="/outcomes" element={
            <ProtectedRoute>
              <Layout>
                <OutcomeDescriptions />
              </Layout>
            </ProtectedRoute>
          } />
          
          {/* Campaign Routes */}
          <Route path="/campaigns" element={
            <ProtectedRoute>
              <Layout>
                <Campaigns />
              </Layout>
            </ProtectedRoute>
          } />
          
          <Route path="/campaigns/:id" element={
            <ProtectedRoute>
              <Layout>
                <CampaignDetail />
              </Layout>
            </ProtectedRoute>
          } />
          
          <Route path="/campaigns/:id/upload" element={
            <ProtectedRoute>
              <Layout>
                <CampaignUpload />
              </Layout>
            </ProtectedRoute>
          } />
          
          <Route path="/campaigns/:id/templates" element={
            <ProtectedRoute>
              <Layout>
                <CampaignTemplates />
              </Layout>
            </ProtectedRoute>
          } />
          
          <Route path="/campaigns/:id/reports" element={
            <ProtectedRoute>
              <Layout>
                <CampaignReports />
              </Layout>
            </ProtectedRoute>
          } />
          
          <Route path="/campaigns/:id/analysis" element={
            <ProtectedRoute>
              <Layout>
                <CampaignAnalysis />
              </Layout>
            </ProtectedRoute>
          } />
                    
          {/* Catch all route - redirect to campaigns */}
          <Route path="*" element={<Navigate to="/campaigns" />} />
        </Routes>
      </AuthProvider>
    </Router>
  );
}

export default App;