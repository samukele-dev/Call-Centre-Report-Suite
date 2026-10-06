// Turns whatever a failed request produced (an axios error, an API payload,
// a bare string) into one readable sentence for the user, and holds the small
// "what is still missing?" validators the search/sync forms share.
//
// Why this exists: the service layer used to return
// `error.response?.data?.error || error.response?.data || 'Failed ...'`,
// which can be an object (DRF field errors, {detail: ...}) that renders as
// "[object Object]", or a whole HTML error page from Render's proxy on a
// 502/504, and it said nothing useful for a dropped connection or timeout.

const looksLikeHtml = (s) => /^\s*<(!doctype|html|head|body)/i.test(s);

const prettyField = (name) =>
  name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// Pull a human message out of an API response body (string / array / object).
export function messageFromPayload(data) {
  if (data == null) return null;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return null;

  if (typeof data === 'string') {
    const text = data.trim();
    if (!text || looksLikeHtml(text)) return null;
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  if (Array.isArray(data)) {
    const parts = data.map(messageFromPayload).filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (typeof data === 'object') {
    for (const key of ['error', 'detail', 'message']) {
      const m = messageFromPayload(data[key]);
      if (m) return m;
    }
    // DRF validation errors: { field: ["msg", ...], non_field_errors: [...] }
    const parts = Object.entries(data)
      .map(([field, value]) => {
        const m = messageFromPayload(value);
        if (!m) return null;
        return field === 'non_field_errors' ? m : `${prettyField(field)}: ${m}`;
      })
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  return String(data);
}

const STATUS_MESSAGES = {
  400: 'The request was not valid. Check your selections and try again.',
  401: 'Your session has expired. Please log in again.',
  403: "You don't have permission to do that.",
  404: 'That could not be found. It may have been deleted or moved.',
  413: 'That file is too large to upload.',
  429: 'Too many requests in a short time. Wait a minute and try again.',
  500: 'The server hit an unexpected error. Try again, and if it keeps happening tell an administrator.',
  502: 'The server is restarting or overloaded. Wait a minute and try again.',
  503: 'The server is temporarily unavailable. Wait a minute and try again.',
  504: 'The server took too long to answer. A big sync can keep running in the background: wait a few minutes and check for the new file, or retry with a shorter date range or fewer batches.',
};

// Known backend/database failures whose raw text means nothing to a user.
function friendlyBackendMessage(message) {
  if (/statement timeout/i.test(message)) {
    return 'The call-centre database took too long to answer this search. Try a shorter date range (a few days) or pick specific batches, then run it again.';
  }
  if (/could not connect to external database|cannot reach database server|connection refused|server closed the connection/i.test(message)) {
    return "Can't reach the call-centre database right now. Wait a minute and try again; if it keeps failing, ask an administrator to check that this server is allowed to connect to it.";
  }
  return message;
}

// Turn any failure into one readable sentence. `fallback` is used when there
// is nothing more specific to say.
export function describeError(error, fallback = 'Something went wrong. Please try again.') {
  if (error == null) return fallback;
  if (typeof error === 'string') return messageFromPayload(error) || fallback;

  const response = error.response;

  // Never got an answer: offline, backend asleep/down, blocked, or timed out.
  if (!response) {
    if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
      return 'The request timed out. The server may be busy: wait a moment and try again, or narrow your selection (dates, batches).';
    }
    if (error.message === 'Network Error' || error.request) {
      return "Can't reach the server. Check your internet connection. If the system has been idle it may be waking up: wait a minute and try again.";
    }
    return messageFromPayload(error.message) || fallback;
  }

  const status = response.status;
  const fromServer = messageFromPayload(response.data);

  // 502/503/504 come from Render's proxy, not the app: any body is useless.
  if (status === 502 || status === 503 || status === 504) {
    return STATUS_MESSAGES[status];
  }
  // For anything else, the app's own message (e.g. "No records returned for
  // campaign X between …") is more useful than a generic status line —
  // except raw database jargon, which gets translated first.
  if (fromServer) return friendlyBackendMessage(fromServer);
  return STATUS_MESSAGES[status] || `${fallback} (error ${status})`;
}

// ---------------------------------------------------------------------------
// Form validation: each returns null when fine, or a sentence naming exactly
// what still needs to be chosen/fixed.
// ---------------------------------------------------------------------------

// missing: [[value, 'label'], ...] -> "Please select a campaign and a file."
export function requireSelections(missing) {
  const labels = missing.filter(([value]) => !value || (Array.isArray(value) && !value.length))
    .map(([, label]) => label);
  if (!labels.length) return null;
  const list = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Please select ${list} before continuing.`;
}

// Checks a From/To (+ optional times) selection.
export function validateDateRange({ startDate, endDate, startTime, endTime } = {}) {
  if (startDate && endDate) {
    const start = new Date(`${startDate}T${startTime || '00:00'}`);
    const end = new Date(`${endDate}T${endTime || '23:59'}`);
    if (start > end) {
      return endDate < startDate
        ? `The "To" date (${endDate}) is before the "From" date (${startDate}). Swap them or pick a later "To" date.`
        : `On ${startDate} the "From" time (${startTime}) is after the "To" time (${endTime}).`;
    }
  }
  if (startTime && !startDate) return 'You picked a "From" time but no "From" date. Pick the date too, or clear the time.';
  if (endTime && !endDate) return 'You picked a "To" time but no "To" date. Pick the date too, or clear the time.';
  const today = new Date().toISOString().slice(0, 10);
  if (startDate && startDate > today) return `The "From" date (${startDate}) is in the future.`;
  return null;
}

// One-line plain-English description of what a date selection will pull, so
// users can see how a half-filled range is interpreted before they run it.
export function describeDateRange({ startDate, endDate }) {
  if (startDate && endDate) {
    return startDate === endDate ? `Calls made on ${startDate}.` : `Calls made from ${startDate} to ${endDate}.`;
  }
  if (startDate) return `Calls made from ${startDate} up to now.`;
  if (endDate) return `Calls made up to ${endDate} (from the campaign's first batch). This can take a while.`;
  return 'No date limit: every call for the selected batches. This can take a long time for big campaigns.';
}
