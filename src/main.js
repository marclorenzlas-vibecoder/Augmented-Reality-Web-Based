import './style.css';
import * as THREE from 'three';
import { Html5Qrcode } from 'html5-qrcode';

// ── State ──────────────────────────────────────────────────────────────────
let cameraStream   = null;
let scene, camera, renderer;
let reticleGroup, dancerGroup, particleSystem;
let ringMesh, dotMesh;
let videoMesh      = null;   // The 2D video billboard
let videoTex       = null;   // Live VideoTexture
let isPlaced       = false;
let dancerVideo    = null;

let currentMediaUrl  = null;
let currentMediaType = 'default'; // 'video' | 'image' | 'default'
let currentTexture   = null;

// QR Scanner instance
let html5QrCode      = null;
let availableCameras = [];
let selectedCameraIndex = 0;

// ── UI References ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const toastEl         = $('toast');
const historyModalEl  = $('history-modal');
const infoToggleBtnEl = $('info-toggle-btn');
const closeHistoryBtn = $('close-history-btn');
const captureBtnEl    = $('capture-btn');
const recenterBtnEl   = $('recenter-btn');
const uiOverlayEl     = $('ui-overlay');
const qrScreenEl      = $('qr-screen');
const cameraErrorEl   = $('camera-error-msg');
const cameraFeedEl    = $('camera-feed');
const cameraSelectEl  = $('qr-camera-select');
const cameraSwitchBtn = $('qr-switch-btn');
const qrStatusTextEl  = $('qr-status-text');


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
});

async function initCustomQrScanner() {
  try {
    html5QrCode = new Html5Qrcode("qr-reader");

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
    if (cameraSwitchBtn) {
      if (devices.length <= 1) {
        cameraSwitchBtn.style.display = 'none';
      } else {
        cameraSwitchBtn.addEventListener('click', async (e) => {
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
      cameraErrorEl.textContent = 'Please allow camera permissions to scan the QR code.';
      cameraErrorEl.classList.remove('hidden');
    }
  }
}

async function startQrCamera(cameraId) {
  if (!html5QrCode) return;

  const config = {
    fps: 15,
    qrbox: { width: 220, height: 220 },
    aspectRatio: 1.0
  };

  try {
    await html5QrCode.start(
      cameraId,
      config,
      onQrCodeSuccess,
      () => {} // silent frame scan ignore
    );
    if (qrStatusTextEl) qrStatusTextEl.textContent = 'Align QR code in frame';
  } catch (err) {
    console.warn('Could not start specific camera ID, trying facingMode environment fallback:', err);
    try {
      await html5QrCode.start(
        { facingMode: "environment" },
        config,
        onQrCodeSuccess,
        () => {}
      );
    } catch (e) {
      console.error('Camera fallback failed:', e);
    }
  }
}

async function switchQrCamera(cameraId) {
  if (!html5QrCode) return;
  try {
    await html5QrCode.stop();
    await startQrCamera(cameraId);
  } catch (err) {
    console.warn('Switch camera error:', err);
  }
}

// ── When QR Code is Scanned : Direct Instant Launch to AR ──────────────────
async function onQrCodeSuccess(decodedText) {
  // 1. Stop QR scanner stream immediately
  try {
    if (html5QrCode && html5QrCode.isScanning) {
      await html5QrCode.stop();
      html5QrCode.clear();
    }
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
    alert('Camera access was denied. Please allow camera permissions in your browser.');
  }
}


// ── Phase 2 : Camera & Three.js AR Engine ──────────────────────────────────
async function startUniversalAR() {
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  });

  cameraFeedEl.srcObject = cameraStream;
  await cameraFeedEl.play();

  if (dancerVideo) {
    dancerVideo.play().catch(() => {});
  }

  initThreeScene();
  setupTapToPlace();
  setupCapture();
}

function initThreeScene() {
  const canvas = $('ar-canvas');

  scene    = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  camera   = new THREE.PerspectiveCamera(65, aspect, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  // Reticle group (Floor placement ring)
  reticleGroup = new THREE.Group();

  const ringGeo = new THREE.RingGeometry(0.36, 0.41, 64);
  ringMesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0xd4b483, side: THREE.DoubleSide, transparent: true, opacity: 0.9
  }));
  ringMesh.rotation.x = -Math.PI / 2;
  reticleGroup.add(ringMesh);

  dotMesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.05, 32),
    new THREE.MeshBasicMaterial({ color: 0xd4b483, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
  );
  dotMesh.rotation.x = -Math.PI / 2;
  reticleGroup.add(dotMesh);

  // 2D Video / GIF Billboard
  dancerGroup = buildVideoBillboard();
  reticleGroup.add(dancerGroup);

  reticleGroup.position.set(0, -0.65, -1.8);
  scene.add(reticleGroup);

  // Floating ambient festival particles
  particleSystem = buildParticles();
  particleSystem.position.set(0, -0.65, -1.8);
  scene.add(particleSystem);

    // Render loop
  const clock = new THREE.Clock();

  (function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    if (videoTex) {
      videoTex.needsUpdate = true;
    }

    if (!isPlaced) {
      const s = 1 + Math.sin(t * 2.5) * 0.04;
      ringMesh.scale.set(s, s, 1);
      dancerGroup.position.y = 0.65 + Math.sin(t * 1.5) * 0.015;
    } else {
      const dt = t * 3.5;
      dancerGroup.position.y = 0.65 + Math.abs(Math.sin(dt)) * 0.1;
      dancerGroup.rotation.y = Math.sin(t * 2) * 0.18;
      dancerGroup.rotation.z = Math.sin(dt) * 0.04;

      const pos = particleSystem.geometry.attributes.position.array;
      for (let i = 1; i < pos.length; i += 3) {
        pos[i] += 0.001;
        if (pos[i] > 1.8) pos[i] = -0.3;
      }
      particleSystem.geometry.attributes.position.needsUpdate = true;
      particleSystem.rotation.y += 0.003;
    }

    renderer.render(scene, camera);
  })();

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
function loadMediaFromQR(text) {
  if (!text) return;
  const resolvedUrl = resolveMediaUrl(text);
  if (!resolvedUrl) return;

  currentMediaUrl = resolvedUrl;
  setToast('Loading media from QR...');

  const isExplicitVideo = /\.(mp4|webm|mov|ogg|m4v)($|\?)/i.test(resolvedUrl) || 
                          resolvedUrl.includes('drive.google.com') ||
                          resolvedUrl.includes('dropbox.com') ||
                          resolvedUrl.includes('commondatastorage.googleapis.com');

  const isExplicitImage = /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(resolvedUrl);

  if (isExplicitImage) {
    tryLoadImage(resolvedUrl);
  } else {
    // Default to video attempt with image fallback
    currentMediaType = 'video';
    if (dancerVideo) {
      dancerVideo.pause();
      dancerVideo.crossOrigin = 'anonymous';
      dancerVideo.muted = true;
      dancerVideo.loop = true;
      dancerVideo.playsInline = true;
      dancerVideo.src = resolvedUrl;
      dancerVideo.load();
      
      dancerVideo.onloadeddata = () => {
        applyVideoToBillboard();
        dancerVideo.play().catch(() => {});
        setToast('Video ready! Aim and tap to place');
      };

      dancerVideo.onerror = (e) => {
        console.warn('Video load error, attempting image fallback:', e);
        tryLoadImage(resolvedUrl);
      };
    }
  }
}

function tryLoadImage(url) {
  currentMediaType = 'image';
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    url,
    (tex) => {
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      currentTexture = tex;
      applyTextureToBillboard(tex);
      setToast('Media ready! Aim and tap to place');
    },
    undefined,
    (err) => {
      console.warn('Image load error:', err);
      setToast('QR scanned. Aim and tap to place');
    }
  );
}

const VIDEO_ASPECT = 9 / 16;
const BILLBOARD_HEIGHT = 1.4;
const BILLBOARD_WIDTH  = BILLBOARD_HEIGHT * VIDEO_ASPECT;

function applyVideoToBillboard() {
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
    videoMesh.material = new THREE.MeshBasicMaterial({
      map: videoTex,
      side: THREE.DoubleSide,
      transparent: false
    });
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
  if (!videoMesh) return;
  
  videoMesh.material = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide
  });
  videoMesh.material.needsUpdate = true;

  const aspect = (tex.image && tex.image.width && tex.image.height) 
    ? (tex.image.width / tex.image.height) 
    : VIDEO_ASPECT;
  const h = BILLBOARD_HEIGHT;
  const w = h * aspect;

  videoMesh.geometry.dispose();
  videoMesh.geometry = new THREE.PlaneGeometry(w, h);
  videoMesh.position.set(0, h / 2, 0);
}

function buildVideoBillboard() {
  const group = new THREE.Group();

  if (currentTexture) {
    const aspect = (currentTexture.image && currentTexture.image.width && currentTexture.image.height)
      ? (currentTexture.image.width / currentTexture.image.height)
      : VIDEO_ASPECT;
    const w = BILLBOARD_HEIGHT * aspect;

    const mat = new THREE.MeshBasicMaterial({
      map: currentTexture,
      transparent: true,
      side: THREE.DoubleSide
    });

    videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, BILLBOARD_HEIGHT), mat);
    videoMesh.position.set(0, BILLBOARD_HEIGHT / 2, 0);
    group.add(videoMesh);
    return group;
  }

  if (videoTex) {
    videoTex.dispose();
  }
  videoTex = new THREE.VideoTexture(dancerVideo);
  videoTex.minFilter = THREE.LinearFilter;
  videoTex.magFilter = THREE.LinearFilter;
  videoTex.generateMipmaps = false;
  videoTex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshBasicMaterial({
    map: videoTex,
    transparent: false,
    side: THREE.DoubleSide
  });

  const vw = (dancerVideo && dancerVideo.videoWidth) ? dancerVideo.videoWidth : 720;
  const vh = (dancerVideo && dancerVideo.videoHeight) ? dancerVideo.videoHeight : 1280;
  const aspect = (vw && vh) ? (vw / vh) : VIDEO_ASPECT;
  const w = BILLBOARD_HEIGHT * aspect;

  videoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, BILLBOARD_HEIGHT),
    mat
  );

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


// ── Tap to Place & Reposition ───────────────────────────────────────────────
function setupTapToPlace() {
  const canvas = $('ar-canvas');

  function onTap(e) {
    if (isPlaced) return;
    if (e.target !== canvas) return;
    placeDancer();
  }

  canvas.addEventListener('click', onTap);
  canvas.addEventListener('touchend', (e) => {
    if (isPlaced) return;
    placeDancer();
  }, { passive: true });
}

function placeDancer() {
  isPlaced = true;

  if (ringMesh) ringMesh.visible = false;
  if (dotMesh)  dotMesh.visible  = false;

  dancerVideo?.play().catch(() => {});

  setToast('Anchor placed');
  setTimeout(() => {
    toastEl?.classList.add('hidden');
    infoToggleBtnEl?.classList.remove('hidden');
    captureBtnEl?.classList.remove('hidden');
    recenterBtnEl?.classList.remove('hidden');
  }, 1500);
}

function repositionDancer() {
  isPlaced = false;

  if (ringMesh) ringMesh.visible = true;
  if (dotMesh)  dotMesh.visible  = true;

  historyModalEl?.classList.add('hidden');
  infoToggleBtnEl?.classList.add('hidden');
  captureBtnEl?.classList.add('hidden');
  recenterBtnEl?.classList.add('hidden');

  setToast('Aim at a flat surface and tap to place the dancer');
}


// ── Snapshot & Share ───────────────────────────────────────────────────────
function setupCapture() {
  captureBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setToast('Capturing...');

    const out = document.createElement('canvas');
    const vw  = cameraFeedEl.videoWidth  || window.innerWidth;
    const vh  = cameraFeedEl.videoHeight || window.innerHeight;
    out.width = vw;
    out.height = vh;
    const ctx = out.getContext('2d');

    ctx.drawImage(cameraFeedEl,        0, 0, vw, vh);
    ctx.drawImage(renderer.domElement, 0, 0, vw, vh);

    out.toBlob(async (blob) => {
      if (!blob) { setToast('Capture failed.'); return; }

      const file = new File([blob], 'tourism-ar.png', { type: 'image/png' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ title: 'Tourism AR — Bacolod City', files: [file] });
          setToast('Saved to gallery');
        } catch (err) {
          if (err.name !== 'AbortError') downloadBlob(blob);
        }
      } else {
        downloadBlob(blob);
      }
    }, 'image/png');
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
function setToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (isPlaced) toastEl.classList.add('hidden');
  }, 2500);
}
