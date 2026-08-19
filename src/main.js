import './style.css';
import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { Html5Qrcode } from 'html5-qrcode';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseGIF, decompressFrames } from 'gifuct-js';

// ── State ──────────────────────────────────────────────────────────────────
let currentGlbModel  = null;
let mixer            = null;
let gifCanvas        = null;
let gifTexture       = null;
let currentGifPlayer = null;
let isGifMediaType   = false;
const gltfLoader     = new GLTFLoader();

class GifPlayer {
  constructor(arrayBuffer, canvas, texture, onLoad) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.texture = texture;
    this.frames = [];
    this.currentFrameIndex = 0;
    this.nextFrameTime = 0;
    this.isPlaying = false;

    try {
      const parsed = parseGIF(arrayBuffer);
      this.frames = decompressFrames(parsed, true);

      if (this.frames.length > 0) {
        this.canvas.width = parsed.lsd.width;
        this.canvas.height = parsed.lsd.height;
        this.isPlaying = true;
        this.currentFrameIndex = 0;
        this.nextFrameTime = performance.now() + (this.frames[0].delay || 100);
        this.drawFrame(0);
        if (onLoad) onLoad();
      } else {
        throw new Error("No frames found in GIF");
      }
    } catch (err) {
      console.error("Error parsing GIF:", err);
      this.isPlaying = false;
    }
  }

  drawFrame(index) {
    const frame = this.frames[index];
    if (!frame) return;

    if (index === 0 || this.frames[index - 1].disposalType === 2) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    const imgData = new ImageData(frame.patch, frame.dims.width, frame.dims.height);
    this.ctx.putImageData(imgData, frame.dims.left, frame.dims.top);
    this.texture.needsUpdate = true;
  }

  update(now) {
    if (!this.isPlaying || this.frames.length <= 1) return;

    if (now >= this.nextFrameTime) {
      this.currentFrameIndex = (this.currentFrameIndex + 1) % this.frames.length;
      this.drawFrame(this.currentFrameIndex);
      this.nextFrameTime = now + (this.frames[this.currentFrameIndex].delay || 100);
    }
  }

  destroy() {
    this.isPlaying = false;
    this.frames = [];
    if (this.canvas) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
let scene, camera, renderer;
let dancerGroup;
let videoMesh      = null;   // The 2D video billboard
let videoTex       = null;   // Live VideoTexture
let isPlaced       = false;
let isThreeInitialized = false;
let dancerVideo    = null;
let reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let controller;

let currentMediaUrl  = null;
let currentMediaType = 'default'; // 'video' | 'image' | 'default'
let currentTexture   = null;
let isMediaReady     = false;
let mediaLoadToken   = 0;
let currentBlobUrl    = null;

// QR Scanner instance
let html5QrCode      = null;
let availableCameras = [];
let selectedCameraIndex = 0;
let qrCameraTask     = Promise.resolve();
let isQrProcessing   = false;
let activeQrCameraId = null;
let restartQrTimer   = null;

// Chroma Key / Transparency Modes (0 = Opaque, 1 = Green Screen, 2 = Black BG Key)
let currentKeyMode = 2;
const chromaModes = [
  { id: 2, label: 'Key: Black BG' },
  { id: 1, label: 'Key: Green BG' },
  { id: 0, label: 'Key: Off' }
];

const QR_CAMERA_CONFIG = {
  fps: 8,
  qrbox: { width: 220, height: 220 },
  aspectRatio: 1.0
};
const CAMERA_RELEASE_DELAY_MS = 450;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveKnownLocalMedia(text) {
  const normalized = text.trim().replace(/_mp4($|[?#])/i, '.mp4$1');

  if (/MaxwellNB\.mp4($|[?#])/i.test(normalized) || /MaxwellNB/i.test(normalized)) {
    return '/MaxwellNB.mp4';
  }

  if (/Maxwell\.mp4($|[?#])/i.test(normalized) || /Maxwell/i.test(normalized)) {
    return '/Maxwell.mp4';
  }

  return null;
}

const ChromaShader = {
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D map;
    uniform int keyMode;
    uniform vec3 keyColor;
    uniform float similarity;
    uniform float smoothness;
    varying vec2 vUv;

    void main() {
      vec4 texColor = texture2D(map, vUv);
      if (texColor.a < 0.05) {
        discard;
      }

      if (keyMode == 1) {
        // Green Screen Chroma Key
        float Y1 = 0.299 * keyColor.r + 0.587 * keyColor.g + 0.114 * keyColor.b;
        float Cb1 = -0.168736 * keyColor.r - 0.331264 * keyColor.g + 0.5 * keyColor.b;
        float Cr1 = 0.5 * keyColor.r - 0.418688 * keyColor.g - 0.081312 * keyColor.b;

        float Y2 = 0.299 * texColor.r + 0.587 * texColor.g + 0.114 * texColor.b;
        float Cb2 = -0.168736 * texColor.r - 0.331264 * texColor.g + 0.5 * texColor.b;
        float Cr2 = 0.5 * texColor.r - 0.418688 * texColor.g - 0.081312 * texColor.b;

        float dist = distance(vec2(Cb1, Cr1), vec2(Cb2, Cr2));
        if (dist < similarity) {
          discard;
        }
        float alpha = smoothstep(similarity, similarity + smoothness, dist);
        if (alpha < 0.05) discard;
        gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
      } else if (keyMode == 2) {
        // Black background removal (Luminance key)
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        if (luma < 0.12) {
          discard;
        }
        float alpha = smoothstep(0.12, 0.30, luma);
        if (alpha < 0.03) discard;
        gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
      } else {
        gl_FragColor = texColor;
      }
    }
  `
};

function createBillboardMaterial(texture) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      keyMode: { value: currentKeyMode },
      keyColor: { value: new THREE.Color(0x00ff00) },
      similarity: { value: 0.38 },
      smoothness: { value: 0.10 }
    },
    vertexShader: ChromaShader.vertexShader,
    fragmentShader: ChromaShader.fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: false
  });
  material.forceSinglePass = true;
  return material;
}

function setMediaReady(ready) {
  isMediaReady = ready;
  if (videoMesh) {
    videoMesh.visible = ready;
  }
}

function resetCurrentTexture() {
  if (currentTexture) {
    currentTexture.dispose();
    currentTexture = null;
  }

  if (gifTexture) {
    gifTexture.dispose();
    gifTexture = null;
  }

  if (currentGifPlayer) {
    currentGifPlayer.destroy();
    currentGifPlayer = null;
  }
  gifCanvas = null;
  isGifMediaType = false;

  if (currentGlbModel) {
    dancerGroup.remove(currentGlbModel);
    currentGlbModel = null;
  }
  mixer = null;

  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

// ── UI References ──────────────────────────────────────────────────────────
function markVideoReady(loadToken) {
  if (loadToken !== mediaLoadToken || isMediaReady) return;

  applyVideoToBillboard();
  setMediaReady(true);
  dancerVideo.play().catch(() => {});
  setToast('Video ready! Aim and tap to place');
}

function describeVideoError() {
  const mediaError = dancerVideo?.error;
  if (!mediaError) return 'Unknown video load error';

  const messages = {
    1: 'Video loading was aborted',
    2: 'Network error while loading video',
    3: 'Video decode error',
    4: 'Video format is not supported by this browser'
  };

  return messages[mediaError.code] || `Video error ${mediaError.code}`;
}

function hasDecodedVideoFrame() {
  return !!(
    dancerVideo &&
    dancerVideo.videoWidth > 0 &&
    dancerVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

async function loadVideoViaBlob(url, loadToken) {
  if (loadToken !== mediaLoadToken || isMediaReady) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    setToast(`Fetching video: ${url}`, true);
    const response = await fetch(url, {
      cache: 'reload',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();
    if (loadToken !== mediaLoadToken || isMediaReady) return;

    if (blob.type && (blob.type.startsWith('text/') || blob.type.startsWith('application/json'))) {
      throw new Error(`Unexpected media type: ${blob.type}`);
    }

    setToast(`Video fetched: ${Math.round(blob.size / 1024)} KB`, true);
    currentBlobUrl = URL.createObjectURL(blob);
    loadVideoMedia(currentBlobUrl, loadToken, { allowBlobFallback: false });
  } catch (err) {
    clearTimeout(timeoutId);
    if (loadToken !== mediaLoadToken || isMediaReady) return;
    console.warn('Video blob fallback failed:', err);
    setToast(`Direct video still loading; fetch fallback failed: ${err.name === 'AbortError' ? 'request timed out' : (err.message || err)}`, true);
  }
}

function loadVideoMedia(url, loadToken, { allowBlobFallback = true } = {}) {
  if (!dancerVideo) return;

  let timeoutId = null;
  let fallbackId = null;
  const cleanup = () => {
    clearTimeout(timeoutId);
    clearTimeout(fallbackId);
    dancerVideo.removeEventListener('loadedmetadata', onReady);
    dancerVideo.removeEventListener('loadeddata', onReady);
    dancerVideo.removeEventListener('canplay', onReady);
    dancerVideo.removeEventListener('playing', onReady);
    dancerVideo.removeEventListener('error', onError);
  };

  const readyStateCheck = () => {
    if (loadToken !== mediaLoadToken) {
      cleanup();
      return;
    }

    if (hasDecodedVideoFrame()) {
      cleanup();
      markVideoReady(loadToken);
    }
  };

  const onReady = () => {
    if (loadToken !== mediaLoadToken) {
      cleanup();
      return;
    }

    if (hasDecodedVideoFrame()) {
      cleanup();
      markVideoReady(loadToken);
    }
  };

  const onError = () => {
    if (loadToken !== mediaLoadToken) {
      cleanup();
      return;
    }

    cleanup();
    console.warn('Video load error:', describeVideoError());

    if (allowBlobFallback) {
      loadVideoViaBlob(url, loadToken);
    } else {
      setToast(`Could not decode video: ${describeVideoError()}`, true);
    }
  };

  dancerVideo.pause();
  dancerVideo.crossOrigin = 'anonymous';
  dancerVideo.muted = true;
  dancerVideo.loop = true;
  dancerVideo.playsInline = true;
  dancerVideo.preload = 'auto';

  dancerVideo.addEventListener('loadedmetadata', onReady);
  dancerVideo.addEventListener('loadeddata', onReady);
  dancerVideo.addEventListener('canplay', onReady);
  dancerVideo.addEventListener('playing', onReady);
  dancerVideo.addEventListener('error', onError);

  dancerVideo.src = url;
  dancerVideo.load();
  dancerVideo.play().catch(() => {});

  if ('requestVideoFrameCallback' in dancerVideo) {
    dancerVideo.requestVideoFrameCallback(() => {
      readyStateCheck();
    });
  }

  setTimeout(readyStateCheck, 0);
  setTimeout(readyStateCheck, 250);

  fallbackId = setTimeout(() => {
    if (!allowBlobFallback || loadToken !== mediaLoadToken || isMediaReady) return;
    loadVideoViaBlob(url, loadToken);
    setTimeout(readyStateCheck, 1000);
  }, 3000);

  timeoutId = setTimeout(() => {
    if (loadToken !== mediaLoadToken || isMediaReady) return;
    cleanup();
    setToast(`Video still loading: ${currentMediaUrl || url}`, true);
  }, 8000);
}

const $ = (id) => document.getElementById(id);
const uiOverlayEl     = $('ui-overlay');
const qrScreenEl      = $('qr-screen');
const qrControlsEl    = $('qr-controls-container');
const qrStatusTextEl  = $('qr-status-text');
const toastEl         = $('toast');
const infoToggleBtnEl = $('info-toggle-btn');
const captureBtnEl    = $('capture-btn');
const recenterBtnEl   = $('recenter-btn');
const historyModalEl  = $('history-modal');
const closeHistoryBtn = $('close-history-btn');
const startCameraBtn  = $('start-camera-btn');
const qrSwitchBtn     = $('qr-switch-btn');
const cameraSelectEl  = $('qr-camera-select');
const cameraErrorEl   = $('camera-error-msg');
const exitArBtnEl     = $('exit-ar-btn');
const chromaBtnEl     = $('chroma-btn');


// ── Phase 1 : Direct QR Scanner (No Injected UI Widget) ────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  dancerVideo = $('dancer-video');
  if (dancerVideo) {
    dancerVideo.muted = true;
    dancerVideo.playsInline = true;
    dancerVideo.loop = true;
    dancerVideo.crossOrigin = 'anonymous';

    dancerVideo.addEventListener('loadedmetadata', () => {
      updateVideoBillboardGeometry();
      if (videoTex) videoTex.needsUpdate = true;
    });

    dancerVideo.addEventListener('canplay', () => {
      if (dancerVideo.paused) {
        dancerVideo.play().catch(() => {});
      }
      if (videoTex) videoTex.needsUpdate = true;
    });
  }

  const startCamBtn = $('start-camera-btn');
  const qrControlsContainer = $('qr-controls-container');

  if (startCamBtn) {
    startCamBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      startCamBtn.classList.add('hidden');
      if (qrControlsContainer) qrControlsContainer.classList.remove('hidden');
      await initCustomQrScanner();
    });
  }

  // History drawer toggles
  infoToggleBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    historyModalEl.classList.remove('hidden');
  });

  closeHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    historyModalEl.classList.add('hidden');
  });

  // Reposition
  recenterBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    repositionDancer();
  });

  // Chroma Key / Transparency toggle
  let modeIndex = 0;
  chromaBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    modeIndex = (modeIndex + 1) % chromaModes.length;
    const selected = chromaModes[modeIndex];
    currentKeyMode = selected.id;
    if (chromaBtnEl) chromaBtnEl.textContent = selected.label;
    if (videoMesh && videoMesh.material && videoMesh.material.uniforms) {
      videoMesh.material.uniforms.keyMode.value = currentKeyMode;
      videoMesh.material.needsUpdate = true;
    }
    setToast(`Applied ${selected.label}`);
  });

  // Exit AR
  const exitArBtnEl = $('exit-ar-btn');
  exitArBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (renderer && renderer.xr && renderer.xr.getSession()) {
        await renderer.xr.getSession().end();
      }
    } catch (err) {
      console.warn("Session already ended or error:", err);
    }
    uiOverlayEl?.classList.add('hidden');
    qrScreenEl?.classList.remove('hidden');
    
    // Hide the ARButton injected by Three.js
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';
    dancerVideo?.pause();

    // Reset all buttons to hidden state
    infoToggleBtnEl?.classList.add('hidden');
    captureBtnEl?.classList.add('hidden');
    recenterBtnEl?.classList.add('hidden');
    chromaBtnEl?.classList.add('hidden');
    toastEl?.classList.add('hidden');

    restartQrCameraSoon();
  });

  setupCapture();
});

async function initCustomQrScanner() {
  try {
    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode("qr-reader");
    }

    // Fetch cameras
    const devices = await Html5Qrcode.getCameras();
    if (!devices || devices.length === 0) {
      if (qrStatusTextEl) qrStatusTextEl.textContent = 'No camera found';
      return;
    }

    availableCameras = devices;

    // Populate custom camera dropdown
    if (cameraSelectEl) {
      cameraSelectEl.innerHTML = '';
      devices.forEach((dev, idx) => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = dev.label || `Camera ${idx + 1}`;
        cameraSelectEl.appendChild(opt);
      });

      cameraSelectEl.addEventListener('change', async (e) => {
        const devId = e.target.value;
        selectedCameraIndex = availableCameras.findIndex(d => d.id === devId);
        await switchQrCamera(devId);
      });
    }

    // Camera Switch button
    if (qrSwitchBtn) {
      if (devices.length <= 1) {
        qrSwitchBtn.style.display = 'none';
      } else {
        qrSwitchBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          selectedCameraIndex = (selectedCameraIndex + 1) % availableCameras.length;
          const nextDevId = availableCameras[selectedCameraIndex].id;
          if (cameraSelectEl) cameraSelectEl.value = nextDevId;
          await switchQrCamera(nextDevId);
        });
      }
    }

    // Default to rear/environment camera
    const backCamIndex = devices.findIndex(d => /back|rear|environment/i.test(d.label));
    selectedCameraIndex = backCamIndex !== -1 ? backCamIndex : 0;
    const initialCamId = devices[selectedCameraIndex].id;
    if (cameraSelectEl) cameraSelectEl.value = initialCamId;

    // Start scanner automatically
    await startQrCamera(initialCamId);

  } catch (err) {
    console.error('QR Scanner init error:', err);
    if (cameraErrorEl) {
      cameraErrorEl.textContent = `Camera Error: ${err.message || err}. (Try fully closing other apps that use the camera)`;
      cameraErrorEl.classList.remove('hidden');
    }
  }
}

function queueQrCameraTask(task) {
  qrCameraTask = qrCameraTask.catch(() => {}).then(task);
  return qrCameraTask;
}

function clearQrRestartTimer() {
  if (restartQrTimer) {
    clearTimeout(restartQrTimer);
    restartQrTimer = null;
  }
}

async function stopQrCameraInternal({ clear = false } = {}) {
  if (!html5QrCode) return;

  if (html5QrCode.isScanning) {
    try {
      await html5QrCode.stop();
    } catch (err) {
      console.warn('QR camera stop skipped:', err);
      await wait(250);
    }
  }

  activeQrCameraId = null;

  if (clear) {
    try {
      html5QrCode.clear();
    } catch (err) {
      console.warn('QR clear skipped:', err);
    }
  }
}

async function startQrCameraInternal(cameraId) {
  if (!html5QrCode || isQrProcessing) return;
  if (html5QrCode.isScanning && activeQrCameraId === cameraId) return;

  clearQrRestartTimer();

  if (html5QrCode.isScanning) {
    await stopQrCameraInternal();
    await wait(150);
  }

  try {
    await html5QrCode.start(
      cameraId,
      QR_CAMERA_CONFIG,
      onQrCodeSuccess,
      () => {}
    );
    activeQrCameraId = cameraId;
    cameraErrorEl?.classList.add('hidden');
    if (qrStatusTextEl) qrStatusTextEl.textContent = 'Align QR code in frame';
  } catch (err) {
    console.warn('Could not start specific camera ID, trying facingMode environment fallback:', err);
    await wait(150);

    try {
      await html5QrCode.start(
        { facingMode: "environment" },
        QR_CAMERA_CONFIG,
        onQrCodeSuccess,
        () => {}
      );
      activeQrCameraId = 'environment';
      cameraErrorEl?.classList.add('hidden');
      if (qrStatusTextEl) qrStatusTextEl.textContent = 'Align QR code in frame';
    } catch (e) {
      activeQrCameraId = null;
      console.error('Camera fallback failed:', e);
      if (cameraErrorEl) {
        cameraErrorEl.textContent = `Failed to start camera: ${e.message || e}`;
        cameraErrorEl.classList.remove('hidden');
      }
    }
  }
}

async function startQrCamera(cameraId) {
  return queueQrCameraTask(() => startQrCameraInternal(cameraId));
}

async function switchQrCamera(cameraId) {
  return queueQrCameraTask(async () => {
    if (!html5QrCode || !cameraId) return;
    await stopQrCameraInternal();
    await wait(150);
    await startQrCameraInternal(cameraId);
  });
}

function restartQrCameraSoon() {
  clearQrRestartTimer();
  if (!availableCameras.length) return;

  restartQrTimer = setTimeout(() => {
    isQrProcessing = false;
    startQrCamera(availableCameras[selectedCameraIndex].id);
  }, 900);
}

// ── When QR Code is Scanned : Direct Instant Launch to AR ──────────────────
async function onQrCodeSuccess(decodedText) {
  if (isQrProcessing) return;
  isQrProcessing = true;
  clearQrRestartTimer();

  // 1. Stop QR scanner stream immediately
  try {
    await queueQrCameraTask(() => stopQrCameraInternal({ clear: true }));
    await wait(CAMERA_RELEASE_DELAY_MS);
  } catch (err) {
    console.warn('QR stop error:', err);
  }

  // 2. Extract media (GIF / Video / Image) from QR
  if (decodedText) {
    loadMediaFromQR(decodedText);
  }

  // 3. Hide QR screen
  if (qrScreenEl) qrScreenEl.classList.add('hidden');

  // 4. DIRECTLY Launch AR Camera & 3D scene (No intermediate clicks!)
  try {
    await startUniversalAR();
    uiOverlayEl?.classList.remove('hidden');
  } catch (err) {
    console.error('AR Camera Launch Error:', err);
    isQrProcessing = false;
    uiOverlayEl?.classList.add('hidden');
    qrScreenEl?.classList.remove('hidden');
    restartQrCameraSoon();
    setToast('Failed to launch AR: ' + err.message, true);
  }
}


// ── Phase 2 : Camera & Three.js AR Engine ──────────────────────────────────
async function startUniversalAR() {
  if (dancerVideo) {
    dancerVideo.play().catch(() => {});
  }

  if (!isThreeInitialized) {
    initThreeScene();
    isThreeInitialized = true;
  }
  
  // Ensure the ARButton injected by Three.js is visible now
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'block';
}

function initThreeScene() {
  const canvas = $('ar-canvas');

  scene    = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  camera   = new THREE.PerspectiveCamera(70, aspect, 0.01, 20);
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

  // Enable WebXR
  renderer.xr.enabled = true;
  renderer.xr.setFramebufferScaleFactor?.(0.8);
  renderer.xr.setFoveation?.(1);
  
  // Create an AR Button that triggers the WebXR session
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.getElementById('ui-overlay') }
  };
  const arButton = ARButton.createButton(renderer, sessionInit);
  document.body.appendChild(arButton);

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  // WebXR Hit-Test Reticle
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xd4b483 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Controller for select (tap to place)
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  // 2D Video / GIF Billboard (hidden until placed)
  dancerGroup = buildVideoBillboard();
  dancerGroup.visible = false;
  scene.add(dancerGroup);

  // Render loop using setAnimationLoop for WebXR compatibility
  const clock = new THREE.Clock();

  const renderLoop = (timestamp, frame) => {
    const delta = clock.getDelta();
    if (mixer) {
      mixer.update(delta);
    }
    if (currentGifPlayer) {
      currentGifPlayer.update(performance.now());
    }

    if (frame) {
      const referenceSpace = renderer.xr.getReferenceSpace();
      const session = renderer.xr.getSession();

      if (hitTestSourceRequested === false) {
        session.requestReferenceSpace('viewer').then((referenceSpace) => {
          session.requestHitTestSource({ space: referenceSpace }).then((source) => {
            hitTestSource = source;
          });
        });

        session.addEventListener('end', async () => {
          hitTestSourceRequested = false;
          hitTestSource = null;
          isPlaced = false;
          if (reticle) reticle.visible = false;
          if (dancerGroup) dancerGroup.visible = false;
          
          // Reset UI
          uiOverlayEl?.classList.add('hidden');
          qrScreenEl?.classList.remove('hidden');
          const arBtn = document.getElementById('ARButton');
          if (arBtn) arBtn.style.display = 'none';
          dancerVideo?.pause();
          
          // Reset all AR buttons to hidden state
          infoToggleBtnEl?.classList.add('hidden');
          captureBtnEl?.classList.add('hidden');
          recenterBtnEl?.classList.add('hidden');
          chromaBtnEl?.classList.add('hidden');
          toastEl?.classList.add('hidden');

          restartQrCameraSoon();
        });

        hitTestSourceRequested = true;
      }

      if (hitTestSource) {
        const hitTestResults = frame.getHitTestResults(hitTestSource);

        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          const pose = hit.getPose(referenceSpace);

          // Only show reticle if we haven't placed the dancer yet
          if (!isPlaced) {
            reticle.visible = true;
            reticle.matrix.fromArray(pose.transform.matrix);
          } else {
            reticle.visible = false;
          }
        } else {
          reticle.visible = false;
        }
      }
    }

    if (isPlaced) {
      const t = clock.getElapsedTime();
      const dt = t * 3.5;
      dancerGroup.position.y = (dancerGroup.userData.baseY || 0) + Math.abs(Math.sin(dt)) * PLACEMENT_FLOAT_AMPLITUDE;
      dancerGroup.rotation.y = (dancerGroup.userData.baseRotY || 0) + Math.sin(t * 2) * 0.18;
      dancerGroup.rotation.z = Math.sin(dt) * 0.04;
    }

    renderer.render(scene, camera);
  };

  // Safely start the animation loop, handling newer and older Three.js versions
  if (renderer && typeof renderer.setAnimationLoop === 'function') {
    renderer.setAnimationLoop(renderLoop);
  } else if (renderer && renderer.xr && typeof renderer.xr.setAnimationLoop === 'function') {
    renderer.xr.setAnimationLoop(renderLoop);
  } else {
    // If we get here, something is very wrong with the renderer object
    const rendererType = typeof renderer;
    const isRendererUndefined = renderer === undefined;
    const hasXR = renderer ? !!renderer.xr : false;
    throw new Error(`Renderer is broken. Type: ${rendererType}, Undefined: ${isRendererUndefined}, HasXR: ${hasXR}. setAnimationLoop is missing.`);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}


// ── Resolve and Format Media URLs (Google Drive, Dropbox, etc.) ────────────
function resolveMediaUrl(raw) {
  if (!raw) return '';
  let url = raw.trim();

  if (url.startsWith('www.')) {
    url = 'https://' + url;
  }

  const knownLocalMedia = resolveKnownLocalMedia(url);

  if (knownLocalMedia) {
    return knownLocalMedia;
  }

  try {
    const parsedUrl = new URL(url, window.location.href);
    const isMediaPath = /\.(mp4|webm|mov|ogg|m4v|jpg|jpeg|png|webp|gif)($|\?)/i.test(parsedUrl.pathname);
    const isViteDevMedia = parsedUrl.port === '5173' || parsedUrl.origin === window.location.origin;

    if (isViteDevMedia && isMediaPath) {
      return parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;
    }
  } catch {
    // Leave non-URL QR payloads unchanged.
  }

  // Handle Google Drive links
  const gDriveMatch = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]+)/);
  if (gDriveMatch && gDriveMatch[1]) {
    return `https://drive.google.com/uc?export=download&id=${gDriveMatch[1]}`;
  }

  // Handle Dropbox links
  if (url.includes('dropbox.com')) {
    return url.replace('dl=0', 'raw=1').replace('?dl=0', '?raw=1');
  }

  // Handle Imgur gifv
  if (url.includes('imgur.com') && url.endsWith('.gifv')) {
    return url.replace('.gifv', '.mp4');
  }

  return url;
}

// ── Load GIF / Video / Image from Scanned QR Code ──────────────────────────
async function loadMediaFromQR(text) {
  if (!text) return;
  const resolvedUrl = resolveMediaUrl(text);
  if (!resolvedUrl) return;

  const loadToken = ++mediaLoadToken;
  setMediaReady(false);
  resetCurrentTexture();
  currentMediaUrl = resolvedUrl;

  const isLocal = resolvedUrl.startsWith('/') || 
                  resolvedUrl.startsWith('./') || 
                  resolvedUrl.startsWith('../') ||
                  resolvedUrl.startsWith(window.location.origin);

  const isUrl = resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://') || isLocal;

  if (!isUrl) {
    // Non-URL raw payload
    currentMediaType = 'video';
    loadVideoMedia(resolvedUrl, loadToken);
    return;
  }

  // If local, we can try direct video/image detection by file extension without fetch
  if (isLocal) {
    const isImage = /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(resolvedUrl);
    if (isImage) {
      tryLoadImage(resolvedUrl, loadToken);
    } else {
      currentMediaType = 'video';
      loadVideoMedia(resolvedUrl, loadToken);
    }
    return;
  }

  setToast(`Fetching media: ${resolvedUrl}`, true);

  let response = null;
  let errorMsg = '';

  // Tier 1: Try fetching directly
  try {
    response = await fetch(resolvedUrl);
  } catch (err) {
    console.warn('Direct fetch failed, trying CORS proxy:', err);
    errorMsg = err.message || err;
  }

  // Tier 2: Try fetching via corsproxy.io if direct fetch failed
  if (!response || !response.ok) {
    try {
      const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(resolvedUrl);
      response = await fetch(proxyUrl);
    } catch (err) {
      console.warn('CORS proxy fetch failed, trying backup proxy:', err);
      errorMsg = err.message || err;
    }
  }

  // Tier 3: Try fetching via allorigins as backup proxy if primary proxy failed
  if (!response || !response.ok) {
    try {
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(resolvedUrl);
      response = await fetch(proxyUrl);
    } catch (err) {
      console.warn('Backup proxy fetch failed:', err);
      errorMsg = err.message || err;
    }
  }

  // If response is successful, process the blob
  if (response && response.ok) {
    try {
      const blob = await response.blob();
      const contentType = blob.type || response.headers.get('Content-Type') || '';
      
      const isGlb = contentType.startsWith('model/') || 
                    contentType.includes('gltf') || 
                    /\.(glb|gltf)($|\?)/i.test(resolvedUrl);
      const isGif = contentType.includes('gif') || /\.(gif)($|\?)/i.test(resolvedUrl);
      const isImage = contentType.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(resolvedUrl);
      const isVideo = contentType.startsWith('video/') || /\.(mp4|webm|mov|ogg|m4v)($|\?)/i.test(resolvedUrl);

      currentBlobUrl = URL.createObjectURL(blob);

      if (isGlb) {
        tryLoadGlb(currentBlobUrl, loadToken);
      } else if (isGif) {
        const buffer = await blob.arrayBuffer();
        tryLoadGif(buffer, loadToken);
      } else if (isImage && !isVideo) {
        tryLoadImage(currentBlobUrl, loadToken);
      } else {
        currentMediaType = 'video';
        loadVideoMedia(currentBlobUrl, loadToken, { allowBlobFallback: false });
      }
      return;
    } catch (err) {
      console.error('Failed to process media blob:', err);
      errorMsg = err.message || err;
    }
  }

  // Fallback to direct element loading if all fetches failed
  console.warn('All fetch attempts failed. Trying direct loading fallback. Error:', errorMsg);
  setToast('Fetch failed. Trying direct load fallback...', true);

  const isExplicitImage = /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(resolvedUrl);
  if (isExplicitImage) {
    const isExplicitGif = /\.(gif)($|\?)/i.test(resolvedUrl);
    if (isExplicitGif) {
      tryLoadGif(resolvedUrl, loadToken);
    } else {
      tryLoadImage(resolvedUrl, loadToken);
    }
  } else {
    const isExplicitGlb = /\.(glb|gltf)($|\?)/i.test(resolvedUrl);
    if (isExplicitGlb) {
      tryLoadGlb(resolvedUrl, loadToken);
    } else {
      currentMediaType = 'video';
      loadVideoMedia(resolvedUrl, loadToken);
    }
  }
}

async function tryLoadGif(urlOrBuffer, loadToken = ++mediaLoadToken) {
  currentMediaType = 'image';
  isGifMediaType = true;
  setMediaReady(false);

  // Clean up any existing GLB
  if (currentGlbModel) {
    dancerGroup.remove(currentGlbModel);
    currentGlbModel = null;
  }
  mixer = null;

  if (currentGifPlayer) {
    currentGifPlayer.destroy();
    currentGifPlayer = null;
  }
  gifCanvas = null;

  if (videoMesh) {
    videoMesh.visible = false;
  }

  let buffer;
  if (typeof urlOrBuffer === 'string') {
    try {
      setToast('Fetching GIF data...', true);
      buffer = await fetch(urlOrBuffer).then(res => res.arrayBuffer());
    } catch (err) {
      console.warn("Failed to fetch GIF buffer directly:", err);
      try {
        const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(urlOrBuffer);
        buffer = await fetch(proxyUrl).then(res => res.arrayBuffer());
      } catch (proxyErr) {
        console.error("GIF buffer fetch failed entirely:", proxyErr);
        setToast("Failed to load GIF.");
        return;
      }
    }
  } else {
    buffer = urlOrBuffer;
  }

  if (loadToken !== mediaLoadToken) return;

  // Create canvas and canvas texture
  gifCanvas = document.createElement('canvas');
  gifTexture = new THREE.CanvasTexture(gifCanvas);
  gifTexture.minFilter = THREE.LinearFilter;
  gifTexture.magFilter = THREE.LinearFilter;
  gifTexture.colorSpace = THREE.SRGBColorSpace;

  currentGifPlayer = new GifPlayer(buffer, gifCanvas, gifTexture, () => {
    if (loadToken !== mediaLoadToken) {
      if (currentGifPlayer) {
        currentGifPlayer.destroy();
        currentGifPlayer = null;
      }
      return;
    }

    currentTexture = gifTexture;
    applyTextureToBillboard(gifTexture);

    // Disable chroma key for GIFs — they have their own transparency;
    // the black-BG shader would incorrectly strip dark content.
    if (videoMesh && videoMesh.material && videoMesh.material.uniforms) {
      videoMesh.material.uniforms.keyMode.value = 0;
      videoMesh.material.needsUpdate = true;
    }

    setMediaReady(true);
    setToast('GIF ready! Aim and tap to place');
  });
}

function tryLoadGlb(url, loadToken = ++mediaLoadToken) {
  currentMediaType = '3d';
  setMediaReady(false);

  // Clean up previous GLB
  if (currentGlbModel) {
    dancerGroup.remove(currentGlbModel);
    currentGlbModel = null;
  }
  mixer = null;

  // Hide 2D billboard
  if (videoMesh) {
    videoMesh.visible = false;
  }

  setToast('Loading 3D model...', true);

  gltfLoader.load(
    url,
    (gltf) => {
      if (loadToken !== mediaLoadToken) {
        return;
      }

      const model = gltf.scene;

      // Auto-scale and center
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const height = size.y || 1;

      const targetHeight = 1.2;
      const scale = targetHeight / height;
      model.scale.set(scale, scale, scale);

      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

      // Play skeletal animation if any clips are present
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(gltf.animations[0]);
        action.play();
      }

      currentGlbModel = model;
      dancerGroup.add(model);

      setMediaReady(true);
      setToast('3D model ready! Aim and tap to place');
    },
    (xhr) => {
      if (loadToken !== mediaLoadToken) return;
      if (xhr.total) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        setToast(`Loading 3D model: ${percent}%`, true);
      }
    },
    (err) => {
      if (loadToken !== mediaLoadToken) return;
      console.error('GLB load error:', err);
      setToast('Failed to load 3D model. Trying direct load fallback...', true);
    }
  );
}

function tryLoadImage(url, loadToken = ++mediaLoadToken) {
  currentMediaType = 'image';
  setMediaReady(false);
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    url,
    (tex) => {
      if (loadToken !== mediaLoadToken) {
        tex.dispose();
        return;
      }
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      currentTexture = tex;
      applyTextureToBillboard(tex);
      setMediaReady(true);
      setToast('Media ready! Aim and tap to place');
    },
    undefined,
    (err) => {
      if (loadToken !== mediaLoadToken) return;
      console.warn('Image load error:', err);
      setToast('QR scanned. Aim and tap to place');
    }
  );
}

const VIDEO_ASPECT = 9 / 16;
const BILLBOARD_HEIGHT = 1.4;
const PLACEMENT_FLOAT_AMPLITUDE = 0.04;

function applyVideoToBillboard() {
  if (currentGlbModel) {
    dancerGroup.remove(currentGlbModel);
    currentGlbModel = null;
  }
  mixer = null;
  if (videoMesh) {
    videoMesh.visible = isMediaReady;
  }

  if (!dancerVideo) return;

  if (videoTex) {
    videoTex.dispose();
  }

  videoTex = new THREE.VideoTexture(dancerVideo);
  videoTex.minFilter = THREE.LinearFilter;
  videoTex.magFilter = THREE.LinearFilter;
  videoTex.generateMipmaps = false;
  videoTex.colorSpace = THREE.SRGBColorSpace;

  if (videoMesh) {
    if (videoMesh.material) videoMesh.material.dispose();
    videoMesh.material = createBillboardMaterial(videoTex);
    videoMesh.material.needsUpdate = true;
    updateVideoBillboardGeometry();
  }
}

function updateVideoBillboardGeometry() {
  if (!videoMesh || !dancerVideo) return;
  const vw = dancerVideo.videoWidth || 720;
  const vh = dancerVideo.videoHeight || 1280;
  const aspect = (vw && vh) ? (vw / vh) : VIDEO_ASPECT;
  const h = BILLBOARD_HEIGHT;
  const w = h * aspect;

  if (videoMesh.geometry) {
    videoMesh.geometry.dispose();
  }
  videoMesh.geometry = new THREE.PlaneGeometry(w, h);
  videoMesh.position.set(0, h / 2, 0);
}

function applyTextureToBillboard(tex) {
  if (currentGlbModel) {
    dancerGroup.remove(currentGlbModel);
    currentGlbModel = null;
  }
  mixer = null;
  if (videoMesh) {
    videoMesh.visible = isMediaReady;
  }

  if (!videoMesh) return;
  
  if (videoMesh.material) videoMesh.material.dispose();
  videoMesh.material = createBillboardMaterial(tex);
  videoMesh.material.needsUpdate = true;

  const aspect = (tex.image && tex.image.width && tex.image.height) 
    ? (tex.image.width / tex.image.height) 
    : VIDEO_ASPECT;
  const h = BILLBOARD_HEIGHT;
  const w = h * aspect;

  if (videoMesh.geometry) videoMesh.geometry.dispose();
  videoMesh.geometry = new THREE.PlaneGeometry(w, h);
  videoMesh.position.set(0, h / 2, 0);
}

function buildVideoBillboard() {
  const group = new THREE.Group();

  let mat;
  let aspect = VIDEO_ASPECT;

  if (currentTexture) {
    mat = createBillboardMaterial(currentTexture);
    if (currentTexture.image && currentTexture.image.width && currentTexture.image.height) {
      aspect = currentTexture.image.width / currentTexture.image.height;
    }
  } else {
    if (videoTex) {
      videoTex.dispose();
    }
    videoTex = new THREE.VideoTexture(dancerVideo);
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.magFilter = THREE.LinearFilter;
    videoTex.generateMipmaps = false;
    videoTex.colorSpace = THREE.SRGBColorSpace;

    mat = createBillboardMaterial(videoTex);

    const vw = (dancerVideo && dancerVideo.videoWidth) ? dancerVideo.videoWidth : 720;
    const vh = (dancerVideo && dancerVideo.videoHeight) ? dancerVideo.videoHeight : 1280;
    aspect = (vw && vh) ? (vw / vh) : VIDEO_ASPECT;
  }

  const w = BILLBOARD_HEIGHT * aspect;
  videoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, BILLBOARD_HEIGHT),
    mat
  );

  videoMesh.visible = isMediaReady;
  videoMesh.position.set(0, BILLBOARD_HEIGHT / 2, 0);
  group.add(videoMesh);
  return group;
}

function buildParticles() {
  const N   = 36;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);

  const palette = [
    new THREE.Color('#d4b483'),
    new THREE.Color('#e8c98a'),
    new THREE.Color('#a87b48'),
    new THREE.Color('#ffffff'),
  ];

  for (let i = 0; i < N; i++) {
    pos[i*3]     = (Math.random() - 0.5) * 2.2;
    pos[i*3 + 1] = Math.random() * 1.6 - 0.3;
    pos[i*3 + 2] = (Math.random() - 0.5) * 2.2;
    const c = palette[i % palette.length];
    col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.035, vertexColors: true, transparent: true, opacity: 0.6
  }));
}


// ── WebXR Hit-Test Tap to Place & Reposition ──────────────────────────────────
function onSelect() {
  if (isPlaced) return;

  if (!isMediaReady && hasDecodedVideoFrame()) {
    markVideoReady(mediaLoadToken);
  }

  if (!isMediaReady) {
    const readyState = dancerVideo ? dancerVideo.readyState : 'no video';
    setToast(`Media is still loading (${readyState}): ${currentMediaUrl || 'no QR media'}`, true);
    return;
  }

  if (reticle && reticle.visible) {
    if (dancerVideo && dancerVideo.paused) {
      dancerVideo.play().catch(() => {});
    }
    
    dancerGroup.position.setFromMatrixPosition(reticle.matrix);
    dancerGroup.userData.baseY = dancerGroup.position.y;

    const cameraWorldPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraWorldPosition);

    const angle = Math.atan2(
      cameraWorldPosition.x - dancerGroup.position.x,
      cameraWorldPosition.z - dancerGroup.position.z
    );
    dancerGroup.userData.baseRotY = angle;
    dancerGroup.rotation.set(0, angle, 0);
    
    placeDancer();
  } else {
    setToast('Please point at a flat surface to place');
  }
}

function placeDancer() {
  isPlaced = true;
  dancerGroup.visible = true;

  if (reticle) reticle.visible = false;

  dancerVideo?.play().catch(() => {});

  setToast('Anchor placed'); // Show bottom UI
  setTimeout(() => {
    toastEl?.classList.add('hidden');
    infoToggleBtnEl?.classList.remove('hidden');
    captureBtnEl?.classList.remove('hidden');
    recenterBtnEl?.classList.remove('hidden');
    chromaBtnEl?.classList.remove('hidden');
  }, 1500);
}

function repositionDancer() {
  isPlaced = false;
  dancerGroup.visible = false;

  historyModalEl?.classList.add('hidden');
  infoToggleBtnEl?.classList.add('hidden');
  captureBtnEl?.classList.add('hidden');
  recenterBtnEl?.classList.add('hidden');
  chromaBtnEl?.classList.add('hidden');

  setToast('Aim at a flat surface and tap to place the dancer');
}


// ── Snapshot & Share ───────────────────────────────────────────────────────
function setupCapture() {
  captureBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setToast('Capturing AR Scene...');

    try {
      // In WebXR immersive-ar mode, we CANNOT capture the real-world camera feed
      // for privacy reasons. We can ONLY capture the 3D scene (the dancer).
      // We force a render to capture the current state.
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL('image/png');
      
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], 'tourism-ar.png', { type: 'image/png' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Tourism AR — Bacolod City', files: [file] });
        setToast('Shared!');
      } else {
        downloadBlob(blob);
      }
    } catch (err) {
      console.error("Capture failed:", err);
      setToast('Capture failed.');
    }
  });
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = 'tourism-ar.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setToast('Photo downloaded');
}

let toastTimer = null;
function setToast(msg, persist = false) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (persist) return;

  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3000);
}
