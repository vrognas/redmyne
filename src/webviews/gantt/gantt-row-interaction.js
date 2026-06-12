/**
 * Collapse/expand + row selection + label keyboard navigation for the
 * windowed Gantt. A toggle is a data operation: flip the key in the
 * row-window's expanded set and refresh (the window recomputes the visible
 * list, remounts ~viewport rows, and re-renders zebra/indent/arrow layers).
 * All the former geometry machinery — stripe contributions, adoption, row
 * shifting, per-arrow visibility — is gone with the emit-everything DOM.
 *
 * Selection and navigation are KEY-based (elements churn with the window):
 * listeners are delegated on the scroll container, and the active element is
 * re-resolved through the row-window after every refresh.
 */
export function setupRowInteraction(ctx) {
  const { vscode, addDocListener, addWinListener, announce, barHeight, selectedCollapseKey, allExpandableKeys, rowWindow, perfLog = () => {} } = ctx;

  const scrollEl = document.getElementById('ganttScroll');
  if (!scrollEl || !rowWindow) return;

  // Expand/collapse all: client-side window refresh + one bulk sync message
  function setAllExpanded(keys, label) {
    const t0 = performance.now();
    rowWindow.setAllExpanded(keys);
    vscode.postMessage({ command: 'collapseStateSyncBulk', expandedKeys: keys });
    perfLog(`${label}: ${(performance.now() - t0).toFixed(1)}ms windowed (${keys.length} expanded)`);
  }
  document.getElementById('menuExpand')?.addEventListener('click', () => {
    setAllExpanded(allExpandableKeys ?? [], 'expand-all');
  });
  document.getElementById('menuCollapse')?.addEventListener('click', () => {
    setAllExpanded([], 'collapse-all');
  });

  // ---------- collapse toggle (data op) ----------

  function toggleCollapseClientSide(collapseKey, action) {
    const meta = rowWindow.getRowMeta(collapseKey);
    if (!meta || !meta.hasChildren) return;
    const wasExpanded = rowWindow.isExpanded(collapseKey);
    const shouldExpand = action === 'expand' ? true : action === 'collapse' ? false : !wasExpanded;
    if (shouldExpand === wasExpanded) return;
    const t0 = performance.now();
    rowWindow.setExpanded(collapseKey, shouldExpand);
    // Sync state to extension for persistence (no re-render)
    vscode.postMessage({ command: 'collapseStateSync', collapseKey, isExpanded: shouldExpand });
    updateRowSelectionOverlays();
    perfLog(`toggle ${collapseKey} ${shouldExpand ? 'expand' : 'collapse'}: ${(performance.now() - t0).toFixed(1)}ms windowed`);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      perfLog(`toggle ${collapseKey}: frame painted ${(performance.now() - t0).toFixed(1)}ms after click`);
    }));
  }

  // ---------- selection (key-based) ----------

  let activeKey = null;
  let activeEl = null; // last element that got the 'active' class (may be recycled)

  // Single spelling of "what counts as a row label" — all sites must agree
  // (click select, focused/unfocused keydown split, mousedown double-fire guard)
  const LABEL_SELECTOR = '.project-label, .issue-label, .time-group-label';

  function setActiveKey(key, { notify = true, focus = true, scroll = false } = {}) {
    if (activeEl) activeEl.classList.remove('active');
    activeKey = key;
    if (scroll && key) rowWindow.scrollToKey(key);
    const el = key ? rowWindow.getLabelElement(key) : null;
    activeEl = el;
    if (el) {
      el.classList.add('active');
      // preventScroll: selecting via a chart click shouldn't yank the view;
      // keyboard nav scrolls explicitly via rowWindow.scrollToKey.
      if (focus) el.focus({ preventScroll: true });
    }
    if (notify) {
      vscode.postMessage({ command: 'setSelectedKey', collapseKey: key ?? null });
    }
    updateRowSelectionOverlays();
  }

  // Full-row selection overlays: ONE rect per column SVG + timeline (7 nodes
  // total). Inserted as first child so they render under row content. The
  // SVG set comes from the row window — the same nodes whose heights it owns.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const selectionOverlays = [];
  rowWindow.getBodySvgs().forEach(svg => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'row-selection-overlay');
    rect.setAttribute('x', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', String(barHeight + 2)); // match row-hit-area band
    rect.setAttribute('visibility', 'hidden');
    svg.insertBefore(rect, svg.firstChild);
    selectionOverlays.push(rect);
  });

  // Full-row HOVER band: same shape as the selection overlays, driven by
  // pointer Y so any part of the row (labels, columns, empty timeline
  // lane) lights the whole row up like a native list.
  const hoverOverlays = [];
  rowWindow.getBodySvgs().forEach(svg => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'row-hover-overlay');
    rect.setAttribute('x', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', String(barHeight + 2));
    rect.setAttribute('visibility', 'hidden');
    rect.setAttribute('pointer-events', 'none');
    svg.insertBefore(rect, svg.firstChild);
    hoverOverlays.push(rect);
  });

  let hoverRowY = null;
  function setHoverRowY(y) {
    if (y === hoverRowY) return;
    hoverRowY = y;
    if (y === null) {
      hoverOverlays.forEach(r => r.setAttribute('visibility', 'hidden'));
    } else {
      hoverOverlays.forEach(r => {
        r.setAttribute('y', String(y - 1)); // match row-hit-area band
        r.setAttribute('visibility', 'visible');
      });
    }
  }

  // The body top is cached — getBoundingClientRect on every mousemove
  // forces layout. All .gantt-body columns share the same top, so any
  // one works; vertical scroll, resize and remounts invalidate it.
  let hoverBodyTop = null;
  const invalidateHoverTop = () => { hoverBodyTop = null; };

  addDocListener('mousemove', (e) => {
    const body = e.target.closest && e.target.closest('.gantt-body');
    if (!body) { setHoverRowY(null); return; }
    if (hoverBodyTop === null) hoverBodyTop = body.getBoundingClientRect().top;
    const index = Math.floor((e.clientY - hoverBodyTop) / barHeight);
    const y = index * barHeight;
    if (y === hoverRowY) return; // same row — skip the key lookup
    setHoverRowY(rowWindow.keyAtIndex(index) ? y : null);
  });
  addDocListener('mouseleave', () => setHoverRowY(null));
  addWinListener('blur', () => setHoverRowY(null));
  addWinListener('resize', invalidateHoverTop);
  // Rows shift under a stationary pointer on scroll/collapse/remount —
  // the band would light the wrong row until the next mousemove. Hide it
  // and re-measure on the next move.
  addDocListener('scroll', () => { invalidateHoverTop(); setHoverRowY(null); }, { capture: true });
  rowWindow.onRefresh(() => { invalidateHoverTop(); setHoverRowY(null); });

  function updateRowSelectionOverlays() {
    const y = activeKey ? rowWindow.getVirtualY(activeKey) : null;
    if (y === null) {
      selectionOverlays.forEach(rect => rect.setAttribute('visibility', 'hidden'));
      return;
    }
    selectionOverlays.forEach(rect => {
      rect.setAttribute('y', String(y - 1)); // row-hit-area starts at -1
      rect.setAttribute('visibility', 'visible');
    });
  }

  // After every window refresh the active element may be a different node
  // (remount/recycle) or the row may have left the visible list.
  rowWindow.onRefresh(() => {
    if (!activeKey) return;
    const el = rowWindow.getLabelElement(activeKey);
    if (el && el !== activeEl) {
      if (activeEl) activeEl.classList.remove('active');
      el.classList.add('active');
      activeEl = el;
    }
    // Unmounting the focused label dropped DOM focus to <body> (Enter/Space/
    // Tab go through the focused-label handler) — restore it on remount.
    // Only when focus actually fell to body: never steal from inputs/buttons.
    if (el && (document.activeElement === document.body || document.activeElement === document.documentElement)) {
      el.focus({ preventScroll: true });
    }
    updateRowSelectionOverlays();
  });

  // Restore focus to active label when webview regains focus
  addWinListener('focus', () => {
    const el = activeKey ? rowWindow.getLabelElement(activeKey) : null;
    if (el) el.focus({ preventScroll: true });
  });

  // Escape to deselect
  addDocListener('keydown', (e) => {
    if (e.key === 'Escape' && activeKey) {
      const el = rowWindow.getLabelElement(activeKey);
      if (el) el.blur();
      setActiveKey(null);
    }
  });

  // ---------- delegated label interactions ----------

  scrollEl.addEventListener('click', (e) => {
    // Chevron toggles without selecting-side effects of the label body
    if (e.target.closest('.collapse-toggle, .chevron-hit-area')) {
      const label = e.target.closest('[data-collapse-key]');
      if (label?.dataset.collapseKey) {
        e.stopPropagation();
        toggleCollapseClientSide(label.dataset.collapseKey);
      }
      return;
    }
    const label = e.target.closest(LABEL_SELECTOR);
    if (!label) return;
    const key = label.dataset.collapseKey;
    const issueId = label.dataset.issueId;
    const isProjectish = label.classList.contains('project-label') || label.classList.contains('time-group-label');
    const clickedOnText = e.target.classList?.contains('issue-text') || e.target.closest('.issue-text');

    setActiveKey(key);
    if (isProjectish && label.dataset.hasChildren === 'true') {
      toggleCollapseClientSide(key);
    } else if (issueId && !clickedOnText && label.dataset.hasChildren === 'true') {
      // Parent issue: clicking outside the text toggles collapse
      toggleCollapseClientSide(key);
    }
    // Plain issues / text clicks: selection only
  });

  // Double click on issue text opens the quick-pick (Enter does too)
  scrollEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.collapse-toggle, .chevron-hit-area')) return;
    const label = e.target.closest('.issue-label');
    const issueId = label?.dataset.issueId;
    const clickedOnText = e.target.classList?.contains('issue-text') || e.target.closest('.issue-text');
    if (issueId && clickedOnText) {
      e.preventDefault();
      vscode.postMessage({ command: 'openIssue', issueId: parseInt(issueId, 10) });
    }
  });

  // ---------- keyboard navigation over the visible list ----------

  function focusKey(key) {
    if (!key) return;
    setActiveKey(key, { scroll: true });
  }

  // A selected row hidden by collapse navigates from its nearest visible
  // ancestor (up lands ON the ancestor, down lands just past its collapsed
  // subtree) — clamping to the board extremes would teleport the selection.
  function nearestVisibleAncestorIndex(fromKey) {
    let key = rowWindow.getRowMeta(fromKey)?.parentKey;
    let hops = 0;
    while (key && hops < 100) {
      const idx = rowWindow.visibleIndexOf(key);
      if (idx >= 0) return idx;
      key = rowWindow.getRowMeta(key)?.parentKey;
      hops++;
    }
    return -1;
  }

  function navRelative(fromKey, delta) {
    const list = rowWindow.getVisibleList();
    if (list.length === 0) return null;
    let idx = rowWindow.visibleIndexOf(fromKey);
    if (idx < 0) {
      const anchor = nearestVisibleAncestorIndex(fromKey);
      if (anchor < 0) {
        return (delta > 0 ? list[0] : list[list.length - 1])?.key ?? null;
      }
      // Treat the hidden row as sitting at the anchor: up by 1 reaches the
      // ancestor itself, down by 1 the first row after its collapsed subtree
      const target = delta < 0
        ? Math.max(0, anchor + delta + 1)
        : Math.min(list.length - 1, anchor + delta);
      return list[target]?.key ?? null;
    }
    const target = Math.max(0, Math.min(list.length - 1, idx + delta));
    return list[target]?.key ?? null;
  }

  function handleNavKeydown(e, key) {
    const meta = key ? rowWindow.getRowMeta(key) : null;
    const hasChildren = !!meta?.hasChildren;
    const expanded = key ? rowWindow.isExpanded(key) : false;
    const issueId = meta?.issueId ?? null;

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (issueId !== null) {
          vscode.postMessage({ command: 'openIssue', issueId });
        }
        return true;
      case 'ArrowDown':
        e.preventDefault();
        focusKey(navRelative(key, 1));
        return true;
      case 'ArrowUp':
        e.preventDefault();
        focusKey(navRelative(key, -1));
        return true;
      case 'Home':
        e.preventDefault();
        focusKey(rowWindow.keyAtIndex(0));
        return true;
      case 'End':
        e.preventDefault();
        focusKey(rowWindow.keyAtIndex(rowWindow.getVisibleList().length - 1));
        return true;
      case 'PageDown':
        e.preventDefault();
        focusKey(navRelative(key, 10));
        return true;
      case 'PageUp':
        e.preventDefault();
        focusKey(navRelative(key, -10));
        return true;
      case 'ArrowLeft':
        // VS Code behavior: if expanded, collapse; if collapsed, go to parent
        e.preventDefault();
        if (hasChildren && expanded) {
          toggleCollapseClientSide(key, 'collapse');
        } else if (meta?.parentKey) {
          focusKey(meta.parentKey);
        }
        return true;
      case 'ArrowRight':
        // VS Code behavior: if collapsed, expand; if expanded, go to first child
        e.preventDefault();
        if (hasChildren && !expanded) {
          toggleCollapseClientSide(key, 'expand');
        } else if (hasChildren && expanded) {
          const idx = rowWindow.visibleIndexOf(key);
          const next = rowWindow.keyAtIndex(idx + 1); // first visible child follows its parent
          const nextMeta = next ? rowWindow.getRowMeta(next) : null;
          if (nextMeta && nextMeta.parentKey === key) focusKey(next);
        }
        return true;
      case 'Tab':
        // Jump to corresponding bar in timeline
        if (!e.shiftKey && issueId !== null) {
          const bar = document.querySelector(`.issue-bar[data-issue-id="${issueId}"]`);
          if (bar) {
            e.preventDefault();
            bar.focus();
            announce(`Timeline bar for issue #${issueId}`);
            return true;
          }
        }
        return false;
      default:
        return false;
    }
  }

  // Focused-label keydown (delegated — labels mount and unmount)
  scrollEl.addEventListener('keydown', (e) => {
    const label = e.target.closest?.(LABEL_SELECTOR);
    if (!label) return;
    handleNavKeydown(e, label.dataset.collapseKey);
  });

  // Row navigation when a row is selected but its label doesn't hold DOM
  // focus (e.g. selected via a chart/bar press). The delegated handler above
  // preventDefaults for the focused case, so bail on defaultPrevented.
  // Whitelisted to pure nav keys: handling Enter/Space/Tab at document level
  // would cancel button activation and yank focus out of modals.
  const DOC_NAV_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown'
  ]);
  addDocListener('keydown', (e) => {
    if (e.defaultPrevented || !activeKey) return;
    if (!DOC_NAV_KEYS.has(e.key)) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    // If a bar holds focus, its own handlers act (date nudge, bar nav)
    if (document.activeElement?.closest?.('.issue-bar')) return;
    if (e.target.closest?.(LABEL_SELECTOR)) return;
    handleNavKeydown(e, activeKey);
  });

  // ---------- ghost projections: inert except row-select ----------

  // Ghosts are hover-info surfaces, nothing more. One capture-phase guard
  // owns the whole contract: a plain press selects the row WITHOUT focus
  // or scroll (preventDefault stops native focus of the tabindex'd bar
  // group, whose bar+ghost bbox is wide; Chromium doesn't reliably honor
  // preventScroll on SVG focus), and stopPropagation keeps every
  // downstream mouse handler — bar pin-highlight on click, dependency
  // focus on dblclick — from ever seeing a ghost event.
  const onGhostPointer = (e) => {
    if (!e.target.closest?.('.ghost-projection')) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type !== 'mousedown') return;
    // Modifier presses stay inert (bars don't multi-select either)
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const key = e.target.closest('.gantt-row[data-collapse-key]')?.dataset.collapseKey
      ?? e.target.closest('.issue-bar')?.dataset.collapseKey;
    if (key) setActiveKey(key, { focus: false });
  };
  ['mousedown', 'click', 'dblclick'].forEach((type) =>
    addDocListener(type, onGhostPointer, { capture: true })
  );

  // ---------- click-to-select for non-label targets ----------

  addDocListener('mousedown', (e) => {
    // Leave modifier gestures to the multi-select handler
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!e.target.closest('#ganttScroll')) return;
    // Skip interactive elements (drag handles, link handle, badges, form fields)
    if (e.target.closest('.collapse-toggle, .chevron-hit-area, .drag-handle, ' +
        '.link-handle, .blocks-badge-group, .blocker-badge, .progress-badge-group, ' +
        '.flex-badge-group, button, input, select')) {
      return;
    }
    const row = e.target.closest('.gantt-row[data-collapse-key]');
    // Labels already select via their own click handler — avoid double-firing
    if (row && row.matches(LABEL_SELECTOR)) return;

    let key = row?.dataset.collapseKey || null;
    if (!key) {
      // Empty timeline lane: derive the row from pointer Y in content space
      const timeline = e.target.closest('.gantt-timeline');
      if (!timeline) return;
      const svg = timeline.querySelector('svg');
      if (!svg) return;
      const contentY = e.clientY - svg.getBoundingClientRect().top;
      key = rowWindow.keyAtIndex(Math.floor(contentY / barHeight));
      if (!key) return;
    }
    // Focus the row's label (same as a label click) so arrow keys navigate
    setActiveKey(key);
  });

  // Restore selection from the previous render. Collapse-hidden keys restore
  // too — setActiveKey tolerates them (no element, overlays hidden) and
  // keyboard nav resumes from the nearest visible ancestor; skipping the
  // restore left Escape/arrows/overlays dead until the next click.
  if (selectedCollapseKey && rowWindow.getRowMeta(selectedCollapseKey)) {
    setActiveKey(selectedCollapseKey, { notify: false, focus: false });
  }
}
