import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { arState } from '../ar/state.js';
import { dom, $ } from '../ui/domElements.js';
import { setToast } from '../ui/toast.js';
import { QR_CAMERA_CONFIG, CAMERA_RELEASE_DELAY_MS, wait } from '../config/constants.js';
import { loadMediaFromQR } from '../media/mediaLoader.js';
import { startUniversalAR } from '../ar/scene.js';

export function classifyCameraError(err) {
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

export function showCameraError(message) {
  const cameraErrorEl = dom.cameraError || $('camera-error-msg');
  if (!cameraErrorEl) return;

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
      initCameraWithPermissionCheck();
    }, { once: true });
  }
}

export function initCameraWithPermissionCheck() {
  console.log('[Camera] Checking environment…');
  console.log('[Camera] isSecureContext:', window.isSecureContext);
  console.log('[Camera] location.protocol:', location.protocol);
  console.log('[Camera] navigator.mediaDevices available:', !!navigator.mediaDevices);

  if (!window.isSecureContext) {
    const errMsg = 'Camera requires HTTPS. You are on ' + location.protocol + '//' + location.host +
      '. Please open https://localhost:5173 instead, or use the HTTPS network URL shown by Vite.';
    console.error('[Camera]', errMsg);
    showCameraError(errMsg);
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const errMsg = 'navigator.mediaDevices.getUserMedia is not available in this browser. ' +
      'Try Chrome, Firefox, or Safari on HTTPS.';
    console.error('[Camera]', errMsg);
    showCameraError(errMsg);
    return;
  }

  console.log('[Camera] Pre-flight getUserMedia probe starting…');
  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    })
    .then((testStream) => {
      console.log('[Camera] Pre-flight OK — permission granted. Releasing test stream.');
      testStream.getTracks().forEach(t => t.stop());

      initCustomQrScanner().catch(err => {
        console.error('[Camera] initCustomQrScanner failed after permission granted:', err);
        showCameraError(classifyCameraError(err));
      });
    })
    .catch((err) => {
      console.error('[Camera] Pre-flight getUserMedia failed:', err);
      const errMsg = classifyCameraError(err);

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

export async function initCustomQrScanner() {
  try {
    if (!arState.html5QrCode) {
      try {
        arState.html5QrCode = new Html5Qrcode('qr-reader', {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true
          },
          verbose: false
        });
      } catch (err) {
        console.warn('[Camera] Fallback standard Html5Qrcode init:', err);
        arState.html5QrCode = new Html5Qrcode('qr-reader');
      }
    }

    console.log('[Camera] Starting html5-qrcode scanner with facingMode:environment…');
    await startQrCamera();
    console.log('[Camera] html5-qrcode scanner started successfully.');

  } catch (err) {
    console.error('[Camera] QR Scanner init error:', err);
    throw err;
  }
}

export function queueQrCameraTask(task) {
  arState.qrCameraTask = arState.qrCameraTask.catch(() => { }).then(task);
  return arState.qrCameraTask;
}

export function clearQrRestartTimer() {
  if (arState.restartQrTimer) {
    clearTimeout(arState.restartQrTimer);
    arState.restartQrTimer = null;
  }
}

export async function stopQrCameraInternal({ clear = false } = {}) {
  const html5QrCode = arState.html5QrCode;
  if (!html5QrCode) return;

  if (html5QrCode.isScanning) {
    try {
      await html5QrCode.stop();
    } catch (err) {
      console.warn('QR camera stop skipped:', err);
      await wait(150);
    }
  }

  arState.activeQrCameraId = null;

  if (clear) {
    try {
      html5QrCode.clear();
    } catch (err) {
      console.warn('QR clear skipped:', err);
    }
  }
}

export async function startQrCameraInternal() {
  const html5QrCode = arState.html5QrCode;
  if (!html5QrCode || arState.isQrProcessing) return;
  if (html5QrCode.isScanning && arState.activeQrCameraId === 'environment') return;

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
      () => { }
    );
    arState.activeQrCameraId = 'environment';
    console.log('[Camera] QR scanner live — rear camera active.');
    dom.cameraError?.classList.add('hidden');
    if (dom.qrStatusText) dom.qrStatusText.textContent = 'Align QR code in frame';
  } catch (err) {
    arState.activeQrCameraId = null;
    console.error('[Camera] html5QrCode.start() failed:', err);
    showCameraError(classifyCameraError(err));
  }
}

export async function startQrCamera() {
  return queueQrCameraTask(() => startQrCameraInternal());
}

export function restartQrCameraSoon() {
  clearQrRestartTimer();
  const arBtn = document.getElementById('ARButton');
  if (arBtn) arBtn.style.display = 'none';
  arState.restartQrTimer = setTimeout(() => {
    arState.isQrProcessing = false;
    startQrCamera();
  }, 900);
}

export async function onQrCodeSuccess(decodedText) {
  if (arState.isQrProcessing) return;
  arState.isQrProcessing = true;
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
  if (dom.qrScreen) dom.qrScreen.classList.add('hidden');

  // 4. DIRECTLY Launch AR Camera & 3D scene
  try {
    await startUniversalAR();
    dom.uiOverlay?.classList.remove('hidden');
  } catch (err) {
    console.error('AR Camera Launch Error:', err);
    arState.isQrProcessing = false;
    dom.uiOverlay?.classList.add('hidden');
    dom.qrScreen?.classList.remove('hidden');
    restartQrCameraSoon();
    setToast('Failed to launch AR: ' + err.message, true);
  }
}

export function setupQrGalleryUpload() {
  const galleryInput = $('qr-gallery-input');
  if (galleryInput) {
    galleryInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file || arState.isQrProcessing) return;

      galleryInput.value = '';

      if (dom.qrStatusText) dom.qrStatusText.textContent = 'Reading QR from image…';

      try {
        await queueQrCameraTask(() => stopQrCameraInternal({ clear: false }));
      } catch (err) {
        console.warn('Gallery: camera stop warning:', err);
      }

      let decodedText = null;
      let scanError = null;

      try {
        decodedText = await arState.html5QrCode.scanFile(file, false);
      } catch (err) {
        scanError = err;
      }

      e.target.value = '';

      if (decodedText) {
        await onQrCodeSuccess(decodedText);
      } else {
        const isNotFound = scanError?.message?.toLowerCase().includes('no qr');
        const msg = isNotFound
          ? 'No QR code found — try a clearer photo'
          : 'Could not read QR — try a clearer or closer photo';

        console.warn('Gallery QR scan failed:', scanError);
        if (dom.qrStatusText) dom.qrStatusText.textContent = msg;

        setTimeout(() => {
          if (dom.qrStatusText) dom.qrStatusText.textContent = 'Align QR code in frame';
          arState.isQrProcessing = false;
          startQrCamera();
        }, 2800);
      }
    });
  }
}
