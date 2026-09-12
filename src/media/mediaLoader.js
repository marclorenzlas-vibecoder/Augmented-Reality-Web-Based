import * as THREE from 'three';
import { arState } from '../ar/state.js';
import { dom } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import {
  updateLoadingBar,
  hideLoadingBar,
  showCircularLoader,
  updateCircularProgress,
  completeAndRevealArButton
} from '../ui/loadingBar.js';
import { GifPlayer } from './gifPlayer.js';
import {
  detectAndApplyKeyModeFromUrl,
  autoDetectKeyModeFromVideo,
  applyKeySettings
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
  if (!text) return null;
  const trimmed = text.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('data:')
  ) {
    return null;
  }

  const normalized = trimmed
    .replace(/_mp4($|[?#])/i, '.mp4$1')
    .replace(/_webm($|[?#])/i, '.webm$1')
    .replace(/_glb($|[?#])/i, '.glb$1')
    .replace(/_gltf($|[?#])/i, '.gltf$1')
    .replace(/_gif($|[?#])/i, '.gif$1')
    .replace(/_png($|[?#])/i, '.png$1')
    .replace(/_jpg($|[?#])/i, '.jpg$1')
    .replace(/_jpeg($|[?#])/i, '.jpeg$1');

  const hasMediaExt = /\.(mp4|webm|mov|ogg|m4v|glb|gltf|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac)($|[?#])/i.test(normalized);
  if (hasMediaExt) {
    if (normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) {
      return normalized;
    }
    return '/' + normalized;
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
    const isMediaPath = /\.(mp4|webm|mov|ogg|m4v|glb|gltf|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac)($|\?)/i.test(parsedUrl.pathname);
    const isViteDevMedia = parsedUrl.origin === window.location.origin;

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

  // Handle OneDrive direct links
  if (url.includes('1drv.ms') || url.includes('onedrive.live.com')) {
    return url.replace('redir?', 'download?');
  }

  return url;
}

export function parseMediaAndAudioFromQr(text) {
  if (!text) return { videoSource: '', audioSource: null };
  const raw = text.trim();

  // 1. JSON payload support: {"video": "...", "audio": "..."} or {"url": "...", "sound": "..."} or {"media": "...", "music": "..."}
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      const v = obj.video || obj.mp4 || obj.url || obj.media || obj.src || obj.model || obj.image || obj.file;
      const a = obj.audio || obj.sound || obj.music || obj.track || obj.audioUrl || obj.soundUrl;
      if (v) return { videoSource: String(v).trim(), audioSource: a ? String(a).trim() : null };
    } catch (e) {}
  }

  // 2. Query parameters (?audio=... or &audio=... or ?sound=... or ?music=...)
  try {
    const parsedUrl = new URL(raw, window.location.href);
    if (parsedUrl.searchParams.has('audio') || parsedUrl.searchParams.has('sound') || parsedUrl.searchParams.has('music') || parsedUrl.searchParams.has('track')) {
      const a = parsedUrl.searchParams.get('audio') || parsedUrl.searchParams.get('sound') || parsedUrl.searchParams.get('music') || parsedUrl.searchParams.get('track');
      parsedUrl.searchParams.delete('audio');
      parsedUrl.searchParams.delete('sound');
      parsedUrl.searchParams.delete('music');
      parsedUrl.searchParams.delete('track');
      return { videoSource: parsedUrl.toString(), audioSource: a ? a.trim() : null };
    }
  } catch (e) {}

  // 3. Pipe separator: "videoUrl | audioUrl"
  if (raw.includes('|')) {
    const parts = raw.split('|');
    let v = parts[0].trim();
    let a = parts[1].trim();
    if (a.toLowerCase().startsWith('audio=')) a = a.slice(6).trim();
    if (a.toLowerCase().startsWith('sound=')) a = a.slice(6).trim();
    if (a.toLowerCase().startsWith('music=')) a = a.slice(6).trim();
    if (a.toLowerCase().startsWith('track=')) a = a.slice(6).trim();
    return { videoSource: v, audioSource: a || null };
  }

  // 4. Extract multiple URLs from text (separated by space, newlines, commas, etc.)
  const urlMatches = raw.match(/https?:\/\/[^\s"',|]+/gi);
  if (urlMatches && urlMatches.length >= 2) {
    let videoUrl = null;
    let audioUrl = null;

    const isAudioPattern = /(audio|sound|music|track|voice|\.(mp3|wav|m4a|ogg|aac))($|[?#])/i;
    const isVideoPattern = /(video|movie|media|\.(mp4|webm|mov|m4v|glb|gltf|jpg|jpeg|png|webp|gif))($|[?#])/i;

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

    if (videoUrl) {
      return { videoSource: videoUrl.trim(), audioSource: audioUrl ? audioUrl.trim() : null };
    }
  }

  // 5. Single URL, path, or arbitrary media endpoint
  const cleanUrl = raw.replace(/\/+$/, '');
  let videoSource = cleanUrl;
  let audioSource = null;

  // If a File Garden folder URL is passed without a specific filename, link to the media & companion audio inside it
  if (cleanUrl.includes('file.garden') && !/\.(mp4|webm|mov|ogg|m4v|glb|gltf|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac)($|[?#])/i.test(cleanUrl)) {
    videoSource = `${cleanUrl}/Composition_greybg.mp4`;
    audioSource = `${cleanUrl}/audioclip-1788760841000-245087.mp4`;
  }

  // If video is an MP4/video file and no separate audio URL was supplied,
  // feed the video file itself to spatial audio so embedded sound plays with 3D audio!
  if (!audioSource && /\.(mp4|webm|mov|m4v)($|[?#])/i.test(videoSource)) {
    audioSource = videoSource;
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
    showCircularLoader();
  }
  const arBtn = document.getElementById('ARButton');
  const landingScreen = dom.landingScreen || document.getElementById('landing-screen');
  if (ready) {
    hideLoadingBar();
    const qrScreenEl = dom.qrScreen;
    // Only display ARButton and landing screen if the QR scanner screen is hidden (i.e. user is in AR mode) and not currently presenting
    if (qrScreenEl && qrScreenEl.classList.contains('hidden') && !arState.arStarted) {
      if (landingScreen) landingScreen.classList.remove('hidden');
      completeAndRevealArButton();
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

  try {
    updateLoadingBar(25, true);
    updateCircularProgress(25, 'Downloading media…');
    const response = await fetch(url, {
      cache: 'reload'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;

    if (blob.type && (blob.type.startsWith('text/') || blob.type.startsWith('application/json'))) {
      throw new Error(`Unexpected media type: ${blob.type}`);
    }

    updateLoadingBar(85, true);
    updateCircularProgress(85, 'Processing media stream…');
    arState.currentBlobUrl = URL.createObjectURL(blob);
    loadVideoMedia(arState.currentBlobUrl, loadToken, { allowBlobFallback: false });
  } catch (err) {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;
    console.warn('Video blob fallback failed:', err);
  }
}

export function loadVideoMedia(url, loadToken, { allowBlobFallback = true } = {}) {
  const video = arState.dancerVideo;
  if (!video) return;
  showCircularLoader();
  updateLoadingBar(20, true);
  updateCircularProgress(20, 'Buffering media…');

  let progressInterval = null;

  const cleanup = () => {
    if (progressInterval) clearInterval(progressInterval);
    video.removeEventListener('loadedmetadata', onMetadata);
    video.removeEventListener('loadeddata', onLoadedData);
    video.removeEventListener('canplay', checkBufferComplete);
    video.removeEventListener('canplaythrough', checkBufferComplete);
    video.removeEventListener('playing', checkBufferComplete);
    video.removeEventListener('progress', onProgress);
    video.removeEventListener('error', onError);
  };

  const checkBufferComplete = () => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) {
      return;
    }

    if (!hasDecodedVideoFrame()) {
      return;
    }

    // Video has decoded first frame and is ready to display!
    if (video.readyState >= 2 || (video.buffered.length > 0 && video.duration > 0)) {
      cleanup();
      updateCircularProgress(100, 'Ready!');
      markVideoReady(loadToken);
    }
  };

  const onMetadata = () => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;
    updateCircularProgress(50, 'Buffering media…');
    updateLoadingBar(50);
    checkBufferComplete();
  };

  const onLoadedData = () => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;
    updateCircularProgress(85, 'Finalizing AR scene…');
    updateLoadingBar(85);
    checkBufferComplete();
    setTimeout(checkBufferComplete, 60);
  };

  const onProgress = () => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) return;
    if (video.buffered.length > 0 && video.duration > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const pct = Math.min(Math.round((bufferedEnd / video.duration) * 100), 100);
      const displayPct = Math.max(30, Math.min(95, pct));
      updateCircularProgress(displayPct, `Buffering media (${displayPct}%)…`);
      updateLoadingBar(displayPct);
      checkBufferComplete();
    }
  };

  const onError = () => {
    if (loadToken !== arState.mediaLoadToken) {
      cleanup();
      return;
    }

    cleanup();
    console.warn('Video stream error, trying fallback:', describeVideoError());

    if (allowBlobFallback) {
      loadVideoViaBlob(url, loadToken);
    } else {
      setToast(`Could not decode video: ${describeVideoError()}`, true);
    }
  };

  // Fast responsive heartbeat while loading initial video frame
  let simProgress = 25;
  progressInterval = setInterval(() => {
    if (loadToken !== arState.mediaLoadToken || arState.isMediaReady) {
      clearInterval(progressInterval);
      return;
    }
    if (simProgress < 85) {
      simProgress += 15;
      updateCircularProgress(simProgress, `Buffering media (${simProgress}%)…`);
      updateLoadingBar(simProgress);
    }
    checkBufferComplete();
  }, 200);

  video.pause();
  pausePositionalAudio();
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';

  video.addEventListener('loadedmetadata', onMetadata);
  video.addEventListener('loadeddata', onLoadedData);
  video.addEventListener('canplay', checkBufferComplete);
  video.addEventListener('canplaythrough', checkBufferComplete);
  video.addEventListener('playing', checkBufferComplete);
  video.addEventListener('progress', onProgress);
  video.addEventListener('error', onError);

  video.src = url;
  video.load();
  video.play().catch(() => {});

  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(() => {
      checkBufferComplete();
    });
  }

  setTimeout(checkBufferComplete, 80);
  setTimeout(checkBufferComplete, 250);
  setTimeout(checkBufferComplete, 600);
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
    applyKeySettings(0);
    applyTextureToBillboard(arState.gifTexture);
    setMediaReady(true);
  });
}

export async function tryLoadGlb(urlOrBuffer, loadToken = ++arState.mediaLoadToken) {
  arState.currentMediaType = '3d';
  setMediaReady(false);
  updateLoadingBar(15, true);

  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;

  if (arState.videoMesh) {
    arState.videoMesh.visible = false;
  }

  let buffer;
  if (typeof urlOrBuffer === 'string') {
    try {
      updateLoadingBar(30, true);
      const res = await fetch(urlOrBuffer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = await res.arrayBuffer();
    } catch (err) {
      console.warn("Direct GLB fetch failed, trying proxy:", err);
      try {
        const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(urlOrBuffer);
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = await res.arrayBuffer();
      } catch (proxyErr) {
        try {
          const backupProxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(urlOrBuffer);
          const res = await fetch(backupProxy);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buffer = await res.arrayBuffer();
        } catch (backupErr) {
          console.error("All GLB fetch attempts failed:", backupErr);
          setToast("Failed to load 3D model.");
          hideLoadingBar();
          setMediaReady(true);
          return;
        }
      }
    }
  } else {
    buffer = urlOrBuffer;
  }

  if (loadToken !== arState.mediaLoadToken) return;
  updateLoadingBar(60, true);

  arState.gltfLoader.parse(
    buffer,
    '',
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
        for (const clip of gltf.animations) {
          const action = arState.mixer.clipAction(clip);
          action.play();
        }
      }

      arState.currentGlbModel = model;
      if (arState.dancerGroup) {
        arState.dancerGroup.add(model);
        arState.dancerGroup.visible = true;

        if (arState.groundShadowMesh) {
          arState.groundShadowMesh.visible = true;
          if (!arState.dancerGroup.children.includes(arState.groundShadowMesh)) {
            arState.dancerGroup.add(arState.groundShadowMesh);
          }
          const footprint = Math.max(size.x * scale, size.z * scale) * 1.5;
          arState.groundShadowMesh.scale.set(Math.max(footprint, 0.8) * 0.5, Math.max(footprint, 0.8) * 0.5, 1);
        }
      }

      setMediaReady(true);
      hideLoadingBar();
      if (arState.arStarted) {
        setToast('3D Model Ready! Aim and tap to place.');
      }
    },
    (err) => {
      if (loadToken !== arState.mediaLoadToken) return;
      console.error('GLB parse error:', err);
      setToast('Error loading 3D Model.');
      hideLoadingBar();
      setMediaReady(true);
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
      applyKeySettings(0);
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

  const isGlbExt   = /\.(glb|gltf)($|[?#])/i.test(resolvedUrl);
  const isImageExt = /\.(jpg|jpeg|png|webp)($|[?#])/i.test(resolvedUrl);
  const isGifExt   = /\.(gif)($|[?#])/i.test(resolvedUrl);

  if (isGlbExt) {
    tryLoadGlb(resolvedUrl, loadToken);
    return;
  }

  if (isGifExt) {
    tryLoadGif(resolvedUrl, loadToken);
    return;
  }

  if (isImageExt) {
    tryLoadImage(resolvedUrl, loadToken);
    return;
  }

  // Direct fast streaming for all video URLs and extensionless media endpoints
  arState.currentMediaType = 'video';
  loadVideoMedia(resolvedUrl, loadToken);
}
