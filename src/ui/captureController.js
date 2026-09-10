import * as THREE from 'three';
import { arState } from '../ar/state.js';
import { dom, $ } from './domElements.js';
import { setToast } from './toast.js';
import { getCameraBackgroundMesh } from '../shaders/backgroundShader.js';

export function requestARSnapshot() {
  return new Promise((resolve, reject) => {
    arState.isCaptureRequested = true;
    arState.capturePromiseResolver = { resolve, reject, timestamp: performance.now() };
    setTimeout(() => {
      if (arState.isCaptureRequested && arState.capturePromiseResolver) {
        arState.capturePromiseResolver.reject(new Error('Capture timeout'));
        arState.isCaptureRequested = false;
        arState.capturePromiseResolver = null;
      }
    }, 4000);
  });
}

export function executeCaptureFrame(frame) {
  const resolver = arState.capturePromiseResolver;
  arState.isCaptureRequested = false;
  arState.capturePromiseResolver = null;

  const renderer = arState.renderer;
  const scene = arState.scene;
  const camera = arState.camera;

  try {
    const W = Math.min(Math.round(window.innerWidth * (window.devicePixelRatio || 1)), 1920);
    const H = Math.min(Math.round(window.innerHeight * (window.devicePixelRatio || 1)), 1920);

    if (!arState.captureRenderTarget || arState.captureRenderTarget.width !== W || arState.captureRenderTarget.height !== H) {
      if (arState.captureRenderTarget) arState.captureRenderTarget.dispose();
      arState.captureRenderTarget = new THREE.WebGLRenderTarget(W, H, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace
      });
    }

    const prevRenderTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(arState.captureRenderTarget);
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
    renderer.readRenderTargetPixels(arState.captureRenderTarget, 0, 0, W, H, pixelBuffer);
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

export function triggerShutterFlash() {
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

export async function handleSaveOrSharePhoto(blob, filename = 'bacolod-tourism-ar.jpg') {
  const file = new File([blob], filename, { type: 'image/jpeg' });

  // 1. Try Native Web Share API
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

export function setupCapture() {
  const captureBtnEl = dom.captureBtn;
  captureBtnEl?.addEventListener('click', async (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 1000;

    triggerShutterFlash();

    const uiWrapper = dom.uiWrapper;
    if (uiWrapper) uiWrapper.style.opacity = '0';

    try {
      setToast('Capturing AR photo...', true);

      let capturedBlob = null;

      // Method 1: In-WebXR render snapshot
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
        const threeCanvas = dom.arCanvas;
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
