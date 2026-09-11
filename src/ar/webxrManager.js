import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { showBrowserIncompatibleNotice } from '../ui/loadingBar.js';
import { updateUILayout, unpinARControls } from '../ui/orientationController.js';
import {
  enablePlacementListener,
  resetArSessionState,
  onSelect
} from './placementController.js';
import { stopPositionalAudio } from '../audio/audioController.js';

export function restoreArButtonContent() {
  const arButton = document.getElementById('ARButton');
  if (arButton) {
    arButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.9;display:block;flex-shrink:0">
        <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
        <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
        <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
        <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
        <circle cx="12" cy="12" r="3"/>
        <path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01"/>
      </svg>
      <span style="font-size:inherit;font-weight:inherit;letter-spacing:inherit;line-height:1">Start AR</span>
    `;
    const landingAnchor = document.querySelector('.landing-button-anchor');
    if (landingAnchor && arButton.parentElement !== landingAnchor) {
      landingAnchor.appendChild(arButton);
    }
  }
}

export function handleSessionStart() {
  arState.arStarted = true;
  arState.isPlaced = false;
  arState.hitTestSourceRequested = false;
  arState.hitTestSource = null;
  document.body.classList.add('ar-active');

  // 1. Hide landing screen
  const landingScreen = dom.landingScreen || $('landing-screen');
  if (landingScreen) landingScreen.classList.add('hidden');

  // 2. Hide Start AR button
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'none';

  // 3. Show WebXR UI Overlay
  const uiOverlayEl = dom.uiOverlay || $('ui-overlay');
  if (uiOverlayEl) {
    uiOverlayEl.classList.remove('hidden');
    uiOverlayEl.style.display = '';
    uiOverlayEl.style.visibility = '';
    uiOverlayEl.style.opacity = '';
    uiOverlayEl.style.pointerEvents = '';
  }

  // 4. Show Exit AR button
  const exitBtn = dom.exitArBtn || $('exit-ar-btn');
  if (exitBtn) {
    exitBtn.classList.remove('hidden');
    exitBtn.style.display = '';
    exitBtn.style.visibility = '';
    exitBtn.style.opacity = '';
    exitBtn.style.pointerEvents = '';
  }

  // 5. Show initial floor detection toast
  const toast = dom.toast || $('toast');
  if (toast) {
    toast.classList.remove('hidden');
  }

  // 6. Hide placed-only controls until dancer is placed
  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');

  // 7. Layout orientation & enable placement listeners
  updateUILayout();
  requestAnimationFrame(updateUILayout);
  setTimeout(updateUILayout, 150);

  enablePlacementListener();
  setTimeout(() => {
    if (arState.arStarted && !arState.isPlaced) {
      enablePlacementListener();
    }
  }, 400);
}

export function handleSessionEndCleanup() {
  arState.arStarted = false;
  arState.hitTestSourceRequested = false;
  arState.hitTestSource = null;
  resetArSessionState();
  arState.xrLastLandscape = null;

  document.body.classList.remove('ar-active');
  document.body.classList.remove('landscape');
  document.body.classList.remove('is-landscape');
  document.body.classList.remove('drawer-open');
  document.body.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');

  // Unpin all landscape-transformed AR controls
  unpinARControls();

  const uiWrapper = dom.uiWrapper;
  if (uiWrapper) {
    uiWrapper.style.width = '';
    uiWrapper.style.height = '';
    uiWrapper.style.left = '';
    uiWrapper.style.top = '';
    uiWrapper.style.transform = '';
    uiWrapper.style.transformOrigin = '';
  }

  // Hide UI overlay completely
  const uiOverlayEl = dom.uiOverlay || $('ui-overlay');
  if (uiOverlayEl) {
    uiOverlayEl.style.width = '';
    uiOverlayEl.style.height = '';
    uiOverlayEl.style.left = '';
    uiOverlayEl.style.top = '';
    uiOverlayEl.style.transform = '';
    uiOverlayEl.style.transformOrigin = '';
    uiOverlayEl.classList.add('hidden');
    uiOverlayEl.style.setProperty('display', 'none', 'important');
    uiOverlayEl.style.setProperty('visibility', 'hidden', 'important');
    uiOverlayEl.style.setProperty('opacity', '0', 'important');
    uiOverlayEl.style.setProperty('pointer-events', 'none', 'important');
  }

  // Explicitly hide Exit AR button and remove any lingering inline overrides
  const exitBtn = dom.exitArBtn || $('exit-ar-btn');
  if (exitBtn) {
    exitBtn.classList.add('hidden');
    exitBtn.style.setProperty('display', 'none', 'important');
    exitBtn.style.setProperty('visibility', 'hidden', 'important');
    exitBtn.style.setProperty('opacity', '0', 'important');
    exitBtn.style.setProperty('pointer-events', 'none', 'important');
  }

  // Show landing screen with tribal ribbons
  dom.landingScreen?.classList.remove('hidden');

  // Restore ARButton with SVG emblem
  restoreArButtonContent();
  const arBtn = document.getElementById('ARButton');
  if (arBtn && arState.isMediaReady) {
    arBtn.style.display = 'flex';
  }

  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  dancerVideo?.pause();
  stopPositionalAudio();

  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');
  dom.toast?.classList.add('hidden');

  updateUILayout();
}

export function setupWebXR(renderer, scene) {
  // ── Compatibility & In-App Browser Detection ──────────────────────────────
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isInApp = /FBAN|FBAV|Instagram|Messenger|Line|musical_ly|ByteDance/i.test(ua);

  if (window.isSecureContext === false) {
    showBrowserIncompatibleNotice(
      'HTTPS Connection Required',
      'WebXR Augmented Reality requires a secure HTTPS connection to access your camera and AR sensors. Please access this website using <strong>https://</strong>.'
    );
    return;
  }

  if (isInApp) {
    showBrowserIncompatibleNotice(
      'In-App Browser Detected',
      'Facebook/Messenger in-app browsers do not support WebXR Augmented Reality.<br><br>Please tap the <strong>three dots (⋮ or ⋯)</strong> in your screen corner and choose <strong>"Open in Chrome"</strong> or <strong>"Open in external browser"</strong>.'
    );
    return;
  }

  if (isIOS) {
    showBrowserIncompatibleNotice(
      'iOS Browser Incompatible',
      'Apple iOS browsers (Safari & Chrome on iPhone/iPad) do not support the WebXR Augmented Reality standard.<br><br>Please use an <strong>Android smartphone with Google Chrome</strong> to experience this AR tour.'
    );
    return;
  }

  if (!('xr' in navigator)) {
    showBrowserIncompatibleNotice(
      'WebXR AR Not Supported',
      'This browser does not support the WebXR Device API.<br><br>Please open this site using <strong>Google Chrome on Android</strong> with <strong>Google Play Services for AR</strong> installed.'
    );
    return;
  }

  navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
    if (!supported) {
      showBrowserIncompatibleNotice(
        'ARCore Required',
        'Your Android device does not currently support WebXR AR sessions.<br><br>Please install or update <strong>Google Play Services for AR (ARCore)</strong> from the Google Play Store.'
      );
    }
  }).catch(() => { });

  const overlayRoot = document.getElementById('ui-overlay');

  // Standard safe WebXR features supported across Chrome, Brave, and Edge
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'plane-detection'],
    domOverlay: overlayRoot ? { root: overlayRoot } : undefined
  };

  const arButton = ARButton.createButton(renderer, sessionInit);
  arButton.style.display = 'none';
  const landingAnchor = document.querySelector('.landing-button-anchor');
  if (landingAnchor) {
    landingAnchor.appendChild(arButton);
  } else {
    document.body.appendChild(arButton);
  }

  restoreArButtonContent();

  // Watch for any textContent / innerHTML resets by Three.js and immediately enforce our icon + styling
  const observer = new MutationObserver(() => {
    if (!arButton.querySelector('svg')) {
      restoreArButtonContent();
    }
  });
  observer.observe(arButton, { childList: true, characterData: true, subtree: true });

  // Use capture-phase listener to intercept click before Three.js's naked handler
  arButton.addEventListener('click', async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    if (!navigator.xr) {
      setToast('WebXR is not supported on this browser', true);
      return;
    }

    let session = null;
    const uiOverlay = document.getElementById('ui-overlay');

    // Attempt 1: Hit-test with dom-overlay
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'plane-detection'],
        domOverlay: uiOverlay ? { root: uiOverlay } : undefined
      });
    } catch (err1) {
      console.warn('[WebXR] Primary session failed, trying fallback init:', err1);

      // Attempt 2: Minimal fallback (hit-test + dom-overlay only)
      try {
        session = await navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay'],
          domOverlay: uiOverlay ? { root: uiOverlay } : undefined
        });
      } catch (err2) {
        console.warn('[WebXR] Fallback session failed, trying bare hit-test:', err2);

        // Attempt 3: Bare hit-test without dom-overlay (for strict browsers)
        try {
          session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test']
          });
        } catch (err3) {
          console.error('[WebXR] All WebXR session attempts failed:', err3);
          setToast('Could not start AR: ' + (err3.message || 'Session rejected by browser'), true);
          return;
        }
      }
    }

    if (session) {
      try {
        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);
        updateUILayout();
      } catch (setSessionErr) {
        console.error('[WebXR] setSession error:', setSessionErr);
        setToast('Failed to initialize AR session: ' + (setSessionErr.message || setSessionErr), true);
        handleSessionEndCleanup();
      }
    }
  }, true); // useCapture = true ensures this fires first!

  renderer.xr.addEventListener('sessionstart', () => {
    handleSessionStart();
  });

  renderer.xr.addEventListener('sessionend', () => {
    handleSessionEndCleanup();
  });

  // Controller for select (tap to place)
  if (!arState.controller) {
    arState.controller = renderer.xr.getController(0);
    arState.controller.addEventListener('select', onSelect);
    scene.add(arState.controller);
  }
}
