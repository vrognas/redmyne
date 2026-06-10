import { computeArrowEndpoints } from './arrow-utils.js';
import { parseTranslateY } from './selection-utils.js';

export function setupDrag(ctx) {
    const {
      vscode,
      menuUndo,
      menuRedo,
      addDocListener,
      closeOnOutsideClick,
      announce,
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
      isDraftModeEnabled,
      getLookupMaps,
      rowWindow
    } = ctx;

    // Track highlighted elements for fast clearing (avoid DOM queries)
    let highlightedArrows = [];
    let highlightedConnected = [];
    function showIssueContextMenu(x, y, issueId) {
      document.querySelector('.relation-picker')?.remove();

      // Check if this is a bulk operation (multiple selected and clicked is part of selection)
      const isBulkMode = selectedIssues.size > 1 && selectedIssues.has(issueId);
      const targetIds = isBulkMode ? Array.from(selectedIssues).map(id => parseInt(id)) : [parseInt(issueId)];

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      const pickerWidth = 160;
      const pickerHeight = 180;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      const label = document.createElement('div');
      label.style.padding = '6px 12px';
      label.style.fontSize = '11px';
      label.style.opacity = '0.7';
      label.textContent = isBulkMode ? targetIds.length + ' issues selected' : '#' + issueId;
      picker.appendChild(label);

      const options = isBulkMode ? [
        { label: 'Set % Done...', command: 'bulkSetDoneRatio', bulk: true },
        { label: 'Clear Selection', command: 'clearSelection', local: true },
      ] : [
        { label: 'Update Issue...', command: 'openIssue' },
        { label: 'Open in Browser', command: 'openInBrowser' },
        { label: 'Show in Issues', command: 'showInIssues' },
        { label: 'Log Time', command: 'logTime' },
        { label: 'Set % Done', command: 'setDoneRatio' },
        { label: 'Set Internal Estimate', command: 'setInternalEstimate' },
        { label: 'Copy Link', command: 'copyLink', local: true },
        { label: 'Copy URL', command: 'copyUrl' },
      ];

      options.forEach(opt => {
        const btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.addEventListener('click', async () => {
          if (opt.command === 'copyLink') {
            // Copy with HTML format for Teams/rich text support
            const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
            const subject = bar?.dataset?.subject || 'Issue #' + issueId;
            const url = redmineBaseUrl + '/issues/' + issueId;
            const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const html = '<a href="' + esc(url) + '">#' + issueId + ' ' + esc(subject) + '</a>';
            const plain = url;
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  'text/plain': new Blob([plain], { type: 'text/plain' }),
                  'text/html': new Blob([html], { type: 'text/html' })
                })
              ]);
              vscode.postMessage({ command: 'showStatus', message: 'Copied #' + issueId + ' link' });
            } catch (e) {
              // Fallback to plain text
              await navigator.clipboard.writeText(plain);
              vscode.postMessage({ command: 'showStatus', message: 'Copied #' + issueId + ' URL' });
            }
          } else if (opt.local) {
            clearSelection();
          } else if (opt.bulk) {
            vscode.postMessage({ command: opt.command, issueIds: targetIds });
          } else {
            vscode.postMessage({ command: opt.command, issueId: parseInt(issueId) });
          }
          picker.remove();
        });
        picker.appendChild(btn);
      });

      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }

    // Issue bar/label and project label context menus are handled by VS Code native webview context menu
    // via data-vscode-context attribute (see webview/context in package.json)

    // Convert x position to date string (YYYY-MM-DD)
    function xToDate(x) {
      const ms = minDateMs + (x / timelineWidth) * (maxDateMs - minDateMs);
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }

    // Convert end x position to due date (bar endX is at due_date + 1, so subtract 1 day)
    function xToDueDate(x) {
      const ms = minDateMs + (x / timelineWidth) * (maxDateMs - minDateMs) - 86400000;
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }

    // Drag date tooltip helpers
    const dragTooltip = document.getElementById('dragDateTooltip');
    let lastTooltipDate = null;

    function formatDateShort(dateStr) {
      const d = new Date(dateStr + 'T00:00:00');
      const month = d.toLocaleDateString('en-US', { month: 'short' });
      const day = d.getDate();
      const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
      return month + ' ' + day + ' (' + weekday + ')';
    }

    function formatDateRange(startStr, endStr) {
      const sd = new Date(startStr + 'T00:00:00'), ed = new Date(endStr + 'T00:00:00');
      const sm = sd.toLocaleDateString('en-US', { month: 'short' });
      const em = ed.toLocaleDateString('en-US', { month: 'short' });
      return sm === em ? sm + ' ' + sd.getDate() + '-' + ed.getDate()
                       : sm + ' ' + sd.getDate() + '-' + em + ' ' + ed.getDate();
    }

    function showDragTooltip(text) {
      dragTooltip.textContent = text;
      dragTooltip.style.display = 'block';
      lastTooltipDate = text;
    }

    function updateDragTooltip(text) {
      if (text === lastTooltipDate) return;
      dragTooltip.textContent = text;
      lastTooltipDate = text;
    }

    function positionDragTooltip(clientX, clientY) {
      // Position above cursor, flip below if near top
      let top = clientY - 28;
      let flipped = false;
      if (top < 40) {
        top = clientY + 20;
        flipped = true;
      }
      dragTooltip.style.left = clientX + 'px';
      dragTooltip.style.top = top + 'px';
      dragTooltip.classList.toggle('flipped', flipped);
    }

    function hideDragTooltip() {
      dragTooltip.style.display = 'none';
      lastTooltipDate = null;
    }

    // Arrow path calculation for drag updates
    // Must match gantt-panel.ts initial render (arrowSize=4, chevron style, r=4 corner radius)
    const arrowSize = 4;
    const r = 4; // corner radius for rounded turns - must match gantt-panel.ts

    function calcArrowPath(x1, y1, x2, y2, isScheduling, fromStart = false, toEnd = false) {
      const goingRight = x2 > x1;
      const horizontalDist = Math.abs(x2 - x1);
      const nearlyVertical = horizontalDist < 30;
      const sameRow = Math.abs(y1 - y2) < 5;
      const goingDown = y2 > y1;

      // Jog direction depends on which anchor we're leaving from
      const jogDir = fromStart ? -1 : 1;
      // Target approach direction (unused for nearlyVertical)
      const approachDir = toEnd ? 1 : -1;
      // Minimum horizontal room needed for simple jog path
      const minJogRoom = 8 + r; // jogX + r

      let path;
      let arrowHead;

      if (!isScheduling) {
        // Non-scheduling: vertical-first routing (path computed by caller with adjusted y coords)
        const centersAligned = Math.abs(x1 - x2) < 5;
        if (sameRow) {
          // Same row: route above the bars
          const routeY = y1 - 8;
          path = 'M ' + x1 + ' ' + y1 + ' V ' + (routeY + r) +
            ' q 0 ' + (-r) + ' ' + (goingRight ? r : -r) + ' ' + (-r) +
            ' H ' + (x2 + (goingRight ? -r : r)) +
            ' q ' + (goingRight ? r : -r) + ' 0 ' + (goingRight ? r : -r) + ' ' + r +
            ' V ' + y2;
          // Arrowhead points down
          arrowHead = 'M ' + (x2 - arrowSize * 0.6) + ' ' + (y2 - arrowSize) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize * 0.6) + ' ' + (y2 - arrowSize);
        } else if (centersAligned) {
          // Centers aligned: straight vertical line
          path = 'M ' + x1 + ' ' + y1 + ' V ' + y2;
          // Arrowhead points down or up
          arrowHead = goingDown
            ? 'M ' + (x2 - arrowSize * 0.6) + ' ' + (y2 - arrowSize) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize * 0.6) + ' ' + (y2 - arrowSize)
            : 'M ' + (x2 - arrowSize * 0.6) + ' ' + (y2 + arrowSize) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize * 0.6) + ' ' + (y2 + arrowSize);
        } else {
          // Different rows: vertical, horizontal at midY, vertical
          const midY = (y1 + y2) / 2;
          path = 'M ' + x1 + ' ' + y1 + ' V ' + (midY + (goingDown ? -r : r)) +
            ' q 0 ' + (goingDown ? r : -r) + ' ' + (goingRight ? r : -r) + ' ' + (goingDown ? r : -r) +
            ' H ' + (x2 + (goingRight ? -r : r)) +
            ' q ' + (goingRight ? r : -r) + ' 0 ' + (goingRight ? r : -r) + ' ' + (goingDown ? r : -r) +
            ' V ' + y2;
          // Arrowhead points down or up
          arrowHead = goingDown
            ? 'M ' + (x2 - arrowSize * 0.6) + ' ' + (y2 - arrowSize) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize * 0.6) + ' ' + (y2 - arrowSize)
            : 'M ' + (x2 - arrowSize * 0.6) + ' ' + (y2 + arrowSize) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize * 0.6) + ' ' + (y2 + arrowSize);
        }
      } else if (sameRow && goingRight) {
        // Same row, target to right: straight horizontal line
        path = 'M ' + x1 + ' ' + y1 + ' H ' + x2;
      } else if (sameRow && !goingRight) {
        // Same row, target to left: route above with rounded corners
        const routeY = y1 - barHeight;
        path = 'M ' + x1 + ' ' + y1 + ' V ' + (routeY + r) +
          ' q 0 ' + (-r) + ' ' + (jogDir * -r) + ' ' + (-r) +
          ' H ' + (x2 + approachDir * 12 - approachDir * r) +
          ' q ' + (approachDir * -r) + ' 0 ' + (approachDir * -r) + ' ' + r +
          ' V ' + y2 + ' H ' + x2;
      } else if (!sameRow && nearlyVertical && (fromStart === goingRight || horizontalDist < minJogRoom)) {
        // Nearly vertical: S-curve with 90° turns when:
        // 1. Direction conflict (jog opposite to target direction), OR
        // 2. Not enough horizontal room for simple jog path (< 12px)
        // jogDir: which way to jog from source (-1=left, +1=right)
        // approachDir: which side to approach target from (-1=left, +1=right)
        const jogX = 8;
        const midY = (y1 + y2) / 2;
        path = 'M ' + x1 + ' ' + y1 + ' H ' + (x1 + jogDir * jogX - jogDir * r) +
          ' q ' + (jogDir * r) + ' 0 ' + (jogDir * r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (midY + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + (-jogDir * r) + ' ' + (goingDown ? r : -r) +
          ' H ' + (x2 + approachDir * jogX - approachDir * r) +
          ' q ' + (approachDir * r) + ' 0 ' + (approachDir * r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (y2 + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + (-approachDir * r) + ' ' + (goingDown ? r : -r) +
          ' H ' + x2;
      } else if (goingRight && !fromStart) {
        // FS/FF with target to right: small jog, vertical to target level, horizontal approach
        const jogX = 8;
        // Second curve turns toward target (right), not back toward source
        path = 'M ' + x1 + ' ' + y1 + ' H ' + (x1 + jogDir * jogX - jogDir * r) +
          ' q ' + (jogDir * r) + ' 0 ' + (jogDir * r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (y2 + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + r + ' ' + (goingDown ? r : -r) +
          ' H ' + x2;
      } else if (goingRight) {
        // SS/SF with target to right: horizontal at source level, then down, then approach
        const jogX = 8;
        path = 'M ' + x1 + ' ' + y1 + ' H ' + (x2 + approachDir * jogX - approachDir * r) +
          ' q ' + (approachDir * r) + ' 0 ' + (approachDir * r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (y2 + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + (-approachDir * r) + ' ' + (goingDown ? r : -r) +
          ' H ' + x2;
      } else if (fromStart) {
        // SS/SF going left: horizontal at source level, then down, then approach
        const jogX = 8;
        path = 'M ' + x1 + ' ' + y1 + ' H ' + (x2 + approachDir * jogX + r) +
          ' q ' + (-r) + ' 0 ' + (-r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (y2 + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + r + ' ' + (goingDown ? r : -r) +
          ' H ' + x2;
      } else {
        // FS/FF going left: S-curve with horizontal between rows
        const jogX = 8;
        const midY = (y1 + y2) / 2;
        path = 'M ' + x1 + ' ' + y1 + ' H ' + (x1 + jogDir * jogX - jogDir * r) +
          ' q ' + (jogDir * r) + ' 0 ' + (jogDir * r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (midY + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + (-r) + ' ' + (goingDown ? r : -r) +
          ' H ' + (x2 + approachDir * jogX + r) +
          ' q ' + (-r) + ' 0 ' + (-r) + ' ' + (goingDown ? r : -r) +
          ' V ' + (y2 + (goingDown ? -r : r)) +
          ' q 0 ' + (goingDown ? r : -r) + ' ' + r + ' ' + (goingDown ? r : -r) +
          ' H ' + x2;
      }
      // Chevron arrowhead - direction depends on approach side
      // Scheduling arrowhead (non-scheduling already computed above)
      if (isScheduling) {
        arrowHead = toEnd
          ? 'M ' + (x2 + arrowSize) + ' ' + (y2 - arrowSize * 0.6) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 + arrowSize) + ' ' + (y2 + arrowSize * 0.6)
          : 'M ' + (x2 - arrowSize) + ' ' + (y2 - arrowSize * 0.6) + ' L ' + x2 + ' ' + y2 + ' L ' + (x2 - arrowSize) + ' ' + (y2 + arrowSize * 0.6);
      }

      return { path, arrowHead };
    }

    // Bar center Y from CURRENT transform (rows shift on collapse/expand;
    // data-center-y is render-time only). Generator contract:
    // data-center-y = transformY + barHeight / 2.
    function barCenterY(bar) {
      const transformY = parseTranslateY(bar.getAttribute('transform'), NaN);
      return Number.isNaN(transformY)
        ? parseFloat(bar.dataset.centerY)
        : transformY + barHeight / 2;
    }

    function getConnectedArrows(issueId) {
      const selector = '.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]';
      return collectArrows(selector);
    }

    function collectArrows(selector) {
      const arrows = [];
      // Bar lookup must be O(1): a per-arrow document.querySelector was an
      // O(arrows × DOM) full-tree scan on every collapse/expand and drag start.
      const { mapsReady, issueBarsByIssueId } = getLookupMaps();
      let localBars = null; // fallback: one scan if the idle-built maps aren't ready yet
      const barFor = (id) => {
        if (mapsReady) return issueBarsByIssueId.get(id)?.[0] ?? null;
        if (!localBars) {
          localBars = new Map();
          document.querySelectorAll('.issue-bar').forEach(b => {
            const bid = b.dataset.issueId;
            if (bid && !localBars.has(bid)) localBars.set(bid, b);
          });
        }
        return localBars.get(id) ?? null;
      };
      document.querySelectorAll(selector).forEach(arrow => {
        const fromId = arrow.getAttribute('data-from');
        const toId = arrow.getAttribute('data-to');
        const classList = arrow.getAttribute('class') || '';
        const relMatch = classList.match(/rel-(\w+)/);
        const relType = relMatch ? relMatch[1] : 'relates';
        const isScheduling = ['blocks', 'precedes', 'finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish'].includes(relType);
        // Get source/target bar positions
        const fromBar = barFor(fromId);
        const toBar = barFor(toId);
        if (!fromBar || !toBar) return;
        arrows.push({
          element: arrow,
          fromId, toId, isScheduling, relType,
          fromBar, toBar,
          linePath: arrow.querySelector('.arrow-line'),
          hitPath: arrow.querySelector('.arrow-hit-area'),
          headPath: arrow.querySelector('.arrow-head')
        });
      });
      return arrows;
    }

    function updateArrowPositions(arrows, draggedIssueId, newStartX, newEndX) {
      arrows.forEach(a => {
        // Get current positions (may be dragged or original); Y always from
        // the live transform so arrows track collapse/expand row shifts
        const fromStartX = a.fromId == draggedIssueId ? newStartX : parseFloat(a.fromBar.dataset.startX);
        const fromEndX = a.fromId == draggedIssueId ? newEndX : parseFloat(a.fromBar.dataset.endX);
        const fromY = barCenterY(a.fromBar);
        const toStartX = a.toId == draggedIssueId ? newStartX : parseFloat(a.toBar.dataset.startX);
        const toEndX = a.toId == draggedIssueId ? newEndX : parseFloat(a.toBar.dataset.endX);
        const toY = barCenterY(a.toBar);

        const { x1, y1, x2, y2, fromStart, toEnd } = computeArrowEndpoints({
          fromStartX, fromEndX, fromY, toStartX, toEndX, toY,
          relType: a.relType, barHeight
        });

        const { path, arrowHead } = calcArrowPath(x1, y1, x2, y2, a.isScheduling, fromStart, toEnd);
        if (a.linePath) a.linePath.setAttribute('d', path);
        if (a.hitPath) a.hitPath.setAttribute('d', path);
        if (a.headPath) a.headPath.setAttribute('d', arrowHead);
      });
    }

    // Recompute ALL arrow paths from current bar positions (called after
    // collapse/expand toggles shift rows — render-time paths go stale)
    function refreshArrowGeometry() {
      updateArrowPositions(collectArrows('.dependency-arrow'), null, null, null);
    }

    // Drag confirmation modal
    const dragConfirmOverlay = document.getElementById('dragConfirmOverlay');
    const dragConfirmMessage = document.getElementById('dragConfirmMessage');
    const dragConfirmOk = document.getElementById('dragConfirmOk');
    const dragConfirmCancel = document.getElementById('dragConfirmCancel');
    let pendingDragConfirm = null;

    function showDragConfirmModal(message, onConfirm, onCancel) {
      if (!dragConfirmOverlay || !dragConfirmMessage) return;
      dragConfirmMessage.textContent = message;
      pendingDragConfirm = { onConfirm, onCancel };
      dragConfirmOverlay.style.display = 'flex';
      if (dragConfirmOk) dragConfirmOk.focus();
    }

    function hideDragConfirmModal() {
      if (dragConfirmOverlay) dragConfirmOverlay.style.display = 'none';
      pendingDragConfirm = null;
    }

    function restoreScrollPosition() {
      if (ganttScroll && dragScrollSnapshot) {
        ganttScroll.scrollLeft = dragScrollSnapshot.left;
        ganttScroll.scrollTop = dragScrollSnapshot.top;
      }
      dragScrollSnapshot = null;
    }

    dragConfirmOk?.addEventListener('click', () => {
      if (pendingDragConfirm?.onConfirm) pendingDragConfirm.onConfirm();
      dragScrollSnapshot = null; // Clear snapshot on confirm (change accepted)
      hideDragConfirmModal();
    });

    dragConfirmCancel?.addEventListener('click', () => {
      if (pendingDragConfirm?.onCancel) pendingDragConfirm.onCancel();
      restoreScrollPosition();
      hideDragConfirmModal();
    });

    // Close on Escape or overlay click
    dragConfirmOverlay?.addEventListener('click', (e) => {
      if (e.target === dragConfirmOverlay) {
        if (pendingDragConfirm?.onCancel) pendingDragConfirm.onCancel();
        restoreScrollPosition();
        hideDragConfirmModal();
      }
    });

    // Keyboard handling for modal
    addDocListener('keydown', (e) => {
      if (!pendingDragConfirm) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (pendingDragConfirm.onCancel) pendingDragConfirm.onCancel();
        restoreScrollPosition();
        hideDragConfirmModal();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pendingDragConfirm.onConfirm) pendingDragConfirm.onConfirm();
        dragScrollSnapshot = null; // Clear snapshot on confirm (change accepted)
        hideDragConfirmModal();
      }
    });


    // Drag state
    let dragState = null;
    let dragScrollSnapshot = null; // Scroll position at drag start, for restoration (modal cancel)
    let justEndedDrag = false; // Flag to skip click handler after drag ends

    // Handle drag start on handles (delegated: 1 listener instead of 2*N per render)
    addDocListener('mousedown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      e.preventDefault(); // Prevent focus/scroll anchoring
      e.stopPropagation();
      // Save scroll position at drag start for later restoration
      dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
      {
        const bar = handle.closest('.issue-bar');
        const isLeft = handle.classList.contains('drag-left');
        const issueId = parseInt(bar.dataset.issueId);
        const startX = parseFloat(bar.dataset.startX);
        const endX = parseFloat(bar.dataset.endX);
        const oldStartDate = bar.dataset.startDate || null;
        const oldDueDate = bar.dataset.dueDate || null;
        // Use bar-outline (always exists) instead of bar-main (may not exist for intensity bars)
        const barOutline = bar.querySelector('.bar-outline');
        const barMain = bar.querySelector('.bar-main'); // May be null for intensity bars
        const leftHandle = bar.querySelector('.drag-left');
        const rightHandle = bar.querySelector('.drag-right');

        bar.classList.add('dragging');
        const barLabels = bar.querySelector('.bar-labels');
        const labelsOnLeft = barLabels?.classList.contains('labels-left');
        const connectedArrows = getConnectedArrows(issueId);
        const linkHandle = bar.querySelector('.link-handle');

        // Keep the dragged row mounted if the user scrolls mid-drag
        ctx.pinRow?.('issue-' + issueId);
        dragState = {
          issueId,
          isLeft,
          isMove: false,
          initialMouseX: e.clientX,
          startX,
          endX,
          oldStartDate,
          oldDueDate,
          barOutline,
          barMain,
          leftHandle,
          rightHandle,
          // Cache grip circles to avoid querySelectorAll per frame
          leftGripCircles: leftHandle ? Array.from(leftHandle.querySelectorAll('.drag-grip circle')) : [],
          rightGripCircles: rightHandle ? Array.from(rightHandle.querySelectorAll('.drag-grip circle')) : [],
          bar,
          barLabels,
          labelsOnLeft,
          connectedArrows,
          linkHandle,
          linkHandleCircles: linkHandle ? Array.from(linkHandle.querySelectorAll('circle')) : []
        };

        // Show drag date tooltip
        const currentDate = isLeft ? oldStartDate : oldDueDate;
        if (currentDate) {
          showDragTooltip((isLeft ? 'Start: ' : 'Due: ') + formatDateShort(currentDate));
          positionDragTooltip(e.clientX, e.clientY);
        }
      }
    });

    // Handle drag start on bar body (move entire bar or bulk move)
    // (delegated: 1 listener instead of N per render)
    addDocListener('mousedown', (e) => {
      // Skip if clicking inside a drag handle (those have their own handler)
      if (e.target.closest('.drag-handle')) return;
      // Skip if Ctrl/Shift held (selection mode)
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      const outline = e.target.closest('.bar-outline');
      if (!outline) return;
      e.preventDefault(); // Prevent focus/scroll anchoring
      e.stopPropagation();
      // Save scroll position at drag start for later restoration
      dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
      {
        const bar = outline.closest('.issue-bar');
        if (!bar) return;
        const issueId = bar.dataset.issueId;

        // Check if this bar is part of a selection for bulk drag
        const isBulkDrag = selectedIssues.size > 1 && selectedIssues.has(issueId);
        if (isBulkDrag) {
          // Bars are windowed: pin every selected row so its element is
          // mounted for the visual move AND the mouseup commit
          selectedIssues.forEach(id => {
            const meta = rowWindow?.getRowMeta('issue-' + id);
            if (meta) ctx.pinRow?.(meta.key);
          });
        }
        const barsToMove = isBulkDrag
          ? Array.from(document.querySelectorAll('.issue-bar')).filter(b => selectedIssues.has(b.dataset.issueId))
          : [bar];

        // Collect data for all bars to move (cache DOM refs to avoid per-frame queries)
        const bulkBars = barsToMove.map(b => {
          const leftHandle = b.querySelector('.drag-left');
          const rightHandle = b.querySelector('.drag-right');
          return {
            issueId: b.dataset.issueId,
            startX: parseFloat(b.dataset.startX),
            endX: parseFloat(b.dataset.endX),
            oldStartDate: b.dataset.startDate || null,
            oldDueDate: b.dataset.dueDate || null,
            barOutline: b.querySelector('.bar-outline'),
            barMain: b.querySelector('.bar-main'),
            leftHandle,
            rightHandle,
            // Cache grip circles to avoid querySelectorAll per frame
            leftGripCircles: leftHandle ? Array.from(leftHandle.querySelectorAll('.drag-grip circle')) : [],
            rightGripCircles: rightHandle ? Array.from(rightHandle.querySelectorAll('.drag-grip circle')) : [],
            leftHandleRect: leftHandle?.querySelector('rect'),
            rightHandleRect: rightHandle?.querySelector('rect'),
            bar: b,
            barLabels: b.querySelector('.bar-labels'),
            labelsOnLeft: b.querySelector('.bar-labels')?.classList.contains('labels-left'),
            connectedArrows: getConnectedArrows(b.dataset.issueId),
            linkHandle: b.querySelector('.link-handle'),
            linkHandleCircles: b.querySelector('.link-handle') ? Array.from(b.querySelector('.link-handle').querySelectorAll('circle')) : []
          };
        });

        bulkBars.forEach(b => b.bar.classList.add('dragging'));

        const singleBarLabels = bar.querySelector('.bar-labels');
        const singleLabelsOnLeft = singleBarLabels?.classList.contains('labels-left');
        const connectedArrows = getConnectedArrows(issueId);
        const singleLinkHandle = bar.querySelector('.link-handle');

        const singleLeftHandle = bar.querySelector('.drag-left');
        const singleRightHandle = bar.querySelector('.drag-right');

        // Keep the dragged row mounted if the user scrolls mid-drag
        ctx.pinRow?.('issue-' + issueId);
        dragState = {
          issueId: parseInt(issueId),
          isLeft: false,
          isMove: true,
          isBulkDrag,
          bulkBars,
          initialMouseX: e.clientX,
          startX: parseFloat(bar.dataset.startX),
          endX: parseFloat(bar.dataset.endX),
          oldStartDate: bar.dataset.startDate || null,
          oldDueDate: bar.dataset.dueDate || null,
          barOutline: outline,
          barMain: bar.querySelector('.bar-main'),
          leftHandle: singleLeftHandle,
          rightHandle: singleRightHandle,
          // Cache grip circles to avoid querySelectorAll per frame
          leftGripCircles: singleLeftHandle ? Array.from(singleLeftHandle.querySelectorAll('.drag-grip circle')) : [],
          rightGripCircles: singleRightHandle ? Array.from(singleRightHandle.querySelectorAll('.drag-grip circle')) : [],
          bar,
          barLabels: singleBarLabels,
          labelsOnLeft: singleLabelsOnLeft,
          connectedArrows,
          linkHandle: singleLinkHandle,
          linkHandleCircles: singleLinkHandle ? Array.from(singleLinkHandle.querySelectorAll('circle')) : []
        };

        // Show drag date tooltip for single bar move (not bulk)
        if (!isBulkDrag && bar.dataset.startDate && bar.dataset.dueDate) {
          showDragTooltip(formatDateRange(bar.dataset.startDate, bar.dataset.dueDate));
          positionDragTooltip(e.clientX, e.clientY);
        }
      }
    });

    // Linking drag state
    let linkingState = null;
    let tempArrow = null;
    let currentTarget = null;

    function cancelLinking() {
      if (!linkingState) return;
      linkingState.fromBar.classList.remove('linking-source');
      document.querySelectorAll('.link-target').forEach(el => el.classList.remove('link-target'));
      if (tempArrow) { tempArrow.remove(); tempArrow = null; }
      linkingState = null;
      currentTarget = null;
      document.body.classList.remove('cursor-crosshair');
    }

    function showRelationPicker(x, y, fromId, toId, fromAnchor = 'end', toAnchor = 'start') {
      // Remove existing picker
      document.querySelector('.relation-picker')?.remove();

      const picker = document.createElement('div');
      picker.className = 'relation-picker';

      // Clamp position to viewport bounds (picker is ~180px wide, ~200px tall)
      const pickerWidth = 180;
      const pickerHeight = 200;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + 'px';
      picker.style.top = Math.max(10, clampedY) + 'px';

      // Map anchor combination to suggested relation type
      const anchorToRelation = {
        'end_start': 'finish_to_start',
        'end_end': 'finish_to_finish',
        'start_start': 'start_to_start',
        'start_end': 'start_to_finish'
      };
      const suggestedType = anchorToRelation[`${fromAnchor}_${toAnchor}`] || 'finish_to_start';

      const baseTypes = [
        { value: 'blocks', label: '🚫 Blocks', cssClass: 'rel-line-blocks',
          tooltip: 'Target cannot be closed until this issue is closed' },
        { value: 'precedes', label: '➡️ Precedes', cssClass: 'rel-line-scheduling',
          tooltip: 'This issue must complete before target can start' },
        { value: 'relates', label: '🔗 Relates to', cssClass: 'rel-line-informational',
          tooltip: 'Simple link between issues (no constraints)' },
        { value: 'duplicates', label: '📋 Duplicates', cssClass: 'rel-line-informational',
          tooltip: 'Closing target will automatically close this issue' },
        { value: 'copied_to', label: '📄 Copied to', cssClass: 'rel-line-informational',
          tooltip: 'This issue was copied to create the target issue' }
      ];
      const types = baseTypes;

      // Delay input for precedes (hidden by default, shown when precedes is hovered/focused)
      let currentDelay = -1; // Default: same day (most useful)
      const delayRow = document.createElement('div');
      delayRow.className = 'delay-row';

      const delayLabel = document.createElement('label');
      delayLabel.textContent = 'Delay:';
      delayRow.appendChild(delayLabel);

      const sameDayBtn = document.createElement('button');
      sameDayBtn.className = 'delay-preset active';
      sameDayBtn.dataset.delay = '-1';
      sameDayBtn.title = 'Start same day predecessor ends';
      sameDayBtn.textContent = 'Same day';
      delayRow.appendChild(sameDayBtn);

      const nextDayBtn = document.createElement('button');
      nextDayBtn.className = 'delay-preset';
      nextDayBtn.dataset.delay = '0';
      nextDayBtn.title = 'Start day after predecessor ends';
      nextDayBtn.textContent = '+1 day';
      delayRow.appendChild(nextDayBtn);

      const delayInput = document.createElement('input');
      delayInput.type = 'number';
      delayInput.className = 'delay-input';
      delayInput.value = currentDelay;
      delayInput.min = '-30';
      delayInput.max = '30';
      delayInput.title = 'Custom delay in days (-1=same day, 0=next day, 3=+4 days)';
      delayRow.appendChild(delayInput);

      delayRow.style.display = 'none'; // Hidden until precedes selected

      delayRow.querySelectorAll('.delay-preset').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          currentDelay = parseInt(btn.dataset.delay);
          delayInput.value = currentDelay;
          delayRow.querySelectorAll('.delay-preset').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      delayInput.addEventListener('input', () => {
        currentDelay = parseInt(delayInput.value) || 0;
        delayRow.querySelectorAll('.delay-preset').forEach(b => {
          b.classList.toggle('active', parseInt(b.dataset.delay) === currentDelay);
        });
      });
      delayInput.addEventListener('click', (e) => e.stopPropagation());

      types.forEach(t => {
        const btn = document.createElement('button');
        if (t.value === suggestedType) {
          btn.classList.add('suggested');
        }
        const swatch = document.createElement('span');
        swatch.className = 'color-swatch ' + t.cssClass;
        btn.appendChild(swatch);
        btn.appendChild(document.createTextNode(t.label));
        btn.title = t.tooltip + (t.value === suggestedType ? ' (suggested based on anchors)' : '');

        // Show delay row on hover/focus for precedes
        if (t.value === 'precedes') {
          btn.addEventListener('mouseenter', () => { delayRow.style.display = 'flex'; });
          btn.addEventListener('focus', () => { delayRow.style.display = 'flex'; });
        }

        btn.addEventListener('click', () => {
          saveState();
          const message = {
            command: 'createRelation',
            issueId: fromId,
            targetIssueId: toId,
            relationType: t.value
          };
          // Include delay for precedes
          if (t.value === 'precedes') {
            message.delay = currentDelay;
          }
          vscode.postMessage(message);
          picker.remove();
        });
        picker.appendChild(btn);
      });

      picker.appendChild(delayRow);
      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }

    // Handle click on bar - scroll to issue start date and highlight
    // Double-click enters focus mode (highlights dependency chain)
    // Delegated: rows materialize on scroll, so per-element listeners would
    // miss every bar mounted after init.
    const interactiveSelector = '.drag-handle, .link-handle, .bar-outline, ' +
      '.blocks-badge-group, .blocker-badge, .progress-badge-group, .flex-badge-group';
    addDocListener('click', (e) => {
      // Ignore clicks on interactive elements (handles, badges, outline)
      if (e.target.closest(interactiveSelector)) return;
      const bar = e.target.closest('.issue-bar');
      if (!bar) return;
      if (dragState || linkingState || justEndedDrag) return;
      // Clear focus mode on single click
      if (getFocusedIssueId()) {
        clearFocus();
      }
      scrollToAndHighlight(bar.dataset.issueId);
    });
    addDocListener('dblclick', (e) => {
      const bar = e.target.closest('.issue-bar');
      if (!bar) return;
      if (dragState || linkingState || justEndedDrag) return;
      e.preventDefault();
      focusOnDependencyChain(bar.dataset.issueId);
    });

    // Helper to highlight multiple arrows and their connected issues
    function highlightArrows(arrows, issueId) {
      // Clear any previous arrow selection (use tracked elements, avoid DOM queries)
      highlightedArrows.forEach(a => a.classList.remove('selected'));
      highlightedArrows = [];
      highlightedConnected.forEach(el => el.classList.remove('arrow-connected'));
      highlightedConnected = [];

      if (arrows.length === 0) return;

      // Add selection mode and select all matching arrows
      document.body.classList.add('arrow-selection-mode');
      const connectedIds = new Set();
      arrows.forEach(arrow => {
        arrow.classList.add('selected');
        highlightedArrows.push(arrow);
        connectedIds.add(arrow.dataset.from);
        connectedIds.add(arrow.dataset.to);
      });

      // Highlight connected bars and labels (use lookup maps if available)
      const maps = getLookupMaps ? getLookupMaps() : null;
      connectedIds.forEach(id => {
        if (maps?.mapsReady) {
          const bars = maps.issueBarsByIssueId.get(id) || [];
          const labels = maps.issueLabelsByIssueId.get(id) || [];
          bars.forEach(el => { el.classList.add('arrow-connected'); highlightedConnected.push(el); });
          labels.forEach(el => { el.classList.add('arrow-connected'); highlightedConnected.push(el); });
        } else {
          document.querySelectorAll(`.issue-bar[data-issue-id="${id}"], .issue-label[data-issue-id="${id}"]`)
            .forEach(el => { el.classList.add('arrow-connected'); highlightedConnected.push(el); });
        }
      });

      announce(`Highlighted ${arrows.length} dependency arrow(s) for #${issueId}`);
    }

    // Badge clicks highlight this issue's arrows: blocks-badge = arrows FROM
    // (issues it blocks), blocker-badge = arrows TO (no scroll). Delegated —
    // badges mount and unmount with the row window.
    addDocListener('mousedown', (e) => {
      // Prevent focus on mousedown (before click fires)
      if (!e.target.closest('.blocks-badge-group, .blocker-badge')) return;
      e.preventDefault();
      e.stopPropagation();
    });
    addDocListener('click', (e) => {
      const badge = e.target.closest('.blocks-badge-group, .blocker-badge');
      if (!badge) return;
      e.preventDefault();
      e.stopPropagation();
      const issueBar = badge.closest('.issue-bar');
      if (!issueBar) return;
      const issueId = issueBar.dataset.issueId;
      const attr = badge.classList.contains('blocks-badge-group') ? 'data-from' : 'data-to';
      const arrows = Array.from(document.querySelectorAll(`.dependency-arrow[${attr}="${issueId}"]`));
      highlightArrows(arrows, issueId);
    });

    // Keyboard navigation for issue bars (delegated — order comes from the
    // row window's visible list, not a DOM snapshot, so navigation spans the
    // whole board including unmounted rows)
    const PAGE_JUMP = 10;
    function focusBarByIssueId(issueId, prefix) {
      const meta = rowWindow?.getRowMeta('issue-' + issueId);
      if (meta) rowWindow.scrollToKey(meta.key); // mounts the target row
      const target = document.querySelector(`.issue-bar[data-issue-id="${issueId}"]`);
      if (!target) return;
      target.focus();
      announce(`${prefix}${target.getAttribute('aria-label')}`);
    }
    addDocListener('keydown', (e) => {
      const bar = e.target.closest?.('.issue-bar');
      if (!bar) return;
      const issueId = bar.dataset.issueId;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        scrollToAndHighlight(issueId);
        return;
      }
      if (e.key === 'Tab' && e.shiftKey) {
        // Jump back to corresponding label
        const label = document.querySelector(`.issue-label[data-issue-id="${issueId}"]`);
        if (label) {
          e.preventDefault();
          label.focus();
          announce(`Label for issue #${issueId}`);
        }
        return;
      }
      const issueIds = (rowWindow?.getVisibleList() ?? [])
        .filter(r => r.issueId !== null && r.issueId !== undefined)
        .map(r => String(r.issueId));
      const index = issueIds.indexOf(issueId);
      if (index === -1) return;
      let nextIdx = null;
      let prefix = 'Issue ';
      if (e.key === 'ArrowDown' && index < issueIds.length - 1) {
        nextIdx = index + 1;
      } else if (e.key === 'ArrowUp' && index > 0) {
        nextIdx = index - 1;
      } else if (e.key === 'Home') {
        nextIdx = 0;
        prefix = 'First issue: ';
      } else if (e.key === 'End') {
        nextIdx = issueIds.length - 1;
        prefix = 'Last issue: ';
      } else if (e.key === 'PageDown') {
        nextIdx = Math.min(index + PAGE_JUMP, issueIds.length - 1);
      } else if (e.key === 'PageUp') {
        nextIdx = Math.max(index - PAGE_JUMP, 0);
      }
      if (nextIdx === null) return;
      e.preventDefault();
      focusBarByIssueId(issueIds[nextIdx], prefix);
    });

    // Handle link handle mousedown to start linking (delegated — the link
    // handle is the only entry point for drag-created relations, and must
    // work on rows materialized after init)
    addDocListener('mousedown', (e) => {
      const handle = e.target.closest('.link-handle');
      if (!handle) return;
      {
        e.stopPropagation();
        e.preventDefault();
        const bar = handle.closest('.issue-bar');
        const issueId = parseInt(bar.dataset.issueId);
        const cx = parseFloat(handle.dataset.cx);
        const cy = parseFloat(handle.dataset.cy);

        bar.classList.add('linking-source');
        document.body.classList.add('cursor-crosshair');

        // Create temp arrow in SVG with arrowhead marker
        const svg = document.querySelector('#ganttTimeline svg');

        // Add arrowhead marker if not exists
        if (!document.getElementById('temp-arrow-head')) {
          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          defs.innerHTML = `
            <marker id="temp-arrow-head" markerWidth="10" markerHeight="7"
                    refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 10 3.5, 0 7" fill="var(--vscode-focusBorder)"/>
            </marker>`;
          svg.insertBefore(defs, svg.firstChild);
        }

        tempArrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempArrow.classList.add('temp-link-arrow');
        tempArrow.setAttribute('stroke', 'var(--vscode-focusBorder)');
        tempArrow.setAttribute('stroke-width', '2');
        tempArrow.setAttribute('fill', 'none');
        tempArrow.setAttribute('marker-end', 'url(#temp-arrow-head)');
        svg.appendChild(tempArrow);

        const fromAnchor = handle.dataset.anchor || 'end'; // 'start' or 'end'
        linkingState = { fromId: issueId, fromBar: bar, startX: cx, startY: cy, fromAnchor };
      }
    });

    // Escape to cancel linking mode, close pickers, and clear focus
    addDocListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const picker = document.querySelector('.relation-picker');
        if (picker) {
          e.stopImmediatePropagation();
          picker.remove();
          return;
        }
        if (linkingState) {
          e.stopImmediatePropagation();
          cancelLinking();
          return;
        }
        if (getFocusedIssueId()) {
          e.stopImmediatePropagation();
          clearFocus();
          announce('Focus cleared');
        }
      }
    });

    // Handle drag move (resizing, moving, and linking)
    // Use requestAnimationFrame to throttle updates for smooth 60fps
    let dragRafPending = false;
    let lastMouseEvent = null;

    addDocListener('mousemove', (e) => {
      // Early exit if no drag in progress
      if (!dragState && !linkingState) return;

      // Store latest event and schedule RAF if not pending
      lastMouseEvent = e;
      if (dragRafPending) return;
      dragRafPending = true;

      requestAnimationFrame(() => {
        dragRafPending = false;
        const evt = lastMouseEvent;
        if (!evt) return;

        // Handle resize/move drag
        if (dragState) {
          const delta = evt.clientX - dragState.initialMouseX;

        if (dragState.isMove && dragState.isBulkDrag && dragState.bulkBars) {
          // Bulk move: update all selected bars
          const snappedDelta = snapToDay(delta) - snapToDay(0); // Snap the delta itself
          dragState.bulkBars.forEach(b => {
            const barWidth = b.endX - b.startX;
            const newStartX = Math.max(0, Math.min(b.startX + snappedDelta, timelineWidth - barWidth));
            const newEndX = newStartX + barWidth;
            const width = newEndX - newStartX;
            b.barOutline.setAttribute('x', newStartX);
            b.barOutline.setAttribute('width', width);
            if (b.barMain) {
              b.barMain.setAttribute('x', newStartX);
              b.barMain.setAttribute('width', width);
            }
            // Handles - use cached rect refs
            if (b.leftHandleRect) b.leftHandleRect.setAttribute('x', newStartX);
            if (b.rightHandleRect) b.rightHandleRect.setAttribute('x', newEndX - 14);
            // Update grip dot positions - use cached circle refs
            b.leftGripCircles.forEach(c => c.setAttribute('cx', newStartX + 9));
            b.rightGripCircles.forEach(c => c.setAttribute('cx', newEndX - 9));
            b.newStartX = newStartX;
            b.newEndX = newEndX;
            // Update badge position
            if (b.barLabels) {
              const labelDelta = b.labelsOnLeft ? (newStartX - b.startX) : (newEndX - b.endX);
              b.barLabels.setAttribute('transform', 'translate(' + labelDelta + ', 0)');
            }
            // Update connected arrows
            if (b.connectedArrows) {
              updateArrowPositions(b.connectedArrows, b.issueId, newStartX, newEndX);
            }
            // Update link handle position - use cached circle refs
            b.linkHandleCircles.forEach(c => c.setAttribute('cx', String(newEndX + 8)));
          });
          dragState.snappedDelta = snappedDelta;
        } else {
          // Single bar drag
          let newStartX = dragState.startX;
          let newEndX = dragState.endX;
          const barWidth = dragState.endX - dragState.startX;

          if (dragState.isMove) {
            // Move entire bar: shift both start and end by same delta
            newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, timelineWidth - barWidth)));
            newEndX = newStartX + barWidth;
          } else if (dragState.isLeft) {
            newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, dragState.endX - dayWidth)));
          } else {
            newEndX = snapToDay(Math.max(dragState.startX + dayWidth, Math.min(dragState.endX + delta, timelineWidth)));
          }

          const width = newEndX - newStartX;
          dragState.barOutline.setAttribute('x', newStartX);
          dragState.barOutline.setAttribute('width', width);
          if (dragState.barMain) {
            dragState.barMain.setAttribute('x', newStartX);
            dragState.barMain.setAttribute('width', width);
          }
          // Handles are now <g> groups - update via rect inside
          const leftRect = dragState.leftHandle.querySelector('rect');
          const rightRect = dragState.rightHandle.querySelector('rect');
          if (leftRect) leftRect.setAttribute('x', newStartX);
          if (rightRect) rightRect.setAttribute('x', newEndX - 14);
          // Update grip dot positions - use cached circle refs
          dragState.leftGripCircles.forEach(c => c.setAttribute('cx', newStartX + 9));
          dragState.rightGripCircles.forEach(c => c.setAttribute('cx', newEndX - 9));
          dragState.newStartX = newStartX;
          dragState.newEndX = newEndX;

          // Update badge position
          if (dragState.barLabels) {
            const labelDelta = dragState.labelsOnLeft ? (newStartX - dragState.startX) : (newEndX - dragState.endX);
            dragState.barLabels.setAttribute('transform', 'translate(' + labelDelta + ', 0)');
          }

          // Update connected arrows
          if (dragState.connectedArrows) {
            updateArrowPositions(dragState.connectedArrows, dragState.issueId, newStartX, newEndX);
          }

          // Update link handle position - use cached circle refs
          dragState.linkHandleCircles.forEach(c => c.setAttribute('cx', String(newEndX + 8)));

          // Update drag date tooltip
          if (dragState.isMove && !dragState.isBulkDrag) {
            const newStartDate = xToDate(newStartX);
            const newDueDate = xToDueDate(newEndX);
            const changed = newStartDate !== dragState.oldStartDate;
            const text = changed
              ? formatDateRange(dragState.oldStartDate, dragState.oldDueDate) + ' → ' + formatDateRange(newStartDate, newDueDate)
              : formatDateRange(newStartDate, newDueDate);
            updateDragTooltip(text);
            positionDragTooltip(evt.clientX, evt.clientY);
          } else if (!dragState.isMove) {
            const edgeX = dragState.isLeft ? newStartX : newEndX;
            const newDate = dragState.isLeft ? xToDate(edgeX) : xToDueDate(edgeX);
            updateDragTooltip((dragState.isLeft ? 'Start: ' : 'Due: ') + formatDateShort(newDate));
            positionDragTooltip(evt.clientX, evt.clientY);
          }
        }
      }

        // Handle linking drag
        if (linkingState && tempArrow) {
          // Use SVG rect directly - getBoundingClientRect accounts for scroll
          const svg = document.querySelector('#ganttTimeline svg');
          const rect = svg.getBoundingClientRect();
          const endX = evt.clientX - rect.left;
          const endY = evt.clientY - rect.top;

          // Draw dashed line from start to cursor
          const path = `M ${linkingState.startX} ${linkingState.startY} L ${endX} ${endY}`;
          tempArrow.setAttribute('d', path);

          // Find target bar under cursor
          const targetBar = document.elementFromPoint(evt.clientX, evt.clientY)?.closest('.issue-bar');
          if (currentTarget && currentTarget !== targetBar) {
            currentTarget.classList.remove('link-target');
          }
          if (targetBar && targetBar !== linkingState.fromBar) {
            targetBar.classList.add('link-target');
            currentTarget = targetBar;
          } else {
            currentTarget = null;
          }
        }
      }); // end RAF
    }); // end mousemove

    // Restore bar to original position (used by cancel)
    function restoreBarPosition(state) {
      if (!state) return;
      const { bar, barOutline, barMain, leftHandle, rightHandle, barLabels, startX, endX, connectedArrows, issueId, linkHandle } = state;
      const width = endX - startX;
      if (barOutline) {
        barOutline.setAttribute('x', String(startX));
        barOutline.setAttribute('width', String(width));
      }
      if (barMain) {
        barMain.setAttribute('x', String(startX));
        barMain.setAttribute('width', String(width));
      }
      // Handles are now <g> groups - update rect and grip dots inside
      if (leftHandle) {
        const rect = leftHandle.querySelector('rect');
        if (rect) rect.setAttribute('x', String(startX));
        leftHandle.querySelectorAll('.drag-grip circle').forEach(c => c.setAttribute('cx', startX + 9));
      }
      if (rightHandle) {
        const rect = rightHandle.querySelector('rect');
        if (rect) rect.setAttribute('x', String(endX - 14));
        rightHandle.querySelectorAll('.drag-grip circle').forEach(c => c.setAttribute('cx', endX - 9));
      }
      if (barLabels) barLabels.removeAttribute('transform');
      if (connectedArrows && connectedArrows.length > 0) {
        updateArrowPositions(connectedArrows, issueId, startX, endX);
      }
      if (linkHandle) {
        linkHandle.querySelectorAll('circle').forEach(c => c.setAttribute('cx', String(endX + 8)));
      }
      if (bar) bar.classList.remove('dragging');
    }

    // Handle drag end (resizing, moving, and linking)
    addDocListener('mouseup', (e) => {
      // Handle resize/move drag end
      if (dragState) {
        const { issueId, isLeft, isMove, isBulkDrag, bulkBars, newStartX, newEndX, bar, startX, endX, oldStartDate, oldDueDate, barOutline, barMain, leftHandle, rightHandle, barLabels, connectedArrows } = dragState;
        const savedState = { ...dragState }; // Save for restoration

        // Handle bulk drag end
        if (isBulkDrag && bulkBars && isMove) {
          // Remove dragging class from all bars
          bulkBars.forEach(b => b.bar.classList.remove('dragging'));

          // Collect all date changes
          const changes = [];
          bulkBars.forEach(b => {
            if (b.newStartX !== undefined && b.newStartX !== b.startX) {
              const newStart = xToDate(b.newStartX);
              const newDue = xToDueDate(b.newEndX);
              if (newStart !== b.oldStartDate || newDue !== b.oldDueDate) {
                changes.push({
                  issueId: parseInt(b.issueId),
                  oldStartDate: b.oldStartDate,
                  oldDueDate: b.oldDueDate,
                  newStartDate: newStart,
                  newDueDate: newDue,
                  barData: b
                });
              }
            }
          });

          if (changes.length > 0) {
            hideDragTooltip();
            const confirmBulk = () => {
              // Confirm: commit changes
              undoStack.push({ type: 'bulk', changes: changes.map(c => ({ issueId: c.issueId, oldStartDate: c.oldStartDate, oldDueDate: c.oldDueDate, newStartDate: c.newStartDate, newDueDate: c.newDueDate })) });
              redoStack.length = 0;
              updateUndoRedoButtons();
              saveState();
              changes.forEach(c => {
                vscode.postMessage({ command: 'updateDates', issueId: c.issueId, startDate: c.newStartDate, dueDate: c.newDueDate });
              });
            };
            if (isDraftModeEnabled && isDraftModeEnabled()) {
              // Draft mode: skip confirmation, changes are queued for review
              confirmBulk();
            } else {
              const message = 'Move ' + changes.length + ' issue(s) to new dates?';
              showDragConfirmModal(message, confirmBulk, () => {
                // Cancel: restore all bars
                bulkBars.forEach(b => restoreBarPosition(b));
              });
            }
          } else {
            // No changes - restore all bars
            hideDragTooltip();
            bulkBars.forEach(b => restoreBarPosition(b));
          }
          dragState = null;
          ctx.unpinRow?.();
          justEndedDrag = true;
          requestAnimationFrame(() => justEndedDrag = false);
          return;
        }

        // Single bar drag end
        bar.classList.remove('dragging');
        hideDragTooltip();

        if (newStartX !== undefined || newEndX !== undefined) {
          let calcStartDate = null;
          let calcDueDate = null;

          if (isMove) {
            // Move: update both dates if position changed
            if (newStartX !== startX) {
              calcStartDate = xToDate(newStartX);
              calcDueDate = xToDueDate(newEndX);
            }
          } else if (isLeft) {
            calcStartDate = newStartX !== startX ? xToDate(newStartX) : null;
          } else {
            calcDueDate = newEndX !== endX ? xToDueDate(newEndX) : null;
          }

          const newStartDate = calcStartDate && calcStartDate !== oldStartDate ? calcStartDate : null;
          const newDueDate = calcDueDate && calcDueDate !== oldDueDate ? calcDueDate : null;

          if (newStartDate || newDueDate) {
            const confirmSingle = () => {
              // Confirm: commit change
              undoStack.push({
                issueId,
                oldStartDate: newStartDate ? oldStartDate : null,
                oldDueDate: newDueDate ? oldDueDate : null,
                newStartDate,
                newDueDate
              });
              redoStack.length = 0;
              updateUndoRedoButtons();
              saveState();
              vscode.postMessage({ command: 'updateDates', issueId, startDate: newStartDate, dueDate: newDueDate });
            };
            if (isDraftModeEnabled && isDraftModeEnabled()) {
              // Draft mode: skip confirmation, changes are queued for review
              confirmSingle();
            } else {
              // Build confirmation message
              let message = 'Issue #' + issueId + ': ';
              if (newStartDate && newDueDate) {
                message += formatDateRange(oldStartDate, oldDueDate) + ' → ' + formatDateRange(newStartDate, newDueDate);
              } else if (newStartDate) {
                message += 'Start: ' + formatDateShort(oldStartDate) + ' → ' + formatDateShort(newStartDate);
              } else {
                message += 'Due: ' + formatDateShort(oldDueDate) + ' → ' + formatDateShort(newDueDate);
              }
              showDragConfirmModal(message, confirmSingle, () => {
                // Cancel: restore bar
                restoreBarPosition(savedState);
              });
            }
          } else {
            // No date change - restore bar to original position
            restoreBarPosition(savedState);
          }
        } else {
          // No drag movement detected - restore bar
          restoreBarPosition(savedState);
        }
        dragState = null;
        ctx.unpinRow?.();
        justEndedDrag = true;
        requestAnimationFrame(() => justEndedDrag = false);
      }

      // Handle linking drag end
      if (linkingState) {
        const fromId = linkingState.fromId;
        const fromAnchor = linkingState.fromAnchor;
        if (currentTarget) {
          const toId = parseInt(currentTarget.dataset.issueId);
          // Prevent self-referential relations
          if (fromId !== toId) {
            // Determine target anchor based on drop position relative to target bar center
            const svg = document.querySelector('#ganttTimeline svg');
            const rect = svg.getBoundingClientRect();
            const dropX = e.clientX - rect.left;
            const targetOutline = currentTarget.querySelector('.bar-outline');
            const targetStartX = parseFloat(targetOutline.getAttribute('x'));
            const targetEndX = targetStartX + parseFloat(targetOutline.getAttribute('width'));
            const targetCenterX = (targetStartX + targetEndX) / 2;
            const toAnchor = dropX < targetCenterX ? 'start' : 'end';
            showRelationPicker(e.clientX, e.clientY, fromId, toId, fromAnchor, toAnchor);
          }
        }
        cancelLinking();
      }

      // Restore scroll position if no modal shown (no-change cases)
      if (!pendingDragConfirm) {
        restoreScrollPosition();
      }
    });

    // Undo menu item
    menuUndo?.addEventListener('click', () => {
      if (menuUndo.hasAttribute('disabled')) return;
      if (undoStack.length === 0) return;
      const action = undoStack.pop();
      redoStack.push(action);
      updateUndoRedoButtons();
      saveState();

      if (action.type === 'relation') {
        // Undo relation action
        if (action.operation === 'create') {
          // Undo create = delete the relation
          vscode.postMessage({
            command: 'undoRelation',
            operation: 'delete',
            relationId: action.relationId,
            datesBefore: action.datesBefore
          });
        } else {
          // Undo delete = recreate the relation
          vscode.postMessage({
            command: 'undoRelation',
            operation: 'create',
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType,
            delay: action.delay
          });
        }
      } else if (action.type === 'bulk') {
        // Undo bulk date changes - revert all to old dates
        const inDraftMode = isDraftModeEnabled && isDraftModeEnabled();
        action.changes.forEach(c => {
          if (inDraftMode) {
            // In draft mode: remove the draft instead of creating new one
            vscode.postMessage({
              command: 'removeDraft',
              issueId: c.issueId,
              startDate: c.oldStartDate,
              dueDate: c.oldDueDate
            });
          } else {
            vscode.postMessage({
              command: 'updateDates',
              issueId: c.issueId,
              startDate: c.oldStartDate,
              dueDate: c.oldDueDate
            });
          }
        });
      } else {
        // Date change action
        const inDraftMode = isDraftModeEnabled && isDraftModeEnabled();
        if (inDraftMode) {
          // In draft mode: remove the draft instead of creating new one
          vscode.postMessage({
            command: 'removeDraft',
            issueId: action.issueId,
            startDate: action.oldStartDate,
            dueDate: action.oldDueDate
          });
        } else {
          vscode.postMessage({
            command: 'updateDates',
            issueId: action.issueId,
            startDate: action.oldStartDate,
            dueDate: action.oldDueDate
          });
        }
      }
    });

    // Redo menu item
    menuRedo?.addEventListener('click', () => {
      if (menuRedo.hasAttribute('disabled')) return;
      if (redoStack.length === 0) return;
      const action = redoStack.pop();
      undoStack.push(action);
      updateUndoRedoButtons();
      saveState();

      if (action.type === 'relation') {
        // Redo relation action
        if (action.operation === 'create') {
          // Redo create = recreate the relation
          vscode.postMessage({
            command: 'redoRelation',
            operation: 'create',
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType,
            delay: action.delay
          });
        } else {
          // Redo delete = delete the relation again
          vscode.postMessage({
            command: 'redoRelation',
            operation: 'delete',
            relationId: action.relationId
          });
        }
      } else if (action.type === 'bulk') {
        // Redo bulk date changes - apply all new dates
        action.changes.forEach(c => {
          vscode.postMessage({
            command: 'updateDates',
            issueId: c.issueId,
            startDate: c.newStartDate,
            dueDate: c.newDueDate
          });
        });
      } else {
        // Date change action
        vscode.postMessage({
          command: 'updateDates',
          issueId: action.issueId,
          startDate: action.newStartDate,
          dueDate: action.newDueDate
        });
      }
    });

    return { refreshArrowGeometry };
}
