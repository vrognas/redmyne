export function setupCollapse(ctx) {
  const { vscode, addDocListener, addWinListener, announce, barHeight, selectedCollapseKey } = ctx;

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
      if (!skipFocus) label.focus();
      if (scrollIntoView) scrollLabelIntoView(label);
      // Persist selection to extension for re-render preservation
      if (!skipNotify) {
        vscode.postMessage({ command: 'setSelectedKey', collapseKey: label.dataset.collapseKey });
      }
    }
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
    }
  });

  // Row index for O(1) lookups during collapse
  const rowIndex = new Map(); // collapseKey → { originalY, elements: [] }
  const ancestorCache = new Map(); // collapseKey → [parentKey, grandparentKey, ...]
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
    const elements = document.querySelectorAll('[data-collapse-key][data-parent-key]');
    elements.forEach(el => {
      const key = el.dataset.collapseKey;
      if (ancestorCache.has(key)) return; // Already built for this key
      const ancestors = [];
      let parentKey = el.dataset.parentKey;
      while (parentKey) {
        ancestors.push(parentKey);
        const parentEl = document.querySelector('[data-collapse-key="' + parentKey + '"]');
        parentKey = parentEl?.dataset.parentKey || null;
      }
      ancestorCache.set(key, ancestors);
    });
  }

  // Build indexes on load
  buildRowIndex();
  buildAncestorCache();

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

  // Find all descendants of a collapse key
  function findDescendants(parentKey) {
    const result = [];
    ancestorCache.forEach((ancestors, key) => {
      if (ancestors.includes(parentKey)) result.push(key);
    });
    return result;
  }

  // Find descendants that should be VISIBLE when expanding parentKey
  // Only includes descendants whose entire ancestor chain (up to parentKey) is expanded
  function findVisibleDescendants(parentKey) {
    const result = [];
    ancestorCache.forEach((ancestors, key) => {
      const idx = ancestors.indexOf(parentKey);
      if (idx === -1) return; // Not a descendant of parentKey

      // Check all ancestors between this node and parentKey
      // ancestors[0] is immediate parent, ancestors[idx] is parentKey
      // All ancestors from 0 to idx-1 must be expanded for this node to be visible
      let allAncestorsExpanded = true;
      for (let i = 0; i < idx; i++) {
        const ancestorKey = ancestors[i];
        const ancestorLabel = document.querySelector('[data-collapse-key="' + ancestorKey + '"].project-label, [data-collapse-key="' + ancestorKey + '"].issue-label, [data-collapse-key="' + ancestorKey + '"].time-group-label');
        if (!ancestorLabel || ancestorLabel.dataset.expanded !== 'true') {
          allAncestorsExpanded = false;
          break;
        }
      }
      if (allAncestorsExpanded) {
        result.push(key);
      }
    });
    return result;
  }

  // Client-side collapse/expand toggle for instant response
  // All rows are rendered in DOM (hidden rows have visibility:hidden)
  // This enables instant toggle without VS Code re-render roundtrip
  function toggleCollapseClientSide(collapseKey, action) {
    // Find the parent label element (must be a label with hasChildren)
    const parentLabel = document.querySelector('[data-collapse-key="' + collapseKey + '"].project-label, [data-collapse-key="' + collapseKey + '"].time-group-label, [data-collapse-key="' + collapseKey + '"].issue-label');
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
    const currentlyVisibleDescendants = shouldExpand ? visibleDescendants : findVisibleDescendants(collapseKey);
    const deltaDescendants = currentlyVisibleDescendants;
    const deltaSet = new Set(deltaDescendants);
    document.querySelectorAll('.zebra-stripe').forEach(stripe => {
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
      const parentTransform = parentEntry.elements[0].getAttribute('transform') || '';
      const parentYMatch = parentTransform.match(/translate\([^,]+,\s*([-\d.]+)/);
      if (parentYMatch) {
        parentCurrentY = parseFloat(parentYMatch[1]);
      }
    }

    // Toggle visibility of descendants and position them correctly
    let nextY = parentCurrentY + barHeight; // First child goes right after parent
    if (shouldExpand) {
      // EXPAND: only show visibleDescendants, position them sequentially
      visibleDescendants.forEach(key => {
        const entry = rowIndex.get(key);
        if (entry) {
          entry.elements.forEach(el => {
            const transform = el.getAttribute('transform') || '';
            const xMatch = transform.match(/translate\(([-\d.]+)/);
            const x = xMatch ? xMatch[1] : '0';
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
          const transform = el.getAttribute('transform') || '';
          // Extract current X (for timeline bars)
          const xMatch = transform.match(/translate\(([-\d.]+)/);
          const x = xMatch ? xMatch[1] : '0';
          // Extract current Y
          const yMatch = transform.match(/translate\([^,]+,\s*([-\d.]+)/);
          const currentY = yMatch ? parseFloat(yMatch[1]) : originalY;
          const newY = currentY + delta;
          el.setAttribute('transform', 'translate(' + x + ', ' + newY + ')');
        });
      }
    });

    // Update SVG heights
    const labelColumn = document.querySelector('.gantt-labels svg');
    if (labelColumn) {
      const currentHeight = parseFloat(labelColumn.getAttribute('height') || '0');
      const newHeight = currentHeight + delta;
      labelColumn.setAttribute('height', String(newHeight));
      // Don't set viewBox on labels SVG - it causes scaling issues on column resize
    }

    // Update other column heights
    const columnSelectors = [
      '.gantt-col-status svg',
      '.gantt-col-id svg',
      '.gantt-col-start svg',
      '.gantt-col-due svg',
      '.gantt-col-assignee svg'
    ];
    columnSelectors.forEach(selector => {
      const colSvg = document.querySelector(selector);
      if (!colSvg) return;
      const currentHeight = parseFloat(colSvg.getAttribute('height') || '0');
      const newHeight = currentHeight + delta;
      colSvg.setAttribute('height', String(newHeight));
    });

    // Update timeline height
    const timelineSvg = document.querySelector('.gantt-timeline svg');
    if (timelineSvg) {
      const currentHeight = parseFloat(timelineSvg.getAttribute('height') || '0');
      const newHeight = currentHeight + delta;
      timelineSvg.setAttribute('height', newHeight);
    }

    // Build set of collapsed parents for visibility checks
    const collapsedKeys = new Set();
    document.querySelectorAll('.project-label[data-has-children="true"], .time-group-label[data-has-children="true"], .issue-label[data-has-children="true"]').forEach(lbl => {
      if (lbl.dataset.expanded === 'false') {
        collapsedKeys.add(lbl.dataset.collapseKey);
      }
    });

    // Handle zebra stripes: hide stripes covering descendants, shift stripes below
    // First pass: calculate actions for each unique stripe (by originalY)
    const stripeActions = new Map(); // originalY -> { action, newHeight?, newY? }
    const allStripes = document.querySelectorAll('.zebra-stripe');
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
    const visibleStripes = Array.from(document.querySelectorAll('.zebra-stripe'))
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

    // Toggle dependency arrows
    document.querySelectorAll('.dependency-arrow').forEach(arrow => {
      const fromId = arrow.dataset.from;
      const toId = arrow.dataset.to;
      const fromBar = document.querySelector('.issue-bar[data-issue-id="' + fromId + '"]');
      const toBar = document.querySelector('.issue-bar[data-issue-id="' + toId + '"]');
      const fromHidden = fromBar?.classList.contains('gantt-row-hidden');
      const toHidden = toBar?.classList.contains('gantt-row-hidden');
      setSvgVisibility(arrow, fromHidden || toHidden);
    });

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
        // Clicking on text opens quick-pick
        setActiveLabel(el, false, false, true); // skipFocus=true
        vscode.postMessage({ command: 'openIssue', issueId: parseInt(issueId, 10) });
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
}
