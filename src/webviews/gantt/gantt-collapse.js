import {
  findDescendants as findDescendantsUtil,
  findVisibleDescendants as findVisibleDescendantsUtil,
  buildAncestorChains,
} from './collapse-utils.js';
import { parseTranslateX, parseTranslateY, pickRowKeyByY } from './selection-utils.js';

export function setupCollapse(ctx) {
  const { vscode, addDocListener, addWinListener, announce, barHeight, selectedCollapseKey, refreshArrowGeometry } = ctx;

  // Collapse toggle click (before issue-label handler to stop propagation)
  document.querySelectorAll('.collapse-toggle').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      // Get collapse key from parent label element
      const label = el.closest('[data-collapse-key]');
      const collapseKey = label?.dataset.collapseKey;
      if (collapseKey) {
        // Instant client-side toggle (all rows are in DOM)
        toggleCollapseClientSide(collapseKey);
      }
    });
  });

  // Expand/collapse all menu items
  document.getElementById('menuExpand')?.addEventListener('click', () => {
    // Use pre-computed list of ALL expandable keys (not just visible DOM elements)
    const ganttScroll = document.getElementById('ganttScroll');
    const allKeys = ganttScroll?.dataset.allExpandableKeys;
    const keys = allKeys ? JSON.parse(allKeys) : [];
    vscode.postMessage({ command: 'expandAll', keys });
  });
  document.getElementById('menuCollapse')?.addEventListener('click', () => {
    vscode.postMessage({ command: 'collapseAll' });
  });

  // Labels click and keyboard navigation
  const allLabels = Array.from(document.querySelectorAll('.project-label, .issue-label, .time-group-label'));
  let activeLabel = null;
  const savedSelectedKey = selectedCollapseKey ?? null;

  // Check if label is visible (not hidden by collapse)
  function isLabelVisible(label) {
    return !label.classList.contains('gantt-row-hidden') && label.getAttribute('visibility') !== 'hidden';
  }

  // Find next visible label from index (direction: 1=down, -1=up)
  function findVisibleLabel(fromIndex, direction) {
    let i = fromIndex + direction;
    while (i >= 0 && i < allLabels.length) {
      if (isLabelVisible(allLabels[i])) return { label: allLabels[i], index: i };
      i += direction;
    }
    return null;
  }

  // Scroll label into view (vertical only, for keyboard navigation)
  function scrollLabelIntoView(label) {
    const scrollContainer = document.getElementById('ganttScroll');
    const headerRow = document.querySelector('.gantt-header-row');
    if (!scrollContainer || !label) return;

    const headerHeight = headerRow?.getBoundingClientRect().height || 60;
    const labelRow = label.closest('.gantt-row');
    if (!labelRow) return;

    const rowTop = labelRow.getBoundingClientRect().top;
    const rowHeight = labelRow.getBoundingClientRect().height;
    const containerRect = scrollContainer.getBoundingClientRect();
    const visibleTop = containerRect.top + headerHeight;
    const visibleBottom = containerRect.bottom;

    // Only scroll if label is outside visible area
    if (rowTop < visibleTop) {
      // Label is above visible area - scroll up
      scrollContainer.scrollBy({ top: rowTop - visibleTop - 4, behavior: 'smooth' });
    } else if (rowTop + rowHeight > visibleBottom) {
      // Label is below visible area - scroll down
      scrollContainer.scrollBy({ top: (rowTop + rowHeight) - visibleBottom + 4, behavior: 'smooth' });
    }
  }

  function setActiveLabel(label, skipNotify = false, scrollIntoView = false, skipFocus = false) {
    if (activeLabel) activeLabel.classList.remove('active');
    activeLabel = label;
    if (label) {
      label.classList.add('active');
      // preventScroll: selecting via a chart click shouldn't yank the view to
      // the label; keyboard nav scrolls explicitly via scrollLabelIntoView.
      if (!skipFocus) label.focus({ preventScroll: true });
      if (scrollIntoView) scrollLabelIntoView(label);
      // Persist selection to extension for re-render preservation
      if (!skipNotify) {
        vscode.postMessage({ command: 'setSelectedKey', collapseKey: label.dataset.collapseKey });
      }
    }
    updateRowSelectionOverlays();
  }

  // Restore focus to active label when webview regains focus
  addWinListener('focus', () => {
    if (activeLabel && isLabelVisible(activeLabel)) {
      activeLabel.focus();
    }
  });

  // Escape to deselect active label
  addDocListener('keydown', (e) => {
    if (e.key === 'Escape' && activeLabel) {
      activeLabel.classList.remove('active');
      activeLabel.blur();
      activeLabel = null;
      vscode.postMessage({ command: 'setSelectedKey', collapseKey: null });
      updateRowSelectionOverlays();
    }
  });

  // Row index for O(1) lookups during collapse
  const rowIndex = new Map(); // collapseKey → { originalY, elements: [] }
  const ancestorCache = new Map(); // collapseKey → [parentKey, grandparentKey, ...]
  const childrenCache = new Map(); // parentKey → Set of direct child keys (for O(1) descendant lookup)
  const expandedStateCache = new Map(); // collapseKey → boolean (avoids DOM queries)
  const stripeContributionsCache = new Map(); // stripe originalY → parsed contributions object

  // Parse stripe contributions with caching (avoids repeated JSON.parse)
  function getStripeContributions(stripe) {
    const originalY = stripe.dataset.originalY;
    if (stripeContributionsCache.has(originalY)) {
      return stripeContributionsCache.get(originalY);
    }
    const contributions = JSON.parse(stripe.dataset.rowContributions || '{}');
    stripeContributionsCache.set(originalY, contributions);
    return contributions;
  }

  function buildRowIndex() {
    rowIndex.clear();
    const elements = document.querySelectorAll('[data-collapse-key][data-original-y]');
    elements.forEach(el => {
      const key = el.dataset.collapseKey;
      const originalY = parseFloat(el.dataset.originalY);
      if (!rowIndex.has(key)) {
        rowIndex.set(key, { originalY, elements: [] });
      }
      rowIndex.get(key).elements.push(el);
    });
  }

  function buildAncestorCache() {
    ancestorCache.clear();
    childrenCache.clear();
    expandedStateCache.clear();

    // Single O(N) pass to collect (key, parentKey) pairs, then resolve ancestor
    // chains via a Map instead of a `document.querySelector` per ancestor — the
    // old walk was O(rows × depth × N) over the full ~75K-node tree and was the
    // dominant cost of initializeGantt (multi-second on large By-Project views).
    const pairs = [];
    document.querySelectorAll('[data-collapse-key][data-parent-key]').forEach(el => {
      pairs.push({ key: el.dataset.collapseKey, parentKey: el.dataset.parentKey });
    });
    const built = buildAncestorChains(pairs);
    built.ancestorCache.forEach((ancestors, key) => ancestorCache.set(key, ancestors));
    built.childrenCache.forEach((children, parentKey) => childrenCache.set(parentKey, children));

    // Build expanded state cache from DOM (once at init)
    document.querySelectorAll('[data-collapse-key][data-expanded]').forEach(el => {
      expandedStateCache.set(el.dataset.collapseKey, el.dataset.expanded === 'true');
    });
  }

  // Build indexes on load
  buildRowIndex();
  buildAncestorCache();

  // Full-row selection overlays: ONE rect per column SVG + timeline (7 nodes
  // total, O(1) DOM — per-cell rects would add ~5N nodes). Inserted as first
  // child so they render under row content.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const selectionOverlays = [];
  [
    '.gantt-labels svg',
    '.gantt-col-status svg',
    '.gantt-col-id svg',
    '.gantt-col-start svg',
    '.gantt-col-due svg',
    '.gantt-col-assignee svg',
    '.gantt-timeline svg'
  ].forEach(selector => {
    const svg = document.querySelector(selector);
    if (!svg) return; // column may be hidden/absent
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'row-selection-overlay');
    rect.setAttribute('x', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', String(barHeight + 2)); // match row-hit-area band
    rect.setAttribute('visibility', 'hidden');
    svg.insertBefore(rect, svg.firstChild);
    selectionOverlays.push(rect);
  });

  // Position overlays on the active row (current Y from transform — collapse
  // shifts rows away from originalY). Hide when no/hidden selection.
  function updateRowSelectionOverlays() {
    const key = activeLabel?.dataset.collapseKey;
    const entry = key ? rowIndex.get(key) : null;
    if (!entry || !isLabelVisible(activeLabel)) {
      selectionOverlays.forEach(rect => rect.setAttribute('visibility', 'hidden'));
      return;
    }
    const el = entry.elements[0];
    const y = parseTranslateY(el.getAttribute('transform'), entry.originalY);
    selectionOverlays.forEach(rect => {
      rect.setAttribute('y', String(y - 1)); // row-hit-area starts at -1
      rect.setAttribute('visibility', 'visible');
    });
  }

  // Helper to toggle SVG element visibility
  function setSvgVisibility(el, hidden) {
    if (hidden) {
      el.setAttribute('visibility', 'hidden');
      el.classList.add('gantt-row-hidden');
    } else {
      el.removeAttribute('visibility');
      el.classList.remove('gantt-row-hidden');
    }
  }

  // Grow (or shrink) an SVG's height attribute by delta
  function growSvgHeight(svg, delta) {
    if (!svg) return;
    const currentHeight = parseFloat(svg.getAttribute('height') || '0');
    svg.setAttribute('height', String(currentHeight + delta));
  }

  // Wrapper functions that pass module caches to utilities
  function findDescendants(parentKey) {
    return findDescendantsUtil(parentKey, childrenCache);
  }

  function findVisibleDescendants(parentKey) {
    return findVisibleDescendantsUtil(parentKey, childrenCache, expandedStateCache);
  }

  // Client-side collapse/expand toggle for instant response
  // All rows are rendered in DOM (hidden rows have visibility:hidden)
  // This enables instant toggle without VS Code re-render roundtrip
  function toggleCollapseClientSide(collapseKey, action) {
    // Find the parent label element (must be a label with hasChildren).
    // rowIndex already holds the row's elements — avoids a full-tree query.
    const parentLabel = rowIndex.get(collapseKey)?.elements.find(el =>
      el.classList.contains('project-label') ||
      el.classList.contains('time-group-label') ||
      el.classList.contains('issue-label'));
    if (!parentLabel || parentLabel.dataset.hasChildren !== 'true') {
      return;
    }

    const wasExpanded = parentLabel.dataset.expanded === 'true';
    const shouldExpand = action === 'expand' ? true : action === 'collapse' ? false : !wasExpanded;
    if (shouldExpand === wasExpanded) {
      return;
    }

    // Update chevron state FIRST (before findVisibleDescendants checks it)
    parentLabel.dataset.expanded = shouldExpand ? 'true' : 'false';
    expandedStateCache.set(collapseKey, shouldExpand); // Keep cache in sync
    const chevron = parentLabel.querySelector('.collapse-toggle');
    if (chevron) chevron.classList.toggle('expanded', shouldExpand);

    // For EXPAND: only show descendants whose ancestor chain is expanded
    // For COLLAPSE: hide ALL descendants
    const allDescendants = findDescendants(collapseKey);
    const visibleDescendants = shouldExpand ? findVisibleDescendants(collapseKey) : [];

    if (allDescendants.length === 0) {
      // No descendants, just sync state
      vscode.postMessage({ command: 'collapseStateSync', collapseKey, isExpanded: shouldExpand });
      return;
    }

    const descendantSet = new Set(allDescendants);
    const visibleSet = new Set(visibleDescendants);
    const parentEntry = rowIndex.get(collapseKey);
    const parentRowY = parentEntry?.originalY ?? 0; // Row coordinate system

    // Calculate delta from stripe contributions for CURRENTLY VISIBLE descendants only
    // When collapsing: only count rows that are currently visible (not already hidden by nested collapse)
    // When expanding: only count rows that will become visible (respecting nested expanded states)
    // Also find the parent's stripe Y position (different coordinate system than rows)
    const countedKeys = new Set();
    let actualDelta = 0;
    let parentStripeY = 0;
    // For collapse: calculate visible descendants (excluding already-hidden nested items)
    const deltaDescendants = shouldExpand ? visibleDescendants : findVisibleDescendants(collapseKey);
    const deltaSet = new Set(deltaDescendants);
    // Cache zebra-stripe query once (reused 3x in this function)
    const allStripes = document.querySelectorAll('.zebra-stripe');
    allStripes.forEach(stripe => {
      const contributions = getStripeContributions(stripe);
      // Find parent's stripe Y (stripe containing the collapseKey)
      if (collapseKey in contributions && parentStripeY === 0) {
        parentStripeY = parseFloat(stripe.dataset.originalY || '0');
      }
      for (const [key, contribution] of Object.entries(contributions)) {
        if (deltaSet.has(key) && !countedKeys.has(key)) {
          actualDelta += parseFloat(contribution);
          countedKeys.add(key);
        }
      }
    });

    // Adopt rows that were hidden at render time: stripes are built from
    // render-time-VISIBLE rows only, so first-expanding a collapsed block found
    // no contributions and fell back to a full re-render. Every row is a
    // uniform barHeight with no gaps, so credit each missing row to the
    // parent's band and persist it — this and all future toggles stay
    // client-side.
    if (shouldExpand && countedKeys.size < deltaDescendants.length) {
      const missing = deltaDescendants.filter(key => !countedKeys.has(key));
      const parentStripes = Array.from(allStripes)
        .filter(stripe => collapseKey in getStripeContributions(stripe));
      if (parentStripes.length > 0) {
        missing.forEach(key => {
          actualDelta += barHeight;
          countedKeys.add(key);
        });
        // Column-SVG duplicates of a band share one cached contributions object
        // (keyed by originalY) — mutate it once, rewrite each stripe's dataset
        const mutated = new Set();
        parentStripes.forEach(stripe => {
          const contributions = getStripeContributions(stripe);
          if (!mutated.has(contributions)) {
            missing.forEach(key => { contributions[key] = barHeight; });
            mutated.add(contributions);
          }
          stripe.dataset.rowContributions = JSON.stringify(contributions);
        });
      }
    }

    // Fallback: if no contributions found, use re-render
    if (actualDelta === 0 && deltaDescendants.length > 0) {
      vscode.postMessage({ command: 'collapseStateSync', collapseKey, isExpanded: shouldExpand });
      vscode.postMessage({ command: 'requestRerender' });
      return;
    }

    const delta = shouldExpand ? actualDelta : -actualDelta;

    // Get parent's CURRENT Y position (from transform, not originalY)
    let parentCurrentY = parentRowY;
    if (parentEntry && parentEntry.elements.length > 0) {
      const parentTransform = parentEntry.elements[0].getAttribute('transform');
      parentCurrentY = parseTranslateY(parentTransform, parentRowY);
    }

    // Toggle visibility of descendants and position them correctly
    let nextY = parentCurrentY + barHeight; // First child goes right after parent
    if (shouldExpand) {
      // EXPAND: only show visibleDescendants, position them sequentially
      visibleDescendants.forEach(key => {
        const entry = rowIndex.get(key);
        if (entry) {
          entry.elements.forEach(el => {
            const x = parseTranslateX(el.getAttribute('transform'), 0);
            el.setAttribute('transform', 'translate(' + x + ', ' + nextY + ')');
            setSvgVisibility(el, false); // Show
          });
          nextY += barHeight;
        }
      });
    } else {
      // COLLAPSE: hide ALL descendants
      allDescendants.forEach(key => {
        const entry = rowIndex.get(key);
        if (entry) {
          entry.elements.forEach(el => {
            setSvgVisibility(el, true); // Hide
          });
        }
      });
    }

    // Shift rows BELOW the parent (not descendants, not above)
    rowIndex.forEach(({ originalY, elements }, key) => {
      // Only shift rows that are below the parent and not any descendant
      if (originalY > parentRowY && !descendantSet.has(key)) {
        elements.forEach(el => {
          const transform = el.getAttribute('transform');
          // Extract current X (for timeline bars)
          const x = parseTranslateX(transform, 0);
          // Extract current Y
          const currentY = parseTranslateY(transform, originalY);
          el.setAttribute('transform', 'translate(' + x + ', ' + (currentY + delta) + ')');
        });
      }
    });

    // Update SVG heights
    // Don't set viewBox on labels SVG - it causes scaling issues on column resize
    growSvgHeight(document.querySelector('.gantt-labels svg'), delta);

    // Update other column heights
    [
      '.gantt-col-status svg',
      '.gantt-col-id svg',
      '.gantt-col-start svg',
      '.gantt-col-due svg',
      '.gantt-col-assignee svg'
    ].forEach(sel => growSvgHeight(document.querySelector(sel), delta));

    // Update timeline height
    growSvgHeight(document.querySelector('.gantt-timeline svg'), delta);

    // Build set of collapsed parents for visibility checks (use cache instead of DOM query)
    const collapsedKeys = new Set();
    expandedStateCache.forEach((isExpanded, key) => {
      if (!isExpanded) {
        collapsedKeys.add(key);
      }
    });

    // Handle zebra stripes: hide stripes covering descendants, shift stripes below
    // First pass: calculate actions for each unique stripe (by originalY)
    const stripeActions = new Map(); // originalY -> { action, newHeight?, newY? }
    // Reuse allStripes from earlier query
    allStripes.forEach((stripe) => {
      const originalY = parseFloat(stripe.dataset.originalY || '0');
      if (stripeActions.has(originalY)) return; // Skip duplicates

      const contributions = getStripeContributions(stripe);
      const contributingKeys = Object.keys(contributions);

      // Check what this stripe covers
      const coversOnlyDescendants = contributingKeys.length > 0 &&
        contributingKeys.every(key => descendantSet.has(key));
      const coversAnyDescendant = contributingKeys.some(key => descendantSet.has(key));
      const isBelowParent = originalY > parentStripeY;

      if (coversOnlyDescendants) {
        stripeActions.set(originalY, { action: 'toggle-visibility', hide: !shouldExpand });
      } else if (coversAnyDescendant) {
        if (!shouldExpand) {
          let newHeight = 0;
          for (const [key, contribution] of Object.entries(contributions)) {
            if (!descendantSet.has(key)) {
              newHeight += parseFloat(contribution);
            }
          }
          stripeActions.set(originalY, { action: 'shrink', newHeight });
        } else {
          // EXPANDING: calculate correct height based on visible descendants (not originalHeight)
          // Include parent (not in descendantSet) + visible descendants
          let newHeight = 0;
          for (const [key, contribution] of Object.entries(contributions)) {
            if (!descendantSet.has(key) || visibleSet.has(key)) {
              newHeight += parseFloat(contribution);
            }
          }
          stripeActions.set(originalY, { action: 'expand', newHeight });
        }
      } else if (isBelowParent) {
        const currentY = parseFloat(stripe.getAttribute('y') || String(originalY));
        stripeActions.set(originalY, { action: 'shift', newY: currentY + delta });
      }
    });

    // Second pass: apply actions to ALL stripes (including duplicates across SVGs)
    allStripes.forEach((stripe) => {
      const originalY = parseFloat(stripe.dataset.originalY || '0');
      const action = stripeActions.get(originalY);
      if (!action) return;

      switch (action.action) {
        case 'toggle-visibility':
          setSvgVisibility(stripe, action.hide);
          break;
        case 'shrink':
          stripe.setAttribute('height', String(action.newHeight));
          break;
        case 'expand':
          stripe.setAttribute('height', String(action.newHeight));
          break;
        case 'shift':
          stripe.setAttribute('y', String(action.newY));
          break;
      }
    });

    // Re-alternate visible stripes by Y position
    // Group stripes by Y to handle multiple columns having stripes at same Y
    // Reuse allStripes from earlier query
    const visibleStripes = Array.from(allStripes)
      .filter(s => s.getAttribute('visibility') !== 'hidden');

    const stripesByY = new Map();
    visibleStripes.forEach(stripe => {
      const y = parseFloat(stripe.getAttribute('y') || '0');
      if (!stripesByY.has(y)) stripesByY.set(y, []);
      stripesByY.get(y).push(stripe);
    });

    // Sort unique Y positions and assign same opacity to all stripes at each Y
    const sortedYs = Array.from(stripesByY.keys()).sort((a, b) => a - b);
    sortedYs.forEach((y, idx) => {
      const opacity = idx % 2 === 0 ? '0.03' : '0.06';
      stripesByY.get(y).forEach(stripe => stripe.setAttribute('opacity', opacity));
    });

    // Handle indent guide lines
    document.querySelectorAll('.indent-guide-line').forEach(line => {
      const forParent = line.dataset.forParent;
      const ancestors = ancestorCache.get(forParent) || [];
      const shouldHide = collapsedKeys.has(forParent) || ancestors.some(a => collapsedKeys.has(a));
      setSvgVisibility(line, shouldHide);

      // Shift indent guides for parents below the collapsed row
      if (!shouldHide) {
        const parentOfGuide = rowIndex.get(forParent);
        if (parentOfGuide && parentOfGuide.originalY > parentRowY) {
          // This guide's parent is below collapsed row - shift it
          const y1 = parseFloat(line.getAttribute('y1') || '0');
          const y2 = parseFloat(line.getAttribute('y2') || '0');
          line.setAttribute('y1', y1 + delta);
          line.setAttribute('y2', y2 + delta);
        }
      }
    });

    // Toggle dependency arrows. Row hidden-state comes from rowIndex (all of a
    // row's elements share the gantt-row-hidden class) — a per-arrow
    // document.querySelector here was an O(arrows × DOM) full-tree scan.
    const isRowHidden = (issueId) => {
      const entry = rowIndex.get('issue-' + issueId);
      return entry ? entry.elements[0].classList.contains('gantt-row-hidden') : false;
    };
    document.querySelectorAll('.dependency-arrow').forEach(arrow => {
      setSvgVisibility(arrow, isRowHidden(arrow.dataset.from) || isRowHidden(arrow.dataset.to));
    });

    // Arrow paths were computed at render time — re-anchor them to the
    // rows' current (shifted) positions
    refreshArrowGeometry?.();

    // Selected row may have shifted or been hidden by this toggle
    updateRowSelectionOverlays();

    // Sync state to extension for persistence (no re-render)
    vscode.postMessage({ command: 'collapseStateSync', collapseKey, isExpanded: shouldExpand });
  }

  // Restore selection from previous render
  if (savedSelectedKey) {
    const savedLabel = allLabels.find(el => el.dataset.collapseKey === savedSelectedKey);
    if (savedLabel) {
      setActiveLabel(savedLabel, true);
    }
  }

  allLabels.forEach((el, index) => {
    el.addEventListener('click', (e) => {
      // Chevron has its own handler with stopPropagation - won't reach here
      if (e.target.closest?.('.collapse-toggle') || e.target.closest?.('.chevron-hit-area')) {
        return;
      }

      const issueId = el.dataset.issueId;
      const isProject = el.classList.contains('project-label');
      const isTimeGroup = el.classList.contains('time-group-label');
      const collapseKey = el.dataset.collapseKey;

      // Project/time-group labels: toggle collapse on click (if has children)
      if ((isProject || isTimeGroup) && collapseKey) {
        setActiveLabel(el);
        if (el.dataset.hasChildren === 'true') {
          // Instant client-side toggle (all rows are in DOM)
          toggleCollapseClientSide(collapseKey);
        }
        return;
      }

      // Issue labels
      const clickedOnText = e.target.classList?.contains('issue-text') || e.target.closest('.issue-text');
      if (issueId && clickedOnText) {
        // Single click on text selects; double click opens quick-pick
        setActiveLabel(el);
      } else if (el.dataset.hasChildren === 'true' && collapseKey) {
        // Parent issue: clicking elsewhere toggles collapse
        setActiveLabel(el);
        // Instant client-side toggle (all rows are in DOM)
        toggleCollapseClientSide(collapseKey);
      } else {
        // Regular issue: clicking elsewhere just selects
        setActiveLabel(el);
      }
    });

    // Double click on issue text opens the quick-pick (Enter does too)
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest?.('.collapse-toggle') || e.target.closest?.('.chevron-hit-area')) {
        return;
      }
      const issueId = el.dataset.issueId;
      const clickedOnText = e.target.classList?.contains('issue-text') || e.target.closest('.issue-text');
      if (issueId && clickedOnText) {
        e.preventDefault();
        vscode.postMessage({ command: 'openIssue', issueId: parseInt(issueId, 10) });
      }
    });

    el.addEventListener('keydown', (e) => {
      const collapseKey = el.dataset.collapseKey;
      const issueId = el.dataset.issueId ? parseInt(el.dataset.issueId, 10) : NaN;

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!isNaN(issueId)) {
            vscode.postMessage({ command: 'openIssue', issueId });
          }
          break;
        case 'ArrowUp': {
          e.preventDefault();
          const prev = findVisibleLabel(index, -1);
          if (prev) setActiveLabel(prev.label, false, true);
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          const next = findVisibleLabel(index, 1);
          if (next) setActiveLabel(next.label, false, true);
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          // VS Code behavior: if expanded, collapse; if collapsed, go to parent
          if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'true') {
            // Instant client-side collapse (all rows are in DOM)
            toggleCollapseClientSide(collapseKey, 'collapse');
          } else if (el.dataset.parentKey) {
            // Navigate to parent
            const parent = allLabels.find(l => l.dataset.collapseKey === el.dataset.parentKey);
            if (parent) setActiveLabel(parent, false, true);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          // VS Code behavior: if collapsed, expand; if expanded, go to first child
          if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'false') {
            // Instant client-side expand (all rows are in DOM)
            toggleCollapseClientSide(collapseKey, 'expand');
          } else if (el.dataset.hasChildren === 'true' && el.dataset.expanded === 'true') {
            // Navigate to first visible child
            const firstChild = allLabels.find(l => l.dataset.parentKey === collapseKey && isLabelVisible(l));
            if (firstChild) setActiveLabel(firstChild, false, true);
          }
          break;
        case 'Home': {
          e.preventDefault();
          const first = findVisibleLabel(-1, 1);
          if (first) setActiveLabel(first.label, false, true);
          break;
        }
        case 'End': {
          e.preventDefault();
          const last = findVisibleLabel(allLabels.length, -1);
          if (last) setActiveLabel(last.label, false, true);
          break;
        }
        case 'PageDown': {
          e.preventDefault();
          // Skip ~10 visible labels
          let target = index, count = 0;
          while (count < 10 && target < allLabels.length - 1) {
            const next = findVisibleLabel(target, 1);
            if (!next) break;
            target = next.index;
            count++;
          }
          if (count > 0) setActiveLabel(allLabels[target], false, true);
          break;
        }
        case 'PageUp': {
          e.preventDefault();
          // Skip ~10 visible labels
          let target = index, count = 0;
          while (count < 10 && target > 0) {
            const prev = findVisibleLabel(target, -1);
            if (!prev) break;
            target = prev.index;
            count++;
          }
          if (count > 0) setActiveLabel(allLabels[target], false, true);
          break;
        }
        case 'Tab':
          // Jump to corresponding bar in timeline
          if (!e.shiftKey && !isNaN(issueId)) {
            const bar = document.querySelector(`.issue-bar[data-issue-id="${issueId}"]`);
            if (bar) {
              e.preventDefault();
              bar.focus();
              announce(`Timeline bar for issue #${issueId}`);
            }
          }
          break;
      }
    });
  });

  // Click-to-select: delegated handler for NON-label rows (column cells, bars,
  // aggregate bars) and empty timeline lanes. Select on MOUSEDOWN, not click:
  // a bar mousedown starts a move-drag that swallows the subsequent click, so a
  // click handler never fires for bars. Mousedown always fires, and "pressing a
  // bar selects its row" is the expected behaviour (a drag then proceeds
  // normally). Labels keep their own click handlers (skipped here). No
  // stopPropagation — the drag/existing handlers still run.
  addDocListener('mousedown', (e) => {
    // Leave modifier gestures to the multi-select handler
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Only inside the gantt body (excludes toolbar, minimap, modals, pickers)
    if (!e.target.closest('#ganttScroll')) return;
    // Skip interactive elements (drag handles, link handle, badges, form fields)
    if (e.target.closest('.collapse-toggle, .chevron-hit-area, .drag-handle, ' +
        '.link-handle, .blocks-badge-group, .blocker-badge, .progress-badge-group, ' +
        '.flex-badge-group, button, input, select')) {
      return;
    }
    const row = e.target.closest('.gantt-row[data-collapse-key]');
    // Labels already select via their own click handlers — avoid double-firing
    if (row && row.matches('.project-label, .issue-label, .time-group-label')) return;

    let key = row?.dataset.collapseKey || null;
    if (!key) {
      // Empty timeline lane: resolve row from press Y over visible label bands
      if (!e.target.closest('.gantt-timeline')) return;
      const rows = [];
      for (const l of allLabels) {
        if (!isLabelVisible(l)) continue;
        const r = l.getBoundingClientRect();
        rows.push({ key: l.dataset.collapseKey, y: r.top, height: r.height });
      }
      key = pickRowKeyByY(rows, e.clientY);
      if (!key) return;
    }
    const label = allLabels.find(l => l.dataset.collapseKey === key);
    // Focus the row's label (same as a label click) so the row is clearly
    // selected (bright :focus highlight) and arrow keys navigate rows. The drag
    // mousedown's preventDefault blocks bar focus, so we focus the label here.
    if (label) setActiveLabel(label);
  });

  // Row navigation when a row is selected but its label doesn't hold DOM focus
  // — e.g. selected via a chart/bar press, where the drag's preventDefault
  // stops the label taking focus. Without this, Arrow/Home/End fall through to
  // the scroll container and scroll the chart instead of moving the selection.
  // The per-label keydown handles the focused case and preventDefaults, so we
  // bail on defaultPrevented (no double navigation). No selection → we do
  // nothing and the chart scrolls as before.
  addDocListener('keydown', (e) => {
    if (e.defaultPrevented || !activeLabel) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // If a bar holds focus, let its own handlers act (date nudge on Left/Right,
    // bar-to-bar nav on Up/Down) rather than duplicating here.
    if (document.activeElement?.closest?.('.issue-bar')) return;
    const index = allLabels.indexOf(activeLabel);
    if (index < 0) return;
    const collapseKey = activeLabel.dataset.collapseKey;
    const hasChildren = activeLabel.dataset.hasChildren === 'true';
    const expanded = activeLabel.dataset.expanded === 'true';
    const navTo = (t) => { if (t) { e.preventDefault(); setActiveLabel(t.label, false, true); } };
    switch (e.key) {
      case 'ArrowDown': navTo(findVisibleLabel(index, 1)); break;
      case 'ArrowUp': navTo(findVisibleLabel(index, -1)); break;
      case 'Home': navTo(findVisibleLabel(-1, 1)); break;
      case 'End': navTo(findVisibleLabel(allLabels.length, -1)); break;
      case 'ArrowLeft':
        // Expanded → collapse; otherwise jump to parent (VS Code tree behaviour)
        e.preventDefault();
        if (hasChildren && expanded && collapseKey) {
          toggleCollapseClientSide(collapseKey, 'collapse');
        } else if (activeLabel.dataset.parentKey) {
          const parent = allLabels.find(l => l.dataset.collapseKey === activeLabel.dataset.parentKey);
          if (parent) setActiveLabel(parent, false, true);
        }
        break;
      case 'ArrowRight':
        // Collapsed → expand; if already expanded, jump to first visible child
        e.preventDefault();
        if (hasChildren && !expanded && collapseKey) {
          toggleCollapseClientSide(collapseKey, 'expand');
        } else if (hasChildren && expanded && collapseKey) {
          const firstChild = allLabels.find(l => l.dataset.parentKey === collapseKey && isLabelVisible(l));
          if (firstChild) setActiveLabel(firstChild, false, true);
        }
        break;
      default: return;
    }
  });
}
