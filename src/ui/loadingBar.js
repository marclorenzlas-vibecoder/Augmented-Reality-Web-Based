import { dom, $ } from './domElements.js';

const CIRCUMFERENCE = 314.16; // 2 * Math.PI * 50
let currentCircularPercent = 0;

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

// ── Circular Loader on Landing Screen ────────────────────────────────────────

export function showCircularLoader() {
  const loader = dom.landingLoader || $('landing-loader');
  const compatCard = dom.landingCompatCard || $('landing-compat-card');
  const arButton = document.getElementById('ARButton');
  const anchor = document.querySelector('.landing-button-anchor');

  currentCircularPercent = 0;
  if (anchor) anchor.classList.remove('is-ready');
  if (compatCard) {
    compatCard.classList.add('hidden');
    compatCard.style.display = 'none';
  }
  if (arButton) {
    arButton.classList.add('hidden');
    arButton.style.display = 'none';
  }

  if (loader) {
    loader.classList.remove('hidden');
    loader.classList.remove('fade-out');
    loader.style.display = 'flex';
  }

  const circle = dom.landingLoaderCircle || $('landing-loader-circle');
  const percentEl = dom.landingLoaderPercent || $('landing-loader-percent');
  const statusEl = dom.landingLoaderStatus || $('landing-loader-status');
  if (circle) circle.style.strokeDashoffset = `${CIRCUMFERENCE}`;
  if (percentEl) percentEl.textContent = '0%';
  if (statusEl) statusEl.textContent = 'Buffering media…';
}

export function updateCircularProgress(percent, statusMessage = '') {
  const circle = dom.landingLoaderCircle || $('landing-loader-circle');
  const percentEl = dom.landingLoaderPercent || $('landing-loader-percent');
  const statusEl = dom.landingLoaderStatus || $('landing-loader-status');

  const p = Math.min(Math.max(percent, 0), 100);
  currentCircularPercent = Math.max(currentCircularPercent, p);

  if (circle) {
    const offset = CIRCUMFERENCE * (1 - currentCircularPercent / 100);
    circle.style.strokeDashoffset = `${offset}`;
  }

  if (percentEl) {
    percentEl.textContent = `${Math.round(currentCircularPercent)}%`;
  }

  if (statusEl && statusMessage) {
    statusEl.textContent = statusMessage;
  }
}

export function completeAndRevealArButton(callback) {
  const loader = dom.landingLoader || $('landing-loader');
  const circle = dom.landingLoaderCircle || $('landing-loader-circle');
  const percentEl = dom.landingLoaderPercent || $('landing-loader-percent');
  const statusEl = dom.landingLoaderStatus || $('landing-loader-status');
  const arBtn = document.getElementById('ARButton');
  const anchor = document.querySelector('.landing-button-anchor');

  currentCircularPercent = 100;

  // Fill circular bar to 100%
  if (circle) circle.style.strokeDashoffset = '0';
  if (percentEl) percentEl.textContent = '100%';
  if (statusEl) statusEl.textContent = 'Ready!';

  // Smoothly fade out loader and reveal ARButton
  setTimeout(() => {
    if (loader) loader.classList.add('fade-out');

    setTimeout(() => {
      if (loader) {
        loader.classList.add('hidden');
        loader.style.display = 'none';
      }

      if (anchor) anchor.classList.add('is-ready');

      if (arBtn) {
        arBtn.classList.remove('hidden');
        arBtn.style.display = 'flex';
        arBtn.style.opacity = '0';
        arBtn.style.transform = 'scale(0.9)';
        requestAnimationFrame(() => {
          arBtn.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
          arBtn.style.opacity = '1';
          arBtn.style.transform = 'scale(1)';
        });
      }

      if (typeof callback === 'function') callback();
    }, 400);
  }, 350);
}

// ── Incompatible Browser / Device Notice ──────────────────────────────────────

export function showBrowserIncompatibleNotice(title, description, actionConfig = null) {
  const loader = dom.landingLoader || $('landing-loader');
  const compatCard = dom.landingCompatCard || $('landing-compat-card');
  const titleEl = dom.landingCompatTitle || $('landing-compat-title');
  const descEl = dom.landingCompatDesc || $('landing-compat-desc');
  const actionEl = dom.landingCompatAction || $('landing-compat-action');
  const arBtn = document.getElementById('ARButton');

  if (loader) {
    loader.classList.add('hidden');
    loader.style.display = 'none';
  }
  if (arBtn) {
    arBtn.style.display = 'none';
  }

  if (compatCard) {
    if (titleEl && title) titleEl.textContent = title;
    if (descEl && description) descEl.innerHTML = description;

    if (actionEl) {
      if (actionConfig && actionConfig.label) {
        actionEl.innerHTML = `
          <button class="btn btn--compat" type="button" id="compat-action-btn">
            ${actionConfig.icon || ''}
            <span>${actionConfig.label}</span>
          </button>
        `;
        actionEl.classList.remove('hidden');
        const btn = document.getElementById('compat-action-btn');
        if (btn && actionConfig.onClick) {
          btn.onclick = actionConfig.onClick;
        }
      } else {
        actionEl.classList.add('hidden');
      }
    }

    compatCard.classList.remove('hidden');
    compatCard.style.display = 'flex';
  }
}
