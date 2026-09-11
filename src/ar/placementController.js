import * as THREE from 'three';
import { arState } from './state.js';
import { dom } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { resetDetectedPlaneGrids } from './planeDetector.js';
import {
  resumeAudioContext,
  stopPositionalAudio,
  syncAudioToVideo
} from '../audio/audioController.js';
import { applyOrientationClasses, getEffectiveOrientation } from '../ui/orientationController.js';

export function resetArSessionState() {
  arState.arStarted = false;
  arState.isPlaced = false;
  disablePlacementListener();
  arState.lastHitPoseMatrix = null;
  arState.detectedFloorHeight = null;
  resetDetectedPlaneGrids();
  if (arState.floorGridMesh) arState.floorGridMesh.visible = false;
  if (arState.dancerGroup) {
    arState.dancerGroup.visible = false;
    arState.dancerGroup.scale.set(1, 1, 1);
  }
  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  if (dancerVideo) {
    dancerVideo.pause();
    dancerVideo.currentTime = 0;
  }
  const toast = dom.toast;
  if (toast) toast.classList.add('hidden');
  stopPositionalAudio();
}

export function enablePlacementListener() {
  if (!arState.arStarted || arState.isPlaced) return;
  const canvas = dom.arCanvas;
  if (arState.placementListenerAttached || typeof arState.handlePlacementTap !== 'function') return;
  if (canvas) canvas.addEventListener('pointerdown', arState.handlePlacementTap);
  window.addEventListener('pointerdown', arState.handlePlacementTap);
  window.addEventListener('touchend', arState.handlePlacementTap);
  arState.placementListenerAttached = true;
}

export function disablePlacementListener() {
  const canvas = dom.arCanvas;
  if (canvas && typeof arState.handlePlacementTap === 'function') {
    canvas.removeEventListener('pointerdown', arState.handlePlacementTap);
  }
  if (typeof arState.handlePlacementTap === 'function') {
    window.removeEventListener('pointerdown', arState.handlePlacementTap);
    window.removeEventListener('touchend', arState.handlePlacementTap);
  }
  arState.placementListenerAttached = false;
}

export function updateTapCoordinates(clientX, clientY) {
  if (typeof clientX === 'number' && clientX > 0 && typeof clientY === 'number' && clientY > 0) {
    arState.lastTapScreenX = clientX;
    arState.lastTapScreenY = clientY;
  }
}

export function onSelect() {
  if (!arState.arStarted || arState.isPlaced) return;
  if (performance.now() < arState.ignorePlacementUntil) return;
  handleFloorTap(arState.lastTapScreenX, arState.lastTapScreenY);
}

export function handleFloorTap(screenX = null, screenY = null) {
  if (!arState.arStarted || arState.isPlaced) return;
  if (performance.now() < arState.ignorePlacementUntil) return;

  const targetPoint = new THREE.Vector3();
  let foundIntersection = false;

  const renderer = arState.renderer;
  const camera = arState.camera;

  const xrCam = (renderer && renderer.xr && renderer.xr.isPresenting)
    ? renderer.xr.getCamera()
    : camera;
  const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0)
    ? xrCam.cameras[0]
    : camera;

  if (!activeCam) return;
  activeCam.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();

  const tapX = (typeof screenX === 'number' && screenX > 0)
    ? screenX
    : (typeof arState.lastTapScreenX === 'number' && arState.lastTapScreenX > 0 ? arState.lastTapScreenX : window.innerWidth / 2);
  const tapY = (typeof screenY === 'number' && screenY > 0)
    ? screenY
    : (typeof arState.lastTapScreenY === 'number' && arState.lastTapScreenY > 0 ? arState.lastTapScreenY : window.innerHeight / 2);

  const mouse = new THREE.Vector2(
    (tapX / window.innerWidth) * 2 - 1,
    -(tapY / window.innerHeight) * 2 + 1
  );

  raycaster.setFromCamera(mouse, activeCam);

  // 1. Test intersection with detected floor grid meshes
  if (arState.floorGridMesh && arState.floorGridMesh.children.length > 0) {
    const planeMeshes = [];
    arState.floorGridMesh.traverse((child) => {
      if (child.isMesh && child.visible) planeMeshes.push(child);
    });

    if (planeMeshes.length > 0) {
      const intersects = raycaster.intersectObjects(planeMeshes, true);
      if (intersects.length > 0) {
        targetPoint.copy(intersects[0].point);
        foundIntersection = true;
      }
    }
  }

  // 2. If fallback grid is active on detected surface, ensure tap is inside grid bounds
  if (!foundIntersection && arState.fallbackFloorGridMesh && arState.fallbackFloorGridMesh.visible && arState.detectedFloorHeight !== null) {
    const floorY = arState.detectedFloorHeight;
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    const hitIntersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, hitIntersection)) {
      const distFromGridCenter = hitIntersection.distanceTo(arState.fallbackFloorGridMesh.position);
      if (distFromGridCenter <= 4.5) {
        targetPoint.copy(hitIntersection);
        targetPoint.y = floorY;
        foundIntersection = true;
      }
    }
  }

  if (!foundIntersection && arState.isFallbackMode) {
    const gridPos = arState.fallbackFloorGridMesh?.position;
    if (gridPos) {
      targetPoint.set(gridPos.x, arState.detectedFloorHeight || -1.3, gridPos.z);
      foundIntersection = true;
    }
  }

  if (foundIntersection && arState.dancerGroup) {
    const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
    if (dancerVideo && dancerVideo.paused) {
      dancerVideo.play().catch(() => { });
    }

    arState.dancerGroup.position.set(targetPoint.x, targetPoint.y, targetPoint.z);
    arState.dancerGroup.userData.baseY = targetPoint.y;

    const cameraPos = new THREE.Vector3();
    activeCam.getWorldPosition(cameraPos);
    const angle = Math.atan2(
      cameraPos.x - arState.dancerGroup.position.x,
      cameraPos.z - arState.dancerGroup.position.z
    );
    arState.dancerGroup.userData.baseRotY = angle;
    arState.dancerGroup.rotation.set(0, angle, 0);

    placeDancer();
  } else {
    setToast('Point camera at floor and tap directly on the floor grid to place');
  }
}

export function placeDancer() {
  arState.isPlaced = true;
  disablePlacementListener();

  if (arState.dancerGroup) {
    arState.dancerGroup.visible = true;
  }

  if (arState.floorGridMesh) {
    arState.floorGridMesh.visible = false;
  }
  if (arState.fallbackFloorGridMesh) {
    arState.fallbackFloorGridMesh.visible = false;
  }

  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  const audioEl = arState.dancerAudioEl || document.getElementById('dancer-audio');

  if (dancerVideo) {
    dancerVideo.currentTime = 0;
    dancerVideo.play().catch(() => { });
  }

  resumeAudioContext();
  if (audioEl) {
    audioEl.currentTime = 0;
    if (arState.isAudioReady && !arState.isAudioMuted) {
      audioEl.play().catch(() => {});
    }
  }

  if (arState.isAudioReady && !arState.isAudioMuted) {
    if (arState.positionalAudio) {
      arState.positionalAudio.stop();
      arState.positionalAudio._progress = 0;
    }
    syncAudioToVideo(true);
  }

  setToast('3D Object placed on floor');
  setTimeout(() => {
    dom.toast?.classList.add('hidden');

    const captureBtn = dom.captureBtn || document.getElementById('capture-btn');
    if (captureBtn) {
      captureBtn.classList.remove('hidden');
      captureBtn.style.removeProperty('display');
      captureBtn.style.removeProperty('visibility');
      captureBtn.style.removeProperty('opacity');
      captureBtn.style.removeProperty('pointer-events');
    }

    const infoBtn = dom.infoToggleBtn || document.getElementById('info-toggle-btn');
    if (infoBtn) {
      infoBtn.classList.remove('hidden');
      infoBtn.style.removeProperty('display');
      infoBtn.style.removeProperty('visibility');
      infoBtn.style.removeProperty('opacity');
      infoBtn.style.removeProperty('pointer-events');
    }

    const recenterBtn = dom.recenterBtn || document.getElementById('recenter-btn');
    if (recenterBtn) {
      recenterBtn.classList.remove('hidden');
      recenterBtn.style.removeProperty('display');
      recenterBtn.style.removeProperty('visibility');
      recenterBtn.style.removeProperty('opacity');
      recenterBtn.style.removeProperty('pointer-events');
    }

    const exitBtn = dom.exitArBtn || document.getElementById('exit-ar-btn');
    if (exitBtn) {
      exitBtn.classList.remove('hidden');
      exitBtn.style.removeProperty('display');
      exitBtn.style.removeProperty('visibility');
      exitBtn.style.removeProperty('opacity');
      exitBtn.style.removeProperty('pointer-events');
    }

    const topBar = document.querySelector('.top-bar') || document.querySelector('.top-actions');
    if (topBar) {
      topBar.classList.remove('hidden');
      topBar.style.removeProperty('display');
      topBar.style.removeProperty('visibility');
      topBar.style.removeProperty('opacity');
      topBar.style.removeProperty('pointer-events');
    }

    applyOrientationClasses(arState.currentOrientationState || getEffectiveOrientation());
  }, 1500);
}

export function repositionDancer() {
  arState.ignorePlacementUntil = performance.now() + 800;
  arState.isPlaced = false;
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

  if (arState.floorGridMesh) {
    arState.floorGridMesh.visible = true;
    arState.floorGridMesh.traverse((child) => {
      if (child.isMesh) child.visible = true;
    });
  }
  if (arState.fallbackFloorGridMesh) {
    arState.fallbackFloorGridMesh.visible = true;
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

  setToast('Point at floor plane and tap anywhere on grid to place');

  setTimeout(() => {
    if (arState.arStarted && !arState.isPlaced) {
      enablePlacementListener();
    }
  }, 600);
}

export function setupPlacementInputListeners() {
  window.addEventListener('pointerdown', (e) => {
    updateTapCoordinates(e.clientX, e.clientY);
  }, { passive: true, capture: true });

  window.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      updateTapCoordinates(e.touches[0].clientX, e.touches[0].clientY);
    }
    if (e.touches && e.touches.length === 2 && arState.isPlaced && arState.dancerGroup) {
      arState.initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      arState.basePinchScale = arState.currentDancerScale;
    }
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length === 2 && arState.isPlaced && arState.dancerGroup && arState.initialPinchDist) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / arState.initialPinchDist;
      arState.currentDancerScale = THREE.MathUtils.clamp(arState.basePinchScale * factor, 0.4, 5.0);
      arState.dancerGroup.scale.set(arState.currentDancerScale, arState.currentDancerScale, arState.currentDancerScale);
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!e.touches || e.touches.length < 2) {
      arState.initialPinchDist = null;
      arState.basePinchScale = arState.currentDancerScale;
    }
  }, { passive: true });

  arState.handlePlacementTap = (e) => {
    if (!arState.arStarted || arState.isPlaced) return;
    if (performance.now() < arState.ignorePlacementUntil) return;
    if (e.target && e.target.closest && e.target.closest('button, .drawer, .top-bar-controls, .top-bar, .dock, input, label, #ARButton')) return;

    const x = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? (e.changedTouches && e.changedTouches[0]?.clientX);
    const y = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? (e.changedTouches && e.changedTouches[0]?.clientY);
    updateTapCoordinates(x, y);
    handleFloorTap(x, y);
  };
}
