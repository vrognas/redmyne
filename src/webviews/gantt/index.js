import { setupMinimap } from './gantt-minimap.js';
import { setupDrag } from './gantt-drag.js';
import { setupRowInteraction } from './gantt-row-interaction.js';
import { createLookupMaps } from './lookup-maps.js';
import { setupKeyboard } from './gantt-keyboard.js';
import { createRowWindow } from './row-window.js';

const vscode = acquireVsCodeApi();

// Windowed row renderer — recreated per render (the skeleton is replaced)
let rowWindow = null;

// Performance instrumentation (controlled by redmyne.gantt.perfDebug setting)
let PERF_DEBUG = false; // Updated from state.perfDebug on render
function perfMark(name) {
  if (PERF_DEBUG && typeof performance !== 'undefined') {
    performance.mark(name);
  }
}
function perfMeasure(name, startMark, endMark) {
  if (PERF_DEBUG && typeof performance !== 'undefined') {
    try {
      performance.measure(name, startMark, endMark);
      const entries = performance.getEntriesByName(name, 'measure');
      if (entries.length > 0) {
        console.log(`[Gantt Perf] ${name}: ${entries[entries.length - 1].duration.toFixed(2)}ms`);
      }
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
      performance.clearMeasures(name);
    } catch (e) { /* ignore */ }
  }
}
function perfLog(message) {
  if (PERF_DEBUG) {
    console.log(`[Gantt Perf] ${message}`);
  }
}
function logDomStats() {
  if (PERF_DEBUG) {
    const root = document.getElementById('ganttRoot');
    const nodeCount = root ? root.querySelectorAll('*').length : 0;
    const svgCount = root ? root.querySelectorAll('svg *').length : 0;
    console.log(`[Gantt Perf] DOM nodes: ${nodeCount}, SVG elements: ${svgCount}`);
  }
}

function applyCssVars(state) {
  if (!state) return;
  const root = document.documentElement;
  root.style.setProperty('--gantt-header-height', `${state.headerHeight}px`);
  root.style.setProperty('--gantt-label-width', `${state.labelWidth}px`);
  root.style.setProperty('--gantt-id-column-width', `${state.idColumnWidth}px`);
  root.style.setProperty('--gantt-start-date-column-width', `${state.startDateColumnWidth}px`);
  root.style.setProperty('--gantt-status-column-width', `${state.statusColumnWidth}px`);
  root.style.setProperty('--gantt-due-date-column-width', `${state.dueDateColumnWidth}px`);
  root.style.setProperty('--gantt-assignee-column-width', `${state.assigneeColumnWidth}px`);
  root.style.setProperty('--gantt-sticky-left-width', `${state.stickyLeftWidth}px`);
}

// Lazily-fetched project member lines, keyed by project id. A Map (not a DOM
// dataset write) because the reply can arrive while the target label is
// unmounted — windowed rows — and the cache must survive remounts/re-renders.
const projectMembersById = new Map();

function setupTooltips({ addDocListener, addWinListener }) {
  const root = document.getElementById('ganttRoot');
  const tooltip = document.getElementById('ganttTooltip');
  const tooltipContent = tooltip?.querySelector('.gantt-tooltip-content');
  if (!root || !tooltip || !tooltipContent) return;

  const normalizeTooltipText = (value) => {
    if (!value) return '';
    return String(value).replace(/\r\n/g, '\n').trimEnd();
  };

  function convertSvgTitles() {
    root.querySelectorAll('svg title').forEach((title) => {
      const parent = title.parentElement;
      const text = normalizeTooltipText(title.textContent);
      if (parent && text) {
        parent.dataset.tooltip = text;
      }
      title.remove();
    });
  }

  function convertTitleAttributes() {
    root.querySelectorAll('[title]').forEach((el) => {
      if (el.tagName.toLowerCase() === 'title') return;
      const text = normalizeTooltipText(el.getAttribute('title'));
      el.removeAttribute('title');
      if (text) {
        el.dataset.tooltip = text;
      }
    });
  }

  function convertToolbarTooltips() {
    // Convert data-toolbar-tooltip to data-tooltip (JS system avoids overflow clipping)
    root.querySelectorAll('[data-toolbar-tooltip]').forEach((el) => {
      const text = normalizeTooltipText(el.dataset.toolbarTooltip);
      delete el.dataset.toolbarTooltip;
      if (text) {
        el.dataset.tooltip = text;
      }
    });
  }

  function prepareTooltips() {
    convertSvgTitles();
    convertTitleAttributes();
    convertToolbarTooltips();
  }

  function findHeaderIndex(lines) {
    // Only return header index for multi-line tooltips with explicit # header
    // Single-line tooltips should not be bolded
    const headerIndex = lines.findIndex((line) => line.trim().startsWith('#'));
    if (headerIndex >= 0) return headerIndex;
    // Only treat first line as header if there are multiple content lines
    const nonEmptyLines = lines.filter((line) => line.trim());
    if (nonEmptyLines.length > 1) {
      return lines.findIndex((line) => line.trim());
    }
    return -1; // No header for single-line tooltips
  }

  function buildTooltipContent(text) {
    tooltipContent.textContent = '';
    const normalized = normalizeTooltipText(text);
    if (!normalized) return;
    const lines = normalized.split('\n');
    const headerIndex = findHeaderIndex(lines);
    let lastWasSpacer = false;

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        if (!lastWasSpacer) {
          const spacer = document.createElement('div');
          spacer.className = 'gantt-tooltip-spacer';
          tooltipContent.appendChild(spacer);
          lastWasSpacer = true;
        }
        return;
      }

      if (trimmed === '---') {
        const divider = document.createElement('div');
        divider.className = 'gantt-tooltip-divider';
        tooltipContent.appendChild(divider);
        lastWasSpacer = false;
        return;
      }

      const customMatch = trimmed.match(/^cf:([^:]+):(.*)$/);
      if (customMatch) {
        const key = customMatch[1].trim();
        const value = customMatch[2].trim();
        const lineEl = document.createElement('div');
        lineEl.className = 'gantt-tooltip-line';
        const keyEl = document.createElement('span');
        keyEl.className = 'gantt-tooltip-key';
        keyEl.textContent = `${key}: `;
        lineEl.appendChild(keyEl);
        if (value) {
          lineEl.appendChild(document.createTextNode(value));
        }
        tooltipContent.appendChild(lineEl);
        lastWasSpacer = false;
        return;
      }

      const lineEl = document.createElement('div');
      lineEl.className = 'gantt-tooltip-line';
      if (index === headerIndex) {
        lineEl.classList.add('gantt-tooltip-title');
      }

      const openMatch = trimmed.match(/^Open in Browser:\s*(\S+)/);
      if (openMatch && /^https?:\/\//i.test(openMatch[1])) {
        const link = document.createElement('a');
        link.href = openMatch[1];
        link.textContent = 'Open in Browser';
        link.title = openMatch[1];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        lineEl.appendChild(link);
      } else {
        lineEl.textContent = line;
      }

      tooltipContent.appendChild(lineEl);
      lastWasSpacer = false;
    });

    const lastChild = tooltipContent.lastElementChild;
    if (lastChild && lastChild.classList.contains('gantt-tooltip-spacer')) {
      lastChild.remove();
    }
  }

  let activeTarget = null;
  let hideTimer = null;
  let showTimer = null;
  let lastPointer = { x: 0, y: 0 };

  function updatePointer(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
  }

  function cancelHide() {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function cancelShow() {
    if (!showTimer) return;
    clearTimeout(showTimer);
    showTimer = null;
  }

  function isInTooltip(node) {
    return node && (node === tooltip || tooltip.contains(node));
  }

  function isInActiveTarget(node) {
    return node && activeTarget && (node === activeTarget || activeTarget.contains(node));
  }

  function isPointerOverTooltipOrTarget() {
    if (!lastPointer) return false;
    const hovered = document.elementFromPoint(lastPointer.x, lastPointer.y);
    return isInTooltip(hovered) || isInActiveTarget(hovered);
  }

  const showDelay = 300;

  function scheduleShow(target) {
    cancelShow();
    showTimer = setTimeout(() => {
      showTimer = null;
      if (!activeTarget || activeTarget !== target) return;
      if (!isPointerOverTooltipOrTarget()) return;
      showTooltip(target, lastPointer.x, lastPointer.y);
    }, showDelay);
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      if (!activeTarget) return;
      if (isPointerOverTooltipOrTarget()) return;
      hideTooltip();
    }, 300);
  }

  function positionTooltip(x, y) {
    const padding = 8;
    const offset = 8;
    const rect = tooltip.getBoundingClientRect();
    let left = x + offset;
    let top = y + offset;

    if (left + rect.width > window.innerWidth - padding) {
      left = x - rect.width - offset;
    }
    if (top + rect.height > window.innerHeight - padding) {
      top = y - rect.height - offset;
    }

    left = Math.max(padding, Math.min(left, window.innerWidth - rect.width - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - rect.height - padding));

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function showTooltip(target, x, y) {
    // Merge cached member lines / request them for project tooltips. Merging
    // at show time (instead of writing the reply to the DOM) handles replies
    // that arrived while the label was unmounted.
    const projectId = target.dataset.projectId;
    if (projectId) {
      const memberText = projectMembersById.get(String(projectId));
      if (memberText) {
        const existing = (target.dataset.tooltip || '').trimEnd();
        if (existing && !existing.includes(memberText)) {
          target.dataset.tooltip = existing + '\n\n---\n\n' + memberText;
        }
      } else if (!target.dataset.membersRequested) {
        target.dataset.membersRequested = '1';
        vscode.postMessage({ command: 'requestProjectMembers', projectId: Number(projectId) });
      }
    }

    const text = target.dataset.tooltip;
    if (!text) return;
    buildTooltipContent(text);
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');
    positionTooltip(x, y);
  }

  function hideTooltip(keepTarget = false) {
    cancelShow();
    cancelHide();
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
    if (!keepTarget) {
      activeTarget = null;
    }
  }

  function resolveTooltipTarget(node) {
    if (!node || node === tooltip || tooltip.contains(node)) return null;
    let target = node.closest?.('[data-tooltip], [title]');
    if (!target) {
      // Windowed fragments and rebuilt arrow layers carry their tooltip as an
      // SVG <title> CHILD element, which attribute selectors can't see — the
      // one-time init conversion only reached initially-mounted rows
      let el = node;
      while (el && el !== root) {
        if (el.querySelector?.(':scope > title')) {
          target = el;
          break;
        }
        el = el.parentElement;
      }
    }
    if (!target || !root.contains(target)) return null;
    if (target.hasAttribute('title')) {
      const title = normalizeTooltipText(target.getAttribute('title'));
      target.removeAttribute('title');
      if (title) {
        target.dataset.tooltip = title;
      }
    }
    const childTitle = target.querySelector?.(':scope > title');
    if (childTitle) {
      const text = normalizeTooltipText(childTitle.textContent);
      childTitle.remove();
      if (text && !target.dataset.tooltip) {
        target.dataset.tooltip = text;
      }
    }
    if (!target.dataset.tooltip) return null;
    return target;
  }

  prepareTooltips();

  addDocListener('pointerover', (event) => {
    updatePointer(event);
    if (isInTooltip(event.target)) {
      cancelHide();
      cancelShow();
      return;
    }
    const target = resolveTooltipTarget(event.target);
    if (!target) {
      cancelShow();
      return;
    }
    cancelHide();
    if (activeTarget !== target) {
      activeTarget = target;
      if (tooltip.classList.contains('visible')) {
        hideTooltip(true);
      }
      scheduleShow(target);
    } else if (!tooltip.classList.contains('visible')) {
      scheduleShow(target);
    }
  }, true);

  addDocListener('pointermove', (event) => {
    if (!activeTarget) return;
    updatePointer(event);
    if (hideTimer && isPointerOverTooltipOrTarget()) {
      cancelHide();
    }
  }, true);

  addDocListener('pointerout', (event) => {
    if (!activeTarget) return;
    updatePointer(event);
    cancelShow();
    if (!isInActiveTarget(event.target) && !isInTooltip(event.target)) return;
    const related = event.relatedTarget;
    if (isInTooltip(related) || isInActiveTarget(related)) return;
    scheduleHide();
  }, true);

  addDocListener('scroll', () => {
    if (activeTarget) hideTooltip();
  }, true);

  addDocListener('keydown', () => {
    if (activeTarget) hideTooltip();
  }, true);

  addWinListener('blur', () => {
    if (activeTarget) hideTooltip();
  });
}

function render(payload) {
  if (!payload) return;
  // Update perf debug flag from config (passed via state)
  if (payload.state) {
    PERF_DEBUG = payload.state.perfDebug ?? false;
  }
  perfMark('render-start');
  const root = document.getElementById('ganttRoot');
  if (!root) return;
  applyCssVars(payload.state);
  perfMark('innerHTML-start');
  root.innerHTML = payload.html || '';
  perfMark('innerHTML-end');
  perfMeasure('innerHTML', 'innerHTML-start', 'innerHTML-end');
  perfMark('mountRows-start');
  rowWindow?.dispose(); // kill queued scroll-rAFs / listeners on the old instance
  rowWindow = createRowWindow({ perfLog });
  rowWindow.setData(payload);
  perfMark('mountRows-end');
  perfMeasure('mountRows', 'mountRows-start', 'mountRows-end');
  initializeGantt(payload.state, rowWindow);
  perfMark('render-end');
  perfMeasure('render', 'render-start', 'render-end');
  logDomStats();
}

window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;
  if (message.command === 'render') {
    render(message.payload);
    return;
  }
  if (message.command === 'appendProjectMembers' && message.projectId && message.memberLines?.length) {
    // Cache by project id; showTooltip merges at display time. The target
    // label may be unmounted (windowed rows) when the reply arrives, so a
    // DOM write here could be lost — the cache can't be.
    projectMembersById.set(String(message.projectId), message.memberLines.join('\n'));
    return;
  }
  if (window.__ganttHandleExtensionMessage) {
    window.__ganttHandleExtensionMessage(message);
  }
});

const initialPayload = window.__GANTT_INITIAL_PAYLOAD__;
if (initialPayload) {
  render(initialPayload);
}
vscode.postMessage({ command: 'webviewReady' });

function initializeGantt(state, rowWindow) {
  perfMark('initializeGantt-start');
  if (!state) return;
  const {
    timelineWidth,
    minDateMs,
    maxDateMs,
    totalDays,
    redmineBaseUrl,
    minimapBarsData,
    minimapHeight,
    minimapBarHeight,
    minimapTodayX,
    labelWidth,
    leftExtrasWidth,
    sortBy,
    sortOrder,
    selectedCollapseKey,
    barHeight,
    todayX,
    todayInRange,
    isDraftMode,
    draftQueueCount
  } = state;
  const dayWidth = timelineWidth / totalDays;

  function setDraftBadgeContent(badge, count) {
    badge.textContent = count;
    badge.dataset.tooltip = count === 1 ? '1 change queued - click to review' : count + ' changes queued - click to review';
  }

  // Mutable draft mode state (updated via setDraftModeState message)
  let currentDraftMode = isDraftMode;

  // Initialize confirm button text based on draft mode
  const confirmBtn = document.getElementById('dragConfirmOk');
  if (confirmBtn) {
    confirmBtn.textContent = isDraftMode ? 'Queue to Draft' : 'Save to Redmine';
  }

  // Initialize draft badge visibility and count
  const draftBadge = document.getElementById('draftBadge');
  if (draftBadge) {
    if (isDraftMode) {
      draftBadge.classList.remove('hidden');
      setDraftBadgeContent(draftBadge, draftQueueCount ?? 0);
    } else {
      draftBadge.classList.add('hidden');
    }
    // Click badge to open draft review
    draftBadge.addEventListener('click', () => {
      vscode.postMessage({ command: 'openDraftReview' });
    });
  }

  // Draft mode toggle button
  const draftModeToggle = document.getElementById('draftModeToggle');
  if (draftModeToggle) {
    draftModeToggle.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleDraftMode' });
    });
  }

  // Cleanup previous event listeners (prevents accumulation on re-render)
  if (window._ganttCleanup) {
    window._ganttCleanup();
  }
  const docListeners = [];
  const winListeners = [];
  function addDocListener(type, handler, options) {
    document.addEventListener(type, handler, options);
    docListeners.push({ type, handler, options });
  }
  function addWinListener(type, handler, options) {
    window.addEventListener(type, handler, options);
    winListeners.push({ type, handler, options });
  }
  const extraCleanups = [];
  window._ganttCleanup = () => {
    docListeners.forEach(l => document.removeEventListener(l.type, l.handler, l.options));
    winListeners.forEach(l => window.removeEventListener(l.type, l.handler, l.options));
    extraCleanups.forEach(fn => fn());
    window.__ganttHandleExtensionMessage = null;
  };

    // Helper: close element on outside click (used by pickers/menus)
    function closeOnOutsideClick(element) {
      setTimeout(() => {
        document.addEventListener('click', function closeHandler(e) {
          if (!element.contains(e.target)) {
            element.remove();
            document.removeEventListener('click', closeHandler);
          }
        });
      }, 0);
    }

    // Snap x position to nearest day boundary
    function snapToDay(x) {
      return Math.round(x / dayWidth) * dayWidth;
    }

    function announce(message) {
      const liveRegion = document.getElementById('liveRegion');
      if (liveRegion) {
        liveRegion.textContent = message;
      }
    }

    // Get DOM elements
    const ganttScroll = document.getElementById('ganttScroll');
    const ganttLeftHeader = document.getElementById('ganttLeftHeader');
    const labelsColumn = document.getElementById('ganttLabels');
    const timelineColumn = document.getElementById('ganttTimeline');
    const menuUndo = document.getElementById('menuUndo');
    const menuRedo = document.getElementById('menuRedo');
    const minimapSvg = document.getElementById('minimapSvg');
    const minimapViewport = document.getElementById('minimapViewport');
    const { updateMinimapPosition, updateMinimapViewport } = setupMinimap({
      timelineWidth,
      minimapBarsData,
      minimapHeight,
      minimapBarHeight,
      minimapTodayX,
      ganttScroll,
      minimapSvg,
      minimapViewport,
      addDocListener
    });

    // Restore state from previous session (use extension-stored position as fallback)
    const MAX_HISTORY_ACTIONS = 200;
    const previousState = vscode.getState() || { undoStack: [], redoStack: [], labelWidth, scrollLeft: null, scrollTop: null, centerDateMs: null };
    const undoStack = previousState.undoStack || [];
    const redoStack = previousState.redoStack || [];

    function trimHistoryStack(stack) {
      if (stack.length > MAX_HISTORY_ACTIONS) {
        stack.splice(0, stack.length - MAX_HISTORY_ACTIONS);
      }
    }

    trimHistoryStack(undoStack);
    trimHistoryStack(redoStack);
    // Restore scroll from webview state (centerDateMs is the primary mechanism)
    let savedScrollLeft = previousState.scrollLeft ?? null;
    let savedScrollTop = previousState.scrollTop ?? null;
    let savedCenterDateMs = previousState.centerDateMs;

    // Convert scroll position to center date (milliseconds)
    function getCenterDateMs() {
      if (!ganttScroll) return null;
      // Account for sticky left column (same as scrollToCenterDate)
      const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      const centerX = ganttScroll.scrollLeft + visibleTimelineWidth / 2;
      const ratio = centerX / timelineWidth;
      return minDateMs + ratio * (maxDateMs - minDateMs);
    }

    // Scroll to center a specific date
    function scrollToCenterDate(dateMs) {
      if (!ganttScroll) return;
      const ratio = (dateMs - minDateMs) / (maxDateMs - minDateMs);
      const centerX = ratio * timelineWidth;
      const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      ganttScroll.scrollLeft = Math.max(0, centerX - visibleTimelineWidth / 2);
    }

    function saveState() {
      trimHistoryStack(undoStack);
      trimHistoryStack(redoStack);
      // Always save centerDateMs for date-based scroll restoration
      // This ensures correct position when date range changes (e.g., visibility toggle)
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: labelsColumn?.offsetWidth || labelWidth,
        scrollLeft: null, // Deprecated: use centerDateMs instead
        scrollTop: ganttScroll?.scrollTop ?? null,
        centerDateMs: getCenterDateMs()
      });
    }

    // Alias for backward compatibility (zoom changes now use same logic)
    const saveStateForZoom = saveState;

    function updateUndoRedoButtons() {
      if (menuUndo) menuUndo.toggleAttribute('disabled', undoStack.length === 0);
      if (menuRedo) menuRedo.toggleAttribute('disabled', redoStack.length === 0);
      saveState();
    }

    // Apply saved label width
    if (previousState.labelWidth && ganttLeftHeader && labelsColumn) {
      ganttLeftHeader.style.width = previousState.labelWidth + 'px';
      labelsColumn.style.width = previousState.labelWidth + 'px';
      // Also update capacity ribbon label to stay aligned
      const capacityLabel = document.querySelector('.capacity-ribbon-label');
      if (capacityLabel) {
        capacityLabel.style.width = (previousState.labelWidth + leftExtrasWidth) + 'px';
      }
    }

    // Single scroll container - no sync needed, just update minimap and save state
    // Flag to prevent saving state during scroll restoration (would overwrite with wrong position)
    let restoringScroll = true;
    let deferredScrollUpdate = null;
    if (ganttScroll) {
      ganttScroll.addEventListener('scroll', () => {
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          if (!restoringScroll) saveState();
        });
      }, { passive: true });
    }

    // Initial button state (defer to avoid forced reflow after style writes)
    requestAnimationFrame(() => updateUndoRedoButtons());

    // Handle messages from extension (for state updates without full re-render)
    // Table-driven view-toggle message handlers
    const viewToggleTable = {
      setDependenciesState:  { targetSel: '.dependency-layer', menuId: 'menuDeps',      className: 'hidden',           addWhenEnabled: false },
      setBadgesState:        { targetSel: '.gantt-container',  menuId: 'menuBadges',    className: 'hide-badges',      addWhenEnabled: false },
      setCapacityRibbonState:{ targetSel: '.capacity-ribbon',  menuId: 'menuCapacity',  className: 'hidden',           addWhenEnabled: false },
      setIntensityState:     { targetSel: '.gantt-container',  menuId: 'menuIntensity', className: 'intensity-enabled', addWhenEnabled: true  },
    };
    function applyViewToggle(cfg, enabled) {
      const target = document.querySelector(cfg.targetSel);
      const menu = document.getElementById(cfg.menuId);
      const on = cfg.addWhenEnabled ? enabled : !enabled;
      if (target) target.classList.toggle(cfg.className, on);
      if (menu) menu.classList.toggle('active', enabled);
    }

    window.__ganttHandleExtensionMessage = (message) => {
      const toggleCfg = viewToggleTable[message.command];
      if (toggleCfg) {
        applyViewToggle(toggleCfg, message.enabled);
      } else if (message.command === 'setDraftModeState') {
        // Update mutable draft mode state for drag handlers
        currentDraftMode = message.enabled;
        // Update confirm button text based on draft mode
        const confirmBtn = document.getElementById('dragConfirmOk');
        if (confirmBtn) {
          confirmBtn.textContent = message.enabled ? 'Queue to Draft' : 'Save to Redmine';
        }
        // Update toggle button active state and text
        const toggleBtn = document.getElementById('draftModeToggle');
        if (toggleBtn) {
          toggleBtn.classList.toggle('active', message.enabled);
          toggleBtn.textContent = message.enabled ? 'Disable Draft Mode' : 'Enable Draft Mode';
        }
        // Update draft badge visibility
        const draftBadge = document.getElementById('draftBadge');
        if (draftBadge) {
          if (message.enabled) {
            draftBadge.classList.remove('hidden');
            setDraftBadgeContent(draftBadge, message.queueCount ?? 0);
          } else {
            draftBadge.classList.add('hidden');
          }
        }
      } else if (message.command === 'setDraftQueueCount') {
        // Update draft badge count
        const draftBadge = document.getElementById('draftBadge');
        if (draftBadge) {
          setDraftBadgeContent(draftBadge, message.count);
        }
      } else if (message.command === 'pushUndoAction') {
        // Push relation action to undo stack
        undoStack.push(message.action);
        trimHistoryStack(undoStack);
        redoStack.length = 0;
        updateUndoRedoButtons();
        saveState();
      } else if (message.command === 'updateRelationId') {
        // Update relationId in most recent relation action (after undo/redo recreates relation)
        const stack = message.stack === 'undo' ? undoStack : redoStack;
        if (stack.length > 0) {
          const lastAction = stack[stack.length - 1];
          if (lastAction.type === 'relation') {
            lastAction.relationId = message.newRelationId;
            saveState();
          }
        }
      } else if (message.command === 'scrollToIssue') {
        // Scroll to, focus, and highlight a specific issue. The target row is
        // usually outside the mounted window (that's why the user asked to
        // reveal it) — scrollToKey scrolls vertically and mounts it first.
        const issueId = message.issueId;
        const scrollContainer = document.getElementById('ganttScroll');
        if (!scrollContainer) return;
        const meta = rowWindow?.getRowMetaByIssueId(issueId);
        if (meta) rowWindow.scrollToKey(meta.key);

        const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
        const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
        let targetScrollLeft = scrollContainer.scrollLeft;

        if (label) {
          label.focus({ preventScroll: true });
          label.classList.add('highlighted');
          setTimeout(() => label.classList.remove('highlighted'), 2000);
        }

        if (bar) {
          // Calculate horizontal scroll to show the bar
          const startX = parseFloat(bar.getAttribute('data-start-x') || '0');
          const endX = parseFloat(bar.getAttribute('data-end-x') || '0');
          const barWidth = endX - startX;
          const viewportWidth = scrollContainer.clientWidth;
          const stickyLeftWidth = document.querySelector('.gantt-sticky-left')?.getBoundingClientRect().width || 0;
          const availableWidth = viewportWidth - stickyLeftWidth;

          if (barWidth <= availableWidth - 100) {
            // Bar fits: center it in the available viewport
            targetScrollLeft = startX - (availableWidth - barWidth) / 2;
          } else {
            // Bar too wide: show start with some padding
            targetScrollLeft = startX - 50;
          }
          targetScrollLeft = Math.max(0, targetScrollLeft);

          bar.classList.add('highlighted');
          setTimeout(() => bar.classList.remove('highlighted'), 2000);
        }

        scrollContainer.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
      }
    };

    // Lookback period select handler
    document.getElementById('lookbackSelect')?.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'setLookback', years: e.target.value });
    });

    // Zoom select handler
    document.getElementById('zoomSelect')?.addEventListener('change', (e) => {
      saveStateForZoom();
      vscode.postMessage({ command: 'setZoom', zoomLevel: e.target.value });
    });

    // View focus select handler
    document.getElementById('viewFocusSelect')?.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'setViewFocus', focus: e.target.value });
    });

    // Project selector handler (native select)
    const projectSelector = document.getElementById('projectSelector');
    projectSelector?.addEventListener('change', (e) => {
      const value = e.target.value;
      const projectId = value ? parseInt(value, 10) : null;
      vscode.postMessage({ command: 'setSelectedProject', projectId });
    });

    // Person selector handler (focusSelector in person focus mode)
    const focusSelector = document.getElementById('focusSelector');
    focusSelector?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({
        command: 'setSelectedAssignee',
        assignee: value || null
      });
    });

    // Filter dropdown handlers
    document.getElementById('filterAssignee')?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { assignee: value } });
    });
    document.getElementById('filterStatus')?.addEventListener('change', (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: 'setFilter', filter: { status: value } });
    });
    document.getElementById('filterTaskType')?.addEventListener('change', (e) => {
      vscode.postMessage({ command: 'setTaskTypeFilter', taskType: e.target.value });
    });

    // Sortable column header handlers (cycle: asc → desc → none)
    document.querySelectorAll('.gantt-col-header.sortable').forEach(header => {
      header.addEventListener('click', () => {
        const sortField = header.dataset.sort;
        const currentSort = sortBy;
        const currentOrder = sortOrder;
        if (sortField === currentSort) {
          // Same field: asc → desc → none
          if (currentOrder === 'asc') {
            vscode.postMessage({ command: 'setSort', sortOrder: 'desc' });
          } else {
            // desc → none (clear sort)
            vscode.postMessage({ command: 'setSort', sortBy: null });
          }
        } else {
          // Different field: start with ascending
          vscode.postMessage({ command: 'setSort', sortBy: sortField, sortOrder: 'asc' });
        }
      });
    });

    // Capacity ribbon toggle handler (menu item)
    document.getElementById('menuCapacity')?.addEventListener('click', () => {
      if (document.getElementById('menuCapacity')?.hasAttribute('disabled')) return;
      saveState();
      vscode.postMessage({ command: 'toggleCapacityRibbon' });
    });

    // Intensity toggle handler (menu item)
    document.getElementById('menuIntensity')?.addEventListener('click', () => {
      if (document.getElementById('menuIntensity')?.hasAttribute('disabled')) return;
      saveState();
      vscode.postMessage({ command: 'toggleIntensity' });
    });

    // Overload badge click - jump to first overloaded day
    document.getElementById('overloadBadge')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const badge = e.currentTarget;
      const firstOverloadMs = parseInt(badge.dataset.firstOverloadMs || '0', 10);
      if (firstOverloadMs > 0) {
        scrollToCenterDate(firstOverloadMs);
        saveState();
      }
    });

    // Capacity ribbon click - scroll to clicked date
    document.querySelectorAll('.capacity-day-bar-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const dateMs = parseInt(e.currentTarget.dataset.dateMs || '0', 10);
        if (dateMs > 0) {
          scrollToCenterDate(dateMs);
          saveState();
        }
      });
    });

    // Dependencies toggle handler (menu item)
    document.getElementById('menuDeps')?.addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleDependencies' });
    });

    // Badges toggle handler (menu item)
    document.getElementById('menuBadges')?.addEventListener('click', () => {
      saveState();
      vscode.postMessage({ command: 'toggleBadges' });
    });

    const ganttContainer = document.querySelector('.gantt-container');

    // Build blocking graph from relation DATA (used by focus mode). Arrow
    // DOM is incomplete: relations whose endpoint sits under a collapsed
    // parent are never mounted, and a DOM-built graph truncates chains there.
    function buildBlockingGraph() {
      const graph = new Map(); // issueId -> [targetIds that this issue blocks/precedes]
      const reverseGraph = new Map(); // issueId -> [sourceIds that block/precede this issue]
      (rowWindow?.getArrows() ?? []).forEach(rel => {
        if (rel.type !== 'blocks' && rel.type !== 'precedes') return;
        const fromId = String(rel.fromId);
        const toId = String(rel.toId);
        if (!graph.has(fromId)) graph.set(fromId, []);
        graph.get(fromId).push(toId);
        if (!reverseGraph.has(toId)) reverseGraph.set(toId, []);
        reverseGraph.get(toId).push(fromId);
      });
      return { graph, reverseGraph };
    }

    // Focus mode: click on issue to highlight its dependency chain.
    // The connected set lives in state and is RE-APPLIED on every window
    // refresh: freshly materialized chain members need the class, and
    // recycled elements may carry a stale one.
    let focusedIssueId = null;
    let focusedConnectedIds = null; // Set<string> while focus mode is active

    function getAllConnected(issueId, graph, reverseGraph) {
      const connected = new Set([issueId]);
      const queue = [issueId];
      // Traverse downstream (issues blocked by this one)
      while (queue.length > 0) {
        const current = queue.shift();
        const downstream = graph.get(current) || [];
        for (const dep of downstream) {
          if (!connected.has(dep)) {
            connected.add(dep);
            queue.push(dep);
          }
        }
      }
      // Traverse upstream (issues that block this one)
      const upQueue = [issueId];
      while (upQueue.length > 0) {
        const current = upQueue.shift();
        const upstream = reverseGraph.get(current) || [];
        for (const dep of upstream) {
          if (!connected.has(dep)) {
            connected.add(dep);
            upQueue.push(dep);
          }
        }
      }
      return connected;
    }

    // Sync focus-highlighted over all MOUNTED bars/labels/arrows from the
    // connected set (toggle both adds missing and strips stale classes)
    function applyFocusClasses() {
      if (!focusedConnectedIds) return;
      document.querySelectorAll('.issue-bar').forEach(bar => {
        bar.classList.toggle('focus-highlighted', focusedConnectedIds.has(bar.dataset.issueId));
      });
      document.querySelectorAll('.issue-label').forEach(label => {
        label.classList.toggle('focus-highlighted', focusedConnectedIds.has(label.dataset.issueId));
      });
      // Arrows highlight only between connected issues
      document.querySelectorAll('.dependency-arrow').forEach(arrow => {
        arrow.classList.toggle('focus-highlighted',
          focusedConnectedIds.has(arrow.dataset.from) && focusedConnectedIds.has(arrow.dataset.to));
      });
    }

    function focusOnDependencyChain(issueId) {
      // Clear previous focus
      clearFocus();
      if (!issueId) return;

      focusedIssueId = issueId;
      const { graph, reverseGraph } = buildBlockingGraph();
      focusedConnectedIds = getAllConnected(String(issueId), graph, reverseGraph);

      // Add focus mode class to container
      ganttContainer.classList.add('focus-mode');
      applyFocusClasses();

      announce(`Focus: ${focusedConnectedIds.size} issue${focusedConnectedIds.size !== 1 ? 's' : ''} in dependency chain`);
    }

    function clearFocus() {
      focusedIssueId = null;
      focusedConnectedIds = null;
      ganttContainer.classList.remove('focus-mode');
      document.querySelectorAll('.focus-highlighted').forEach(el => el.classList.remove('focus-highlighted'));
    }
    const getFocusedIssueId = () => focusedIssueId;

    // Multi-select state. Bars are resolved at USE time (mounted rows churn
    // with the window — an init snapshot misses later-materialized bars):
    // element access goes through the refresh-synced lookup maps, ordering
    // through the full payload row list.
    const selectedIssues = new Set();
    let lastClickedIssueId = null;
    const selectionCountEl = document.getElementById('selectionCount');

    function barsForIssueId(issueId) {
      return lookupMaps.isReady()
        ? lookupMaps.getIssueBars(issueId)
        : document.querySelectorAll(`.issue-bar[data-issue-id="${issueId}"]`);
    }

    function refreshSelectionChrome() {
      if (selectedIssues.size > 0) {
        selectionCountEl.textContent = `${selectedIssues.size} selected`;
        selectionCountEl.classList.remove('hidden');
        ganttContainer.classList.add('multi-select-mode');
      } else {
        selectionCountEl.classList.add('hidden');
        ganttContainer.classList.remove('multi-select-mode');
      }
    }

    // Update selection for specific changed IDs (O(changed) instead of O(all))
    function updateSelectionForIds(changedIds) {
      changedIds.forEach(issueId => {
        barsForIssueId(issueId).forEach(bar =>
          bar.classList.toggle('selected', selectedIssues.has(issueId)));
      });
      refreshSelectionChrome();
    }

    // Full UI sync over MOUNTED bars (bulk ops + window-refresh re-sync:
    // recycled elements keep their classes across unmount/remount)
    function updateSelectionUI() {
      document.querySelectorAll('.issue-bar').forEach(bar => {
        bar.classList.toggle('selected', selectedIssues.has(bar.dataset.issueId));
      });
      refreshSelectionChrome();
    }

    function clearSelection() {
      const changedIds = [...selectedIssues]; // Copy before clearing
      selectedIssues.clear();
      lastClickedIssueId = null;
      updateSelectionForIds(changedIds);
    }

    function toggleSelection(issueId) {
      if (selectedIssues.has(issueId)) {
        selectedIssues.delete(issueId);
      } else {
        selectedIssues.add(issueId);
      }
      lastClickedIssueId = issueId;
      updateSelectionForIds([issueId]); // O(1) update for single selection
    }

    function selectRange(fromId, toId) {
      const ids = rowWindow?.getAllIssueIds() ?? [];
      const fromIndex = ids.indexOf(fromId);
      const toIndex = ids.indexOf(toId);
      if (fromIndex === -1 || toIndex === -1) return;
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const changedIds = [];
      for (let i = start; i <= end; i++) {
        const id = ids[i];
        if (!selectedIssues.has(id)) {
          selectedIssues.add(id);
          changedIds.push(id);
        }
      }
      updateSelectionForIds(changedIds);
    }

    function selectAll() {
      (rowWindow?.getAllIssueIds() ?? []).forEach(id => selectedIssues.add(id));
      updateSelectionUI();
      announce(`Selected all ${selectedIssues.size} issues`);
    }

    // Handle Ctrl+click and Shift+click on bars for selection (delegated: 1
    // listener on document instead of N per render).
    addDocListener('mousedown', (e) => {
      // Only handle Ctrl or Shift clicks for selection
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
      // Don't interfere with drag handles or link handles (closest catches
      // descendants like drag-grip circles, which classList wouldn't).
      if (e.target.closest('.drag-handle') || e.target.closest('.link-handle')) return;
      const bar = e.target.closest('.issue-bar');
      if (!bar) return;

      e.preventDefault();
      e.stopPropagation();

      const issueId = bar.dataset.issueId;
      if (e.shiftKey && lastClickedIssueId) {
        // Shift+click: range selection
        selectRange(lastClickedIssueId, issueId);
      } else {
        // Ctrl/Cmd+click: toggle selection
        toggleSelection(issueId);
      }
    });

    // Ctrl+A to select all, Escape to clear
    addDocListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
      if (e.key === 'Escape' && selectedIssues.size > 0) {
        e.stopImmediatePropagation();
        clearSelection();
        announce('Selection cleared');
      }
    });

    // Refresh button handler
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
      document.getElementById('loadingOverlay')?.classList.add('visible');
      vscode.postMessage({ command: 'refresh' });
    });

    // Show relation context menu
    function showDeletePicker(x, y, relationId, fromId, toId, relationType) {
      document.querySelector('.relation-picker')?.remove();

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      // Clamp position to viewport bounds
      const pickerWidth = 150;
      const pickerHeight = 120;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      const label = document.createElement('div');
      label.style.padding = '6px 12px';
      label.style.fontSize = '11px';
      label.style.opacity = '0.7';
      label.textContent = `#${fromId} → #${toId}`;
      picker.appendChild(label);

      // Update delay option for precedes/follows relations
      if (relationType === 'precedes' || relationType === 'follows') {
        const delayBtn = document.createElement('button');
        delayBtn.textContent = 'Update delay...';
        delayBtn.addEventListener('click', () => {
          picker.remove();
          vscode.postMessage({ command: 'updateRelationDelay', relationId, fromId, toId });
        });
        picker.appendChild(delayBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete relation';
      deleteBtn.addEventListener('click', () => {
        saveState();
        vscode.postMessage({ command: 'deleteRelation', relationId });
        picker.remove();
      });
      picker.appendChild(deleteBtn);

      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }

    // Mounted-element lookup maps (lookup-maps.js). First build deferred to
    // idle (cancelled on re-render — a zombie callback would scan the new
    // document into unreachable maps).
    const lookupMaps = createLookupMaps();
    if (typeof requestIdleCallback !== 'undefined') {
      const idleHandle = requestIdleCallback(() => lookupMaps.rebuild(), { timeout: 100 });
      extraCleanups.push(() => cancelIdleCallback(idleHandle));
    } else {
      const timeoutHandle = setTimeout(() => lookupMaps.rebuild(), 0);
      extraCleanups.push(() => clearTimeout(timeoutHandle));
    }
    // Mounted rows change on scroll/collapse — keep the maps in sync, and
    // re-sync state-driven classes (recycled elements keep stale classes
    // across unmount/remount; freshly materialized ones lack them)
    rowWindow?.onRefresh(() => {
      lookupMaps.rebuildIfReady();
      updateSelectionUI();
      applyFocusClasses();
      // A hovered element that unmounts never gets its mouseleave — drop the
      // hover state; the next pointer move re-applies it
      clearHoverHighlight();
    });

    // Track currently highlighted elements for fast clear, plus the logical
    // hover target. mouseenter/mouseleave with capture fire on EVERY internal
    // element boundary (rect -> text -> grip) — without the key, each
    // crossing did a full clear + re-apply, and each body-class flip
    // invalidates style for the whole ~77K-node tree.
    let highlightedElements = [];
    let currentHoverKey = null;

    function clearHoverHighlight() {
      if (currentHoverKey === null && highlightedElements.length === 0) return;
      currentHoverKey = null;
      document.body.classList.remove('hover-focus', 'dependency-hover');
      highlightedElements.forEach(el => el.classList.remove('hover-highlighted', 'hover-source'));
      highlightedElements = [];
    }

    // NOTE: plain bar/label hovers deliberately do NOT touch document.body —
    // only arrow hovers (the dim-everything effect) pay that document-wide
    // style invalidation.
    function highlightIssue(issueId) {
      // Use cached lookups if ready, otherwise fall back to DOM query
      const bars = lookupMaps.isReady() ? lookupMaps.getIssueBars(issueId)
        : document.querySelectorAll('.issue-bar[data-issue-id="' + issueId + '"]');
      const labels = lookupMaps.isReady() ? lookupMaps.getIssueLabels(issueId)
        : document.querySelectorAll('.issue-label[data-issue-id="' + issueId + '"]');
      const arrows = lookupMaps.isReady() ? lookupMaps.getArrows(issueId)
        : document.querySelectorAll('.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]');
      bars.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      labels.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      arrows.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
    }

    function highlightProject(collapseKey) {
      const labels = lookupMaps.isReady() ? lookupMaps.getProjectLabels(collapseKey)
        : document.querySelectorAll('.project-label[data-collapse-key="' + collapseKey + '"]');
      const bars = lookupMaps.isReady() ? lookupMaps.getAggregateBars(collapseKey)
        : document.querySelectorAll('.aggregate-bars[data-collapse-key="' + collapseKey + '"]');
      labels.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
      bars.forEach(el => { el.classList.add('hover-highlighted'); highlightedElements.push(el); });
    }

    // Use event delegation for hover events (single listener instead of N listeners)
    const timelineSvg = document.querySelector('.gantt-timeline svg');
    const labelsSvg = document.querySelector('.gantt-labels svg');

    if (timelineSvg) {
      timelineSvg.addEventListener('mouseenter', (e) => {
        const bar = e.target.closest('.issue-bar');
        const aggBar = e.target.closest('.aggregate-bars');
        const arrow = e.target.closest('.dependency-arrow');
        if (bar) {
          const issueId = bar.dataset.issueId;
          if (!issueId || currentHoverKey === 'issue:' + issueId) return;
          clearHoverHighlight();
          currentHoverKey = 'issue:' + issueId;
          highlightIssue(issueId);
        } else if (aggBar) {
          const key = aggBar.dataset.collapseKey;
          if (!key || currentHoverKey === 'project:' + key) return;
          clearHoverHighlight();
          currentHoverKey = 'project:' + key;
          highlightProject(key);
        } else if (arrow) {
          const fromId = arrow.dataset.from;
          const toId = arrow.dataset.to;
          const hoverKey = 'arrow:' + fromId + '-' + toId;
          if (currentHoverKey === hoverKey) return;
          clearHoverHighlight();
          currentHoverKey = hoverKey;
          document.body.classList.add('hover-focus', 'dependency-hover');
          arrow.classList.add('hover-source');
          highlightedElements.push(arrow);
          if (fromId) highlightIssue(fromId);
          if (toId) highlightIssue(toId);
        }
      }, true); // capture phase for delegation

      timelineSvg.addEventListener('mouseleave', (e) => {
        const container = e.target.closest('.issue-bar, .aggregate-bars, .dependency-arrow');
        if (!container) return;
        // Crossing an INTERNAL boundary fires mouseleave too — only clear
        // when the pointer actually exits the element
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        clearHoverHighlight();
      }, true);
    }

    if (labelsSvg) {
      labelsSvg.addEventListener('mouseenter', (e) => {
        const label = e.target.closest('.issue-label');
        const projectLabel = e.target.closest('.project-label');
        if (label) {
          const issueId = label.dataset.issueId;
          if (!issueId || currentHoverKey === 'issue:' + issueId) return;
          clearHoverHighlight();
          currentHoverKey = 'issue:' + issueId;
          highlightIssue(issueId);
        } else if (projectLabel) {
          const key = projectLabel.dataset.collapseKey;
          if (!key || currentHoverKey === 'project:' + key) return;
          clearHoverHighlight();
          currentHoverKey = 'project:' + key;
          highlightProject(key);
        }
      }, true);

      labelsSvg.addEventListener('mouseleave', (e) => {
        const container = e.target.closest('.issue-label, .project-label');
        if (!container) return;
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        clearHoverHighlight();
      }, true);
    }

    // Dependency arrow right-click delete (delegated)
    if (timelineSvg) {
      // Hide tooltip early on right-click mousedown (before browser shows it)
      timelineSvg.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return; // right-click only
        const arrow = e.target.closest('.dependency-arrow');
        if (!arrow) return;
        const title = arrow.querySelector('title');
        if (title) title.remove();
      });

      timelineSvg.addEventListener('contextmenu', (e) => {
        const arrow = e.target.closest('.dependency-arrow');
        if (!arrow) return;
        e.preventDefault();

        const relationId = parseInt(arrow.dataset.relationId);
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        // Get relation type from class (e.g., rel-precedes -> precedes)
        const relTypeClass = [...arrow.classList].find(c => c.startsWith('rel-'));
        const relationType = relTypeClass ? relTypeClass.replace('rel-', '') : null;
        showDeletePicker(e.clientX, e.clientY, relationId, fromId, toId, relationType);
      });

      // Dependency arrow click to select/highlight
      let selectedArrow = null;
      const selectedArrowElements = []; // Track selected arrows for fast clearing
      const arrowConnectedElements = []; // Track connected bars/labels for fast clearing
      timelineSvg.addEventListener('click', (e) => {
        const arrow = e.target.closest('.dependency-arrow');

        // Clear previous selection
        if (selectedArrow) {
          selectedArrow.classList.remove('selected');
          document.body.classList.remove('arrow-selection-mode');
          document.querySelectorAll('.arrow-connected').forEach(el => el.classList.remove('arrow-connected'));
          selectedArrow = null;
        }

        if (!arrow) return;

        // Select clicked arrow
        e.stopPropagation();
        selectedArrow = arrow;
        arrow.classList.add('selected');
        selectedArrowElements.push(arrow);
        document.body.classList.add('arrow-selection-mode');

        // Highlight connected bars and labels (use lookup maps if ready)
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        const connectedBars = lookupMaps.isReady()
          ? [...lookupMaps.getIssueBars(fromId), ...lookupMaps.getIssueBars(toId)]
          : document.querySelectorAll(`.issue-bar[data-issue-id="${fromId}"], .issue-bar[data-issue-id="${toId}"]`);
        const connectedLabels = lookupMaps.isReady()
          ? [...lookupMaps.getIssueLabels(fromId), ...lookupMaps.getIssueLabels(toId)]
          : document.querySelectorAll(`.issue-label[data-issue-id="${fromId}"], .issue-label[data-issue-id="${toId}"]`);
        connectedBars.forEach(bar => { bar.classList.add('arrow-connected'); arrowConnectedElements.push(bar); });
        connectedLabels.forEach(label => { label.classList.add('arrow-connected'); arrowConnectedElements.push(label); });

        announce(`Selected relation from #${fromId} to #${toId}`);
      });

      // Helper to clear all arrow selections (single or multi-select)
      // Uses tracked elements instead of DOM queries for O(1) clear
      function clearArrowSelection() {
        selectedArrowElements.forEach(a => a.classList.remove('selected'));
        selectedArrowElements.length = 0;
        document.body.classList.remove('arrow-selection-mode');
        arrowConnectedElements.forEach(el => el.classList.remove('arrow-connected'));
        arrowConnectedElements.length = 0;
        selectedArrow = null;
      }

      // Window refreshes rebuild the dependency layer (collapse toggles) and
      // mount/recycle bars (scroll): re-resolve the selected arrow by its
      // stable relation id and re-apply connected highlights — or drop the
      // selection mode entirely if the arrow is no longer rendered.
      rowWindow?.onRefresh(() => {
        if (!selectedArrow) return;
        const relationId = selectedArrow.dataset.relationId;
        const fresh = relationId
          ? document.querySelector(`.dependency-arrow[data-relation-id="${relationId}"]`)
          : null;
        if (!fresh) {
          clearArrowSelection(); // endpoint collapsed away — nothing to highlight
          return;
        }
        selectedArrow = fresh;
        selectedArrowElements.length = 0;
        selectedArrowElements.push(fresh);
        fresh.classList.add('selected');
        arrowConnectedElements.forEach(el => el.classList.remove('arrow-connected'));
        arrowConnectedElements.length = 0;
        [fresh.dataset.from, fresh.dataset.to].forEach(id => {
          document.querySelectorAll(`.issue-bar[data-issue-id="${id}"], .issue-label[data-issue-id="${id}"]`)
            .forEach(el => { el.classList.add('arrow-connected'); arrowConnectedElements.push(el); });
        });
      });

      // Click elsewhere to deselect arrows (cleanup previous handlers)
      if (window._ganttArrowClickHandler) {
        document.removeEventListener('click', window._ganttArrowClickHandler);
      }
      window._ganttArrowClickHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector('.dependency-arrow.selected');
        if (hasSelection && !e.target.closest('.dependency-arrow') && !e.target.closest('.blocks-badge-group') && !e.target.closest('.blocker-badge')) {
          clearArrowSelection();
        }
      };
      document.addEventListener('click', window._ganttArrowClickHandler);

      // Escape to deselect arrows (cleanup previous handler)
      if (window._ganttArrowKeyHandler) {
        document.removeEventListener('keydown', window._ganttArrowKeyHandler);
      }
      window._ganttArrowKeyHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector('.dependency-arrow.selected');
        if (e.key === 'Escape' && hasSelection) {
          e.stopImmediatePropagation();
          clearArrowSelection();
        }
      };
      document.addEventListener('keydown', window._ganttArrowKeyHandler);
    }

    setupDrag({
      vscode,
      menuUndo,
      menuRedo,
      addDocListener,
      closeOnOutsideClick,
      announce,
      // Keep the dragged row(s) mounted while a drag is in progress
      pinRow: (key) => rowWindow?.pin(key),
      pinRows: (keys) => rowWindow?.pinAll(keys),
      unpinRow: () => rowWindow?.unpin(),
      saveState,
      updateUndoRedoButtons,
      undoStack,
      redoStack,
      selectedIssues,
      clearSelection,
      redmineBaseUrl,
      minDateMs,
      maxDateMs,
      timelineWidth,
      dayWidth,
      barHeight,
      ganttScroll,
      snapToDay,
      focusOnDependencyChain,
      clearFocus,
      getFocusedIssueId,
      scrollToAndHighlight,
      isDraftModeEnabled: () => currentDraftMode,
      isPerfDebugEnabled: () => PERF_DEBUG,
      lookupMaps,
      rowWindow
    });

    setupRowInteraction({
      vscode,
      addDocListener,
      addWinListener,
      announce,
      barHeight,
      selectedCollapseKey,
      allExpandableKeys: state.allExpandableKeys,
      rowWindow,
      perfLog
    });

    // Scroll to today marker (centered in visible timeline area)
    // announceOutOfRange: only notify the user when THEY asked to go to today
    // (button / "T"). On auto-scroll at load we silently rest at the nearest
    // edge — a blocking modal on every open of a past-dated project is noise.
    function scrollToToday(announceOutOfRange = true) {
      if (!todayInRange) {
        if (announceOutOfRange) {
          vscode.postMessage({ command: 'todayOutOfRange' });
        } else if (ganttScroll) {
          ganttScroll.scrollLeft = todayX < 0 ? 0 : ganttScroll.scrollWidth;
        }
        return;
      }
      if (ganttScroll) {
        const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
        const stickyWidth = stickyLeft?.offsetWidth ?? 0;
        const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
        ganttScroll.scrollLeft = Math.max(0, todayX - visibleTimelineWidth / 2);
      }
    }

    // Scroll to and highlight an issue (for click/keyboard navigation).
    // The row may be unmounted — scrollToKey scrolls vertically AND mounts
    // it, so the element queries below can succeed.
    function scrollToAndHighlight(issueId) {
      if (!issueId) return;
      const meta = rowWindow?.getRowMetaByIssueId(issueId);
      if (meta) rowWindow.scrollToKey(meta.key);
      const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
      const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
      if (label) {
        label.classList.add('highlighted');
        setTimeout(() => label.classList.remove('highlighted'), 1500);
      }
      if (bar && ganttScroll) {
        const barRect = bar.getBoundingClientRect();
        const scrollRect = ganttScroll.getBoundingClientRect();
        const scrollLeft = ganttScroll.scrollLeft + barRect.left - scrollRect.left - 100;
        ganttScroll.scrollTo({ left: Math.max(0, scrollLeft), behavior: 'smooth' });
        bar.classList.add('highlighted');
        setTimeout(() => bar.classList.remove('highlighted'), 1500);
      }
    }

    setupKeyboard({
      vscode,
      addDocListener,
      menuUndo,
      menuRedo,
      undoStack,
      redoStack,
      saveState,
      updateUndoRedoButtons,
      announce,
      scrollToAndHighlight,
      scrollToToday,
      rowWindow
    });

    setupTooltips({
      addDocListener,
      addWinListener,
      ganttScroll
    });
    // Restore scroll position or scroll to today on initial load
    // Defer to next frame to avoid blocking initial paint and batch layout reads
    requestAnimationFrame(() => {
      if (savedCenterDateMs !== null && ganttScroll) {
        // Date-based restore: works correctly when date range changes
        // Clamp to current date range if saved date is outside
        const clampedDateMs = Math.max(minDateMs, Math.min(maxDateMs, savedCenterDateMs));
        // Always scroll to clamped date (nearest edge if out of range)
        scrollToCenterDate(clampedDateMs);
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedCenterDateMs = null;
        savedScrollTop = null;
      } else if (savedScrollLeft !== null && ganttScroll) {
        // Legacy pixel position (deprecated, kept for backward compat)
        ganttScroll.scrollLeft = savedScrollLeft;
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedScrollLeft = null;
        savedScrollTop = null;
      } else {
        scrollToToday(false); // auto-scroll: no modal if today is out of range
      }
      // Initialize minimap viewport (batched with scroll restoration)
      updateMinimapViewport();
      // Allow scroll state saving after restoration completes
      restoringScroll = false;
    });

    // Today button handler (user-initiated → announce if out of range)
    document.getElementById('todayBtn')?.addEventListener('click', () => scrollToToday());

    // Column resize handling
    const resizeHandle = document.getElementById('resizeHandle');
    const resizeHandleHeader = document.getElementById('resizeHandleHeader');
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    let activeResizeHandle = null;

    function startResize(e, handle) {
      isResizing = true;
      activeResizeHandle = handle;
      resizeStartX = e.clientX;
      resizeStartWidth = labelsColumn.offsetWidth;
      handle.classList.add('dragging');
      document.body.classList.add('cursor-col-resize', 'user-select-none');
      e.preventDefault();
    }

    resizeHandle?.addEventListener('mousedown', (e) => startResize(e, resizeHandle));
    resizeHandleHeader?.addEventListener('mousedown', (e) => startResize(e, resizeHandleHeader));

    // RAF throttle for smooth column resize
    let resizeRafPending = false;
    let lastResizeEvent = null;
    addDocListener('mousemove', (e) => {
      if (!isResizing) return;
      lastResizeEvent = e;
      if (resizeRafPending) return;
      resizeRafPending = true;
      requestAnimationFrame(() => {
        resizeRafPending = false;
        if (!lastResizeEvent) return;
        const delta = lastResizeEvent.clientX - resizeStartX;
        const newWidth = Math.min(600, Math.max(120, resizeStartWidth + delta));
        // Resize both header and body labels columns + inner SVG
        if (ganttLeftHeader) ganttLeftHeader.style.width = newWidth + 'px';
        if (labelsColumn) {
          labelsColumn.style.width = newWidth + 'px';
          const labelsSvg = labelsColumn.querySelector('svg');
          if (labelsSvg) labelsSvg.setAttribute('width', String(newWidth));
        }
        // Update capacity ribbon label width (label + resize handle + extra columns)
        const capacityLabel = document.querySelector('.capacity-ribbon-label');
        if (capacityLabel) {
          capacityLabel.style.width = (newWidth + leftExtrasWidth) + 'px';
        }
        updateMinimapPosition();
      });
    });

    addDocListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        activeResizeHandle?.classList.remove('dragging');
        activeResizeHandle = null;
        document.body.classList.remove('cursor-col-resize', 'user-select-none');
        saveState(); // Persist new column width
      }
    });

    // Auto-hide loading overlay after content renders
    requestAnimationFrame(() => {
      document.getElementById('loadingOverlay')?.classList.remove('visible');
    });
    perfMark('initializeGantt-end');
    perfMeasure('initializeGantt', 'initializeGantt-start', 'initializeGantt-end');
}









