// Extracted from index.html <script> (formerly inline).
// NOTE: This file must be loaded after Leaflet/Turf are loaded.

// ╔═══════════════════════════════════════════════════╗
// ║  CONFIG — replace with your Apps Script URL       ║
// ╚═══════════════════════════════════════════════════╝
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx2Kk9Z0mmH4REuybyUWT8_29SeH0AgaMw5cSwK_m4lagnpmVTGgdVEAq9M_BkToFbo_g/exec";
const AVATAR_FOLDER_ID = "1UoskrRd1X4KC1R5tXJUtDslxo5W0pIzV";

// ─── State ────────────────────────────────────────────
const state = {
  points:        [],        // [[lat,lng], ...]  from GPS
  markers:       [],        // Leaflet node markers
  liveMarker:    null,      // moving "you are here" marker
  liveAccCircle: null,      // accuracy circle
  polyline:      null,      // live preview polyline
  existingLayers:[],
  existingTurf:  [],
  pendingCoords: null,
  pendingArea:   0,
  deviceId:      getDeviceId(),
  profile:       getProfile(),
  registered:    isRegistered_(),
  remoteAvatars: null,      // [{id,name,url,mimeType}, ...]
  otherUsers:    new Map(), // deviceId -> Leaflet marker
  lastHeartbeatAt: 0,
  onlinePollTimer: null,
  portfolio:     { parcels:0, value:0, area:0 },
  owners:        {},
  gpsReady:      false,
  currentPos:    null,      // latest GeolocationPosition
  watchId:       null,
};

// ─── Map Initialization ───────────────────────────────
const map = L.map('map', {
  center: [7.0, 125.6],
  zoom: 17,
  zoomControl: true,
  tap: false,               // map taps no longer place points
  doubleClickZoom: false,
});

L.tileLayer(
  'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
  { subdomains:['mt0','mt1','mt2','mt3'], maxZoom: 21 }
).addTo(map);

// ─── Live GPS Watch ───────────────────────────────────
function startGPSWatch() {
  if (!navigator.geolocation) {
    showToast('❌ GPS not supported on this device.', 'error');
    setStatus('GPS NOT AVAILABLE', 'error');
    return;
  }

  setStatus('🛰 ACQUIRING GPS SIGNAL…', '');

  state.watchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    onGPSError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function onGPSUpdate(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  state.currentPos = [lat, lng];
  state.gpsReady   = true;

  // First fix — fly to location
  if (!state.liveMarker) {
    map.setView([lat, lng], 19);
  }

  // Update live "you" marker
  if (state.liveMarker) map.removeLayer(state.liveMarker);
  if (state.liveAccCircle) map.removeLayer(state.liveAccCircle);

  const icon = createSelfIcon();
  state.liveMarker    = L.marker([lat, lng], { icon, interactive:false, zIndexOffset:1000 }).addTo(map);
  state.liveAccCircle = L.circle([lat, lng], {
    radius: accuracy,
    color: '#00e5ff', fillColor:'#00e5ff',
    fillOpacity: 0.06, weight: 1, dashArray:'4 4'
  }).addTo(map);

  // Update accuracy badge
  document.getElementById('pts-badge').style.display = 'block';
  document.getElementById('acc-val').textContent = Math.round(accuracy) + 'm';

  if (!state.gpsWasReady) {
    state.gpsWasReady = true;
    setStatus('WALK TO A CORNER — PRESS MARK HERE', '');
    showToast(`📡 GPS locked! ±${Math.round(accuracy)}m accuracy`, 'info');
    document.getElementById('btn-mark').disabled = false;
  }

  // Presence + live location (throttled)
  heartbeatIfDue(lat, lng);
}

function onGPSError(err) {
  const msgs = {
    1: 'Location permission denied. Please allow GPS.',
    2: 'GPS signal lost. Move to open sky.',
    3: 'GPS timeout. Retrying…'
  };
  showToast('⚠ ' + (msgs[err.code] || 'GPS error'), 'error');
  setStatus('GPS ERROR — CHECK PERMISSIONS', 'error');
}

// ─── MARK HERE — core action ─────────────────────────
function markHere() {
  if (!state.gpsReady || !state.currentPos) {
    showToast('⏳ Waiting for GPS fix…', 'error');
    return;
  }

  const [lat, lng] = state.currentPos;
  const n = state.points.length + 1;

  // Visual feedback on button
  const btn = document.getElementById('btn-mark');
  btn.classList.add('locking');
  setTimeout(() => btn.classList.remove('locking'), 650);

  // Place numbered node marker
  const icon = L.divIcon({
    html: `<div style="
      width:26px;height:26px;
      background:var(--cyan);
      border:2px solid #fff;
      border-radius:50%;
      box-shadow:0 0 10px var(--cyan),0 0 20px rgba(0,229,255,0.4);
      display:flex;align-items:center;justify-content:center;
      font-family:'Orbitron',monospace;font-size:9px;font-weight:700;
      color:#000;
    ">${n}</div>`,
    className: '', iconSize:[26,26], iconAnchor:[13,13]
  });

  const marker = L.marker([lat, lng], { icon }).addTo(map);
  marker.bindTooltip(`Node ${n}<br>${lat.toFixed(6)}, ${lng.toFixed(6)}`, { permanent:false });
  state.markers.push(marker);
  state.points.push([lat, lng]);

  updatePreview();
  updateUI();

  showToast(`📍 Node ${n} marked at ±${Math.round(state.currentPos._acc || 0)}m`, 'info');
}

// ─── Pulse Marker (static, for existing parcels label) ───
function addPulseMarker(latlng) {
  const icon = L.divIcon({
    html: `<div class="pulse-marker"><div class="pulse-dot"></div><div class="pulse-ring"></div></div>`,
    className: '', iconSize:[16,16], iconAnchor:[8,8]
  });
  L.marker(latlng, { icon, interactive:false }).addTo(map);
}

// ─── Preview polyline ─────────────────────────────────
function updatePreview() {
  if (state.polyline) map.removeLayer(state.polyline);
  if (state.points.length < 2) return;
  const pts = state.points.length >= 3
    ? [...state.points, state.points[0]]
    : state.points;
  state.polyline = L.polyline(pts, {
    color: '#00e5ff', weight: 2, dashArray: '6 4', opacity: 0.85
  }).addTo(map);
}

// ─── UI sync ──────────────────────────────────────────
function updateUI() {
  const n = state.points.length;
  document.getElementById('pts-count').textContent = n;
  document.getElementById('btn-finish').disabled = n < 3;

  if (n === 0) {
    setStatus('WALK TO A CORNER — PRESS MARK HERE', '');
  } else if (n < 3) {
    setStatus(`NODE ${n} LOCKED ✓ — WALK TO NEXT CORNER`, '');
  } else {
    setStatus(`${n} NODES — PRESS FINISH OR KEEP WALKING`, '');
  }
}

// ─── Clear all points ─────────────────────────────────
function clearPoints() {
  state.points = [];
  state.markers.forEach(m => map.removeLayer(m));
  state.markers = [];
  if (state.polyline) { map.removeLayer(state.polyline); state.polyline = null; }
  document.getElementById('pts-count').textContent = '0';
  document.getElementById('btn-finish').disabled = true;
  if (state.gpsReady) setStatus('CLEARED — WALK TO FIRST CORNER & MARK HERE', '');
  else setStatus('ACQUIRING GPS SIGNAL…', '');
}

// ─── Finish polygon & check overlaps ──────────────────
function finishPolygon() {
  if (state.points.length < 3) {
    showToast('Need at least 3 nodes!', 'error'); return;
  }

  const coords = [...state.points];

  // Build turf polygon (close it)
  const ring = coords.map(p => [p[1], p[0]]); // turf uses [lng,lat]
  ring.push(ring[0]);
  const newPoly = turf.polygon([ring]);

  // ── Overlap Detection ──────────────────────────────
  let overlap = false;
  let overlapLayer = null;

  for (const existing of state.existingTurf) {
    try {
      const intersection = turf.intersect(newPoly, existing.poly);
      if (intersection) {
        overlap = true;
        overlapLayer = existing;
        break;
      }
    } catch(_) {}
  }

  if (overlap) {
    // Flash conflict area red
    const conflictLayer = L.polygon(coords, {
      color: '#ff2442', fillColor: '#ff2442',
      fillOpacity: 0.45, weight: 3,
      className: 'overlap-flash'
    }).addTo(map);
    setTimeout(() => map.removeLayer(conflictLayer), 1500);

    setStatus('⚠ LAND DISPUTE DETECTED!', 'error');
    showToast('🚨 LAND DISPUTE! Your claim overlaps with an existing parcel.', 'error');

    // Highlight conflicting existing parcel
    if (overlapLayer && overlapLayer.layer) {
      const orig = overlapLayer.layer.options.color;
      overlapLayer.layer.setStyle({ color:'#ff2442', weight:3 });
      setTimeout(() => overlapLayer.layer.setStyle({ color: orig || '#f0a500', weight:2 }), 2000);
    }
    return;
  }

  // ── Area Calculation ───────────────────────────────
  const areaSqm = Math.round(turf.area(newPoly));
  const value   = areaSqm * 10;

  state.pendingCoords = coords;
  state.pendingArea   = areaSqm;

  // Populate modal
  document.getElementById('modal-area').textContent  = areaSqm.toLocaleString() + ' m²';
  document.getElementById('modal-value').textContent = '$' + value.toLocaleString();
  document.getElementById('input-title').value = '';
  document.getElementById('input-owner').value = '';

  openModal();
}

// ─── Modal helpers ────────────────────────────────────
function openModal() {
  document.getElementById('claim-modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById('input-title').focus(), 400);
}

function cancelModal() {
  document.getElementById('claim-modal-overlay').classList.remove('show');
}

// ─── Submit claim ─────────────────────────────────────
async function submitClaim() {
  const titleNo = document.getElementById('input-title').value.trim();
  const owner   = document.getElementById('input-owner').value.trim();

  if (!titleNo) { showToast('Please enter a Land Title name.', 'error'); return; }
  if (!owner)   { showToast('Please enter an Owner name.',     'error'); return; }

  const areaSqm = state.pendingArea;
  const value   = areaSqm * 10;
  const coords  = state.pendingCoords;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '⏳ Registering…';

  const payload = {
    deviceId: state.deviceId,
    titleNo, owner,
    area:  areaSqm,
    value: value,
    coordinates: coords
  };

  try {
    // Save to Google Sheets
    await postToSheet(payload, { requireServer: true });

    // Draw the parcel on map
    drawParcel(coords, titleNo, owner, value, areaSqm);

    // Update HUD stats
    state.portfolio.parcels++;
    state.portfolio.value += value;
    state.portfolio.area  += areaSqm;
    updateStatsHUD();

    // Update leaderboard
    state.owners[owner] = (state.owners[owner] || 0) + value;
    updateLeaderboard();

    // Shout message on map
    const center = coords.reduce((a,c)=>[a[0]+c[0]/coords.length, a[1]+c[1]/coords.length], [0,0]);
    showShoutMarker(center, `"I just claimed ${titleNo} for $${value.toLocaleString()}!"`);

    cancelModal();
    clearPoints();

    setStatus('PARCEL REGISTERED ✓ — WALK TO NEXT CLAIM', 'success');
    showToast(`🏛 "${titleNo}" claimed for $${value.toLocaleString()}!`, 'gold');

  } catch(err) {
    showToast('❌ Failed to save. Check your Apps Script URL.', 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '🏛 REGISTER PARCEL';
  }
}

// ─── Draw existing/new parcel on map ─────────────────
function drawParcel(coords, titleNo, owner, value, area) {
  const colors = ['#f0a500','#00e5ff','#a855f7','#00e676','#ff8a65'];
  const color  = colors[state.existingTurf.length % colors.length];

  const layer = L.polygon(coords, {
    color,
    fillColor: color,
    fillOpacity: 0.2,
    weight: 2
  }).addTo(map);

  layer.bindPopup(`
    <div style="font-family:'Rajdhani',sans-serif;min-width:160px">
      <strong style="color:${color};font-size:15px">${titleNo}</strong><br>
      <span style="color:#888;font-size:11px">Owner:</span> <strong>${owner}</strong><br>
      <span style="color:#888;font-size:11px">Area:</span> ${area.toLocaleString()} m²<br>
      <span style="color:#888;font-size:11px">Value:</span> <strong style="color:#f0a500">$${value.toLocaleString()}</strong>
    </div>
  `);

  // Store for overlap detection
  const ring = coords.map(p => [p[1], p[0]]);
  ring.push(ring[0]);
  state.existingTurf.push({
    poly:  turf.polygon([ring]),
    layer: layer
  });
  state.existingLayers.push(layer);
}

// ─── Shout popup on map ───────────────────────────────
function showShoutMarker([lat, lng], msg) {
  const icon = L.divIcon({
    html: `<div style="
      background:rgba(10,15,28,0.92);
      border:1px solid var(--gold);
      border-radius:8px;
      padding:6px 10px;
      font-family:'Rajdhani',sans-serif;
      font-size:12px;
      color:var(--gold);
      white-space:nowrap;
      box-shadow:0 0 12px rgba(240,165,0,0.3);
      max-width:200px;
      white-space:normal;
      text-align:center;
    ">${msg}</div>`,
    className: '', iconAnchor:[0,0]
  });
  const m = L.marker([lat, lng], { icon }).addTo(map);
  setTimeout(() => map.removeLayer(m), 6000);
}

// ─── Google Sheets integration ────────────────────────
async function postToSheet(payload, opts = {}) {
  const requireServer = !!opts.requireServer;
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
    const msg = 'Apps Script URL not set. Edit APPS_SCRIPT_URL in app.js';
    console.warn(msg);
    if (requireServer) throw new Error(msg);
    return { status: 'skipped' };
  }
  const params = new URLSearchParams();
  params.append('payload', JSON.stringify(payload));
  await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    mode:   'no-cors',
    body:   params
  });
  return { status: 'ok' };
}

async function pingServer_() {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') return false;
  try {
    const res = await fetch(APPS_SCRIPT_URL + '?action=ping', { method: 'GET' });
    const data = await res.json();
    return !!(data && data.status === 'ok');
  } catch (_) {
    return false;
  }
}

async function loadExistingParcels() {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
    console.warn('No Apps Script URL — skipping initial load.');
    return;
  }
  try {
    const res  = await fetch(APPS_SCRIPT_URL + '?action=getParcels');
    const data = await res.json();
    if (data.status !== 'ok') return;

    data.parcels.forEach(p => {
      if (!p.coordinates || p.coordinates.length < 3) return;
      drawParcel(p.coordinates, p.titleNo, p.owner, p.value, p.area);
      state.portfolio.parcels++;
      state.portfolio.value += parseFloat(p.value) || 0;
      state.portfolio.area  += parseFloat(p.area)  || 0;
      state.owners[p.owner] = (state.owners[p.owner] || 0) + (parseFloat(p.value) || 0);
    });

    updateStatsHUD();
    updateLeaderboard();
  } catch(e) {
    console.warn('Could not load existing parcels:', e);
  }
}

// ─── Profile + Online Users (faces on markers) ────────────────
function getProfile() {
  const displayName = (localStorage.getItem('lt_profile_name') || '').trim();
  const avatarUrl   = (localStorage.getItem('lt_profile_avatar') || '').trim();
  return {
    displayName: displayName || ('Tycoon ' + stateOrRandomSuffix_()),
    avatarUrl
  };
}

function isRegistered_() {
  // Treat as registered only if explicitly marked AND has a name.
  // This prevents a stale flag from hiding registration UI.
  const flag = localStorage.getItem('lt_profile_registered') === '1';
  const name = (localStorage.getItem('lt_profile_name') || '').trim();
  return flag && !!name;
}

function stateOrRandomSuffix_() {
  const existing = localStorage.getItem('lt_profile_suffix');
  if (existing) return existing;
  const s = Math.random().toString(36).slice(2, 6).toUpperCase();
  localStorage.setItem('lt_profile_suffix', s);
  return s;
}

function setProfile(profile) {
  state.profile = {
    displayName: (profile.displayName || '').trim(),
    avatarUrl: (profile.avatarUrl || '').trim()
  };
  localStorage.setItem('lt_profile_name', state.profile.displayName);
  localStorage.setItem('lt_profile_avatar', state.profile.avatarUrl);
  renderProfileChip();
}

function getCustomGallery_() {
  try {
    const raw = localStorage.getItem('lt_custom_gallery');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => x && x.name && x.url) : [];
  } catch(_) {
    return [];
  }
}

function setCustomGallery_(arr) {
  localStorage.setItem('lt_custom_gallery', JSON.stringify(arr || []));
}

async function loadRemoteAvatars_() {
  if (state.remoteAvatars) return state.remoteAvatars;
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') return null;
  try {
    const res = await fetch(APPS_SCRIPT_URL + `?action=avatars&folderId=${encodeURIComponent(AVATAR_FOLDER_ID)}`);
    const data = await res.json();
    if (data.status !== 'ok' || !Array.isArray(data.avatars)) return null;
    state.remoteAvatars = data.avatars
      .filter(a => a && a.url && a.name)
      .slice(0, 40);
    return state.remoteAvatars;
  } catch (e) {
    console.warn('Could not load avatar list:', e);
    return null;
  }
}

function getWebDefaultCharacters_() {
  // Web defaults without copyrighted images.
  // DiceBear gives deterministic avatars via URL.
  const mk = (label, seed, style='adventurer') => ({
    name: label,
    url: `https://api.dicebear.com/8.x/${style}/svg?seed=${encodeURIComponent(seed)}`
  });
  return [
    mk('Solo Leveling — Jin-Woo', 'JinWoo'),
    mk('Solo Leveling — Cha Hae-In', 'ChaHaeIn'),
    mk('Baki — Baki', 'BakiHanma'),
    mk('Baki — Yujiro', 'YujiroHanma'),
    mk('Gamble — High Roller', 'HighRoller'),
    mk('Gamble — Card Shark', 'CardShark'),
    mk('Shadow Monarch', 'ShadowMonarch'),
    mk('Arena Fighter', 'ArenaFighter'),
  ];
}

function initials_(name) {
  const parts = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map(p => p[0].toUpperCase()).join('');
}

function escapeXml_(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}

function renderAvatarGrid_() {
  const grid = document.getElementById('avatar-grid');
  if (!grid) return;

  const render = (avatars) => {
    grid.innerHTML = avatars.map((a, idx) => `
    <button type="button" class="btn-tycoon" data-avatar-idx="${idx}" style="
      max-width:none;
      padding:0;
      border-radius:12px;
      border:1px solid rgba(240,165,0,0.22);
      background: rgba(255,255,255,0.03);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      gap:6px;
      min-height: 86px;
    ">
      <div style="width:44px;height:44px;border-radius:50%;overflow:hidden;border:2px solid rgba(255,255,255,0.55)">
        <img src="${escapeHtml_(a.preview || a.url)}" alt="${escapeHtml_(a.name)}" style="width:100%;height:100%;object-fit:cover;display:block"/>
      </div>
      <div style="font-family:'Orbitron',monospace;font-size:9px;color:var(--text);line-height:1.05;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">
        ${escapeHtml_(a.name)}
      </div>
    </button>
  `).join('');

    grid.onclick = (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-avatar-idx]') : null;
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-avatar-idx'), 10);
      const chosen = avatars[idx];
      if (!chosen) return;
      document.getElementById('profile-avatar-input').value = chosen.url || '';
      syncProfilePreview();
    };

    // Right-click to remove custom avatars (desktop)
    grid.oncontextmenu = (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-avatar-idx]') : null;
      if (!btn) return;
      ev.preventDefault();
      const idx = parseInt(btn.getAttribute('data-avatar-idx'), 10);
      const chosen = avatars[idx];
      if (!chosen || !chosen._customId) return;
      setCustomGallery_(getCustomGallery_().filter(x => x.id !== chosen._customId));
      renderAvatarGrid_();
      showToast('🗑 Removed from gallery', 'info');
    };
  };

  grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dim);font-size:12px">Loading characters…</div>`;

  loadRemoteAvatars_().then((remote) => {
    const remoteAvatars = (remote && remote.length) ? remote.map(a => ({ name: a.name, url: a.url })) : [];
    const custom = getCustomGallery_().map(a => ({ name: a.name, url: a.url, _customId: a.id }));
    const webDefaults = getWebDefaultCharacters_();

    const merged = [...custom, ...remoteAvatars, ...webDefaults];
    const seen = new Set();
    const deduped = merged.filter(a => {
      const k = String(a.url || '');
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 60);

    render(deduped.length ? deduped : webDefaults);
  }).catch(() => {
    render(getWebDefaultCharacters_());
  });
}

function renderProfileChip() {
  const nameEl = document.getElementById('profile-name');
  const imgEl  = document.getElementById('profile-avatar-img');
  nameEl.textContent = state.profile.displayName || 'Select Profile';

  const url = (state.profile.avatarUrl || '').trim();
  if (url) {
    imgEl.src = url;
  } else {
    imgEl.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
        <rect width="100%" height="100%" fill="#0a0f1c"/>
        <circle cx="32" cy="26" r="12" fill="#00e5ff" opacity="0.65"/>
        <rect x="14" y="40" width="36" height="18" rx="9" fill="#f0a500" opacity="0.55"/>
      </svg>`
    );
  }
}

function openProfileModal() {
  const overlay = document.getElementById('profile-modal-overlay');
  // Make it robust even if CSS fails to load.
  overlay.style.display = 'flex';
  overlay.classList.add('show');
  document.getElementById('profile-name-input').value = state.profile.displayName || '';
  document.getElementById('profile-avatar-input').value = state.profile.avatarUrl || '';
  renderAvatarGrid_();
  syncProfilePreview();
  setTimeout(() => document.getElementById('profile-name-input').focus(), 200);

  const skipBtn = document.getElementById('btn-skip-profile');
  if (skipBtn) skipBtn.style.display = state.registered ? 'block' : 'none';
}

function closeProfileModal() {
  if (!state.registered) {
    showToast('📝 Please register your profile to start.', 'error');
    return;
  }
  const overlay = document.getElementById('profile-modal-overlay');
  overlay.classList.remove('show');
  overlay.style.display = 'none';
}

function syncProfilePreview() {
  const url = (document.getElementById('profile-avatar-input').value || '').trim();
  const img = document.getElementById('profile-preview-img');
  if (url) img.src = url;
  else img.src = document.getElementById('profile-avatar-img').src;
}

async function saveProfile() {
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true;
  btn.textContent = 'SAVING…';
  try {
    const displayName = (document.getElementById('profile-name-input').value || '').trim();
    const avatarUrl   = (document.getElementById('profile-avatar-input').value || '').trim();
    if (!displayName) { showToast('Please enter a display name.', 'error'); return; }
    setProfile({ displayName, avatarUrl });
    state.registered = true;
    localStorage.setItem('lt_profile_registered', '1');

    await postToSheet({
      action: 'setProfile',
      deviceId: state.deviceId,
      displayName: state.profile.displayName,
      avatarUrl: state.profile.avatarUrl
    }, { requireServer: true });

    if (state.gpsReady && state.currentPos) onGPSUpdate({ coords: { latitude: state.currentPos[0], longitude: state.currentPos[1], accuracy: 0 } });

    closeProfileModal();
    showToast('✅ Profile saved!', 'info');
  } catch (e) {
    console.warn(e);
    showToast('⚠ Could not save profile to server.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'SAVE PROFILE';
  }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'profile-avatar-input') syncProfilePreview();
});

function triggerPhotoPick() {
  document.getElementById('profile-photo-file')?.click();
}

async function fileToCompressedDataUrl_(file, maxSize=96, quality=0.62) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tw, th);

  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  if (!dataUrl || dataUrl.length < 30) dataUrl = canvas.toDataURL('image/png');

  if (dataUrl.length > 45000) dataUrl = canvas.toDataURL('image/jpeg', 0.5);
  if (dataUrl.length > 45000) throw new Error('Photo too large after compression.');

  return dataUrl;
}

document.addEventListener('change', async (e) => {
  if (!e.target || e.target.id !== 'profile-photo-file') return;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    showToast('📷 Processing photo…', 'info');
    const dataUrl = await fileToCompressedDataUrl_(file);
    document.getElementById('profile-avatar-input').value = dataUrl;
    syncProfilePreview();
    showToast('✅ Photo set as avatar', 'info');
  } catch (err) {
    console.warn(err);
    showToast('❌ ' + (err && err.message ? err.message : 'Could not process photo'), 'error');
  } finally {
    e.target.value = '';
  }
});

function addCurrentToGallery() {
  const name = (document.getElementById('profile-name-input')?.value || state.profile.displayName || 'My Avatar').trim();
  const url = (document.getElementById('profile-avatar-input')?.value || '').trim();
  if (!url) { showToast('Add an avatar URL or take a photo first.', 'error'); return; }
  const gallery = getCustomGallery_();
  const id = 'av-' + Math.random().toString(36).slice(2, 10);
  gallery.unshift({ id, name, url });
  setCustomGallery_(gallery.slice(0, 30));
  renderAvatarGrid_();
  showToast('➕ Added to gallery (right-click to remove)', 'info');
}

function resetToDefaultAvatars() {
  setCustomGallery_([]);
  renderAvatarGrid_();
  showToast('♻ Gallery reset', 'info');
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}

function createFaceIcon(avatarUrl, displayName, isSelf=false) {
  const safeName = escapeHtml_(displayName || 'Tycoon');
  const safeUrl  = escapeHtml_(avatarUrl || '');
  const ring = isSelf ? 'style="border-color: rgba(240,165,0,0.95); box-shadow: 0 0 20px rgba(240,165,0,0.28), 0 0 40px rgba(240,165,0,0.14)"' : '';
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div class="user-face-marker" ${ring}>
        <img src="${safeUrl}" alt="face" onerror="this.style.display='none'">
      </div>
      <div class="user-face-label">${safeName}</div>
    </div>
  `;
  return L.divIcon({ html, className:'', iconSize:[48, 54], iconAnchor:[24, 27] });
}

function createSelfIcon() {
  const p = state.profile || {};
  if (p.avatarUrl) return createFaceIcon(p.avatarUrl, p.displayName || 'You', true);
  return L.divIcon({
    html: `<div class="pulse-marker"><div class="pulse-dot"></div><div class="pulse-ring"></div></div>`,
    className: '', iconSize:[16,16], iconAnchor:[8,8]
  });
}

function heartbeatIfDue(lat, lng) {
  const now = Date.now();
  if (now - (state.lastHeartbeatAt || 0) < 12000) return;
  state.lastHeartbeatAt = now;
  postToSheet({
    action: 'heartbeat',
    deviceId: state.deviceId,
    displayName: state.profile.displayName,
    avatarUrl: state.profile.avatarUrl,
    lat, lng
  }).catch(() => {});
}

async function fetchOnlineUsers() {
  if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') return [];
  const res = await fetch(APPS_SCRIPT_URL + '?action=onlineUsers');
  const data = await res.json();
  if (data.status !== 'ok') return [];
  return Array.isArray(data.users) ? data.users : [];
}

function updateOnlineCount(n) {
  const el = document.getElementById('online-count');
  el.textContent = 'Online: ' + (typeof n === 'number' ? n : '—');
}

function renderOnlineUsers(users) {
  const nowIds = new Set();
  users.forEach(u => {
    if (!u || !u.deviceId) return;
    nowIds.add(String(u.deviceId));
  });

  for (const [id, marker] of state.otherUsers.entries()) {
    if (!nowIds.has(id)) {
      try { map.removeLayer(marker); } catch(_) {}
      state.otherUsers.delete(id);
    }
  }

  users.forEach(u => {
    const id = String(u.deviceId || '');
    if (!id) return;
    if (id === String(state.deviceId)) return;
    const lat = parseFloat(u.lat);
    const lng = parseFloat(u.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;

    const icon = (u.avatarUrl || '').trim()
      ? createFaceIcon(u.avatarUrl, u.displayName || 'Tycoon')
      : L.divIcon({
          html: `<div class="pulse-marker"><div class="pulse-dot"></div><div class="pulse-ring"></div></div>`,
          className: '', iconSize:[16,16], iconAnchor:[8,8]
        });

    const existing = state.otherUsers.get(id);
    if (!existing) {
      const m = L.marker([lat, lng], { icon, interactive:false, zIndexOffset:900 }).addTo(map);
      state.otherUsers.set(id, m);
    } else {
      existing.setLatLng([lat, lng]);
      existing.setIcon(icon);
    }
  });
}

function startOnlineLoop() {
  if (state.onlinePollTimer) clearInterval(state.onlinePollTimer);
  (async () => {
    try {
      const users = await fetchOnlineUsers();
      updateOnlineCount(users.length);
      renderOnlineUsers(users);
    } catch(_) {}
  })();

  state.onlinePollTimer = setInterval(async () => {
    try {
      const users = await fetchOnlineUsers();
      updateOnlineCount(users.length);
      renderOnlineUsers(users);
    } catch(_) {}
  }, 7000);
}

// ─── HUD Update ───────────────────────────────────────
function updateStatsHUD() {
  document.getElementById('stat-parcels').textContent = state.portfolio.parcels;
  document.getElementById('stat-value').textContent   = '$' + Math.round(state.portfolio.value).toLocaleString();
  const area = state.portfolio.area;
  document.getElementById('stat-area').textContent    =
    area >= 10000 ? (area/10000).toFixed(2) + ' ha' : Math.round(area).toLocaleString() + ' m²';
}

// ─── Leaderboard ──────────────────────────────────────
function toggleLeaderboard() {
  document.getElementById('leaderboard-panel').classList.toggle('show');
}

function updateLeaderboard() {
  const sorted = Object.entries(state.owners)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10);

  const medals = ['🥇','🥈','🥉'];
  document.getElementById('lb-rows').innerHTML = sorted.map(([name, val], i) => `
    <div class="lb-row">
      <span class="lb-name">${medals[i] || (i+1+'.')} ${name}</span>
      <span class="lb-val">$${Math.round(val).toLocaleString()}</span>
    </div>
  `).join('');
}

// ─── Toast system ─────────────────────────────────────
function showToast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast-msg toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ─── Status bar ───────────────────────────────────────
function setStatus(msg, cls='') {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className   = cls ? `error` === cls ? 'error' : cls === 'success' ? 'success' : '' : '';
}

// ─── Device ID ───────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('lt_device_id');
  if (!id) {
    id = 'DEV-' + Math.random().toString(36).substr(2,8).toUpperCase();
    localStorage.setItem('lt_device_id', id);
  }
  return id;
}

// ─── Boot sequence ────────────────────────────────────
window.addEventListener('load', async () => {
  document.getElementById('btn-mark').disabled = true;

  renderProfileChip();
  state.registered = isRegistered_();
  if (!state.registered) {
    openProfileModal();
  }

  const ok = await pingServer_();
  if (!ok) showToast('⚠ Server not connected. Set APPS_SCRIPT_URL and deploy web app.', 'error');

  await new Promise(r => setTimeout(r, 2000));
  const ls = document.getElementById('loading-screen');
  ls.classList.add('fade-out');
  setTimeout(() => ls.remove(), 700);

  await loadExistingParcels();
  startGPSWatch();
  startOnlineLoop();

  showToast('🏛 Welcome, Land Tycoon! Walk your land!', 'gold');
});

