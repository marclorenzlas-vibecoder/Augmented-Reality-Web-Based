import * as THREE from 'three';
import { arState } from '../ar/state.js';
import { dom } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { updateLoadingBar, hideLoadingBar } from '../ui/loadingBar.js';
import { GifPlayer } from './gifPlayer.js';
import {
  detectAndApplyKeyModeFromUrl,
  autoDetectKeyModeFromVideo
} from '../shaders/chromaShader.js';
import {
  stopPositionalAudio,
  pausePositionalAudio,
  loadPositionalAudio,
  syncAudioToVideo
} from '../audio/audioController.js';
import {
  applyVideoToBillboard,
  applyTextureToBillboard,
  updateVideoBillboardGeometry
} from '../ar/billboard.js';

export function resolveKnownLocalMedia(text) {
  const normalized = text.trim().replace(/_mp4($|[?#])/i, '.mp4$1');

  if (/MaxwellNB\.mp4($|[?#])/i.test(normalized) || /MaxwellNB/i.test(normalized)) {
    return '/MaxwellNB.mp4';
  }

  if (/Maxwell\.mp4($|[?#])/i.test(normalized) || /Maxwell/i.test(normalized)) {
    return '/Maxwell.mp4';
  }

  return null;
}

export function resolveMediaUrl(raw) {
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

export function parseMediaAndAudioFromQr(text) {
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

export function setMediaReady(ready) {
  arState.isMediaReady = ready;
  if (arState.videoMesh) {
    arState.videoMesh.visible = ready;
  }
  if (!ready) {
    stopPositionalAudio();
  }
  const arBtn = document.getElementById('ARButton');
  if (ready) {
    hideLoadingBar();
    const qrScreenEl = dom.qrScreen;
    // Only display ARButton if the QR scanner screen is hidden (i.e. user is in AR mode)
    if (qrScreenEl && qrScreenEl.classList.contains('hidden')) {
      if (arBtn) arBtn.style.display = 'block';
    }
  } else {
    if (arBtn) arBtn.style.display = 'none';
  }
}

export function resetCurrentTexture() {
  if (arState.currentTexture) {
    arState.currentTexture.dispose();
    arState.currentTexture = null;
  }

  if (arState.gifTexture) {
    arState.gifTexture.dispose();
    arState.gifTexture = null;
  }

  if (arState.currentGifPlayer) {
    arState.currentGifPlayer.destroy();
    arState.currentGifPlayer = null;
  }
  arState.gifCanvas = null;
  arState.isGifMediaType = false;

  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;

  if (arState.currentBlobUrl) {
    URL.revokeObjectURL(arState.currentBlobUrl);
    arState.currentBlobUrl = null;
  }
}

export function markVideoReady(loadToken) {
  if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;

  applyVideoToBillboard();
  setMediaReady(true);
  if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible) {
    arState.dancerVideo?.play().catch(() => { });
    syncAudioToVideo(true);
  } else {
    arState.dancerVideo?.pause();
    stopPositionalAudio();
  }
}

export function describeVideoError() {
  const mediaError = arState.dancerVideo?.error;
  if (!mediaError) return 'Unknown video load error';

  const messages = {
    1: 'Video loading was aborted',
    2: 'Network error while loading video',
    3: 'Video decode error',
    4: 'Video format is not supported by this browser'
  };

  return messages[mediaError.code] || `Video error ${mediaError.code}`;
}

export function hasDecodedVideoFrame() {
  const video = arState.dancerVideo;
  return !!(
    video &&
    video.videoWidth > 0 &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  );
}

export async function loadVideoViaBlob(url, loadToken) {
  if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;

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
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;

    if (blob.type && (blob.type.startsWith('text/') || blob.type.startsWith('application/json'))) {
      throw new Error(`Unexpected media type: ${blob.type}`);
    }

    updateLoadingBar(80, true);
    arState.currentBlobUrl = URL.createObjectURL(blob);
    loadVideoMedia(arState.currentBlobUrl, loadToken, { allowBlobFallback: false });
  } catch (err) {
    clearTimeout(timeoutId);
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;
    console.warn('Video blob fallback failed:', err);
    hideLoadingBar();
    setToast('Video loading error', false);
  }
}

export function loadVideoMedia(url, loadToken, { allowBlobFallback = true } = {}) {
  const video = arState.dancerVideo;
  if (!video) return;
  updateLoadingBar(20, true);

  let timeoutId = null;
  let fallbackId = null;
  const cleanup = () => {
    clearTimeout(timeoutId);
    clearTimeout(fallbackId);
    video.removeEventListener('loadedmetadata', onReady);
    video.removeEventListener('loadeddata', onReady);
    video.removeEventListener('canplay', onReady);
    video.removeEventListener('playing', onReady);
    video.removeEventListener('error', onError);
  };

  const readyStateCheck = () => {
    if (loadToken !== arState.mediaLoadToken) {
      cleanup();
      return;
    }

    if (hasDecodedVideoFrame()) {
      cleanup();
      markVideoReady(loadToken);
    }
  };

  const onReady = () => {
    if (loadToken !== arState.mediaLoadToken) {
      cleanup();
      return;
    }

    if (hasDecodedVideoFrame()) {
      cleanup();
      markVideoReady(loadToken);
    }
  };

  const onError = () => {
    if (loadToken !== arState.mediaLoadToken) {
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

  video.pause();
  pausePositionalAudio();
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';

  video.addEventListener('loadedmetadata', onReady);
  video.addEventListener('loadeddata', onReady);
  video.addEventListener('canplay', onReady);
  video.addEventListener('playing', onReady);
  video.addEventListener('error', onError);

  video.src = url;
  video.load();
  video.play().catch(() => {});

  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(() => {
      readyStateCheck();
    });
  }

  setTimeout(readyStateCheck, 0);
  setTimeout(readyStateCheck, 250);

  // If after 4s no metadata/frames are ready, try blob fallback
  fallbackId = setTimeout(() => {
    if (!allowBlobFallback || loadToken !== arState.mediaLoadToken || arState.isMediaReady || hasDecodedVideoFrame()) return;
    loadVideoViaBlob(url, loadToken);
    setTimeout(readyStateCheck, 1000);
  }, 4000);

  timeoutId = setTimeout(() => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady || hasDecodedVideoFrame()) return;
    cleanup();
    hideLoadingBar();
    setToast('Video loading timed out', false);
  }, 15000);
}

export async function tryLoadGif(urlOrBuffer, loadToken = ++arState.mediaLoadToken) {
  arState.currentMediaType = 'image';
  arState.isGifMediaType = true;
  setMediaReady(false);
  updateLoadingBar(30, true);

  // Clean up any existing GLB
  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;

  if (arState.currentGifPlayer) {
    arState.currentGifPlayer.destroy();
    arState.currentGifPlayer = null;
  }
  arState.gifCanvas = null;

  if (arState.videoMesh) {
    arState.videoMesh.visible = false;
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

  if (loadToken !== arState.mediaLoadToken) return;

  arState.gifCanvas = document.createElement('canvas');
  arState.gifTexture = new THREE.CanvasTexture(arState.gifCanvas);
  arState.gifTexture.minFilter = THREE.LinearFilter;
  arState.gifTexture.magFilter = THREE.LinearFilter;
  arState.gifTexture.colorSpace = THREE.SRGBColorSpace;

  arState.currentGifPlayer = new GifPlayer(buffer, arState.gifCanvas, arState.gifTexture, () => {
    if (loadToken !== arState.mediaLoadToken) {
      if (arState.currentGifPlayer) {
        arState.currentGifPlayer.destroy();
        arState.currentGifPlayer = null;
      }
      return;
    }

    arState.currentTexture = arState.gifTexture;
    applyTextureToBillboard(arState.gifTexture);
    setMediaReady(true);
  });
}

export function tryLoadGlb(url, loadToken = ++arState.mediaLoadToken) {
  arState.currentMediaType = '3d';
  setMediaReady(false);
  updateLoadingBar(10);

  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;

  if (arState.videoMesh) {
    arState.videoMesh.visible = false;
  }

  updateLoadingBar(15);

  arState.gltfLoader.load(
    url,
    (gltf) => {
      if (loadToken !== arState.mediaLoadToken) return;

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
        arState.mixer = new THREE.AnimationMixer(model);
        const action = arState.mixer.clipAction(gltf.animations[0]);
        action.play();
      }

      arState.currentGlbModel = model;
      if (arState.dancerGroup) {
        arState.dancerGroup.add(model);
      }

      setMediaReady(true);
    },
    (xhr) => {
      if (loadToken !== arState.mediaLoadToken) return;
      if (xhr.total) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        updateLoadingBar(percent);
      }
    },
    (err) => {
      if (loadToken !== arState.mediaLoadToken) return;
      console.error('GLB load error:', err);
      updateLoadingBar(50, true);
    }
  );
}

export function tryLoadImage(url, loadToken = ++arState.mediaLoadToken) {
  arState.currentMediaType = 'image';
  setMediaReady(false);
  updateLoadingBar(40, true);
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    url,
    (tex) => {
      if (loadToken !== arState.mediaLoadToken) {
        tex.dispose();
        return;
      }
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      arState.currentTexture = tex;
      applyTextureToBillboard(tex);
      setMediaReady(true);
    },
    undefined,
    (err) => {
      if (loadToken !== arState.mediaLoadToken) return;
      console.warn('Image load error:', err);
      hideLoadingBar();
      if (arState.arStarted) {
        setToast('QR scanned. Aim and tap to place');
      }
    }
  );
}

export async function loadMediaFromQR(text) {
  if (!text) return;

  const { videoSource, audioSource } = parseMediaAndAudioFromQr(text);
  console.log('[QR Media] Video Source:', videoSource, '| Audio Source:', audioSource);

  stopPositionalAudio();

  if (audioSource) {
    const aToken = ++arState.audioLoadToken;
    loadPositionalAudio(audioSource, aToken, resolveMediaUrl);
  } else {
    arState.isAudioReady = false;
    arState.audioBuffer = null;
    arState.currentAudioUrl = null;
  }

  const resolvedUrl = resolveMediaUrl(videoSource);
  if (!resolvedUrl) return;

  detectAndApplyKeyModeFromUrl(resolvedUrl);

  const loadToken = ++arState.mediaLoadToken;
  setMediaReady(false);
  resetCurrentTexture();
  arState.currentMediaUrl = resolvedUrl;

  const isLocal = resolvedUrl.startsWith('/') ||
    resolvedUrl.startsWith('./') ||
    resolvedUrl.startsWith('../') ||
    resolvedUrl.startsWith(window.location.origin);

  const isUrl = resolvedUrl.startsWith('http://') || resolvedUrl.startsWith('https://') || isLocal;

  if (!isUrl) {
    arState.currentMediaType = 'video';
    loadVideoMedia(resolvedUrl, loadToken);
    return;
  }

  const isVideoExt = /\.(mp4|webm|mov|m4v|ogg)($|[?#])/i.test(resolvedUrl);
  const isGifExt   = /\.(gif)($|[?#])/i.test(resolvedUrl);
  const isImageExt = /\.(jpg|jpeg|png|webp)($|[?#])/i.test(resolvedUrl);
  const isGlbExt   = /\.(glb|gltf)($|[?#])/i.test(resolvedUrl);

  if (isVideoExt) {
    arState.currentMediaType = 'video';
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

  try {
    response = await fetch(resolvedUrl);
  } catch (err) {
    console.warn('Direct fetch failed, trying CORS proxy:', err);
    errorMsg = err.message || err;
  }

  if (!response || !response.ok) {
    try {
      const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(resolvedUrl);
      response = await fetch(proxyUrl);
    } catch (err) {
      console.warn('CORS proxy fetch failed, trying backup proxy:', err);
      errorMsg = err.message || err;
    }
  }

  if (!response || !response.ok) {
    try {
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(resolvedUrl);
      response = await fetch(proxyUrl);
    } catch (err) {
      console.warn('Backup proxy fetch failed:', err);
      errorMsg = err.message || err;
    }
  }

  if (response && response.ok) {
    try {
      const blob = await response.blob();
      const contentType = blob.type || response.headers.get('Content-Type') || '';

      let isGlb = contentType.startsWith('model/') ||
        contentType.includes('gltf') ||
        /\.(glb|gltf)($|\?)/i.test(resolvedUrl);

      try {
        const headerBuffer = await blob.slice(0, 4).arrayBuffer();
        if (headerBuffer.byteLength === 4) {
          const headerView = new DataView(headerBuffer);
          const magic = headerView.getUint32(0, false);
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

      arState.currentBlobUrl = URL.createObjectURL(blob);

      if (isGlb) {
        tryLoadGlb(arState.currentBlobUrl, loadToken);
      } else if (isGif) {
        const buffer = await blob.arrayBuffer();
        tryLoadGif(buffer, loadToken);
      } else if (isImage && !isVideo) {
        tryLoadImage(arState.currentBlobUrl, loadToken);
      } else {
        arState.currentMediaType = 'video';
        loadVideoMedia(arState.currentBlobUrl, loadToken, { allowBlobFallback: false });
      }
      return;
    } catch (err) {
      console.error('Failed to process media blob:', err);
      errorMsg = err.message || err;
    }
  }

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
      arState.currentMediaType = 'video';
      loadVideoMedia(resolvedUrl, loadToken);
    }
  }
}
