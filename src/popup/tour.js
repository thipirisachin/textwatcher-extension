/**
 * tour.js
 * Lightweight step-based onboarding tour for the TextWatcher popup.
 *
 * Usage:
 *   import { startTour, maybeAutoStartTour } from './tour.js';
 *
 *   // Auto-start once on first open:
 *   await maybeAutoStartTour(steps);
 *
 *   // Replay on "?" button click:
 *   startTour(steps);
 */

const TOUR_DONE_KEY = 'tw_tour_done';

let currentStep = 0;
let steps = [];

/** Check first-open flag and start tour if not yet seen. */
export async function maybeAutoStartTour(tourSteps) {
  const { [TOUR_DONE_KEY]: done } = await chrome.storage.local.get(TOUR_DONE_KEY);
  if (!done) startTour(tourSteps);
}

/** Start the tour from step 0. */
export function startTour(tourSteps) {
  steps = tourSteps;
  currentStep = 0;
  showStep(currentStep, 1);
}

/** Advance to the next step, or end tour if on last step. */
function nextStep() {
  currentStep++;
  if (currentStep >= steps.length) {
    endTour();
  } else {
    showStep(currentStep, 1);
  }
}

/** Go back one step. */
function previousStep() {
  if (currentStep <= 0) return;
  currentStep--;
  showStep(currentStep, -1);
}

/** End the tour and mark as done in storage. */
function endTour() {
  const overlay = document.getElementById('tourOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('tour-active');
  chrome.storage.local.set({ [TOUR_DONE_KEY]: true });
}

/**
 * Toggle the `tour-active` class on body.
 * CSS handles blocking: body.tour-active blocks pointer events on everything
 * except #tourOverlay via `pointer-events: none`.
 * This survives DOM re-renders (unlike setting `inert` on individual nodes).
 */
function setTourActive(on) {
  document.body.classList.toggle('tour-active', on);
  document.documentElement.classList.toggle('tour-active', on);
}

/** Render a single tour step.
 * @param {number} index
 * @param {1|-1} direction - 1 = forward, -1 = backward (for skip logic)
 */
function showStep(index, direction = 1) {
  const step = steps[index];
  if (!step) return;

  const overlay   = document.getElementById('tourOverlay');
  const spotlight = document.getElementById('tourSpotlight');
  const tooltip   = document.getElementById('tourTooltip');
  const stepLabel = document.getElementById('tourStepLabel');
  const stepText  = document.getElementById('tourText');
  const nextBtn   = document.getElementById('tourNextBtn');
  const backBtn   = document.getElementById('tourBackBtn');
  const skipBtn   = document.getElementById('tourSkipBtn');

  if (!overlay || !spotlight || !tooltip) return;

  // Optional: click a nav link to reveal a hidden section before checking visibility
  if (step.section) {
    const navLink = document.querySelector(`[data-section="${step.section}"]`);
    if (navLink) navLink.click();
  }

  // Skip step if target element is not visible
  const target = step.target ? document.querySelector(step.target) : null;
  if (step.target && !isVisible(target)) {
    currentStep += direction;
    if (currentStep >= steps.length) {
      endTour();
    } else if (currentStep < 0) {
      currentStep = 0;
      showStep(currentStep, 1);
    } else {
      showStep(currentStep, direction);
    }
    return;
  }

  overlay.classList.remove('hidden');
  setTourActive(true);

  // Scroll target into view so spotlight can cover it
  if (target) target.scrollIntoView({ block: 'nearest', behavior: 'instant' });

  // Position spotlight over target (re-read rect after scroll)
  if (target) {
    const rect = target.getBoundingClientRect();
    const pad  = 4;
    spotlight.style.top    = `${rect.top    - pad}px`;
    spotlight.style.left   = `${rect.left   - pad}px`;
    spotlight.style.width  = `${rect.width  + pad * 2}px`;
    spotlight.style.height = `${rect.height + pad * 2}px`;
    spotlight.style.display = '';
  } else {
    spotlight.style.display = 'none';
  }

  // Position tooltip below (or above) target
  positionTooltip(tooltip, target);

  // Set text
  if (stepLabel) stepLabel.textContent = `Step ${index + 1} of ${steps.length}`;
  if (stepText)  stepText.textContent  = step.text;

  // Last step: change button label and add Done styling; remove it on other steps
  if (nextBtn) {
    const isLast = index === steps.length - 1;
    nextBtn.textContent = isLast ? 'Done' : 'Next \u2192';
    nextBtn.classList.toggle('tour-btn--done', isLast);
  }

  // Back button: disabled on first step
  if (backBtn) backBtn.disabled = index === 0;

  // Wire buttons (replace previous listeners)
  if (nextBtn) nextBtn.onclick = nextStep;
  if (backBtn) backBtn.onclick = previousStep;
  if (skipBtn) skipBtn.onclick = endTour;
  // No overlay.onclick — clicking outside tooltip does nothing.
  // Only the tooltip action buttons can advance or close the tour.
}

/** Position tooltip below the target, flipping above if it would overflow. */
function positionTooltip(tooltip, target) {
  const GAP       = 10;
  const TOOLTIP_W = 260;
  const viewH     = window.innerHeight;
  const viewW     = window.innerWidth;

  if (!target) {
    // Center in popup
    tooltip.style.top    = '50%';
    tooltip.style.left   = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    return;
  }

  tooltip.style.transform = '';
  const rect = target.getBoundingClientRect();

  // Horizontal: align left of target, clamp to viewport
  let left = rect.left;
  if (left + TOOLTIP_W > viewW - 8) left = viewW - TOOLTIP_W - 8;
  if (left < 8) left = 8;
  tooltip.style.left = `${left}px`;

  // Vertical: prefer below, flip above if too close to bottom
  const tooltipH = tooltip.offsetHeight || 120;
  if (rect.bottom + GAP + tooltipH <= viewH - 8) {
    tooltip.style.top = `${rect.bottom + GAP}px`;
  } else {
    tooltip.style.top = `${rect.top - GAP - tooltipH}px`;
  }
}

/** Check if an element is visible in the DOM. */
function isVisible(el) {
  if (!el) return false;
  return el.offsetParent !== null && getComputedStyle(el).display !== 'none';
}
