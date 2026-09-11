import * as THREE from 'three';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { updateUILayout, unpinARControls } from '../ui/orientationController.js';
import { stopPositionalAudio } from '../audio/audioController.js';
import { enablePlacementListener, disablePlacementListener, spawnDancerInFrontOfCamera, clearVideoStartDelay } from './placementController.js';

// Pre-allocated vectors & quaternions for device orientation
const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X

let deviceOrientationListener = null;
let currentCameraStream = null;
let initialOrientationYaw = null;
let accumulatedScanTime = 0;
let lastScanTimestamp = 0;
let lastPitch = null;
let lastYaw = null;
let autoScanTimeout = null;

/**
 * Converts device orientation angles (alpha, beta, gamma) into a Three.js Quaternion.
 */
function setDeviceOrientationQuaternion(quaternion, alpha, beta, gamma, orientAngle = 0) {
  euler.set(
    THREE.MathUtils.degToRad(beta),
    THREE.MathUtils.degToRad(alpha),
    -THREE.MathUtils.degToRad(gamma),
    'YXZ'
  );
  quaternion.setFromEuler(euler);
  quaternion.multiply(q1); // Camera faces outward through back of phone
  quaternion.multiply(q0.setFromAxisAngle(zee, -THREE.MathUtils.degToRad(orientAngle))); // Screen rotation
}

/**
 * Triggers successful surface detection: reveals floor grid and prompts user to tap to place
 */
export function triggerSurfaceDetected() {
  arState.isSurfaceDetected = true;
  if (autoScanTimeout) {
    clearTimeout(autoScanTimeout);
    autoScanTimeout = null;
  }
  dom.surfaceScannerReticle?.classList.add('hidden');
  if (arState.fallbackFloorGridMesh) arState.fallbackFloorGridMesh.visible = false;
  if (arState.floorGridMesh) arState.floorGridMesh.visible = false;
}

/**
 * Handle incoming device orientation events
 */
function onDeviceOrientation(e) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;

  arState.deviceOrientationData.alpha = e.alpha;
  arState.deviceOrientationData.beta = e.beta;
  arState.deviceOrientationData.gamma = e.gamma;
  arState.deviceOrientationActive = true;

  const orientAngle = (typeof window.orientation === 'number')
    ? window.orientation
    : (screen.orientation?.angle || 0);

  const q = new THREE.Quaternion();
  setDeviceOrientationQuaternion(q, e.alpha, e.beta, e.gamma, orientAngle);

  if (initialOrientationYaw === null) {
    const camEuler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    initialOrientationYaw = camEuler.y;
  }

  if (arState.camera && arState.isFallbackMode) {
    arState.camera.quaternion.copy(q);
  }
}

/**
 * Request device orientation permissions on iOS 13+
 */
async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      return state === 'granted';
    } catch (err) {
      console.warn('[FallbackAR] Orientation permission prompt failed:', err);
      return false;
    }
  }
  return true;
}

/**
 * Reposition the dancer in fallback mode: re-centers the dancer directly in front of the camera
 */
export function repositionFallbackDancer() {
  arState.ignorePlacementUntil = performance.now() + 600;
  spawnDancerInFrontOfCamera(1.9);
  setToast('Dancer repositioned in front of camera');
  setTimeout(() => {
    dom.toast?.classList.add('hidden');
  }, 1800);
}

/**
 * Starts the fallback Camera + Gyro AR experience for Mozilla Firefox, iOS, and non-WebXR browsers
 */
export async function startFallbackAR() {
  try {
    setToast('Starting camera AR...');

    // 1. Request iOS 13+ device orientation permission if applicable
    await requestOrientationPermission();

    // 2. Request rear environment camera stream
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920, min: 640 },
        height: { ideal: 1080, min: 480 }
      }
    };

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (camErr) {
      console.warn('[FallbackAR] Ideal environment camera failed, trying fallback video constraints:', camErr);
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    currentCameraStream = stream;
    arState.cameraStream = stream;

    // 3. Attach camera stream to background video element
    const cameraVideo = dom.arCameraFeed || $('ar-camera-feed');
    if (cameraVideo) {
      cameraVideo.srcObject = stream;
      cameraVideo.classList.remove('hidden');
      await cameraVideo.play().catch(err => console.warn('Camera video play error:', err));
    }

    // 4. Set state flags: AR is active, dancer is placed immediately in front of camera
    arState.isFallbackMode = true;
    arState.arStarted = true;
    arState.isPlaced = true;
    arState.isSurfaceDetected = true;
    arState.detectedFloorHeight = -1.25;
    document.body.classList.add('ar-active', 'ar-fallback-active');

    // Disable Three.js WebXR presentation mode so camera renders normally
    if (arState.renderer && arState.renderer.xr) {
      arState.renderer.xr.enabled = false;
    }

    // 5. Hide landing screen & Start AR button
    dom.landingScreen?.classList.add('hidden');
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';

    // 6. Show AR UI Overlay
    const uiOverlayEl = dom.uiOverlay || $('ui-overlay');
    if (uiOverlayEl) {
      uiOverlayEl.classList.remove('hidden');
      uiOverlayEl.style.display = '';
      uiOverlayEl.style.visibility = '';
      uiOverlayEl.style.opacity = '';
      uiOverlayEl.style.pointerEvents = '';
    }

    // 7. Hide floor grids and surface scanner reticle
    if (arState.fallbackFloorGridMesh) arState.fallbackFloorGridMesh.visible = false;
    if (arState.floorGridMesh) arState.floorGridMesh.visible = false;
    dom.surfaceScannerReticle?.classList.add('hidden');

    // 8. Initialize orientation listener
    initialOrientationYaw = null;
    if (window.DeviceOrientationEvent) {
      deviceOrientationListener = onDeviceOrientation;
      window.addEventListener('deviceorientation', deviceOrientationListener, true);
    }

    // 9. Reset camera
    if (arState.camera) {
      arState.camera.position.set(0, 0, 0);
      arState.camera.rotation.set(0, 0, 0);
    }

    // 10. Automatically spawn MassKara dancer directly in front of camera with 4-second pause before video play!
    spawnDancerInFrontOfCamera(1.9, 4);

    // 11. Update UI layout to show controls and Bacolod mosaic ribbons
    updateUILayout(null, true);
    requestAnimationFrame(() => updateUILayout(null, true));
    setTimeout(() => updateUILayout(null, true), 150);

  } catch (err) {
    console.error('[FallbackAR] Error starting camera fallback AR:', err);
    setToast('Could not access camera: ' + (err.message || err), true);
    stopFallbackAR();
  }
}

/**
 * Clean up and exit fallback Camera AR mode
 */
export function stopFallbackAR() {
  clearVideoStartDelay();
  arState.isFallbackMode = false;
  arState.arStarted = false;
  arState.isPlaced = false;
  arState.isSurfaceDetected = false;
  accumulatedScanTime = 0;
  lastPitch = null;
  lastYaw = null;

  if (autoScanTimeout) {
    clearTimeout(autoScanTimeout);
    autoScanTimeout = null;
  }

  // Hide scanning reticle
  dom.surfaceScannerReticle?.classList.add('hidden');

  document.body.classList.remove('ar-active', 'ar-fallback-active');
  document.body.classList.remove('landscape', 'is-landscape', 'drawer-open');
  document.body.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');

  // Stop camera media stream
  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach(t => t.stop());
    currentCameraStream = null;
  }
  arState.cameraStream = null;

  const cameraVideo = dom.arCameraFeed || $('ar-camera-feed');
  if (cameraVideo) {
    cameraVideo.pause();
    cameraVideo.srcObject = null;
    cameraVideo.classList.add('hidden');
  }

  // Remove orientation listener
  if (deviceOrientationListener) {
    window.removeEventListener('deviceorientation', deviceOrientationListener, true);
    deviceOrientationListener = null;
  }
  initialOrientationYaw = null;
  arState.deviceOrientationActive = false;

  // Reset dancer
  if (arState.dancerGroup) {
    arState.dancerGroup.visible = false;
  }
  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  dancerVideo?.pause();
  stopPositionalAudio();

  // Reset camera
  if (arState.camera) {
    arState.camera.position.set(0, 0, 0);
    arState.camera.rotation.set(0, 0, 0);
  }

  // Re-enable WebXR flag on renderer for future WebXR sessions
  if (arState.renderer && arState.renderer.xr) {
    arState.renderer.xr.enabled = true;
  }

  // Disable placement listener and hide grids
  disablePlacementListener();
  if (arState.fallbackFloorGridMesh) {
    arState.fallbackFloorGridMesh.visible = false;
  }
  if (arState.floorGridMesh) {
    arState.floorGridMesh.visible = false;
  }

  // Unpin orientation controls
  unpinARControls();

  // Hide UI overlay completely
  const uiOverlayEl = dom.uiOverlay || $('ui-overlay');
  if (uiOverlayEl) {
    uiOverlayEl.classList.add('hidden');
    uiOverlayEl.style.setProperty('display', 'none', 'important');
    uiOverlayEl.style.setProperty('visibility', 'hidden', 'important');
    uiOverlayEl.style.setProperty('opacity', '0', 'important');
    uiOverlayEl.style.setProperty('pointer-events', 'none', 'important');
  }

  const exitBtn = dom.exitArBtn || $('exit-ar-btn');
  if (exitBtn) {
    exitBtn.classList.add('hidden');
    exitBtn.style.setProperty('display', 'none', 'important');
    exitBtn.style.setProperty('visibility', 'hidden', 'important');
    exitBtn.style.setProperty('opacity', '0', 'important');
    exitBtn.style.setProperty('pointer-events', 'none', 'important');
  }

  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');
  dom.toast?.classList.add('hidden');

  // Restore Landing Screen
  dom.landingScreen?.classList.remove('hidden');
  const arBtn = document.getElementById('ARButton');
  if (arBtn && arState.isMediaReady) {
    arBtn.style.display = 'flex';
  }

  updateUILayout();
}
