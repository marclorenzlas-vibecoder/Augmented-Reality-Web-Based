import { arState } from '../ar/state.js';
import { $, dom } from '../ui/domElements.js';
import { ALLOWED_LOCATIONS, GEO_ICONS } from '../config/locations.js';
import { launchDirectAR } from '../ar/scene.js';
import { resetArSessionState } from '../ar/placementController.js';
import { stopPositionalAudio } from '../audio/audioController.js';

let watchId = null;
let pollIntervalId = null;
let isFirstCheck = true;
let currentPermissionState = 'prompt'; // 'granted' | 'denied' | 'prompt'
let gpsAutoRetryTimer = null;

function stopGpsAutoRetry() {
  if (gpsAutoRetryTimer !== null) {
    clearTimeout(gpsAutoRetryTimer);
    gpsAutoRetryTimer = null;
  }
}

function scheduleGpsAutoRetry(intervalMs = 1800) {
  if (gpsAutoRetryTimer !== null) return;
  if (arState.isLocationVerified || !isGeofenceEnabled()) return;

  gpsAutoRetryTimer = setTimeout(() => {
    gpsAutoRetryTimer = null;
    if (arState.isLocationVerified || !isGeofenceEnabled()) return;

    // Trigger high-accuracy position request to trigger OS prompt and query GPS status
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        stopGpsAutoRetry();
        currentPermissionState = 'granted';
        processCoordinates(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        handleGpsError(err);
      },
      {
        enableHighAccuracy: true,
        timeout: 6000,
        maximumAge: 0
      }
    );
  }, intervalMs);
}

function setActivatingDeviceGpsState() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');

  if (gateEl) gateEl.className = 'screen screen--location state-activating-gps';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.pin;
  if (badgeEl) {
    badgeEl.textContent = 'Permission Allowed';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'Activating Device GPS…';
  if (descEl) {
    descEl.innerHTML = `
      <p>Location permission is granted! Automatically connecting to high-accuracy device GPS…</p>
      <p class="location-desc-sub" style="color: var(--bacolod-orange, #ee6327); font-weight: 600;">
        ⚡ Acquiring real-time GPS coordinates…
      </p>
    `;
  }
  if (distEl) distEl.classList.add('hidden');
  if (actionsEl) actionsEl.classList.add('hidden');
}

function setWaitingForDeviceGpsState() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (gateEl) gateEl.className = 'screen screen--location state-waiting-gps';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.pin;
  if (badgeEl) {
    badgeEl.textContent = 'Turn On GPS';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'Turn On Device Location';
  if (descEl) {
    descEl.innerHTML = `
      <p>Browser permission is allowed! If prompted on your device, tap <strong>OK</strong> to turn on location, or turn on <strong>Location / GPS</strong> in your phone's quick settings.</p>
      <p class="location-desc-sub" style="color: var(--bacolod-orange, #ee6327); font-weight: 600;">
        ⚡ Waiting for GPS signal… automatically connecting once turned on.
      </p>
    `;
  }
  if (distEl) distEl.classList.add('hidden');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (retryBtn) {
    retryBtn.innerHTML = `${GEO_ICONS.pin} <span>Turn On Device Location</span>`;
  }
}

export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's mean radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function handleLocationRevokedOrOutOfRange(stateType, nearestLoc = null, distMeters = 0, errMsg = '') {
  if (!isGeofenceEnabled()) {
    arState.isLocationVerified = true;
    return;
  }

  arState.isLocationVerified = false;

  // 1. Immediately abort active AR session if running
  try {
    if (arState.renderer && arState.renderer.xr && arState.renderer.xr.getSession()) {
      arState.renderer.xr.getSession().end().catch(() => {});
    }
  } catch (e) {}

  resetArSessionState();
  stopPositionalAudio();
  if (arState.dancerVideo) {
    arState.dancerVideo.pause();
  }

  // 2. Hide all AR / Landing UI & ARButton
  dom.uiOverlay?.classList.add('hidden');
  dom.landingScreen?.classList.add('hidden');
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'none';

  // 3. Bring Location Gate Modal popup immediately to the front
  const gateEl = $('location-gate');
  if (gateEl) {
    gateEl.classList.remove('hidden');
    gateEl.classList.remove('fade-out');

    if (stateType === 'restricted') {
      setRestrictedState(nearestLoc, distMeters);
    } else if (stateType === 'denied') {
      setDeniedState();
    } else {
      setErrorState(errMsg || 'GPS connection lost');
    }
  }
}

function setCheckingState() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');

  if (gateEl) gateEl.className = 'screen screen--location';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.pin;
  if (badgeEl) {
    badgeEl.textContent = 'Location Verification';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'Verifying Location…';
  if (descEl) {
    descEl.innerHTML = `
      <p>This Augmented Reality experience is exclusively available at <strong>The NGC</strong> or authorized team locations within a <strong>500m radius</strong>.</p>
      <p>Requesting real-time GPS coordinates…</p>
    `;
  }
  if (distEl) distEl.classList.add('hidden');
  if (actionsEl) actionsEl.classList.add('hidden');
}

function setVerifiedState(loc, distMeters) {
  arState.isLocationVerified = true;
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');

  if (gateEl) gateEl.className = 'screen screen--location state-verified';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.verified;
  if (badgeEl) {
    badgeEl.textContent = loc.badge || 'Location Verified';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = `Welcome to ${loc.name}!`;
  const radiusLabel = loc.radiusMeters >= 1000 ? `${(loc.radiusMeters / 1000).toFixed(0)}km` : `${loc.radiusMeters}m`;
  const distFormatted = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(2)}km` : `${Math.round(distMeters)}m`;
  if (descEl) {
    descEl.innerHTML = `
      <p>You are inside the authorized <strong>${radiusLabel} geofence zone</strong> (${distFormatted} away).</p>
      <p>Access granted. Loading Augmented Reality experience…</p>
    `;
  }
  if (distEl) {
    distEl.innerHTML = `${GEO_ICONS.verified} <span>Inside ${loc.name} (${distFormatted})</span>`;
    distEl.classList.remove('hidden');
  }
  if (actionsEl) actionsEl.classList.add('hidden');

  setTimeout(() => {
    if (gateEl && arState.isLocationVerified) {
      gateEl.classList.add('fade-out');
      setTimeout(() => {
        if (arState.isLocationVerified) {
          gateEl.classList.add('hidden');
        }
      }, 500);
      launchDirectAR();
    }
  }, 1000);
}

function setDeniedState() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (gateEl) gateEl.className = 'screen screen--location state-denied';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.denied;
  if (badgeEl) {
    badgeEl.textContent = 'Permission Denied';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'Location Permission Required';
  if (descEl) {
    descEl.innerHTML = `
      <p>Location access was declined or turned off. This experience requires active real-time GPS within 500m of authorized zones to function.</p>
      <p>Please tap the <strong>site settings / lock icon (${GEO_ICONS.lock} or ${GEO_ICONS.gear})</strong> in your address bar, set <strong>Location: Allow</strong>, then tap below:</p>
    `;
  }
  if (distEl) distEl.classList.add('hidden');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (retryBtn) {
    retryBtn.innerHTML = `${GEO_ICONS.pin} <span>Grant Permission &amp; Try Again</span>`;
  }
}

function setRestrictedState(nearestLoc, distMeters) {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (gateEl) gateEl.className = 'screen screen--location state-restricted';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.navigation;
  if (badgeEl) {
    badgeEl.textContent = 'Location Restricted';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'Location Restricted';
  const distStr = distMeters >= 1000
    ? (distMeters / 1000).toFixed(2) + ' km'
    : Math.round(distMeters) + ' meters';
  const locName = nearestLoc ? nearestLoc.name : 'The NGC';
  const maxRadius = nearestLoc ? nearestLoc.radiusMeters : 500;
  if (descEl) {
    descEl.innerHTML = `
      <p>This Augmented Reality experience is only accessible within <strong>${maxRadius}m</strong> of authorized locations (<strong>${locName}</strong>).</p>
      <p>You are currently <strong>${distStr}</strong> away. Please move closer to unlock!</p>
    `;
  }
  if (distEl) {
    distEl.innerHTML = `${GEO_ICONS.navigation} <span>Distance: ${distStr} (Allowed: ${maxRadius}m)</span>`;
    distEl.classList.remove('hidden');
  }
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (retryBtn) {
    retryBtn.innerHTML = `${GEO_ICONS.retry} <span>Re-check My Location</span>`;
  }
}

function setErrorState(errMsg) {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (gateEl) gateEl.className = 'screen screen--location state-denied';
  if (iconEl) iconEl.innerHTML = GEO_ICONS.warning;
  if (badgeEl) {
    badgeEl.textContent = 'GPS Signal Error';
    badgeEl.className = 'location-badge';
  }
  if (titleEl) titleEl.textContent = 'GPS Signal Unavailable';
  if (descEl) {
    descEl.innerHTML = `
      <p>Unable to acquire real-time GPS coordinates (${errMsg}).</p>
      <p>Please ensure your device's <strong>Location / GPS</strong> is turned ON in settings, then try again.</p>
    `;
  }
  if (distEl) distEl.classList.add('hidden');
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (retryBtn) {
    retryBtn.innerHTML = `${GEO_ICONS.retry} <span>Try Again</span>`;
  }
}

function processCoordinates(userLat, userLng) {
  stopGpsAutoRetry();
  currentPermissionState = 'granted';

  if (!isGeofenceEnabled()) {
    arState.isLocationVerified = true;
    return;
  }

  let matchedLocation = null;
  let matchedDistance = Infinity;
  let nearestLocation = null;
  let minDistance = Infinity;

  for (const loc of ALLOWED_LOCATIONS) {
    const dist = calculateDistanceMeters(
      userLat,
      userLng,
      loc.latitude,
      loc.longitude
    );

    if (dist <= loc.radiusMeters) {
      matchedLocation = loc;
      matchedDistance = dist;
      break;
    }

    if (dist < minDistance) {
      minDistance = dist;
      nearestLocation = loc;
    }
  }

  if (matchedLocation) {
    if (!arState.isLocationVerified) {
      setVerifiedState(matchedLocation, matchedDistance);
    }
  } else {
    // User is outside the 500m radius!
    handleLocationRevokedOrOutOfRange('restricted', nearestLocation, minDistance);
  }
}

function handleGpsError(err) {
  if (!isGeofenceEnabled()) {
    arState.isLocationVerified = true;
    return;
  }

  console.warn('[Location Real-Time] Geolocation error:', err);
  if (err.code === err.PERMISSION_DENIED) {
    currentPermissionState = 'denied';
    stopGpsAutoRetry();
    handleLocationRevokedOrOutOfRange('denied');
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    // Site permission is allowed, but device GPS hardware is disabled or acquiring fix
    currentPermissionState = 'granted';
    setWaitingForDeviceGpsState();
    scheduleGpsAutoRetry(1800);
  } else if (err.code === err.TIMEOUT) {
    if (!arState.isLocationVerified) {
      if (currentPermissionState === 'granted') {
        setActivatingDeviceGpsState();
        scheduleGpsAutoRetry(1800);
      } else {
        setErrorState('Location request timed out');
      }
    }
  } else {
    handleLocationRevokedOrOutOfRange('error', null, 0, err.message || 'GPS Signal Lost');
  }
}

export function startRealtimeLocationTracking() {
  if (!navigator.geolocation) {
    setErrorState('Geolocation not supported by this browser');
    return;
  }

  if (isFirstCheck) {
    if (currentPermissionState === 'granted') {
      setActivatingDeviceGpsState();
    } else {
      setCheckingState();
    }
  }

  const geoOptions = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  };

  // 1. Clear any prior watchers and timers
  stopRealtimeLocationTracking();

  // 2. Real-time GPS Watcher
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      isFirstCheck = false;
      stopGpsAutoRetry();
      currentPermissionState = 'granted';
      processCoordinates(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      isFirstCheck = false;
      handleGpsError(err);
    },
    geoOptions
  );

  // 3. Fallback recurring polling check every 3.5 seconds to guarantee continuous validation
  pollIntervalId = setInterval(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        stopGpsAutoRetry();
        currentPermissionState = 'granted';
        processCoordinates(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        handleGpsError(err);
      },
      geoOptions
    );
  }, 3500);

  // 4. Immediate high-accuracy position request to instantly trigger Android's native "Turn on location" dialog
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      stopGpsAutoRetry();
      currentPermissionState = 'granted';
      processCoordinates(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      handleGpsError(err);
    },
    geoOptions
  );
}

export function isGeofenceEnabled() {
  const stored = localStorage.getItem('geofence_enabled');
  return stored === null ? true : stored === 'true';
}

export function syncGeofenceToggleUI(enabled) {
  const inputs = document.querySelectorAll('.geofence-toggle-input');
  const wraps = document.querySelectorAll('.geofence-toggle-wrap');
  const statusTexts = document.querySelectorAll('.geofence-status-text');

  inputs.forEach(input => {
    input.checked = enabled;
  });

  wraps.forEach(wrap => {
    if (enabled) {
      wrap.classList.remove('is-disabled');
    } else {
      wrap.classList.add('is-disabled');
    }
  });

  statusTexts.forEach(txt => {
    txt.textContent = enabled ? 'Active' : 'Disabled';
  });
}

export function stopRealtimeLocationTracking() {
  stopGpsAutoRetry();
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

export function setGeofenceEnabled(enabled) {
  localStorage.setItem('geofence_enabled', enabled ? 'true' : 'false');
  syncGeofenceToggleUI(enabled);

  if (!enabled) {
    stopRealtimeLocationTracking();
    arState.isLocationVerified = true;

    const gateEl = $('location-gate');
    if (gateEl) {
      gateEl.classList.add('fade-out');
      setTimeout(() => {
        gateEl.classList.add('hidden');
      }, 400);
    }
    launchDirectAR();
  } else {
    arState.isLocationVerified = false;
    startRealtimeLocationTracking();
  }
}

export function setupGeofenceToggleListeners() {
  const inputs = document.querySelectorAll('.geofence-toggle-input');
  inputs.forEach(input => {
    if (!input.dataset.bound) {
      input.dataset.bound = 'true';
      input.addEventListener('change', (e) => {
        setGeofenceEnabled(e.target.checked);
      });
    }
  });
}

export async function initLocationGateCheck() {
  setupGeofenceToggleListeners();

  const enabled = isGeofenceEnabled();
  syncGeofenceToggleUI(enabled);

  const gateEl = $('location-gate');
  const retryBtn = $('location-retry-btn');

  if (!enabled) {
    arState.isLocationVerified = true;
    if (gateEl) {
      gateEl.classList.add('hidden');
    }
    launchDirectAR();
    return;
  }

  if (!gateEl) {
    launchDirectAR();
    return;
  }

  if (retryBtn && !retryBtn.dataset.bound) {
    retryBtn.dataset.bound = 'true';
    retryBtn.addEventListener('click', () => {
      if (currentPermissionState === 'granted') {
        setActivatingDeviceGpsState();
      } else {
        setCheckingState();
      }
      startRealtimeLocationTracking();
    });
  }

  // 1. Proactively query permission status and auto-activate device GPS if granted
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'geolocation' });
      currentPermissionState = permissionStatus.state;

      if (permissionStatus.state === 'granted') {
        // Automatically start activating GPS without requiring manual button press!
        setActivatingDeviceGpsState();
      }

      permissionStatus.onchange = () => {
        currentPermissionState = permissionStatus.state;
        if (permissionStatus.state === 'denied') {
          stopGpsAutoRetry();
          handleLocationRevokedOrOutOfRange('denied');
        } else if (permissionStatus.state === 'granted') {
          setActivatingDeviceGpsState();
          startRealtimeLocationTracking();
        }
      };
    } catch (e) {
      console.warn('[Location] permissions.query not supported or rejected:', e);
    }
  }

  // 2. Automatically start tracking & GPS activation
  startRealtimeLocationTracking();
}
