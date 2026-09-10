import { arState } from '../ar/state.js';
import { $ } from '../ui/domElements.js';
import { ALLOWED_LOCATIONS, GEO_ICONS } from '../config/locations.js';
import { initCameraWithPermissionCheck } from '../scanner/qrScanner.js';

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

export function initLocationGateCheck() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (!gateEl) {
    initCameraWithPermissionCheck();
    return;
  }

  if (retryBtn && !retryBtn.dataset.bound) {
    retryBtn.dataset.bound = 'true';
    retryBtn.addEventListener('click', () => {
      requestLocation();
    });
  }

  function setCheckingState() {
    gateEl.className = 'screen screen--location';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.pin;
    if (badgeEl) {
      badgeEl.textContent = 'Location Verification';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'Verifying Location…';
    if (descEl) {
      descEl.innerHTML = `
        <p>This Augmented Reality experience is exclusively available at <strong>The NGC</strong> or authorized team locations.</p>
        <p>Requesting your GPS coordinates to verify your location…</p>
      `;
    }
    if (distEl) distEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.add('hidden');
  }

  function setVerifiedState(loc, distMeters) {
    arState.isLocationVerified = true;
    gateEl.className = 'screen screen--location state-verified';
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
        <p>You are inside the authorized <strong>${radiusLabel} geofence zone</strong>.</p>
        <p>Starting camera &amp; AR scanner…</p>
      `;
    }
    if (distEl) {
      distEl.innerHTML = `${GEO_ICONS.verified} <span>Inside ${loc.name} (${distFormatted})</span>`;
      distEl.classList.remove('hidden');
    }
    if (actionsEl) actionsEl.classList.add('hidden');

    setTimeout(() => {
      gateEl.classList.add('fade-out');
      setTimeout(() => {
        gateEl.classList.add('hidden');
      }, 500);
      initCameraWithPermissionCheck();
    }, 1100);
  }

  function setDeniedState() {
    gateEl.className = 'screen screen--location state-denied';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.denied;
    if (badgeEl) {
      badgeEl.textContent = 'Permission Denied';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'Location Permission Required';
    if (descEl) {
      descEl.innerHTML = `
        <p>Location access was declined. This experience is location-restricted and cannot start without GPS permission.</p>
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
    gateEl.className = 'screen screen--location state-restricted';
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
    const maxRadius = nearestLoc ? nearestLoc.radiusMeters : 10000;
    if (descEl) {
      descEl.innerHTML = `
        <p>This Augmented Reality experience is only accessible at designated locations (<strong>The NGC</strong> or authorized team zones).</p>
        <p>You are currently <strong>${distStr}</strong> away from ${locName}. Please visit an authorized zone to unlock!</p>
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
    gateEl.className = 'screen screen--location state-denied';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.warning;
    if (badgeEl) {
      badgeEl.textContent = 'GPS Signal Error';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'GPS Signal Unavailable';
    if (descEl) {
      descEl.innerHTML = `
        <p>Unable to acquire GPS coordinates (${errMsg}).</p>
        <p>Please make sure your device's <strong>Location / GPS</strong> is turned ON in settings, then try again.</p>
      `;
    }
    if (distEl) distEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (retryBtn) {
      retryBtn.innerHTML = `${GEO_ICONS.retry} <span>Try Again</span>`;
    }
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setErrorState('Geolocation not supported by this browser');
      return;
    }

    setCheckingState();

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userLat = pos.coords.latitude;
        const userLng = pos.coords.longitude;

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
          setVerifiedState(matchedLocation, matchedDistance);
        } else {
          setRestrictedState(nearestLocation, minDistance);
        }
      },
      (err) => {
        console.warn('[Location] Geolocation error:', err);
        if (err.code === err.PERMISSION_DENIED) {
          setDeniedState();
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setErrorState('Position unavailable');
        } else if (err.code === err.TIMEOUT) {
          setErrorState('Location request timed out');
        } else {
          setErrorState(err.message || 'Unknown location error');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  requestLocation();
}
