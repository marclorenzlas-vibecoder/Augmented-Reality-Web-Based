import './style.css';
import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseGIF, decompressFrames } from 'gifuct-js';

// ── State ──────────────────────────────────────────────────────────────────
let currentGlbModel = null;
let mixer = null;
let gifCanvas = null;
let gifTexture = null;
let currentGifPlayer = null;
let isGifMediaType = false;
const gltfLoader = new GLTFLoader();

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
let videoMesh = null;   // The 2D video billboard
let videoTex = null;   // Live VideoTexture
let isPlaced = false;
let arStarted = false; // Only true after user explicitly taps "Start AR"
let ignorePlacementUntil = 0;
let placementListenerAttached = false;
let handlePlacementTap = null;
let isThreeInitialized = false;
let dancerVideo = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let controller;
let xrLastLandscape = null; // tracks overlay rotation state inside WebXR
let currentMediaUrl = null;
let currentMediaType = 'default'; // 'video' | 'image' | 'default'
let currentTexture = null;
let isMediaReady = false;
let mediaLoadToken = 0;
let currentBlobUrl = null;

// QR Scanner instance
let html5QrCode = null;
let availableCameras = [];
let selectedCameraIndex = 0;
let qrCameraTask = Promise.resolve();
let isQrProcessing = false;
let activeQrCameraId = null;
let restartQrTimer = null;

// ── Spatial Audio State (Three.js PositionalAudio) ───────────────────────────
let audioListener     = null;
let positionalAudio   = null;
let audioLoader       = null;
let currentAudioUrl   = null;
let audioBuffer       = null;
let isAudioReady      = false;
let isAudioMuted      = false;
let audioLoadToken    = 0;


let dancerAudioEl = null;
let audioSourceNode = null;

function getDancerAudioElement() {
  if (!dancerAudioEl) {
    dancerAudioEl = document.getElementById('dancer-audio');
    if (!dancerAudioEl) {
      dancerAudioEl = document.createElement('audio');
      dancerAudioEl.id = 'dancer-audio';
      dancerAudioEl.loop = true;
      dancerAudioEl.playsInline = true;
      dancerAudioEl.preload = 'auto';
      dancerAudioEl.crossOrigin = 'anonymous';
      dancerAudioEl.style.position = 'fixed';
      dancerAudioEl.style.top = '-9999px';
      dancerAudioEl.style.left = '-9999px';
      dancerAudioEl.style.width = '1px';
      dancerAudioEl.style.height = '1px';
      dancerAudioEl.style.opacity = '0';
      dancerAudioEl.style.pointerEvents = 'none';
      document.body.appendChild(dancerAudioEl);
    }
  }
  return dancerAudioEl;
}

function resumeAudioContext() {
  const ctx = (audioListener && audioListener.context) || (THREE.AudioContext && THREE.AudioContext.getContext && THREE.AudioContext.getContext());
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

let lastAudioSyncTime = 0;

function syncAudioToVideo(force = false) {
  const audioEl = dancerAudioEl || document.getElementById('dancer-audio');
  if (!audioEl || !isAudioReady || isAudioMuted) {
    return;
  }

  // 1. If AR has not started, object is not placed, or dancer is hidden -> stop audio immediately!
  if (!arStarted || !isPlaced || !dancerGroup || !dancerGroup.visible) {
    if (!audioEl.paused) audioEl.pause();
    return;
  }

  // 2. Check video playback state
  if (!dancerVideo) return;

  if (dancerVideo.paused || dancerVideo.seeking || dancerVideo.readyState < 2) {
    if (!audioEl.paused) audioEl.pause();
    return;
  }

  const now = performance.now();
  // Throttle non-forced sync calls to prevent property spamming
  if (!force && (now - lastAudioSyncTime < 300)) {
    return;
  }
  lastAudioSyncTime = now;

  const targetTime = dancerVideo.currentTime;
  const drift = Math.abs(audioEl.currentTime - targetTime);

  // If video looped or drift exceeds 100ms, adjust audio currentTime
  if (force || drift > 0.10) {
    try {
      audioEl.currentTime = targetTime;
    } catch (e) {}
  }

  if (audioEl.paused && !dancerVideo.paused) {
    resumeAudioContext();
    audioEl.play().catch(() => {});
  }
}

function playPositionalAudio() {
  syncAudioToVideo(false);
}

function pausePositionalAudio() {
  const audioEl = dancerAudioEl || document.getElementById('dancer-audio');
  if (audioEl && !audioEl.paused) {
    try {
      audioEl.pause();
    } catch (e) {}
  }
  if (positionalAudio && positionalAudio.isPlaying) {
    try {
      positionalAudio.pause();
    } catch (e) {}
  }
}

function stopPositionalAudio() {
  const audioEl = dancerAudioEl || document.getElementById('dancer-audio');
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch (e) {}
  }
  if (positionalAudio && positionalAudio.isPlaying) {
    try {
      positionalAudio.stop();
    } catch (e) {}
  }
}

function resolveAudioUrl(raw) {
  if (!raw) return '';
  let url = raw.trim();

  if (url.startsWith('www.')) {
    url = 'https://' + url;
  }

  // Prepend slash for relative local files without scheme or leading slash
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/')) {
    if (/\.(mp3|wav|ogg|m4a|aac|mp4|webm)($|[?#])/i.test(url)) {
      url = '/' + url;
    }
  }

  return resolveMediaUrl(url);
}

async function loadPositionalAudio(rawUrl, token) {
  if (!rawUrl) return;
  const resolvedAudioUrl = resolveAudioUrl(rawUrl);
  if (!resolvedAudioUrl) return;

  console.log('[Audio] Streaming audio from:', resolvedAudioUrl);
  currentAudioUrl = resolvedAudioUrl;
  isAudioReady = false;
  stopPositionalAudio();

  const audioEl = getDancerAudioElement();
  audioEl.src = resolvedAudioUrl;
  audioEl.muted = false;
  audioEl.volume = isAudioMuted ? 0 : 1.0;
  audioEl.currentTime = 0;
  audioEl.load();

  const onCanPlay = () => {
    if (token !== audioLoadToken) return;
    audioEl.removeEventListener('canplay', onCanPlay);
    isAudioReady = true;
    console.log('[Audio] Audio stream ready for playback');

    if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted) {
      syncAudioToVideo(true);
    }
  };

  audioEl.addEventListener('canplay', onCanPlay);
  audioEl.addEventListener('loadeddata', onCanPlay);
  audioEl.addEventListener('playing', () => {
    isAudioReady = true;
  });
  audioEl.addEventListener('error', (e) => {
    console.warn('[Audio] Direct stream error, trying proxy URL:', e);
    if (token === audioLoadToken && !resolvedAudioUrl.includes('corsproxy.io')) {
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(resolvedAudioUrl)}`;
      audioEl.src = proxyUrl;
      audioEl.load();
    }
  });
}

// ── Automatic Background / Chroma Key Configuration ─────────────────────────
// Modes: 0 = Original/Opaque (No removal), 1 = Green Screen Key, 2 = Black BG Key, 3 = Grey BG Key, 4 = White BG Key, 5 = Blue Screen Key
let currentKeyMode    = 2;
let currentKeyColor   = new THREE.Color(0x000000);
let currentSimilarity = 0.38;
let currentSmoothness = 0.10;
let hasFilenameKeyTag = false;

function applyKeySettings(mode, color = null, similarity = null, smoothness = null) {
  currentKeyMode = mode;
  if (color) currentKeyColor = color;
  if (similarity !== null) currentSimilarity = similarity;
  if (smoothness !== null) currentSmoothness = smoothness;

  if (videoMesh && videoMesh.material && videoMesh.material.uniforms) {
    if (videoMesh.material.uniforms.keyMode) {
      videoMesh.material.uniforms.keyMode.value = currentKeyMode;
    }
    if (videoMesh.material.uniforms.keyColor && color) {
      videoMesh.material.uniforms.keyColor.value.copy(currentKeyColor);
    }
    if (videoMesh.material.uniforms.similarity && similarity !== null) {
      videoMesh.material.uniforms.similarity.value = currentSimilarity;
    }
    if (videoMesh.material.uniforms.smoothness && smoothness !== null) {
      videoMesh.material.uniforms.smoothness.value = currentSmoothness;
    }
    videoMesh.material.needsUpdate = true;
  }
}

function detectAndApplyKeyModeFromUrl(url) {
  if (!url) return;
  const decoded = decodeURIComponent(url).toLowerCase();
  hasFilenameKeyTag = false;

  // 1. Original / Opaque (No background removal): original, orig, originalbg, nobgkey, opaque
  if (/(original|_original|originalbg|orig\b|_orig\b|_nobgkey|_opaque|_none\b|bg=none|key=none)/i.test(decoded)) {
    console.log('Chroma Key: Original / Opaque mode (No Background Removal)');
    hasFilenameKeyTag = true;
    applyKeySettings(0);
    return;
  }

  // 2. Grey / Gray background: greybg, graybg, _greybg, _graybg, Composition_greybg, grey_bg, etc.
  if (/(greybg|graybg|_greybg|_graybg|grey[_-]?bg|gray[_-]?bg|bg[_-]?grey|bg[_-]?gray|_grey\b|_gray\b)/i.test(decoded)) {
    console.log('Chroma Key: Detected Grey background from filename (greybg)');
    hasFilenameKeyTag = true;
    applyKeySettings(3, new THREE.Color(0.5, 0.5, 0.5), 0.18, 0.08);
    return;
  }

  // 3. Green background: greenbg, _greenbg, green_bg, greenscreen, etc.
  if (/(greenbg|_greenbg|green[_-]?bg|bg[_-]?green|_green\b|greenscreen|green-screen|green_screen|chroma[_-]?green|key[_-]?green)/i.test(decoded)) {
    console.log('Chroma Key: Detected Green Screen from filename (greenbg)');
    hasFilenameKeyTag = true;
    applyKeySettings(1, new THREE.Color(0x00ff00), 0.38, 0.10);
    return;
  }

  // 4. Blue background: bluebg, _bluebg, blue_bg, bluescreen, etc.
  if (/(bluebg|_bluebg|blue[_-]?bg|bg[_-]?blue|_blue\b|bluescreen|blue-screen|blue_screen|chroma[_-]?blue|key[_-]?blue)/i.test(decoded)) {
    console.log('Chroma Key: Detected Blue Screen from filename (bluebg)');
    hasFilenameKeyTag = true;
    applyKeySettings(5, new THREE.Color(0x0000ff), 0.38, 0.10);
    return;
  }

  // 5. White background: whitebg, _whitebg, white_bg, etc.
  if (/(whitebg|_whitebg|white[_-]?bg|bg[_-]?white|_white\b)/i.test(decoded)) {
    console.log('Chroma Key: Detected White background from filename (whitebg)');
    hasFilenameKeyTag = true;
    applyKeySettings(4, new THREE.Color(1.0, 1.0, 1.0), 0.20, 0.12);
    return;
  }

  // 6. Black / nobg tag: blackbg, _blackbg, black_bg, nobg, _nobg, etc.
  if (/(blackbg|_blackbg|black[_-]?bg|bg[_-]?black|_black\b|_nobg\b|nobg)/i.test(decoded)) {
    console.log('Chroma Key: Detected Black/NoBG from filename (blackbg)');
    hasFilenameKeyTag = true;
    applyKeySettings(2, new THREE.Color(0x000000), 0.07, 0.14);
    return;
  }

  // Default fallback: Black BG keying for standard dark background assets
  applyKeySettings(2, new THREE.Color(0x000000), 0.07, 0.14);
}

function autoDetectKeyModeFromVideo() {
  if (!dancerVideo || dancerVideo.videoWidth === 0) return;
  try {
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 16;
    sampleCanvas.height = 16;
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(dancerVideo, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;

    // Check corners: TL (0,0), TR (15,0), BL (0,15), BR (15,15)
    const corners = [0, 15 * 4, (15 * 16) * 4, (15 * 16 + 15) * 4];
    let totalR = 0, totalG = 0, totalB = 0;
    for (const idx of corners) {
      totalR += data[idx];
      totalG += data[idx + 1];
      totalB += data[idx + 2];
    }
    const avgR = totalR / 4;
    const avgG = totalG / 4;
    const avgB = totalB / 4;

    // If filename explicitly specified greybg, adapt keyColor to the exact sampled background grey
    if (hasFilenameKeyTag && currentKeyMode === 3) {
      if (Math.abs(avgR - avgG) < 25 && Math.abs(avgG - avgB) < 25) {
        applyKeySettings(3, new THREE.Color(avgR / 255, avgG / 255, avgB / 255));
      }
      return;
    }

    if (hasFilenameKeyTag) return;

    // Automatic detection when no naming tag is present
    if (avgG > 80 && avgG > avgR * 1.35 && avgG > avgB * 1.35) {
      applyKeySettings(1, new THREE.Color(0x00ff00), 0.38, 0.10); // Green Screen
    } else if (avgB > 80 && avgB > avgR * 1.35 && avgB > avgG * 1.35) {
      applyKeySettings(5, new THREE.Color(0x0000ff), 0.38, 0.10); // Blue Screen
    } else if (Math.abs(avgR - avgG) < 20 && Math.abs(avgG - avgB) < 20 && avgR > 50 && avgR < 210) {
      applyKeySettings(3, new THREE.Color(avgR / 255, avgG / 255, avgB / 255), 0.18, 0.08); // Grey Screen
    } else if (avgR > 230 && avgG > 230 && avgB > 230) {
      applyKeySettings(4, new THREE.Color(1.0, 1.0, 1.0), 0.20, 0.12); // White Screen
    } else if (avgR < 40 && avgG < 40 && avgB < 40) {
      applyKeySettings(2, new THREE.Color(0x000000), 0.07, 0.14); // Black BG
    }
  } catch (err) {
    // Canvas read security restriction on cross-origin media
  }
}

const RETICLE_ACCENT = 0xee6327; // Bacolod Orange
const RETICLE_LIGHT = 0xfbb03b; // Bacolod Yellow

const QR_CAMERA_CONFIG = {
  fps: 25,
  qrbox: (viewfinderWidth, viewfinderHeight) => {
    const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
    const size = Math.floor(minEdge * 0.88);
    return {
      width: Math.max(size, 200),
      height: Math.max(size, 200)
    };
  },
  aspectRatio: 1.0,
  disableFlip: false
};
const CAMERA_RELEASE_DELAY_MS = 100;

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

      if (keyMode == 0) {
        // Original / Opaque (No background removal)
        gl_FragColor = texColor;
      } else if (keyMode == 1) {
        // Green Screen Chroma Key with Green Despill
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

        float maxRB = max(texColor.r, texColor.b);
        vec3 cleanRgb = texColor.rgb;
        if (cleanRgb.g > maxRB) {
          cleanRgb.g = maxRB + (cleanRgb.g - maxRB) * 0.2;
        }
        gl_FragColor = vec4(cleanRgb, texColor.a * alpha);
      } else if (keyMode == 5) {
        // Blue Screen Chroma Key with Blue Despill
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

        float maxRG = max(texColor.r, texColor.g);
        vec3 cleanRgb = texColor.rgb;
        if (cleanRgb.b > maxRG) {
          cleanRgb.b = maxRG + (cleanRgb.b - maxRG) * 0.2;
        }
        gl_FragColor = vec4(cleanRgb, texColor.a * alpha);
      } else if (keyMode == 2) {
        // Black background removal (Luminance & Color Threshold key)
        float maxVal = max(texColor.r, max(texColor.g, texColor.b));
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float metric = max(luma, maxVal * 0.95);

        float threshold = similarity;
        float feather = smoothness;
        if (metric < threshold) {
          discard;
        }
        float alpha = smoothstep(threshold, threshold + feather, metric);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
      } else if (keyMode == 3) {
        // High-Precision Grey Screen Chroma Key (e.g. Composition_greybg.mp4)
        // 1. Calculate color saturation (chroma = max channel - min channel)
        float maxC = max(texColor.r, max(texColor.g, texColor.b));
        float minC = min(texColor.r, min(texColor.g, texColor.b));
        float chroma = maxC - minC;

        // 2. Calculate luminance and distance from target grey
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float targetLuma = dot(keyColor, vec3(0.299, 0.587, 0.114));
        float lumaDiff = abs(luma - targetLuma);
        float colorDist = distance(texColor.rgb, keyColor);

        // In a flat grey background video (e.g. Composition_greybg.mp4):
        // Foreground elements (costumes, feathers, skin, face, masks) have either:
        // - Color saturation (chroma > 0.045)
        // - Luminance clearly different from background grey (lumaDiff > similarity)
        // - High RGB distance from grey color (colorDist > similarity * 1.25)
        float chromaTol = 0.045;
        float lumaTol = similarity;

        if (chroma > chromaTol || lumaDiff > lumaTol || colorDist > lumaTol * 1.25) {
          // Foreground dancer / costume is completely preserved and opaque
          gl_FragColor = texColor;
        } else {
          // In neutral grey zone: smooth edge feathering
          float chromaFactor = smoothstep(0.015, chromaTol, chroma);
          float lumaFactor = smoothstep(lumaTol * 0.4, lumaTol, lumaDiff);
          float distFactor = smoothstep(lumaTol * 0.4, lumaTol * 1.25, colorDist);
          float dancerStrength = max(chromaFactor, max(lumaFactor, distFactor));

          if (dancerStrength < 0.12) {
            discard; // Pure grey background discarded completely
          }

          float alpha = smoothstep(0.12, 0.75, dancerStrength);
          if (alpha < 0.02) discard;
          gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
        }
      } else if (keyMode == 4) {
        // White background removal
        float minVal = min(texColor.r, min(texColor.g, texColor.b));
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float metric = 1.0 - min(luma, minVal);
        float threshold = similarity;
        float feather = smoothness;
        if (metric < threshold) {
          discard;
        }
        float alpha = smoothstep(threshold, threshold + feather, metric);
        if (alpha < 0.02) discard;
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
      keyColor: { value: currentKeyColor.clone() },
      similarity: { value: currentSimilarity },
      smoothness: { value: currentSmoothness }
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

// ── Pulsating Grid Floor Shader & Builder ───────────────────────────────
let floorGridMesh = null;
let floorGridMaterial = null;
let fallbackFloorGridMesh = null;
let detectedFloorHeight = null;
const lastHitPosition = new THREE.Vector3();
let lastHitPoseMatrix = null;
let detectedPlaneGrids = new Map();
let planeDetectionAvailable = false;

const PLANE_GRID_SURFACE_OFFSET = 0.003;
const hitTestMatrix = new THREE.Matrix4();
const planeInverseMatrix = new THREE.Matrix4();
const planePoseMatrix = new THREE.Matrix4();
const localHitPoint = new THREE.Vector3();
const planeLocalHitPoint = new THREE.Vector3();
const planeWorldNormal = new THREE.Vector3();

const FloorGridShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xee6327) },          // Bacolod Orange
    uColorSecondary: { value: new THREE.Color(0xfbb03b) }  // Bacolod Yellow
  },
  vertexShader: `
    varying vec3 vPlanePosition;
    void main() {
      vPlanePosition = position;
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform vec3 uColorSecondary;
    varying vec3 vPlanePosition;

    void main() {
      // Local plane coordinates keep the pattern aligned to each detected surface.
      vec2 gridWorld = vPlanePosition.xz * 6.0;
      vec2 grid = abs(fract(gridWorld - 0.5) - 0.5) / fwidth(gridWorld);
      float line = min(grid.x, grid.y);
      float gridAlpha = clamp(1.0 - min(line, 1.0), 0.0, 1.0);

      // Fine secondary grid lines
      vec2 fineGridWorld = vPlanePosition.xz * 18.0;
      vec2 fineGrid = abs(fract(fineGridWorld - 0.5) - 0.5) / fwidth(fineGridWorld);
      float fineLine = min(fineGrid.x, fineGrid.y);
      float fineGridAlpha = clamp((1.0 - min(fineLine, 1.0)) * 0.35, 0.0, 1.0);

      float totalGrid = max(gridAlpha, fineGridAlpha);

      // Completely discard fragments between grid lines: zero dark fill, 100% transparent plane body
      if (totalGrid <= 0.02) discard;

      // Pulsating wave animation radiating across floor plane grid lines
      float distWorld = length(vPlanePosition.xz);
      float wave = sin(distWorld * 3.5 - uTime * 3.5) * 0.5 + 0.5;
      float timePulse = sin(uTime * 2.5) * 0.15 + 0.85;

      // Color composition matching Bacolod theme
      vec3 gridColor = mix(uColorSecondary, uColor, wave * 0.75);

      // Only the wireframe grid lines render with vivid color and opacity
      float alpha = clamp(totalGrid * timePulse, 0.0, 1.0);

      gl_FragColor = vec4(gridColor, alpha);
    }
  `
};

function buildPulsatingFloorGrid() {
  floorGridMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xee6327) },
      uColorSecondary: { value: new THREE.Color(0xfbb03b) }
    },
    vertexShader: FloorGridShader.vertexShader,
    fragmentShader: FloorGridShader.fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  floorGridMesh = new THREE.Group();
  floorGridMesh.visible = false;
  return floorGridMesh;
}

function buildPlaneGridGeometry(polygon) {
  if (!polygon || polygon.length < 3) return null;

  const points = [];
  for (const point of polygon) {
    const previous = points[points.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) < 0.0001 &&
      Math.abs(previous.z - point.z) < 0.0001
    ) {
      continue;
    }
    points.push(point);
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (
    points.length > 2 &&
    Math.abs(first.x - last.x) < 0.0001 &&
    Math.abs(first.z - last.z) < 0.0001
  ) {
    points.pop();
  }

  if (points.length < 3) return null;

  const vertices = [];
  const uvs = [];
  const contour = [];

  for (const point of points) {
    vertices.push(point.x, point.y + PLANE_GRID_SURFACE_OFFSET, point.z);
    uvs.push(point.x, point.z);
    contour.push(new THREE.Vector2(point.x, point.z));
  }

  let triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!triangles.length) {
    triangles = [];
    for (let i = 2; i < points.length; i++) {
      triangles.push([0, i - 1, i]);
    }
  }

  const indices = [];
  for (const triangle of triangles) {
    indices.push(triangle[0], triangle[1], triangle[2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function disposeDetectedPlaneGrid(context) {
  if (!context) return;
  floorGridMesh?.remove(context.mesh);
  context.mesh.geometry?.dispose();
}

function resetDetectedPlaneGrids() {
  detectedPlaneGrids.forEach(disposeDetectedPlaneGrid);
  detectedPlaneGrids.clear();
  planeDetectionAvailable = false;
  detectedFloorHeight = null;
  if (fallbackFloorGridMesh) {
    floorGridMesh?.remove(fallbackFloorGridMesh);
    fallbackFloorGridMesh.geometry?.dispose();
    fallbackFloorGridMesh = null;
  }
  if (floorGridMesh) floorGridMesh.visible = false;
}

function pointInDetectedPlanePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;
    const intersects = ((zi > point.z) !== (zj > point.z)) &&
      (point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isHorizontalDetectedPlane(plane, planePose) {
  if (plane.orientation && plane.orientation !== 'horizontal') return false;

  planePoseMatrix.fromArray(planePose.transform.matrix);
  planeWorldNormal.setFromMatrixColumn(planePoseMatrix, 1).normalize();
  return Math.abs(planeWorldNormal.y) > 0.85;
}

function updateDetectedPlaneGrids(frame, referenceSpace, hitMatrix = null) {
  let detectedPlanes = null;
  try {
    detectedPlanes = frame.detectedPlanes;
  } catch (err) {
    detectedPlanes = null;
  }

  if (detectedPlanes && detectedPlanes.size > 0) {
    planeDetectionAvailable = true;
    detectedPlaneGrids.forEach((context, plane) => {
      if (!detectedPlanes.has(plane)) {
        disposeDetectedPlaneGrid(context);
        detectedPlaneGrids.delete(plane);
      }
    });

    let visiblePlaneCount = 0;

    detectedPlanes.forEach((plane) => {
      const planePose = frame.getPose(plane.planeSpace, referenceSpace);
      let context = detectedPlaneGrids.get(plane);

      if (!planePose || !isHorizontalDetectedPlane(plane, planePose)) {
        if (context) context.mesh.visible = false;
        return;
      }

      if (!context) {
        const geometry = buildPlaneGridGeometry(plane.polygon);
        if (!geometry) return;

        const mesh = new THREE.Mesh(geometry, floorGridMaterial);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 1;
        floorGridMesh?.add(mesh);

        context = {
          mesh,
          polygon: plane.polygon,
          timestamp: plane.lastChangedTime
        };
        detectedPlaneGrids.set(plane, context);
      } else if (context.timestamp < plane.lastChangedTime) {
        const geometry = buildPlaneGridGeometry(plane.polygon);
        if (geometry) {
          context.mesh.geometry.dispose();
          context.mesh.geometry = geometry;
          context.polygon = plane.polygon;
          context.timestamp = plane.lastChangedTime;
        }
      }

      context.mesh.matrix.fromArray(planePose.transform.matrix);
      // Floor grid sticks directly to all detected horizontal floor surfaces!
      context.mesh.visible = !isPlaced;
      visiblePlaneCount++;

      planePoseMatrix.fromArray(planePose.transform.matrix);
      detectedFloorHeight = planePoseMatrix.elements[13];
    });

    if (floorGridMesh) {
      floorGridMesh.visible = !isPlaced && visiblePlaneCount > 0;
    }

    return visiblePlaneCount > 0;
  }

  // Anchor floor grid on hit-test detected surface
  if (hitMatrix && !isPlaced) {
    hitTestMatrix.fromArray(hitMatrix);
    const hitPos = new THREE.Vector3().setFromMatrixPosition(hitTestMatrix);
    detectedFloorHeight = hitPos.y;
    lastHitPosition.copy(hitPos);

    if (!fallbackFloorGridMesh) {
      const gridGeo = new THREE.PlaneGeometry(6, 6, 1, 1);
      gridGeo.rotateX(-Math.PI / 2);
      fallbackFloorGridMesh = new THREE.Mesh(gridGeo, floorGridMaterial);
      fallbackFloorGridMesh.renderOrder = 1;
      floorGridMesh?.add(fallbackFloorGridMesh);
    }

    fallbackFloorGridMesh.position.set(hitPos.x, hitPos.y + PLANE_GRID_SURFACE_OFFSET, hitPos.z);
    fallbackFloorGridMesh.visible = !isPlaced;

    if (floorGridMesh) {
      floorGridMesh.visible = !isPlaced;
    }
    return true;
  }

  return false;
}

function setMediaReady(ready) {
  isMediaReady = ready;
  if (videoMesh) {
    videoMesh.visible = ready;
  }
  if (!ready) {
    stopPositionalAudio();
  }
  const arBtn = document.getElementById('ARButton');
  if (ready) {
    hideLoadingBar();
    // Only display ARButton if the QR scanner screen is hidden (i.e. user is in AR mode)
    if (qrScreenEl && qrScreenEl.classList.contains('hidden')) {
      if (arBtn) arBtn.style.display = 'block';
    }
  } else {
    if (arBtn) arBtn.style.display = 'none';
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
  if (arStarted && isPlaced && dancerGroup && dancerGroup.visible) {
    dancerVideo.play().catch(() => { });
    syncAudioToVideo(true);
  } else {
    dancerVideo.pause();
    stopPositionalAudio();
  }
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
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    updateLoadingBar(20, true);
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

    updateLoadingBar(80, true);
    currentBlobUrl = URL.createObjectURL(blob);
    loadVideoMedia(currentBlobUrl, loadToken, { allowBlobFallback: false });
  } catch (err) {
    clearTimeout(timeoutId);
    if (loadToken !== mediaLoadToken || isMediaReady) return;
    console.warn('Video blob fallback failed:', err);
    hideLoadingBar();
    setToast('Video loading error', false);
  }
}

function loadVideoMedia(url, loadToken, { allowBlobFallback = true } = {}) {
  if (!dancerVideo) return;
  updateLoadingBar(20, true);

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
  pausePositionalAudio();
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

  // If after 4s no metadata/frames are ready, try blob fallback
  fallbackId = setTimeout(() => {
    if (!allowBlobFallback || loadToken !== mediaLoadToken || isMediaReady || hasDecodedVideoFrame()) return;
    loadVideoViaBlob(url, loadToken);
    setTimeout(readyStateCheck, 1000);
  }, 4000);

  timeoutId = setTimeout(() => {
    if (loadToken !== mediaLoadToken || isMediaReady || hasDecodedVideoFrame()) return;
    cleanup();
    hideLoadingBar();
    setToast('Video loading timed out', false);
  }, 15000);
}

const $ = (id) => document.getElementById(id);
const uiOverlayEl = $('ui-overlay');
const uiWrapperEl = $('ui-wrapper');
const qrScreenEl = $('qr-screen');
const qrControlsEl = $('qr-controls-container');
const qrStatusTextEl = $('qr-status-text');
const toastEl = $('toast');
const infoToggleBtnEl = $('info-toggle-btn');
const captureBtnEl    = $('capture-btn');
const recenterBtnEl   = $('recenter-btn');
const historyModalEl  = $('history-modal');
const closeHistoryBtn = $('close-history-btn');
const qrSwitchBtn = $('qr-switch-btn');
const cameraSelectEl = $('qr-camera-select');
const cameraErrorEl = $('camera-error-msg');
const exitArBtnEl = $('exit-ar-btn');
const loadingBarContainer = $('loading-bar-container');
const loadingBar = $('loading-bar');

// ── Viewport & Orientation Layout Logic ────────────────────────────────────
let currentOrientationIsLandscape = null;
let currentOrientationState = { isLandscape: false, angle: 0 };
let isTransitioningOrientation = false;
let pendingOrientationTarget = null;
let orientationTransitionTimer = null;
let lastDeviceOrientationAngle = null;
let lastDeviceOrientationTimestamp = 0;

window.addEventListener('deviceorientation', (e) => {
  if (e.gamma !== null && e.gamma !== undefined) {
    lastDeviceOrientationTimestamp = performance.now();
    const absGamma = Math.abs(e.gamma);
    const absBeta = Math.abs(e.beta || 0);

    // If phone is held upright in portrait, gamma is small and beta is tilted up
    if (absGamma < 25 && absBeta > 30) {
      lastDeviceOrientationAngle = 0; // portrait
    } else if (e.gamma < -45 || (absBeta < 35 && e.gamma < -25)) {
      lastDeviceOrientationAngle = 90; // landscape primary (counter-clockwise)
    } else if (e.gamma > 45 || (absBeta < 35 && e.gamma > 25)) {
      lastDeviceOrientationAngle = -90; // landscape secondary (clockwise)
    }
  }
}, true);

function getXrDeviceOrientation(cameraObj) {
  const activeCam = (cameraObj && cameraObj.cameras && cameraObj.cameras.length > 0)
    ? cameraObj.cameras[0]
    : (cameraObj || camera);
  if (!activeCam) return null;
  const q = activeCam.quaternion;

  // Local directions in world space:
  // -Z: camera forward direction pointing into the world
  // +Y: camera local up
  // +X: camera local right
  const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

  // If camera is pointing almost straight down at the floor or up at ceiling, maintain previous state
  if (Math.abs(camDir.y) > 0.94) {
    if (currentOrientationIsLandscape !== null) {
      return { isLandscape: currentOrientationIsLandscape, angle: currentOrientationState?.angle ?? (currentOrientationIsLandscape ? 90 : 0) };
    }
    return null;
  }

  // Project world UP (0, 1, 0) onto camera's screen plane
  const projUp = new THREE.Vector3(0, 1, 0).addScaledVector(camDir, -camDir.y);
  const len = projUp.length();
  if (len < 0.2) {
    if (currentOrientationIsLandscape !== null) {
      return { isLandscape: currentOrientationIsLandscape, angle: currentOrientationState?.angle ?? (currentOrientationIsLandscape ? 90 : 0) };
    }
    return null;
  }
  projUp.divideScalar(len);

  // Determine whether the XR camera's native viewport aspect is landscape or portrait
  const m = activeCam.projectionMatrix?.elements;
  const isNativeXrLandscape = (m && m[0] && m[5]) ? (m[0] < m[5]) : (window.innerWidth > window.innerHeight);

  if (!isNativeXrLandscape) {
    // Native viewport is portrait:
    // camUp (+Y) is along long edge of phone.
    // camRight (+X) is along short edge of phone.
    const rightDot = camRight.dot(projUp);
    const absRight = Math.abs(rightDot);
    // In portrait: camUp points up, absRight is near 0.
    // In landscape: camRight points up, absRight is near 1.
    const isLandscape = currentOrientationIsLandscape ? absRight >= 0.42 : absRight >= 0.62;
    const angle = rightDot < 0 ? -90 : 90;
    return { isLandscape, angle };
  } else {
    // Native viewport is landscape (session started in landscape):
    // camRight (+X) is along long edge of phone.
    // camUp (+Y) is along short edge of phone.
    const upDot = camUp.dot(projUp);
    const absUp = Math.abs(upDot);
    // When phone is in landscape, short edge (camUp) points up (absUp ≈ 1).
    // When phone is in portrait, short edge (camUp) points horizontally (absUp ≈ 0).
    const isLandscape = currentOrientationIsLandscape ? absUp >= 0.42 : absUp >= 0.62;
    const angle = isLandscape ? (upDot < 0 ? -90 : 90) : 0;
    return { isLandscape, angle };
  }
}

function getScreenOrientationInfo() {
  // 1. Check Screen Orientation API (type) - most reliable on modern mobile
  if (screen?.orientation?.type) {
    if (screen.orientation.type.startsWith('portrait')) return { isLandscape: false, angle: 0 };
    if (screen.orientation.type.startsWith('landscape-secondary')) return { isLandscape: true, angle: -90 };
    if (screen.orientation.type.startsWith('landscape')) return { isLandscape: true, angle: 90 };
  }

  // 2. Check orientation angle
  const angle = screen?.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : null);
  if (angle !== null && angle !== undefined) {
    if (angle === 0 || angle === 180) return { isLandscape: false, angle: 0 };
    if (Math.abs(angle) === 90) return { isLandscape: true, angle: 90 };
    if (angle === 270 || angle === -90) return { isLandscape: true, angle: -90 };
  }

  // 3. Check media queries
  if (window.matchMedia) {
    if (window.matchMedia('(orientation: portrait)').matches) {
      return { isLandscape: false, angle: 0 };
    }
    if (window.matchMedia('(orientation: landscape)').matches) {
      return { isLandscape: true, angle: 90 };
    }
  }

  // 4. Fallback to viewport dimensions
  if (window.innerWidth > window.innerHeight) {
    return { isLandscape: true, angle: 90 };
  }

  return { isLandscape: false, angle: 0 };
}

function getEffectiveOrientation() {
  if (renderer?.xr?.isPresenting) {
    const xrCam = renderer.xr.getCamera?.();
    const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0) ? xrCam.cameras[0] : (xrCam || camera);
    const xrOrient = getXrDeviceOrientation(activeCam);
    if (xrOrient !== null) {
      return xrOrient;
    }
  }

  const screenInfo = getScreenOrientationInfo();

  // If screen orientation says portrait, but device was actively tilted recently
  const isRecentTilt = (performance.now() - lastDeviceOrientationTimestamp) < 2000;
  if (isRecentTilt && lastDeviceOrientationAngle !== null && lastDeviceOrientationAngle !== 0 && screenInfo.angle === 0 && !screen?.orientation?.type?.startsWith('portrait')) {
    return {
      isLandscape: true,
      angle: lastDeviceOrientationAngle
    };
  }

  return screenInfo;
}

function applyOrientationClasses(orientationInfo) {
  const isLandscape = !!orientationInfo?.isLandscape;
  const angle = orientationInfo?.angle ?? 90;

  currentOrientationIsLandscape = isLandscape;
  currentOrientationState = { isLandscape, angle };

  const overlay = document.getElementById('ar-overlay') || document.getElementById('ui-overlay') || uiOverlayEl;
  const uiWrapper = document.getElementById('ui-wrapper') || uiWrapperEl;

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
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.width = '100dvw';
      overlay.style.height = '100dvh';
      overlay.style.pointerEvents = 'none';
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
        // Simulated landscape inside portrait viewport (e.g. WebXR DOM overlay on Android Chrome)
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
      overlay.style.overflow = '';
    }
    if (uiWrapper) {
      uiWrapper.classList.add('is-portrait');
      uiWrapper.classList.remove('is-landscape', 'landscape', 'simulated-landscape', 'simulated-landscape-90', 'simulated-landscape--90');

      if (!isNativeLandscape) {
        // Native portrait viewport: normal 100% overlay
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
        // Simulated portrait inside landscape viewport (e.g. AR started in landscape on mobile, then phone rotated to portrait)
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


  // Recalculate camera aspect ratio and projection matrix if not presenting XR
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (camera && !renderer?.xr?.isPresenting) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  if (renderer && !renderer?.xr?.isPresenting) {
    renderer.setSize(width, height);
  }
}

function updateUILayout(forcedOrientation = null) {
  let target = forcedOrientation;
  if (typeof target === 'boolean') {
    target = { isLandscape: target, angle: 90 };
  } else if (!target) {
    target = getEffectiveOrientation();
  }

  const uiWrapper = document.getElementById('ui-wrapper') || uiWrapperEl;
  const isFirstRun = currentOrientationIsLandscape === null;
  const hasChanged = !isFirstRun && (
    target.isLandscape !== currentOrientationIsLandscape ||
    (target.isLandscape && target.angle !== currentOrientationState?.angle)
  );

  // If already at target, skip
  if (!isFirstRun && !hasChanged) {
    return;
  }

  // If already in the middle of transitioning towards this exact target state, ignore duplicate calls
  if (isTransitioningOrientation && pendingOrientationTarget &&
      pendingOrientationTarget.isLandscape === target.isLandscape &&
      pendingOrientationTarget.angle === target.angle) {
    return;
  }

  if (isFirstRun || !uiWrapper || !arStarted) {
    // Initial run or before AR start: apply immediately without transition delay
    pendingOrientationTarget = null;
    isTransitioningOrientation = false;
    applyOrientationClasses(target);
    return;
  }

  // Smooth fade-out, swap layout, and fade-in
  pendingOrientationTarget = { ...target };
  isTransitioningOrientation = true;

  if (orientationTransitionTimer) {
    clearTimeout(orientationTransitionTimer);
    orientationTransitionTimer = null;
  }

  uiWrapper.classList.add('ui-transitioning');

  orientationTransitionTimer = setTimeout(() => {
    applyOrientationClasses(pendingOrientationTarget || target);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        uiWrapper.classList.remove('ui-transitioning');
        isTransitioningOrientation = false;
        pendingOrientationTarget = null;
        orientationTransitionTimer = null;
      });
    });
  }, 180);
}

const updateLayoutAndOrientation = updateUILayout;
const updateOrientationClass = updateUILayout;

// ── Phase 1 : Direct QR Scanner (No Injected UI Widget) ────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  updateUILayout();
  window.addEventListener('resize', () => updateUILayout());
  window.addEventListener('orientationchange', () => updateUILayout());
  if (screen?.orientation) {
    screen.orientation.addEventListener('change', () => {
      if (screen.orientation.type?.startsWith('portrait') || screen.orientation.angle === 0 || screen.orientation.angle === 180) {
        lastDeviceOrientationAngle = 0;
      }
      updateUILayout();
    });
  }
  if (window.matchMedia) {
    window.matchMedia('(orientation: landscape)').addEventListener('change', () => updateUILayout());
  }
  dancerVideo = $('dancer-video');
  if (dancerVideo) {
    dancerVideo.muted = true;
    dancerVideo.playsInline = true;
    dancerVideo.loop = true;
    dancerVideo.crossOrigin = 'anonymous';

    dancerVideo.addEventListener('loadedmetadata', () => {
      updateVideoBillboardGeometry();
      autoDetectKeyModeFromVideo();
      if (videoTex) videoTex.needsUpdate = true;
    });

    dancerVideo.addEventListener('canplay', () => {
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible) {
        if (dancerVideo.paused) {
          dancerVideo.play().catch(() => { });
        }
      } else {
        dancerVideo.pause();
      }
      autoDetectKeyModeFromVideo();
      if (videoTex) videoTex.needsUpdate = true;
    });

    dancerVideo.addEventListener('playing', () => {
      autoDetectKeyModeFromVideo();
      // Tight sync: Only play audio if dancer is placed and visible in AR
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted) {
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
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted && !dancerVideo.paused) {
        syncAudioToVideo(true);
      }
    });

    dancerVideo.addEventListener('ended', () => {
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted) {
        syncAudioToVideo(true);
      }
    });

    let lastVideoSyncTime = 0;
    dancerVideo.addEventListener('timeupdate', () => {
      // Loop sync: when the dancer video loops back to start, restart audio so they stay matched in tempo
      if (dancerVideo.currentTime < lastVideoSyncTime - 0.25) {
        if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted) {
          syncAudioToVideo(true);
        }
      }
      lastVideoSyncTime = dancerVideo.currentTime;
    });
  }

  const qrControlsContainer = $('qr-controls-container');
  if (qrControlsContainer) {
    qrControlsContainer.classList.remove('hidden');
  }

  // ── Geofence & Camera startup: verify user is within 500m of The NGC first!
  // If user allows and is within 500m, it transitions to camera & QR scanner.
  initLocationGateCheck();

  // ── Gallery QR Upload ────────────────────────────────────────────────────
  // Lets users pick a QR code image from their phone gallery.
  // IMPORTANT: html5QrCode.scanFile() throws if the live camera is still
  // running, so we must stop it first, then restart on failure.
  const galleryInput = $('qr-gallery-input');
  if (galleryInput) {
    galleryInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file || isQrProcessing) return;

      // Reset input immediately so the same photo can be re-picked later
      galleryInput.value = '';

      if (qrStatusTextEl) qrStatusTextEl.textContent = 'Reading QR from image…';

      // ── Step 1: Stop the live camera scanner ──────────────────────────
      // scanFile() will throw "Scanner is running" if camera is active
      try {
        await queueQrCameraTask(() => stopQrCameraInternal({ clear: false }));
      } catch (err) {
        console.warn('Gallery: camera stop warning:', err);
      }

      // ── Step 2: Decode the QR from the uploaded image ─────────────────
      let decodedText = null;
      let scanError = null;

      try {
        // scanFile() takes the File directly — no need for objectURL
        decodedText = await html5QrCode.scanFile(file, /* showImage= */ false);
      } catch (err) {
        scanError = err;
      }

      // ── Step 3: Memory cleanup — file data freed immediately ──────────
      e.target.value = '';

      // ── Step 4: Route result ──────────────────────────────────────────
      if (decodedText) {
        // Pipe into the same handler used by the live camera
        await onQrCodeSuccess(decodedText);
      } else {
        const isNotFound = scanError?.message?.toLowerCase().includes('no qr');
        const msg = isNotFound
          ? 'No QR code found — try a clearer photo'
          : 'Could not read QR — try a clearer or closer photo';

        console.warn('Gallery QR scan failed:', scanError);
        if (qrStatusTextEl) qrStatusTextEl.textContent = msg;

        // Restart the live camera since we stopped it
        setTimeout(() => {
          if (qrStatusTextEl) qrStatusTextEl.textContent = 'Align QR code in frame';
          isQrProcessing = false;
          startQrCamera();
        }, 2800);
      }
    });
  }

  // History drawer toggles & touch scroll support
  infoToggleBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 800;
    historyModalEl.classList.remove('hidden');
    document.body.classList.add('drawer-open');
  });

  closeHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 800;
    historyModalEl.classList.add('hidden');
    document.body.classList.remove('drawer-open');
  });

  // Enable smooth touch and wheel scrolling inside drawer in all orientations
  const drawerBodyEl = historyModalEl?.querySelector('.drawer-body');
  if (drawerBodyEl) {
    let startY = 0;
    let startX = 0;
    let startScrollTop = 0;
    let isTouchingDrawer = false;
    let lastTime = 0;
    let lastDelta = 0;
    let velocity = 0;
    let momentumRaf = null;

    drawerBodyEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        if (momentumRaf) cancelAnimationFrame(momentumRaf);
        isTouchingDrawer = true;
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        startScrollTop = drawerBodyEl.scrollTop;
        lastTime = performance.now();
        lastDelta = 0;
        velocity = 0;
        ignorePlacementUntil = performance.now() + 800;
      }
    }, { passive: true });

    drawerBodyEl.addEventListener('touchmove', (e) => {
      if (!isTouchingDrawer || e.touches.length !== 1) return;
      ignorePlacementUntil = performance.now() + 800;

      const isSimulated = document.body.classList.contains('simulated-landscape') ||
                          document.body.classList.contains('simulated-landscape-90') ||
                          document.body.classList.contains('simulated-landscape--90') ||
                          uiWrapperEl?.classList.contains('simulated-landscape');
      const isDegMinus90 = document.body.classList.contains('simulated-landscape--90') ||
                           uiWrapperEl?.classList.contains('simulated-landscape--90');

      if (isSimulated) {
        // Invert delta so finger movement matches natural scroll direction
        let delta = isDegMinus90 ? (startX - e.touches[0].clientX) : (e.touches[0].clientX - startX);
        drawerBodyEl.scrollTop = startScrollTop + delta;

        const now = performance.now();
        const dt = now - lastTime;
        if (dt > 12) {
          velocity = (delta - lastDelta) / dt;
          lastDelta = delta;
          lastTime = now;
        }
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    const endDrawerTouch = () => {
      if (!isTouchingDrawer) return;
      isTouchingDrawer = false;
      ignorePlacementUntil = performance.now() + 800;

      const isSimulated = document.body.classList.contains('simulated-landscape') ||
                          document.body.classList.contains('simulated-landscape-90') ||
                          document.body.classList.contains('simulated-landscape--90') ||
                          uiWrapperEl?.classList.contains('simulated-landscape');

      if (isSimulated && Math.abs(velocity) > 0.15) {
        let v = velocity * 14;
        const step = () => {
          if (Math.abs(v) < 0.4) return;
          drawerBodyEl.scrollTop += v;
          v *= 0.92;
          momentumRaf = requestAnimationFrame(step);
        };
        momentumRaf = requestAnimationFrame(step);
      }
    };

    drawerBodyEl.addEventListener('touchend', endDrawerTouch, { passive: true });
    drawerBodyEl.addEventListener('touchcancel', endDrawerTouch, { passive: true });

    drawerBodyEl.addEventListener('wheel', (e) => {
      drawerBodyEl.scrollTop += e.deltaY;
    }, { passive: true });
  }

  // Reposition
  const onRecenterTrigger = (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 800;
    repositionDancer();
  };
  recenterBtnEl?.addEventListener('click', onRecenterTrigger);
  recenterBtnEl?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 800;
  });
  recenterBtnEl?.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 800;
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
    resetArSessionState();
    uiOverlayEl?.classList.add('hidden');
    qrScreenEl?.classList.remove('hidden');

    // Hide the ARButton injected by Three.js
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';
    dancerVideo?.pause();
    stopPositionalAudio();

    // Reset all buttons to hidden state
    infoToggleBtnEl?.classList.add('hidden');
    captureBtnEl?.classList.add('hidden');
    recenterBtnEl?.classList.add('hidden');
    toastEl?.classList.add('hidden');

    restartQrCameraSoon();
  });

  setupCapture();
});

/**
 * Classify a camera/getUserMedia error into a human-readable message.
 * @param {Error} err
 * @returns {string}
 */
function classifyCameraError(err) {
  const name = err?.name || '';
  const msg  = (err?.message || '').toLowerCase();
  console.error('[Camera] Error name:', name, '| message:', err?.message);

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera access was denied. Please tap the camera/lock icon in your browser\'s address bar, allow Camera, then refresh the page.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera found on this device. Please connect a camera and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Camera is in use by another app. Close other apps that use the camera (e.g. video call, camera app) and refresh.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Rear camera not available. Trying front camera…';
  }
  if (name === 'SecurityError' || msg.includes('secure') || msg.includes('http')) {
    return 'Camera requires a secure (HTTPS) page. Make sure you are visiting https://localhost:5173 — not http://';
  }
  if (msg.includes('not found') || msg.includes('could not start')) {
    return `Could not start camera: ${err.message}. (Close other apps using the camera and try again.)`;
  }
  return `Camera error: ${err.message || err}. (Try closing other apps that use the camera and refresh.)`;
}

// ── Geofence Configuration: Designated Allowed Locations ─────────────
const ALLOWED_LOCATIONS = [
  {
    id: 'ngc',
    name: 'The NGC (New Government Center)',
    badge: 'NGC Festival Zone',
    latitude: 10.669337,
    longitude: 122.969881,
    radiusMeters: 500
  },
  {
    id: 'programmer',
    name: 'Programmer Workspace',
    badge: 'Dev Zone (Programmer)',
    latitude: 10.6194,
    longitude: 122.9310,
    radiusMeters: 100
  },
  {
    id: 'designer',
    name: 'UI Designer Workspace',
    badge: 'Dev Zone (UI Designer)',
    latitude: 10.513861,
    longitude: 122.849917,
    radiusMeters: 100
  }
];

let isLocationVerified = false;

/**
 * Calculates great-circle distance between two coordinates using the Haversine formula
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} distance in meters
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth's mean radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── Vector SVGs for Location Gate (No Emojis) ───────────────────────────
const GEO_ICONS = {
  pin: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
  denied: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M8.9 8.9A9 9 0 0 0 3 10c0 7 9 13 9 13s2.9-2.25 5.5-6.1"></path><path d="M19.7 13.9C20.6 12 21 10.5 21 10a9 9 0 0 0-14.7-6.9"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
  navigation: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>`,
  verified: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`,
  warning: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
  retry: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
  lock: `<span class="inline-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></span>`,
  gear: `<span class="inline-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></span>`
};

/**
 * Startup Geofence Gate: Prompts location access immediately on app load.
 * Strictly verifies the user is within an authorized location zone (NGC 500m, Programmer 100m, UI Designer 100m).
 */
function initLocationGateCheck() {
  const gateEl = $('location-gate');
  const iconEl = $('location-gate-icon');
  const badgeEl = $('location-badge');
  const titleEl = $('location-gate-title');
  const descEl = $('location-gate-desc');
  const distEl = $('location-gate-distance');
  const actionsEl = $('location-gate-actions');
  const retryBtn = $('location-retry-btn');

  if (!gateEl) {
    initCameraWithPermissionCheck();
    return;
  }

  if (retryBtn && !retryBtn.dataset.bound) {
    retryBtn.dataset.bound = 'true';
    retryBtn.addEventListener('click', () => {
      requestLocation();
    });
  }

  function setCheckingState() {
    gateEl.className = 'screen screen--location';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.pin;
    if (badgeEl) {
      badgeEl.textContent = 'Location Verification';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'Verifying Location…';
    if (descEl) {
      descEl.innerHTML = `
        <p>This Augmented Reality experience is exclusively available at <strong>The NGC</strong> or authorized team locations.</p>
        <p>Requesting your GPS coordinates to verify your location…</p>
      `;
    }
    if (distEl) distEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.add('hidden');
  }

  function setVerifiedState(loc, distMeters) {
    isLocationVerified = true;
    gateEl.className = 'screen screen--location state-verified';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.verified;
    if (badgeEl) {
      badgeEl.textContent = loc.badge || 'Location Verified';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = `Welcome to ${loc.name}!`;
    const distStr = Math.round(distMeters) + 'm from zone center';
    if (descEl) {
      descEl.innerHTML = `
        <p>You are inside the authorized <strong>${loc.radiusMeters}m geofence zone</strong>.</p>
        <p>Starting camera &amp; AR scanner…</p>
      `;
    }
    if (distEl) {
      distEl.innerHTML = `${GEO_ICONS.verified} <span>Inside ${loc.name} (${Math.round(distMeters)}m)</span>`;
      distEl.classList.remove('hidden');
    }
    if (actionsEl) actionsEl.classList.add('hidden');

    // Smoothly fade out the location gate and start camera
    setTimeout(() => {
      gateEl.classList.add('fade-out');
      setTimeout(() => {
        gateEl.classList.add('hidden');
      }, 500);
      initCameraWithPermissionCheck();
    }, 1100);
  }

  function setDeniedState() {
    gateEl.className = 'screen screen--location state-denied';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.denied;
    if (badgeEl) {
      badgeEl.textContent = 'Permission Denied';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'Location Permission Required';
    if (descEl) {
      descEl.innerHTML = `
        <p>Location access was declined. This experience is location-restricted and cannot start without GPS permission.</p>
        <p>Please tap the <strong>site settings / lock icon (${GEO_ICONS.lock} or ${GEO_ICONS.gear})</strong> in your address bar, set <strong>Location: Allow</strong>, then tap below:</p>
      `;
    }
    if (distEl) distEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (retryBtn) {
      retryBtn.innerHTML = `${GEO_ICONS.pin} <span>Grant Permission &amp; Try Again</span>`;
    }
  }

  function setRestrictedState(nearestLoc, distMeters) {
    gateEl.className = 'screen screen--location state-restricted';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.navigation;
    if (badgeEl) {
      badgeEl.textContent = 'Location Restricted';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'Location Restricted';
    const distStr = distMeters >= 1000
      ? (distMeters / 1000).toFixed(2) + ' km'
      : Math.round(distMeters) + ' meters';
    const locName = nearestLoc ? nearestLoc.name : 'The NGC';
    const maxRadius = nearestLoc ? nearestLoc.radiusMeters : 500;
    if (descEl) {
      descEl.innerHTML = `
        <p>This Augmented Reality experience is only accessible at designated locations (<strong>The NGC</strong> or authorized team zones).</p>
        <p>You are currently <strong>${distStr}</strong> away from ${locName}. Please visit an authorized zone to unlock!</p>
      `;
    }
    if (distEl) {
      distEl.innerHTML = `${GEO_ICONS.navigation} <span>Distance: ${distStr} (Allowed: ${maxRadius}m)</span>`;
      distEl.classList.remove('hidden');
    }
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (retryBtn) {
      retryBtn.innerHTML = `${GEO_ICONS.retry} <span>Re-check My Location</span>`;
    }
  }

  function setErrorState(errMsg) {
    gateEl.className = 'screen screen--location state-denied';
    if (iconEl) iconEl.innerHTML = GEO_ICONS.warning;
    if (badgeEl) {
      badgeEl.textContent = 'GPS Signal Error';
      badgeEl.className = 'location-badge';
    }
    if (titleEl) titleEl.textContent = 'GPS Signal Unavailable';
    if (descEl) {
      descEl.innerHTML = `
        <p>Unable to acquire GPS coordinates (${errMsg}).</p>
        <p>Please make sure your device's <strong>Location / GPS</strong> is turned ON in settings, then try again.</p>
      `;
    }
    if (distEl) distEl.classList.add('hidden');
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (retryBtn) {
      retryBtn.innerHTML = `${GEO_ICONS.retry} <span>Try Again</span>`;
    }
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setErrorState('Geolocation not supported by this browser');
      return;
    }

    setCheckingState();

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userLat = pos.coords.latitude;
        const userLng = pos.coords.longitude;

        let matchedLocation = null;
        let matchedDistance = Infinity;
        let nearestLocation = null;
        let minDistance = Infinity;

        for (const loc of ALLOWED_LOCATIONS) {
          const dist = calculateDistanceMeters(
            userLat,
            userLng,
            loc.latitude,
            loc.longitude
          );

          if (dist <= loc.radiusMeters) {
            matchedLocation = loc;
            matchedDistance = dist;
            break;
          }

          if (dist < minDistance) {
            minDistance = dist;
            nearestLocation = loc;
          }
        }

        if (matchedLocation) {
          setVerifiedState(matchedLocation, matchedDistance);
        } else {
          setRestrictedState(nearestLocation, minDistance);
        }
      },
      (err) => {
        console.warn('[Location] Geolocation error:', err);
        if (err.code === err.PERMISSION_DENIED) {
          setDeniedState();
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setErrorState('Position unavailable');
        } else if (err.code === err.TIMEOUT) {
          setErrorState('Location request timed out');
        } else {
          setErrorState(err.message || 'Unknown location error');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  // Request location immediately upon opening the app
  requestLocation();
}

/**
 * Called once location is verified within 500m of The NGC. Checks for secure context,
 * probes getUserMedia so the browser shows the native permission dialog, then starts html5-qrcode.
 * Falls back to a visible retry button on failure.
 */
function initCameraWithPermissionCheck() {
  console.log('[Camera] Checking environment…');
  console.log('[Camera] isSecureContext:', window.isSecureContext);
  console.log('[Camera] location.protocol:', location.protocol);
  console.log('[Camera] navigator.mediaDevices available:', !!navigator.mediaDevices);

  // ── 1. Secure context guard ────────────────────────────────────────────
  if (!window.isSecureContext) {
    const errMsg = 'Camera requires HTTPS. You are on ' + location.protocol + '//' + location.host +
      '. Please open https://localhost:5173 instead, or use the HTTPS network URL shown by Vite.';
    console.error('[Camera]', errMsg);
    showCameraError(errMsg);
    return;
  }

  // ── 2. API availability guard ─────────────────────────────────────────
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const errMsg = 'navigator.mediaDevices.getUserMedia is not available in this browser. ' +
      'Try Chrome, Firefox, or Safari on HTTPS.';
    console.error('[Camera]', errMsg);
    showCameraError(errMsg);
    return;
  }

  // ── 3. Pre-flight getUserMedia probe ─────────────────────────────────
  // We briefly open a stream ourselves so the browser always shows its
  // native Allow/Block camera prompt BEFORE html5-qrcode takes over.
  // Once the user grants permission we immediately release the test track
  // so html5-qrcode can acquire its own stream cleanly.
  console.log('[Camera] Pre-flight getUserMedia probe starting…');
  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false   // we NEVER request mic
    })
    .then((testStream) => {
      console.log('[Camera] Pre-flight OK — permission granted. Releasing test stream.');
      // Release the probe stream immediately; html5-qrcode will open its own.
      testStream.getTracks().forEach(t => t.stop());

      // ── 4. Now init html5-qrcode ────────────────────────────────────
      initCustomQrScanner().catch(err => {
        console.error('[Camera] initCustomQrScanner failed after permission granted:', err);
        showCameraError(classifyCameraError(err));
      });
    })
    .catch((err) => {
      console.error('[Camera] Pre-flight getUserMedia failed:', err);
      const errMsg = classifyCameraError(err);

      // If it was an OverconstrainedError (no back cam), try user-facing cam
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        console.warn('[Camera] Rear camera unavailable — trying any camera.');
        navigator.mediaDevices
          .getUserMedia({ video: true, audio: false })
          .then((fallbackStream) => {
            fallbackStream.getTracks().forEach(t => t.stop());
            initCustomQrScanner().catch(e => showCameraError(classifyCameraError(e)));
          })
          .catch((fallbackErr) => {
            showCameraError(classifyCameraError(fallbackErr));
          });
        return;
      }

      showCameraError(errMsg);
    });
}

/**
 * Display an error message in #camera-error-msg with a Retry button.
 * @param {string} message
 */
function showCameraError(message) {
  if (!cameraErrorEl) return;
  // Build a styled error message with retry button
  cameraErrorEl.innerHTML =
    `<span>${message}</span>` +
    `<button id="camera-retry-btn" style="` +
      `display:block;margin-top:10px;padding:8px 18px;` +
      `background:var(--bacolod-orange,#ee6327);color:#fff;` +
      `border:none;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;` +
    `">Tap to retry camera</button>`;
  cameraErrorEl.classList.remove('hidden');

  const retryBtn = document.getElementById('camera-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      console.log('[Camera] User tapped Retry.');
      cameraErrorEl.classList.add('hidden');
      // A retry button click IS a user gesture — safe to call getUserMedia directly
      initCameraWithPermissionCheck();
    }, { once: true });
  }
}

async function initCustomQrScanner() {
  try {
    if (!html5QrCode) {
      try {
        html5QrCode = new Html5Qrcode('qr-reader', {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          },
          verbose: false
        });
      } catch (err) {
        console.warn('[Camera] Fallback standard Html5Qrcode init:', err);
        html5QrCode = new Html5Qrcode('qr-reader');
      }
    }

    console.log('[Camera] Starting html5-qrcode scanner with facingMode:environment…');
    // Always use the back camera using facingMode constraint
    await startQrCamera();
    console.log('[Camera] html5-qrcode scanner started successfully.');

  } catch (err) {
    console.error('[Camera] QR Scanner init error:', err);
    throw err; // re-throw so initCameraWithPermissionCheck can classify it
  }
}

function queueQrCameraTask(task) {
  qrCameraTask = qrCameraTask.catch(() => { }).then(task);
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
      await wait(150);
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

async function startQrCameraInternal() {
  if (!html5QrCode || isQrProcessing) return;
  if (html5QrCode.isScanning && activeQrCameraId === 'environment') return;

  clearQrRestartTimer();

  if (html5QrCode.isScanning) {
    await stopQrCameraInternal();
    await wait(100);
  }

  console.log('[Camera] html5QrCode.start() — facingMode:environment');
  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      QR_CAMERA_CONFIG,
      onQrCodeSuccess,
      () => { } // QR scan error callback (not a camera error)
    );
    activeQrCameraId = 'environment';
    console.log('[Camera] QR scanner live — rear camera active.');
    cameraErrorEl?.classList.add('hidden');
    if (qrStatusTextEl) qrStatusTextEl.textContent = 'Align QR code in frame';
  } catch (err) {
    activeQrCameraId = null;
    console.error('[Camera] html5QrCode.start() failed:', err);
    showCameraError(classifyCameraError(err));
  }
}

async function startQrCamera() {
  return queueQrCameraTask(() => startQrCameraInternal());
}

function restartQrCameraSoon() {
  clearQrRestartTimer();
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'none';
  restartQrTimer = setTimeout(() => {
    isQrProcessing = false;
    startQrCamera();
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
  resetArSessionState();
  if (dancerVideo) {
    dancerVideo.play().catch(() => { });
  }

  if (!isThreeInitialized) {
    initThreeScene();
    isThreeInitialized = true;
  }

}



function initThreeScene() {
  const canvas = $('ar-canvas');

  scene = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(70, aspect, 0.01, 20);
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

  // Enable WebXR
  renderer.xr.enabled = true;
  renderer.xr.setFramebufferScaleFactor?.(0.8);
  renderer.xr.setFoveation?.(1);

  // Create an AR Button that triggers the WebXR session with Environmental Occlusion, Camera Access & Depth Sensing
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'camera-access', 'depth-sensing', 'mesh-detection', 'plane-detection'],
    depthSensing: {
      usagePreference: ['gpu-optimized', 'cpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32']
    },
    domOverlay: { root: document.getElementById('ui-overlay') }
  };
  const arButton = ARButton.createButton(renderer, sessionInit);
  arButton.style.display = 'none'; // Keep hidden until asset loading is successful
  document.body.appendChild(arButton);

  // Inject elegant icon + label inside the circular button
  // (ARButton sets textContent; we override it with richer HTML)
  requestAnimationFrame(() => {
    arButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.9;display:block;flex-shrink:0">
        <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
        <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
        <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
        <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
        <circle cx="12" cy="12" r="3"/>
        <path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01"/>
      </svg>
      <span style="font-size:inherit;font-weight:inherit;letter-spacing:inherit;line-height:1">Start AR</span>
    `;
  });

  // Enhanced Start AR button click handler: ensures domOverlay is active, launches WebXR, and provides graceful fallback
  const originalOnClick = arButton.onclick;
  arButton.onclick = async function (e) {
    if (uiOverlayEl) {
      uiOverlayEl.classList.remove('hidden');
      uiOverlayEl.style.display = '';
    }

    arStarted = true;
    const toast = toastEl || $('toast');
    if (toast && !isPlaced) {
      toast.classList.remove('hidden');
    }

    try {
      if (typeof originalOnClick === 'function') {
        await originalOnClick.call(this, e);
      } else if (navigator.xr) {
        const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
        await renderer.xr.setSession(session);
      }
      updateLayoutAndOrientation();
    } catch (err) {
      console.warn('Primary WebXR session request failed, trying minimal features:', err);
      try {
        const fallbackInit = {
          requiredFeatures: ['hit-test'],
          optionalFeatures: ['dom-overlay', 'camera-access'],
          domOverlay: { root: document.getElementById('ui-overlay') }
        };
        const session = await navigator.xr.requestSession('immersive-ar', fallbackInit);
        await renderer.xr.setSession(session);
        updateLayoutAndOrientation();
      } catch (fallbackErr) {
        console.error('AR session start failed completely:', fallbackErr);
        setToast('Failed to start AR: ' + (fallbackErr.message || fallbackErr), true);
        arStarted = false;
        if (toast) toast.classList.add('hidden');
        return;
      }
    }

    updateLayoutAndOrientation();

    // Hide Start AR button once session starts
    arButton.style.display = 'none';

    setTimeout(() => {
      if (arStarted && !isPlaced) {
        enablePlacementListener();
      }
    }, 400);
  };

  renderer.xr.addEventListener('sessionstart', () => {
    arStarted = true;
    updateLayoutAndOrientation();
    requestAnimationFrame(updateLayoutAndOrientation);
    setTimeout(updateLayoutAndOrientation, 150);
    const arBtn = document.getElementById('ARButton');
    if (arBtn) arBtn.style.display = 'none';
    const toast = toastEl || $('toast');
    if (toast && !isPlaced) {
      toast.classList.remove('hidden');
    }
    setTimeout(() => {
      if (arStarted && !isPlaced) {
        enablePlacementListener();
      }
    }, 400);
  });

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  // Controller for select (tap to place)
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  // Pulsating Grid Floor (acts as plane indicator & ground plane)
  floorGridMesh = buildPulsatingFloorGrid();
  floorGridMesh.visible = false;
  scene.add(floorGridMesh);

  // 3D Object / Video Billboard container (hidden until user taps on the detected floor grid)
  dancerGroup = buildVideoBillboard();
  dancerGroup.visible = false;
  scene.add(dancerGroup);

  // Setup Spatial 3D Audio Listener on Camera
  if (!audioListener) {
    audioListener = new THREE.AudioListener();
    camera.add(audioListener);
  }

  // Setup Positional Audio node attached directly to dancerGroup
  if (!positionalAudio) {
    positionalAudio = new THREE.PositionalAudio(audioListener);
    positionalAudio.setRefDistance(1.5);
    positionalAudio.setMaxDistance(20);
    positionalAudio.setRolloffFactor(1.2);
    positionalAudio.setDistanceModel('inverse');
    positionalAudio.setLoop(true);
    positionalAudio.setVolume(isAudioMuted ? 0 : 1.0);
    dancerGroup.add(positionalAudio);
  }

  if (audioBuffer && (!positionalAudio.buffer || positionalAudio.buffer !== audioBuffer)) {
    try {
      positionalAudio.setBuffer(audioBuffer);
    } catch (err) {
      console.warn('Error setting initial audio buffer:', err);
    }
  }

  // Global screen-space tap tracking for exact touch coordinates in WebXR
  let lastTapScreenX = null;
  let lastTapScreenY = null;

  function updateTapCoordinates(clientX, clientY) {
    if (typeof clientX === 'number' && clientX > 0 && typeof clientY === 'number' && clientY > 0) {
      lastTapScreenX = clientX;
      lastTapScreenY = clientY;
    }
  }

  window.addEventListener('pointerdown', (e) => {
    updateTapCoordinates(e.clientX, e.clientY);
  }, { passive: true, capture: true });

  window.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 0) {
      updateTapCoordinates(e.touches[0].clientX, e.touches[0].clientY);
    }
    if (e.touches && e.touches.length === 2 && isPlaced && dancerGroup) {
      initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      basePinchScale = currentDancerScale;
    }
  }, { passive: true, capture: true });

  // Two-finger pinch gesture to dynamically scale dancer size to the viewer
  let initialPinchDist = null;
  let basePinchScale = 1.0;
  let currentDancerScale = 1.0;

  window.addEventListener('touchmove', (e) => {
    if (e.touches && e.touches.length === 2 && isPlaced && dancerGroup && initialPinchDist) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / initialPinchDist;
      currentDancerScale = THREE.MathUtils.clamp(basePinchScale * factor, 0.4, 5.0);
      dancerGroup.scale.set(currentDancerScale, currentDancerScale, currentDancerScale);
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!e.touches || e.touches.length < 2) {
      initialPinchDist = null;
      basePinchScale = currentDancerScale;
    }
  }, { passive: true });

  // Touch / pointer placement handler on canvas (strictly inactive until user starts AR)
  handlePlacementTap = (e) => {
    if (!arStarted || isPlaced) return;
    if (performance.now() < ignorePlacementUntil) return;
    if (e.target && e.target.closest && e.target.closest('button, .drawer, .top-bar-controls, .top-bar, .dock, input, label, #ARButton')) return;

    const x = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? (e.changedTouches && e.changedTouches[0]?.clientX);
    const y = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? (e.changedTouches && e.changedTouches[0]?.clientY);
    updateTapCoordinates(x, y);
    handleFloorTap(x, y);
  };

  // Ensure placement listener is inactive until user explicitly taps "Start AR"
  disablePlacementListener();

  // Render loop using setAnimationLoop for WebXR compatibility
  const clock = new THREE.Clock();

  const renderLoop = (timestamp, frame) => {
    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    if (floorGridMaterial) {
      floorGridMaterial.uniforms.uTime.value = elapsed;
    }

    if (mixer) {
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible) {
        mixer.update(delta);
      }
    }
    if (currentGifPlayer) {
      if (arStarted && isPlaced && dancerGroup && dancerGroup.visible) {
        currentGifPlayer.update(performance.now());
      }
    }

    // Stop audio if dancer is hidden or AR is not active
    if (!arStarted || !isPlaced || !dancerGroup || !dancerGroup.visible) {
      stopPositionalAudio();
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
          resetArSessionState();
          xrLastLandscape = null; // reset so next session re-evaluates

          // Reset overlay rotation back to portrait
          const uiWrapper = $('ui-wrapper');
          if (uiWrapper) {
            uiWrapper.style.width = '';
            uiWrapper.style.height = '';
            uiWrapper.style.left = '';
            uiWrapper.style.top = '';
            uiWrapper.style.transform = '';
            uiWrapper.style.transformOrigin = '';
          }
          if (uiOverlayEl) {
            uiOverlayEl.style.width = '';
            uiOverlayEl.style.height = '';
            uiOverlayEl.style.left = '';
            uiOverlayEl.style.top = '';
            uiOverlayEl.style.transform = '';
            uiOverlayEl.style.transformOrigin = '';
          }
          document.body.classList.remove('landscape');

          // Reset UI
          uiOverlayEl?.classList.add('hidden');
          qrScreenEl?.classList.remove('hidden');
          const arBtn = document.getElementById('ARButton');
          if (arBtn) arBtn.style.display = 'none';
          dancerVideo?.pause();
          stopPositionalAudio();
          // Reset all AR buttons to hidden state
          document.body.classList.remove('drawer-open');
          infoToggleBtnEl?.classList.add('hidden');
          captureBtnEl?.classList.add('hidden');
          recenterBtnEl?.classList.add('hidden');
          toastEl?.classList.add('hidden');

          restartQrCameraSoon();
        });

        hitTestSourceRequested = true;
      }

      let currentHitMatrix = null;
      if (hitTestSource) {
        const hitTestResults = frame.getHitTestResults(hitTestSource);

        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          const xrRefSpace = renderer.xr.getReferenceSpace();
          const pose = hit.getPose(xrRefSpace);

          if (pose) {
            currentHitMatrix = Array.from(pose.transform.matrix);
          }
        }
      }

      const hasActivePlaneGrid = updateDetectedPlaneGrids(frame, referenceSpace, currentHitMatrix);
      lastHitPoseMatrix = currentHitMatrix && (!planeDetectionAvailable || hasActivePlaneGrid)
        ? currentHitMatrix
        : null;
    }

    if (isPlaced && dancerGroup) {
      // Anchored stably to placed location without artificial wobbling
      if (dancerGroup.userData.baseY !== undefined) {
        dancerGroup.position.y = dancerGroup.userData.baseY;
      }
      // If billboard is 2D video or image, continuously face viewer so it never looks flat or skewed from side angles
      if (currentMediaType === 'video' || currentMediaType === 'default' || currentMediaType === 'image') {
        const xrCam = (renderer && renderer.xr && renderer.xr.isPresenting)
          ? renderer.xr.getCamera()
          : camera;
        const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0)
          ? xrCam.cameras[0]
          : (xrCam || camera);
        if (activeCam) {
          const camPos = new THREE.Vector3();
          activeCam.getWorldPosition(camPos);
          const angle = Math.atan2(
            camPos.x - dancerGroup.position.x,
            camPos.z - dancerGroup.position.z
          );
          dancerGroup.rotation.y = angle;
        }
      } else if (dancerGroup.userData.baseRotY !== undefined) {
        dancerGroup.rotation.y = dancerGroup.userData.baseRotY;
      }
      dancerGroup.rotation.x = 0;
      dancerGroup.rotation.z = 0;
      if (videoMesh) {
        videoMesh.rotation.z = 0;
      }
      if (currentGlbModel) {
        currentGlbModel.rotation.z = 0;
      }
    }

    // Real-time orientation sync in WebXR
    if (renderer.xr.isPresenting) {
      const orient = getEffectiveOrientation();
      if (
        currentOrientationIsLandscape === null ||
        orient.isLandscape !== currentOrientationIsLandscape ||
        (orient.isLandscape && orient.angle !== currentOrientationState.angle)
      ) {
        updateUILayout(orient);
      }
    }

    // AR Snapshot Capture executing directly in WebXR animation frame
    if (isCaptureRequested && capturePromiseResolver) {
      const resolver = capturePromiseResolver;
      isCaptureRequested = false;
      capturePromiseResolver = null;

      try {
        const W = Math.min(Math.round(window.innerWidth * (window.devicePixelRatio || 1)), 1920);
        const H = Math.min(Math.round(window.innerHeight * (window.devicePixelRatio || 1)), 1920);

        if (!captureRenderTarget || captureRenderTarget.width !== W || captureRenderTarget.height !== H) {
          if (captureRenderTarget) captureRenderTarget.dispose();
          captureRenderTarget = new THREE.WebGLRenderTarget(W, H, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            colorSpace: THREE.SRGBColorSpace
          });
        }

        const prevRenderTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(captureRenderTarget);
        renderer.clear();

        // 1. Render camera background if WebXR camera texture is available
        let hasCameraBg = false;
        if (frame && renderer.xr.isPresenting) {
          const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
          if (pose && pose.views && pose.views.length > 0) {
            const xrCam = pose.views[0].camera;
            if (xrCam) {
              const cameraTex = renderer.xr.getCameraTexture(xrCam);
              if (cameraTex) {
                const { scene: bgScene, mat: bgMat } = getCameraBackgroundMesh();
                bgMat.uniforms.map.value = cameraTex;
                const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
                renderer.render(bgScene, orthoCam);
                hasCameraBg = true;
              }
            }
          }
        }

        // 2. Render 3D Scene (dancer billboard + particle effects) on top
        const xrCam = (renderer.xr && renderer.xr.isPresenting) ? renderer.xr.getCamera() : camera;
        const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0) ? xrCam.cameras[0] : (xrCam || camera);

        renderer.autoClear = !hasCameraBg;
        renderer.render(scene, activeCam);
        renderer.autoClear = true;

        // 3. Read pixel buffer from render target
        const pixelBuffer = new Uint8Array(W * H * 4);
        renderer.readRenderTargetPixels(captureRenderTarget, 0, 0, W, H, pixelBuffer);
        renderer.setRenderTarget(prevRenderTarget);

        // 4. Draw to Canvas 2D with WebGL bottom-left to top-left flip
        const outCanvas = document.createElement('canvas');
        outCanvas.width = W;
        outCanvas.height = H;
        const ctx = outCanvas.getContext('2d');
        const imgData = ctx.createImageData(W, H);
        const data = imgData.data;

        for (let y = 0; y < H; y++) {
          const srcY = H - 1 - y;
          const srcOffset = srcY * W * 4;
          const dstOffset = y * W * 4;
          data.set(pixelBuffer.subarray(srcOffset, srcOffset + W * 4), dstOffset);
        }
        ctx.putImageData(imgData, 0, 0);

        // 5. Add festive Bacolod watermark ribbon/badge
        const badgeH = Math.round(52 * (W / 720));
        const fontSize = Math.round(18 * (W / 720));
        ctx.fillStyle = 'rgba(15, 15, 20, 0.65)';
        ctx.fillRect(0, H - badgeH, W, badgeH);

        ctx.fillStyle = '#fbb03b';
        ctx.font = `bold ${Math.max(fontSize, 14)}px "Plus Jakarta Sans", "Baloo 2", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText('🎭 Bacolod Tourism AR · City of Smiles', Math.round(20 * (W / 720)), H - badgeH / 2);

        outCanvas.toBlob((blob) => {
          if (blob) {
            resolver.resolve(blob);
          } else {
            resolver.reject(new Error('Canvas toBlob returned null'));
          }
        }, 'image/jpeg', 0.95);

      } catch (err) {
        console.error('[Capture] Error during AR render snapshot:', err);
        resolver.reject(err);
      }
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
    updateUILayout();
  });

  // screen.orientation fires inside WebXR where window resize might be frozen
  if (screen?.orientation) {
    screen.orientation.addEventListener('change', () => {
      lastOrientationAngle = null;
      if (screen.orientation.type?.startsWith('portrait') || screen.orientation.angle === 0 || screen.orientation.angle === 180) {
        lastDeviceOrientationAngle = 0;
      }
      updateUILayout();
    });
  }
  // Legacy fallback (Safari / older Android)
  window.addEventListener('orientationchange', () => {
    lastOrientationAngle = null;
    const angle = typeof window.orientation === 'number' ? window.orientation : null;
    if (angle === 0 || angle === 180) {
      lastDeviceOrientationAngle = 0;
    }
    updateUILayout();
  });
  if (window.matchMedia) {
    window.matchMedia('(orientation: landscape)').addEventListener('change', () => {
      updateUILayout();
    });
  }
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

// ── Parse Multiple Links (Video MP4 + Audio) from Scanned QR Code ─────────
function parseMediaAndAudioFromQr(text) {
  if (!text) return { videoSource: '', audioSource: null };
  const raw = text.trim();

  // 1. JSON payload support: {"video": "...", "audio": "..."}
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      const v = obj.video || obj.mp4 || obj.url || obj.media || obj.src;
      const a = obj.audio || obj.sound || obj.music || obj.track;
      if (v) return { videoSource: v.trim(), audioSource: a ? a.trim() : null };
    } catch (e) {}
  }

  // 2. Direct File Garden folder links (e.g. https://file.garden/aoVl-M0-p1TyFay4/masskara1)
  const cleanFolder = raw.replace(/\/+$/, '');
  if (/file\.garden\/[^\/]+\/masskara1$/i.test(cleanFolder) || cleanFolder.endsWith('/masskara1')) {
    return {
      videoSource: `${cleanFolder}/Composition_greybg.mp4`,
      audioSource: `${cleanFolder}/audioclip-1788760841000-245087.mp4`
    };
  }
  if (/file\.garden\//i.test(cleanFolder) && !/\.(mp4|webm|mov|ogg|m4v|glb|gltf|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac)$/i.test(cleanFolder)) {
    return {
      videoSource: `${cleanFolder}/Composition_greybg.mp4`,
      audioSource: `${cleanFolder}/audioclip-1788760841000-245087.mp4`
    };
  }

  // 3. Extract multiple URLs from text (separated by space, newlines, pipes, commas, etc.)
  const urlMatches = raw.match(/https?:\/\/[^\s"',|]+/gi);
  if (urlMatches && urlMatches.length >= 2) {
    let videoUrl = null;
    let audioUrl = null;

    const isAudioPattern = /(audioclip|audio|sound|music|track|voice|masskara|\.(mp3|wav|m4a|ogg|aac))($|[?#])/i;
    const isVideoPattern = /(composition|video|movie|greybg|graybg|blackbg|greenbg|bluebg|original|\.(webm|mov|m4v))($|[?#])/i;

    for (const u of urlMatches) {
      if (isAudioPattern.test(u) && !audioUrl) {
        audioUrl = u;
      } else if (isVideoPattern.test(u) && !videoUrl) {
        videoUrl = u;
      } else if (!videoUrl) {
        videoUrl = u;
      } else if (!audioUrl) {
        audioUrl = u;
      }
    }

    if (videoUrl && audioUrl) {
      return { videoSource: videoUrl.trim(), audioSource: audioUrl.trim() };
    }
  }

  // 4. Pipe separator: "videoUrl | audioUrl"
  if (raw.includes('|')) {
    const parts = raw.split('|');
    let v = parts[0].trim();
    let a = parts[1].trim();
    if (a.toLowerCase().startsWith('audio=')) a = a.slice(6).trim();
    return { videoSource: v, audioSource: a || null };
  }

  // 5. Query parameters (?audio=... or &audio=...)
  try {
    const parsedUrl = new URL(raw, window.location.href);
    if (parsedUrl.searchParams.has('audio')) {
      const a = parsedUrl.searchParams.get('audio');
      parsedUrl.searchParams.delete('audio');
      return { videoSource: parsedUrl.toString(), audioSource: a };
    }
  } catch (e) {}

  let videoSource = raw;
  let audioSource = null;

  // 6. If video is from masskara1 folder and audio wasn't explicitly passed, auto-pair with audioclip
  if (videoSource.includes('/masskara1/')) {
    const baseFolder = videoSource.substring(0, videoSource.lastIndexOf('/masskara1/') + 11);
    audioSource = `${baseFolder}/audioclip-1788760841000-245087.mp4`;
  }

  return { videoSource, audioSource };
}

// ── Load GIF / Video / Image from Scanned QR Code ──────────────────────────
async function loadMediaFromQR(text) {
  if (!text) return;

  const { videoSource, audioSource } = parseMediaAndAudioFromQr(text);
  console.log('[QR Media] Video Source:', videoSource, '| Audio Source:', audioSource);

  // Immediately stop any previously playing audio when scanning new media
  stopPositionalAudio();

  if (audioSource) {
    const aToken = ++audioLoadToken;
    loadPositionalAudio(audioSource, aToken);
  } else {
    isAudioReady = false;
    audioBuffer = null;
    currentAudioUrl = null;
  }

  const resolvedUrl = resolveMediaUrl(videoSource);
  if (!resolvedUrl) return;

  // Automatically detect and apply chroma key mode based on file name or URL:
  detectAndApplyKeyModeFromUrl(resolvedUrl);

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

  // Direct detection by media extension for BOTH local and remote URLs (prevents downloading 60MB via fetch into RAM!)
  const isVideoExt = /\.(mp4|webm|mov|m4v|ogg)($|[?#])/i.test(resolvedUrl);
  const isGifExt   = /\.(gif)($|[?#])/i.test(resolvedUrl);
  const isImageExt = /\.(jpg|jpeg|png|webp)($|[?#])/i.test(resolvedUrl);
  const isGlbExt   = /\.(glb|gltf)($|[?#])/i.test(resolvedUrl);

  if (isVideoExt) {
    currentMediaType = 'video';
    loadVideoMedia(resolvedUrl, loadToken);
    return;
  }

  if (isGlbExt) {
    tryLoadGlb(resolvedUrl, loadToken);
    return;
  }

  if (isImageExt) {
    tryLoadImage(resolvedUrl, loadToken);
    return;
  }

  if (isGifExt) {
    tryLoadGif(resolvedUrl, loadToken);
    return;
  }

  updateLoadingBar(25, true);

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

      let isGlb = contentType.startsWith('model/') ||
        contentType.includes('gltf') ||
        /\.(glb|gltf)($|\?)/i.test(resolvedUrl);

      // Proactively detect GLB via standard 3D binary magic header 'glTF' (0x676C5446)
      try {
        const headerBuffer = await blob.slice(0, 4).arrayBuffer();
        if (headerBuffer.byteLength === 4) {
          const headerView = new DataView(headerBuffer);
          const magic = headerView.getUint32(0, false); // Big-endian 'glTF'
          if (magic === 0x676C5446) {
            isGlb = true;
          }
        }
      } catch (magicErr) {
        console.warn('Could not check magic bytes for GLB detection:', magicErr);
      }

      const isGif = contentType.includes('gif') || /\.(gif)($|\?)/i.test(resolvedUrl);
      const isImage = (contentType.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(resolvedUrl)) && !isGif;
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
  updateLoadingBar(50, true);

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
  updateLoadingBar(30, true);

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
      updateLoadingBar(30, true);
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

    setMediaReady(true);
  });
}

function tryLoadGlb(url, loadToken = ++mediaLoadToken) {
  currentMediaType = '3d';
  setMediaReady(false);
  updateLoadingBar(10);

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

  updateLoadingBar(15);

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
    },
    (xhr) => {
      if (loadToken !== mediaLoadToken) return;
      if (xhr.total) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        updateLoadingBar(percent);
      }
    },
    (err) => {
      if (loadToken !== mediaLoadToken) return;
      console.error('GLB load error:', err);
      updateLoadingBar(50, true);
    }
  );
}

function tryLoadImage(url, loadToken = ++mediaLoadToken) {
  currentMediaType = 'image';
  setMediaReady(false);
  updateLoadingBar(40, true);
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
    },
    undefined,
    (err) => {
      if (loadToken !== mediaLoadToken) return;
      console.warn('Image load error:', err);
      hideLoadingBar();
      if (arStarted) {
        setToast('QR scanned. Aim and tap to place');
      }
    }
  );
}

const VIDEO_ASPECT = 9 / 16;
const BILLBOARD_HEIGHT = 5.0; // 5 meters scale
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

function createGroundOcclusionShadow() {
  const geo = new THREE.PlaneGeometry(1.5, 1.5);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x000000) },
      uOpacity: { value: 0.55 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        vec2 center = vUv - vec2(0.5);
        float dist = length(center);

        if (dist > 0.5) discard;

        float coreShadow = (1.0 - smoothstep(0.0, 0.16, dist)) * 0.7;
        float outerShadow = (1.0 - smoothstep(0.1, 0.5, dist)) * 0.35;

        float alpha = (coreShadow + outerShadow) * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.002, 0);
  return mesh;
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
  const N = 36;
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
    pos[i * 3] = (Math.random() - 0.5) * 2.2;
    pos[i * 3 + 1] = Math.random() * 1.6 - 0.3;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
    const c = palette[i % palette.length];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.035, vertexColors: true, transparent: true, opacity: 0.6
  }));
}


function resetArSessionState() {
  arStarted = false;
  isPlaced = false;
  disablePlacementListener();
  lastHitPoseMatrix = null;
  detectedFloorHeight = null;
  resetDetectedPlaneGrids();
  if (floorGridMesh) floorGridMesh.visible = false;
  if (dancerGroup) {
    dancerGroup.visible = false;
    dancerGroup.scale.set(1, 1, 1);
  }
  if (dancerVideo) {
    dancerVideo.pause();
    dancerVideo.currentTime = 0;
  }
  const toast = toastEl || $('toast');
  if (toast) toast.classList.add('hidden');
  stopPositionalAudio();
}

function enablePlacementListener() {
  if (!arStarted || isPlaced) return;
  const canvas = $('ar-canvas');
  if (placementListenerAttached || typeof handlePlacementTap !== 'function') return;
  if (canvas) canvas.addEventListener('pointerdown', handlePlacementTap);
  window.addEventListener('pointerdown', handlePlacementTap);
  window.addEventListener('touchend', handlePlacementTap);
  placementListenerAttached = true;
}

function disablePlacementListener() {
  const canvas = $('ar-canvas');
  if (canvas && typeof handlePlacementTap === 'function') {
    canvas.removeEventListener('pointerdown', handlePlacementTap);
  }
  if (typeof handlePlacementTap === 'function') {
    window.removeEventListener('pointerdown', handlePlacementTap);
    window.removeEventListener('touchend', handlePlacementTap);
  }
  placementListenerAttached = false;
}

// ── Tap Anywhere on Floor Grid to Place & Reposition ────────────────────────
function onSelect() {
  if (!arStarted || isPlaced) return;
  if (performance.now() < ignorePlacementUntil) return;
  handleFloorTap(lastTapScreenX, lastTapScreenY);
}

function handleFloorTap(screenX = null, screenY = null) {
  if (!arStarted || isPlaced) return;
  if (performance.now() < ignorePlacementUntil) return;

  const targetPoint = new THREE.Vector3();
  let foundIntersection = false;

  // In WebXR, renderer.xr.getCamera() returns an ArrayCamera whose first child is the active eye perspective camera
  const xrCam = (renderer && renderer.xr && renderer.xr.isPresenting)
    ? renderer.xr.getCamera()
    : camera;
  const activeCam = (xrCam && xrCam.cameras && xrCam.cameras.length > 0)
    ? xrCam.cameras[0]
    : camera;

  activeCam.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();

  // Use the exact screen coordinate where user tapped; fallback to center only if completely unknown
  const tapX = (typeof screenX === 'number' && screenX > 0)
    ? screenX
    : (typeof lastTapScreenX === 'number' && lastTapScreenX > 0 ? lastTapScreenX : window.innerWidth / 2);
  const tapY = (typeof screenY === 'number' && screenY > 0)
    ? screenY
    : (typeof lastTapScreenY === 'number' && lastTapScreenY > 0 ? lastTapScreenY : window.innerHeight / 2);

  const mouse = new THREE.Vector2(
    (tapX / window.innerWidth) * 2 - 1,
    -(tapY / window.innerHeight) * 2 + 1
  );

  raycaster.setFromCamera(mouse, activeCam);

  // 1. Test intersection with detected floor grid meshes
  if (floorGridMesh && floorGridMesh.children.length > 0) {
    const planeMeshes = [];
    floorGridMesh.traverse((child) => {
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

  // 2. Intersect with horizontal ground plane at detected floor height
  const floorY = detectedFloorHeight !== null 
    ? detectedFloorHeight 
    : (lastHitPosition ? lastHitPosition.y : (activeCam.position.y - 1.2));

  if (!foundIntersection) {
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    if (raycaster.ray.intersectPlane(groundPlane, targetPoint)) {
      const camDir = new THREE.Vector3();
      activeCam.getWorldDirection(camDir);
      const toHit = targetPoint.clone().sub(activeCam.position);
      if (toHit.dot(camDir) > 0.05 && toHit.length() < 25) {
        foundIntersection = true;
      }
    }
  }

  // 3. Fallback: project along user's tapped ray direction at current depth instead of forcing screen center
  if (!foundIntersection) {
    const dist = lastHitPosition ? activeCam.position.distanceTo(lastHitPosition) : 1.8;
    targetPoint.copy(raycaster.ray.direction).multiplyScalar(dist).add(raycaster.ray.origin);
    targetPoint.y = floorY;
    foundIntersection = true;
  }

  if (foundIntersection) {
    if (dancerVideo && dancerVideo.paused) {
      dancerVideo.play().catch(() => { });
    }

    dancerGroup.position.copy(targetPoint);
    dancerGroup.userData.baseY = targetPoint.y;

    const cameraPos = new THREE.Vector3();
    activeCam.getWorldPosition(cameraPos);
    const angle = Math.atan2(
      cameraPos.x - dancerGroup.position.x,
      cameraPos.z - dancerGroup.position.z
    );
    dancerGroup.userData.baseRotY = angle;
    dancerGroup.rotation.set(0, angle, 0);

    placeDancer();
  } else {
    setToast('Point at floor to detect flat surface, then tap anywhere on grid');
  }
}

function placeDancer() {
  isPlaced = true;
  disablePlacementListener();

  // Reveal 3D Object / Video content
  dancerGroup.visible = true;

  // The pulsating floor grid disappears once placed!
  if (floorGridMesh) {
    floorGridMesh.visible = false;
  }

  // Reset video to start frame so video and audio begin in perfect unison
  if (dancerVideo) {
    dancerVideo.currentTime = 0;
    dancerVideo.play().catch(() => { });
  }

  // Spatial Positional 3D Audio : resume AudioContext and play from dancer in lock-step!
  resumeAudioContext();
  if (isAudioReady && !isAudioMuted) {
    if (positionalAudio) {
      positionalAudio.stop();
      positionalAudio._progress = 0;
    }
    syncAudioToVideo(true);
  }

  setToast('3D Object placed on floor');
  setTimeout(() => {
    toastEl?.classList.add('hidden');
    infoToggleBtnEl?.classList.remove('hidden');
    captureBtnEl?.classList.remove('hidden');
    recenterBtnEl?.classList.remove('hidden');
  }, 1500);
}

function repositionDancer() {
  ignorePlacementUntil = performance.now() + 800;
  isPlaced = false;
  if (dancerGroup) {
    dancerGroup.visible = false;
    dancerGroup.scale.set(1, 1, 1);
  }
  disablePlacementListener();

  // Stop positional audio and pause video while repositioning
  stopPositionalAudio();
  if (dancerVideo) {
    dancerVideo.pause();
    dancerVideo.currentTime = 0;
  }

  // Re-enable pulsating floor grid on detected floor surfaces
  if (floorGridMesh) {
    floorGridMesh.visible = true;
    floorGridMesh.traverse((child) => {
      if (child.isMesh) child.visible = true;
    });
  }

  historyModalEl?.classList.add('hidden');
  document.body.classList.remove('drawer-open');
  infoToggleBtnEl?.classList.add('hidden');
  captureBtnEl?.classList.add('hidden');
  recenterBtnEl?.classList.add('hidden');

  setToast('Point at floor plane and tap anywhere on grid to place');

  setTimeout(() => {
    if (arStarted && !isPlaced) {
      enablePlacementListener();
    }
  }, 600);
}


let captureRenderTarget = null;
let isCaptureRequested = false;
let capturePromiseResolver = null;
let cameraBackgroundScene = null;
let cameraBackgroundQuad = null;
let cameraBackgroundMaterial = null;

function getCameraBackgroundMesh() {
  if (!cameraBackgroundQuad) {
    const geo = new THREE.PlaneGeometry(2, 2);
    cameraBackgroundMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(map, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false
    });
    cameraBackgroundQuad = new THREE.Mesh(geo, cameraBackgroundMaterial);
    cameraBackgroundScene = new THREE.Scene();
    cameraBackgroundScene.add(cameraBackgroundQuad);
  }
  return { scene: cameraBackgroundScene, quad: cameraBackgroundQuad, mat: cameraBackgroundMaterial };
}

function requestARSnapshot() {
  return new Promise((resolve, reject) => {
    isCaptureRequested = true;
    capturePromiseResolver = { resolve, reject, timestamp: performance.now() };
    setTimeout(() => {
      if (isCaptureRequested && capturePromiseResolver) {
        capturePromiseResolver.reject(new Error('Capture timeout'));
        isCaptureRequested = false;
        capturePromiseResolver = null;
      }
    }, 4000);
  });
}

function triggerShutterFlash() {
  try {
    if ('vibrate' in navigator) navigator.vibrate([40, 30, 40]);
  } catch (e) {}

  const flash = document.createElement('div');
  flash.style.position = 'fixed';
  flash.style.inset = '0';
  flash.style.backgroundColor = '#ffffff';
  flash.style.opacity = '0.9';
  flash.style.zIndex = '99999';
  flash.style.pointerEvents = 'none';
  flash.style.transition = 'opacity 0.25s ease-out';
  document.body.appendChild(flash);

  requestAnimationFrame(() => {
    flash.style.opacity = '0';
    setTimeout(() => flash.remove(), 260);
  });
}

// ── Snapshot & Share ───────────────────────────────────────────────────────
function setupCapture() {
  captureBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    ignorePlacementUntil = performance.now() + 1000;

    triggerShutterFlash();

    // Temporarily hide all UI overlay elements for a clean photo
    const uiWrapper = $('ui-wrapper');
    if (uiWrapper) uiWrapper.style.opacity = '0';

    try {
      setToast('Capturing AR photo...', true);

      let capturedBlob = null;

      // Method 1: In-WebXR render snapshot (captures 3D models with camera texture from active frame)
      try {
        capturedBlob = await requestARSnapshot();
      } catch (xrSnapErr) {
        console.warn('Inside-loop capture fallback:', xrSnapErr);
      }

      // Method 2: Screen Capture API fallback if supported
      if (!capturedBlob && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser' },
            audio: false
          });

          const video = document.createElement('video');
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play();

          await new Promise((r) => setTimeout(r, 140));

          const W = video.videoWidth || window.innerWidth;
          const H = video.videoHeight || window.innerHeight;

          const outCanvas = document.createElement('canvas');
          outCanvas.width = W;
          outCanvas.height = H;
          const ctx = outCanvas.getContext('2d', { alpha: false });
          ctx.drawImage(video, 0, 0, W, H);

          stream.getTracks().forEach((t) => t.stop());

          capturedBlob = await new Promise((res) => outCanvas.toBlob(res, 'image/jpeg', 0.95));
        } catch (screenErr) {
          console.warn('Screen capture skipped/declined:', screenErr);
        }
      }

      // Method 3: Direct canvas toBlob fallback
      if (!capturedBlob) {
        const threeCanvas = $('ar-canvas');
        if (threeCanvas && threeCanvas.width > 0 && threeCanvas.height > 0) {
          capturedBlob = await new Promise((res) => threeCanvas.toBlob(res, 'image/jpeg', 0.95));
        }
      }

      if (capturedBlob) {
        await handleSaveOrSharePhoto(capturedBlob, 'bacolod-tourism-ar.jpg');
        setToast('AR Photo Saved!');
      } else {
        setToast('Capture failed.');
      }

    } catch (err) {
      console.error('AR Capture error:', err);
      setToast('Capture failed: ' + (err.message || err));
    } finally {
      if (uiWrapper) uiWrapper.style.opacity = '1';
    }
  });
}

async function handleSaveOrSharePhoto(blob, filename = 'bacolod-tourism-ar.jpg') {
  const file = new File([blob], filename, { type: 'image/jpeg' });

  // 1. Try Native Web Share API (allows direct saving to phone Photos / Gallery)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'Bacolod Tourism AR Photo',
        text: 'Exploring Bacolod in Augmented Reality! 🎭✨'
      });
      return;
    } catch (shareErr) {
      if (shareErr.name !== 'AbortError') {
        console.warn('Web Share failed, fallback to direct download:', shareErr);
      }
    }
  }

  // 2. Direct browser download fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer = null;
function setToast(msg, persist = false) {
  if (!toastEl) return;
  // If AR has not started yet, do not display surface detection/placement instruction toasts
  if (!arStarted && /tap|aim|point|grid|floor|place/i.test(msg)) {
    return;
  }
  const textSpan = toastEl.querySelector('#toast-text');
  if (textSpan) {
    textSpan.textContent = msg;
  } else {
    toastEl.textContent = msg;
  }
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (persist) return;

  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3000);
}


let lastOrientationAngle = null;

function updateLoadingBar(percent, isIndeterminate = false) {
  if (!loadingBarContainer || !loadingBar) return;

  loadingBarContainer.classList.remove('hidden');
  loadingBarContainer.style.opacity = '1';

  if (isIndeterminate) {
    loadingBar.classList.add('loading-bar--indeterminate');
    loadingBar.style.width = '100%';
  } else {
    loadingBar.classList.remove('loading-bar--indeterminate');
    const p = Math.min(Math.max(percent, 0), 100);
    loadingBar.style.width = `${p}%`;
  }
}

function hideLoadingBar() {
  if (!loadingBarContainer || !loadingBar) return;
  loadingBar.style.width = '100%';
  setTimeout(() => {
    loadingBarContainer.style.opacity = '0';
    setTimeout(() => {
      loadingBarContainer.classList.add('hidden');
      loadingBar.style.width = '0%';
      loadingBar.classList.remove('loading-bar--indeterminate');
    }, 300);
  }, 200);
}

// ── Visibility & Focus Handling ────────────────────────────────────────────
// If the user locks their phone, switches apps, or minimizes the browser: pause video and stop audio immediately
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (dancerVideo) dancerVideo.pause();
    pausePositionalAudio();
  } else {
    if (arStarted && isPlaced && dancerGroup && dancerGroup.visible && !isAudioMuted) {
      if (dancerVideo) {
        dancerVideo.play().catch(() => {});
      }
      syncAudioToVideo(true);
    }
  }
});

