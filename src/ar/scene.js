import * as THREE from 'three';
import { arState } from './state.js';
import { dom, $ } from '../ui/domElements.js';
import { buildPulsatingFloorGrid } from '../shaders/floorGridShader.js';
import { buildVideoBillboard } from './billboard.js';
import { updateDetectedPlaneGrids } from './planeDetector.js';
import { resetArSessionState, setupPlacementInputListeners, disablePlacementListener } from './placementController.js';
import { setupWebXR, handleSessionEndCleanup } from './webxrManager.js';
import { updateUILayout, getEffectiveOrientation } from '../ui/orientationController.js';
import { executeCaptureFrame } from '../ui/captureController.js';
import { stopPositionalAudio } from '../audio/audioController.js';
import { loadMediaFromQR } from '../media/mediaLoader.js';
import { DEFAULT_MEDIA_URL } from '../config/constants.js';
import { showCircularLoader } from '../ui/loadingBar.js';
import { setToast } from '../ui/toast.js';

export async function launchDirectAR() {
  const urlParams = new URLSearchParams(window.location.search);
  const targetMedia = urlParams.get('media') || urlParams.get('model') || urlParams.get('url') || urlParams.get('qr') || DEFAULT_MEDIA_URL;

  if (dom.qrScreen) dom.qrScreen.classList.add('hidden');

  showCircularLoader();

  if (!arState.isThreeInitialized) {
    initThreeScene();
    arState.isThreeInitialized = true;
  }

  loadMediaFromQR(targetMedia);
  dom.landingScreen?.classList.remove('hidden');
}

export async function startUniversalAR() {
  resetArSessionState();

  if (!arState.isThreeInitialized) {
    initThreeScene();
    arState.isThreeInitialized = true;
  }
}

// Reusable static vectors & throttles to eliminate garbage collection stutter and CPU drain
const _billboardCamPos = new THREE.Vector3();
let _lastOrientSyncTime = 0;

export function initThreeScene() {
  const canvas = dom.arCanvas || $('ar-canvas');

  arState.scene = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  arState.camera = new THREE.PerspectiveCamera(70, aspect, 0.01, 20);
  arState.renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  });
  arState.renderer.setSize(window.innerWidth, window.innerHeight);
  arState.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  arState.renderer.setClearColor(0x000000, 0);

  // Enable WebXR
  arState.renderer.xr.enabled = true;
  arState.renderer.xr.setFramebufferScaleFactor?.(0.8);
  arState.renderer.xr.setFoveation?.(1);

  // Lighting
  arState.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 4, 3);
  arState.scene.add(dir);

  // Setup WebXR & Controller
  setupWebXR(arState.renderer, arState.scene);

  // Pulsating Grid Floor
  arState.floorGridMesh = buildPulsatingFloorGrid();
  arState.floorGridMesh.visible = false;
  arState.scene.add(arState.floorGridMesh);

  // 3D Object / Video Billboard container
  arState.dancerGroup = buildVideoBillboard();
  arState.dancerGroup.visible = false;
  arState.scene.add(arState.dancerGroup);

  // Setup Spatial 3D Audio Listener on Camera
  if (!arState.audioListener) {
    arState.audioListener = new THREE.AudioListener();
    arState.camera.add(arState.audioListener);
  }

  // Setup Positional Audio node attached directly to dancerGroup
  if (!arState.positionalAudio) {
    arState.positionalAudio = new THREE.PositionalAudio(arState.audioListener);
    arState.positionalAudio.setRefDistance(1.5);
    arState.positionalAudio.setMaxDistance(20);
    arState.positionalAudio.setRolloffFactor(1.2);
    arState.positionalAudio.setDistanceModel('inverse');
    arState.positionalAudio.setLoop(true);
    arState.positionalAudio.setVolume(arState.isAudioMuted ? 0 : 1.0);
    arState.dancerGroup.add(arState.positionalAudio);
  }

  if (arState.audioBuffer && (!arState.positionalAudio.buffer || arState.positionalAudio.buffer !== arState.audioBuffer)) {
    try {
      arState.positionalAudio.setBuffer(arState.audioBuffer);
    } catch (err) {
      console.warn('Error setting initial audio buffer:', err);
    }
  }

  // Setup touch & pinch listeners
  setupPlacementInputListeners();
  disablePlacementListener();

  // Render loop using setAnimationLoop for WebXR compatibility
  const clock = new THREE.Clock();

  const renderLoop = (timestamp, frame) => {
    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    if (arState.floorGridMaterial && arState.floorGridMesh?.visible) {
      arState.floorGridMaterial.uniforms.uTime.value = elapsed;
    }

    if (arState.mixer) {
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible) {
        arState.mixer.update(delta);
      }
    }
    if (arState.currentGifPlayer) {
      if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible) {
        arState.currentGifPlayer.update(performance.now());
      }
    }

    // Stop audio if dancer is hidden or AR is not active
    if (!arState.arStarted || !arState.isPlaced || !arState.dancerGroup || !arState.dancerGroup.visible) {
      stopPositionalAudio();
    }

    // Performance optimization: only compute WebXR SLAM hit-tests and plane geometry before the dancer is placed
    if (frame && (!arState.isPlaced || !arState.arStarted)) {
      const referenceSpace = arState.renderer.xr.getReferenceSpace();
      const session = arState.renderer.xr.getSession();

      if (arState.hitTestSourceRequested === false && session) {
        session.requestReferenceSpace('viewer').then((viewerSpace) => {
          session.requestHitTestSource({ space: viewerSpace }).then((source) => {
            arState.hitTestSource = source;
          }).catch(err => console.warn('Hit test source error:', err));
        }).catch(err => console.warn('Viewer space error:', err));

        session.addEventListener('end', async () => {
          handleSessionEndCleanup();
        }, { once: true });

        arState.hitTestSourceRequested = true;
      }

      let currentHitMatrix = null;
      if (arState.hitTestSource) {
        const hitTestResults = frame.getHitTestResults(arState.hitTestSource);

        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          const xrRefSpace = arState.renderer.xr.getReferenceSpace();
          const pose = hit.getPose(xrRefSpace);

          if (pose) {
            currentHitMatrix = Array.from(pose.transform.matrix);
          }
        }
      }

      const hasActivePlaneGrid = updateDetectedPlaneGrids(frame, referenceSpace, currentHitMatrix);
      arState.lastHitPoseMatrix = currentHitMatrix && (!arState.planeDetectionAvailable || hasActivePlaneGrid)
        ? currentHitMatrix
        : null;

      if (!arState.isPlaced) {
        if (hasActivePlaneGrid) {
          if (!arState.isSurfaceDetected) {
            arState.isSurfaceDetected = true;
            setToast('Surface detected! Tap anywhere on grid to place', true);
          }
        } else {
          if (arState.isSurfaceDetected) {
            arState.isSurfaceDetected = false;
            setToast('Point camera at floor and move slowly to scan surface', true);
          }
        }
      }
    }

    if (arState.isPlaced && arState.dancerGroup) {
      if (arState.dancerGroup.userData.baseY !== undefined) {
        arState.dancerGroup.position.y = arState.dancerGroup.userData.baseY;
      }
      if (arState.currentMediaType === 'video' || arState.currentMediaType === 'default' || arState.currentMediaType === 'image') {
        const xrCam = (arState.renderer && arState.renderer.xr && arState.renderer.xr.isPresenting)
          ? arState.renderer.xr.getCamera()
          : arState.camera;
        const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0)
          ? xrCam.cameras[0]
          : (xrCam || arState.camera);
        if (activeCam) {
          activeCam.getWorldPosition(_billboardCamPos);
          const angle = Math.atan2(
            _billboardCamPos.x - arState.dancerGroup.position.x,
            _billboardCamPos.z - arState.dancerGroup.position.z
          );
          arState.dancerGroup.rotation.y = angle;
        }
      } else if (arState.dancerGroup.userData.baseRotY !== undefined) {
        arState.dancerGroup.rotation.y = arState.dancerGroup.userData.baseRotY;
      }
      arState.dancerGroup.rotation.x = 0;
      arState.dancerGroup.rotation.z = 0;
      if (arState.videoMesh) {
        arState.videoMesh.rotation.z = 0;
      }
      if (arState.currentGlbModel) {
        arState.currentGlbModel.rotation.z = 0;
      }
    }

    // Real-time orientation sync in WebXR or Fallback mode (throttled to 10Hz to prevent CPU lag)
    if ((elapsed - _lastOrientSyncTime > 0.1) && (arState.renderer?.xr?.isPresenting || arState.isFallbackMode)) {
      _lastOrientSyncTime = elapsed;
      const orient = getEffectiveOrientation();
      if (
        orient && (
          arState.currentOrientationIsLandscape === null ||
          orient.isLandscape !== arState.currentOrientationIsLandscape ||
          (orient.isLandscape && Math.abs((orient.angle || 0) - (arState.currentOrientationState?.angle ?? 0)) > 45)
        )
      ) {
        updateUILayout(orient);
      }
    }

    // AR Snapshot Capture executing directly in WebXR animation frame
    if (arState.isCaptureRequested && arState.capturePromiseResolver) {
      executeCaptureFrame(frame);
    }

    arState.renderer.render(arState.scene, arState.camera);
  };

  if (arState.renderer && typeof arState.renderer.setAnimationLoop === 'function') {
    arState.renderer.setAnimationLoop(renderLoop);
  } else if (arState.renderer && arState.renderer.xr && typeof arState.renderer.xr.setAnimationLoop === 'function') {
    arState.renderer.xr.setAnimationLoop(renderLoop);
  } else {
    throw new Error('Renderer setAnimationLoop is missing.');
  }

  window.addEventListener('resize', () => {
    updateUILayout();
  });

  if (screen?.orientation) {
    screen.orientation.addEventListener('change', () => {
      arState.lastOrientationAngle = null;
      if (screen.orientation.type?.startsWith('portrait') || screen.orientation.angle === 0 || screen.orientation.angle === 180) {
        arState.lastDeviceOrientationAngle = 0;
      }
      updateUILayout();
    });
  }

  window.addEventListener('orientationchange', () => {
    arState.lastOrientationAngle = null;
    const angle = typeof window.orientation === 'number' ? window.orientation : null;
    if (angle === 0 || angle === 180) {
      arState.lastDeviceOrientationAngle = 0;
    }
    updateUILayout();
  });

  if (window.matchMedia) {
    window.matchMedia('(orientation: landscape)').addEventListener('change', () => {
      updateUILayout();
    });
  }
}
