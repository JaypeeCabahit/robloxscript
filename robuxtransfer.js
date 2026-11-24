/* Sign in at https://www.roblox.com and paste this entire file into Chrome's Console.
   Search for the recipient, enter an amount, choose Review transfer, then Send Robux.
   Uses Roblox's authenticated web requests. Roblox Plus and transfer eligibility apply.
   No extension is needed. If Roblox requires verification, complete it through Roblox.
   Robux is sent only after clicking Send Robux. Review prepares the transfer first.
   Single-recipient sends refresh balance and limits, with two follow-up checks for delayed updates.
   Batch transfer spaces recipients 10 seconds apart and refreshes account data after the queue stops.
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
  const themeKey = 'robux-transfer-ui-theme';
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

  function svgIcon(paths, className = 'ui-icon', viewBox = '0 0 24 24') {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', viewBox);
    icon.setAttribute('class', className);
    icon.setAttribute('aria-hidden', 'true');
    for (const attrs of paths) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg', attrs.tag || 'path');
      for (const [k, v] of Object.entries(attrs)) {
        if (k !== 'tag') shape.setAttribute(k, v);
      }
      icon.append(shape);
    }
    return icon;
  }

  function robuxIcon() {
    return svgIcon([
      { d: 'M12 2 21 7v10l-9 5-9-5V7Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linejoin': 'round' },
      { d: 'M12 6 17 9v6l-5 3-5-3V9ZM10 10v4h4v-4Z', fill: 'currentColor', 'fill-rule': 'evenodd' },
    ], 'robux-icon');
  }

  function animatePanel(node) {
    if (!node) return;
    node.classList.remove('panel-enter');
    void node.offsetWidth;
    node.classList.add('panel-enter');
  }

  function showRobux(node, value) {
    const text = new Intl.NumberFormat('en-US').format(value);
    node.setAttribute('aria-label', text + ' Robux');
    node.replaceChildren(robuxIcon(), element('span', text));
  }

  function createAvatar(userId, username) {
    const avatar = element('span', '', { class: 'avatar', 'aria-hidden': 'true' });
    avatar.dataset.userId = String(userId);
    const placeholder = element('span', (username || '?').charAt(0).toUpperCase(), { class: 'avatar-fallback' });
    const image = element('img', '', { alt: '', width: '44', height: '44', hidden: '', referrerpolicy: 'no-referrer' });
    image.addEventListener('load', () => {
      image.hidden = false;
      image.classList.add('loaded');
      placeholder.hidden = true;
    });
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
          const response = await fetch(url, {
            credentials: 'omit',
            signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(8000)]),
          });
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

  function detectInitialTheme() {
    try {
      const saved = localStorage.getItem(themeKey);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch { /* Ignore storage errors. */ }
    if (document.body.classList.contains('dark-theme') || document.documentElement.classList.contains('dark-theme')) return 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const host = element('div', '', { id: panelId });
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host {
      --bg: #ffffff;
      --bg-elevated: #f8fafc;
      --surface: #f1f5f9;
      --surface-hover: #e8eef6;
      --border: rgba(15, 23, 42, 0.09);
      --border-strong: rgba(15, 23, 42, 0.16);
      --text: #0f172a;
      --text-muted: #52627a;
      --text-subtle: #7c8ba1;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-soft: rgba(37, 99, 235, 0.11);
      --accent-glow: rgba(37, 99, 235, 0.28);
      --accent-gradient: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%);
      --success: #16a34a;
      --success-soft: rgba(22, 163, 74, 0.12);
      --warn: #d97706;
      --warn-soft: rgba(217, 119, 6, 0.13);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.12);
      --shadow: 0 28px 70px -12px rgba(15, 23, 42, 0.34), 0 0 0 1px var(--border);
      --backdrop: rgba(15, 23, 42, 0.56);
      --ring: rgba(59, 130, 246, 0.45);
      --input-bg: #ffffff;
      --shimmer-a: rgba(148, 163, 184, 0.14);
      --shimmer-b: rgba(148, 163, 184, 0.28);
      --dialog-top: clamp(20px, 8vh, 68px);
      color-scheme: light;
    }

    :host([data-theme="dark"]) {
      --bg: #11151f;
      --bg-elevated: #171c29;
      --surface: #1d2434;
      --surface-hover: #252e42;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --text: #f1f5f9;
      --text-muted: #9aa7bd;
      --text-subtle: #6f7d96;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --accent-soft: rgba(59, 130, 246, 0.16);
      --accent-glow: rgba(59, 130, 246, 0.36);
      --accent-gradient: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
      --success: #22c55e;
      --success-soft: rgba(34, 197, 94, 0.16);
      --warn: #f59e0b;
      --warn-soft: rgba(245, 158, 11, 0.16);
      --danger: #f87171;
      --danger-soft: rgba(248, 113, 113, 0.15);
      --shadow: 0 32px 80px -10px rgba(0, 0, 0, 0.68), 0 0 0 1px var(--border);
      --backdrop: rgba(4, 7, 15, 0.72);
      --ring: rgba(96, 165, 250, 0.45);
      --input-bg: #151a26;
      --shimmer-a: rgba(255, 255, 255, 0.05);
      --shimmer-b: rgba(255, 255, 255, 0.13);
      color-scheme: dark;
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }

    @keyframes modalIn {
      from { opacity: 0; transform: translateY(18px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes modalOut {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to { opacity: 0; transform: translateY(12px) scale(0.96); }
    }
    @keyframes backdropIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes backdropOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    @keyframes panelEnter {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes itemIn {
      from { opacity: 0; transform: translateY(6px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.8); }
    }
    @keyframes popIn {
      0% { opacity: 0; transform: scale(0.6); }
      70% { opacity: 1; transform: scale(1.06); }
      100% { opacity: 1; transform: scale(1); }
    }
    @keyframes drawStroke {
      to { stroke-dashoffset: 0; }
    }
    @keyframes particleBurst {
      0% { opacity: 1; transform: translate(0, 0) scale(1); }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.2); }
    }

    .panel-enter { animation: panelEnter 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }

    dialog {
      position: fixed;
      inset: 0;
      margin: var(--dialog-top) auto auto;
      width: min(472px, calc(100% - 28px));
      max-width: none;
      max-height: calc(100vh - var(--dialog-top) - 20px);
      padding: 0;
      overflow-y: auto;
      overflow-x: hidden;
      border: 0;
      border-radius: 22px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: var(--shadow);
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
      animation: modalIn 0.34s cubic-bezier(0.22, 1, 0.36, 1) both;
      transition: background-color 0.25s ease, color 0.25s ease;
    }
    dialog::before {
      content: "";
      position: sticky;
      top: 0;
      display: block;
      height: 3px;
      width: 100%;
      background: var(--accent-gradient);
      z-index: 5;
    }
    dialog::backdrop {
      background: var(--backdrop);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: backdropIn 0.26s ease both;
    }
    dialog.closing {
      animation: modalOut 0.2s cubic-bezier(0.4, 0, 1, 1) both;
      pointer-events: none;
    }
    dialog.closing::backdrop {
      animation: backdropOut 0.2s ease both;
    }

    dialog::-webkit-scrollbar, .results::-webkit-scrollbar, .batch-list::-webkit-scrollbar { width: 6px; }
    dialog::-webkit-scrollbar-thumb, .results::-webkit-scrollbar-thumb, .batch-list::-webkit-scrollbar-thumb {
      background: var(--border-strong); border-radius: 999px;
    }

    header, section, form { padding: 18px 22px; }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      justify-content: space-between;
      padding: 18px 22px 14px;
    }
    section { border-top: 1px solid var(--border); }
    section.account { border-top: 0; padding-top: 4px; }

    /* Downward expand / collapse drawer for Batch mode */
    section.batch-panel {
      display: grid;
      grid-template-rows: 0fr;
      padding: 0;
      border-top: 0;
      opacity: 0;
      transition:
        grid-template-rows 0.38s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.24s ease;
    }
    section.batch-panel[data-open="true"] {
      grid-template-rows: 1fr;
      opacity: 1;
      transition:
        grid-template-rows 0.48s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.36s ease 0.06s;
    }
    .batch-panel-clip {
      min-height: 0;
      overflow: hidden;
    }
    .batch-panel-inner {
      padding: 18px 22px;
      border-top: 1px solid var(--border);
      transform: translateY(-16px) scale(0.985);
      transform-origin: top center;
      transition: transform 0.36s cubic-bezier(0.4, 0, 0.2, 1);
    }
    section.batch-panel[data-open="true"] .batch-panel-inner {
      transform: translateY(0) scale(1);
      transition: transform 0.48s cubic-bezier(0.22, 1, 0.36, 1);
    }
    section.batch-panel.no-transition,
    section.batch-panel.no-transition .batch-panel-inner {
      transition: none !important;
    }

    .brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .brand-badge {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 12px;
      background: var(--accent-gradient);
      color: #fff;
      font-size: 19px;
      box-shadow: 0 6px 18px var(--accent-glow);
      flex: none;
    }
    .header-controls { display: flex; align-items: center; gap: 6px; }

    h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; }
    h3 { margin: 0 0 6px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
    p { margin: 4px 0 0; color: var(--text-muted); }
    a {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
      overflow-wrap: anywhere;
      transition: color 0.18s ease, opacity 0.18s ease;
    }
    a:hover { text-decoration: underline; }
    label, .label { display: block; margin: 0 0 7px; font-size: 12.5px; font-weight: 650; color: var(--text-muted); letter-spacing: 0.01em; }

    .ui-icon { width: 17px; height: 17px; flex: none; display: block; }

    input {
      width: 100%;
      padding: 11px 13px;
      border: 1.5px solid var(--border-strong);
      border-radius: 12px;
      font: inherit;
      color: var(--text);
      background: var(--input-bg);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease;
    }
    input::placeholder { color: var(--text-subtle); }
    input:hover:not(:disabled) { border-color: var(--text-subtle); }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3.5px var(--accent-soft);
    }
    input:disabled { opacity: 0.55; cursor: not-allowed; }

    button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border: 1px solid var(--border-strong);
      border-radius: 11px;
      padding: 9px 14px;
      background: var(--bg-elevated);
      color: var(--text);
      font: inherit;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: transform 0.14s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.18s ease,
                  border-color 0.18s ease, box-shadow 0.2s ease, color 0.18s ease, opacity 0.18s ease;
    }
    button:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--text-subtle); }
    button:active:not(:disabled) { transform: scale(0.965); }
    button:disabled { opacity: 0.48; cursor: not-allowed; }

    .icon-btn {
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 10px;
      background: var(--surface);
      border-color: transparent;
      color: var(--text-muted);
    }
    .icon-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); border-color: var(--border); }
    .close-btn:hover:not(:disabled) svg { transform: rotate(90deg); }
    .close-btn svg { transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1); }

    .primary {
      background: var(--accent-gradient);
      border-color: transparent;
      color: #ffffff;
      box-shadow: 0 6px 18px -4px var(--accent-glow);
    }
    .primary:hover:not(:disabled) {
      filter: brightness(1.08);
      box-shadow: 0 10px 24px -4px var(--accent-glow);
      transform: translateY(-1px);
      background: var(--accent-gradient);
      border-color: transparent;
    }
    .primary:active:not(:disabled) { transform: translateY(0) scale(0.97); }
    .primary.is-busy::before {
      content: "";
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.35);
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    :focus-visible { outline: 2.5px solid var(--ring); outline-offset: 2px; }

    .mode-switch-wrap { padding: 0 22px 14px; }
    .mode-switch {
      position: relative;
      display: grid;
      grid-template-columns: 1fr 1fr;
      padding: 4px;
      border-radius: 13px;
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .mode-thumb {
      position: absolute;
      top: 4px;
      bottom: 4px;
      left: 4px;
      width: calc(50% - 4px);
      border-radius: 9.5px;
      background: var(--accent-gradient);
      box-shadow: 0 4px 14px -2px var(--accent-glow);
      transition: transform 0.34s cubic-bezier(0.34, 1.4, 0.64, 1);
      pointer-events: none;
    }
    .mode-switch[data-mode="batch"] .mode-thumb { transform: translateX(100%); }
    .mode-switch button {
      position: relative;
      z-index: 1;
      border: 0;
      background: transparent;
      box-shadow: none;
      padding: 8px 10px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .mode-switch button:hover:not(:disabled) { background: transparent; color: var(--text); }
    .mode-switch button[aria-pressed="true"] { color: #ffffff; }

    .account-card {
      padding: 13px 15px;
      border-radius: 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      transition: border-color 0.2s ease;
    }
    .account-line {
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--text);
      font-weight: 600;
    }
    .account-balance {
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .account-balance small { font-size: 11px; font-weight: 600; opacity: 0.8; }

    .allowances { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .allowance {
      padding: 12px 13px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 14px;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .allowance:hover { border-color: var(--border-strong); }
    .allowance-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .allowance-label { margin: 0; font-size: 12px; font-weight: 600; color: var(--text-muted); }
    .allowance-pct { font-size: 11px; font-weight: 650; color: var(--text-subtle); font-variant-numeric: tabular-nums; }
    .allowance-value {
      font-size: 18px;
      font-weight: 750;
      color: var(--text);
      margin: 4px 0 2px !important;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .allowance-value.is-loading {
      color: transparent;
      border-radius: 6px;
      background: linear-gradient(90deg, var(--shimmer-a) 25%, var(--shimmer-b) 50%, var(--shimmer-a) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.4s infinite linear;
      width: 72%;
    }
    .allowance small { display: block; font-size: 11.5px; color: var(--text-subtle); }
    .progress-track {
      height: 6px;
      width: 100%;
      margin-top: 10px;
      border-radius: 999px;
      background: var(--surface);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 100%;
      border-radius: 999px;
      background: var(--accent-gradient);
      transform-origin: left center;
      transform: scaleX(0);
      transition: transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), background 0.3s ease;
    }
    .progress-fill[data-level="warn"] { background: linear-gradient(90deg, #f59e0b, #ea580c); }
    .progress-fill[data-level="high"] { background: linear-gradient(90deg, #ef4444, #dc2626); }

    .allowance-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
    }
    .allowance-footer p { margin: 0; font-size: 12px; color: var(--text-subtle); }
    .allowance-footer button { padding: 5px 10px; font-size: 12px; border-radius: 9px; }
    .allowance-footer button.spinning svg { animation: spin 0.75s linear infinite; }

    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .total {
      margin: 6px 0 0;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .status:empty { display: none; }
    .status {
      margin-top: 10px;
      padding: 9px 12px;
      border-radius: 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 12.5px;
      animation: panelEnter 0.22s ease both;
    }
    #robux-transfer-cooldown {
      background: var(--warn-soft);
      border-color: rgba(245, 158, 11, 0.28);
      color: var(--warn);
      font-weight: 600;
    }

    .search { padding: 0; }
    .search-row, .recipient-row { display: flex; gap: 9px; align-items: center; }
    .search-input-wrap { position: relative; flex: 1; min-width: 0; }
    .search-input-wrap .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-subtle);
      pointer-events: none;
    }
    .search-input-wrap input { padding-left: 36px; }
    .recipient-row {
      padding: 10px 12px;
      border-radius: 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
    }
    .recipient-row > div { min-width: 0; flex: 1; }
    .recipient-row .label { margin: 0; font-size: 11.5px; }

    .results {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      max-height: 236px;
      overflow-y: auto;
      padding: 2px;
    }
    .results:empty { display: none; }
    .result {
      width: 100%;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: flex-start;
      text-align: left;
      white-space: normal;
      overflow-wrap: anywhere;
      padding: 8px 10px;
      border-radius: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      animation: itemIn 0.24s cubic-bezier(0.22, 1, 0.36, 1) both;
      animation-delay: calc(var(--i, 0) * 32ms);
    }
    .result:hover:not(:disabled) {
      transform: translateX(3px);
      border-color: var(--accent);
      background: var(--surface);
    }
    .result-names { min-width: 0; font-weight: 650; }

    .avatar {
      position: relative;
      display: grid;
      place-items: center;
      flex: 0 0 42px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      overflow: hidden;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      box-shadow: inset 0 0 0 1px var(--border);
    }
    .avatar img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 0.28s ease;
    }
    .avatar img.loaded { opacity: 1; }
    .avatar-slot { display: flex; flex: none; }
    .username { display: block; color: var(--text-muted); font-size: 12.5px; font-weight: 500; }
    .fallback { display: inline-block; margin-top: 8px; font-size: 13px; }

    .amount-input-wrap { position: relative; }
    .amount-input-wrap .robux-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 20px;
      color: var(--accent);
      pointer-events: none;
    }
    .amount-input-wrap input {
      padding: 13px 14px 13px 44px;
      font-size: 22px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }

    .presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
    .presets button {
      padding: 8px 6px;
      border-radius: 10px;
      font-variant-numeric: tabular-nums;
      font-size: 13px;
    }
    .presets button.is-selected {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
    }

    .notice { font-size: 12.5px; margin-top: 10px; color: var(--text-subtle); }
    .review-card {
      padding: 16px;
      border-radius: 16px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
    }
    .review-card > p:first-child { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-muted); }

    .robux-icon { display: inline-block; width: 1.05em; height: 1.05em; flex: none; vertical-align: -0.14em; }
    .money, .presets button { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }

    .success { padding: 24px 22px; }
    .success-hero { position: relative; text-align: center; padding: 6px 0 22px; overflow: visible; }
    .success-check {
      position: relative;
      display: grid;
      place-items: center;
      width: 60px;
      height: 60px;
      margin: 0 auto 14px;
      border-radius: 50%;
      color: var(--success);
      background: var(--success-soft);
      box-shadow: 0 0 0 8px rgba(34, 197, 94, 0.06);
      animation: popIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }
    .success-check svg { width: 32px; height: 32px; }
    .success-check .check-path {
      stroke-dasharray: 40;
      stroke-dashoffset: 40;
      animation: drawStroke 0.4s 0.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .burst-dot {
      position: absolute;
      left: 50%;
      top: 36px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      pointer-events: none;
      animation: particleBurst 0.72s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .success-total {
      justify-content: center;
      color: var(--text);
      font-size: 36px;
      font-weight: 800;
      letter-spacing: -0.03em;
      animation: panelEnter 0.35s 0.12s ease both;
    }
    .success-recipient {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      gap: 9px;
      margin-top: 12px;
      padding: 6px 14px 6px 7px;
      border-radius: 999px;
      background: var(--surface);
      border: 1px solid var(--border);
      animation: panelEnter 0.35s 0.18s ease both;
    }
    .success-recipient .avatar { width: 30px; height: 30px; flex-basis: 30px; font-size: 12px; }

    .receipt {
      margin: 0;
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
    }
    .receipt-row { display: grid; grid-template-columns: 82px 1fr; gap: 12px; padding: 6px 0; }
    .receipt-row + .receipt-row { border-top: 1px solid var(--border); }
    .receipt-row dt { color: var(--text-subtle); font-size: 12.5px; }
    .receipt-row dd {
      margin: 0;
      text-align: right;
      overflow-wrap: anywhere;
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .success .actions { flex-wrap: wrap; }
    .success .actions a { align-self: center; font-size: 13px; margin-right: auto; }

    .batch-summary-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      margin: 10px 0 12px;
      border-radius: 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
    }
    .batch-summary-card .label { margin: 0; }
    .batch-summary-card .total { margin: 0; font-size: 22px; }

    .batch-list { display: grid; gap: 8px; margin-top: 10px; max-height: 290px; overflow-y: auto; padding-right: 2px; }
    .batch-row {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: var(--bg-elevated);
      transition: border-color 0.25s ease, background-color 0.25s ease, box-shadow 0.25s ease;
    }
    .batch-row.row-enter { animation: itemIn 0.26s cubic-bezier(0.22, 1, 0.36, 1) both; }
    .batch-row[data-status="preparing"], .batch-row[data-status="sending"] {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .batch-row[data-status="submitted"] { border-color: rgba(34, 197, 94, 0.32); }
    .batch-row[data-status="failed"], .batch-row[data-status="unconfirmed"] { border-color: rgba(248, 113, 113, 0.38); }
    .batch-row > div { min-width: 0; flex: 1; }
    .batch-row p { margin: 3px 0 0; font-size: 12px; overflow-wrap: anywhere; }
    .batch-row .money { font-size: 14.5px; font-weight: 700; }
    .batch-row button { padding: 5px 9px; font-size: 12px; border-radius: 8px; }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 650;
      background: var(--surface);
      color: var(--text-muted);
      margin-right: 4px;
    }
    .status-pill::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .status-pill[data-status="preparing"], .status-pill[data-status="sending"] {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .status-pill[data-status="preparing"]::before, .status-pill[data-status="sending"]::before {
      animation: pulseDot 1s ease-in-out infinite;
    }
    .status-pill[data-status="submitted"] { background: var(--success-soft); color: var(--success); }
    .status-pill[data-status="failed"], .status-pill[data-status="unconfirmed"] {
      background: var(--danger-soft);
      color: var(--danger);
    }
    .status-pill[data-status="skipped"] { background: var(--warn-soft); color: var(--warn); }

    .batch-panel .actions { flex-wrap: wrap; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  `);
  shadow.adoptedStyleSheets = [styles];

  let currentTheme = detectInitialTheme();
  host.dataset.theme = currentTheme;

  const dialog = element('dialog', '', { 'aria-labelledby': 'transfer-title' });
  const header = element('header');
  const brand = element('div', '', { class: 'brand' });
  const brandBadge = element('div', '', { class: 'brand-badge', 'aria-hidden': 'true' });
  brandBadge.append(robuxIcon());
  const transferTitle = element('h2', 'Send Robux', { id: 'transfer-title' });
  brand.append(brandBadge, transferTitle);

  const headerControls = element('div', '', { class: 'header-controls' });
  const themeButton = element('button', '', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Switch color theme', title: 'Switch color theme',
  });
  function renderThemeIcon() {
    const isDark = currentTheme === 'dark';
    themeButton.replaceChildren(isDark
      ? svgIcon([
          { tag: 'circle', cx: '12', cy: '12', r: '4', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
          { d: 'M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' },
        ])
      : svgIcon([
          { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' },
        ]));
  }
  renderThemeIcon();
  themeButton.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    host.dataset.theme = currentTheme;
    renderThemeIcon();
    try { localStorage.setItem(themeKey, currentTheme); } catch { /* Theme persists in memory. */ }
  });

  const closeButton = element('button', '', {
    type: 'button', class: 'icon-btn close-btn', 'aria-label': 'Close', title: 'Close',
  });
  closeButton.append(svgIcon([
    { d: 'M18 6 6 18M6 6l12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' },
  ]));
  headerControls.append(themeButton, closeButton);
  header.append(brand, headerControls);

  const modeSwitchWrap = element('div', '', { class: 'mode-switch-wrap' });
  const modeSwitch = element('div', '', { class: 'mode-switch', 'data-mode': 'single' });
  const modeThumb = element('span', '', { class: 'mode-thumb', 'aria-hidden': 'true' });
  const singleModeButton = element('button', 'Single recipient', { type: 'button', 'aria-pressed': 'true' });
  const batchModeButton = element('button', 'Batch transfer', { type: 'button', 'aria-pressed': 'false' });
  modeSwitch.append(modeThumb, singleModeButton, batchModeButton);
  modeSwitchWrap.append(modeSwitch);

  const accountSection = element('section', '', { class: 'account' });
  const accountCard = element('div', '', { class: 'account-card' });
  const accountLabel = element('p', 'Checking your signed-in Roblox account…');
  accountCard.append(accountLabel);
  const accountStatus = element('p', '', { class: 'status', role: 'status' });
  const cooldownNote = element('p', '', { id: 'robux-transfer-cooldown', class: 'status', role: 'status', hidden: '' });
  const reloadButton = element('button', 'Reload account', { type: 'button', hidden: '' });
  const allowanceGrid = element('div', '', { class: 'allowances' });

  function allowanceCard(label) {
    const card = element('div', '', { class: 'allowance' });
    const top = element('div', '', { class: 'allowance-top' });
    const title = element('p', label, { class: 'allowance-label' });
    const pct = element('span', '', { class: 'allowance-pct' });
    top.append(title, pct);
    const value = element('p', 'Loading…', { class: 'allowance-value money is-loading' });
    const cap = element('small', 'Checking allowance');
    const track = element('div', '', { class: 'progress-track', hidden: '' });
    const fill = element('div', '', { class: 'progress-fill' });
    track.append(fill);
    const progress = element('progress', '', { max: '1', value: '0', 'aria-label': label + ' used', class: 'sr-only' });
    card.append(top, value, cap, track, progress);
    allowanceGrid.append(card);
    return { value, cap, progress, track, fill, pct };
  }
  const dailyAllowance = allowanceCard('Daily remaining');
  const monthlyAllowance = allowanceCard('Monthly remaining');
  const allowanceFooter = element('div', '', { class: 'allowance-footer' });
  const allowanceNote = element('p', 'History estimate · last 24h / 30 days', { role: 'status' });
  const refreshAllowanceButton = element('button', '', { type: 'button', 'aria-label': 'Refresh balance and allowances' });
  refreshAllowanceButton.append(
    svgIcon([
      { d: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    ]),
    element('span', 'Refresh'),
  );
  allowanceFooter.append(allowanceNote, refreshAllowanceButton);
  accountSection.append(accountCard, allowanceGrid, allowanceFooter, accountStatus, cooldownNote, reloadButton);

  const recipientSection = element('section');
  const searchForm = element('form', '', { class: 'search', role: 'search' });
  const searchField = element('input', '', {
    id: 'recipient-search', type: 'text', placeholder: '@username or profile link',
    required: '', autocomplete: 'off', maxlength: '300',
  });
  const searchInputWrap = element('div', '', { class: 'search-input-wrap' });
  searchInputWrap.append(
    svgIcon([
      { tag: 'circle', cx: '11', cy: '11', r: '7', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
      { d: 'm20 20-3.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' },
    ], 'ui-icon search-icon'),
    searchField,
  );
  const searchRow = element('div', '', { class: 'search-row' });
  searchRow.append(searchInputWrap, element('button', 'Search', { type: 'submit', class: 'primary' }));
  const searchStatus = element('p', '', { class: 'status', role: 'status' });
  const searchResults = element('div', '', { id: 'recipient-suggestions', class: 'results', 'aria-label': 'Matching Roblox users' });
  searchField.setAttribute('aria-controls', 'recipient-suggestions');
  const peopleSearchLink = element('a', 'Open Roblox People search ↗', {
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
  const amountInputWrap = element('div', '', { class: 'amount-input-wrap' });
  amountInputWrap.append(robuxIcon(), amount);
  const editFields = element('div');
  const editActions = element('div', '', { class: 'actions' });
  const reviewButton = element('button', 'Review transfer', { type: 'submit', class: 'primary' });
  reviewButton.disabled = true;
  const presets = element('div', '', { class: 'presets' });

  function syncPresetHighlight() {
    for (const btn of presets.children) {
      btn.classList.toggle('is-selected', amount.value === btn.dataset.value);
    }
  }

  for (const value of [25, 50, 100, 200]) {
    const preset = element('button', String(value), { type: 'button', 'data-value': String(value) });
    showRobux(preset, value);
    preset.addEventListener('click', () => {
      amount.value = String(value);
      amount.setCustomValidity('');
      syncPresetHighlight();
      amount.focus();
    });
    presets.append(preset);
  }
  const limitsLabel = element('p', '', { class: 'notice' });
  const prepareStatus = element('p', '', { class: 'status', role: 'status' });
  editActions.append(reviewButton);
  editFields.append(element('label', 'Amount in Robux', { for: 'robux-amount' }), amountInputWrap,
    presets, limitsLabel, prepareStatus, editActions);

  const review = element('div', '', { hidden: '' });
  const reviewCard = element('div', '', { class: 'review-card' });
  const total = element('p', '', { class: 'total money' });
  const status = element('p', '', { class: 'status', role: 'status' });
  const reviewActions = element('div', '', { class: 'actions' });
  const editButton = element('button', 'Edit amount', { type: 'button' });
  const sendButton = element('button', 'Send Robux', { type: 'button', class: 'primary' });
  const reviewedRecipient = element('p');
  const transactionsLink = element('a', 'Open My Transactions ↗', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer', hidden: '', class: 'fallback',
  });
  const acknowledgedButton = element('button', 'I checked My Transactions', { type: 'button', hidden: '' });
  const newTransferButton = element('button', 'New transfer', { type: 'button', hidden: '' });
  reviewActions.append(editButton, sendButton);
  reviewCard.append(reviewedRecipient, total);
  review.append(reviewCard,
    element('p', 'Confirm the @username and amount. Transfers are final.', { class: 'notice' }),
    reviewActions, status, transactionsLink, acknowledgedButton, newTransferButton);
  form.append(editFields, review);

  const parentApprovalPanel = element('section', '', { id: 'robux-parent-approval', hidden: '' });
  const parentApprovalSummary = element('p', '', { id: 'robux-parent-summary' });
  const parentApprovalStatus = element('p', '', { id: 'robux-parent-status', class: 'status', role: 'status' });
  const askParentButton = element('button', 'Ask parent', { type: 'button', class: 'primary' });
  const parentCheckedButton = element('button', 'Check status', { type: 'button' });
  const parentDiagnosticButton = element('button', 'Copy check details', { type: 'button', hidden: '' });
  const parentNewButton = element('button', 'New transfer', { type: 'button', hidden: '' });
  const parentTransactionsLink = element('a', 'Open My Transactions ↗', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer', class: 'fallback',
  });
  const parentApprovalActions = element('div', '', { class: 'actions' });
  parentApprovalActions.append(askParentButton, parentCheckedButton, parentDiagnosticButton, parentNewButton);
  parentApprovalPanel.append(element('h3', 'Parent approval'), parentApprovalSummary,
    parentApprovalStatus, parentTransactionsLink, parentApprovalActions);

  const successPanel = element('section', '', { class: 'success', hidden: '' });
  const successHero = element('div', '', { class: 'success-hero' });
  const successCheck = element('div', '', { class: 'success-check', 'aria-hidden': 'true' });
  const successAmount = element('div', '', { class: 'success-total money' });
  const successRecipient = element('div', '', { class: 'success-recipient' });
  successHero.append(successCheck, successAmount, successRecipient);

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
  const receiptTransferId = receiptRow('Transfer ID');
  receiptTransferId.parentElement.hidden = true;
  const successActions = element('div', '', { class: 'actions' });
  const successTransactions = element('a', 'View transactions ↗', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer',
  });
  const copyReceiptButton = element('button', 'Copy receipt', { type: 'button' });
  newTransferButton.className = 'primary';
  newTransferButton.textContent = 'Send another';
  successActions.append(successTransactions, copyReceiptButton, newTransferButton);
  const receiptStatus = element('p', '', { role: 'status', class: 'status' });
  successPanel.append(successHero, receipt, successActions, receiptStatus);

  const batchPanel = element('section', '', {
    id: 'robux-batch-panel', class: 'batch-panel', 'data-open': 'false', 'aria-hidden': 'true',
  });
  batchPanel.inert = true;
  const batchPanelClip = element('div', '', { class: 'batch-panel-clip' });
  const batchPanelInner = element('div', '', { class: 'batch-panel-inner' });
  const batchSummary = element('p', 'Add up to 50 recipients.', { id: 'robux-batch-summary', role: 'status' });
  const batchSummaryCard = element('div', '', { class: 'batch-summary-card' });
  const batchTotalLabel = element('p', 'Total remaining', { class: 'label' });
  const batchTotal = element('p', '', { id: 'robux-batch-total', class: 'total money' });
  batchSummaryCard.append(batchTotalLabel, batchTotal);
  const batchList = element('div', '', { id: 'robux-batch-list', class: 'batch-list' });
  const batchNotice = element('p', 'Review every @username and amount. Each row is a separate personal transfer. Submitted transfers are final.', { class: 'notice' });
  const batchStatus = element('p', '', { id: 'robux-batch-status', class: 'status', role: 'status' });
  const batchActions = element('div', '', { class: 'actions' });
  const batchReviewButton = element('button', 'Review batch', { type: 'button', class: 'primary' });
  const batchEditButton = element('button', 'Edit batch', { type: 'button', hidden: '' });
  const batchSendButton = element('button', 'Send batch', { type: 'button', class: 'primary', hidden: '' });
  const batchCancelButton = element('button', 'Cancel remaining', { type: 'button', hidden: '' });
  const batchResumeButton = element('button', 'Resume remaining', { type: 'button', hidden: '' });
  const batchNewButton = element('button', 'New batch', { type: 'button', hidden: '' });
  const batchAcknowledgeButton = element('button', 'I checked batch transactions', { type: 'button', hidden: '' });
  const batchTransactionsLink = element('a', 'View batch transactions ↗', {
    href: robloxWebsite + '/transactions', target: '_blank', rel: 'noopener noreferrer', hidden: '', class: 'fallback',
  });
  batchActions.append(batchEditButton, batchReviewButton, batchSendButton, batchCancelButton,
    batchResumeButton, batchAcknowledgeButton, batchNewButton);
  batchPanelInner.append(element('h3', 'Recipients'), batchSummary, batchSummaryCard, batchList,
    batchNotice, batchStatus, batchTransactionsLink, batchActions);
  batchPanelClip.append(batchPanelInner);
  batchPanel.append(batchPanelClip);
  dialog.append(header, modeSwitchWrap, accountSection, recipientSection, form, parentApprovalPanel, successPanel, batchPanel);
  shadow.append(dialog);

  let recipient;
  let searchRequest;
  let suggestionTimer;
  let displayedUsers = [];
  let renderedUserCount = 0;
  let resultSignal;
  let usageTransfers = [];
  let usageReady = false;
  const usageCacheVersion = 3;
  let usageRequest;
  let usageLastAttemptAt = -Infinity;
  let usageLastOwnerId;
  let usageRefreshTimer;
  let usageRefreshAfterRequest = false;
  const historyReadMinimumMs = 30000;
  const historyPages = new Map();
  let statsRequest;
  let statsRequestRevision;
  let statsRevision = 0;
  const statsRefreshTimers = new Set();
  let acceptedTransfers = [];
  let lastReceipt;
  let account;
  let limits;
  let balance;
  let balanceEstimated = false;
  let prepared;
  let parentApproval;
  let parentStatusRequest;
  let parentStatusRefreshWanted = false;
  let parentStatusTimer;
  let parentStatusPollStep = 0;
  let parentStatusWatchUntil = 0;
  let parentResolutionReady = false;
  let parentStatusPaused = false;
  let lastParentDiagnostic;
  const parentStatusPollDelays = [5000, 10000, 20000, 30000, 60000];
  let busy = false;
  let locked = false;
  let batchMode = false;
  let batchRows = [];
  let batchPhase = 'draft';
  let batchSenderId;
  let batchSnapshot;
  let batchRunning = false;
  let batchCancelRequested = false;
  let batchNextRecipientAt = 0;
  let batchWaitTimer;
  let batchWaitResolve;
  let batchStatsDirty = false;
  const animatedBatchIds = new Set();
  const batchRecipientGapMs = 10000;
  const apiCooldownKey = 'robux-transfer-api-cooldown';
  let apiCooldownUntil = 0;
  let apiCooldownTimer;
  try {
    const savedCooldown = Number(sessionStorage.getItem(apiCooldownKey));
    if (Number.isFinite(savedCooldown) && savedCooldown > Date.now()) apiCooldownUntil = savedCooldown;
  } catch { /* Keep rate-limit state in memory if storage is unavailable. */ }
  const batchKey = 'robux-transfer-popup-batch';
  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.dataset.token || '';
  const pendingKey = 'robux-transfer-popup-pending';
  const profileLookups = new AbortController();
  const previousFocus = document.activeElement;
  host._transferPopup = { focus: () => dialog.focus() };

  function setBatchDrawerOpen(open, instant = false) {
    if (instant) batchPanel.classList.add('no-transition');
    batchPanel.dataset.open = open ? 'true' : 'false';
    batchPanel.inert = !open;
    batchPanel.setAttribute('aria-hidden', String(!open));
    if (instant) {
      void batchPanel.offsetHeight;
      batchPanel.classList.remove('no-transition');
    }
  }

  function closeDialogAnimated() {
    if (busy || dialog.classList.contains('closing')) return;
    dialog.classList.add('closing');
    const finish = () => {
      dialog.classList.remove('closing');
      if (dialog.open) dialog.close();
    };
    dialog.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 240);
  }

  closeButton.addEventListener('click', closeDialogAnimated);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!busy) closeDialogAnimated();
  });
  dialog.addEventListener('close', () => {
    batchCancelRequested = true;
    clearSearch();
    clearStatsRefreshTimers();
    clearTimeout(parentStatusTimer);
    clearTimeout(usageRefreshTimer);
    clearTimeout(apiCooldownTimer);
    releaseBatchWait();
    profileLookups.abort();
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }, { once: true });

  function setBusy(value) {
    busy = value;
    const coolingDown = Date.now() < apiCooldownUntil;
    closeButton.disabled = value;
    changeRecipientButton.disabled = value || locked;
    editButton.disabled = value || locked;
    sendButton.disabled = value || locked || coolingDown || !prepared;
    reviewButton.disabled = value || locked || coolingDown || !account || !limits;
    reloadButton.disabled = value || coolingDown;
    amount.disabled = value;
    for (const button of presets.children) button.disabled = value;
    newTransferButton.disabled = value;
    const refreshing = Boolean(usageRequest) || Boolean(statsRequest) || Boolean(parentStatusRequest);
    refreshAllowanceButton.disabled = value || coolingDown || refreshing;
    refreshAllowanceButton.classList.toggle('spinning', refreshing);
    singleModeButton.disabled = value || locked;
    batchModeButton.disabled = value || locked;
    batchReviewButton.disabled = value || locked || coolingDown || !batchRows.length || !account || !limits;
    batchSendButton.disabled = value || locked || coolingDown || !batchSnapshot;
    batchResumeButton.disabled = value || locked || coolingDown || !account || !limits;
    batchEditButton.disabled = value || locked;
    batchNewButton.disabled = value || locked;
    batchAcknowledgeButton.disabled = value;
    batchCancelButton.disabled = !batchRunning || batchCancelRequested;
    askParentButton.disabled = value || coolingDown || !parentApproval || parentApproval.parentApproval !== 'required' || Boolean(parentStatusRequest);
    parentCheckedButton.disabled = value || coolingDown || !parentApproval || Boolean(parentStatusRequest);
    parentNewButton.disabled = value || !parentResolutionReady || Boolean(parentStatusRequest);
    reviewButton.classList.toggle('is-busy', value && !reviewButton.hidden && editFields && !editFields.hidden);
    sendButton.classList.toggle('is-busy', value && !sendButton.hidden && !review.hidden);
    batchSendButton.classList.toggle('is-busy', value && batchRunning);
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

  function remainingBatchRows() {
    return batchRows.filter((row) => row.status === 'waiting' || row.status === 'failed');
  }

  function hasUnknownBatchRow() {
    return batchRows.some((row) => row.status === 'unconfirmed' || row.status === 'sending');
  }

  function hasParentApprovalRow() {
    return batchRows.some((row) => ['parent_required', 'parent_requesting', 'parent_pending', 'parent_unknown'].includes(row.status));
  }

  function terminalParentStatus(status) {
    return ['Completed', 'Cancelled', 'Failed', 'Submitted', 'Refunded'].includes(status);
  }

  function renderParentApproval(message) {
    parentApprovalPanel.hidden = !parentApproval;
    if (!parentApproval) return;
    parentApprovalSummary.textContent = '@' + parentApproval.username + ' · '
      + new Intl.NumberFormat('en-US').format(parentApproval.amount) + ' Robux · ' + parentApproval.id;
    const state = parentApproval.parentApproval;
    const transferStatus = parentApproval.transferStatus;
    askParentButton.hidden = state !== 'required' || terminalParentStatus(transferStatus);
    const messages = {
      required: 'Roblox requires your parent to approve this transfer. Select Ask parent to send the request.',
      requesting: 'Sending the approval request to your linked parent…',
      requested: 'Request sent. Waiting for your parent to review it in Roblox. Status checks update this panel automatically.',
      unknown: 'The parent request result is unconfirmed. Checking the existing transfer will not send another request.',
    };
    const transferMessages = {
      Initiated: 'Roblox reports this transfer is initiated. Parent approval or another required step may still be pending.',
      Pending: 'Transfer pending in Roblox. Approval or recipient action may still be required; this is not a confirmed completed transfer.',
      Completed: 'Roblox confirmed this transfer is completed.',
      Cancelled: 'Roblox cancelled this transfer. It will not be retried automatically.',
      Failed: 'Roblox reports this transfer failed. It will not be retried automatically.',
      Submitted: 'Sent confirmed in My Transactions. Recipient acceptance has not been verified.',
      Refunded: 'My Transactions shows this transfer was fully refunded. This row will not be retried.',
    };
    parentApprovalStatus.textContent = message || transferMessages[transferStatus] || messages[state] || messages.unknown;
    parentCheckedButton.hidden = state === 'requesting' || parentResolutionReady;
    parentNewButton.hidden = !parentResolutionReady || parentApproval.batch || ['Completed', 'Submitted'].includes(transferStatus);
    parentDiagnosticButton.hidden = !lastParentDiagnostic || terminalParentStatus(transferStatus);
    setBusy(busy);
  }

  function saveParentApproval() {
    if (!parentApproval) return;
    if (parentApproval.batch) {
      const row = batchRows.find((entry) => entry.reference === parentApproval.id);
      if (!row) throw new Error('The saved batch no longer contains this transfer.');
      const states = { required: 'parent_required', requesting: 'parent_requesting', requested: 'parent_pending', unknown: 'parent_unknown' };
      const outcomes = { Completed: 'submitted', Submitted: 'submitted', Cancelled: 'parent_cancelled', Failed: 'parent_failed', Refunded: 'parent_refunded' };
      row.status = outcomes[parentApproval.transferStatus] || states[parentApproval.parentApproval] || 'parent_unknown';
      row.parentTransferStatus = parentApproval.transferStatus;
      row.parentConfirmationSource = parentApproval.confirmationSource;
      row.transferId = parentApproval.transferId;
      row.error = parentApproval.transferStatus === 'Pending' ? 'Transfer pending in Roblox.'
        : parentApproval.transferStatus === 'Completed' ? 'Completed in Roblox.'
        : parentApproval.transferStatus === 'Cancelled' ? 'Cancelled in Roblox. This row will not be retried.'
        : parentApproval.transferStatus === 'Failed' ? 'Failed in Roblox. This row will not be retried.'
        : parentApproval.transferStatus === 'Submitted' ? 'Sent confirmed in My Transactions. Recipient acceptance unverified.'
        : parentApproval.transferStatus === 'Refunded' ? 'Fully refunded in My Transactions. This row will not be retried.'
        : parentApproval.parentApproval === 'requested' ? 'Waiting for parent review.' : 'Parent approval required.';
      batchPhase = remainingBatchRows().length || hasUnknownBatchRow() || hasParentApprovalRow() ? 'paused' : 'complete';
      saveBatch();
    }
    sessionStorage.setItem(pendingKey, JSON.stringify(parentApproval));
  }

  function beginParentApproval(transfer, batch = false) {
    clearTimeout(parentStatusTimer);
    lastParentDiagnostic = null;
    parentResolutionReady = false;
    parentApproval = { ...transfer, batch, parentApproval: 'required' };
    locked = true;
    prepared = null;
    sendButton.hidden = true;
    acknowledgedButton.hidden = true;
    try {
      saveParentApproval();
      renderParentApproval();
    } catch {
      parentApproval.parentApproval = 'unknown';
      renderParentApproval('Could not save the approval state. Check this transfer in Roblox before continuing.');
    }
  }

  function readParentApproval(value) {
    if (!value || !['required', 'requesting', 'requested', 'unknown'].includes(value.parentApproval) ||
        typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 ||
        typeof value.username !== 'string' || !/^[a-z0-9_]{1,20}$/i.test(value.username) ||
        !Number.isSafeInteger(value.senderId) || value.senderId <= 0 ||
        !Number.isSafeInteger(value.recipientId) || value.recipientId <= 0 ||
        !Number.isSafeInteger(value.amount) || value.amount < 10) return null;
    const statuses = ['Initiated', 'Pending', 'Completed', 'Cancelled', 'Failed'];
    if (value.confirmationSource === 'history') statuses.push('Submitted', 'Refunded');
    const transferStatus = statuses.includes(value.transferStatus)
      ? value.transferStatus : undefined;
    return { ...value, batch: value.batch === true, transferStatus, transferId: normalizeTransferId(value.transferId) || undefined,
      parentApproval: value.parentApproval === 'requesting' ? 'unknown' : value.parentApproval };
  }

  function isCurrentParentTransfer(transfer) {
    return parentApproval === transfer && !profileLookups.signal.aborted;
  }

  function hydrateParentAccount(sender) {
    if (account?.id === sender.id) return false;
    clearStatsRefreshTimers();
    statsRevision++;
    account = sender;
    limits = null;
    balance = undefined;
    usageTransfers = [];
    usageReady = false;
    try {
      const recent = JSON.parse(sessionStorage.getItem('robux-transfer-recent:' + sender.id));
      acceptedTransfers = (Array.isArray(recent) ? recent : []).filter((transfer) =>
        typeof transfer.id === 'string' && Number.isFinite(transfer.amount) && transfer.amount > 0 &&
        Number.isFinite(transfer.createdMs) && transfer.createdMs > Date.now() - 30 * 86400000);
    } catch { acceptedTransfers = []; }
    accountLabel.textContent = 'From @' + sender.name;
    return true;
  }

  function normalizeTransferId(value) {
    const id = canonicalTransferReference(value);
    return id.length <= 200 && /^[1-9]\d*$/.test(id) ? id : '';
  }

  function readVerifiedParentTransfer(data, expected, lookupRequestId) {
    const transfer = data?.transfer;
    const transferId = normalizeTransferId(transfer?.transferId);
    const mismatches = [];
    // The GET is addressed by its RXT request reference. The returned transferId
    // belongs to a different identifier namespace and may change while processing.
    if (typeof lookupRequestId !== 'string' || lookupRequestId !== expected.id) mismatches.push('lookup request');
    if (!transferId) mismatches.push('transfer ID');
    if (String(transfer?.sender?.targetId) !== String(expected.senderId)) mismatches.push('sender');
    if (String(transfer?.recipient?.targetId) !== String(expected.recipientId)) mismatches.push('recipient');
    if (transfer?.transferAmount !== expected.amount) mismatches.push('amount');
    const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
    lastParentDiagnostic = {
      expected: { requestReference: expected.id, senderId: expected.senderId, recipientId: expected.recipientId, amount: expected.amount },
      lookupRequestId: scalar(lookupRequestId),
      observed: { transferId: scalar(transfer?.transferId), senderId: scalar(transfer?.sender?.targetId),
        recipientId: scalar(transfer?.recipient?.targetId), amount: scalar(transfer?.transferAmount), status: scalar(transfer?.status) },
      responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
      transferKeys: transfer && typeof transfer === 'object' ? Object.keys(transfer).slice(0, 20) : [],
      mismatches,
    };
    if (mismatches.length) {
      throw new Error('Status response did not match: ' + mismatches.join(', ') + '.');
    }
    const names = ['Initiated', 'Pending', 'Cancelled', 'Failed', 'Completed'];
    const status = Number.isInteger(transfer.status) ? names[transfer.status]
      : typeof transfer.status === 'string' && names.includes(transfer.status) ? transfer.status : undefined;
    if (!status) throw new Error('Roblox returned an unrecognized transfer status.');
    lastParentDiagnostic = null;
    return { ...transfer, status, transferId };
  }

  function verifyOutgoingHistory(page, expected) {
    if (!Array.isArray(page?.data)) throw new Error('Roblox did not return transfer history.');
    const reference = canonicalTransferReference(expected.id);
    if (!reference) return null;
    const seen = new Map();
    let sent = 0;
    let sentRows = 0;
    let refunded = 0;
    for (const row of page.data) {
      const details = row?.details || {};
      if (canonicalTransferReference(details.transferRequestId) !== reference) continue;
      if (String(details.senderTargetId) !== String(expected.senderId)) return null;
      const value = Number(row.currency?.amount);
      if (!Number.isSafeInteger(value) || !Number.isFinite(Date.parse(row.created))) return null;
      const key = row.idHash ? String(row.idHash)
        : [row.created, value, details.transferRole, details.recipientTargetId || ''].join(':');
      const fingerprint = [row.created, value, details.senderTargetId, details.recipientTargetId || '', details.transferRole].join(':');
      if (seen.has(key)) {
        if (seen.get(key) !== fingerprint) return null;
        continue;
      }
      seen.set(key, fingerprint);
      if (details.transferRole === 'Sender' && value < 0 &&
          String(details.recipientTargetId) === String(expected.recipientId)) {
        if (++sentRows !== 1 || value !== -expected.amount) return null;
        sent -= value;
      }
      else if (details.transferRole === 'SenderRefund' && value > 0 &&
          (details.recipientTargetId == null || String(details.recipientTargetId) === String(expected.recipientId))) refunded += value;
      else return null;
    }
    if (sent !== expected.amount) return null;
    if (refunded === 0) return { status: 'Submitted', confirmationSource: 'history' };
    if (refunded === sent) return { status: 'Refunded', confirmationSource: 'history' };
    return null;
  }


  function finishParentTransfer(transfer) {
    clearTimeout(parentStatusTimer);
    // Persist the terminal row before removing its pending marker. A crash must never requeue it.
    saveParentApproval();
    if (transfer.batch || ['Completed', 'Submitted'].includes(transfer.transferStatus)) {
      sessionStorage.removeItem(pendingKey);
      parentApproval = null;
      parentApprovalPanel.hidden = true;
      locked = hasUnknownBatchRow() || hasParentApprovalRow();
      if (transfer.batch) {
        batchSnapshot = null;
        batchStatus.textContent = transfer.transferStatus === 'Submitted'
          ? 'Sent confirmed in My Transactions. Review any remaining recipients before continuing.'
          : transfer.transferStatus === 'Completed'
          ? 'Roblox confirmed this transfer is completed. Review any remaining recipients before continuing.'
          : 'Roblox reports this transfer ' + transfer.transferStatus.toLowerCase() + '. This row will not be retried. Review any remaining recipients before continuing.';
        renderBatch();
      } else {
        const completed = transfer.transferStatus === 'Completed';
        showSuccess(transfer, { recordUsage: false, refresh: false, confirmed: completed });
        transferTitle.textContent = completed ? 'Transfer completed' : 'Transfer sent';
        if (!completed) {
          lastReceipt.verifiedSent = true;
          receiptTime.parentElement.querySelector('dt').textContent = 'Verified';
        }
        receiptStatus.textContent = completed ? 'Roblox confirmed this transfer is completed.'
          : 'Sent confirmed in My Transactions. Recipient acceptance has not been verified.';
      }
      if (['Completed', 'Submitted', 'Refunded'].includes(transfer.transferStatus)) refreshAfterSend();
    } else {
      parentResolutionReady = true;
      renderParentApproval();
    }
  }

  function scheduleParentStatusCheck() {
    clearTimeout(parentStatusTimer);
    if (!parentApproval || parentStatusPaused || terminalParentStatus(parentApproval.transferStatus) ||
        !['requested', 'unknown'].includes(parentApproval.parentApproval) || profileLookups.signal.aborted) return;
    if (Date.now() >= parentStatusWatchUntil) {
      renderParentApproval(parentApprovalStatus.textContent + ' Automatic checks paused. Select Check status to check again.');
      return;
    }
    const delay = Math.max(parentStatusPollDelays[Math.min(parentStatusPollStep++, parentStatusPollDelays.length - 1)],
      apiCooldownUntil - Date.now());
    if (Date.now() + delay > parentStatusWatchUntil) return;
    parentStatusTimer = setTimeout(() => {
      if (document.hidden) { scheduleParentStatusCheck(); return; }
      checkParentTransfer();
    }, delay);
  }

  async function checkParentTransfer({ manual = false } = {}) {
    if (!parentApproval || profileLookups.signal.aborted) return;
    if (manual) {
      parentStatusPaused = false;
      parentStatusWatchUntil = Date.now() + 10 * 60000;
      parentStatusPollStep = 0;
      parentStatusRefreshWanted = true;
    }
    if (parentStatusRequest) return parentStatusRequest;
    clearTimeout(parentStatusTimer);
    if (Date.now() < apiCooldownUntil) { updateCooldownStatus(); scheduleParentStatusCheck(); return; }
    const transfer = parentApproval;
    const readOptions = { signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(15000)]) };
    parentStatusRequest = (async () => {
      let refreshStats = false;
      let senderVerified = false;
      let resolved = false;
      try {
        const sender = await api(usersApi + '/authenticated', undefined, readOptions);
        if (!isCurrentParentTransfer(transfer)) return;
        if (sender.id !== transfer.senderId || !sender.name) {
          parentStatusPaused = true;
          throw new Error('Your signed-in account changed. Reload the correct sender account before checking this transfer.');
        }
        senderVerified = true;
        refreshStats = hydrateParentAccount(sender);
        let current;
        let statusError;
        try {
          const lookupRequestId = transfer.id;
          const data = await api(transferApi + '/transfer/' + encodeURIComponent(lookupRequestId), undefined,
            { ...readOptions, preserveTransferId: true });
          if (!isCurrentParentTransfer(transfer)) return;
          current = readVerifiedParentTransfer(data, transfer, lookupRequestId);
        } catch (error) {
          if (error.status === 401 || error.status === 403 || error.status === 429 || error.hasChallenge) throw error;
          statusError = error;
        }
        if (!isCurrentParentTransfer(transfer)) return;
        if (!current || !terminalParentStatus(current.status)) {
          const page = await fetchHistoryPage(transfer.senderId, '');
          if (!isCurrentParentTransfer(transfer)) return;
          const recorded = verifyOutgoingHistory(page, transfer);
          if (recorded) current = recorded;
          else if (!current) {
            throw new Error((statusError?.message || 'Transfer status is unavailable.')
              + ' No exact sent transaction was found in the latest 100 records. Recent history is checked at most once every 30 seconds. '
              + (lastParentDiagnostic ? 'Use Copy check details to inspect the mismatch.' : 'Check My Transactions.'));
          }
        }
        const changed = transfer.transferStatus !== current.status;
        transfer.transferStatus = current.status;
        if (current.transferId) transfer.transferId = current.transferId;
        transfer.confirmationSource = current.confirmationSource || 'status';
        refreshStats = refreshStats || changed;
        saveParentApproval();
        if (terminalParentStatus(current.status)) {
          finishParentTransfer(transfer);
          resolved = true;
        } else {
          renderParentApproval();
          if (transfer.batch) {
            batchStatus.textContent = 'Batch paused. Waiting for a verified transfer result.';
            renderBatch();
          }
        }
      } catch (error) {
        if (!isCurrentParentTransfer(transfer)) return;
        if (error.status === 401 || error.status === 403 || error.hasChallenge) parentStatusPaused = true;
        if (parentStatusPaused) {
          clearTimeout(usageRefreshTimer);
          usageRefreshAfterRequest = false;
          clearStatsRefreshTimers();
          statsRevision++;
        }
        renderParentApproval(error.message + ' No transfer or parent request was sent by this check.'
          + (parentStatusPaused ? ' Automatic checks paused; select Check status after completing the required step in Roblox.' : ''));
      } finally {
        if (!profileLookups.signal.aborted && !parentStatusPaused && senderVerified && account?.id === transfer.senderId &&
            (isCurrentParentTransfer(transfer) || resolved) && (refreshStats || parentStatusRefreshWanted)) {
          await refreshAccountStats();
        }
        parentStatusRefreshWanted = false;
        parentStatusRequest = null;
        setBusy(busy);
        if (isCurrentParentTransfer(transfer)) scheduleParentStatusCheck();
      }
    })();
    setBusy(busy);
    return parentStatusRequest;
  }

  function startParentStatusWatch() {
    clearTimeout(parentStatusTimer);
    parentStatusPaused = false;
    parentStatusWatchUntil = Date.now() + 10 * 60000;
    parentStatusPollStep = 0;
    if (!document.hidden) checkParentTransfer();
    else scheduleParentStatusCheck();
  }

  askParentButton.addEventListener('click', async () => {
    if (busy || parentStatusRequest || !parentApproval || parentApproval.parentApproval !== 'required' || terminalParentStatus(parentApproval.transferStatus)) return;
    if (Date.now() < apiCooldownUntil) { updateCooldownStatus(); return; }
    const transfer = parentApproval;
    let requestStarted = false;
    setBusy(true);
    try {
      const sender = await api(usersApi + '/authenticated');
      if (sender.id !== transfer.senderId) throw new Error('Your signed-in account changed. Reload the page before requesting approval.');
      const transferId = transfer.id.replace(/^RXT-/, '');
      if (!transferId) throw new Error('Roblox did not provide a valid transfer reference.');
      transfer.parentApproval = 'requesting';
      saveParentApproval();
      renderParentApproval();
      requestStarted = true;
      await api('https://apis.roblox.com/child-requests-api/v1/send-request-to-all-parents', {
        requestType: 'SendTransfer',
        requestDetails: { transferType: 'Robux', transferId, robuxTransferAmount: transfer.amount },
      }, { allowEmpty: true });
      transfer.parentApproval = 'requested';
      saveParentApproval();
      renderParentApproval();
    } catch (error) {
      transfer.parentApproval = !requestStarted || error.definitelyRejected ? 'required' : 'unknown';
      try { saveParentApproval(); } catch { transfer.parentApproval = 'unknown'; }
      renderParentApproval(transfer.parentApproval === 'unknown'
        ? 'The parent request result is unconfirmed. Check Roblox before continuing; do not send another request.'
        : error.message);
    } finally {
      if (transfer.batch) renderBatch();
      setBusy(false);
      if (['requested', 'unknown'].includes(transfer.parentApproval)) startParentStatusWatch();
    }
  });

  parentCheckedButton.addEventListener('click', () => {
    if (!busy) return checkParentTransfer({ manual: true });
  });

  parentDiagnosticButton.addEventListener('click', async () => {
    if (!lastParentDiagnostic) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastParentDiagnostic, null, 2));
      parentDiagnosticButton.textContent = 'Details copied';
      setTimeout(() => { parentDiagnosticButton.textContent = 'Copy check details'; }, 1800);
    } catch { renderParentApproval('Could not copy the check details. Clipboard access is unavailable.'); }
  });

  parentNewButton.addEventListener('click', () => {
    if (busy || !parentApproval || !parentResolutionReady || parentApproval.batch) return;
    try {
      sessionStorage.removeItem(pendingKey);
      clearTimeout(parentStatusTimer);
      parentApproval = null;
      parentResolutionReady = false;
      parentApprovalPanel.hidden = true;
      locked = false;
      recipientSection.hidden = false;
      resetRecipientEditor();
      transferTitle.textContent = 'Send Robux';
      setBusy(false);
      searchField.focus();
    } catch {
      renderParentApproval('Could not clear the saved result. Reopen this popup before starting another transfer.');
    }
  });

  function saveBatch() {
    sessionStorage.setItem(batchKey, JSON.stringify({
      version: 1, senderId: batchSenderId, phase: batchPhase, rows: batchRows, nextRecipientAt: batchNextRecipientAt,
    }));
  }

  function releaseBatchWait() {
    clearTimeout(batchWaitTimer);
    batchWaitTimer = null;
    const resolve = batchWaitResolve;
    batchWaitResolve = null;
    if (resolve) resolve();
  }

  function waitForBatchTurn() {
    if (batchCancelRequested || Date.now() >= batchNextRecipientAt) return Promise.resolve();
    return new Promise((resolve) => {
      batchWaitResolve = resolve;
      const tick = () => {
        const remaining = batchNextRecipientAt - Date.now();
        if (batchCancelRequested || profileLookups.signal.aborted || remaining <= 0) {
          releaseBatchWait();
          return;
        }
        batchStatus.textContent = 'Waiting ' + Math.ceil(remaining / 1000) + 's before the next recipient…';
        batchWaitTimer = setTimeout(tick, Math.min(1000, remaining));
      };
      tick();
    });
  }

  function refreshBatchStatsWhenReady() {
    if (!batchStatsDirty || batchRunning || !account || profileLookups.signal.aborted || Date.now() < apiCooldownUntil) return;
    batchStatsDirty = false;
    refreshAccountStats();
  }

  function updateCooldownStatus() {
    clearTimeout(apiCooldownTimer);
    if (profileLookups.signal.aborted) return;
    const remaining = apiCooldownUntil - Date.now();
    cooldownNote.hidden = remaining <= 0;
    if (remaining > 0) {
      cooldownNote.textContent = 'Roblox cooldown · wait ' + Math.ceil(remaining / 1000) + 's before resuming.';
      apiCooldownTimer = setTimeout(updateCooldownStatus, Math.min(1000, remaining));
    } else {
      const expired = apiCooldownUntil > 0;
      apiCooldownUntil = 0;
      cooldownNote.textContent = '';
      try { sessionStorage.removeItem(apiCooldownKey); } catch { /* Expired timestamps are ignored on reopen. */ }
      if (expired && !account && !busy && !locked && !reloadButton.hidden) loadAccount();
      refreshBatchStatsWhenReady();
    }
    setBusy(busy);
  }

  function cooldownError(retryAt = apiCooldownUntil) {
    const error = new Error('Roblox cooldown is active. Wait ' + Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) + 's before trying again.');
    error.status = 429;
    error.rateLimited = true;
    error.retryAt = retryAt;
    error.definitelyRejected = true;
    return error;
  }

  function rememberApiCooldown(response) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter == null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    const date = Number.isFinite(seconds) ? NaN : Date.parse(retryAfter);
    const deadline = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000
      : Number.isFinite(date) ? date : Date.now() + 60000;
    apiCooldownUntil = Math.max(apiCooldownUntil, Date.now() + 1000, deadline);
    try { sessionStorage.setItem(apiCooldownKey, String(apiCooldownUntil)); } catch { /* Respect the cooldown in memory. */ }
    updateCooldownStatus();
    return apiCooldownUntil;
  }

  function resetRecipientEditor() {
    prepared = null;
    recipient = null;
    selectedRecipient.hidden = true;
    searchForm.hidden = false;
    form.hidden = true;
    review.hidden = true;
    editFields.hidden = false;
    amount.value = '';
    syncPresetHighlight();
    searchField.value = '';
    clearSearch();
  }

  function renderBatch(instant = false) {
    modeSwitch.dataset.mode = batchMode ? 'batch' : 'single';
    singleModeButton.setAttribute('aria-pressed', String(!batchMode));
    batchModeButton.setAttribute('aria-pressed', String(batchMode));
    reviewButton.textContent = batchMode ? 'Add to batch' : 'Review transfer';
    if (!batchMode) {
      setBatchDrawerOpen(false, instant);
      return;
    }
    const counts = {};
    for (const row of batchRows) counts[row.status] = (counts[row.status] || 0) + 1;
    const completedCount = batchRows.filter((row) => row.status === 'submitted' && row.parentTransferStatus === 'Completed').length;
    const allCompleted = batchRows.length > 0 && completedCount === batchRows.length;
    const remaining = remainingBatchRows();
    batchSummary.textContent = batchRows.length ? batchRows.length + ' recipients · '
      + ((counts.submitted || 0) - completedCount) + ' submitted · '
      + (completedCount ? completedCount + ' completed · ' : '')
      + ((counts.failed || 0) + (counts.parent_failed || 0)) + ' failed · '
      + (counts.unconfirmed || 0) + ' unconfirmed · ' + remaining.length + ' remaining'
      + (counts.skipped ? ' · ' + counts.skipped + ' skipped' : '')
      + (counts.parent_refunded ? ' · ' + counts.parent_refunded + ' refunded' : '')
      + (counts.parent_cancelled ? ' · ' + counts.parent_cancelled + ' cancelled' : '')
      + (hasParentApprovalRow() ? ' · transfer confirmation needed' : '')
      : 'Add up to 50 recipients using the search above.';
    batchTotalLabel.textContent = batchPhase === 'complete' ? allCompleted ? 'Total completed' : 'Total submitted' : 'Total remaining';
    const totalRows = batchPhase === 'complete' ? batchRows.filter((row) => row.status === 'submitted') : remaining;
    showRobux(batchTotal, totalRows.reduce((sum, row) => sum + row.amount, 0));
    batchList.replaceChildren();
    const avatars = [];
    const labels = {
      waiting: 'Waiting', preparing: 'Preparing', sending: 'Sending', submitted: 'Submitted',
      failed: 'Failed', unconfirmed: 'Unconfirmed — check transactions', skipped: 'Skipped',
      parent_required: 'Parent approval required', parent_requesting: 'Requesting parent approval',
      parent_pending: 'Awaiting transfer confirmation', parent_unknown: 'Parent request unconfirmed',
      parent_checked: 'Checked — not retried', parent_cancelled: 'Cancelled — not retried', parent_failed: 'Failed — not retried',
      parent_refunded: 'Refunded — not retried',
    };
    for (const row of batchRows) {
      const isNew = !animatedBatchIds.has(row.recipientId);
      animatedBatchIds.add(row.recipientId);
      const item = element('div', '', {
        class: isNew ? 'batch-row row-enter' : 'batch-row',
        'data-user-id': String(row.recipientId),
        'data-status': row.status,
      });
      const avatar = createAvatar(row.recipientId, row.username);
      avatars.push(avatar);
      const details = element('div');
      const link = element('a', '@' + row.username, {
        href: robloxWebsite + '/users/' + row.recipientId + '/profile',
        target: '_blank', rel: 'noopener noreferrer',
      });
      const meta = element('p');
      const label = row.status === 'submitted' && row.parentTransferStatus === 'Completed' ? 'Completed'
        : row.status === 'parent_pending' && row.parentTransferStatus === 'Pending' ? 'Transfer pending in Roblox' : labels[row.status] || row.status;
      meta.append(element('span', label, { class: 'status-pill', 'data-status': row.status }));
      if (row.reference || row.error) {
        meta.append(document.createTextNode((row.reference ? row.reference : '') + (row.error ? (row.reference ? ' · ' : '') + row.error : '')));
      }
      if (row.transferId) meta.append(document.createTextNode(' · Transfer ID: ' + row.transferId));
      details.append(link, meta);
      const money = element('span', '', { class: 'money' });
      showRobux(money, row.amount);
      item.append(avatar, details, money);
      if (batchPhase === 'draft' && (row.status === 'waiting' || row.status === 'failed')) {
        const remove = element('button', 'Remove', { type: 'button', 'aria-label': 'Remove @' + row.username });
        remove.disabled = busy;
        remove.addEventListener('click', () => {
          if (busy || locked || batchPhase !== 'draft') return;
          animatedBatchIds.delete(row.recipientId);
          batchRows = batchRows.filter((entry) => entry !== row);
          try { saveBatch(); } catch { batchStatus.textContent = 'Could not save the batch. Try again before sending.'; }
          renderBatch();
        });
        item.append(remove);
      }
      batchList.append(item);
    }
    if (avatars.length) loadAvatars(avatars, profileLookups.signal);
    recipientSection.hidden = batchPhase !== 'draft';
    if (batchPhase !== 'draft') form.hidden = true;
    batchReviewButton.hidden = batchPhase !== 'draft';
    batchEditButton.hidden = batchPhase !== 'review';
    batchSendButton.hidden = batchPhase !== 'review';
    batchCancelButton.hidden = !batchRunning;
    batchResumeButton.hidden = batchPhase !== 'paused' || !remaining.length || hasUnknownBatchRow() || hasParentApprovalRow();
    batchAcknowledgeButton.hidden = !hasUnknownBatchRow();
    batchNewButton.hidden = !batchRows.length || batchPhase === 'review' || batchRunning;
    batchTransactionsLink.hidden = Boolean(parentApproval) || !batchRows.some((row) => row.reference);
    transferTitle.textContent = batchRunning ? 'Sending batch' : batchPhase === 'complete'
      ? allCompleted ? 'Batch completed' : batchRows.every((row) => row.status === 'submitted') ? 'Batch submitted' : 'Batch finished' : 'Batch transfer';
    setBatchDrawerOpen(true, instant);
    setBusy(busy);
  }

  function setBatchMode(value) {
    if (busy || locked || (batchMode === value && successPanel.hidden)) return;
    batchMode = value;
    successPanel.hidden = true;
    resetRecipientEditor();
    recipientSection.hidden = false;
    transferTitle.textContent = value ? 'Batch transfer' : 'Send Robux';
    renderBatch();
    setBusy(false);
    searchField.focus();
  }
  singleModeButton.addEventListener('click', () => setBatchMode(false));
  batchModeButton.addEventListener('click', () => setBatchMode(true));

  function batchAllowance(cap, days) {
    if (!usageReady || !Number.isSafeInteger(cap) || cap < 0) return null;
    const transfers = reconcileUsageTransfers();
    const since = Date.now() - days * 86400000;
    return Math.max(0, cap - transfers.reduce((sum, row) => row.createdMs > since ? sum + row.amount : sum, 0));
  }

  async function validateBatch(rows, fresh = false) {
    if (!account || !limits) throw new Error('Load your account before reviewing the batch.');
    if (batchSenderId !== account.id) throw new Error('This batch belongs to a different sender. Start a new batch.');
    if (hasUnknownBatchRow()) throw new Error('Check the unconfirmed transfer in My Transactions first.');
    if (fresh) {
      const [user, currency, transferLimits] = await Promise.all([
        api(usersApi + '/authenticated'), api('https://economy.roblox.com/v1/user/currency'),
        api(transferApi + '/user-transfer-limit'),
      ]);
      if (user.id !== batchSenderId) throw new Error('Your signed-in account changed. Reload the page.');
      if (!Number.isSafeInteger(currency.robux) || currency.robux < 0 ||
          !Number.isSafeInteger(transferLimits.perTransferLimit) || transferLimits.perTransferLimit < 10) {
        throw new Error('Roblox did not provide current balance and transfer limits.');
      }
      balance = currency.robux;
      balanceEstimated = false;
      limits = transferLimits;
      updateAccountDisplay();
      await refreshUsage(true);
    }
    if (!rows.length || rows.length > 50) throw new Error('Add between 1 and 50 recipients.');
    const ids = new Set();
    let sum = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.recipientId) || row.recipientId <= 0 || row.recipientId === batchSenderId ||
          typeof row.username !== 'string' || !row.username || ids.has(row.recipientId)) {
        throw new Error('Every recipient must be verified, unique, and different from your own account.');
      }
      if (!Number.isSafeInteger(row.amount) || row.amount < 10 || row.amount > limits.perTransferLimit) {
        throw new Error('Each amount must be 10–' + limits.perTransferLimit + ' whole Robux.');
      }
      ids.add(row.recipientId);
      sum += row.amount;
    }
    if (!Number.isSafeInteger(sum) || sum > balance) throw new Error('The batch total exceeds your available balance.');
    const daily = batchAllowance(limits.dailyLimit, 1);
    const monthly = batchAllowance(limits.monthlyLimit, 30);
    if (daily !== null && sum > daily) throw new Error('The batch total exceeds your daily remaining allowance.');
    if (monthly !== null && sum > monthly) throw new Error('The batch total exceeds your monthly remaining allowance.');
    return { balance, daily, monthly, perTransfer: limits.perTransferLimit };
  }

  async function addBatchRecipient(value) {
    if (batchPhase !== 'draft' || batchRows.length >= 50) throw new Error('A batch can contain up to 50 recipients.');
    const target = await api(usersApi + '/' + recipient.userId);
    if (String(target.id) !== recipient.userId || !target.name) throw new Error('Could not verify the recipient.');
    if (target.id === account.id) throw new Error('Choose a recipient other than your own account.');
    if (batchRows.some((row) => row.recipientId === target.id)) throw new Error('That recipient is already in this batch.');
    if (batchRows.length && batchSenderId !== account.id) throw new Error('This batch belongs to a different sender. Start a new batch.');
    batchSenderId = account.id;
    batchRows.push({ recipientId: target.id, username: target.name, amount: value, status: 'waiting' });
    saveBatch();
    resetRecipientEditor();
    batchStatus.textContent = 'Recipient added. Add another, or review the batch.';
    renderBatch();
    searchField.focus();
  }

  async function reviewBatch() {
    if (busy || locked || batchRunning) return;
    if (Date.now() < apiCooldownUntil) { updateCooldownStatus(); return; }
    setBusy(true);
    batchStatus.textContent = 'Checking the batch total and your account…';
    try {
      const rows = remainingBatchRows();
      await validateBatch(rows);
      batchSnapshot = Object.freeze(rows.map((row) => Object.freeze({
        recipientId: row.recipientId, username: row.username, amount: row.amount,
      })));
      batchPhase = 'review';
      saveBatch();
      batchStatus.textContent = 'Review every recipient and the total. Click Send batch to submit these transfers.';
      resetRecipientEditor();
    } catch (error) {
      batchSnapshot = null;
      batchStatus.textContent = error.message;
    } finally {
      setBusy(false);
      renderBatch();
    }
  }
  batchReviewButton.addEventListener('click', reviewBatch);
  batchResumeButton.addEventListener('click', reviewBatch);
  batchEditButton.addEventListener('click', () => {
    if (busy || locked) return;
    batchPhase = 'draft';
    batchSnapshot = null;
    try { saveBatch(); } catch { batchStatus.textContent = 'Could not save the batch. Try again before sending.'; }
    resetRecipientEditor();
    renderBatch();
  });

  batchCancelButton.addEventListener('click', () => {
    if (!batchRunning) return;
    batchCancelRequested = true;
    releaseBatchWait();
    batchCancelButton.disabled = true;
    batchStatus.textContent = 'Stopping after the current recipient. Remaining recipients will not be sent.';
  });

  batchSendButton.addEventListener('click', async () => {
    if (busy || locked || batchRunning || batchPhase !== 'review' || !batchSnapshot) return;
    if (Date.now() < apiCooldownUntil) { updateCooldownStatus(); return; }
    const snapshot = batchSnapshot;
    batchRunning = true;
    batchCancelRequested = false;
    batchStatsDirty = true;
    clearStatsRefreshTimers();
    statsRevision++;
    setBusy(true);
    try {
      if (statsRequest) await statsRequest;
      if (usageRequest) await usageRequest;
      const budget = await validateBatch(snapshot, true);
      batchPhase = 'running';
      saveBatch();
      renderBatch();
      for (const transfer of snapshot) {
        await waitForBatchTurn();
        if (batchCancelRequested || profileLookups.signal.aborted) break;
        const row = batchRows.find((entry) => entry.recipientId === transfer.recipientId);
        if (!row || (row.status !== 'waiting' && row.status !== 'failed')) throw new Error('The reviewed batch changed. Review it again.');
        let processing = false;
        let accepted = false;
        try {
          if (transfer.amount > budget.balance || transfer.amount > budget.perTransfer ||
              (budget.daily !== null && transfer.amount > budget.daily) ||
              (budget.monthly !== null && transfer.amount > budget.monthly)) throw new Error('The remaining batch exceeds the available balance or allowance.');
          row.status = 'preparing';
          row.error = '';
          saveBatch();
          renderBatch();
          if (batchCancelRequested) { row.status = 'waiting'; saveBatch(); break; }
          const initiated = await api(transferApi + '/initiate-transfer', { transferOrigin: 1, recipientId: transfer.recipientId });
          if (typeof initiated.transferRequestId !== 'string' || !initiated.transferRequestId) throw new Error('Roblox did not provide a transfer request ID.');
          if (batchCancelRequested) { row.status = 'waiting'; saveBatch(); break; }
          const currentUser = await api(usersApi + '/authenticated');
          if (currentUser.id !== batchSenderId) throw new Error('Your signed-in account changed. Reload the page.');
          if (batchCancelRequested) { row.status = 'waiting'; saveBatch(); break; }
          row.reference = initiated.transferRequestId;
          row.status = 'sending';
          saveBatch();
          sessionStorage.setItem(pendingKey, JSON.stringify({
            ...transfer, id: row.reference, senderId: batchSenderId, batch: true,
          }));
          locked = true;
          renderBatch();
          processing = true;
          await api(transferApi + '/process-transfer/' + encodeURIComponent(row.reference),
            { robuxAmount: transfer.amount }, { processing: true });
          accepted = true;
          row.status = 'submitted';
          batchNextRecipientAt = Date.now() + batchRecipientGapMs;
          saveBatch();
          sessionStorage.removeItem(pendingKey);
          locked = false;
          acceptedTransfers.push({ id: row.reference, recipientId: transfer.recipientId, amount: transfer.amount, createdMs: Date.now() });
          displayAllowances();
          budget.balance -= transfer.amount;
          if (budget.daily !== null) budget.daily -= transfer.amount;
          if (budget.monthly !== null) budget.monthly -= transfer.amount;
          balance = budget.balance;
          balanceEstimated = true;
          updateAccountDisplay();
          refreshAfterSend();
          batchStatus.textContent = 'Submitted ' + transfer.amount + ' Robux to @' + transfer.username + '.';
          renderBatch();
        } catch (error) {
          if (error.parentConsentRequired && !accepted) {
            beginParentApproval({ ...transfer, id: row.reference, senderId: batchSenderId }, true);
            batchStatus.textContent = 'Batch paused. Ask your parent to review this transfer before continuing.';
            break;
          }
          const unknown = accepted || (processing && !error.definitelyRejected);
          row.status = unknown ? 'unconfirmed' : 'failed';
          row.error = unknown ? 'Check My Transactions before continuing. This row will never be retried.' : error.message;
          locked = unknown;
          try { saveBatch(); if (!unknown) sessionStorage.removeItem(pendingKey); } catch {
            locked = true;
            row.status = 'unconfirmed';
            row.error = 'Could not save the result. Check My Transactions before continuing.';
          }
          batchStatus.textContent = 'Batch paused. ' + row.error;
          break;
        }
      }
      batchPhase = remainingBatchRows().length || hasUnknownBatchRow() || hasParentApprovalRow() ? 'paused' : 'complete';
      if (batchPhase === 'complete') batchStatus.textContent = 'Batch finished. Each submitted transfer has its own reference.';
      else if (batchCancelRequested) batchStatus.textContent = 'Batch stopped. Review remaining recipients before sending again.';
      saveBatch();
    } catch (error) {
      batchPhase = 'paused';
      batchStatus.textContent = 'Batch paused. ' + error.message;
      try { saveBatch(); } catch { /* Keep the reviewed queue visible; no further transfer is submitted. */ }
    } finally {
      batchRunning = false;
      releaseBatchWait();
      batchSnapshot = null;
      locked = hasUnknownBatchRow() || hasParentApprovalRow();
      setBusy(false);
      renderBatch();
      refreshBatchStatsWhenReady();
    }
  });

  batchAcknowledgeButton.addEventListener('click', () => {
    if (busy || batchRunning) return;
    const previousRows = batchRows.map((row) => ({ ...row }));
    const previousPhase = batchPhase;
    try {
      for (const row of batchRows) {
        if (row.status === 'unconfirmed' || row.status === 'sending') {
          row.status = 'skipped';
          row.error = 'Checked by you. This recipient will not be retried.';
        }
      }
      batchPhase = remainingBatchRows().length ? 'paused' : 'complete';
      saveBatch();
      sessionStorage.removeItem(pendingKey);
      locked = false;
      batchStatus.textContent = 'The unconfirmed row was skipped permanently. Review any remaining recipients before sending.';
      renderBatch();
      loadAccount();
    } catch {
      batchRows = previousRows;
      batchPhase = previousPhase;
      locked = true;
      batchStatus.textContent = 'Could not save your acknowledgment. Do not send again; check My Transactions.';
      renderBatch();
    }
  });

  batchNewButton.addEventListener('click', () => {
    if (busy || locked || hasUnknownBatchRow()) return;
    batchRows = [];
    animatedBatchIds.clear();
    batchNextRecipientAt = 0;
    batchPhase = 'draft';
    batchSnapshot = null;
    batchSenderId = account?.id;
    try { sessionStorage.removeItem(batchKey); } catch { batchStatus.textContent = 'Could not clear the saved batch.'; return; }
    batchStatus.textContent = '';
    resetRecipientEditor();
    renderBatch();
  });

  async function api(url, body, { signal, processing = false, allowEmpty = false, preserveTransferId = false } = {}) {
    if (Date.now() < apiCooldownUntil) throw cooldownError();
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
    const readResponse = async (response) => {
      if (!preserveTransferId) return response.json().catch(() => null);
      // Status responses may encode the 19-digit transfer reference as a JSON number.
      // Preserve that token before JSON parsing can round it through Number.
      const text = await response.text();
      try { return JSON.parse(text.replace(/("(?:transferId|transferRequestId)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"')); }
      catch { return null; }
    };
    let response;
    let data;
    try {
      response = await fetch(url, options);
      data = await readResponse(response);
      const refreshed = response.headers.get('x-csrf-token');
      const hasChallenge = response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length;
      if (body && response.status === 403 && refreshed && !hasChallenge) {
        csrfToken = refreshed;
        headers['X-CSRF-TOKEN'] = refreshed;
        response = await fetch(url, options);
        data = await readResponse(response);
      }
    } catch {
      throw new Error(processing
        ? 'The connection ended before Roblox returned a transfer result.'
        : 'Could not reach Roblox. The request may be blocked by the browser, connection, or Roblox authentication.');
    }
    if (!response.ok || response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length || data?.failureReason || data?.success === false) {
      const error = new Error(describeError(response, data));
      error.status = response.status;
      error.hasChallenge = Boolean(response.headers.get('rblx-challenge-id') || data?.ampRecourseActions?.length);
      const recourses = Array.isArray(data?.ampRecourseActions) ? data.ampRecourseActions : [];
      error.parentConsentRequired = processing && String(url).includes('/process-transfer/')
        && !response.headers.get('rblx-challenge-id') && recourses.length > 0
        && recourses.every((recourse) => recourse === 'ParentConsentRecourse');
      if (response.status === 429) {
        error.rateLimited = true;
        error.retryAt = rememberApiCooldown(response);
        const path = new URL(String(url)).pathname;
        const requestName = path.includes('/process-transfer/') ? 'transfer submission'
          : path.endsWith('/initiate-transfer') ? 'transfer preparation'
          : path.endsWith('/authenticated') ? 'sender checks'
          : path.endsWith('/user-transfer-limit') ? 'limit refreshes'
          : path.includes('/robux-transfer/transfer/') ? 'transfer status checks'
          : path.startsWith('/transaction-records/') ? 'transfer history'
          : path.endsWith('/user/currency') ? 'balance refreshes'
          : path.startsWith('/child-requests-api/') ? 'parent requests' : 'recipient lookups';
        if (!error.hasChallenge) error.message = 'Roblox rate limited ' + requestName + '. Wait for the cooldown before resuming.';
      }
      error.definitelyRejected = error.parentConsentRequired || [400, 401, 403, 404, 422, 429].includes(response.status);
      throw error;
    }
    if (!data && allowEmpty) return {};
    if (!data) throw new Error('Roblox returned an empty response.');
    return data;
  }

  function updateAccountDisplay() {
    const balanceValue = element('span', '', { class: 'money account-balance' });
    if (Number.isSafeInteger(balance) && balance >= 0) showRobux(balanceValue, balance);
    else balanceValue.textContent = 'Unavailable';
    if (balanceEstimated) {
      balanceValue.append(element('small', 'est.'));
      balanceValue.setAttribute('aria-label', balance + ' Robux, estimated');
    }
    accountLabel.className = 'account-line';
    accountLabel.replaceChildren(element('span', 'From @' + account.name), balanceValue);
    if (Number.isSafeInteger(limits?.perTransferLimit)) {
      amount.max = String(limits.perTransferLimit);
      limitsLabel.textContent = '10–' + new Intl.NumberFormat('en-US').format(limits.perTransferLimit) + ' Robux per transfer.';
    } else {
      amount.removeAttribute('max');
      limitsLabel.textContent = 'Per-transfer limit unavailable · try Refresh';
    }
    if (balance < 10) limitsLabel.textContent = 'Your balance is below the 10 Robux minimum.';
  }

  function saveAcceptedTransfers() {
    try {
      sessionStorage.setItem('robux-transfer-recent:' + account.id, JSON.stringify(acceptedTransfers));
    } catch { /* Keep the local allowance adjustment in memory. */ }
  }

  function canonicalTransferReference(value) {
    // Roblox's RXT-prefixed request reference and its numeric-string history reference
    // identify the same transfer. Never round these long identifiers through Number().
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    if (typeof value !== 'string') return '';
    const reference = value.trim();
    const numeric = reference.match(/^(?:RXT-)?(\d+)$/i);
    return numeric ? numeric[1].replace(/^0+(?=\d)/, '') : reference;
  }

  function reconcileUsageTransfers() {
    const historyReferences = usageTransfers.map((transfer) =>
      canonicalTransferReference(transfer.reference === undefined ? transfer.id : transfer.reference));
    const seenLocal = new Set();
    const locals = [];
    for (const transfer of acceptedTransfers) {
      const reference = canonicalTransferReference(transfer.id);
      if (!reference || seenLocal.has(reference)) continue;
      seenLocal.add(reference);
      locals.push(transfer);
    }
    const matchedHistory = new Set();
    const pending = [];
    for (const transfer of locals) {
      const reference = canonicalTransferReference(transfer.id);
      const index = historyReferences.indexOf(reference);
      if (index >= 0) matchedHistory.add(index);
      else pending.push(transfer);
    }
    // Some history rows initially expose only an opaque row hash. In that case,
    // require a unique recipient, gross amount and close timestamp match. A row
    // already seen before this send, or a different known reference, cannot match.
    const candidates = pending.map((local) => usageTransfers.reduce((indices, history, index) => {
      if (matchedHistory.has(index) || historyReferences[index] ||
          !Number.isSafeInteger(local.recipientId) || local.recipientId <= 0 ||
          String(history.recipientId) !== String(local.recipientId) ||
          history.grossAmount !== local.amount ||
          !Number.isFinite(history.observedAt) || history.observedAt < local.createdMs ||
          Math.abs(history.createdMs - local.createdMs) > 60000) return indices;
      indices.push(index);
      return indices;
    }, []));
    acceptedTransfers = pending.filter((local, localIndex) => {
      const indices = candidates[localIndex];
      if (indices.length !== 1) return true;
      const index = indices[0];
      if (candidates.some((other, otherIndex) => otherIndex !== localIndex && other.includes(index))) return true;
      matchedHistory.add(index);
      return false;
    });
    saveAcceptedTransfers();
    return [...usageTransfers, ...acceptedTransfers];
  }

  function displayAllowances() {
    const transfers = reconcileUsageTransfers();
    const now = Date.now();
    for (const [card, rawCap, windowDays] of [
      [dailyAllowance, limits?.dailyLimit, 1],
      [monthlyAllowance, limits?.monthlyLimit, 30],
    ]) {
      card.value.classList.remove('is-loading');
      const cap = Number(rawCap);
      if (rawCap == null || !Number.isSafeInteger(cap) || cap < 0) {
        card.value.textContent = 'Unavailable';
        card.cap.textContent = 'Account cap unavailable';
        card.pct.textContent = '';
        card.progress.hidden = true;
        card.track.hidden = true;
        continue;
      }
      card.cap.textContent = 'of ' + new Intl.NumberFormat('en-US').format(cap) + ' Robux allowance';
      card.progress.max = Math.max(1, cap);
      card.progress.hidden = !usageReady;
      card.track.hidden = !usageReady;
      if (!usageReady) {
        card.value.textContent = 'Unavailable';
        card.pct.textContent = '';
        continue;
      }
      const used = transfers.reduce((sum, transfer) =>
        transfer.createdMs > now - windowDays * 86400000 ? sum + transfer.amount : sum, 0);
      showRobux(card.value, Math.max(0, cap - used));
      card.progress.value = Math.min(cap, used);
      const ratio = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
      card.pct.textContent = Math.round(ratio * 100) + '% used';
      card.fill.dataset.level = ratio >= 0.92 ? 'high' : ratio >= 0.75 ? 'warn' : 'ok';
      requestAnimationFrame(() => { card.fill.style.transform = 'scaleX(' + ratio + ')'; });
    }
  }

  async function fetchHistoryPage(userId, cursor) {
    const key = userId + ':' + cursor;
    const cached = historyPages.get(key);
    if (cached?.request) return cached.request;
    if (cached?.page && cached.fetchedAt > Date.now() - historyReadMinimumMs) return cached.page;
    const entry = {};
    entry.request = (async () => {
      const url = new URL('https://apis.roblox.com/transaction-records/v1/users/' + userId + '/transactions');
      url.search = new URLSearchParams({ cursor, limit: '100', transactionType: 'CurrencyTransfer', itemPricingType: 'PaidAndLimited' });
      const page = await api(url, undefined, {
        signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(15000)]), preserveTransferId: true,
      });
      if (!Array.isArray(page.data)) throw new Error('Roblox did not return transfer history.');
      entry.page = page;
      entry.fetchedAt = Date.now();
      return page;
    })();
    historyPages.set(key, entry);
    try { return await entry.request; }
    finally {
      entry.request = null;
      if (!entry.page) historyPages.delete(key);
    }
  }

  async function fetchTransferHistory(userId) {
    const grouped = new Map();
    const seenRows = new Set();
    const seenCursors = new Set();
    const cutoff = Date.now() - 30 * 86400000;
    const observedAt = Date.now();
    let cursor = '';
    do {
      if (seenCursors.has(cursor)) throw new Error('Roblox repeated a history page.');
      seenCursors.add(cursor);
      const page = await fetchHistoryPage(userId, cursor);
      const pageObservedAt = Math.min(observedAt, historyPages.get(userId + ':' + cursor)?.fetchedAt ?? observedAt);
      for (const row of page.data) {
        const details = row.details || {};
        if (String(details.senderTargetId) !== String(userId)) continue;
        const value = Number(row.currency?.amount);
        const createdMs = Date.parse(row.created);
        if (!Number.isFinite(value) || !Number.isFinite(createdMs)) continue;
        const isSent = details.transferRole === 'Sender' && value < 0;
        const isRefund = details.transferRole === 'SenderRefund' && value > 0;
        if (!isSent && !isRefund) continue;
        const reference = canonicalTransferReference(details.transferRequestId);
        const rowKey = row.idHash ? 'row:' + row.idHash
          : [reference, row.created, value, details.transferRole, details.recipientTargetId || ''].join(':');
        if (seenRows.has(rowKey)) continue;
        seenRows.add(rowKey);
        const id = reference || String(row.idHash || rowKey);
        const transfer = grouped.get(id) || {
          id, reference, amount: 0, grossAmount: 0,
          recipientId: details.recipientTargetId, createdMs, observedAt: pageObservedAt,
        };
        transfer.observedAt = Math.min(transfer.observedAt, pageObservedAt);
        transfer.amount -= value;
        if (isSent) {
          transfer.grossAmount += Math.abs(value);
          transfer.createdMs = Math.min(transfer.createdMs, createdMs);
          transfer.recipientId = details.recipientTargetId;
        }
        grouped.set(id, transfer);
      }
      const oldest = Date.parse(page.data[page.data.length - 1]?.created);
      if (Number.isFinite(oldest) && oldest < cutoff) break;
      cursor = page.nextPageCursor || '';
    } while (cursor);
    return Array.from(grouped.values()).map((transfer) => ({ ...transfer, amount: Math.max(0, transfer.amount) }));
  }

  function scheduleUsageRefresh() {
    clearTimeout(usageRefreshTimer);
    if (!account || profileLookups.signal.aborted || (parentApproval && parentStatusPaused)) return;
    const ownerId = account.id;
    const pageFetchedAt = historyPages.get(ownerId + ':')?.fetchedAt || -Infinity;
    const delay = Math.max(50, usageLastAttemptAt + historyReadMinimumMs - Date.now() + 10,
      pageFetchedAt + historyReadMinimumMs - Date.now() + 10,
      apiCooldownUntil - Date.now() + 10);
    usageRefreshTimer = setTimeout(() => {
      usageRefreshTimer = null;
      if (profileLookups.signal.aborted || account?.id !== ownerId || (parentApproval && parentStatusPaused)) return;
      if (batchRunning) { batchStatsDirty = true; return; }
      refreshUsage(true, { trailing: true });
    }, delay);
  }

  async function refreshUsage(force = false, { trailing = false } = {}) {
    if (!account || (parentApproval && parentStatusPaused)) return;
    if (usageRequest) {
      if (force) usageRefreshAfterRequest = true;
      return usageRequest;
    }
    if (Date.now() < apiCooldownUntil) { scheduleUsageRefresh(); return; }
    if (usageLastOwnerId === account.id && Date.now() - usageLastAttemptAt < historyReadMinimumMs) {
      displayAllowances();
      allowanceNote.textContent = usageReady ? 'History estimate · recent results reused' : 'History check paused · try again in 30 seconds';
      if (force) scheduleUsageRefresh();
      return;
    }
    const owner = account;
    const revision = statsRevision;
    const cacheKey = 'robux-transfer-usage:' + owner.id;
    let cached;
    try { cached = JSON.parse(sessionStorage.getItem(cacheKey)); } catch { /* Fetch current history. */ }
    if (!force && cached?.version === usageCacheVersion && cached.fetchedAt > Date.now() - 120000 && Array.isArray(cached.transfers)) {
      usageTransfers = cached.transfers;
      usageReady = true;
      displayAllowances();
      allowanceNote.textContent = 'History estimate · last 24h / 30 days';
      return;
    }
    allowanceNote.textContent = 'Updating transfer history…';
    clearTimeout(usageRefreshTimer);
    usageRefreshTimer = null;
    const cachedFirstPage = historyPages.get(owner.id + ':');
    if (force && !trailing && cachedFirstPage?.page && cachedFirstPage.fetchedAt > Date.now() - historyReadMinimumMs) {
      usageRefreshAfterRequest = true;
    }
    usageLastAttemptAt = Date.now();
    usageLastOwnerId = owner.id;
    usageRequest = (async () => {
      try {
        const transfers = await fetchTransferHistory(owner.id);
        if (account !== owner || revision !== statsRevision || profileLookups.signal.aborted) return;
        const firstSeen = new Map(usageTransfers.map((transfer) => [transfer.id, transfer.observedAt]));
        for (const transfer of transfers) {
          const previous = firstSeen.get(transfer.id);
          if (Number.isFinite(previous)) transfer.observedAt = Math.min(transfer.observedAt, previous);
        }
        usageTransfers = transfers;
        usageReady = true;
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ version: usageCacheVersion, transfers, fetchedAt: Date.now() })); } catch { /* Cache is optional. */ }
        displayAllowances();
        allowanceNote.textContent = 'History estimate · last 24h / 30 days';
      } catch {
        if (account !== owner || revision !== statsRevision || profileLookups.signal.aborted) return;
        displayAllowances();
        allowanceNote.textContent = usageReady ? 'Last history estimate · refresh unavailable' : 'Remaining allowance unavailable · try Refresh';
      } finally {
        usageRequest = null;
        setBusy(busy);
        if (usageRefreshAfterRequest) {
          usageRefreshAfterRequest = false;
          scheduleUsageRefresh();
        }
      }
    })();
    setBusy(busy);
    return usageRequest;
  }

  function clearStatsRefreshTimers() {
    for (const timer of statsRefreshTimers) clearTimeout(timer);
    statsRefreshTimers.clear();
  }

  function refreshAfterSend() {
    if (batchRunning) { batchStatsDirty = true; return; }
    clearStatsRefreshTimers();
    const owner = account;
    const revision = ++statsRevision;
    refreshAccountStats();
    for (const delay of [1500, 5000]) {
      const timer = setTimeout(() => {
        statsRefreshTimers.delete(timer);
        if (account === owner && statsRevision === revision && !profileLookups.signal.aborted) {
          refreshAccountStats();
        }
      }, delay);
      statsRefreshTimers.add(timer);
    }
  }

  async function refreshAccountStats() {
    if (!account || profileLookups.signal.aborted) return;
    if (batchRunning || Date.now() < apiCooldownUntil) { batchStatsDirty = true; return; }
    const owner = account;
    if (statsRequest) {
      const revision = statsRequestRevision;
      await statsRequest;
      if (account === owner && revision !== statsRevision && !profileLookups.signal.aborted) {
        return refreshAccountStats();
      }
      return;
    }
    const revision = statsRevision;
    statsRequestRevision = revision;
    allowanceNote.textContent = 'Refreshing balance and limits…';
    statsRequest = (async () => {
      try {
        const readOptions = { signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(15000)]) };
        const [currencyResult, limitsResult] = await Promise.allSettled([
          api('https://economy.roblox.com/v1/user/currency', undefined, readOptions),
          api(transferApi + '/user-transfer-limit', undefined, readOptions),
        ]);
        if (account !== owner || revision !== statsRevision || profileLookups.signal.aborted) return;
        const currency = currencyResult.status === 'fulfilled' ? currencyResult.value : null;
        const transferLimits = limitsResult.status === 'fulfilled' ? limitsResult.value : null;
        const currencyReady = Number.isSafeInteger(currency?.robux) && currency.robux >= 0;
        const limitsReady = Number.isSafeInteger(transferLimits?.perTransferLimit) && transferLimits.perTransferLimit >= 0;
        if (currencyReady) { balance = currency.robux; balanceEstimated = false; }
        if (limitsReady) limits = transferLimits;
        updateAccountDisplay();
        accountStatus.textContent = currencyReady && limitsReady ? ''
          : (!currencyReady && !limitsReady ? 'Balance and limits' : !currencyReady ? 'Balance' : 'Limits')
            + ' could not refresh. Showing previous values.';
        await refreshUsage(true);
      } catch {
        if (account === owner && revision === statsRevision && !profileLookups.signal.aborted) {
          allowanceNote.textContent = 'Account refresh unavailable · try Refresh';
        }
      } finally {
        statsRequest = null;
        setBusy(busy);
      }
    })();
    setBusy(busy);
    return statsRequest;
  }
  refreshAllowanceButton.addEventListener('click', () => {
    if (!busy) return parentApproval ? checkParentTransfer({ manual: true }) : refreshAccountStats();
  });

  function triggerSuccessAnimation() {
    successCheck.replaceChildren(svgIcon([
      {
        d: 'M5 13l4.5 4.5L19 7.5',
        fill: 'none', stroke: 'currentColor', 'stroke-width': '2.8',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'check-path',
      },
    ], ''));
    for (const old of successHero.querySelectorAll('.burst-dot')) old.remove();
    const colors = ['#22c55e', '#3b82f6', '#6366f1', '#f59e0b', '#38bdf8'];
    for (let i = 0; i < 12; i++) {
      const angle = (Math.PI * 2 * i) / 12 + (Math.random() * 0.25 - 0.125);
      const dist = 42 + Math.random() * 26;
      const dot = element('span', '', { class: 'burst-dot', 'aria-hidden': 'true' });
      dot.style.background = colors[i % colors.length];
      dot.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
      dot.style.setProperty('--dy', Math.round(Math.sin(angle) * dist) + 'px');
      dot.addEventListener('animationend', () => dot.remove(), { once: true });
      successHero.append(dot);
    }
  }

  function showSuccess(transfer, { recordUsage = true, refresh = true, confirmed = false } = {}) {
    const submittedAt = new Date();
    lastReceipt = { ...transfer, sender: account.name, submittedAt: submittedAt.toLocaleString(), confirmed };
    if (recordUsage) acceptedTransfers.push({ id: transfer.id, recipientId: transfer.recipientId, amount: transfer.amount, createdMs: submittedAt.getTime() });
    displayAllowances();
    transferTitle.textContent = 'Transfer submitted';
    recipientSection.hidden = true;
    form.hidden = true;
    successPanel.hidden = false;
    animatePanel(successPanel);
    triggerSuccessAnimation();
    showRobux(successAmount, transfer.amount);
    const avatar = createAvatar(transfer.recipientId, transfer.username);
    successRecipient.replaceChildren(avatar, element('a', '@' + transfer.username, {
      href: robloxWebsite + '/users/' + transfer.recipientId + '/profile', target: '_blank', rel: 'noopener noreferrer',
    }));
    loadAvatars([avatar], profileLookups.signal);
    receiptSender.textContent = '@' + account.name;
    receiptTime.parentElement.querySelector('dt').textContent = confirmed ? 'Confirmed' : 'Time';
    receiptTime.textContent = lastReceipt.submittedAt;
    receiptReference.textContent = transfer.id;
    receiptTransferId.textContent = normalizeTransferId(transfer.transferId);
    receiptTransferId.parentElement.hidden = !receiptTransferId.textContent;
    receiptStatus.textContent = '';
    newTransferButton.hidden = false;
    if (refresh) refreshAfterSend();
  }

  copyReceiptButton.addEventListener('click', async () => {
    if (!lastReceipt) return;
    try {
      await navigator.clipboard.writeText([
        'Robux transfer ' + (lastReceipt.confirmed ? 'completed' : lastReceipt.verifiedSent ? 'sent' : 'submitted'),
        'From: @' + lastReceipt.sender,
        'To: @' + lastReceipt.username + ' (' + lastReceipt.recipientId + ')',
        'Amount: ' + lastReceipt.amount + ' Robux',
        (lastReceipt.confirmed ? 'Confirmed: ' : lastReceipt.verifiedSent ? 'Verified: ' : 'Time: ') + lastReceipt.submittedAt,
        'Reference: ' + lastReceipt.id,
        ...(lastReceipt.transferId ? ['Transfer ID: ' + lastReceipt.transferId] : []),
        ...(lastReceipt.verifiedSent ? ['Sent verified in My Transactions. Recipient acceptance has not been verified.'] : []),
      ].join('\n'));
      receiptStatus.textContent = 'Receipt copied.';
      copyReceiptButton.textContent = 'Copied ✓';
      setTimeout(() => { copyReceiptButton.textContent = 'Copy receipt'; }, 1800);
    } catch { receiptStatus.textContent = 'Clipboard unavailable. You can select the receipt text.'; }
  });

  async function loadAccount() {
    if (busy || locked) return;
    clearStatsRefreshTimers();
    statsRevision++;
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
      balanceEstimated = false;
      try {
        const recent = JSON.parse(sessionStorage.getItem('robux-transfer-recent:' + user.id));
        acceptedTransfers = (Array.isArray(recent) ? recent : []).filter((transfer) =>
          typeof transfer.id === 'string' && Number.isFinite(transfer.amount) && transfer.amount > 0 &&
          Number.isFinite(transfer.createdMs) && transfer.createdMs > Date.now() - 30 * 86400000);
        // Older saved sends did not retain the recipient ID. Recover it only
        // from this sender's saved batch and an exact canonical reference match.
        let savedBatch;
        try { savedBatch = JSON.parse(sessionStorage.getItem(batchKey)); } catch { /* Keep valid recent sends if the batch cache is damaged. */ }
        if (savedBatch?.senderId === user.id && Array.isArray(savedBatch.rows)) {
          const recipients = new Map(savedBatch.rows.filter((row) => row && typeof row.reference === 'string')
            .map((row) => [canonicalTransferReference(row.reference), row.recipientId]));
          acceptedTransfers = acceptedTransfers.map((transfer) => {
            const recipientId = recipients.get(canonicalTransferReference(transfer.id));
            return !Number.isSafeInteger(transfer.recipientId) && Number.isSafeInteger(recipientId) && recipientId > 0
              ? { ...transfer, recipientId } : transfer;
          });
        }
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
      dailyAllowance.value.classList.remove('is-loading');
      monthlyAllowance.value.classList.remove('is-loading');
    } finally {
      setBusy(false);
      if (batchMode) renderBatch();
    }
  }
  reloadButton.addEventListener('click', loadAccount);

  function showAmountEditor() {
    if (busy || locked) return;
    prepared = null;
    review.hidden = true;
    editFields.hidden = false;
    animatePanel(editFields);
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
    batch.forEach((user, index) => {
      const username = '@' + user.name;
      const result = element('button', '', { type: 'button', class: 'result' });
      result.style.setProperty('--i', String(index));
      const avatar = createAvatar(user.id, user.name);
      const names = element('span', user.displayName || username, { class: 'result-names' });
      if (user.displayName) names.append(element('span', username, { class: 'username' }));
      result.append(avatar, names);
      avatars.push(avatar);
      result.addEventListener('click', () => selectRecipient(String(user.id), user.name));
      searchResults.append(result);
    });
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
        const options = {
          credentials: 'omit',
          signal: AbortSignal.any([profileLookups.signal, AbortSignal.timeout(8000)]),
        };
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
    animatePanel(selectedRecipient);
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
    animatePanel(searchForm);
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
    if (batchMode) {
      setBusy(true);
      try { await addBatchRecipient(value); }
      catch (error) { prepareStatus.textContent = error.message; }
      finally { setBusy(false); renderBatch(); }
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
      prepared = Object.freeze({
        id: transfer.transferRequestId, senderId: account.id,
        recipientId: target.id, username: target.name, amount: value,
      });
      recipientLink.textContent = '@' + target.name;
      reviewedRecipient.textContent = 'To @' + target.name + ' · User ID ' + target.id;
      showRobux(total, value);
      status.textContent = '';
      transactionsLink.hidden = true;
      editFields.hidden = true;
      review.hidden = false;
      animatePanel(review);
      sendButton.hidden = false;
    } catch (error) {
      prepared = null;
      prepareStatus.textContent = error.message;
    } finally {
      setBusy(false);
    }
    if (prepared) sendButton.focus();
  });
  amount.addEventListener('input', () => {
    amount.setCustomValidity('');
    syncPresetHighlight();
  });
  editButton.addEventListener('click', showAmountEditor);
  sendButton.addEventListener('click', async () => {
    if (!prepared || busy || locked) return;
    const transfer = prepared;
    setBusy(true);
    status.textContent = 'Checking sender…';
    try {
      const currentUser = await api(usersApi + '/authenticated');
      if (currentUser.id !== transfer.senderId) throw new Error('Your signed-in account changed. Reload the page.');
      sessionStorage.setItem(pendingKey, JSON.stringify(transfer));
      locked = true;
      status.textContent = 'Sending ' + transfer.amount + ' Robux to @' + transfer.username + '…';
      try {
        await api(transferApi + '/process-transfer/' + encodeURIComponent(transfer.id),
          { robuxAmount: transfer.amount }, { processing: true });
        sessionStorage.removeItem(pendingKey);
        showSuccess(transfer);
      } catch (error) {
        if (error.parentConsentRequired) {
          beginParentApproval(transfer);
          status.textContent = 'Parent approval is required. Use Ask parent below.';
        } else if (error.definitelyRejected) {
          sessionStorage.removeItem(pendingKey);
          locked = false;
        } else {
          acknowledgedButton.hidden = false;
        }
        if (!error.parentConsentRequired) status.textContent = error.definitelyRejected ? error.message
          : error.message + ' The outcome is unconfirmed. Check My Transactions before sending again.';
      }
      prepared = null;
      sendButton.hidden = true;
      transactionsLink.hidden = Boolean(parentApproval);
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
    animatePanel(recipientSection);
    selectedRecipient.hidden = true;
    searchForm.hidden = false;
    form.hidden = true;
    amount.value = '';
    syncPresetHighlight();
    searchField.value = '';
    clearSearch();
    loadAccount();
    searchField.focus();
  });

  function restoreBatch(saved) {
    const statuses = new Set(['waiting', 'preparing', 'sending', 'submitted', 'failed', 'unconfirmed', 'skipped',
      'parent_required', 'parent_requesting', 'parent_pending', 'parent_unknown', 'parent_checked', 'parent_cancelled', 'parent_failed', 'parent_refunded']);
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.senderId) || saved.senderId <= 0 ||
        !Array.isArray(saved.rows) || !saved.rows.length || saved.rows.length > 50) return false;
    const ids = new Set();
    for (const row of saved.rows) {
      if (!Number.isSafeInteger(row.recipientId) || row.recipientId <= 0 || ids.has(row.recipientId) ||
          !Number.isSafeInteger(row.amount) || row.amount < 10 || typeof row.username !== 'string' ||
          !/^[a-z0-9_]{1,20}$/i.test(row.username) || !statuses.has(row.status) ||
          (row.reference !== undefined && typeof row.reference !== 'string')) return false;
      ids.add(row.recipientId);
    }
    batchSenderId = saved.senderId;
    batchNextRecipientAt = Number.isFinite(saved.nextRecipientAt) ? saved.nextRecipientAt : 0;
    batchRows = saved.rows.map((row) => ({
      ...row,
      transferId: normalizeTransferId(row.transferId) || undefined,
      status: row.status === 'sending' ? 'unconfirmed' : row.status === 'preparing' ? 'waiting'
        : row.status === 'parent_requesting' ? 'parent_unknown' : row.status,
    }));
    batchPhase = saved.phase === 'draft' && batchRows.every((row) => row.status === 'waiting') ? 'draft'
      : remainingBatchRows().length || hasUnknownBatchRow() || hasParentApprovalRow() ? 'paused' : 'complete';
    batchMode = true;
    batchSnapshot = null;
    locked = hasUnknownBatchRow() || hasParentApprovalRow();
    resetRecipientEditor();
    renderBatch(true);
    return true;
  }

  document.body.append(host);
  dialog.showModal();
  updateCooldownStatus();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(pendingKey)); } catch { /* No saved attempt. */ }
  let savedBatch;
  try { savedBatch = JSON.parse(sessionStorage.getItem(batchKey)); } catch { /* No saved batch. */ }
  parentApproval = readParentApproval(pending);
  const restoredBatch = (!pending?.id || pending.batch === true) && restoreBatch(savedBatch);
  if (restoredBatch && pending?.id) {
    const row = batchRows.find((entry) => entry.reference === pending.id);
    if ((row?.status === 'submitted' || row?.status === 'parent_checked' || row?.status === 'parent_cancelled' || row?.status === 'parent_failed' || row?.status === 'parent_refunded')
        && !terminalParentStatus(parentApproval?.transferStatus)) {
      parentApproval = null;
      try { sessionStorage.removeItem(pendingKey); pending = null; } catch { /* Preserve the submitted or checked row; never repeat it. */ }
    } else if (row && !parentApproval && !row.status.startsWith('parent_')) {
      row.status = 'unconfirmed';
      row.error = 'Previous request is unconfirmed. Check My Transactions; this row will not be retried.';
      locked = true;
    }
    renderBatch(true);
  }
  if (restoredBatch && !parentApproval) {
    const row = batchRows.find((entry) => ['parent_required', 'parent_requesting', 'parent_pending', 'parent_unknown'].includes(entry.status));
    if (row && (!pending?.id || pending.id === row.reference)) {
      const states = { parent_required: 'required', parent_requesting: 'unknown', parent_pending: 'requested', parent_unknown: 'unknown' };
      parentApproval = readParentApproval({ id: row.reference, senderId: batchSenderId,
        recipientId: row.recipientId, username: row.username, amount: row.amount, batch: true,
        parentApproval: states[row.status], transferStatus: row.parentTransferStatus, confirmationSource: row.parentConfirmationSource, transferId: row.transferId });
    }
  }
  if (parentApproval) {
    if (!restoredBatch || !parentApproval.batch || !batchRows.some((row) => row.reference === parentApproval.id)) {
      if (parentApproval.batch) parentApproval.parentApproval = 'unknown';
      parentApproval.batch = false;
      batchMode = false;
      setBatchDrawerOpen(false, true);
      modeSwitch.dataset.mode = 'single';
      singleModeButton.setAttribute('aria-pressed', 'true');
      batchModeButton.setAttribute('aria-pressed', 'false');
      recipientSection.hidden = true;
      form.hidden = false;
      editFields.hidden = true;
      review.hidden = false;
      sendButton.hidden = true;
      acknowledgedButton.hidden = true;
      transactionsLink.hidden = true;
      reviewedRecipient.textContent = 'To @' + parentApproval.username + ' · User ID ' + parentApproval.recipientId;
      showRobux(total, parentApproval.amount);
      status.textContent = 'This transfer requires parent approval. It will not be processed again by this script.';
    } else {
      const row = batchRows.find((entry) => entry.reference === parentApproval.id);
      const states = { required: 'parent_required', requesting: 'parent_requesting', requested: 'parent_pending', unknown: 'parent_unknown' };
      const outcomes = { Completed: 'submitted', Submitted: 'submitted', Cancelled: 'parent_cancelled', Failed: 'parent_failed', Refunded: 'parent_refunded' };
      row.status = outcomes[parentApproval.transferStatus] || states[parentApproval.parentApproval];
      batchPhase = 'paused';
      renderBatch(true);
    }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(parentApproval)); } catch { /* Keep the pending request locked in memory. */ }
    locked = true;
    accountLabel.textContent = 'Parent approval pending';
    dailyAllowance.value.classList.remove('is-loading');
    monthlyAllowance.value.classList.remove('is-loading');
    dailyAllowance.value.textContent = 'Unavailable';
    monthlyAllowance.value.textContent = 'Unavailable';
    allowanceNote.textContent = 'Check this transfer in Roblox before continuing';
    renderParentApproval();
    setBusy(false);
    if (['requested', 'unknown'].includes(parentApproval.parentApproval) || parentApproval.transferStatus) startParentStatusWatch();
  } else if (restoredBatch && (!pending?.id || batchRows.some((row) => row.reference === pending.id))) {
    if (hasUnknownBatchRow()) {
      accountLabel.textContent = 'Check the previous batch request first';
      dailyAllowance.value.classList.remove('is-loading');
      monthlyAllowance.value.classList.remove('is-loading');
      dailyAllowance.value.textContent = 'Unavailable';
      monthlyAllowance.value.textContent = 'Unavailable';
      allowanceNote.textContent = 'Check My Transactions before continuing';
      batchStatus.textContent = 'Batch paused. Check the unconfirmed row in My Transactions. Acknowledging it skips that row permanently.';
      locked = true;
      setBusy(false);
      renderBatch(true);
    } else {
      loadAccount();
    }
  } else if (pending?.id) {
    batchMode = false;
    setBatchDrawerOpen(false, true);
    modeSwitch.dataset.mode = 'single';
    singleModeButton.setAttribute('aria-pressed', 'true');
    batchModeButton.setAttribute('aria-pressed', 'false');
    reviewButton.textContent = 'Review transfer';
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
    dailyAllowance.value.classList.remove('is-loading');
    monthlyAllowance.value.classList.remove('is-loading');
    dailyAllowance.value.textContent = 'Unavailable';
    monthlyAllowance.value.textContent = 'Unavailable';
    allowanceNote.textContent = 'Check the previous request before refreshing';
    setBusy(false);
  } else {
    if (currentProfile) selectRecipient(currentProfile[1]);
    else searchField.focus();
    loadAccount();
  }
})();

