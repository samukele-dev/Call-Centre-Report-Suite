// src/context/QASyncContext.js
//
// Owns QA syncs and downloads at the app level instead of inside QA.js. A sync
// of a big campaign takes minutes; when the loop lived in the QA page's own
// state, navigating to Campaigns / Export Data / Agent Reports unmounted it
// and the progress (and the Stop button) was lost while the server kept
// working. Here it keeps running across page changes, QASyncStatus shows it
// on every page, Stop works from anywhere, and a browser notification fires
// when a sync or download finishes.
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import DashboardService from '../api/dashboardService';
import { describeError } from '../utils/errorMessages';

const QASyncContext = createContext(null);

export const useQASync = () => useContext(QASyncContext);

// Browser notification (shown even when this tab isn't focused). Permission is
// asked for on the user's own click that starts a sync/download — browsers
// ignore prompts that don't come from a user gesture. Never throws: some
// browsers/contexts (insecure origins, embedded views) don't support it, and
// the on-page card is always shown regardless.
const askNotificationPermission = () => {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch { /* unsupported — the on-page card still shows */ }
};

const notify = (title, body) => {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: 'qa-activity' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* unsupported */ }
};

export const QASyncProvider = ({ children }) => {
  const [syncing, setSyncing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(null); // { index, total, campaignName }
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState(null); // { variant: 'success' | 'danger' | 'warning', text }
  // Bumped after every finished job so whichever page is showing QA data can refetch.
  const [completedTick, setCompletedTick] = useState(0);
  // Bumped whenever the server-side "Recent activity" list has changed.
  const [activityTick, setActivityTick] = useState(0);

  const abortRef = useRef(null);
  const stopRequestedRef = useRef(false);
  const currentCampaignIdRef = useRef(null);
  // Set synchronously (before any await) so a fast double-click can't start two
  // loops — state updates are batched and wouldn't be visible yet.
  const inFlightRef = useRef(false);
  const downloadInFlightRef = useRef(false);

  // jobs: [{ campaignId, campaignName, startDate, startTime, endDate, endTime }],
  // synced one at a time so progress shows per job and a Stop skips the rest.
  const runSync = useCallback(async (jobs) => {
    if (inFlightRef.current || !jobs || jobs.length === 0) return;
    inFlightRef.current = true;
    stopRequestedRef.current = false;
    askNotificationPermission();
    setSyncing(true);
    setStopping(false);
    setMessage(null);

    const total = jobs.length;
    const results = [];

    for (let i = 0; i < total; i++) {
      if (stopRequestedRef.current) break;
      const job = jobs[i];
      const campaignName = job.campaignName || `Campaign ${job.campaignId}`;
      setProgress({ index: i + 1, total, campaignName });

      const controller = new AbortController();
      abortRef.current = controller;
      currentCampaignIdRef.current = job.campaignId;
      const result = await DashboardService.syncQACache([job.campaignId], controller.signal, {
        startDate: job.startDate, endDate: job.endDate, startTime: job.startTime, endTime: job.endTime,
      });
      abortRef.current = null;
      currentCampaignIdRef.current = null;

      if (result.aborted) break;

      if (result.success) {
        const entry = (result.data?.results || [])[0];
        if (entry && !entry.cancelled) results.push(entry);
        if (entry && entry.cancelled) break;
      } else {
        results.push({ campaign_id: job.campaignId, campaign: campaignName, error: result.error });
      }
      setCompletedTick(t => t + 1);
      setActivityTick(t => t + 1);
    }

    const stoppedEarly = stopRequestedRef.current;
    inFlightRef.current = false;
    setProgress(null);
    setSyncing(false);
    setStopping(false);
    setCompletedTick(t => t + 1);
    setActivityTick(t => t + 1);

    const failed = results.filter(r => r.error);
    const ok = results.filter(r => !r.error);
    const okCount = ok.reduce((sum, r) => sum + (r.records_synced || 0), 0);
    if (failed.length > 0) {
      const text = `Sync failed for: ${failed.map(f => `${f.campaign} (${describeError(f.error, 'unknown error')})`).join('; ')}`;
      setMessage({ variant: 'danger', text });
      notify('QA sync failed', text);
    } else if (stoppedEarly) {
      setMessage({
        variant: 'warning',
        text: `Sync stopped — ${okCount.toLocaleString()} record${okCount === 1 ? '' : 's'} saved before stopping. Ranges that didn't finish stay flagged as not synced.`,
      });
    } else if (results.length > 0) {
      const text = `Synced ${okCount.toLocaleString()} record${okCount === 1 ? '' : 's'} (${ok.length} of ${total} sync${total === 1 ? '' : 's'}).`;
      setMessage({ variant: 'success', text });
      notify('QA sync finished', text);
    }
  }, []);

  const stopSync = useCallback(() => {
    if (!inFlightRef.current) return;
    stopRequestedRef.current = true;
    setStopping(true);
    const campaignId = currentCampaignIdRef.current;
    // Tell the server first (it halts the pull between source-DB windows), then
    // drop the browser's wait on the request.
    const cancel = campaignId != null ? DashboardService.cancelQASync([campaignId]) : Promise.resolve();
    cancel.finally(() => {
      if (abortRef.current) abortRef.current.abort();
    });
  }, []);

  // filters: { campaignIds, startDate, endDate, startTime, endTime, outcomes }.
  // Runs here (not in QA.js) so leaving the page mid-download doesn't lose it;
  // the file is also saved server-side and listed under Recent activity.
  const runDownload = useCallback(async (filters) => {
    if (downloadInFlightRef.current) return;
    downloadInFlightRef.current = true;
    askNotificationPermission();
    setDownloading(true);
    setMessage(null);
    try {
      const result = await DashboardService.downloadQARecords(filters);
      if (result.success) {
        saveAs(result.data, `QA_Records_${new Date().toISOString().slice(0, 10)}.xlsx`);
        const text = 'Your QA download is ready — it was saved to your downloads and is listed under Recent activity on the QA page.';
        setMessage({ variant: 'success', text });
        notify('QA download ready', 'The file was saved to your downloads. It is also under Recent activity on the QA page.');
      } else {
        const text = describeError(result.error, 'Could not download QA records');
        setMessage({ variant: 'danger', text });
        notify('QA download failed', text);
      }
    } finally {
      downloadInFlightRef.current = false;
      setDownloading(false);
      setActivityTick(t => t + 1);
    }
  }, []);

  const dismissMessage = useCallback(() => setMessage(null), []);

  return (
    <QASyncContext.Provider
      value={{
        syncing, downloading, progress, stopping, message, completedTick, activityTick,
        runSync, stopSync, runDownload, dismissMessage,
      }}
    >
      {children}
    </QASyncContext.Provider>
  );
};
