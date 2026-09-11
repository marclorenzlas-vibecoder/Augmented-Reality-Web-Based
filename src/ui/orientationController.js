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

  // If window is natively wider than tall, it's native landscape
  if (window.innerWidth > window.innerHeight) {
    return { isLandscape: true, angle: 90 };
  }

  const q = activeCam.quaternion;
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

  if (Math.abs(camDir.y) > 0.92) {
    if (arState.currentOrientationIsLandscape !== null) {
      return {
        isLandscape: arState.currentOrientationIsLandscape,
        angle: arState.currentOrientationState?.angle ?? (arState.currentOrientationIsLandscape ? 90 : 0)
      };
    }
    return null;
  }

  const projUp = new THREE.Vector3(0, 1, 0).addScaledVector(camDir, -camDir.y);
  const len = projUp.length();
  if (len < 0.2) {
    if (arState.currentOrientationIsLandscape !== null) {
      return {
        isLandscape: arState.currentOrientationIsLandscape,
        angle: arState.currentOrientationState?.angle ?? (arState.currentOrientationIsLandscape ? 90 : 0)
      };
    }
    return null;
  }
  projUp.divideScalar(len);

  const rightDot = camRight.dot(projUp);
  const absRight = Math.abs(rightDot);

  // Robust hysteresis: requires absRight >= 0.62 to enter landscape, stays landscape until absRight <= 0.38
  const currentlyLandscape = !!arState.currentOrientationIsLandscape;
  const isLandscape = currentlyLandscape ? (absRight >= 0.38) : (absRight >= 0.62);

  let angle = 0;
  if (isLandscape) {
    const prevAngle = arState.currentOrientationState?.angle ?? 90;
    // When phone is tilted counter-clockwise (landscape-primary), camRight points down so rightDot < 0 -> angle = 90
    // When phone is tilted clockwise (landscape-secondary), camRight points up so rightDot > 0 -> angle = -90
    if (prevAngle === -90 && rightDot < -0.38) {
      angle = 90;
    } else if (prevAngle === 90 && rightDot > 0.38) {
      angle = -90;
    } else {
      angle = (prevAngle === -90 || prevAngle === 90) ? prevAngle : (rightDot < 0 ? 90 : -90);
    }
  }

  return { isLandscape, angle };
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

// Track elements we've reparented so we can restore them
const _movedEls = new Map(); // el → { parent, nextSibling }

/**
 * Move an element to be a direct child of the overlay (which has no CSS transform),
 * so that position:absolute uses viewport coordinates — bypassing the rotated wrapper.
 */
function _liftToOverlay(el) {
  const overlay = document.getElementById('ar-overlay') || document.getElementById('ui-overlay');
  if (!el || !overlay || el.parentElement === overlay) return;
  _movedEls.set(el, { parent: el.parentElement, nextSibling: el.nextSibling });
  overlay.appendChild(el);
}

function _applyARControlsLandscape(deg) {
  // Restore any reparented elements back into uiWrapper
  _unpinARControls();

  // Hide information drawer when rotating so it never blocks the screen
  const historyModal = document.getElementById('history-modal');
  if (historyModal) {
    historyModal.classList.add('hidden');
    document.body.classList.remove('drawer-open');
  }

  const isCCW = (deg !== -90); // true for CCW tilt (rotate left), false for CW tilt (rotate right)

  // 1) Top Bar: [Reposition] + [✕ Exit]
  // In CCW: top-right of landscape screen. In CW: top-left of landscape screen.
  const topBar = document.querySelector('.top-bar') || document.querySelector('.top-actions');
  if (topBar) {
    topBar.style.setProperty('position', 'absolute', 'important');
    topBar.style.setProperty('top', '24px', 'important');
    topBar.style.setProperty('bottom', 'auto', 'important');
    topBar.style.setProperty('left', isCCW ? 'auto' : '24px', 'important');
    topBar.style.setProperty('right', isCCW ? '24px' : 'auto', 'important');
    topBar.style.setProperty('z-index', '150', 'important');
    topBar.style.setProperty('display', 'flex', 'important');
    topBar.style.setProperty('flex-direction', isCCW ? 'row' : 'row-reverse', 'important');
    topBar.style.setProperty('align-items', 'center', 'important');
    topBar.style.setProperty('gap', '10px', 'important');
    topBar.style.setProperty('opacity', '1', 'important');
    topBar.style.setProperty('visibility', 'visible', 'important');
    topBar.style.setProperty('pointer-events', 'auto', 'important');
    topBar.style.setProperty('transform', 'none', 'important');
    topBar.style.setProperty('width', 'auto', 'important');

    const topBarInner = topBar.querySelector('div') || topBar;
    if (topBarInner && topBarInner !== topBar) {
      topBarInner.style.setProperty('display', 'flex', 'important');
      topBarInner.style.setProperty('flex-direction', isCCW ? 'row' : 'row-reverse', 'important');
      topBarInner.style.setProperty('align-items', 'center', 'important');
      topBarInner.style.setProperty('gap', '8px', 'important');
      topBarInner.style.setProperty('margin', '0', 'important');
      topBarInner.style.setProperty('opacity', '1', 'important');
      topBarInner.style.setProperty('visibility', 'visible', 'important');
      topBarInner.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  const exitBtn = document.getElementById('exit-ar-btn');
  if (exitBtn) {
    exitBtn.classList.remove('hidden');
    exitBtn.style.setProperty('display', 'inline-flex', 'important');
    exitBtn.style.setProperty('opacity', '1', 'important');
    exitBtn.style.setProperty('visibility', 'visible', 'important');
    exitBtn.style.setProperty('pointer-events', 'auto', 'important');
    exitBtn.style.setProperty('z-index', '155', 'important');
  }

  const recenterBtn = document.getElementById('recenter-btn');
  if (recenterBtn) {
    recenterBtn.classList.remove('hidden');
    recenterBtn.style.setProperty('display', 'inline-flex', 'important');
    recenterBtn.style.setProperty('opacity', '1', 'important');
    recenterBtn.style.setProperty('visibility', 'visible', 'important');
    recenterBtn.style.setProperty('pointer-events', 'auto', 'important');
    recenterBtn.style.setProperty('z-index', '155', 'important');
  }

  // 2) Camera Shutter:
  // In CCW: middle-right of landscape screen. In CW: middle-left of landscape screen.
  const captureBtn = document.getElementById('capture-btn');
  if (captureBtn) {
    captureBtn.classList.remove('hidden');
    captureBtn.style.setProperty('position', 'absolute', 'important');
    captureBtn.style.setProperty('top', '50%', 'important');
    captureBtn.style.setProperty('bottom', 'auto', 'important');
    captureBtn.style.setProperty('left', isCCW ? 'auto' : '24px', 'important');
    captureBtn.style.setProperty('right', isCCW ? '24px' : 'auto', 'important');
    captureBtn.style.setProperty('transform', 'translateY(-50%)', 'important');
    captureBtn.style.setProperty('display', 'flex', 'important');
    captureBtn.style.setProperty('opacity', '1', 'important');
    captureBtn.style.setProperty('visibility', 'visible', 'important');
    captureBtn.style.setProperty('pointer-events', 'auto', 'important');
    captureBtn.style.setProperty('z-index', '150', 'important');
    captureBtn.style.setProperty('margin', '0', 'important');
  }

  // 3) About MassKara Festival Pill:
  // In CCW: bottom-right of landscape screen. In CW: bottom-left of landscape screen.
  // Oriented horizontally, completely readable and beautifully positioned.
  const infoBtn = document.getElementById('info-toggle-btn');
  if (infoBtn) {
    infoBtn.classList.remove('hidden');
    infoBtn.style.setProperty('position', 'absolute', 'important');
    infoBtn.style.setProperty('top', 'auto', 'important');
    infoBtn.style.setProperty('bottom', '24px', 'important');
    infoBtn.style.setProperty('left', isCCW ? 'auto' : '24px', 'important');
    infoBtn.style.setProperty('right', isCCW ? '24px' : 'auto', 'important');
    infoBtn.style.setProperty('transform', 'none', 'important');
    infoBtn.style.setProperty('display', 'inline-flex', 'important');
    infoBtn.style.setProperty('opacity', '1', 'important');
    infoBtn.style.setProperty('visibility', 'visible', 'important');
    infoBtn.style.setProperty('pointer-events', 'auto', 'important');
    infoBtn.style.setProperty('z-index', '150', 'important');
    infoBtn.style.setProperty('white-space', 'nowrap', 'important');
    infoBtn.style.setProperty('width', 'auto', 'important');
    infoBtn.style.setProperty('margin', '0', 'important');
  }

  // 4) Dock container: transparent full-bleed layer inside uiWrapper
  const dock = document.querySelector('.dock');
  if (dock) {
    dock.style.setProperty('position', 'absolute', 'important');
    dock.style.setProperty('inset', '0', 'important');
    dock.style.setProperty('width', '100%', 'important');
    dock.style.setProperty('height', '100%', 'important');
    dock.style.setProperty('pointer-events', 'none', 'important');
    dock.style.setProperty('display', 'block', 'important');
    dock.style.setProperty('transform', 'none', 'important');
    dock.style.setProperty('z-index', '140', 'important');
  }

  // 5) Tribal ribbons: running along top and bottom of the landscape view
  const ribbonsTop = document.querySelectorAll('#ui-wrapper .tribal-ribbon--top, .tribal-ribbon--top');
  ribbonsTop.forEach(r => {
    r.style.setProperty('position', 'absolute', 'important');
    r.style.setProperty('top', '0', 'important');
    r.style.setProperty('left', '0', 'important');
    r.style.setProperty('right', '0', 'important');
    r.style.setProperty('bottom', 'auto', 'important');
    r.style.setProperty('width', '100%', 'important');
    r.style.setProperty('height', '30px', 'important');
    r.style.setProperty('background-image', "url('/bacolod-mosaic-ribbon.svg')", 'important');
    r.style.setProperty('background-repeat', 'repeat-x', 'important');
    r.style.setProperty('background-size', '360px 30px', 'important');
    r.style.setProperty('display', 'block', 'important');
    r.style.setProperty('opacity', '1', 'important');
    r.style.setProperty('visibility', 'visible', 'important');
    r.style.setProperty('z-index', '100', 'important');
    r.style.setProperty('pointer-events', 'none', 'important');
  });

  const ribbonsBottom = document.querySelectorAll('#ui-wrapper .tribal-ribbon--bottom, .tribal-ribbon--bottom');
  ribbonsBottom.forEach(r => {
    r.style.setProperty('position', 'absolute', 'important');
    r.style.setProperty('bottom', '0', 'important');
    r.style.setProperty('top', 'auto', 'important');
    r.style.setProperty('left', '0', 'important');
    r.style.setProperty('right', '0', 'important');
    r.style.setProperty('width', '100%', 'important');
    r.style.setProperty('height', '30px', 'important');
    r.style.setProperty('background-image', "url('/bacolod-mosaic-ribbon.svg')", 'important');
    r.style.setProperty('background-repeat', 'repeat-x', 'important');
    r.style.setProperty('background-size', '360px 30px', 'important');
    r.style.setProperty('display', 'block', 'important');
    r.style.setProperty('opacity', '1', 'important');
    r.style.setProperty('visibility', 'visible', 'important');
    r.style.setProperty('z-index', '100', 'important');
    r.style.setProperty('pointer-events', 'none', 'important');
  });

  // 6) Toast: Top-center of landscape screen
  const toast = document.getElementById('toast');
  if (toast) {
    toast.style.setProperty('position', 'absolute', 'important');
    toast.style.setProperty('top', '34px', 'important');
    toast.style.setProperty('left', '50%', 'important');
    toast.style.setProperty('right', 'auto', 'important');
    toast.style.setProperty('bottom', 'auto', 'important');
    toast.style.setProperty('transform', 'translateX(-50%)', 'important');
    toast.style.setProperty('max-width', '50vw', 'important');
    toast.style.setProperty('z-index', '90', 'important');
  }
}

function _unpinARControls() {
  const topBarEl = document.querySelector('.top-bar') || document.querySelector('.top-actions');
  const elements = [
    topBarEl,
    topBarEl?.querySelector('div'),
    document.getElementById('exit-ar-btn'),
    document.getElementById('recenter-btn'),
    document.getElementById('capture-btn'),
    document.getElementById('info-toggle-btn'),
    document.querySelector('.dock'),
    document.querySelector('.tribal-ribbon--top'),
    document.querySelector('.tribal-ribbon--bottom'),
    document.getElementById('toast'),
  ];

  const propsToClear = [
    'position', 'top', 'left', 'right', 'bottom', 'z-index',
    'display', 'flex-direction', 'align-items', 'gap', 'opacity',
    'visibility', 'pointer-events', 'transform', 'transform-origin',
    'width', 'height', 'max-width', 'white-space', 'margin'
  ];

  for (const el of elements) {
    if (!el) continue;
    for (const prop of propsToClear) {
      el.style.removeProperty(prop);
    }
  }

  // Restore elements that were reparented to overlay back into their original parent
  for (const [el, info] of _movedEls.entries()) {
    if (el && info?.parent && el.parentElement !== info.parent) {
      if (info.nextSibling && info.nextSibling.parentNode === info.parent) {
        info.parent.insertBefore(el, info.nextSibling);
      } else {
        info.parent.appendChild(el);
      }
    }
  }
  _movedEls.clear();
}

export function applyOrientationClasses(orientationInfo) {
  const isLandscape = !!orientationInfo?.isLandscape;
  const angle = orientationInfo?.angle ?? 90;

  // Auto-hide history drawer whenever phone is rotated
  const historyModal = document.getElementById('history-modal');
  if (historyModal) {
    historyModal.classList.add('hidden');
    document.body.classList.remove('drawer-open');
  }


  arState.currentOrientationIsLandscape = isLandscape;
  arState.currentOrientationState = { isLandscape, angle };

  const overlay = document.getElementById('ar-overlay') || document.getElementById('ui-overlay') || dom.uiOverlay;
  const uiWrapper = document.getElementById('ui-wrapper') || dom.uiWrapper;

  const isNativeLandscape = window.innerWidth > window.innerHeight;

  // Keep overlay hidden if AR hasn't started yet
  if (!arState.arStarted && overlay?.classList.contains('hidden')) {
    overlay.style.setProperty('visibility', 'hidden', 'important');
    overlay.style.setProperty('opacity', '0', 'important');
    overlay.style.setProperty('pointer-events', 'none', 'important');
    return;
  }

  if (isLandscape) {
    document.body.classList.add('is-landscape', 'landscape');
    document.body.classList.remove('is-portrait', 'simulated-portrait');

    const deg = (angle === -90 || angle === 270) ? -90 : 90;
    const simClass = deg === -90 ? 'simulated-landscape--90' : 'simulated-landscape-90';
    const otherSimClass = deg === -90 ? 'simulated-landscape-90' : 'simulated-landscape--90';

    if (overlay) {
      overlay.classList.add('is-landscape', 'landscape');
      overlay.classList.remove('is-portrait');
      overlay.style.setProperty('position', 'fixed', 'important');
      overlay.style.setProperty('inset', '0', 'important');
      overlay.style.setProperty('width', '100%', 'important');
      overlay.style.setProperty('height', '100%', 'important');
      overlay.style.setProperty('pointer-events', 'none', 'important');
      overlay.style.setProperty('opacity', '1', 'important');
      overlay.style.setProperty('visibility', 'visible', 'important');
      // Always overflow:visible in simulated landscape so rotated/fixed children show
      overlay.style.setProperty('overflow', 'visible', 'important');

      if (!isNativeLandscape) {
        overlay.classList.add('simulated-landscape', simClass);
        overlay.classList.remove(otherSimClass);
      } else {
        overlay.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
        overlay.style.setProperty('overflow', 'hidden', 'important');
      }
    }

    if (uiWrapper) {
      uiWrapper.classList.add('is-landscape', 'landscape');
      uiWrapper.classList.remove('is-portrait', 'simulated-portrait', 'ui-transitioning');
      uiWrapper.style.setProperty('opacity', '1', 'important');
      uiWrapper.style.setProperty('visibility', 'visible', 'important');
      uiWrapper.style.setProperty('pointer-events', 'none', 'important');
      uiWrapper.style.setProperty('overflow', 'visible', 'important');

      if (isNativeLandscape) {
        document.body.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
        uiWrapper.classList.remove('simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', '0', 'important');
        uiWrapper.style.setProperty('width', '100%', 'important');
        uiWrapper.style.setProperty('height', '100%', 'important');
        uiWrapper.style.setProperty('transform', 'none', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
      } else {
        const pw = window.innerWidth;
        const ph = window.innerHeight;

        document.body.classList.add('simulated-landscape', simClass);
        document.body.classList.remove(otherSimClass);
        uiWrapper.classList.add('simulated-landscape', simClass);
        uiWrapper.classList.remove(otherSimClass);

        uiWrapper.style.setProperty('position', 'absolute', 'important');
        uiWrapper.style.setProperty('inset', 'auto', 'important');
        uiWrapper.style.setProperty('width', ph + 'px', 'important');
        uiWrapper.style.setProperty('height', pw + 'px', 'important');
        uiWrapper.style.setProperty('left', '50%', 'important');
        uiWrapper.style.setProperty('top', '50%', 'important');
        uiWrapper.style.setProperty('right', 'auto', 'important');
        uiWrapper.style.setProperty('bottom', 'auto', 'important');
        uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
        uiWrapper.style.setProperty('transform', `translate(-50%, -50%) rotate(${deg}deg)`, 'important');
      }
    }

    // Always make exit button visible during AR
    dom.exitArBtn?.classList.remove('hidden');

    // If dancer placed, unhide placed-only controls
    if (arState.isPlaced) {
      dom.recenterBtn?.classList.remove('hidden');
      dom.infoToggleBtn?.classList.remove('hidden');
      dom.captureBtn?.classList.remove('hidden');
    }

    // ── Apply landscape controls placement inside uiWrapper ──
    // Pass deg so positions mirror correctly for CW vs CCW tilt
    _applyARControlsLandscape(deg);

  } else {
    document.body.classList.add('is-portrait');
    document.body.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');

    // Remove landscape inline pins so portrait CSS takes over
    _unpinARControls();

    if (overlay) {
      overlay.classList.add('is-portrait');
      overlay.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');
      overlay.style.setProperty('position', 'fixed', 'important');
      overlay.style.setProperty('inset', '0', 'important');
      overlay.style.setProperty('width', '100%', 'important');
      overlay.style.setProperty('height', '100%', 'important');
      overlay.style.setProperty('pointer-events', 'none', 'important');
      overlay.style.setProperty('opacity', '1', 'important');
      overlay.style.setProperty('visibility', 'visible', 'important');
      overlay.style.setProperty('overflow', 'hidden', 'important');
    }

    if (uiWrapper) {
      uiWrapper.classList.add('is-portrait');
      uiWrapper.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90', 'ui-transitioning');
      uiWrapper.style.setProperty('position', 'absolute', 'important');
      uiWrapper.style.setProperty('inset', '0', 'important');
      uiWrapper.style.setProperty('width', '100%', 'important');
      uiWrapper.style.setProperty('height', '100%', 'important');
      uiWrapper.style.setProperty('transform', 'none', 'important');
      uiWrapper.style.setProperty('transform-origin', 'center center', 'important');
      uiWrapper.style.setProperty('opacity', '1', 'important');
      uiWrapper.style.setProperty('visibility', 'visible', 'important');
      uiWrapper.style.setProperty('pointer-events', 'none', 'important');
      uiWrapper.style.setProperty('overflow', '', 'important');
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

  const isFirstRun = arState.currentOrientationIsLandscape === null;
  const hasChanged = !isFirstRun && (
    target.isLandscape !== arState.currentOrientationIsLandscape ||
    (target.isLandscape && Math.abs((target.angle || 0) - (arState.currentOrientationState?.angle ?? 0)) > 45)
  );

  if (!isFirstRun && !hasChanged) {
    return;
  }

  // Synchronously update state to prevent any continuous re-trigger loops
  arState.currentOrientationIsLandscape = target.isLandscape;
  arState.currentOrientationState = { isLandscape: target.isLandscape, angle: target.angle };
  arState.isTransitioningOrientation = false;
  arState.pendingOrientationTarget = null;
  if (arState.orientationTransitionTimer) {
    clearTimeout(arState.orientationTransitionTimer);
    arState.orientationTransitionTimer = null;
  }

  const uiWrapper = document.getElementById('ui-wrapper') || dom.uiWrapper;
  if (uiWrapper) {
    uiWrapper.classList.remove('ui-transitioning');
  }

  applyOrientationClasses(target);
}
