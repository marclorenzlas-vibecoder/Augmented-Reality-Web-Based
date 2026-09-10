import { dom } from './domElements.js';
import { arState } from '../ar/state.js';

let toastTimer = null;

export function setToast(msg, persist = false) {
  const toastEl = dom.toast;
  if (!toastEl) return;

  // If AR has not started yet, do not display surface detection/placement instruction toasts
  if (!arState.arStarted && /tap|aim|point|grid|floor|place/i.test(msg)) {
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
