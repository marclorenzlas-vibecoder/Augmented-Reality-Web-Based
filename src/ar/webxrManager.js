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
import { restartQrCameraSoon } from '../scanner/qrScanner.js';

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
  arButton.style.display = 'none'; // Keep hidden until asset loading is successful
  document.body.appendChild(arButton);

  requestAnimationFrame(() => {
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
  });

  const originalOnClick = arButton.onclick;
  arButton.onclick = async function (e) {
    const uiOverlayEl = dom.uiOverlay;
    if (uiOverlayEl) {
      uiOverlayEl.classList.remove('hidden');
      uiOverlayEl.style.display = '';
    }

    arState.arStarted = true;
    const toast = dom.toast;
    if (toast && !arState.isPlaced) {
      toast.classList.remove('hidden');
    }

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
        arState.arStarted = false;
        if (toast) toast.classList.add('hidden');
        return;
      }
    }

    updateUILayout();
    arButton.style.display = 'none';

    setTimeout(() => {
      if (arState.arStarted && !arState.isPlaced) {
        enablePlacementListener();
      }
    }, 400);
  };

  renderer.xr.addEventListener('sessionstart', () => {
    arState.arStarted = true;
    updateUILayout();
    requestAnimationFrame(updateUILayout);
    setTimeout(updateUILayout, 150);
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';
    const toast = dom.toast;
    if (toast && !arState.isPlaced) {
      toast.classList.remove('hidden');
    }
    setTimeout(() => {
      if (arState.arStarted && !arState.isPlaced) {
        enablePlacementListener();
      }
    }, 400);
  });

  // Controller for select (tap to place)
  arState.controller = renderer.xr.getController(0);
  arState.controller.addEventListener('select', onSelect);
  scene.add(arState.controller);
}

export function handleSessionEndCleanup() {
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
  }
  document.body.classList.remove('landscape');

  uiOverlayEl?.classList.add('hidden');
  dom.qrScreen?.classList.remove('hidden');
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'none';

  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  dancerVideo?.pause();
  stopPositionalAudio();

  document.body.classList.remove('drawer-open');
  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');
  dom.toast?.classList.add('hidden');

  restartQrCameraSoon();
}
