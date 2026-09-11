import * as THREE from 'three';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { updateUILayout, unpinARControls } from '../ui/orientationController.js';
import { stopPositionalAudio } from '../audio/audioController.js';
import { enablePlacementListener, disablePlacementListener } from './placementController.js';

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
  if (arState.isSurfaceDetected || arState.isPlaced || !arState.arStarted) return;
  arState.isSurfaceDetected = true;

  if (autoScanTimeout) {
    clearTimeout(autoScanTimeout);
    autoScanTimeout = null;
  }

  // Hide the scanning reticle
  dom.surfaceScannerReticle?.classList.add('hidden');

  // Position floor grid in front of current camera gaze on floor
  if (arState.camera) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(arState.camera.quaternion);
    const forwardXZ = new THREE.Vector3(forward.x, 0, forward.z);
    if (forwardXZ.lengthSq() < 0.001) forwardXZ.set(0, 0, -1);
    else forwardXZ.normalize();
    const dist = Math.min(Math.max(-1.3 / (forward.y || -0.6), 1.6), 3.0);
    if (arState.fallbackFloorGridMesh) {
      arState.fallbackFloorGridMesh.position.set(forwardXZ.x * dist, -1.3, forwardXZ.z * dist);
    }
  }

  // Reveal floor grid
  if (arState.fallbackFloorGridMesh) {
    arState.fallbackFloorGridMesh.visible = true;
  }
  if (arState.floorGridMesh) {
    arState.floorGridMesh.visible = true;
    arState.floorGridMesh.traverse((child) => {
      if (child.isMesh) child.visible = true;
    });
  }

  // Subtle haptic feedback on mobile devices
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate([40, 60, 40]); } catch (_) {}
  }

  setToast('Surface detected! Tap anywhere on the grid to place');
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

    // SURFACE SCANNING LOGIC (Requires 2.8 seconds of deliberate sweeping across floor)
    if (!arState.isPlaced && !arState.isSurfaceDetected) {
      // Force grid to stay strictly hidden while scanning
      if (arState.fallbackFloorGridMesh) arState.fallbackFloorGridMesh.visible = false;
      if (arState.floorGridMesh) arState.floorGridMesh.visible = false;

      const now = performance.now();
      const dt = Math.min((now - (lastScanTimestamp || now)) / 1000, 0.1);
      lastScanTimestamp = now;

      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);

      // Check vertical pitch:
      // forward.y indicates tilt: forward.y ≈ 0 is looking straight ahead at walls
      // forward.y < -0.20 means user is tilting camera downward at the floor
      if (forward.y > -0.20) {
        // User is aiming straight at walls or ceiling, not down at the floor!
        setToast('Tilt camera downward toward the floor...', true);
        const scannerText = dom.surfaceScannerReticle?.querySelector('.scanner-text');
        if (scannerText) scannerText.textContent = 'Aim camera at the floor';
      } else {
        // User is aiming downward at the floor!
        const deltaYaw = (lastYaw !== null) ? Math.abs(e.alpha - lastYaw) : 0;
        const deltaPitch = (lastPitch !== null) ? Math.abs(e.beta - lastPitch) : 0;
        lastYaw = e.alpha;
        lastPitch = e.beta;

        // Measure angular motion (degrees per second)
        const motionSpeed = (deltaYaw + deltaPitch) / (dt || 0.016);

        // Progress scanning: full speed if gently moving phone (motionSpeed > 2.5 deg/s),
        // or slow crawl if held stationary to prompt the user to sweep across the floor
        const moveFactor = motionSpeed > 2.0 ? 1.0 : 0.25;
        accumulatedScanTime += dt * moveFactor;

        // Require 2.8 seconds of active scanning!
        const targetScanDuration = 2.8;
        const progress = Math.min(accumulatedScanTime / targetScanDuration, 1.0);
        const percent = Math.round(progress * 100);

        const scannerText = dom.surfaceScannerReticle?.querySelector('.scanner-text');
        if (scannerText) {
          scannerText.textContent = `Scanning floor surface... ${percent}%`;
        }

        if (percent < 100) {
          setToast(`Move phone slowly to scan floor surface (${percent}%)`, true);
        } else {
          // 100% REACHED: SURFACE DETECTED!
          triggerSurfaceDetected();
        }
      }
    } else if (!arState.isPlaced && arState.isSurfaceDetected && arState.fallbackFloorGridMesh) {
      // After surface is detected, floor grid glides along the ground plane in front of user
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const forwardXZ = new THREE.Vector3(forward.x, 0, forward.z);
      if (forwardXZ.lengthSq() > 0.001) {
        forwardXZ.normalize();
        const dist = Math.min(Math.max(-1.3 / (forward.y || -0.6), 1.6), 3.0);
        arState.fallbackFloorGridMesh.position.set(forwardXZ.x * dist, -1.3, forwardXZ.z * dist);
      }
    }
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
 * Reposition the dancer in fallback mode: re-enters scanning phase so user can tap to place on floor
 */
export function repositionFallbackDancer() {
  arState.ignorePlacementUntil = performance.now() + 800;
  arState.isPlaced = false;
  arState.isSurfaceDetected = false;
  accumulatedScanTime = 0;
  lastScanTimestamp = performance.now();
  lastPitch = null;
  lastYaw = null;

  if (arState.dancerGroup) {
    arState.dancerGroup.visible = false;
    arState.dancerGroup.scale.set(1, 1, 1);
  }

  disablePlacementListener();
  stopPositionalAudio();

  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  if (dancerVideo) {
    dancerVideo.pause();
    dancerVideo.currentTime = 0;
  }

  // Hide floor grid until scanned again
  if (arState.fallbackFloorGridMesh) {
    arState.fallbackFloorGridMesh.visible = false;
  }
  if (arState.floorGridMesh) {
    arState.floorGridMesh.visible = false;
    arState.floorGridMesh.traverse((child) => {
      if (child.isMesh) child.visible = false;
    });
  }

  dom.historyModal?.classList.add('hidden');
  document.body.classList.remove('drawer-open');
  dom.infoToggleBtn?.classList.add('hidden');
  dom.captureBtn?.classList.add('hidden');
  dom.recenterBtn?.classList.add('hidden');
  dom.exitArBtn?.classList.add('hidden');
  const topBar = document.querySelector('.top-bar') || document.querySelector('.top-actions');
  if (topBar) {
    topBar.classList.add('hidden');
    topBar.style.setProperty('display', 'none', 'important');
  }

  // Show surface scanning reticle & instruction toast
  dom.surfaceScannerReticle?.classList.remove('hidden');
  const scannerText = dom.surfaceScannerReticle?.querySelector('.scanner-text');
  if (scannerText) scannerText.textContent = 'Point camera at the floor';

  setToast('Point camera at floor and move slowly to scan', true);

  if (autoScanTimeout) clearTimeout(autoScanTimeout);
  autoScanTimeout = setTimeout(() => {
    if (arState.arStarted && !arState.isPlaced && !arState.isSurfaceDetected && !arState.deviceOrientationActive) {
      triggerSurfaceDetected();
    }
  }, 8000);

  setTimeout(() => {
    if (arState.arStarted && !arState.isPlaced) {
      enablePlacementListener();
    }
  }, 400);

  updateUILayout();
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

    // 4. Set state flags: AR is active, but dancer is NOT placed and surface is NOT yet detected
    arState.isFallbackMode = true;
    arState.arStarted = true;
    arState.isPlaced = false;
    arState.isSurfaceDetected = false;
    arState.detectedFloorHeight = -1.3;
    accumulatedScanTime = 0;
    lastScanTimestamp = performance.now();
    lastPitch = null;
    lastYaw = null;
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

    // 7. Hide placed-only controls until dancer is placed (Exit, Reposition, Info pill, Camera Shutter, Top bar)
    dom.exitArBtn?.classList.add('hidden');
    dom.recenterBtn?.classList.add('hidden');
    dom.infoToggleBtn?.classList.add('hidden');
    dom.captureBtn?.classList.add('hidden');
    const topBar = document.querySelector('.top-bar') || document.querySelector('.top-actions');
    if (topBar) {
      topBar.classList.add('hidden');
      topBar.style.setProperty('display', 'none', 'important');
    }

    // 8. Initialize orientation listener
    initialOrientationYaw = null;
    if (window.DeviceOrientationEvent) {
      deviceOrientationListener = onDeviceOrientation;
      window.addEventListener('deviceorientation', deviceOrientationListener, true);
    }

    // 9. Reset camera and keep dancer hidden until user taps to place
    if (arState.camera) {
      arState.camera.position.set(0, 0, 0);
      arState.camera.rotation.set(0, 0, 0);
    }

    if (arState.dancerGroup) {
      arState.dancerGroup.visible = false;
      arState.dancerGroup.scale.set(1, 1, 1);
    }

    const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
    if (dancerVideo) {
      dancerVideo.pause();
      dancerVideo.currentTime = 0;
    }
    stopPositionalAudio();

    // 10. Prepare Floor Grid for surface scanning (initially HIDDEN until floor surface is scanned)
    if (!arState.fallbackFloorGridMesh) {
      const gridGeo = new THREE.PlaneGeometry(6, 6, 1, 1);
      gridGeo.rotateX(-Math.PI / 2);
      arState.fallbackFloorGridMesh = new THREE.Mesh(gridGeo, arState.floorGridMaterial);
      arState.fallbackFloorGridMesh.renderOrder = 1;
      if (arState.floorGridMesh) {
        arState.floorGridMesh.add(arState.fallbackFloorGridMesh);
      } else {
        arState.scene.add(arState.fallbackFloorGridMesh);
      }
    }
    arState.fallbackFloorGridMesh.position.set(0, -1.3, -2.2);
    arState.fallbackFloorGridMesh.visible = false;

    if (arState.floorGridMesh) {
      arState.floorGridMesh.visible = false;
      arState.floorGridMesh.traverse((child) => {
        if (child.isMesh) child.visible = false;
      });
    }

    // 11. Instruction toast & scanning reticle
    dom.surfaceScannerReticle?.classList.remove('hidden');
    const scannerText = dom.surfaceScannerReticle?.querySelector('.scanner-text');
    if (scannerText) scannerText.textContent = 'Point camera at the floor';

    setToast('Point camera at the floor and move slowly to scan', true);

    // Auto-detection timer ONLY for desktop / non-gyro environments (8s)
    if (autoScanTimeout) clearTimeout(autoScanTimeout);
    autoScanTimeout = setTimeout(() => {
      if (arState.arStarted && !arState.isPlaced && !arState.isSurfaceDetected && !arState.deviceOrientationActive) {
        triggerSurfaceDetected();
      }
    }, 8000);

    enablePlacementListener();
    setTimeout(() => {
      if (arState.arStarted && !arState.isPlaced) {
        enablePlacementListener();
      }
    }, 400);

    // 12. Update UI layout
    updateUILayout();
    requestAnimationFrame(updateUILayout);
    setTimeout(updateUILayout, 150);

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
