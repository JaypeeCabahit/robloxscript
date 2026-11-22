/* Sign in at https://www.roblox.com and paste this entire file into Chrome's Console.
   Search for the recipient, enter an amount, choose Review transfer, then Send Robux.
   Uses Roblox's authenticated web requests. Roblox Plus and transfer eligibility apply.
   No extension is needed. If Roblox requires verification, complete it through Roblox.
   Robux is sent only after clicking Send Robux. Review prepares the transfer first.
   Request flow checked against RoValra's public source, independently implemented here.
   https://github.com/NotValra/RoValra/blob/main/src/content/features/plus/sendRobux.js
*/
(() => {
  'use strict';

  if (!/^(www\.)?roblox\.com$/.test(location.hostname)) {
    console.warn('Open roblox.com and run this again.');
    return;
  }

  const currentProfile = location.pathname.match(/^\/users\/([1-9]\d*)\/profile\/?$/);
  const robloxWebsite = 'https://www.roblox.com';
  const usersApi = 'https://users.roblox.com/v1/users';
  const thumbnailsApi = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';
  const transferApi = 'https://apis.roblox.com/transfer/v1/robux-transfer';
  const avatarCache = new Map();
  const avatarRequests = new Map();
  const searchRequests = new Map();
  const knownUsers = new Map();
  const searchStateKey = 'robux-transfer-user-search';
  let savedSearch = {};
  try { savedSearch = JSON.parse(sessionStorage.getItem(searchStateKey)) || {}; } catch { /* Start with an empty cache. */ }
  const searchCache = new Map(Array.isArray(savedSearch.cache) ? savedSearch.cache : []);
  const searchCooldowns = { exact: Number(savedSearch.exactUntil) || 0, fuzzy: Number(savedSearch.fuzzyUntil) || 0 };
  let nextFuzzySearchAt = Number(savedSearch.nextFuzzySearchAt) || 0;
  for (const cached of searchCache.values()) {
    if (cached.expiresAt > Date.now()) {
      for (const user of cached.data || []) knownUsers.set(String(user.id), user);
    }
  }
  const panelId = 'robux-transfer-draft-popup';
  const existingHost = document.getElementById(panelId);
  if (existingHost?._transferPopup) {
    existingHost._transferPopup.focus();
    return;
  }
  if (existingHost?.shadowRoot?.querySelector('dialog')?.open) {
    existingHost.shadowRoot.querySelector('dialog').close();
  }
  existingHost?.remove();

  function element(tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function robuxIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'robux-icon');
    icon.setAttribute('aria-hidden', 'true');
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.setAttribute('d', 'M12 2 21 7v10l-9 5-9-5V7Z');
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', 'currentColor');
    outline.setAttribute('stroke-width', '1.6');
    outline.setAttribute('stroke-linejoin', 'round');
    const center = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    center.setAttribute('d', 'M12 6 17 9v6l-5 3-5-3V9ZM10 10v4h4v-4Z');
    center.setAttribute('fill', 'currentColor');
    center.setAttribute('fill-rule', 'evenodd');
    icon.append(outline, center);
    return icon;
  }

  function showRobux(node, value) {
    const text = new Intl.NumberFormat('en-US').format(value);
    node.setAttribute('aria-label', text + ' Robux');
    node.replaceChildren(robuxIcon(), element('span', text));
  }

  function createAvatar(userId, username) {
    const avatar = element('span', '', { class: 'avatar', 'aria-hidden': 'true' });
    avatar.dataset.userId = String(userId);
    const placeholder = element('span', (username || '?').charAt(0).toUpperCase());
    const image = element('img', '', { alt: '', width: '44', height: '44', hidden: '', referrerpolicy: 'no-referrer' });
    image.addEventListener('load', () => { image.hidden = false; placeholder.hidden = true; });
    image.addEventListener('error', () => { image.hidden = true; placeholder.hidden = false; });
    avatar.append(placeholder, image);
    return avatar;
  }

  async function loadAvatars(avatars, signal) {
    const missingIds = [...new Set(avatars.map((avatar) => avatar.dataset.userId))]
      .filter((id) => !avatarCache.has(id) && !avatarRequests.has(id));
    if (missingIds.length) {
      const batch = (async () => {
        try {
          const url = new URL(thumbnailsApi);
          url.search = new URLSearchParams({ userIds: missingIds.join(','), size: '100x100', format: 'Png', isCircular: 'true' });
          const response = await fetch(url, { credentials: 'omit',
            signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(8000)]) });
          if (response.ok) {
            const { data } = await response.json();
            for (const thumbnail of data || []) {
              if (thumbnail.state === 'Completed' && typeof thumbnail.imageUrl === 'string' && thumbnail.imageUrl.startsWith('https://')) {
                avatarCache.set(String(thumbnail.targetId), thumbnail.imageUrl);
              }
            }
          }
        } catch { /* Keep the placeholder if Roblox cannot provide an image. */ }
        finally { for (const id of missingIds) avatarRequests.delete(id); }
      })();
      for (const id of missingIds) avatarRequests.set(id, batch);
    }
    await Promise.allSettled(avatars.map((avatar) => avatarRequests.get(avatar.dataset.userId)));
    if (signal.aborted) return;
    for (const avatar of avatars) {
      const url = avatarCache.get(avatar.dataset.userId);
      if (url && avatar.isConnected) avatar.querySelector('img').src = url;
    }
  }

  const host = element('div', '', { id: panelId });
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host { color-scheme: light; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    dialog {
      width: min(460px, calc(100% - 32px)); max-width: none; padding: 0;
      max-height: calc(100vh - 32px); overflow-y: auto;
      border: 1px solid #d5dde8; border-radius: 16px; background: #fff;
      color: #172336; font: 14px/1.5 system-ui, sans-serif;
      box-shadow: 0 20px 64px #0f172a44;
    }
    dialog::backdrop { background: #0f172aaf; }
    header, section, form { padding: 20px 24px; }
    header { display: flex; align-items: flex-start; gap: 12px; justify-content: space-between; }
    header, section { border-bottom: 1px solid #e2e8f0; }
    h2 { margin: 0; font-size: 20px; line-height: 1.3; }
    p { margin: 4px 0 0; color: #485970; }
    a { color: #144ea6; font-weight: 650; overflow-wrap: anywhere; }
    label, .label { display: block; margin: 0 0 6px; font-weight: 650; }
    input {
      width: 100%; padding: 10px 12px; border: 1px solid #94a3b8;
      border-radius: 8px; font: inherit; color: inherit; background: #fff;
    }
    button {
      border: 1px solid #b5c1d0; border-radius: 8px; padding: 8px 13px;
      background: #fff; color: #172336; font: inherit; font-weight: 650;
      cursor: pointer; white-space: nowrap;
    }
    button:hover { background: #f1f5f9; }
    .primary { background: #1456b8; border-color: #1456b8; color: white; }
    .primary:hover { background: #11468f; }
    :focus-visible { outline: 3px solid #60a5fa; outline-offset: 2px; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .total { margin: 0; font-size: 24px; font-weight: 700; color: #172336; }
    .status:empty { display: none; }
    .status { margin-top: 10px; }
    .search { padding: 0; }
    .search-row, .recipient-row { display: flex; gap: 10px; align-items: center; }
    .search-row input, .recipient-row > div { min-width: 0; flex: 1; }
    .results { display: grid; gap: 6px; margin-top: 10px; max-height: 240px; overflow: auto; padding: 4px; }
    .results:empty { display: none; }
    .result { width: 100%; display: flex; gap: 12px; align-items: center; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    .result-names { min-width: 0; }
    .avatar { position: relative; display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; background: #e8eef6; color: #4b607a; }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .avatar-slot { display: flex; flex: none; }
    .username { display: block; color: #485970; font-size: 13px; font-weight: 500; }
    .fallback { display: inline-block; margin-top: 8px; }
    button:disabled { opacity: .5; cursor: default; }
    .notice { font-size: 13px; padding-top: 12px; }
    .error { color: #b42318; }
    .account { padding-top: 0; }
    .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .robux-icon { display: inline-block; width: 1em; height: 1em; flex: none; vertical-align: -.12em; }
    .money, .presets button { display: inline-flex; align-items: center; gap: 6px; }
    .account-line { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
    .allowances { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
    .allowance { padding: 12px; background: #f4f7fb; border: 1px solid #e2e8f0; border-radius: 10px; }
    .allowance p { margin: 0; }
    .allowance-value { font-size: 18px; font-weight: 700; color: #172336; margin: 3px 0 !important; }
    .allowance small { display: block; color: #65758a; }
    .allowance progress { display: block; width: 100%; height: 5px; margin: 9px 0 0; accent-color: #1456b8; }
    .allowance-footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 9px; }
    .allowance-footer p { margin: 0; font-size: 12px; }
    .allowance-footer button { padding: 4px 8px; font-size: 12px; }
    .success { padding: 24px; }
    .success-hero { text-align: center; padding: 0 0 20px; }
    .success-check { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto 12px; border-radius: 50%; color: #15803d; background: #e9f7ee; font-size: 28px; font-weight: 700; }
    .success-total { justify-content: center; color: #172336; font-size: 34px; font-weight: 750; }
    .success-recipient { display: flex; justify-content: center; align-items: center; gap: 9px; margin-top: 12px; }
    .success-recipient .avatar { width: 36px; height: 36px; flex-basis: 36px; }
    .receipt { margin: 0; padding: 14px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
    .receipt-row { display: grid; grid-template-columns: 76px 1fr; gap: 12px; margin: 6px 0; }
    .receipt-row dt { color: #65758a; }
    .receipt-row dd { margin: 0; text-align: right; overflow-wrap: anywhere; color: #172336; }
    .success .actions { flex-wrap: wrap; }
    .success .actions a { align-self: center; font-size: 13px; margin-right: auto; }
  `);
  shadow.adoptedStyleSheets = [styles];

  const dialog = element('dialog', '', { 'aria-labelledby': 'transfer-title' });
  const header = element('header');
  const heading = element('div');
  const closeButton = element('button', 'Close', { type: 'button' });
  const transferTitle = element('h2', 'Send Robux', { id: 'transfer-title' });
  heading.append(transferTitle);
  header.append(heading, closeButton);

  const accountSection = element('section', '', { class: 'account' });
  const accountLabel = element('p', 'Checking your signed-in Roblox account…');
  const accountStatus = element('p', '', { class: 'status', role: 'status' });
  const reloadButton = element('button', 'Reload account', { type: 'button', hidden: '' });
  const allowanceGrid = element('div', '', { class: 'allowances' });
  function allowanceCard(label) {
    const card = element('div', '', { class: 'allowance' });
    const value = element('p', 'Loading…', { class: 'allowance-value money' });
    const cap = element('small');
    const progress = element('progress', '', { max: '1', value: '0', 'aria-label': label + ' used' });
    card.append(element('p', label), value, cap, progress);
    allowanceGrid.append(card);
    return { value, cap, progress };
  }
  const dailyAllowance = allowanceCard('Daily remaining');
  const monthlyAllowance = allowanceCard('Monthly remaining');
  const allowanceFooter = element('div', '', { class: 'allowance-footer' });
  const allowanceNote = element('p', 'History estimate · last 24h / 30 days', { role: 'status' });
  const refreshAllowanceButton = element('button', 'Refresh', { type: 'button', 'aria-label': 'Refresh balance and allowances' });
  allowanceFooter.append(allowanceNote, refreshAllowanceButton);
  accountSection.append(accountLabel, allowanceGrid, allowanceFooter, accountStatus, reloadButton);

  const recipientSection = element('section');
  const searchForm = element('form', '', { class: 'search', role: 'search' });
  const searchField = element('input', '', {
    id: 'recipient-search', type: 'text', placeholder: '@username or profile link',
    required: '', autocomplete: 'off', maxlength: '300',
  });
  const searchRow = element('div', '', { class: 'search-row' });
  searchRow.append(searchField, element('button', 'Search', { type: 'submit', class: 'primary' }));
  const searchStatus = element('p', '', { class: 'status', role: 'status' });
  const searchResults = element('div', '', { id: 'recipient-suggestions', class: 'results', 'aria-label': 'Matching Roblox users' });
  searchField.setAttribute('aria-controls', 'recipient-suggestions');
  const peopleSearchLink = element('a', 'Open Roblox People search', {
    class: 'fallback', target: '_blank', rel: 'noopener noreferrer', hidden: '',
  });
  searchForm.append(element('label', 'Find recipient', { for: 'recipient-search' }), searchRow,
    searchStatus, searchResults, peopleSearchLink);

  const selectedRecipient = element('div', '', { class: 'recipient-row', hidden: '' });
  const selectedAvatar = element('span', '', { class: 'avatar-slot' });
  const recipientDetails = element('div');
  const recipientLink = element('a', '', { target: '_blank', rel: 'noopener noreferrer' });
  const changeRecipientButton = element('button', 'Change', { type: 'button', 'aria-label': 'Change recipient' });
  recipientDetails.append(element('p', 'Recipient', { class: 'label' }), recipientLink);
  selectedRecipient.append(selectedAvatar, recipientDetails, changeRecipientButton);
  recipientSection.append(searchForm, selectedRecipient);

  const form = element('form', '', { hidden: '' });
  const amount = element('input', '', {
    id: 'robux-amount', name: 'amount', type: 'number', min: '10', step: '1',
    required: '', inputmode: 'numeric', placeholder: '100',
  });
  const editFields = element('div');
  const editActions = element('div', '', { class: 'actions' });
  const reviewButton = element('button', 'Review transfer', { type: 'submit', class: 'primary' });
  reviewButton.disabled = true;
  const presets = element('div', '', { class: 'presets' });
  for (const value of [25, 50, 100, 200]) {
    const preset = element('button', String(value), { type: 'button' });
    showRobux(preset, value);
    preset.addEventListener('click', () => {
      amount.value = String(value);
      amount.setCustomValidity('');
      amount.focus();
    });
    presets.append(preset);
  }
  const limitsLabel = element('p', '', { class: 'notice' });
  const prepareStatus = element('p', '', { class: 'status', role: 'status' });
  editActions.append(reviewButton);
  editFields.append(element('label', 'Amount in Robux', { for: 'robux-amount' }), amount,
    presets, limitsLabel, prepareStatus, editActions);

  const review = element('div', '', { hidden: '' });
  const total = element('p', '', { class: 'total money' });
  const status = element('p', '', { class: 'status', role: 'status' });
  const reviewActions = element('div', '', { class: 'actions' });
  const editButton = element('button', 'Edit amount', { type: 'button' });
  const sendButton = element('button', 'Send Robux', { type: 'button', class: 'primary' });
  const reviewedRecipient = element('p');
  const transactionsLink = element('a', 'Open My Transactions', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer', hidden: '',
  });
  const acknowledgedButton = element('button', 'I checked My Transactions', { type: 'button', hidden: '' });
  const newTransferButton = element('button', 'New transfer', { type: 'button', hidden: '' });
  reviewActions.append(editButton, sendButton);
  review.append(reviewedRecipient, total,
    element('p', 'Confirm the @username and amount. Transfers are final.', { class: 'notice' }),
    reviewActions, status, transactionsLink, acknowledgedButton, newTransferButton);
  form.append(editFields, review);

  const successPanel = element('section', '', { class: 'success', hidden: '' });
  const successHero = element('div', '', { class: 'success-hero' });
  const successAmount = element('div', '', { class: 'success-total money' });
  const successRecipient = element('div', '', { class: 'success-recipient' });
  successHero.append(element('div', '✓', { class: 'success-check', 'aria-hidden': 'true' }),
    successAmount, successRecipient);
  const receipt = element('dl', '', { class: 'receipt' });
  function receiptRow(label) {
    const row = element('div', '', { class: 'receipt-row' });
    const value = element('dd');
    row.append(element('dt', label), value);
    receipt.append(row);
    return value;
  }
  const receiptSender = receiptRow('From');
  const receiptTime = receiptRow('Time');
  const receiptReference = receiptRow('Reference');
  const successActions = element('div', '', { class: 'actions' });
  const successTransactions = element('a', 'View transactions', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer',
  });
  const copyReceiptButton = element('button', 'Copy receipt', { type: 'button' });
  newTransferButton.className = 'primary';
  newTransferButton.textContent = 'Send another';
  successActions.append(successTransactions, copyReceiptButton, newTransferButton);
  const receiptStatus = element('p', '', { role: 'status', class: 'status' });
  successPanel.append(successHero, receipt, successActions, receiptStatus);
  dialog.append(header, accountSection, recipientSection, form, successPanel);
  shadow.append(dialog);

  let recipient;
  let searchRequest;
  let suggestionTimer;
  let displayedUsers = [];
  let renderedUserCount = 0;
  let resultSignal;
  let usageTransfers = [];
  let usageReady = false;
  let usageRequest;
  let acceptedTransfers = [];
  let lastReceipt;
  let account;
  let limits;
  let balance;
  let prepared;
  let busy = false;
  let locked = false;
  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.dataset.token || '';
  const pendingKey = 'robux-transfer-popup-pending';
  const profileLookups = new AbortController();
  const previousFocus = document.activeElement;
  host._transferPopup = { focus: () => dialog.focus() };
  closeButton.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    clearSearch();
    profileLookups.abort();
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }, { once: true });

  function setBusy(value) {
    busy = value;
    closeButton.disabled = value;
    changeRecipientButton.disabled = value || locked;
    editButton.disabled = value || locked;
    sendButton.disabled = value || locked || !prepared;
    reviewButton.disabled = value || locked || !account || !limits;
    reloadButton.disabled = value;
    amount.disabled = value;
    for (const button of presets.children) button.disabled = value;
    newTransferButton.disabled = value;
    refreshAllowanceButton.disabled = value || Boolean(usageRequest);
  }

  function describeError(response, data) {
    if (response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length) {
      return 'Roblox requires verification or parent approval. Complete the required step through Roblox.';
    }
    if (response.status === 401) return 'Your Roblox session expired. Sign in and reload the page.';
    if (response.status === 429) return 'Roblox rate limited the request. Wait before trying again.';
    const detail = data?.errorMessage || data?.errors?.[0]?.message || data?.failureReason || data?.message;
    return 'Roblox returned HTTP ' + response.status + '. ' + (detail || 'Check your transfer eligibility.');
  }

  async function api(url, body, { signal, processing = false } = {}) {
    const headers = { Accept: 'application/json' };
    const options = {
      method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
      redirect: 'error', headers, signal: signal || AbortSignal.timeout(30000),
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;
      options.body = JSON.stringify(body);
    }
    let response;
    let data;
    try {
      response = await fetch(url, options);
      data = await response.json().catch(() => null);
      const refreshed = response.headers.get('x-csrf-token');
      const hasChallenge = response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length;
      // A rejected CSRF request has no transfer effect. Refresh once, then stop on errors.
      if (body && response.status === 403 && refreshed && !hasChallenge) {
        csrfToken = refreshed;
        headers['X-CSRF-TOKEN'] = refreshed;
        response = await fetch(url, options);
        data = await response.json().catch(() => null);
      }
    } catch {
      throw new Error(processing
        ? 'The connection ended before Roblox returned a transfer result.'
        : 'Could not reach Roblox. The request may be blocked by the browser, connection, or Roblox authentication.');
    }
    if (!response.ok || response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length || data?.failureReason || data?.success === false) {
      const error = new Error(describeError(response, data));
      error.definitelyRejected = [400, 401, 403, 404, 422, 429].includes(response.status);
      throw error;
    }
    if (!data) throw new Error('Roblox returned an empty response.');
    return data;
  }

  function updateAccountDisplay() {
    const balanceValue = element('span', '', { class: 'money' });
    showRobux(balanceValue, balance);
    accountLabel.className = 'account-line';
    accountLabel.replaceChildren(element('span', 'From @' + account.name), balanceValue);
    amount.max = String(limits.perTransferLimit);
    limitsLabel.textContent = '10–' + limits.perTransferLimit + ' Robux per transfer.';
    if (balance < 10) limitsLabel.textContent = 'Your balance is below the 10 Robux minimum.';
  }

  function saveAcceptedTransfers() {
    try {
      sessionStorage.setItem('robux-transfer-recent:' + account.id, JSON.stringify(acceptedTransfers));
    } catch { /* Keep the local allowance adjustment in memory. */ }
  }

  function displayAllowances() {
    const seenIds = new Set(usageTransfers.map((transfer) => transfer.id));
    acceptedTransfers = acceptedTransfers.filter((transfer) => !seenIds.has(transfer.id));
    saveAcceptedTransfers();
    const transfers = [...usageTransfers, ...acceptedTransfers];
    const now = Date.now();
    for (const [card, rawCap, windowDays] of [
      [dailyAllowance, limits?.dailyLimit, 1],
      [monthlyAllowance, limits?.monthlyLimit, 30],
    ]) {
      const cap = Number(rawCap);
      if (rawCap == null || !Number.isSafeInteger(cap) || cap < 0) {
        card.value.textContent = 'Unavailable';
        card.cap.textContent = 'Account cap unavailable';
        card.progress.hidden = true;
        continue;
      }
      card.cap.textContent = 'of ' + new Intl.NumberFormat('en-US').format(cap) + ' Robux allowance';
      card.progress.max = Math.max(1, cap);
      card.progress.hidden = !usageReady;
      if (!usageReady) {
        card.value.textContent = 'Unavailable';
        continue;
      }
      const used = transfers.reduce((sum, transfer) =>
        transfer.createdMs > now - windowDays * 86400000 ? sum + transfer.amount : sum, 0);
      showRobux(card.value, Math.max(0, cap - used));
      card.progress.value = Math.min(cap, used);
    }
  }

  async function fetchTransferHistory(userId) {
    const grouped = new Map();
    const seenRows = new Set();
    const seenCursors = new Set();
    const cutoff = Date.now() - 30 * 86400000;
    let cursor = '';
    do {
      if (seenCursors.has(cursor)) throw new Error('Roblox repeated a history page.');
      seenCursors.add(cursor);
      const url = new URL('https://apis.roblox.com/transaction-records/v1/users/' + userId + '/transactions');
      url.search = new URLSearchParams({ cursor, limit: '100', transactionType: 'CurrencyTransfer', itemPricingType: 'PaidAndLimited' });
      const page = await api(url, undefined, {
        signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(15000)]),
      });
      if (!Array.isArray(page.data)) throw new Error('Roblox did not return transfer history.');
      for (const row of page.data) {
        const details = row.details || {};
        if (String(details.senderTargetId) !== String(userId)) continue;
        const value = Number(row.currency?.amount);
        const createdMs = Date.parse(row.created);
        if (!Number.isFinite(value) || !Number.isFinite(createdMs)) continue;
        if (row.idHash && seenRows.has(row.idHash)) continue;
        if (row.idHash) seenRows.add(row.idHash);
        const isSent = details.transferRole === 'Sender' && value < 0;
        const isRefund = details.transferRole === 'SenderRefund' && value > 0;
        if (!isSent && !isRefund) continue;
        const id = String(details.transferRequestId || row.idHash || row.created + ':' + Math.abs(value));
        const transfer = grouped.get(id) || { id, amount: 0, createdMs };
        transfer.amount -= value;
        if (isSent) transfer.createdMs = Math.min(transfer.createdMs, createdMs);
        grouped.set(id, transfer);
      }
      const oldest = Date.parse(page.data[page.data.length - 1]?.created);
      if (Number.isFinite(oldest) && oldest < cutoff) break;
      cursor = page.nextPageCursor || '';
    } while (cursor);
    return Array.from(grouped.values()).map((transfer) => ({ ...transfer, amount: Math.max(0, transfer.amount) }));
  }

  async function refreshUsage(force = false) {
    if (!account) return;
    if (usageRequest) {
      await usageRequest;
      if (!account || profileLookups.signal.aborted) return;
      return refreshUsage(force);
    }
    const owner = account;
    const cacheKey = 'robux-transfer-usage:' + owner.id;
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem(cacheKey)); } catch { /* Fetch current history. */ }
    if (!force && cached?.fetchedAt > Date.now() - 120000 && Array.isArray(cached.transfers)) {
      usageTransfers = cached.transfers;
      usageReady = true;
      displayAllowances();
      allowanceNote.textContent = 'History estimate · last 24h / 30 days';
      return;
    }
    allowanceNote.textContent = 'Updating transfer history…';
    usageRequest = (async () => {
      try {
        const transfers = await fetchTransferHistory(owner.id);
        if (account?.id !== owner.id || profileLookups.signal.aborted) return;
        usageTransfers = transfers;
        usageReady = true;
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ transfers, fetchedAt: Date.now() })); } catch { /* Cache is optional. */ }
        displayAllowances();
        allowanceNote.textContent = 'History estimate · last 24h / 30 days';
      } catch {
        if (profileLookups.signal.aborted) return;
        displayAllowances();
        allowanceNote.textContent = usageReady ? 'Last history estimate · refresh unavailable' : 'Remaining allowance unavailable · try Refresh';
      } finally {
        usageRequest = null;
        refreshAllowanceButton.disabled = busy;
      }
    })();
    refreshAllowanceButton.disabled = true;
    return usageRequest;
  }

  async function refreshAccountStats() {
    if (!account) return;
    const owner = account;
    refreshAllowanceButton.disabled = true;
    try {
      const [currency, transferLimits] = await Promise.all([
        api('https://economy.roblox.com/v1/user/currency'),
        api(transferApi + '/user-transfer-limit'),
      ]);
      if (account !== owner || profileLookups.signal.aborted) return;
      if (!Number.isSafeInteger(currency.robux) || !Number.isSafeInteger(transferLimits.perTransferLimit)) {
        throw new Error('Account refresh unavailable');
      }
      balance = currency.robux;
      limits = transferLimits;
      updateAccountDisplay();
      await refreshUsage(true);
    } catch {
      allowanceNote.textContent = 'Account refresh unavailable · try Refresh';
    } finally {
      refreshAllowanceButton.disabled = busy || Boolean(usageRequest);
    }
  }
  refreshAllowanceButton.addEventListener('click', () => { if (!busy) refreshAccountStats(); });

  function showSuccess(transfer) {
    const submittedAt = new Date();
    lastReceipt = { ...transfer, sender: account.name, submittedAt: submittedAt.toLocaleString() };
    acceptedTransfers.push({ id: transfer.id, amount: transfer.amount, createdMs: submittedAt.getTime() });
    displayAllowances();
    transferTitle.textContent = 'Transfer submitted';
    recipientSection.hidden = true;
    form.hidden = true;
    successPanel.hidden = false;
    showRobux(successAmount, transfer.amount);
    const avatar = createAvatar(transfer.recipientId, transfer.username);
    successRecipient.replaceChildren(avatar, element('a', '@' + transfer.username, {
      href: robloxWebsite + '/users/' + transfer.recipientId + '/profile', target: '_blank', rel: 'noopener noreferrer',
    }));
    loadAvatars([avatar], profileLookups.signal);
    receiptSender.textContent = '@' + account.name;
    receiptTime.textContent = lastReceipt.submittedAt;
    receiptReference.textContent = transfer.id;
    receiptStatus.textContent = '';
    newTransferButton.hidden = false;
    refreshAccountStats();
  }

  copyReceiptButton.addEventListener('click', async () => {
    if (!lastReceipt) return;
    try {
      await navigator.clipboard.writeText([
        'Robux transfer submitted',
        'From: @' + lastReceipt.sender,
        'To: @' + lastReceipt.username + ' (' + lastReceipt.recipientId + ')',
        'Amount: ' + lastReceipt.amount + ' Robux',
        'Time: ' + lastReceipt.submittedAt,
        'Reference: ' + lastReceipt.id,
      ].join('\n'));
      receiptStatus.textContent = 'Receipt copied.';
    } catch { receiptStatus.textContent = 'Clipboard unavailable. You can select the receipt text.'; }
  });

  async function loadAccount() {
    if (busy || locked) return;
    setBusy(true);
    account = null;
    limits = null;
    accountStatus.textContent = '';
    reloadButton.hidden = true;
    try {
      const [user, transferLimits, currency] = await Promise.all([
        api(usersApi + '/authenticated'),
        api(transferApi + '/user-transfer-limit'),
        api('https://economy.roblox.com/v1/user/currency'),
      ]);
      if (!Number.isSafeInteger(user.id) || !user.name || !Number.isSafeInteger(transferLimits.perTransferLimit) ||
          !Number.isSafeInteger(currency.robux) || currency.robux < 0) {
        throw new Error('Roblox did not provide valid account and transfer-limit details.');
      }
      account = user;
      limits = transferLimits;
      balance = currency.robux;
      try {
        const recent = JSON.parse(sessionStorage.getItem('robux-transfer-recent:' + user.id));
        acceptedTransfers = (Array.isArray(recent) ? recent : []).filter((transfer) =>
          typeof transfer.id === 'string' && Number.isFinite(transfer.amount) && transfer.amount > 0 &&
          Number.isFinite(transfer.createdMs) && transfer.createdMs > Date.now() - 30 * 86400000);
      } catch { acceptedTransfers = []; }
      usageTransfers = [];
      usageReady = false;
      updateAccountDisplay();
      displayAllowances();
      refreshUsage();
    } catch (error) {
      accountLabel.textContent = 'Account details unavailable';
      accountStatus.textContent = error.message;
      reloadButton.hidden = false;
    } finally {
      setBusy(false);
    }
  }
  reloadButton.addEventListener('click', loadAccount);

  function showAmountEditor() {
    if (busy || locked) return;
    prepared = null;
    review.hidden = true;
    editFields.hidden = false;
    prepareStatus.textContent = '';
    setBusy(false);
    amount.focus();
  }

  function clearSearch() {
    clearTimeout(suggestionTimer);
    searchRequest?.abort();
    searchRequest = null;
    searchResults.replaceChildren();
    displayedUsers = [];
    renderedUserCount = 0;
    searchStatus.textContent = '';
    peopleSearchLink.hidden = true;
  }

  function saveSearchState() {
    try {
      sessionStorage.setItem(searchStateKey, JSON.stringify({
        cache: Array.from(searchCache.entries()).filter(([, item]) => item.expiresAt > Date.now()).slice(-50),
        exactUntil: searchCooldowns.exact,
        fuzzyUntil: searchCooldowns.fuzzy,
        nextFuzzySearchAt,
      }));
    } catch { /* The in-memory cache still works if storage is unavailable. */ }
  }

  function matchingUsers(query) {
    const key = query.toLowerCase();
    return Array.from(knownUsers.values()).filter((user) =>
      user.name.toLowerCase().includes(key) || (user.displayName || '').toLowerCase().includes(key)
    ).sort((a, b) => Number(b.name.toLowerCase() === key) - Number(a.name.toLowerCase() === key)).slice(0, 50);
  }

  function renderUsers(users, signal) {
    searchResults.replaceChildren();
    searchResults.scrollTop = 0;
    displayedUsers = users;
    renderedUserCount = 0;
    resultSignal = signal;
    appendUserBatch();
  }

  function appendUserBatch() {
    if (!resultSignal || resultSignal.aborted) return;
    const avatars = [];
    const batch = displayedUsers.slice(renderedUserCount, renderedUserCount + 5);
    renderedUserCount += batch.length;
    for (const user of batch) {
      const username = '@' + user.name;
      const result = element('button', '', { type: 'button', class: 'result' });
      const avatar = createAvatar(user.id, user.name);
      const names = element('span', user.displayName || username, { class: 'result-names' });
      if (user.displayName) names.append(element('span', username, { class: 'username' }));
      result.append(avatar, names);
      avatars.push(avatar);
      result.addEventListener('click', () => selectRecipient(String(user.id), user.name));
      searchResults.append(result);
    }
    loadAvatars(avatars, resultSignal);
  }

  searchResults.addEventListener('scroll', () => {
    if (searchResults.scrollTop + searchResults.clientHeight >= searchResults.scrollHeight - 24) appendUserBatch();
  });

  async function lookupUsers(query, kind) {
    const key = kind + ':' + query.toLowerCase();
    const cached = searchCache.get(key);
    if (cached?.expiresAt > Date.now()) return cached.data;
    if (searchRequests.has(key)) return searchRequests.get(key);

    const availableAt = Math.max(searchCooldowns[kind], kind === 'fuzzy' ? nextFuzzySearchAt : 0);
    if (Date.now() < availableAt) {
      const error = new Error('Search is cooling down');
      error.kind = kind;
      error.retryAt = availableAt;
      error.rateLimited = Date.now() < searchCooldowns[kind];
      throw error;
    }
    if (kind === 'fuzzy') {
      nextFuzzySearchAt = Date.now() + 15000;
      saveSearchState();
    }

    const pending = (async () => {
      try {
        const options = { credentials: 'omit',
          signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(8000)]) };
        let url;
        if (kind === 'exact') {
          url = 'https://users.roblox.com/v1/usernames/users';
          options.method = 'POST';
          options.headers = { 'Content-Type': 'application/json' };
          options.body = JSON.stringify({ usernames: [query], excludeBannedUsers: true });
        } else {
          url = new URL(usersApi + '/search');
          url.search = new URLSearchParams({ keyword: query, limit: '10' });
        }
        const response = await fetch(url, options);
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const seconds = Number(retryAfter);
          const retryAt = retryAfter && Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000
            : Date.parse(retryAfter) || Date.now() + 60000;
          searchCooldowns[kind] = Math.max(Date.now() + 1000, retryAt);
          saveSearchState();
          const error = new Error('Roblox is limiting searches');
          error.kind = kind;
          error.rateLimited = true;
          error.retryAt = searchCooldowns[kind];
          throw error;
        }
        if (!response.ok) throw new Error('Roblox search is unavailable');
        const { data } = await response.json();
        const users = (Array.isArray(data) ? data : []).filter((user) =>
          Number.isSafeInteger(user.id) && user.id > 0 && typeof user.name === 'string' &&
          (kind !== 'exact' || user.name.toLowerCase() === query.toLowerCase())
        );
        for (const user of users) knownUsers.set(String(user.id), user);
        searchCache.set(key, { data: users, expiresAt: Date.now() + (users.length ? 300000 : 30000) });
        saveSearchState();
        return users;
      } finally {
        searchRequests.delete(key);
      }
    })();
    searchRequests.set(key, pending);
    return pending;
  }

  function selectRecipient(userId, username) {
    if (busy || locked) return;
    clearSearch();
    const selection = { userId, profileUrl: robloxWebsite + '/users/' + userId + '/profile' };
    recipient = selection;
    const avatar = createAvatar(userId, username);
    selectedAvatar.replaceChildren(avatar);
    loadAvatars([avatar], AbortSignal.any([profileLookups.signal, AbortSignal.timeout(8000)]));
    recipientLink.href = selection.profileUrl;
    recipientLink.textContent = username ? '@' + username : 'Roblox user #' + userId;
    searchForm.hidden = true;
    selectedRecipient.hidden = false;
    form.hidden = false;
    showAmountEditor();

    if (!username) {
      const signal = AbortSignal.any([profileLookups.signal, AbortSignal.timeout(5000)]);
      fetch(usersApi + '/' + userId, { credentials: 'omit', signal })
        .then((response) => response.ok ? response.json() : null)
        .then((user) => {
          if (recipient === selection && String(user?.id) === userId && user.name) {
            recipientLink.textContent = '@' + user.name;
          }
        })
        .catch(() => { /* The profile link and user ID remain available. */ });
    }
  }

  searchField.addEventListener('input', () => {
    clearSearch();
    if (!searchField.value.trim()) return;
    if (searchField.value.trim().replace(/^@/, '').length < 3) {
      searchStatus.textContent = 'Type at least 3 characters for suggestions.';
      return;
    }
    searchRequest = new AbortController();
    const query = searchField.value.trim().replace(/^@/, '');
    renderUsers(matchingUsers(query), searchRequest.signal);
    suggestionTimer = setTimeout(() => searchUsers(true), 900);
  });
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    return searchUsers(false);
  });
  searchField.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && searchResults.children.length) {
      event.preventDefault();
      searchResults.children[0].focus();
    }
    if (event.key === 'Escape' && searchResults.children.length) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
    }
  });
  searchResults.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      searchField.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(searchResults.children);
    const current = buttons.indexOf(event.target.closest('button'));
    if (current < 0) return;
    event.preventDefault();
    const next = current + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) searchField.focus();
    else {
      if (next === buttons.length) appendUserBatch();
      searchResults.children[Math.min(next, searchResults.children.length - 1)].focus();
    }
  });

  async function searchUsers(automatic) {
    if (locked || searchForm.hidden) return;
    clearSearch();
    const query = searchField.value.trim().replace(/^@/, '');
    const profile = query.match(/^https:\/\/(?:www\.)?roblox\.com\/users\/([1-9]\d*)\/profile\/?(?:[?#].*)?$/i);
    if (profile) {
      if (automatic) {
        searchStatus.textContent = 'Press Search to use this profile.';
        return;
      }
      selectRecipient(profile[1]);
      return;
    }
    if (!query || query.length > 50) {
      searchStatus.textContent = 'Enter a Roblox username or paste a Roblox profile link.';
      return;
    }

    const request = new AbortController();
    searchRequest = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
    renderUsers(matchingUsers(query), signal);
    searchStatus.textContent = 'Finding recipient…';
    try {
      let users = [];
      if (/^[a-z0-9_]{3,20}$/i.test(query)) users = await lookupUsers(query, 'exact');
      if (searchRequest !== request) return;
      if (!users.length) {
        const local = matchingUsers(query);
        if (automatic && local.length) users = local;
        else users = await lookupUsers(query, 'fuzzy');
      }
      if (searchRequest !== request) return;
      renderUsers(users, signal);
      searchStatus.textContent = users.length ? 'Select the correct @username.' : 'No users found. Check the spelling.';
    } catch (error) {
      if (searchRequest !== request) return;
      if (error.retryAt) {
        searchStatus.textContent = error.kind === 'exact'
          ? 'Username lookup is temporarily limited. Wait a moment, or paste a profile link.'
          : 'Partial-name search is cooling down. Enter the full @username for a direct lookup.';
      } else {
        searchStatus.textContent = 'Search is unavailable. You can paste a Roblox profile link here.';
      }
      peopleSearchLink.href = robloxWebsite + '/search/users?keyword=' + encodeURIComponent(query);
      peopleSearchLink.hidden = false;
      if (automatic && error.kind === 'fuzzy' && error.retryAt && !error.rateLimited) {
        suggestionTimer = setTimeout(() => searchUsers(true), Math.max(0, error.retryAt - Date.now()));
      }
    }
  }

  changeRecipientButton.addEventListener('click', () => {
    if (busy || locked) return;
    prepared = null;
    recipient = null;
    selectedRecipient.hidden = true;
    form.hidden = true;
    searchForm.hidden = false;
    searchField.focus();
    searchField.select();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!recipient || !account || !limits || busy || locked || !review.hidden) return;
    const value = amount.valueAsNumber;
    if (!Number.isSafeInteger(value) || value < 10 || value > limits.perTransferLimit || value > balance) {
      amount.setCustomValidity(balance < 10 ? 'Your balance is below the 10 Robux minimum.'
        : 'Enter 10–' + Math.min(limits.perTransferLimit, balance) + ' whole Robux.');
      amount.reportValidity();
      return;
    }
    if (String(account.id) === recipient.userId) {
      prepareStatus.textContent = 'Choose a recipient other than your own account.';
      return;
    }
    setBusy(true);
    prepareStatus.textContent = 'Preparing transfer with Roblox…';
    try {
      const target = await api(usersApi + '/' + recipient.userId);
      if (String(target.id) !== recipient.userId || !target.name) throw new Error('Could not verify the recipient.');
      const transfer = await api(transferApi + '/initiate-transfer', { transferOrigin: 1, recipientId: target.id });
      if (typeof transfer.transferRequestId !== 'string' || !transfer.transferRequestId) {
        throw new Error('Roblox did not provide a transfer request ID.');
      }
      prepared = Object.freeze({ id: transfer.transferRequestId, senderId: account.id,
        recipientId: target.id, username: target.name, amount: value });
      recipientLink.textContent = '@' + target.name;
      reviewedRecipient.textContent = 'To @' + target.name + ' · User ID ' + target.id;
      showRobux(total, value);
      status.textContent = '';
      transactionsLink.hidden = true;
      editFields.hidden = true;
      review.hidden = false;
      sendButton.hidden = false;
    } catch (error) {
      prepared = null;
      prepareStatus.textContent = error.message;
    } finally {
      setBusy(false);
    }
    if (prepared) sendButton.focus();
  });
  amount.addEventListener('input', () => amount.setCustomValidity(''));
  editButton.addEventListener('click', showAmountEditor);
  sendButton.addEventListener('click', async () => {
    if (!prepared || busy || locked) return;
    const transfer = prepared;
    setBusy(true);
    status.textContent = 'Checking sender…';
    try {
      const currentUser = await api(usersApi + '/authenticated');
      if (currentUser.id !== transfer.senderId) throw new Error('Your signed-in account changed. Reload the page.');
      // Preserve an uncertain attempt across refreshes. Never retry a timed-out payment.
      sessionStorage.setItem(pendingKey, JSON.stringify(transfer));
      locked = true;
      status.textContent = 'Sending ' + transfer.amount + ' Robux to @' + transfer.username + '…';
      try {
        await api(transferApi + '/process-transfer/' + encodeURIComponent(transfer.id),
          { robuxAmount: transfer.amount }, { processing: true });
        sessionStorage.removeItem(pendingKey);
        showSuccess(transfer);
      } catch (error) {
        if (error.definitelyRejected) {
          sessionStorage.removeItem(pendingKey);
          locked = false;
        } else {
          acknowledgedButton.hidden = false;
        }
        status.textContent = error.definitelyRejected ? error.message
          : error.message + ' The outcome is unconfirmed. Check My Transactions before sending again.';
      }
      prepared = null;
      sendButton.hidden = true;
      transactionsLink.hidden = false;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });

  acknowledgedButton.addEventListener('click', () => {
    if (busy) return;
    sessionStorage.removeItem(pendingKey);
    locked = false;
    acknowledgedButton.hidden = true;
    recipientSection.hidden = false;
    form.hidden = !recipient;
    showAmountEditor();
    loadAccount();
  });

  newTransferButton.addEventListener('click', () => {
    if (busy) return;
    locked = false;
    prepared = null;
    recipient = null;
    newTransferButton.hidden = true;
    successPanel.hidden = true;
    transferTitle.textContent = 'Send Robux';
    recipientSection.hidden = false;
    selectedRecipient.hidden = true;
    searchForm.hidden = false;
    form.hidden = true;
    amount.value = '';
    searchField.value = '';
    clearSearch();
    loadAccount();
    searchField.focus();
  });

  document.body.append(host);
  dialog.showModal();
  if (currentProfile) selectRecipient(currentProfile[1]);
  else searchField.focus();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey)); } catch { /* No saved attempt. */ }
  if (pending?.id) {
    locked = true;
    recipientSection.hidden = true;
    form.hidden = false;
    editFields.hidden = true;
    review.hidden = false;
    sendButton.hidden = true;
    reviewedRecipient.textContent = 'Previous request to @' + pending.username;
    showRobux(total, pending.amount);
    status.textContent = 'A previous result is unconfirmed. Check My Transactions before sending again.';
    transactionsLink.hidden = false;
    acknowledgedButton.hidden = false;
    accountLabel.textContent = 'Check the previous request first';
    dailyAllowance.value.textContent = 'Unavailable';
    monthlyAllowance.value.textContent = 'Unavailable';
    allowanceNote.textContent = 'Check the previous request before refreshing';
    setBusy(false);
  } else {
    loadAccount();
  }
})();
