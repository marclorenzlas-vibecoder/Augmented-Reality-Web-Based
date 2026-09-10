import './style.css';
import { arState } from './ar/state.js';
import { dom, $ } from './ui/domElements.js';
import { updateUILayout, setupDeviceOrientationListeners } from './ui/orientationController.js';
import { autoDetectKeyModeFromVideo } from './shaders/chromaShader.js';
import { updateVideoBillboardGeometry } from './ar/billboard.js';
import { syncAudioToVideo, pausePositionalAudio, stopPositionalAudio } from './audio/audioController.js';
import { initLocationGateCheck } from './geo/locationGate.js';
import { setupQrGalleryUpload, restartQrCameraSoon } from './scanner/qrScanner.js';
import { setupHistoryDrawer } from './ui/drawer.js';
import { setupCapture } from './ui/captureController.js';
import { repositionDancer, resetArSessionState } from './ar/placementController.js';

// ── Application Initialization ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Initial UI Layout & Orientation Listeners
  updateUILayout();
  setupDeviceOrientationListeners();

  window.addEventListener('resize', () => updateUILayout());
  window.addEventListener('orientationchange', () => updateUILayout());

  if (screen?.orientation) {
    screen.orientation.addEventListener('change', () => {
      if (screen.orientation.type?.startsWith('portrait') || screen.orientation.angle === 0 || screen.orientation.angle === 180) {
        arState.lastDeviceOrientationAngle = 0;
      }
      updateUILayout();
    });
  }

  if (window.matchMedia) {
    window.matchMedia('(orientation: landscape)').addEventListener('change', () => updateUILayout());
  }

  // 2. Setup Dancer Video Element & Video-Audio Synchronizer
  const dancerVideo = dom.dancerVideo || $('dancer-video');
  arState.dancerVideo = dancerVideo;

  if (dancerVideo) {
    dancerVideo.muted = true;
    dancerVideo.playsInline = true;
    dancerVideo.loop = true;
    dancerVideo.crossOrigin = 'anonymous';

    dancerVideo.addEventListener('loadedmetadata', () => {
      updateVideoBillboardGeometry();
      autoDetectKeyModeFromVideo();
      if (arState.videoTex) arState.videoTex.needsUpdate = true;
    });

    dancerVideo.addEventListener('canplay', () => {
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible) {
        if (dancerVideo.paused) {
          dancerVideo.play().catch(() => { });
        }
      } else {
        dancerVideo.pause();
      }
      autoDetectKeyModeFromVideo();
      if (arState.videoTex) arState.videoTex.needsUpdate = true;
    });

    dancerVideo.addEventListener('playing', () => {
      autoDetectKeyModeFromVideo();
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
        syncAudioToVideo(true);
      } else {
        pausePositionalAudio();
      }
    });

    dancerVideo.addEventListener('pause', () => {
      pausePositionalAudio();
    });

    dancerVideo.addEventListener('waiting', () => {
      pausePositionalAudio();
    });

    dancerVideo.addEventListener('stalled', () => {
      pausePositionalAudio();
    });

    dancerVideo.addEventListener('seeking', () => {
      pausePositionalAudio();
    });

    dancerVideo.addEventListener('seeked', () => {
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted && !dancerVideo.paused) {
        syncAudioToVideo(true);
      }
    });

    dancerVideo.addEventListener('ended', () => {
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
        syncAudioToVideo(true);
      }
    });

    let lastVideoSyncTime = 0;
    dancerVideo.addEventListener('timeupdate', () => {
      if (dancerVideo.currentTime < lastVideoSyncTime - 0.25) {
        if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
          syncAudioToVideo(true);
        }
      }
      lastVideoSyncTime = dancerVideo.currentTime;
    });
  }

  // 3. UI Controls container
  const qrControlsContainer = dom.qrControls;
  if (qrControlsContainer) {
    qrControlsContainer.classList.remove('hidden');
  }

  // 4. Setup QR Gallery Input & History Drawer & Snapshot Capture
  setupQrGalleryUpload();
  setupHistoryDrawer();
  setupCapture();

  // 5. Reposition Dancer button
  const recenterBtnEl = dom.recenterBtn;
  const onRecenterTrigger = (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 800;
    repositionDancer();
  };
  recenterBtnEl?.addEventListener('click', onRecenterTrigger);
  recenterBtnEl?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 800;
  });
  recenterBtnEl?.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 800;
  });

  // 6. Exit AR button
  const exitArBtnEl = dom.exitArBtn;
  exitArBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (arState.renderer && arState.renderer.xr && arState.renderer.xr.getSession()) {
        await arState.renderer.xr.getSession().end();
      }
    } catch (err) {
      console.warn('Session already ended or error:', err);
    }
    resetArSessionState();
    dom.uiOverlay?.classList.add('hidden');

    const arBtn = document.getElementById('ARButton');
    if (arBtn && arState.isMediaReady) arBtn.style.display = 'block';
    arState.dancerVideo?.pause();
    stopPositionalAudio();

    dom.infoToggleBtn?.classList.add('hidden');
    dom.captureBtn?.classList.add('hidden');
    dom.recenterBtn?.classList.add('hidden');
    dom.toast?.classList.add('hidden');
  });

  // 7. Geofence & Camera Startup Check (Exclusive to NGC within 500m)
  initLocationGateCheck();
});

// ── Visibility & Focus Handling ────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (arState.dancerVideo) arState.dancerVideo.pause();
    pausePositionalAudio();
  } else {
    if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
      if (arState.dancerVideo) {
        arState.dancerVideo.play().catch(() => {});
      }
      syncAudioToVideo(true);
    }
  }
});
