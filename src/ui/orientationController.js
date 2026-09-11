import * as THREE from 'three';
import { arState } from '../ar/state.js';
import { dom, $ } from './domElements.js';

export function setupDeviceOrientationListeners() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma !== null && e.gamma !== undefined) {
      arState.lastDeviceOrientationTimestamp = performance.now();
      const absGamma = Math.abs(e.gamma);
      const absBeta = Math.abs(e.beta || 0);

      // If phone is held upright in portrait, gamma is small and beta is tilted up
      if (absGamma < 25 && absBeta > 30) {
        arState.lastDeviceOrientationAngle = 0; // portrait
      } else if (e.gamma < -45 || (absBeta < 35 && e.gamma < -25)) {
        arState.lastDeviceOrientationAngle = 90; // landscape primary (counter-clockwise)
      } else if (e.gamma > 45 || (absBeta < 35 && e.gamma > 25)) {
        arState.lastDeviceOrientationAngle = -90; // landscape secondary (clockwise)
      }
    }
  }, true);
}

export function getXrDeviceOrientation(cameraObj) {
  const activeCam = (cameraObj && cameraObj.cameras && cameraObj.cameras.length > 0)
    ? cameraObj.cameras[0]
    : (cameraObj || arState.camera);
  if (!activeCam) return null;
  const q = activeCam.quaternion;

  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

  if (Math.abs(camDir.y) > 0.94) {
    if (arState.currentOrientationIsLandscape !== null) {
      return { isLandscape: arState.currentOrientationIsLandscape, angle: arState.currentOrientationState?.angle ?? (arState.currentOrientationIsLandscape ? 90 : 0) };
    }
    return null;
  }

  const projUp = new THREE.Vector3(0, 1, 0).addScaledVector(camDir, -camDir.y);
  const len = projUp.length();
  if (len < 0.2) {
    if (arState.currentOrientationIsLandscape !== null) {
      return { isLandscape: arState.currentOrientationIsLandscape, angle: arState.currentOrientationState?.angle ?? (arState.currentOrientationIsLandscape ? 90 : 0) };
    }
    return null;
  }
  projUp.divideScalar(len);

  const m = activeCam.projectionMatrix?.elements;
  const isNativeXrLandscape = (m && m[0] && m[5]) ? (m[0] < m[5]) : (window.innerWidth > window.innerHeight);

  if (!isNativeXrLandscape) {
    const rightDot = camRight.dot(projUp);
    const absRight = Math.abs(rightDot);
    const isLandscape = arState.currentOrientationIsLandscape ? absRight >= 0.42 : absRight >= 0.62;
    const angle = rightDot < 0 ? -90 : 90;
    return { isLandscape, angle };
  } else {
    const upDot = camUp.dot(projUp);
    const absUp = Math.abs(upDot);
    const isLandscape = arState.currentOrientationIsLandscape ? absUp >= 0.42 : absUp >= 0.62;
    const angle = isLandscape ? (upDot < 0 ? -90 : 90) : 0;
    return { isLandscape, angle };
  }
}

export function getScreenOrientationInfo() {
  if (screen?.orientation?.type) {
    if (screen.orientation.type.startsWith('portrait')) return { isLandscape: false, angle: 0 };
    if (screen.orientation.type.startsWith('landscape-secondary')) return { isLandscape: true, angle: -90 };
    if (screen.orientation.type.startsWith('landscape')) return { isLandscape: true, angle: 90 };
  }

  const angle = screen?.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : null);
  if (angle !== null && angle !== undefined) {
    if (angle === 0 || angle === 180) return { isLandscape: false, angle: 0 };
    if (Math.abs(angle) === 90) return { isLandscape: true, angle: 90 };
    if (angle === 270 || angle === -90) return { isLandscape: true, angle: -90 };
  }

  if (window.matchMedia) {
    if (window.matchMedia('(orientation: portrait)').matches) {
      return { isLandscape: false, angle: 0 };
    }
    if (window.matchMedia('(orientation: landscape)').matches) {
      return { isLandscape: true, angle: 90 };
    }
  }

  if (window.innerWidth > window.innerHeight) {
    return { isLandscape: true, angle: 90 };
  }

  return { isLandscape: false, angle: 0 };
}

export function getEffectiveOrientation() {
  const renderer = arState.renderer;
  if (renderer?.xr?.isPresenting) {
    const xrCam = renderer.xr.getCamera?.();
    const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0) ? xrCam.cameras[0] : (xrCam || arState.camera);
    const xrOrient = getXrDeviceOrientation(activeCam);
    if (xrOrient !== null) {
      return xrOrient;
    }
  }

  const screenInfo = getScreenOrientationInfo();
  const isRecentTilt = (performance.now() - arState.lastDeviceOrientationTimestamp) < 2000;
  if (isRecentTilt && arState.lastDeviceOrientationAngle !== null && arState.lastDeviceOrientationAngle !== 0 && screenInfo.angle === 0 && !screen?.orientation?.type?.startsWith('portrait')) {
    return {
      isLandscape: true,
      angle: arState.lastDeviceOrientationAngle
    };
  }

  return screenInfo;
}

export function applyOrientationClasses(orientationInfo) {
  const isLandscape = !!orientationInfo?.isLandscape;
  const angle = orientationInfo?.angle ?? 90;

  arState.currentOrientationIsLandscape = isLandscape;
  arState.currentOrientationState = { isLandscape, angle };

  const overlay = document.getElementById('ar-overlay') || document.getElementById('ui-overlay') || dom.uiOverlay;
  const uiWrapper = document.getElementById('ui-wrapper') || dom.uiWrapper;

  const isNativeLandscape = window.innerWidth > window.innerHeight;

  if (isLandscape) {
    document.body.classList.add('is-landscape', 'landscape');
    document.body.classList.remove('is-portrait', 'simulated-portrait');
    if (overlay) {
      overlay.classList.add('is-landscape', 'landscape');
      overlay.classList.remove('is-portrait');
    }
    if (uiWrapper) {
      uiWrapper.classList.add('is-landscape', 'landscape');
      uiWrapper.classList.remove('is-portrait', 'simulated-portrait');
    }

    if (overlay) {
      overlay.style.setProperty('position', 'fixed', 'important');
      overlay.style.setProperty('inset', '0', 'important');
      overlay.style.setProperty('top', '0', 'important');
      overlay.style.setProperty('bottom', '0', 'important');
      overlay.style.setProperty('left', '0', 'important');
      overlay.style.setProperty('right', '0', 'important');
      overlay.style.setProperty('width', '100%', 'important');
      overlay.style.setProperty('height', '100%', 'important');
      overlay.style.setProperty('pointer-events', 'none', 'important');
      overlay.style.transform = '';
      if (!isNativeLandscape) {
        overlay.style.overflow = 'visible';
      } else {
        overlay.style.overflow = '';
      }
    }

    if (uiWrapper) {
      if (isNativeLandscape) {
        document.body.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
        uiWrapper.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', '0', 'important');
        uiWrapper.style.setProperty('width', '100%', 'important');
        uiWrapper.style.setProperty('height', '100%', 'important');
        uiWrapper.style.setProperty('left', '0', 'important');
        uiWrapper.style.setProperty('top', '0', 'important');
        uiWrapper.style.setProperty('transform', 'none', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
        uiWrapper.style.setProperty('opacity', '1', 'important');
      } else {
        const pw = window.innerWidth;
        const ph = window.innerHeight;
        const deg = angle === -90 || angle === 270 ? -90 : 90;
        const simClass = deg === -90 ? 'simulated-landscape--90' : 'simulated-landscape-90';
        const otherSimClass = deg === -90 ? 'simulated-landscape-90' : 'simulated-landscape--90';

        document.body.classList.add('simulated-landscape', simClass);
        document.body.classList.remove(otherSimClass);
        uiWrapper.classList.add('simulated-landscape', simClass);
        uiWrapper.classList.remove(otherSimClass);

        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', 'auto', 'important');
        uiWrapper.style.setProperty('width', ph + 'px', 'important');
        uiWrapper.style.setProperty('height', pw + 'px', 'important');
        uiWrapper.style.setProperty('left', ((pw - ph) / 2) + 'px', 'important');
        uiWrapper.style.setProperty('top', ((ph - pw) / 2) + 'px', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
        uiWrapper.style.setProperty('transform', `rotate(${deg}deg)`, 'important');
        uiWrapper.style.setProperty('opacity', '1', 'important');
      }
    }
  } else {
    document.body.classList.add('is-portrait');
    document.body.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
    if (overlay) {
      overlay.classList.add('is-portrait');
      overlay.classList.remove('is-landscape', 'landscape');
      overlay.style.setProperty('position', 'fixed', 'important');
      overlay.style.setProperty('inset', '0', 'important');
      overlay.style.setProperty('top', '0', 'important');
      overlay.style.setProperty('bottom', '0', 'important');
      overlay.style.setProperty('left', '0', 'important');
      overlay.style.setProperty('right', '0', 'important');
      overlay.style.setProperty('width', '100%', 'important');
      overlay.style.setProperty('height', '100%', 'important');
      overlay.style.setProperty('pointer-events', 'none', 'important');
      overlay.style.overflow = '';
    }
    if (uiWrapper) {
      uiWrapper.classList.add('is-portrait');
      uiWrapper.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');

      if (!isNativeLandscape) {
        document.body.classList.remove('simulated-portrait');
        uiWrapper.classList.remove('simulated-portrait');
        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', '0', 'important');
        uiWrapper.style.setProperty('width', '100%', 'important');
        uiWrapper.style.setProperty('height', '100%', 'important');
        uiWrapper.style.setProperty('left', '0', 'important');
        uiWrapper.style.setProperty('top', '0', 'important');
        uiWrapper.style.setProperty('transform', 'none', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
        uiWrapper.style.setProperty('opacity', '1', 'important');
      } else {
        const pw = window.innerWidth;
        const ph = window.innerHeight;
        const deg = (angle === -90 || angle === 270) ? 90 : -90;
        document.body.classList.add('simulated-portrait');
        uiWrapper.classList.add('simulated-portrait');
        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', 'auto', 'important');
        uiWrapper.style.setProperty('width', ph + 'px', 'important');
        uiWrapper.style.setProperty('height', pw + 'px', 'important');
        uiWrapper.style.setProperty('left', ((pw - ph) / 2) + 'px', 'important');
        uiWrapper.style.setProperty('top', ((ph - pw) / 2) + 'px', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
        uiWrapper.style.setProperty('transform', `rotate(${deg}deg)`, 'important');
        uiWrapper.style.setProperty('opacity', '1', 'important');
      }
    }
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  if (arState.camera && !arState.renderer?.xr?.isPresenting) {
    arState.camera.aspect = width / height;
    arState.camera.updateProjectionMatrix();
  }

  if (arState.renderer && !arState.renderer?.xr?.isPresenting) {
    arState.renderer.setSize(width, height);
  }
}

export function updateUILayout(forcedOrientation = null) {
  let target = forcedOrientation;
  if (typeof target === 'boolean') {
    target = { isLandscape: target, angle: 90 };
  } else if (!target) {
    target = getEffectiveOrientation();
  }

  const uiWrapper = document.getElementById('ui-wrapper') || dom.uiWrapper;
  const isFirstRun = arState.currentOrientationIsLandscape === null;
  const hasChanged = !isFirstRun && (
    target.isLandscape !== arState.currentOrientationIsLandscape ||
    (target.isLandscape && target.angle !== arState.currentOrientationState?.angle)
  );

  if (!isFirstRun && !hasChanged) {
    return;
  }

  if (arState.isTransitioningOrientation && arState.pendingOrientationTarget &&
      arState.pendingOrientationTarget.isLandscape === target.isLandscape &&
      arState.pendingOrientationTarget.angle === target.angle) {
    return;
  }

  if (isFirstRun || !uiWrapper || !arState.arStarted) {
    arState.pendingOrientationTarget = null;
    arState.isTransitioningOrientation = false;
    applyOrientationClasses(target);
    return;
  }

  arState.pendingOrientationTarget = { ...target };
  arState.isTransitioningOrientation = true;

  if (arState.orientationTransitionTimer) {
    clearTimeout(arState.orientationTransitionTimer);
    arState.orientationTransitionTimer = null;
  }

  uiWrapper.classList.add('ui-transitioning');

  arState.orientationTransitionTimer = setTimeout(() => {
    applyOrientationClasses(arState.pendingOrientationTarget || target);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        uiWrapper.classList.remove('ui-transitioning');
        arState.isTransitioningOrientation = false;
        arState.pendingOrientationTarget = null;
        arState.orientationTransitionTimer = null;
      });
    });
  }, 180);
}
