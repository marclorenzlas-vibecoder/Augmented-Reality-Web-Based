import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { updateUILayout } from '../ui/orientationController.js';
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
  }

  // 4. Show initial floor detection toast
  const toast = dom.toast || $('toast');
  if (toast) {
    toast.classList.remove('hidden');
  }

  // 5. Hide placed-only controls until dancer is placed
  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');

  // 6. Layout orientation & enable placement listeners
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

  const uiWrapper = dom.uiWrapper;
  if (uiWrapper) {
    uiWrapper.style.width = '';
    uiWrapper.style.height = '';
    uiWrapper.style.left = '';
    uiWrapper.style.top = '';
    uiWrapper.style.transform = '';
    uiWrapper.style.transformOrigin = '';
  }
  const uiOverlayEl = dom.uiOverlay;
  if (uiOverlayEl) {
    uiOverlayEl.style.width = '';
    uiOverlayEl.style.height = '';
    uiOverlayEl.style.left = '';
    uiOverlayEl.style.top = '';
    uiOverlayEl.style.transform = '';
    uiOverlayEl.style.transformOrigin = '';
    uiOverlayEl.classList.add('hidden');
  }
  document.body.classList.remove('landscape');
  document.body.classList.remove('drawer-open');

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
}

export function setupWebXR(renderer, scene) {
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'camera-access', 'depth-sensing', 'mesh-detection', 'plane-detection'],
    depthSensing: {
      usagePreference: ['gpu-optimized', 'cpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32']
    },
    domOverlay: { root: document.getElementById('ui-overlay') }
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

  const originalOnClick = arButton.onclick;
  arButton.onclick = async function (e) {
    handleSessionStart();

    try {
      if (typeof originalOnClick === 'function') {
        await originalOnClick.call(this, e);
      } else if (navigator.xr) {
        const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
        await renderer.xr.setSession(session);
      }
      updateUILayout();
    } catch (err) {
      console.warn('Primary WebXR session request failed, trying minimal features:', err);
      try {
        const fallbackInit = {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay', 'camera-access'],
          domOverlay: { root: document.getElementById('ui-overlay') }
        };
        const session = await navigator.xr.requestSession('immersive-ar', fallbackInit);
        await renderer.xr.setSession(session);
        updateUILayout();
      } catch (fallbackErr) {
        console.error('AR session start failed completely:', fallbackErr);
        setToast('Failed to start AR: ' + (fallbackErr.message || fallbackErr), true);
        handleSessionEndCleanup();
        return;
      }
    }

    updateUILayout();
  };

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
