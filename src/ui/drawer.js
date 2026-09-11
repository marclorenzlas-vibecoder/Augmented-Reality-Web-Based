import { arState } from '../ar/state.js';
import { dom } from './domElements.js';

export function closeHistoryDrawer() {
  const historyModalEl = dom.historyModal || document.getElementById('history-modal');
  historyModalEl?.classList.add('hidden');
  document.body.classList.remove('drawer-open');
}

export function setupHistoryDrawer() {
  const infoToggleBtnEl = dom.infoToggleBtn;
  const historyModalEl = dom.historyModal;
  const closeHistoryBtn = dom.closeHistoryBtn;

  infoToggleBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 800;
    historyModalEl?.classList.remove('hidden');
    document.body.classList.add('drawer-open');
  });

  closeHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    arState.ignorePlacementUntil = performance.now() + 800;
    closeHistoryDrawer();
  });

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
        arState.ignorePlacementUntil = performance.now() + 800;
      }
    }, { passive: true });

    drawerBodyEl.addEventListener('touchmove', (e) => {
      if (!isTouchingDrawer || e.touches.length !== 1) return;
      arState.ignorePlacementUntil = performance.now() + 800;

      const isSimulated = document.body.classList.contains('simulated-landscape') ||
                          document.body.classList.contains('simulated-landscape-90') ||
                          document.body.classList.contains('simulated-landscape--90') ||
                          dom.uiWrapper?.classList.contains('simulated-landscape');
      const isDegMinus90 = document.body.classList.contains('simulated-landscape--90') ||
                           dom.uiWrapper?.classList.contains('simulated-landscape--90');

      if (isSimulated) {
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
      arState.ignorePlacementUntil = performance.now() + 800;

      const isSimulated = document.body.classList.contains('simulated-landscape') ||
                          document.body.classList.contains('simulated-landscape-90') ||
                          document.body.classList.contains('simulated-landscape--90') ||
                          dom.uiWrapper?.classList.contains('simulated-landscape');

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
}
