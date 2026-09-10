import { dom } from './domElements.js';

export function updateLoadingBar(percent, isIndeterminate = false) {
  const container = dom.loadingBarContainer;
  const bar = dom.loadingBar;
  if (!container || !bar) return;

  container.classList.remove('hidden');
  container.style.opacity = '1';

  if (isIndeterminate) {
    bar.classList.add('loading-bar--indeterminate');
    bar.style.width = '100%';
  } else {
    bar.classList.remove('loading-bar--indeterminate');
    const p = Math.min(Math.max(percent, 0), 100);
    bar.style.width = `${p}%`;
  }
}

export function hideLoadingBar() {
  const container = dom.loadingBarContainer;
  const bar = dom.loadingBar;
  if (!container || !bar) return;

  bar.style.width = '100%';
  setTimeout(() => {
    container.style.opacity = '0';
    setTimeout(() => {
      container.classList.add('hidden');
      bar.style.width = '0%';
      bar.classList.remove('loading-bar--indeterminate');
    }, 300);
  }, 200);
}
