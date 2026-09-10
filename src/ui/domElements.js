export const $ = (id) => document.getElementById(id);

export const dom = {
  get uiOverlay() { return $('ui-overlay'); },
  get uiWrapper() { return $('ui-wrapper'); },
  get qrScreen() { return $('qr-screen'); },
  get qrControls() { return $('qr-controls-container'); },
  get qrStatusText() { return $('qr-status-text'); },
  get toast() { return $('toast'); },
  get infoToggleBtn() { return $('info-toggle-btn'); },
  get captureBtn() { return $('capture-btn'); },
  get recenterBtn() { return $('recenter-btn'); },
  get historyModal() { return $('history-modal'); },
  get closeHistoryBtn() { return $('close-history-btn'); },
  get cameraError() { return $('camera-error-msg'); },
  get exitArBtn() { return $('exit-ar-btn'); },
  get loadingBarContainer() { return $('loading-bar-container'); },
  get loadingBar() { return $('loading-bar'); },
  get dancerVideo() { return $('dancer-video'); },
  get arCanvas() { return $('ar-canvas'); }
};
