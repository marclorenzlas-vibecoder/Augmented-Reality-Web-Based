import { arState } from '../ar/state.js';
import { $, dom } from '../ui/domElements.js';
import { ALLOWED_LOCATIONS, GEO_ICONS } from '../config/locations.js';
import { launchDirectAR } from '../ar/scene.js';
import { resetArSessionState } from '../ar/placementController.js';
import { stopPositionalAudio } from '../audio/audioController.js';

let watchId = null;
let pollIntervalId = null;
let isFirstCheck = true;

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
  console.warn('[Location Real-Time] Geolocation error:', err);
  if (err.code === err.PERMISSION_DENIED) {
    handleLocationRevokedOrOutOfRange('denied');
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    handleLocationRevokedOrOutOfRange('error', null, 0, 'Location/GPS is disabled on your device');
  } else if (err.code === err.TIMEOUT) {
    if (!arState.isLocationVerified) {
      setErrorState('Location request timed out');
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
    setCheckingState();
  }

  const geoOptions = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 3000
  };

  // 1. Clear any prior watchers
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }

  // 2. Real-time GPS Watcher
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      isFirstCheck = false;
      processCoordinates(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      isFirstCheck = false;
      handleGpsError(err);
    },
    geoOptions
  );

  // 3. Fallback recurring polling check every 4 seconds to guarantee continuous validation
  pollIntervalId = setInterval(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        processCoordinates(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        handleGpsError(err);
      },
      geoOptions
    );
  }, 4000);

  // 4. Listen to browser permission state changes
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((permissionStatus) => {
      permissionStatus.onchange = () => {
        if (permissionStatus.state === 'denied') {
          handleLocationRevokedOrOutOfRange('denied');
        } else if (permissionStatus.state === 'granted') {
          navigator.geolocation.getCurrentPosition(
            (pos) => processCoordinates(pos.coords.latitude, pos.coords.longitude),
            handleGpsError,
            geoOptions
          );
        }
      };
    }).catch(() => {});
  }
}

export function initLocationGateCheck() {
  const gateEl = $('location-gate');
  const retryBtn = $('location-retry-btn');

  if (!gateEl) {
    launchDirectAR();
    return;
  }

  if (retryBtn && !retryBtn.dataset.bound) {
    retryBtn.dataset.bound = 'true';
    retryBtn.addEventListener('click', () => {
      setCheckingState();
      startRealtimeLocationTracking();
    });
  }

  startRealtimeLocationTracking();
}
