import * as THREE from 'three';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { updateUILayout, unpinARControls } from '../ui/orientationController.js';
import { stopPositionalAudio, syncAudioToVideo, resumeAudioContext } from '../audio/audioController.js';

// Pre-allocated vectors & quaternions for device orientation
const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X

let deviceOrientationListener = null;
let currentCameraStream = null;
let initialOrientationYaw = null;

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
    repositionFallbackDancer();
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
 * Reposition the dancer directly in front of the phone's current camera gaze
 */
export function repositionFallbackDancer() {
  if (!arState.dancerGroup || !arState.camera) return;

  const camera = arState.camera;
  camera.updateMatrixWorld(true);

  // Direction camera is facing projected on horizontal XZ plane
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 0.001) {
    forward.set(0, 0, -1);
  } else {
    forward.normalize();
  }

  const distance = 2.1;
  arState.dancerGroup.position.copy(camera.position).addScaledVector(forward, distance);
  arState.dancerGroup.position.y = camera.position.y - 0.48;
  arState.dancerGroup.userData.baseY = arState.dancerGroup.position.y;

  // Rotate dancer to face back toward the user
  const faceAngle = Math.atan2(forward.x, forward.z) + Math.PI;
  arState.dancerGroup.rotation.set(0, faceAngle, 0);
  arState.dancerGroup.userData.baseRotY = faceAngle;

  arState.isPlaced = true;
  arState.dancerGroup.visible = true;

  setToast('Dancer repositioned in front of you');
  setTimeout(() => {
    dom.toast?.classList.add('hidden');
  }, 2200);
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

    // 4. Set state flags
    arState.isFallbackMode = true;
    arState.arStarted = true;
    arState.isPlaced = true;
    document.body.classList.add('ar-active', 'ar-fallback-active');

    // Disable Three.js WebXR presentation mode so camera renders normally
    if (arState.renderer && arState.renderer.xr) {
      arState.renderer.xr.enabled = false;
    }

    // 5. Hide landing screen & Start AR button
    dom.landingScreen?.classList.add('hidden');
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';

    // 6. Show AR UI Overlay & Controls
    const uiOverlayEl = dom.uiOverlay || $('ui-overlay');
    if (uiOverlayEl) {
      uiOverlayEl.classList.remove('hidden');
      uiOverlayEl.style.display = '';
      uiOverlayEl.style.visibility = '';
      uiOverlayEl.style.opacity = '';
      uiOverlayEl.style.pointerEvents = '';
    }

    const exitBtn = dom.exitArBtn || $('exit-ar-btn');
    if (exitBtn) {
      exitBtn.classList.remove('hidden');
      exitBtn.style.display = '';
      exitBtn.style.visibility = '';
      exitBtn.style.opacity = '';
      exitBtn.style.pointerEvents = '';
    }

    dom.infoToggleBtn?.classList.remove('hidden');
    const captureBtn = dom.captureBtn || document.getElementById('capture-btn');
    if (captureBtn) {
      captureBtn.classList.remove('hidden');
      captureBtn.style.removeProperty('display');
      captureBtn.style.removeProperty('visibility');
      captureBtn.style.removeProperty('opacity');
      captureBtn.style.removeProperty('pointer-events');
    }
    dom.recenterBtn?.classList.remove('hidden');

    // 7. Initialize orientation listener
    initialOrientationYaw = null;
    if (window.DeviceOrientationEvent) {
      deviceOrientationListener = onDeviceOrientation;
      window.addEventListener('deviceorientation', deviceOrientationListener, true);
    }

    // 8. Position the dancer in front of user and make visible
    if (arState.camera) {
      arState.camera.position.set(0, 0, 0);
      arState.camera.rotation.set(0, 0, 0);
    }

    if (arState.dancerGroup) {
      arState.dancerGroup.position.set(0, -0.48, -2.1);
      arState.dancerGroup.rotation.set(0, 0, 0);
      arState.dancerGroup.userData.baseY = -0.48;
      arState.dancerGroup.visible = true;
    }

    // Hide floor grid in fallback mode
    if (arState.floorGridMesh) {
      arState.floorGridMesh.visible = false;
    }

    // 9. Play festival dancer video & audio
    const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
    if (dancerVideo) {
      dancerVideo.currentTime = 0;
      dancerVideo.play().catch(() => {});
    }

    resumeAudioContext();
    const audioEl = arState.dancerAudioEl || document.getElementById('dancer-audio');
    if (audioEl && arState.isAudioReady && !arState.isAudioMuted) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    }
    syncAudioToVideo(true);

    // 10. Update UI layout
    updateUILayout();
    requestAnimationFrame(updateUILayout);
    setTimeout(updateUILayout, 150);

    setToast('Move your phone to explore the MassKara dancer!');
    setTimeout(() => {
      dom.toast?.classList.add('hidden');
    }, 3500);

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
