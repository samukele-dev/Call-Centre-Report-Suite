// src/components/QASyncStatus.js
// Floating card, shown on every page, for the QA sync that QASyncProvider is
// running — so you can leave the QA page (to Campaigns, Export Data, Agent
// Reports…) and still see it, or stop it.
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQASync } from '../context/QASyncContext';

const QASyncStatus = () => {
  const { syncing, downloading, progress, stopping, message, stopSync, dismissMessage } = useQASync();
  const { pathname } = useLocation();

  if (!syncing && !downloading && !message) return null;

  return (
    <div className="qa-sync-floating" role="status" aria-live="polite">
      {downloading && !syncing ? (
        <>
          <div className="qa-sync-floating-title">
            <span className="spinner-border spinner-border-sm me-2"></span>
            Preparing your QA download…
          </div>
          <div className="qa-sync-floating-note">
            You can use other pages — you'll be notified when it's ready.
          </div>
        </>
      ) : syncing ? (
        <>
          <div className="qa-sync-floating-title">
            <span className="spinner-border spinner-border-sm me-2"></span>
            Syncing QA data{progress ? ` — ${progress.index} of ${progress.total}` : ''}
          </div>
          {progress && <div className="qa-sync-floating-sub">{progress.campaignName}</div>}
          {progress && (
            <div className="qa-sync-progress-bar" aria-hidden="true">
              <div
                className="qa-sync-progress-fill"
                style={{ width: `${Math.round(((progress.index - 1) / progress.total) * 100)}%` }}
              />
            </div>
          )}
          <div className="qa-sync-floating-note">
            It keeps running while you use other pages.
          </div>
          <div className="d-flex gap-2 mt-2">
            <button className="btn btn-sm btn-outline-danger" onClick={stopSync} disabled={stopping}>
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
            {pathname !== '/qa' && (
              <Link className="btn btn-sm btn-outline-secondary" to="/qa">Open QA</Link>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={`qa-sync-floating-title text-${message.variant}`}>{message.text}</div>
          <div className="d-flex gap-2 mt-2">
            {pathname !== '/qa' && (
              <Link className="btn btn-sm btn-outline-secondary" to="/qa">Open QA</Link>
            )}
            <button className="btn btn-sm btn-outline-secondary" onClick={dismissMessage}>Dismiss</button>
          </div>
        </>
      )}
    </div>
  );
};

export default QASyncStatus;
