// src/components/Layout/Layout.js
import React from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';

const SECTIONS = [
  { match: (p) => p.startsWith('/campaigns'), icon: 'bi-megaphone', label: 'Campaigns' },
  { match: (p) => p.startsWith('/outcomes'), icon: 'bi-list-check', label: 'Outcomes' },
  { match: () => true, icon: 'bi-speedometer2', label: 'Dashboard' },
];

const Layout = ({ children }) => {
  const location = useLocation();
  const section = SECTIONS.find((s) => s.match(location.pathname));

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-content">
        <div className="topbar-breadcrumb">
          <i className={`bi ${section.icon}`}></i>
          <span>{section.label}</span>
          <i className="bi bi-chevron-down breadcrumb-caret"></i>
        </div>
        <div className="page-container">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Layout;
