import * as THREE from 'three';
import { arState } from '../ar/state.js';

export function getDancerAudioElement() {
  if (!arState.dancerAudioEl) {
    arState.dancerAudioEl = document.getElementById('dancer-audio');
    if (!arState.dancerAudioEl) {
      arState.dancerAudioEl = document.createElement('audio');
      arState.dancerAudioEl.id = 'dancer-audio';
      arState.dancerAudioEl.loop = false; // Controlled strictly by video loop sync
      arState.dancerAudioEl.playsInline = true;
      arState.dancerAudioEl.preload = 'auto';
      arState.dancerAudioEl.crossOrigin = 'anonymous';
      arState.dancerAudioEl.style.position = 'fixed';
      arState.dancerAudioEl.style.top = '-9999px';
      arState.dancerAudioEl.style.left = '-9999px';
      arState.dancerAudioEl.style.width = '1px';
      arState.dancerAudioEl.style.height = '1px';
      arState.dancerAudioEl.style.opacity = '0';
      arState.dancerAudioEl.style.pointerEvents = 'none';

      // If audio file ends before video loops, loop audio in lockstep with video
      arState.dancerAudioEl.addEventListener('ended', () => {
        if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
          const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
          if (dancerVideo && !dancerVideo.paused) {
            try {
              arState.dancerAudioEl.currentTime = 0;
              arState.dancerAudioEl.play().catch(() => {});
            } catch (e) {}
          }
        }
      });

      document.body.appendChild(arState.dancerAudioEl);
    }
  }
  return arState.dancerAudioEl;
}

export function resumeAudioContext() {
  const ctx = (arState.audioListener && arState.audioListener.context) ||
              (THREE.AudioContext && THREE.AudioContext.getContext && THREE.AudioContext.getContext());
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function syncAudioToVideo(force = false) {
  const audioEl = arState.dancerAudioEl || document.getElementById('dancer-audio');
  if (!audioEl || !arState.isAudioReady || arState.isAudioMuted) {
    return;
  }

  // 1. If AR has not started, object is not placed, or dancer is hidden -> stop audio immediately!
  if (!arState.arStarted || !arState.isPlaced || !arState.dancerGroup || !arState.dancerGroup.visible) {
    if (!audioEl.paused) audioEl.pause();
    return;
  }

  // 2. Check video playback state
  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  if (!dancerVideo) return;

  if (dancerVideo.paused || dancerVideo.seeking || dancerVideo.readyState < 2) {
    if (!audioEl.paused) audioEl.pause();
    return;
  }

  const now = performance.now();
  // Throttle non-forced sync calls to avoid performance overhead
  if (!force && (now - arState.lastAudioSyncTime < 200)) {
    return;
  }
  arState.lastAudioSyncTime = now;

  const targetTime = dancerVideo.currentTime;
  const drift = Math.abs(audioEl.currentTime - targetTime);

  // If video looped or drift exceeds 60ms, lock audio currentTime to video
  if (force || drift > 0.06) {
    try {
      audioEl.currentTime = targetTime;
    } catch (e) {}
  }

  if (audioEl.paused && !dancerVideo.paused) {
    resumeAudioContext();
    audioEl.play().catch(() => {});
  }
}

export function playPositionalAudio() {
  syncAudioToVideo(false);
}

export function pausePositionalAudio() {
  const audioEl = arState.dancerAudioEl || document.getElementById('dancer-audio');
  if (audioEl && !audioEl.paused) {
    try {
      audioEl.pause();
    } catch (e) {}
  }
  if (arState.positionalAudio && arState.positionalAudio.isPlaying) {
    try {
      arState.positionalAudio.pause();
    } catch (e) {}
  }
}

export function stopPositionalAudio() {
  const audioEl = arState.dancerAudioEl || document.getElementById('dancer-audio');
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch (e) {}
  }
  if (arState.positionalAudio && arState.positionalAudio.isPlaying) {
    try {
      arState.positionalAudio.stop();
    } catch (e) {}
  }
}

export function resolveAudioUrl(raw, resolveMediaUrlFn) {
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

  return resolveMediaUrlFn ? resolveMediaUrlFn(url) : url;
}

export async function loadPositionalAudio(rawUrl, token, resolveMediaUrlFn) {
  if (!rawUrl) return;
  const resolvedAudioUrl = resolveAudioUrl(rawUrl, resolveMediaUrlFn);
  if (!resolvedAudioUrl) return;

  console.log('[Audio] Streaming audio from:', resolvedAudioUrl);
  arState.currentAudioUrl = resolvedAudioUrl;
  arState.isAudioReady = false;
  stopPositionalAudio();

  const audioEl = getDancerAudioElement();
  audioEl.src = resolvedAudioUrl;
  audioEl.muted = false;
  audioEl.volume = arState.isAudioMuted ? 0 : 1.0;
  audioEl.currentTime = 0;
  audioEl.load();

  const onCanPlay = () => {
    if (token !== arState.audioLoadToken) return;
    audioEl.removeEventListener('canplay', onCanPlay);
    arState.isAudioReady = true;
    console.log('[Audio] Audio stream ready for playback');

    if (arState.arStarted && arState.isPlaced && arState.dancerGroup && arState.dancerGroup.visible && !arState.isAudioMuted) {
      syncAudioToVideo(true);
    }
  };

  audioEl.addEventListener('canplay', onCanPlay);
  audioEl.addEventListener('loadeddata', onCanPlay);
  audioEl.addEventListener('playing', () => {
    arState.isAudioReady = true;
  });
  audioEl.addEventListener('error', (e) => {
    console.warn('[Audio] Direct stream error, trying proxy URL:', e);
    if (token === arState.audioLoadToken && !resolvedAudioUrl.includes('corsproxy.io')) {
      const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(resolvedAudioUrl)}`;
      audioEl.src = proxyUrl;
      audioEl.load();
    }
  });
}
