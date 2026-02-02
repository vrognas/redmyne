"use strict";
(() => {
  // src/webviews/gantt/gantt-minimap.js
  function setupMinimap({
    timelineWidth,
    minimapBarsData,
    minimapHeight,
    minimapBarHeight,
    minimapTodayX,
    ganttScroll,
    minimapSvg,
    minimapViewport,
    addDocListener
  }) {
    function updateMinimapPosition() {
      const stickyLeft = document.querySelector(".gantt-body .gantt-sticky-left");
      const ganttContainer = document.querySelector(".gantt-container");
      if (stickyLeft && ganttContainer) {
        ganttContainer.style.setProperty("--sticky-left-width", stickyLeft.offsetWidth + "px");
      }
    }
    requestAnimationFrame(updateMinimapPosition);
    if (minimapSvg) {
      requestAnimationFrame(() => {
        const barSpacing = minimapHeight / (minimapBarsData.length + 1);
        minimapBarsData.forEach((bar, i) => {
          const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("class", bar.classes);
          rect.setAttribute("x", (bar.startPct * timelineWidth).toString());
          rect.setAttribute("y", (barSpacing * (i + 0.5)).toString());
          rect.setAttribute("width", Math.max(2, (bar.endPct - bar.startPct) * timelineWidth).toString());
          rect.setAttribute("height", minimapBarHeight.toString());
          rect.setAttribute("rx", "1");
          rect.setAttribute("fill", bar.color);
          minimapSvg.insertBefore(rect, minimapViewport);
        });
        if (minimapTodayX > 0 && minimapTodayX < timelineWidth) {
          const todayLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
          todayLine.setAttribute("class", "minimap-today");
          todayLine.setAttribute("x1", minimapTodayX.toString());
          todayLine.setAttribute("y1", "0");
          todayLine.setAttribute("x2", minimapTodayX.toString());
          todayLine.setAttribute("y2", minimapHeight.toString());
          minimapSvg.insertBefore(todayLine, minimapViewport);
        }
      });
    }
    function updateMinimapViewport() {
      if (!ganttScroll || !minimapViewport) return;
      if (!timelineWidth || !ganttScroll.scrollWidth || !ganttScroll.clientWidth) return;
      const scrollableRange = Math.max(1, ganttScroll.scrollWidth - ganttScroll.clientWidth);
      const scrollRatio = Math.min(1, ganttScroll.scrollLeft / scrollableRange);
      const viewportRatio = Math.min(1, ganttScroll.clientWidth / ganttScroll.scrollWidth);
      const viewportWidth = Math.max(20, viewportRatio * timelineWidth);
      const viewportX = scrollRatio * (timelineWidth - viewportWidth);
      if (isNaN(viewportX) || isNaN(viewportWidth)) return;
      minimapViewport.setAttribute("x", viewportX.toString());
      minimapViewport.setAttribute("width", viewportWidth.toString());
    }
    let minimapDragging = false;
    let minimapDragOffset = 0;
    function scrollFromMinimap(e, useOffset = false) {
      if (!ganttScroll || !minimapSvg || !minimapViewport) return;
      const rect = minimapSvg.getBoundingClientRect();
      const viewportWidth = parseFloat(minimapViewport.getAttribute("width") || "0");
      const viewportWidthPx = viewportWidth / timelineWidth * rect.width;
      let targetX = e.clientX - rect.left;
      if (useOffset) {
        targetX -= minimapDragOffset;
      } else {
        targetX -= viewportWidthPx / 2;
      }
      const clickRatio = Math.max(0, Math.min(1, targetX / (rect.width - viewportWidthPx)));
      const scrollableRange = Math.max(0, ganttScroll.scrollWidth - ganttScroll.clientWidth);
      ganttScroll.scrollLeft = clickRatio * scrollableRange;
    }
    if (minimapSvg && minimapViewport) {
      minimapViewport.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        minimapDragging = true;
        const rect = minimapSvg.getBoundingClientRect();
        const viewportX = parseFloat(minimapViewport.getAttribute("x") || "0");
        const viewportXPx = viewportX / timelineWidth * rect.width;
        minimapDragOffset = e.clientX - rect.left - viewportXPx;
      });
      minimapSvg.addEventListener("mousedown", (e) => {
        if (e.target === minimapViewport) return;
        minimapDragging = true;
        const rect = minimapSvg.getBoundingClientRect();
        const viewportWidth = parseFloat(minimapViewport.getAttribute("width") || "0");
        minimapDragOffset = viewportWidth / 100 * rect.width / 2;
        scrollFromMinimap(e, true);
      });
      addDocListener("mousemove", (e) => {
        if (minimapDragging) scrollFromMinimap(e, true);
      });
      addDocListener("mouseup", () => {
        minimapDragging = false;
      });
    }
    return { updateMinimapPosition, updateMinimapViewport };
  }

  // src/webviews/gantt/gantt-drag.js
  function setupDrag(ctx) {
    const {
      vscode: vscode2,
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
      allIssueBars,
      redmineBaseUrl,
      extendedRelationTypes,
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
      setAllowScrollChange,
      isDraftModeEnabled,
      isPerfDebugEnabled,
      getLookupMaps
    } = ctx;
    let highlightedArrows = [];
    let highlightedConnected = [];
    function showIssueContextMenu(x, y, issueId) {
      document.querySelector(".relation-picker")?.remove();
      const isBulkMode = selectedIssues.size > 1 && selectedIssues.has(issueId);
      const targetIds = isBulkMode ? Array.from(selectedIssues).map((id) => parseInt(id)) : [parseInt(issueId)];
      const picker = document.createElement("div");
      picker.className = "relation-picker";
      const pickerWidth = 160;
      const pickerHeight = 180;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + "px";
      picker.style.top = Math.max(10, clampedY) + "px";
      const label = document.createElement("div");
      label.style.padding = "6px 12px";
      label.style.fontSize = "11px";
      label.style.opacity = "0.7";
      label.textContent = isBulkMode ? targetIds.length + " issues selected" : "#" + issueId;
      picker.appendChild(label);
      const options = isBulkMode ? [
        { label: "Set % Done...", command: "bulkSetDoneRatio", bulk: true },
        { label: "Clear Selection", command: "clearSelection", local: true }
      ] : [
        { label: "Update Issue...", command: "openIssue" },
        { label: "Open in Browser", command: "openInBrowser" },
        { label: "Show in Issues", command: "showInIssues" },
        { label: "Log Time", command: "logTime" },
        { label: "Set % Done", command: "setDoneRatio" },
        { label: "Toggle Auto-update %", command: "toggleAutoUpdate" },
        { label: "Toggle Ad-hoc Budget", command: "toggleAdHoc" },
        { label: "Toggle Precedence", command: "togglePrecedence" },
        { label: "Set Internal Estimate", command: "setInternalEstimate" },
        { label: "Copy Link", command: "copyLink", local: true },
        { label: "Copy URL", command: "copyUrl" }
      ];
      options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.textContent = opt.label;
        btn.addEventListener("click", async () => {
          if (opt.command === "copyLink") {
            const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
            const subject = bar?.dataset?.subject || "Issue #" + issueId;
            const url = redmineBaseUrl + "/issues/" + issueId;
            const html = '<a href="' + url + '">#' + issueId + " " + subject + "</a>";
            const plain = url;
            try {
              await navigator.clipboard.write([
                new ClipboardItem({
                  "text/plain": new Blob([plain], { type: "text/plain" }),
                  "text/html": new Blob([html], { type: "text/html" })
                })
              ]);
              vscode2.postMessage({ command: "showStatus", message: "Copied #" + issueId + " link" });
            } catch (e) {
              await navigator.clipboard.writeText(plain);
              vscode2.postMessage({ command: "showStatus", message: "Copied #" + issueId + " URL" });
            }
          } else if (opt.local) {
            clearSelection();
          } else if (opt.bulk) {
            vscode2.postMessage({ command: opt.command, issueIds: targetIds });
          } else {
            vscode2.postMessage({ command: opt.command, issueId: parseInt(issueId) });
          }
          picker.remove();
        });
        picker.appendChild(btn);
      });
      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }
    function xToDate(x) {
      const ms = minDateMs + x / timelineWidth * (maxDateMs - minDateMs);
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }
    function xToDueDate(x) {
      const ms = minDateMs + x / timelineWidth * (maxDateMs - minDateMs) - 864e5;
      const d = new Date(ms);
      return d.toISOString().slice(0, 10);
    }
    const dragTooltip = document.getElementById("dragDateTooltip");
    let lastTooltipDate = null;
    function formatDateShort(dateStr) {
      const d = /* @__PURE__ */ new Date(dateStr + "T00:00:00");
      const month = d.toLocaleDateString("en-US", { month: "short" });
      const day = d.getDate();
      const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
      return month + " " + day + " (" + weekday + ")";
    }
    function formatDateRange(startStr, endStr) {
      const sd = /* @__PURE__ */ new Date(startStr + "T00:00:00"), ed = /* @__PURE__ */ new Date(endStr + "T00:00:00");
      const sm = sd.toLocaleDateString("en-US", { month: "short" });
      const em = ed.toLocaleDateString("en-US", { month: "short" });
      return sm === em ? sm + " " + sd.getDate() + "-" + ed.getDate() : sm + " " + sd.getDate() + "-" + em + " " + ed.getDate();
    }
    function showDragTooltip(text) {
      dragTooltip.textContent = text;
      dragTooltip.style.display = "block";
      lastTooltipDate = text;
    }
    function updateDragTooltip(text) {
      if (text === lastTooltipDate) return;
      dragTooltip.textContent = text;
      lastTooltipDate = text;
    }
    function positionDragTooltip(clientX, clientY) {
      let top = clientY - 28;
      let flipped = false;
      if (top < 40) {
        top = clientY + 20;
        flipped = true;
      }
      dragTooltip.style.left = clientX + "px";
      dragTooltip.style.top = top + "px";
      dragTooltip.classList.toggle("flipped", flipped);
    }
    function hideDragTooltip() {
      dragTooltip.style.display = "none";
      lastTooltipDate = null;
    }
    const arrowSize = 4;
    const r = 4;
    function logArrowDebug(label, data) {
      if (isPerfDebugEnabled && isPerfDebugEnabled()) {
        console.log("[Arrow Debug]", label, data);
      }
    }
    function calcArrowPath(x1, y1, x2, y2, isScheduling, fromStart = false, toEnd = false) {
      const goingRight = x2 > x1;
      const horizontalDist = Math.abs(x2 - x1);
      const nearlyVertical = horizontalDist < 30;
      const sameRow = Math.abs(y1 - y2) < 5;
      const goingDown = y2 > y1;
      const jogDir = fromStart ? -1 : 1;
      const approachDir = toEnd ? 1 : -1;
      const minJogRoom = 8 + r;
      let pathCase;
      if (!isScheduling) pathCase = "non-scheduling";
      else if (sameRow && goingRight) pathCase = "sameRow-right";
      else if (!sameRow && nearlyVertical && (fromStart === goingRight || horizontalDist < minJogRoom)) pathCase = "nearlyVertical";
      else if (goingRight) pathCase = "diffRow-right";
      else if (sameRow) pathCase = "sameRow-left";
      else pathCase = "diffRow-left";
      let path;
      let arrowHead;
      if (!isScheduling) {
        const centersAligned = Math.abs(x1 - x2) < 5;
        if (sameRow) {
          const routeY = y1 - 8;
          path = "M " + x1 + " " + y1 + " V " + (routeY + r) + " q 0 " + -r + " " + (goingRight ? r : -r) + " " + -r + " H " + (x2 + (goingRight ? -r : r)) + " q " + (goingRight ? r : -r) + " 0 " + (goingRight ? r : -r) + " " + r + " V " + y2;
          arrowHead = "M " + (x2 - arrowSize * 0.6) + " " + (y2 - arrowSize) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize * 0.6) + " " + (y2 - arrowSize);
        } else if (centersAligned) {
          path = "M " + x1 + " " + y1 + " V " + y2;
          arrowHead = goingDown ? "M " + (x2 - arrowSize * 0.6) + " " + (y2 - arrowSize) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize * 0.6) + " " + (y2 - arrowSize) : "M " + (x2 - arrowSize * 0.6) + " " + (y2 + arrowSize) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize * 0.6) + " " + (y2 + arrowSize);
        } else {
          const midY = (y1 + y2) / 2;
          path = "M " + x1 + " " + y1 + " V " + (midY + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + (goingRight ? r : -r) + " " + (goingDown ? r : -r) + " H " + (x2 + (goingRight ? -r : r)) + " q " + (goingRight ? r : -r) + " 0 " + (goingRight ? r : -r) + " " + (goingDown ? r : -r) + " V " + y2;
          arrowHead = goingDown ? "M " + (x2 - arrowSize * 0.6) + " " + (y2 - arrowSize) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize * 0.6) + " " + (y2 - arrowSize) : "M " + (x2 - arrowSize * 0.6) + " " + (y2 + arrowSize) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize * 0.6) + " " + (y2 + arrowSize);
        }
      } else if (sameRow && goingRight) {
        path = "M " + x1 + " " + y1 + " H " + x2;
      } else if (sameRow && !goingRight) {
        const routeY = y1 - barHeight;
        path = "M " + x1 + " " + y1 + " V " + (routeY + r) + " q 0 " + -r + " " + jogDir * -r + " " + -r + " H " + (x2 + approachDir * 12 - approachDir * r) + " q " + approachDir * -r + " 0 " + approachDir * -r + " " + r + " V " + y2 + " H " + x2;
      } else if (!sameRow && nearlyVertical && (fromStart === goingRight || horizontalDist < minJogRoom)) {
        const jogX = 8;
        const midY = (y1 + y2) / 2;
        path = "M " + x1 + " " + y1 + " H " + (x1 + jogDir * jogX - jogDir * r) + " q " + jogDir * r + " 0 " + jogDir * r + " " + (goingDown ? r : -r) + " V " + (midY + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + -jogDir * r + " " + (goingDown ? r : -r) + " H " + (x2 + approachDir * jogX - approachDir * r) + " q " + approachDir * r + " 0 " + approachDir * r + " " + (goingDown ? r : -r) + " V " + (y2 + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + -approachDir * r + " " + (goingDown ? r : -r) + " H " + x2;
      } else if (goingRight && !fromStart) {
        const jogX = 8;
        path = "M " + x1 + " " + y1 + " H " + (x1 + jogDir * jogX - jogDir * r) + " q " + jogDir * r + " 0 " + jogDir * r + " " + (goingDown ? r : -r) + " V " + (y2 + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + r + " " + (goingDown ? r : -r) + " H " + x2;
      } else if (goingRight) {
        const jogX = 8;
        path = "M " + x1 + " " + y1 + " H " + (x2 + approachDir * jogX - approachDir * r) + " q " + approachDir * r + " 0 " + approachDir * r + " " + (goingDown ? r : -r) + " V " + (y2 + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + -approachDir * r + " " + (goingDown ? r : -r) + " H " + x2;
      } else if (fromStart) {
        const jogX = 8;
        path = "M " + x1 + " " + y1 + " H " + (x2 + approachDir * jogX + r) + " q " + -r + " 0 " + -r + " " + (goingDown ? r : -r) + " V " + (y2 + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + r + " " + (goingDown ? r : -r) + " H " + x2;
      } else {
        const jogX = 8;
        const midY = (y1 + y2) / 2;
        path = "M " + x1 + " " + y1 + " H " + (x1 + jogDir * jogX - jogDir * r) + " q " + jogDir * r + " 0 " + jogDir * r + " " + (goingDown ? r : -r) + " V " + (midY + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + -r + " " + (goingDown ? r : -r) + " H " + (x2 + approachDir * jogX + r) + " q " + -r + " 0 " + -r + " " + (goingDown ? r : -r) + " V " + (y2 + (goingDown ? -r : r)) + " q 0 " + (goingDown ? r : -r) + " " + r + " " + (goingDown ? r : -r) + " H " + x2;
      }
      if (isScheduling) {
        arrowHead = toEnd ? "M " + (x2 + arrowSize) + " " + (y2 - arrowSize * 0.6) + " L " + x2 + " " + y2 + " L " + (x2 + arrowSize) + " " + (y2 + arrowSize * 0.6) : "M " + (x2 - arrowSize) + " " + (y2 - arrowSize * 0.6) + " L " + x2 + " " + y2 + " L " + (x2 - arrowSize) + " " + (y2 + arrowSize * 0.6);
      }
      logArrowDebug("calcArrowPath", {
        inputs: { x1, y1, x2, y2, isScheduling },
        conditions: { goingRight, horizontalDist, nearlyVertical, sameRow, goingDown },
        pathCase,
        path: path.substring(0, 80) + (path.length > 80 ? "..." : "")
      });
      return { path, arrowHead };
    }
    function getConnectedArrows(issueId) {
      const arrows = [];
      const selector = '.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]';
      document.querySelectorAll(selector).forEach((arrow) => {
        const fromId = arrow.getAttribute("data-from");
        const toId = arrow.getAttribute("data-to");
        const classList = arrow.getAttribute("class") || "";
        const relMatch = classList.match(/rel-(\w+)/);
        const relType = relMatch ? relMatch[1] : "relates";
        const isScheduling = ["blocks", "precedes", "finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"].includes(relType);
        const fromBar = document.querySelector('.issue-bar[data-issue-id="' + fromId + '"]');
        const toBar = document.querySelector('.issue-bar[data-issue-id="' + toId + '"]');
        if (!fromBar || !toBar) return;
        arrows.push({
          element: arrow,
          fromId,
          toId,
          isScheduling,
          relType,
          fromBar,
          toBar,
          linePath: arrow.querySelector(".arrow-line"),
          hitPath: arrow.querySelector(".arrow-hit-area"),
          headPath: arrow.querySelector(".arrow-head")
        });
      });
      return arrows;
    }
    function updateArrowPositions(arrows, draggedIssueId, newStartX, newEndX) {
      arrows.forEach((a) => {
        const originalPath = a.linePath ? a.linePath.getAttribute("d") : null;
        const fromStartX = a.fromId == draggedIssueId ? newStartX : parseFloat(a.fromBar.dataset.startX);
        const fromEndX = a.fromId == draggedIssueId ? newEndX : parseFloat(a.fromBar.dataset.endX);
        const fromY = parseFloat(a.fromBar.dataset.centerY);
        const toStartX = a.toId == draggedIssueId ? newStartX : parseFloat(a.toBar.dataset.startX);
        const toEndX = a.toId == draggedIssueId ? newEndX : parseFloat(a.toBar.dataset.endX);
        const toY = parseFloat(a.toBar.dataset.centerY);
        const fromStart = a.relType === "start_to_start" || a.relType === "start_to_finish";
        const toEnd = a.relType === "finish_to_finish" || a.relType === "start_to_finish";
        let x1, y1, x2, y2;
        if (a.isScheduling) {
          x1 = fromStart ? fromStartX - 2 : fromEndX + 2;
          y1 = fromY;
          x2 = toEnd ? toEndX + 2 : toStartX - 2;
          y2 = toY;
        } else {
          x1 = (fromStartX + fromEndX) / 2;
          x2 = (toStartX + toEndX) / 2;
          const goingDown = toY > fromY;
          const sameRowCenter = Math.abs(fromY - toY) < 5;
          if (sameRowCenter) {
            y1 = fromY - barHeight / 2;
            y2 = toY - barHeight / 2;
          } else {
            y1 = goingDown ? fromY + barHeight / 2 : fromY - barHeight / 2;
            y2 = goingDown ? toY - barHeight / 2 : toY + barHeight / 2;
          }
        }
        logArrowDebug("updateArrowPositions", {
          arrow: a.fromId + " -> " + a.toId,
          isScheduling: a.isScheduling,
          draggedId: draggedIssueId,
          barData: {
            fromStartX: a.fromBar.dataset.startX,
            fromEndX: a.fromBar.dataset.endX,
            fromY: a.fromBar.dataset.centerY,
            toStartX: a.toBar.dataset.startX,
            toEndX: a.toBar.dataset.endX,
            toY: a.toBar.dataset.centerY
          },
          computed: { fromStartX, fromEndX, fromY, toStartX, toEndX, toY },
          coords: { x1, y1, x2, y2 },
          originalPath: originalPath ? originalPath.substring(0, 60) + "..." : null
        });
        const { path, arrowHead } = calcArrowPath(x1, y1, x2, y2, a.isScheduling, fromStart, toEnd);
        if (a.linePath) a.linePath.setAttribute("d", path);
        if (a.hitPath) a.hitPath.setAttribute("d", path);
        if (a.headPath) a.headPath.setAttribute("d", arrowHead);
      });
    }
    const dragConfirmOverlay = document.getElementById("dragConfirmOverlay");
    const dragConfirmMessage = document.getElementById("dragConfirmMessage");
    const dragConfirmOk = document.getElementById("dragConfirmOk");
    const dragConfirmCancel = document.getElementById("dragConfirmCancel");
    let pendingDragConfirm = null;
    function showDragConfirmModal(message, onConfirm, onCancel) {
      if (!dragConfirmOverlay || !dragConfirmMessage) return;
      dragConfirmMessage.textContent = message;
      pendingDragConfirm = { onConfirm, onCancel };
      setAllowScrollChange(true);
      dragConfirmOverlay.style.display = "flex";
      if (dragConfirmOk) dragConfirmOk.focus();
    }
    function hideDragConfirmModal() {
      if (dragConfirmOverlay) dragConfirmOverlay.style.display = "none";
      pendingDragConfirm = null;
    }
    function restoreScrollPosition() {
      if (ganttScroll && dragScrollSnapshot) {
        ganttScroll.scrollLeft = dragScrollSnapshot.left;
        ganttScroll.scrollTop = dragScrollSnapshot.top;
      }
      dragScrollSnapshot = null;
    }
    dragConfirmOk?.addEventListener("click", () => {
      if (pendingDragConfirm?.onConfirm) pendingDragConfirm.onConfirm();
      dragScrollSnapshot = null;
      hideDragConfirmModal();
    });
    dragConfirmCancel?.addEventListener("click", () => {
      if (pendingDragConfirm?.onCancel) pendingDragConfirm.onCancel();
      restoreScrollPosition();
      hideDragConfirmModal();
    });
    dragConfirmOverlay?.addEventListener("click", (e) => {
      if (e.target === dragConfirmOverlay) {
        if (pendingDragConfirm?.onCancel) pendingDragConfirm.onCancel();
        restoreScrollPosition();
        hideDragConfirmModal();
      }
    });
    addDocListener("keydown", (e) => {
      if (!pendingDragConfirm) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (pendingDragConfirm.onCancel) pendingDragConfirm.onCancel();
        restoreScrollPosition();
        hideDragConfirmModal();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (pendingDragConfirm.onConfirm) pendingDragConfirm.onConfirm();
        dragScrollSnapshot = null;
        hideDragConfirmModal();
      }
    });
    let dragState = null;
    let dragScrollSnapshot = null;
    let justEndedDrag = false;
    document.querySelectorAll(".drag-handle").forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
        const bar = handle.closest(".issue-bar");
        const isLeft = handle.classList.contains("drag-left");
        const issueId = parseInt(bar.dataset.issueId);
        const startX = parseFloat(bar.dataset.startX);
        const endX = parseFloat(bar.dataset.endX);
        const oldStartDate = bar.dataset.startDate || null;
        const oldDueDate = bar.dataset.dueDate || null;
        const barOutline = bar.querySelector(".bar-outline");
        const barMain = bar.querySelector(".bar-main");
        const leftHandle = bar.querySelector(".drag-left");
        const rightHandle = bar.querySelector(".drag-right");
        bar.classList.add("dragging");
        const barLabels = bar.querySelector(".bar-labels");
        const labelsOnLeft = barLabels?.classList.contains("labels-left");
        const connectedArrows = getConnectedArrows(issueId);
        const linkHandle = bar.querySelector(".link-handle");
        logArrowDebug("dragStart (resize)", {
          issueId,
          isLeft,
          connectedArrowCount: connectedArrows.length,
          arrows: connectedArrows.map((a) => ({
            from: a.fromId,
            to: a.toId,
            isScheduling: a.isScheduling,
            currentPath: a.linePath ? a.linePath.getAttribute("d")?.substring(0, 60) + "..." : null
          }))
        });
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
          leftGripCircles: leftHandle ? Array.from(leftHandle.querySelectorAll(".drag-grip circle")) : [],
          rightGripCircles: rightHandle ? Array.from(rightHandle.querySelectorAll(".drag-grip circle")) : [],
          bar,
          barLabels,
          labelsOnLeft,
          connectedArrows,
          linkHandle,
          linkHandleCircles: linkHandle ? Array.from(linkHandle.querySelectorAll("circle")) : []
        };
        const edgeX = isLeft ? startX : endX;
        const currentDate = isLeft ? oldStartDate : oldDueDate;
        if (currentDate) {
          showDragTooltip((isLeft ? "Start: " : "Due: ") + formatDateShort(currentDate));
          positionDragTooltip(e.clientX, e.clientY);
        }
      });
    });
    document.querySelectorAll(".bar-outline").forEach((outline) => {
      outline.addEventListener("mousedown", (e) => {
        if (e.target.classList.contains("drag-handle")) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
        const bar = outline.closest(".issue-bar");
        if (!bar) return;
        const issueId = bar.dataset.issueId;
        const isBulkDrag = selectedIssues.size > 1 && selectedIssues.has(issueId);
        const barsToMove = isBulkDrag ? allIssueBars.filter((b) => selectedIssues.has(b.dataset.issueId)) : [bar];
        const bulkBars = barsToMove.map((b) => {
          const leftHandle = b.querySelector(".drag-left");
          const rightHandle = b.querySelector(".drag-right");
          return {
            issueId: b.dataset.issueId,
            startX: parseFloat(b.dataset.startX),
            endX: parseFloat(b.dataset.endX),
            oldStartDate: b.dataset.startDate || null,
            oldDueDate: b.dataset.dueDate || null,
            barOutline: b.querySelector(".bar-outline"),
            barMain: b.querySelector(".bar-main"),
            leftHandle,
            rightHandle,
            // Cache grip circles to avoid querySelectorAll per frame
            leftGripCircles: leftHandle ? Array.from(leftHandle.querySelectorAll(".drag-grip circle")) : [],
            rightGripCircles: rightHandle ? Array.from(rightHandle.querySelectorAll(".drag-grip circle")) : [],
            leftHandleRect: leftHandle?.querySelector("rect"),
            rightHandleRect: rightHandle?.querySelector("rect"),
            bar: b,
            barLabels: b.querySelector(".bar-labels"),
            labelsOnLeft: b.querySelector(".bar-labels")?.classList.contains("labels-left"),
            connectedArrows: getConnectedArrows(b.dataset.issueId),
            linkHandle: b.querySelector(".link-handle"),
            linkHandleCircles: b.querySelector(".link-handle") ? Array.from(b.querySelector(".link-handle").querySelectorAll("circle")) : []
          };
        });
        bulkBars.forEach((b) => b.bar.classList.add("dragging"));
        const singleBarLabels = bar.querySelector(".bar-labels");
        const singleLabelsOnLeft = singleBarLabels?.classList.contains("labels-left");
        const connectedArrows = getConnectedArrows(issueId);
        const singleLinkHandle = bar.querySelector(".link-handle");
        const singleLeftHandle = bar.querySelector(".drag-left");
        const singleRightHandle = bar.querySelector(".drag-right");
        logArrowDebug("dragStart (move)", {
          issueId,
          isBulkDrag,
          connectedArrowCount: connectedArrows.length,
          arrows: connectedArrows.map((a) => ({
            from: a.fromId,
            to: a.toId,
            isScheduling: a.isScheduling,
            currentPath: a.linePath ? a.linePath.getAttribute("d")?.substring(0, 60) + "..." : null
          }))
        });
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
          barMain: bar.querySelector(".bar-main"),
          leftHandle: singleLeftHandle,
          rightHandle: singleRightHandle,
          // Cache grip circles to avoid querySelectorAll per frame
          leftGripCircles: singleLeftHandle ? Array.from(singleLeftHandle.querySelectorAll(".drag-grip circle")) : [],
          rightGripCircles: singleRightHandle ? Array.from(singleRightHandle.querySelectorAll(".drag-grip circle")) : [],
          bar,
          barLabels: singleBarLabels,
          labelsOnLeft: singleLabelsOnLeft,
          connectedArrows,
          linkHandle: singleLinkHandle,
          linkHandleCircles: singleLinkHandle ? Array.from(singleLinkHandle.querySelectorAll("circle")) : []
        };
        if (!isBulkDrag && bar.dataset.startDate && bar.dataset.dueDate) {
          showDragTooltip(formatDateRange(bar.dataset.startDate, bar.dataset.dueDate));
          positionDragTooltip(e.clientX, e.clientY);
        }
      });
    });
    let linkingState = null;
    let tempArrow = null;
    let currentTarget = null;
    function cancelLinking() {
      if (!linkingState) return;
      linkingState.fromBar.classList.remove("linking-source");
      document.querySelectorAll(".link-target").forEach((el) => el.classList.remove("link-target"));
      if (tempArrow) {
        tempArrow.remove();
        tempArrow = null;
      }
      linkingState = null;
      currentTarget = null;
      document.body.classList.remove("cursor-crosshair");
    }
    function showRelationPicker(x, y, fromId, toId, fromAnchor = "end", toAnchor = "start") {
      document.querySelector(".relation-picker")?.remove();
      const picker = document.createElement("div");
      picker.className = "relation-picker";
      const pickerWidth = 180;
      const pickerHeight = 200;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + "px";
      picker.style.top = Math.max(10, clampedY) + "px";
      const anchorToRelation = {
        "end_start": "finish_to_start",
        "end_end": "finish_to_finish",
        "start_start": "start_to_start",
        "start_end": "start_to_finish"
      };
      const suggestedType = anchorToRelation[`${fromAnchor}_${toAnchor}`] || "finish_to_start";
      const baseTypes = [
        {
          value: "blocks",
          label: "\u{1F6AB} Blocks",
          cssClass: "rel-line-blocks",
          tooltip: "Target cannot be closed until this issue is closed"
        },
        {
          value: "precedes",
          label: "\u27A1\uFE0F Precedes",
          cssClass: "rel-line-scheduling",
          tooltip: "This issue must complete before target can start"
        },
        {
          value: "relates",
          label: "\u{1F517} Relates to",
          cssClass: "rel-line-informational",
          tooltip: "Simple link between issues (no constraints)"
        },
        {
          value: "duplicates",
          label: "\u{1F4CB} Duplicates",
          cssClass: "rel-line-informational",
          tooltip: "Closing target will automatically close this issue"
        },
        {
          value: "copied_to",
          label: "\u{1F4C4} Copied to",
          cssClass: "rel-line-informational",
          tooltip: "This issue was copied to create the target issue"
        }
      ];
      const extendedTypes = [
        {
          value: "finish_to_start",
          label: "\u23E9 Finish\u2192Start",
          cssClass: "rel-line-scheduling",
          tooltip: "Target starts after this issue finishes (FS)"
        },
        {
          value: "start_to_start",
          label: "\u25B6\uFE0F Start\u2192Start",
          cssClass: "rel-line-scheduling",
          tooltip: "Target starts when this issue starts (SS)"
        },
        {
          value: "finish_to_finish",
          label: "\u23F9\uFE0F Finish\u2192Finish",
          cssClass: "rel-line-scheduling",
          tooltip: "Target finishes when this issue finishes (FF)"
        },
        {
          value: "start_to_finish",
          label: "\u23EA Start\u2192Finish",
          cssClass: "rel-line-scheduling",
          tooltip: "Target finishes when this issue starts (SF)"
        }
      ];
      const types = extendedRelationTypes ? [...baseTypes, ...extendedTypes] : baseTypes;
      let currentDelay = -1;
      const delayRow = document.createElement("div");
      delayRow.className = "delay-row";
      const delayLabel = document.createElement("label");
      delayLabel.textContent = "Delay:";
      delayRow.appendChild(delayLabel);
      const sameDayBtn = document.createElement("button");
      sameDayBtn.className = "delay-preset active";
      sameDayBtn.dataset.delay = "-1";
      sameDayBtn.title = "Start same day predecessor ends";
      sameDayBtn.textContent = "Same day";
      delayRow.appendChild(sameDayBtn);
      const nextDayBtn = document.createElement("button");
      nextDayBtn.className = "delay-preset";
      nextDayBtn.dataset.delay = "0";
      nextDayBtn.title = "Start day after predecessor ends";
      nextDayBtn.textContent = "+1 day";
      delayRow.appendChild(nextDayBtn);
      const delayInput = document.createElement("input");
      delayInput.type = "number";
      delayInput.className = "delay-input";
      delayInput.value = currentDelay;
      delayInput.min = "-30";
      delayInput.max = "30";
      delayInput.title = "Custom delay in days (-1=same day, 0=next day, 3=+4 days)";
      delayRow.appendChild(delayInput);
      delayRow.style.display = "none";
      delayRow.querySelectorAll(".delay-preset").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          currentDelay = parseInt(btn.dataset.delay);
          delayInput.value = currentDelay;
          delayRow.querySelectorAll(".delay-preset").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });
      delayInput.addEventListener("input", () => {
        currentDelay = parseInt(delayInput.value) || 0;
        delayRow.querySelectorAll(".delay-preset").forEach((b) => {
          b.classList.toggle("active", parseInt(b.dataset.delay) === currentDelay);
        });
      });
      delayInput.addEventListener("click", (e) => e.stopPropagation());
      types.forEach((t) => {
        const btn = document.createElement("button");
        if (t.value === suggestedType) {
          btn.classList.add("suggested");
        }
        const swatch = document.createElement("span");
        swatch.className = "color-swatch " + t.cssClass;
        btn.appendChild(swatch);
        btn.appendChild(document.createTextNode(t.label));
        btn.title = t.tooltip + (t.value === suggestedType ? " (suggested based on anchors)" : "");
        if (t.value === "precedes") {
          btn.addEventListener("mouseenter", () => {
            delayRow.style.display = "flex";
          });
          btn.addEventListener("focus", () => {
            delayRow.style.display = "flex";
          });
        }
        btn.addEventListener("click", () => {
          saveState();
          const message = {
            command: "createRelation",
            issueId: fromId,
            targetIssueId: toId,
            relationType: t.value
          };
          if (t.value === "precedes") {
            message.delay = currentDelay;
          }
          vscode2.postMessage(message);
          picker.remove();
        });
        picker.appendChild(btn);
      });
      picker.appendChild(delayRow);
      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }
    const interactiveSelector = ".drag-handle, .link-handle, .bar-outline, .blocks-badge-group, .blocker-badge, .progress-badge-group, .flex-badge-group";
    document.querySelectorAll(".issue-bar").forEach((bar) => {
      bar.addEventListener("click", (e) => {
        if (e.target.closest(interactiveSelector)) return;
        if (dragState || linkingState || justEndedDrag) return;
        if (getFocusedIssueId()) {
          clearFocus();
        }
        scrollToAndHighlight(bar.dataset.issueId);
      });
      bar.addEventListener("dblclick", (e) => {
        if (dragState || linkingState || justEndedDrag) return;
        e.preventDefault();
        focusOnDependencyChain(bar.dataset.issueId);
      });
    });
    function highlightArrows(arrows, issueId) {
      highlightedArrows.forEach((a) => a.classList.remove("selected"));
      highlightedArrows = [];
      highlightedConnected.forEach((el) => el.classList.remove("arrow-connected"));
      highlightedConnected = [];
      if (arrows.length === 0) return;
      document.body.classList.add("arrow-selection-mode");
      const connectedIds = /* @__PURE__ */ new Set();
      arrows.forEach((arrow) => {
        arrow.classList.add("selected");
        highlightedArrows.push(arrow);
        connectedIds.add(arrow.dataset.from);
        connectedIds.add(arrow.dataset.to);
      });
      const maps = getLookupMaps ? getLookupMaps() : null;
      connectedIds.forEach((id) => {
        if (maps?.mapsReady) {
          const bars = maps.issueBarsByIssueId.get(id) || [];
          const labels = maps.issueLabelsByIssueId.get(id) || [];
          bars.forEach((el) => {
            el.classList.add("arrow-connected");
            highlightedConnected.push(el);
          });
          labels.forEach((el) => {
            el.classList.add("arrow-connected");
            highlightedConnected.push(el);
          });
        } else {
          document.querySelectorAll(`.issue-bar[data-issue-id="${id}"], .issue-label[data-issue-id="${id}"]`).forEach((el) => {
            el.classList.add("arrow-connected");
            highlightedConnected.push(el);
          });
        }
      });
      announce(`Highlighted ${arrows.length} dependency arrow(s) for #${issueId}`);
    }
    document.querySelectorAll(".blocks-badge-group").forEach((badge) => {
      badge.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const issueBar = badge.closest(".issue-bar");
        if (!issueBar) return;
        const issueId = issueBar.dataset.issueId;
        const arrows = Array.from(document.querySelectorAll(`.dependency-arrow[data-from="${issueId}"]`));
        highlightArrows(arrows, issueId);
      });
    });
    document.querySelectorAll(".blocker-badge").forEach((badge) => {
      badge.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const issueBar = badge.closest(".issue-bar");
        if (!issueBar) return;
        const issueId = issueBar.dataset.issueId;
        const arrows = Array.from(document.querySelectorAll(`.dependency-arrow[data-to="${issueId}"]`));
        highlightArrows(arrows, issueId);
      });
    });
    const issueBars = Array.from(document.querySelectorAll(".issue-bar"));
    const PAGE_JUMP = 10;
    issueBars.forEach((bar, index) => {
      bar.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scrollToAndHighlight(bar.dataset.issueId);
        } else if (e.key === "ArrowDown" && index < issueBars.length - 1) {
          e.preventDefault();
          issueBars[index + 1].focus();
          announce(`Issue ${issueBars[index + 1].getAttribute("aria-label")}`);
        } else if (e.key === "ArrowUp" && index > 0) {
          e.preventDefault();
          issueBars[index - 1].focus();
          announce(`Issue ${issueBars[index - 1].getAttribute("aria-label")}`);
        } else if (e.key === "Home") {
          e.preventDefault();
          issueBars[0].focus();
          announce(`First issue: ${issueBars[0].getAttribute("aria-label")}`);
        } else if (e.key === "End") {
          e.preventDefault();
          issueBars[issueBars.length - 1].focus();
          announce(`Last issue: ${issueBars[issueBars.length - 1].getAttribute("aria-label")}`);
        } else if (e.key === "PageDown") {
          e.preventDefault();
          const nextIdx = Math.min(index + PAGE_JUMP, issueBars.length - 1);
          issueBars[nextIdx].focus();
          announce(`Issue ${issueBars[nextIdx].getAttribute("aria-label")}`);
        } else if (e.key === "PageUp") {
          e.preventDefault();
          const prevIdx = Math.max(index - PAGE_JUMP, 0);
          issueBars[prevIdx].focus();
          announce(`Issue ${issueBars[prevIdx].getAttribute("aria-label")}`);
        } else if (e.key === "Tab" && e.shiftKey) {
          const issueId = bar.dataset.issueId;
          const label = document.querySelector(`.issue-label[data-issue-id="${issueId}"]`);
          if (label) {
            e.preventDefault();
            label.focus();
            announce(`Label for issue #${issueId}`);
          }
        }
      });
    });
    document.querySelectorAll(".link-handle").forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const bar = handle.closest(".issue-bar");
        const issueId = parseInt(bar.dataset.issueId);
        const cx = parseFloat(handle.dataset.cx);
        const cy = parseFloat(handle.dataset.cy);
        bar.classList.add("linking-source");
        document.body.classList.add("cursor-crosshair");
        const svg = document.querySelector("#ganttTimeline svg");
        if (!document.getElementById("temp-arrow-head")) {
          const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
          defs.innerHTML = `
            <marker id="temp-arrow-head" markerWidth="10" markerHeight="7"
                    refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 10 3.5, 0 7" fill="var(--vscode-focusBorder)"/>
            </marker>`;
          svg.insertBefore(defs, svg.firstChild);
        }
        tempArrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
        tempArrow.classList.add("temp-link-arrow");
        tempArrow.setAttribute("stroke", "var(--vscode-focusBorder)");
        tempArrow.setAttribute("stroke-width", "2");
        tempArrow.setAttribute("fill", "none");
        tempArrow.setAttribute("marker-end", "url(#temp-arrow-head)");
        svg.appendChild(tempArrow);
        const fromAnchor = handle.dataset.anchor || "end";
        linkingState = { fromId: issueId, fromBar: bar, startX: cx, startY: cy, fromAnchor };
      });
    });
    addDocListener("keydown", (e) => {
      if (e.key === "Escape") {
        const picker = document.querySelector(".relation-picker");
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
          announce("Focus cleared");
        }
      }
    });
    let dragRafPending = false;
    let lastMouseEvent = null;
    addDocListener("mousemove", (e) => {
      if (!dragState && !linkingState) return;
      lastMouseEvent = e;
      if (dragRafPending) return;
      dragRafPending = true;
      requestAnimationFrame(() => {
        dragRafPending = false;
        const evt = lastMouseEvent;
        if (!evt) return;
        if (dragState) {
          const delta = evt.clientX - dragState.initialMouseX;
          if (dragState.isMove && dragState.isBulkDrag && dragState.bulkBars) {
            const snappedDelta = snapToDay(delta) - snapToDay(0);
            dragState.bulkBars.forEach((b) => {
              const barWidth = b.endX - b.startX;
              const newStartX = Math.max(0, Math.min(b.startX + snappedDelta, timelineWidth - barWidth));
              const newEndX = newStartX + barWidth;
              const width = newEndX - newStartX;
              b.barOutline.setAttribute("x", newStartX);
              b.barOutline.setAttribute("width", width);
              if (b.barMain) {
                b.barMain.setAttribute("x", newStartX);
                b.barMain.setAttribute("width", width);
              }
              if (b.leftHandleRect) b.leftHandleRect.setAttribute("x", newStartX);
              if (b.rightHandleRect) b.rightHandleRect.setAttribute("x", newEndX - 14);
              b.leftGripCircles.forEach((c) => c.setAttribute("cx", newStartX + 9));
              b.rightGripCircles.forEach((c) => c.setAttribute("cx", newEndX - 9));
              b.newStartX = newStartX;
              b.newEndX = newEndX;
              if (b.barLabels) {
                const labelDelta = b.labelsOnLeft ? newStartX - b.startX : newEndX - b.endX;
                b.barLabels.setAttribute("transform", "translate(" + labelDelta + ", 0)");
              }
              if (b.connectedArrows) {
                updateArrowPositions(b.connectedArrows, b.issueId, newStartX, newEndX);
              }
              b.linkHandleCircles.forEach((c) => c.setAttribute("cx", String(newEndX + 8)));
            });
            dragState.snappedDelta = snappedDelta;
          } else {
            let newStartX = dragState.startX;
            let newEndX = dragState.endX;
            const barWidth = dragState.endX - dragState.startX;
            if (dragState.isMove) {
              newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, timelineWidth - barWidth)));
              newEndX = newStartX + barWidth;
            } else if (dragState.isLeft) {
              newStartX = snapToDay(Math.max(0, Math.min(dragState.startX + delta, dragState.endX - dayWidth)));
            } else {
              newEndX = snapToDay(Math.max(dragState.startX + dayWidth, Math.min(dragState.endX + delta, timelineWidth)));
            }
            const width = newEndX - newStartX;
            dragState.barOutline.setAttribute("x", newStartX);
            dragState.barOutline.setAttribute("width", width);
            if (dragState.barMain) {
              dragState.barMain.setAttribute("x", newStartX);
              dragState.barMain.setAttribute("width", width);
            }
            const leftRect = dragState.leftHandle.querySelector("rect");
            const rightRect = dragState.rightHandle.querySelector("rect");
            if (leftRect) leftRect.setAttribute("x", newStartX);
            if (rightRect) rightRect.setAttribute("x", newEndX - 14);
            dragState.leftGripCircles.forEach((c) => c.setAttribute("cx", newStartX + 9));
            dragState.rightGripCircles.forEach((c) => c.setAttribute("cx", newEndX - 9));
            dragState.newStartX = newStartX;
            dragState.newEndX = newEndX;
            if (dragState.barLabels) {
              const labelDelta = dragState.labelsOnLeft ? newStartX - dragState.startX : newEndX - dragState.endX;
              dragState.barLabels.setAttribute("transform", "translate(" + labelDelta + ", 0)");
            }
            if (dragState.connectedArrows) {
              updateArrowPositions(dragState.connectedArrows, dragState.issueId, newStartX, newEndX);
            }
            dragState.linkHandleCircles.forEach((c) => c.setAttribute("cx", String(newEndX + 8)));
            if (dragState.isMove && !dragState.isBulkDrag) {
              const newStartDate = xToDate(newStartX);
              const newDueDate = xToDueDate(newEndX);
              const changed = newStartDate !== dragState.oldStartDate;
              const text = changed ? formatDateRange(dragState.oldStartDate, dragState.oldDueDate) + " \u2192 " + formatDateRange(newStartDate, newDueDate) : formatDateRange(newStartDate, newDueDate);
              updateDragTooltip(text);
              positionDragTooltip(evt.clientX, evt.clientY);
            } else if (!dragState.isMove) {
              const edgeX = dragState.isLeft ? newStartX : newEndX;
              const newDate = dragState.isLeft ? xToDate(edgeX) : xToDueDate(edgeX);
              updateDragTooltip((dragState.isLeft ? "Start: " : "Due: ") + formatDateShort(newDate));
              positionDragTooltip(evt.clientX, evt.clientY);
            }
          }
        }
        if (linkingState && tempArrow) {
          const svg = document.querySelector("#ganttTimeline svg");
          const rect = svg.getBoundingClientRect();
          const endX = evt.clientX - rect.left;
          const endY = evt.clientY - rect.top;
          const path = `M ${linkingState.startX} ${linkingState.startY} L ${endX} ${endY}`;
          tempArrow.setAttribute("d", path);
          const targetBar = document.elementFromPoint(evt.clientX, evt.clientY)?.closest(".issue-bar");
          if (currentTarget && currentTarget !== targetBar) {
            currentTarget.classList.remove("link-target");
          }
          if (targetBar && targetBar !== linkingState.fromBar) {
            targetBar.classList.add("link-target");
            currentTarget = targetBar;
          } else {
            currentTarget = null;
          }
        }
      });
    });
    function restoreBarPosition(state) {
      if (!state) return;
      const { bar, barOutline, barMain, leftHandle, rightHandle, barLabels, startX, endX, connectedArrows, issueId, linkHandle } = state;
      const width = endX - startX;
      if (barOutline) {
        barOutline.setAttribute("x", String(startX));
        barOutline.setAttribute("width", String(width));
      }
      if (barMain) {
        barMain.setAttribute("x", String(startX));
        barMain.setAttribute("width", String(width));
      }
      if (leftHandle) {
        const rect = leftHandle.querySelector("rect");
        if (rect) rect.setAttribute("x", String(startX));
        leftHandle.querySelectorAll(".drag-grip circle").forEach((c) => c.setAttribute("cx", startX + 9));
      }
      if (rightHandle) {
        const rect = rightHandle.querySelector("rect");
        if (rect) rect.setAttribute("x", String(endX - 14));
        rightHandle.querySelectorAll(".drag-grip circle").forEach((c) => c.setAttribute("cx", endX - 9));
      }
      if (barLabels) barLabels.removeAttribute("transform");
      if (connectedArrows && connectedArrows.length > 0) {
        updateArrowPositions(connectedArrows, issueId, startX, endX);
      }
      if (linkHandle) {
        linkHandle.querySelectorAll("circle").forEach((c) => c.setAttribute("cx", String(endX + 8)));
      }
      if (bar) bar.classList.remove("dragging");
    }
    addDocListener("mouseup", (e) => {
      if (dragState) {
        const { issueId, isLeft, isMove, isBulkDrag, bulkBars, newStartX, newEndX, bar, startX, endX, oldStartDate, oldDueDate, barOutline, barMain, leftHandle, rightHandle, barLabels, connectedArrows } = dragState;
        const savedState = { ...dragState };
        if (isBulkDrag && bulkBars && isMove) {
          bulkBars.forEach((b) => b.bar.classList.remove("dragging"));
          const changes = [];
          bulkBars.forEach((b) => {
            if (b.newStartX !== void 0 && b.newStartX !== b.startX) {
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
              undoStack.push({ type: "bulk", changes: changes.map((c) => ({ issueId: c.issueId, oldStartDate: c.oldStartDate, oldDueDate: c.oldDueDate, newStartDate: c.newStartDate, newDueDate: c.newDueDate })) });
              redoStack.length = 0;
              updateUndoRedoButtons();
              saveState();
              changes.forEach((c) => {
                vscode2.postMessage({ command: "updateDates", issueId: c.issueId, startDate: c.newStartDate, dueDate: c.newDueDate });
              });
            };
            if (isDraftModeEnabled && isDraftModeEnabled()) {
              confirmBulk();
            } else {
              const message = "Move " + changes.length + " issue(s) to new dates?";
              showDragConfirmModal(message, confirmBulk, () => {
                bulkBars.forEach((b) => restoreBarPosition(b));
              });
            }
          } else {
            hideDragTooltip();
            bulkBars.forEach((b) => restoreBarPosition(b));
          }
          dragState = null;
          justEndedDrag = true;
          requestAnimationFrame(() => justEndedDrag = false);
          return;
        }
        bar.classList.remove("dragging");
        hideDragTooltip();
        if (newStartX !== void 0 || newEndX !== void 0) {
          let calcStartDate = null;
          let calcDueDate = null;
          if (isMove) {
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
              vscode2.postMessage({ command: "updateDates", issueId, startDate: newStartDate, dueDate: newDueDate });
            };
            if (isDraftModeEnabled && isDraftModeEnabled()) {
              confirmSingle();
            } else {
              let message = "Issue #" + issueId + ": ";
              if (newStartDate && newDueDate) {
                message += formatDateRange(oldStartDate, oldDueDate) + " \u2192 " + formatDateRange(newStartDate, newDueDate);
              } else if (newStartDate) {
                message += "Start: " + formatDateShort(oldStartDate) + " \u2192 " + formatDateShort(newStartDate);
              } else {
                message += "Due: " + formatDateShort(oldDueDate) + " \u2192 " + formatDateShort(newDueDate);
              }
              showDragConfirmModal(message, confirmSingle, () => {
                restoreBarPosition(savedState);
              });
            }
          } else {
            restoreBarPosition(savedState);
          }
        } else {
          restoreBarPosition(savedState);
        }
        dragState = null;
        justEndedDrag = true;
        requestAnimationFrame(() => justEndedDrag = false);
      }
      if (linkingState) {
        const fromId = linkingState.fromId;
        const fromAnchor = linkingState.fromAnchor;
        if (currentTarget) {
          const toId = parseInt(currentTarget.dataset.issueId);
          if (fromId !== toId) {
            const svg = document.querySelector("#ganttTimeline svg");
            const rect = svg.getBoundingClientRect();
            const dropX = e.clientX - rect.left;
            const targetOutline = currentTarget.querySelector(".bar-outline");
            const targetStartX = parseFloat(targetOutline.getAttribute("x"));
            const targetEndX = targetStartX + parseFloat(targetOutline.getAttribute("width"));
            const targetCenterX = (targetStartX + targetEndX) / 2;
            const toAnchor = dropX < targetCenterX ? "start" : "end";
            showRelationPicker(e.clientX, e.clientY, fromId, toId, fromAnchor, toAnchor);
          }
        }
        cancelLinking();
      }
      if (!pendingDragConfirm) {
        restoreScrollPosition();
      }
    });
    menuUndo?.addEventListener("click", () => {
      if (menuUndo.hasAttribute("disabled")) return;
      if (undoStack.length === 0) return;
      const action = undoStack.pop();
      redoStack.push(action);
      updateUndoRedoButtons();
      saveState();
      if (action.type === "relation") {
        if (action.operation === "create") {
          vscode2.postMessage({
            command: "undoRelation",
            operation: "delete",
            relationId: action.relationId,
            datesBefore: action.datesBefore
          });
        } else {
          vscode2.postMessage({
            command: "undoRelation",
            operation: "create",
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType
          });
        }
      } else if (action.type === "bulk") {
        const inDraftMode = isDraftModeEnabled && isDraftModeEnabled();
        action.changes.forEach((c) => {
          if (inDraftMode) {
            vscode2.postMessage({
              command: "removeDraft",
              issueId: c.issueId,
              startDate: c.oldStartDate,
              dueDate: c.oldDueDate
            });
          } else {
            vscode2.postMessage({
              command: "updateDates",
              issueId: c.issueId,
              startDate: c.oldStartDate,
              dueDate: c.oldDueDate
            });
          }
        });
      } else {
        const inDraftMode = isDraftModeEnabled && isDraftModeEnabled();
        if (inDraftMode) {
          vscode2.postMessage({
            command: "removeDraft",
            issueId: action.issueId,
            startDate: action.oldStartDate,
            dueDate: action.oldDueDate
          });
        } else {
          vscode2.postMessage({
            command: "updateDates",
            issueId: action.issueId,
            startDate: action.oldStartDate,
            dueDate: action.oldDueDate
          });
        }
      }
    });
    menuRedo?.addEventListener("click", () => {
      if (menuRedo.hasAttribute("disabled")) return;
      if (redoStack.length === 0) return;
      const action = redoStack.pop();
      undoStack.push(action);
      updateUndoRedoButtons();
      saveState();
      if (action.type === "relation") {
        if (action.operation === "create") {
          vscode2.postMessage({
            command: "redoRelation",
            operation: "create",
            issueId: action.issueId,
            targetIssueId: action.targetIssueId,
            relationType: action.relationType
          });
        } else {
          vscode2.postMessage({
            command: "redoRelation",
            operation: "delete",
            relationId: action.relationId
          });
        }
      } else if (action.type === "bulk") {
        action.changes.forEach((c) => {
          vscode2.postMessage({
            command: "updateDates",
            issueId: c.issueId,
            startDate: c.newStartDate,
            dueDate: c.newDueDate
          });
        });
      } else {
        vscode2.postMessage({
          command: "updateDates",
          issueId: action.issueId,
          startDate: action.newStartDate,
          dueDate: action.newDueDate
        });
      }
    });
  }

  // src/webviews/gantt/collapse-utils.js
  function findDescendants(parentKey, childrenCache) {
    const result = [];
    const queue = [parentKey];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = childrenCache.get(current);
      if (children) {
        for (const child of children) {
          result.push(child);
          queue.push(child);
        }
      }
    }
    return result;
  }
  function findVisibleDescendants(parentKey, childrenCache, expandedStateCache) {
    const result = [];
    const queue = [parentKey];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = childrenCache.get(current);
      if (children) {
        for (const child of children) {
          result.push(child);
          const isExpanded = expandedStateCache.get(child);
          if (isExpanded) {
            queue.push(child);
          }
        }
      }
    }
    return result;
  }

  // src/webviews/gantt/gantt-collapse.js
  function setupCollapse(ctx) {
    const { vscode: vscode2, addDocListener, addWinListener, announce, barHeight, selectedCollapseKey } = ctx;
    document.querySelectorAll(".collapse-toggle").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const label = el.closest("[data-collapse-key]");
        const collapseKey = label?.dataset.collapseKey;
        if (collapseKey) {
          toggleCollapseClientSide(collapseKey);
        }
      });
    });
    document.getElementById("menuExpand")?.addEventListener("click", () => {
      const ganttScroll = document.getElementById("ganttScroll");
      const allKeys = ganttScroll?.dataset.allExpandableKeys;
      const keys = allKeys ? JSON.parse(allKeys) : [];
      vscode2.postMessage({ command: "expandAll", keys });
    });
    document.getElementById("menuCollapse")?.addEventListener("click", () => {
      vscode2.postMessage({ command: "collapseAll" });
    });
    const allLabels = Array.from(document.querySelectorAll(".project-label, .issue-label, .time-group-label"));
    let activeLabel = null;
    const savedSelectedKey = selectedCollapseKey ?? null;
    function isLabelVisible(label) {
      return !label.classList.contains("gantt-row-hidden") && label.getAttribute("visibility") !== "hidden";
    }
    function findVisibleLabel(fromIndex, direction) {
      let i = fromIndex + direction;
      while (i >= 0 && i < allLabels.length) {
        if (isLabelVisible(allLabels[i])) return { label: allLabels[i], index: i };
        i += direction;
      }
      return null;
    }
    function scrollLabelIntoView(label) {
      const scrollContainer = document.getElementById("ganttScroll");
      const headerRow = document.querySelector(".gantt-header-row");
      if (!scrollContainer || !label) return;
      const headerHeight = headerRow?.getBoundingClientRect().height || 60;
      const labelRow = label.closest(".gantt-row");
      if (!labelRow) return;
      const rowTop = labelRow.getBoundingClientRect().top;
      const rowHeight = labelRow.getBoundingClientRect().height;
      const containerRect = scrollContainer.getBoundingClientRect();
      const visibleTop = containerRect.top + headerHeight;
      const visibleBottom = containerRect.bottom;
      if (rowTop < visibleTop) {
        scrollContainer.scrollBy({ top: rowTop - visibleTop - 4, behavior: "smooth" });
      } else if (rowTop + rowHeight > visibleBottom) {
        scrollContainer.scrollBy({ top: rowTop + rowHeight - visibleBottom + 4, behavior: "smooth" });
      }
    }
    function setActiveLabel(label, skipNotify = false, scrollIntoView = false, skipFocus = false) {
      if (activeLabel) activeLabel.classList.remove("active");
      activeLabel = label;
      if (label) {
        label.classList.add("active");
        if (!skipFocus) label.focus();
        if (scrollIntoView) scrollLabelIntoView(label);
        if (!skipNotify) {
          vscode2.postMessage({ command: "setSelectedKey", collapseKey: label.dataset.collapseKey });
        }
      }
    }
    addWinListener("focus", () => {
      if (activeLabel && isLabelVisible(activeLabel)) {
        activeLabel.focus();
      }
    });
    addDocListener("keydown", (e) => {
      if (e.key === "Escape" && activeLabel) {
        activeLabel.classList.remove("active");
        activeLabel.blur();
        activeLabel = null;
        vscode2.postMessage({ command: "setSelectedKey", collapseKey: null });
      }
    });
    const rowIndex = /* @__PURE__ */ new Map();
    const ancestorCache = /* @__PURE__ */ new Map();
    const childrenCache = /* @__PURE__ */ new Map();
    const expandedStateCache = /* @__PURE__ */ new Map();
    const stripeContributionsCache = /* @__PURE__ */ new Map();
    function getStripeContributions(stripe) {
      const originalY = stripe.dataset.originalY;
      if (stripeContributionsCache.has(originalY)) {
        return stripeContributionsCache.get(originalY);
      }
      const contributions = JSON.parse(stripe.dataset.rowContributions || "{}");
      stripeContributionsCache.set(originalY, contributions);
      return contributions;
    }
    function buildRowIndex() {
      rowIndex.clear();
      const elements = document.querySelectorAll("[data-collapse-key][data-original-y]");
      elements.forEach((el) => {
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
      const elements = document.querySelectorAll("[data-collapse-key][data-parent-key]");
      elements.forEach((el) => {
        const key = el.dataset.collapseKey;
        const immediateParent = el.dataset.parentKey;
        if (immediateParent) {
          if (!childrenCache.has(immediateParent)) {
            childrenCache.set(immediateParent, /* @__PURE__ */ new Set());
          }
          childrenCache.get(immediateParent).add(key);
        }
        if (ancestorCache.has(key)) return;
        const ancestors = [];
        let parentKey = el.dataset.parentKey;
        while (parentKey) {
          ancestors.push(parentKey);
          const parentEl = document.querySelector('[data-collapse-key="' + parentKey + '"]');
          parentKey = parentEl?.dataset.parentKey || null;
        }
        ancestorCache.set(key, ancestors);
      });
      document.querySelectorAll("[data-collapse-key][data-expanded]").forEach((el) => {
        expandedStateCache.set(el.dataset.collapseKey, el.dataset.expanded === "true");
      });
    }
    buildRowIndex();
    buildAncestorCache();
    function setSvgVisibility(el, hidden) {
      if (hidden) {
        el.setAttribute("visibility", "hidden");
        el.classList.add("gantt-row-hidden");
      } else {
        el.removeAttribute("visibility");
        el.classList.remove("gantt-row-hidden");
      }
    }
    function findDescendants2(parentKey) {
      return findDescendants(parentKey, childrenCache);
    }
    function findVisibleDescendants2(parentKey) {
      return findVisibleDescendants(parentKey, childrenCache, expandedStateCache);
    }
    function toggleCollapseClientSide(collapseKey, action) {
      const parentLabel = document.querySelector('[data-collapse-key="' + collapseKey + '"].project-label, [data-collapse-key="' + collapseKey + '"].time-group-label, [data-collapse-key="' + collapseKey + '"].issue-label');
      if (!parentLabel || parentLabel.dataset.hasChildren !== "true") {
        return;
      }
      const wasExpanded = parentLabel.dataset.expanded === "true";
      const shouldExpand = action === "expand" ? true : action === "collapse" ? false : !wasExpanded;
      if (shouldExpand === wasExpanded) {
        return;
      }
      parentLabel.dataset.expanded = shouldExpand ? "true" : "false";
      expandedStateCache.set(collapseKey, shouldExpand);
      const chevron = parentLabel.querySelector(".collapse-toggle");
      if (chevron) chevron.classList.toggle("expanded", shouldExpand);
      const allDescendants = findDescendants2(collapseKey);
      const visibleDescendants = shouldExpand ? findVisibleDescendants2(collapseKey) : [];
      if (allDescendants.length === 0) {
        vscode2.postMessage({ command: "collapseStateSync", collapseKey, isExpanded: shouldExpand });
        return;
      }
      const descendantSet = new Set(allDescendants);
      const visibleSet = new Set(visibleDescendants);
      const parentEntry = rowIndex.get(collapseKey);
      const parentRowY = parentEntry?.originalY ?? 0;
      const countedKeys = /* @__PURE__ */ new Set();
      let actualDelta = 0;
      let parentStripeY = 0;
      const currentlyVisibleDescendants = shouldExpand ? visibleDescendants : findVisibleDescendants2(collapseKey);
      const deltaDescendants = currentlyVisibleDescendants;
      const deltaSet = new Set(deltaDescendants);
      const allStripes = document.querySelectorAll(".zebra-stripe");
      allStripes.forEach((stripe) => {
        const contributions = getStripeContributions(stripe);
        if (collapseKey in contributions && parentStripeY === 0) {
          parentStripeY = parseFloat(stripe.dataset.originalY || "0");
        }
        for (const [key, contribution] of Object.entries(contributions)) {
          if (deltaSet.has(key) && !countedKeys.has(key)) {
            actualDelta += parseFloat(contribution);
            countedKeys.add(key);
          }
        }
      });
      if (actualDelta === 0 && deltaDescendants.length > 0) {
        vscode2.postMessage({ command: "collapseStateSync", collapseKey, isExpanded: shouldExpand });
        vscode2.postMessage({ command: "requestRerender" });
        return;
      }
      const delta = shouldExpand ? actualDelta : -actualDelta;
      let parentCurrentY = parentRowY;
      if (parentEntry && parentEntry.elements.length > 0) {
        const parentTransform = parentEntry.elements[0].getAttribute("transform") || "";
        const parentYMatch = parentTransform.match(/translate\([^,]+,\s*([-\d.]+)/);
        if (parentYMatch) {
          parentCurrentY = parseFloat(parentYMatch[1]);
        }
      }
      let nextY = parentCurrentY + barHeight;
      if (shouldExpand) {
        visibleDescendants.forEach((key) => {
          const entry = rowIndex.get(key);
          if (entry) {
            entry.elements.forEach((el) => {
              const transform = el.getAttribute("transform") || "";
              const xMatch = transform.match(/translate\(([-\d.]+)/);
              const x = xMatch ? xMatch[1] : "0";
              el.setAttribute("transform", "translate(" + x + ", " + nextY + ")");
              setSvgVisibility(el, false);
            });
            nextY += barHeight;
          }
        });
      } else {
        allDescendants.forEach((key) => {
          const entry = rowIndex.get(key);
          if (entry) {
            entry.elements.forEach((el) => {
              setSvgVisibility(el, true);
            });
          }
        });
      }
      rowIndex.forEach(({ originalY, elements }, key) => {
        if (originalY > parentRowY && !descendantSet.has(key)) {
          elements.forEach((el) => {
            const transform = el.getAttribute("transform") || "";
            const xMatch = transform.match(/translate\(([-\d.]+)/);
            const x = xMatch ? xMatch[1] : "0";
            const yMatch = transform.match(/translate\([^,]+,\s*([-\d.]+)/);
            const currentY = yMatch ? parseFloat(yMatch[1]) : originalY;
            const newY = currentY + delta;
            el.setAttribute("transform", "translate(" + x + ", " + newY + ")");
          });
        }
      });
      const labelColumn = document.querySelector(".gantt-labels svg");
      if (labelColumn) {
        const currentHeight = parseFloat(labelColumn.getAttribute("height") || "0");
        const newHeight = currentHeight + delta;
        labelColumn.setAttribute("height", String(newHeight));
      }
      const columnSelectors = [
        ".gantt-col-status svg",
        ".gantt-col-id svg",
        ".gantt-col-start svg",
        ".gantt-col-due svg",
        ".gantt-col-assignee svg"
      ];
      columnSelectors.forEach((selector) => {
        const colSvg = document.querySelector(selector);
        if (!colSvg) return;
        const currentHeight = parseFloat(colSvg.getAttribute("height") || "0");
        const newHeight = currentHeight + delta;
        colSvg.setAttribute("height", String(newHeight));
      });
      const timelineSvg = document.querySelector(".gantt-timeline svg");
      if (timelineSvg) {
        const currentHeight = parseFloat(timelineSvg.getAttribute("height") || "0");
        const newHeight = currentHeight + delta;
        timelineSvg.setAttribute("height", newHeight);
      }
      const collapsedKeys = /* @__PURE__ */ new Set();
      expandedStateCache.forEach((isExpanded, key) => {
        if (!isExpanded) {
          collapsedKeys.add(key);
        }
      });
      const stripeActions = /* @__PURE__ */ new Map();
      allStripes.forEach((stripe) => {
        const originalY = parseFloat(stripe.dataset.originalY || "0");
        if (stripeActions.has(originalY)) return;
        const contributions = getStripeContributions(stripe);
        const contributingKeys = Object.keys(contributions);
        const coversOnlyDescendants = contributingKeys.length > 0 && contributingKeys.every((key) => descendantSet.has(key));
        const coversAnyDescendant = contributingKeys.some((key) => descendantSet.has(key));
        const isBelowParent = originalY > parentStripeY;
        if (coversOnlyDescendants) {
          stripeActions.set(originalY, { action: "toggle-visibility", hide: !shouldExpand });
        } else if (coversAnyDescendant) {
          if (!shouldExpand) {
            let newHeight = 0;
            for (const [key, contribution] of Object.entries(contributions)) {
              if (!descendantSet.has(key)) {
                newHeight += parseFloat(contribution);
              }
            }
            stripeActions.set(originalY, { action: "shrink", newHeight });
          } else {
            let newHeight = 0;
            for (const [key, contribution] of Object.entries(contributions)) {
              if (!descendantSet.has(key) || visibleSet.has(key)) {
                newHeight += parseFloat(contribution);
              }
            }
            stripeActions.set(originalY, { action: "expand", newHeight });
          }
        } else if (isBelowParent) {
          const currentY = parseFloat(stripe.getAttribute("y") || String(originalY));
          stripeActions.set(originalY, { action: "shift", newY: currentY + delta });
        }
      });
      allStripes.forEach((stripe) => {
        const originalY = parseFloat(stripe.dataset.originalY || "0");
        const action2 = stripeActions.get(originalY);
        if (!action2) return;
        switch (action2.action) {
          case "toggle-visibility":
            setSvgVisibility(stripe, action2.hide);
            break;
          case "shrink":
            stripe.setAttribute("height", String(action2.newHeight));
            break;
          case "expand":
            stripe.setAttribute("height", String(action2.newHeight));
            break;
          case "shift":
            stripe.setAttribute("y", String(action2.newY));
            break;
        }
      });
      const visibleStripes = Array.from(allStripes).filter((s) => s.getAttribute("visibility") !== "hidden");
      const stripesByY = /* @__PURE__ */ new Map();
      visibleStripes.forEach((stripe) => {
        const y = parseFloat(stripe.getAttribute("y") || "0");
        if (!stripesByY.has(y)) stripesByY.set(y, []);
        stripesByY.get(y).push(stripe);
      });
      const sortedYs = Array.from(stripesByY.keys()).sort((a, b) => a - b);
      sortedYs.forEach((y, idx) => {
        const opacity = idx % 2 === 0 ? "0.03" : "0.06";
        stripesByY.get(y).forEach((stripe) => stripe.setAttribute("opacity", opacity));
      });
      document.querySelectorAll(".indent-guide-line").forEach((line) => {
        const forParent = line.dataset.forParent;
        const ancestors = ancestorCache.get(forParent) || [];
        const shouldHide = collapsedKeys.has(forParent) || ancestors.some((a) => collapsedKeys.has(a));
        setSvgVisibility(line, shouldHide);
        if (!shouldHide) {
          const parentOfGuide = rowIndex.get(forParent);
          if (parentOfGuide && parentOfGuide.originalY > parentRowY) {
            const y1 = parseFloat(line.getAttribute("y1") || "0");
            const y2 = parseFloat(line.getAttribute("y2") || "0");
            line.setAttribute("y1", y1 + delta);
            line.setAttribute("y2", y2 + delta);
          }
        }
      });
      document.querySelectorAll(".dependency-arrow").forEach((arrow) => {
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        const fromBar = document.querySelector('.issue-bar[data-issue-id="' + fromId + '"]');
        const toBar = document.querySelector('.issue-bar[data-issue-id="' + toId + '"]');
        const fromHidden = fromBar?.classList.contains("gantt-row-hidden");
        const toHidden = toBar?.classList.contains("gantt-row-hidden");
        setSvgVisibility(arrow, fromHidden || toHidden);
      });
      vscode2.postMessage({ command: "collapseStateSync", collapseKey, isExpanded: shouldExpand });
    }
    if (savedSelectedKey) {
      const savedLabel = allLabels.find((el) => el.dataset.collapseKey === savedSelectedKey);
      if (savedLabel) {
        setActiveLabel(savedLabel, true);
      }
    }
    allLabels.forEach((el, index) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest?.(".collapse-toggle") || e.target.closest?.(".chevron-hit-area")) {
          return;
        }
        const issueId = el.dataset.issueId;
        const isProject = el.classList.contains("project-label");
        const isTimeGroup = el.classList.contains("time-group-label");
        const collapseKey = el.dataset.collapseKey;
        if ((isProject || isTimeGroup) && collapseKey) {
          setActiveLabel(el);
          if (el.dataset.hasChildren === "true") {
            toggleCollapseClientSide(collapseKey);
          }
          return;
        }
        const clickedOnText = e.target.classList?.contains("issue-text") || e.target.closest(".issue-text");
        if (issueId && clickedOnText) {
          setActiveLabel(el, false, false, true);
          vscode2.postMessage({ command: "openIssue", issueId: parseInt(issueId, 10) });
        } else if (el.dataset.hasChildren === "true" && collapseKey) {
          setActiveLabel(el);
          toggleCollapseClientSide(collapseKey);
        } else {
          setActiveLabel(el);
        }
      });
      el.addEventListener("keydown", (e) => {
        const collapseKey = el.dataset.collapseKey;
        const issueId = el.dataset.issueId ? parseInt(el.dataset.issueId, 10) : NaN;
        switch (e.key) {
          case "Enter":
          case " ":
            e.preventDefault();
            if (!isNaN(issueId)) {
              vscode2.postMessage({ command: "openIssue", issueId });
            }
            break;
          case "ArrowUp": {
            e.preventDefault();
            const prev = findVisibleLabel(index, -1);
            if (prev) setActiveLabel(prev.label, false, true);
            break;
          }
          case "ArrowDown": {
            e.preventDefault();
            const next = findVisibleLabel(index, 1);
            if (next) setActiveLabel(next.label, false, true);
            break;
          }
          case "ArrowLeft":
            e.preventDefault();
            if (el.dataset.hasChildren === "true" && el.dataset.expanded === "true") {
              toggleCollapseClientSide(collapseKey, "collapse");
            } else if (el.dataset.parentKey) {
              const parent = allLabels.find((l) => l.dataset.collapseKey === el.dataset.parentKey);
              if (parent) setActiveLabel(parent, false, true);
            }
            break;
          case "ArrowRight":
            e.preventDefault();
            if (el.dataset.hasChildren === "true" && el.dataset.expanded === "false") {
              toggleCollapseClientSide(collapseKey, "expand");
            } else if (el.dataset.hasChildren === "true" && el.dataset.expanded === "true") {
              const firstChild = allLabels.find((l) => l.dataset.parentKey === collapseKey && isLabelVisible(l));
              if (firstChild) setActiveLabel(firstChild, false, true);
            }
            break;
          case "Home": {
            e.preventDefault();
            const first = findVisibleLabel(-1, 1);
            if (first) setActiveLabel(first.label, false, true);
            break;
          }
          case "End": {
            e.preventDefault();
            const last = findVisibleLabel(allLabels.length, -1);
            if (last) setActiveLabel(last.label, false, true);
            break;
          }
          case "PageDown": {
            e.preventDefault();
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
          case "PageUp": {
            e.preventDefault();
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
          case "Tab":
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

  // src/webviews/gantt/gantt-keyboard.js
  function setupKeyboard(ctx) {
    const { vscode: vscode2, addDocListener, menuUndo, menuRedo, undoStack, redoStack, saveState, updateUndoRedoButtons, announce, scrollToAndHighlight, scrollToToday } = ctx;
    addDocListener("keydown", (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (modKey && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        menuUndo?.click();
      } else if (modKey && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        menuRedo?.click();
      } else if (modKey && e.key === "y") {
        e.preventDefault();
        menuRedo?.click();
      } else if (e.key >= "1" && e.key <= "5") {
        const zoomSelect = document.getElementById("zoomSelect");
        const levels = ["day", "week", "month", "quarter", "year"];
        zoomSelect.value = levels[parseInt(e.key) - 1];
        zoomSelect.dispatchEvent(new Event("change"));
      } else if (e.key.toLowerCase() === "y") {
        document.getElementById("menuCapacity")?.click();
      } else if (e.key.toLowerCase() === "i") {
        document.getElementById("menuIntensity")?.click();
      } else if (e.key.toLowerCase() === "d") {
        document.getElementById("menuDeps")?.click();
      } else if (e.key.toLowerCase() === "v") {
        const viewSelect = document.getElementById("viewFocusSelect");
        viewSelect.value = viewSelect.value === "project" ? "person" : "project";
        viewSelect.dispatchEvent(new Event("change"));
      } else if (e.key.toLowerCase() === "r") {
        document.getElementById("refreshBtn")?.click();
      } else if (e.key.toLowerCase() === "t") {
        scrollToToday();
      } else if (e.key.toLowerCase() === "e") {
        document.getElementById("menuExpand")?.click();
      } else if (e.key.toLowerCase() === "c" && !modKey) {
        document.getElementById("menuCollapse")?.click();
      } else if (e.key.toLowerCase() === "b") {
        document.getElementById("menuBadges")?.click();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const focusedBar = document.activeElement?.closest(".issue-bar:not(.parent-bar)");
        if (!focusedBar) return;
        e.preventDefault();
        const issueId = parseInt(focusedBar.dataset.issueId);
        const startDate = focusedBar.dataset.startDate;
        const dueDate = focusedBar.dataset.dueDate;
        if (!startDate && !dueDate) return;
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const addDays = (dateStr, days) => {
          const d = /* @__PURE__ */ new Date(dateStr + "T00:00:00");
          d.setDate(d.getDate() + days);
          return d.toISOString().slice(0, 10);
        };
        let newStart = null, newDue = null;
        if (e.shiftKey && dueDate) {
          newDue = addDays(dueDate, delta);
        } else if (e.altKey && startDate) {
          newStart = addDays(startDate, delta);
        } else {
          if (startDate) newStart = addDays(startDate, delta);
          if (dueDate) newDue = addDays(dueDate, delta);
        }
        if (newStart || newDue) {
          saveState();
          undoStack.push({
            issueId,
            oldStartDate: newStart ? startDate : null,
            oldDueDate: newDue ? dueDate : null,
            newStartDate: newStart,
            newDueDate: newDue
          });
          redoStack.length = 0;
          updateUndoRedoButtons();
          vscode2.postMessage({ command: "updateDates", issueId, startDate: newStart, dueDate: newDue });
        }
      } else if (e.key === "/" && !modKey) {
        e.preventDefault();
        showQuickSearch();
      } else if (e.key === "?" || e.shiftKey && e.key === "/") {
        e.preventDefault();
        toggleKeyboardHelp();
      }
    });
    let quickSearchEl = null;
    function showQuickSearch() {
      if (quickSearchEl) {
        quickSearchEl.remove();
      }
      quickSearchEl = document.createElement("div");
      quickSearchEl.className = "quick-search";
      quickSearchEl.innerHTML = `
      <input type="text" placeholder="Search issues..." autofocus />
    `;
      document.body.appendChild(quickSearchEl);
      const input = quickSearchEl.querySelector("input");
      input.focus();
      const labels = Array.from(document.querySelectorAll(".issue-label"));
      const labelData = labels.map((label) => ({
        el: label,
        text: (label.getAttribute("aria-label") || "").toLowerCase()
      }));
      let searchTimeout = null;
      input.addEventListener("input", () => {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const query = input.value.toLowerCase();
          labelData.forEach(({ el, text }) => {
            const match = query && text.includes(query);
            el.classList.toggle("search-match", match);
          });
        }, 50);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeQuickSearch();
        } else if (e.key === "Enter") {
          const match = document.querySelector(".issue-label.search-match");
          if (match) {
            closeQuickSearch();
            match.focus();
            scrollToAndHighlight(match.dataset.issueId);
          }
        }
      });
      input.addEventListener("blur", () => setTimeout(closeQuickSearch, 150));
    }
    function closeQuickSearch() {
      if (quickSearchEl) {
        quickSearchEl.remove();
        quickSearchEl = null;
        document.querySelectorAll(".search-match").forEach((el) => el.classList.remove("search-match"));
      }
    }
    let keyboardHelpEl = null;
    function toggleKeyboardHelp() {
      if (keyboardHelpEl) {
        keyboardHelpEl.remove();
        keyboardHelpEl = null;
        return;
      }
      keyboardHelpEl = document.createElement("div");
      keyboardHelpEl.className = "keyboard-help";
      keyboardHelpEl.innerHTML = `
      <div class="keyboard-help-content">
        <h3>Keyboard Shortcuts</h3>
        <div class="shortcut-grid">
          <div class="shortcut-section">
            <h4>Navigation</h4>
            <div><kbd>\u2191</kbd><kbd>\u2193</kbd> Move between issues</div>
            <div><kbd>Home</kbd><kbd>End</kbd> First/last issue</div>
            <div><kbd>PgUp</kbd><kbd>PgDn</kbd> Jump 10 rows</div>
            <div><kbd>Tab</kbd> Label \u2192 Bar</div>
            <div><kbd>Shift+Tab</kbd> Bar \u2192 Label</div>
          </div>
          <div class="shortcut-section">
            <h4>Date Editing</h4>
            <div><kbd>\u2190</kbd><kbd>\u2192</kbd> Move bar \xB11 day</div>
            <div><kbd>Shift+\u2190/\u2192</kbd> Resize end</div>
            <div><kbd>Alt+\u2190/\u2192</kbd> Resize start</div>
            <div><kbd>Ctrl+Z</kbd> Undo</div>
            <div><kbd>Ctrl+Y</kbd> Redo</div>
          </div>
          <div class="shortcut-section">
            <h4>View</h4>
            <div><kbd>1-5</kbd> Zoom levels</div>
            <div><kbd>D</kbd> Dependencies</div>
            <div><kbd>C</kbd> Critical path</div>
            <div><kbd>T</kbd> Today</div>
          </div>
          <div class="shortcut-section">
            <h4>Other</h4>
            <div><kbd>B</kbd> Badges</div>
            <div><kbd>/</kbd> Quick search</div>
            <div><kbd>S</kbd> Cycle sort</div>
            <div><kbd>R</kbd> Refresh</div>
            <div><kbd>Esc</kbd> Clear/cancel</div>
          </div>
        </div>
        <p class="keyboard-help-close">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>
      </div>
    `;
      document.body.appendChild(keyboardHelpEl);
      keyboardHelpEl.addEventListener("click", (e) => {
        if (e.target === keyboardHelpEl) toggleKeyboardHelp();
      });
    }
    addDocListener("keydown", (e) => {
      if (e.key === "Escape" && keyboardHelpEl) {
        e.stopImmediatePropagation();
        toggleKeyboardHelp();
      }
    });
  }

  // src/webviews/gantt/index.js
  var vscode = acquireVsCodeApi();
  var PERF_DEBUG = false;
  function perfMark(name) {
    if (PERF_DEBUG && typeof performance !== "undefined") {
      performance.mark(name);
    }
  }
  function perfMeasure(name, startMark, endMark) {
    if (PERF_DEBUG && typeof performance !== "undefined") {
      try {
        performance.measure(name, startMark, endMark);
        const entries = performance.getEntriesByName(name, "measure");
        if (entries.length > 0) {
          console.log(`[Gantt Perf] ${name}: ${entries[entries.length - 1].duration.toFixed(2)}ms`);
        }
        performance.clearMarks(startMark);
        performance.clearMarks(endMark);
        performance.clearMeasures(name);
      } catch (e) {
      }
    }
  }
  function logDomStats() {
    if (PERF_DEBUG) {
      const root = document.getElementById("ganttRoot");
      const nodeCount = root ? root.querySelectorAll("*").length : 0;
      const svgCount = root ? root.querySelectorAll("svg *").length : 0;
      console.log(`[Gantt Perf] DOM nodes: ${nodeCount}, SVG elements: ${svgCount}`);
    }
  }
  function applyCssVars(state) {
    if (!state) return;
    const root = document.documentElement;
    root.style.setProperty("--gantt-header-height", `${state.headerHeight}px`);
    root.style.setProperty("--gantt-label-width", `${state.labelWidth}px`);
    root.style.setProperty("--gantt-id-column-width", `${state.idColumnWidth}px`);
    root.style.setProperty("--gantt-start-date-column-width", `${state.startDateColumnWidth}px`);
    root.style.setProperty("--gantt-status-column-width", `${state.statusColumnWidth}px`);
    root.style.setProperty("--gantt-due-date-column-width", `${state.dueDateColumnWidth}px`);
    root.style.setProperty("--gantt-assignee-column-width", `${state.assigneeColumnWidth}px`);
    root.style.setProperty("--gantt-sticky-left-width", `${state.stickyLeftWidth}px`);
  }
  function setupTooltips({ addDocListener, addWinListener }) {
    const root = document.getElementById("ganttRoot");
    const tooltip = document.getElementById("ganttTooltip");
    const tooltipContent = tooltip?.querySelector(".gantt-tooltip-content");
    if (!root || !tooltip || !tooltipContent) return;
    const normalizeTooltipText = (value) => {
      if (!value) return "";
      return String(value).replace(/\r\n/g, "\n").trimEnd();
    };
    function convertSvgTitles() {
      root.querySelectorAll("svg title").forEach((title) => {
        const parent = title.parentElement;
        const text = normalizeTooltipText(title.textContent);
        if (parent && text) {
          parent.dataset.tooltip = text;
        }
        title.remove();
      });
    }
    function convertTitleAttributes() {
      root.querySelectorAll("[title]").forEach((el) => {
        if (el.tagName.toLowerCase() === "title") return;
        const text = normalizeTooltipText(el.getAttribute("title"));
        el.removeAttribute("title");
        if (text) {
          el.dataset.tooltip = text;
        }
      });
    }
    function convertToolbarTooltips() {
      root.querySelectorAll("[data-toolbar-tooltip]").forEach((el) => {
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
      const headerIndex = lines.findIndex((line) => line.trim().startsWith("#"));
      if (headerIndex >= 0) return headerIndex;
      const nonEmptyLines = lines.filter((line) => line.trim());
      if (nonEmptyLines.length > 1) {
        return lines.findIndex((line) => line.trim());
      }
      return -1;
    }
    function buildTooltipContent(text) {
      tooltipContent.textContent = "";
      const normalized = normalizeTooltipText(text);
      if (!normalized) return;
      const lines = normalized.split("\n");
      const headerIndex = findHeaderIndex(lines);
      let lastWasSpacer = false;
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) {
          if (!lastWasSpacer) {
            const spacer = document.createElement("div");
            spacer.className = "gantt-tooltip-spacer";
            tooltipContent.appendChild(spacer);
            lastWasSpacer = true;
          }
          return;
        }
        if (trimmed === "---") {
          const divider = document.createElement("div");
          divider.className = "gantt-tooltip-divider";
          tooltipContent.appendChild(divider);
          lastWasSpacer = false;
          return;
        }
        const customMatch = trimmed.match(/^cf:([^:]+):(.*)$/);
        if (customMatch) {
          const key = customMatch[1].trim();
          const value = customMatch[2].trim();
          const lineEl2 = document.createElement("div");
          lineEl2.className = "gantt-tooltip-line";
          const keyEl = document.createElement("span");
          keyEl.className = "gantt-tooltip-key";
          keyEl.textContent = `${key}: `;
          lineEl2.appendChild(keyEl);
          if (value) {
            lineEl2.appendChild(document.createTextNode(value));
          }
          tooltipContent.appendChild(lineEl2);
          lastWasSpacer = false;
          return;
        }
        const lineEl = document.createElement("div");
        lineEl.className = "gantt-tooltip-line";
        if (index === headerIndex) {
          lineEl.classList.add("gantt-tooltip-title");
        }
        const openMatch = trimmed.match(/^Open in Browser:\s*(\S+)/);
        if (openMatch && /^https?:\/\//i.test(openMatch[1])) {
          lineEl.appendChild(document.createTextNode("Open in Browser: "));
          const link = document.createElement("a");
          link.href = openMatch[1];
          link.textContent = openMatch[1];
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          lineEl.appendChild(link);
        } else {
          lineEl.textContent = line;
        }
        tooltipContent.appendChild(lineEl);
        lastWasSpacer = false;
      });
      const lastChild = tooltipContent.lastElementChild;
      if (lastChild && lastChild.classList.contains("gantt-tooltip-spacer")) {
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
      const text = target.dataset.tooltip;
      if (!text) return;
      buildTooltipContent(text);
      tooltip.classList.add("visible");
      tooltip.setAttribute("aria-hidden", "false");
      positionTooltip(x, y);
    }
    function hideTooltip(keepTarget = false) {
      cancelShow();
      cancelHide();
      tooltip.classList.remove("visible");
      tooltip.setAttribute("aria-hidden", "true");
      if (!keepTarget) {
        activeTarget = null;
      }
    }
    function resolveTooltipTarget(node) {
      if (!node || node === tooltip || tooltip.contains(node)) return null;
      const target = node.closest?.("[data-tooltip], [title]");
      if (!target || !root.contains(target)) return null;
      if (target.hasAttribute("title")) {
        const title = normalizeTooltipText(target.getAttribute("title"));
        target.removeAttribute("title");
        if (title) {
          target.dataset.tooltip = title;
        }
      }
      if (!target.dataset.tooltip) return null;
      return target;
    }
    prepareTooltips();
    addDocListener("pointerover", (event) => {
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
        if (tooltip.classList.contains("visible")) {
          hideTooltip(true);
        }
        scheduleShow(target);
      } else if (!tooltip.classList.contains("visible")) {
        scheduleShow(target);
      }
    }, true);
    addDocListener("pointermove", (event) => {
      if (!activeTarget) return;
      updatePointer(event);
      if (hideTimer && isPointerOverTooltipOrTarget()) {
        cancelHide();
      }
    }, true);
    addDocListener("pointerout", (event) => {
      if (!activeTarget) return;
      updatePointer(event);
      cancelShow();
      if (!isInActiveTarget(event.target) && !isInTooltip(event.target)) return;
      const related = event.relatedTarget;
      if (isInTooltip(related) || isInActiveTarget(related)) return;
      scheduleHide();
    }, true);
    addDocListener("scroll", () => {
      if (activeTarget) hideTooltip();
    }, true);
    addDocListener("keydown", () => {
      if (activeTarget) hideTooltip();
    }, true);
    addWinListener("blur", () => {
      if (activeTarget) hideTooltip();
    });
  }
  function render(payload) {
    if (!payload) return;
    if (payload.state) {
      PERF_DEBUG = payload.state.perfDebug ?? false;
    }
    perfMark("render-start");
    const root = document.getElementById("ganttRoot");
    if (!root) return;
    applyCssVars(payload.state);
    perfMark("innerHTML-start");
    root.innerHTML = payload.html || "";
    perfMark("innerHTML-end");
    perfMeasure("innerHTML", "innerHTML-start", "innerHTML-end");
    initializeGantt(payload.state);
    perfMark("render-end");
    perfMeasure("render", "render-start", "render-end");
    logDomStats();
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.command === "render") {
      render(message.payload);
      return;
    }
    if (window.__ganttHandleExtensionMessage) {
      window.__ganttHandleExtensionMessage(message);
    }
  });
  var initialPayload = window.__GANTT_INITIAL_PAYLOAD__;
  if (initialPayload) {
    render(initialPayload);
  }
  vscode.postMessage({ command: "webviewReady" });
  function initializeGantt(state) {
    perfMark("initializeGantt-start");
    if (!state) return;
    const {
      timelineWidth,
      minDateMs,
      maxDateMs,
      totalDays,
      extendedRelationTypes,
      redmineBaseUrl,
      minimapBarsData,
      minimapHeight,
      minimapBarHeight,
      minimapTodayX,
      extScrollLeft,
      extScrollTop,
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
    let currentDraftMode = isDraftMode;
    const confirmBtn = document.getElementById("dragConfirmOk");
    if (confirmBtn) {
      confirmBtn.textContent = isDraftMode ? "Queue to Draft" : "Save to Redmine";
    }
    const draftBadge = document.getElementById("draftBadge");
    if (draftBadge) {
      if (isDraftMode) {
        draftBadge.classList.remove("hidden");
        const c = draftQueueCount ?? 0;
        draftBadge.textContent = c;
        draftBadge.dataset.tooltip = c === 1 ? "1 change queued - click to review" : c + " changes queued - click to review";
      } else {
        draftBadge.classList.add("hidden");
      }
      draftBadge.addEventListener("click", () => {
        vscode.postMessage({ command: "openDraftReview" });
      });
    }
    const draftModeToggle = document.getElementById("draftModeToggle");
    if (draftModeToggle) {
      draftModeToggle.addEventListener("click", () => {
        vscode.postMessage({ command: "toggleDraftMode" });
      });
    }
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
    window._ganttCleanup = () => {
      docListeners.forEach((l) => document.removeEventListener(l.type, l.handler, l.options));
      winListeners.forEach((l) => window.removeEventListener(l.type, l.handler, l.options));
      window.__ganttHandleExtensionMessage = null;
    };
    function closeOnOutsideClick(element) {
      setTimeout(() => {
        document.addEventListener("click", function closeHandler(e) {
          if (!element.contains(e.target)) {
            element.remove();
            document.removeEventListener("click", closeHandler);
          }
        });
      }, 0);
    }
    function snapToDay(x) {
      return Math.round(x / dayWidth) * dayWidth;
    }
    function announce(message) {
      const liveRegion = document.getElementById("liveRegion");
      if (liveRegion) {
        liveRegion.textContent = message;
      }
    }
    const ganttScroll = document.getElementById("ganttScroll");
    const ganttLeftHeader = document.getElementById("ganttLeftHeader");
    const labelsColumn = document.getElementById("ganttLabels");
    const timelineColumn = document.getElementById("ganttTimeline");
    const menuUndo = document.getElementById("menuUndo");
    const menuRedo = document.getElementById("menuRedo");
    const minimapSvg = document.getElementById("minimapSvg");
    const minimapViewport = document.getElementById("minimapViewport");
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
    const previousState = vscode.getState() || { undoStack: [], redoStack: [], labelWidth, scrollLeft: null, scrollTop: null, centerDateMs: null };
    const undoStack = previousState.undoStack || [];
    const redoStack = previousState.redoStack || [];
    let savedScrollLeft = previousState.scrollLeft ?? (extScrollLeft > 0 ? extScrollLeft : null);
    let savedScrollTop = previousState.scrollTop ?? (extScrollTop > 0 ? extScrollTop : null);
    let savedCenterDateMs = previousState.centerDateMs;
    function getCenterDateMs() {
      if (!ganttScroll) return null;
      const stickyLeft = document.querySelector(".gantt-body .gantt-sticky-left");
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      const centerX = ganttScroll.scrollLeft + visibleTimelineWidth / 2;
      const ratio = centerX / timelineWidth;
      return minDateMs + ratio * (maxDateMs - minDateMs);
    }
    function scrollToCenterDate(dateMs) {
      if (!ganttScroll) return;
      const ratio = (dateMs - minDateMs) / (maxDateMs - minDateMs);
      const centerX = ratio * timelineWidth;
      const stickyLeft = document.querySelector(".gantt-body .gantt-sticky-left");
      const stickyWidth = stickyLeft?.offsetWidth ?? 0;
      const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
      ganttScroll.scrollLeft = Math.max(0, centerX - visibleTimelineWidth / 2);
    }
    function saveState() {
      vscode.setState({
        undoStack,
        redoStack,
        labelWidth: labelsColumn?.offsetWidth || labelWidth,
        scrollLeft: null,
        // Deprecated: use centerDateMs instead
        scrollTop: ganttScroll?.scrollTop ?? null,
        centerDateMs: getCenterDateMs()
      });
    }
    const saveStateForZoom = saveState;
    function updateUndoRedoButtons() {
      if (menuUndo) menuUndo.toggleAttribute("disabled", undoStack.length === 0);
      if (menuRedo) menuRedo.toggleAttribute("disabled", redoStack.length === 0);
      saveState();
    }
    if (previousState.labelWidth && ganttLeftHeader && labelsColumn) {
      ganttLeftHeader.style.width = previousState.labelWidth + "px";
      labelsColumn.style.width = previousState.labelWidth + "px";
      const capacityLabel = document.querySelector(".capacity-ribbon-label");
      if (capacityLabel) {
        capacityLabel.style.width = previousState.labelWidth + leftExtrasWidth + "px";
      }
    }
    let restoringScroll = true;
    let allowScrollChange = false;
    const setAllowScrollChange = (value) => {
      allowScrollChange = value;
    };
    let deferredScrollUpdate = null;
    if (ganttScroll) {
      ganttScroll.addEventListener("scroll", () => {
        cancelAnimationFrame(deferredScrollUpdate);
        deferredScrollUpdate = requestAnimationFrame(() => {
          updateMinimapViewport();
          if (!restoringScroll) saveState();
        });
      }, { passive: true });
    }
    requestAnimationFrame(() => updateUndoRedoButtons());
    window.__ganttHandleExtensionMessage = (message) => {
      if (message.command === "setDependenciesState") {
        const dependencyLayer = document.querySelector(".dependency-layer");
        const menuDeps = document.getElementById("menuDeps");
        if (message.enabled) {
          if (dependencyLayer) dependencyLayer.classList.remove("hidden");
          if (menuDeps) menuDeps.classList.add("active");
        } else {
          if (dependencyLayer) dependencyLayer.classList.add("hidden");
          if (menuDeps) menuDeps.classList.remove("active");
        }
      } else if (message.command === "setBadgesState") {
        const ganttContainer2 = document.querySelector(".gantt-container");
        const menuBadges = document.getElementById("menuBadges");
        if (message.enabled) {
          if (ganttContainer2) ganttContainer2.classList.remove("hide-badges");
          if (menuBadges) menuBadges.classList.add("active");
        } else {
          if (ganttContainer2) ganttContainer2.classList.add("hide-badges");
          if (menuBadges) menuBadges.classList.remove("active");
        }
      } else if (message.command === "setCapacityRibbonState") {
        const capacityRibbon = document.querySelector(".capacity-ribbon");
        const menuCapacity = document.getElementById("menuCapacity");
        if (message.enabled) {
          if (capacityRibbon) capacityRibbon.classList.remove("hidden");
          if (menuCapacity) menuCapacity.classList.add("active");
        } else {
          if (capacityRibbon) capacityRibbon.classList.add("hidden");
          if (menuCapacity) menuCapacity.classList.remove("active");
        }
      } else if (message.command === "setIntensityState") {
        const ganttContainer2 = document.querySelector(".gantt-container");
        const menuIntensity = document.getElementById("menuIntensity");
        if (message.enabled) {
          ganttContainer2?.classList.add("intensity-enabled");
          if (menuIntensity) menuIntensity.classList.add("active");
        } else {
          ganttContainer2?.classList.remove("intensity-enabled");
          if (menuIntensity) menuIntensity.classList.remove("active");
        }
      } else if (message.command === "setDraftModeState") {
        currentDraftMode = message.enabled;
        const confirmBtn2 = document.getElementById("dragConfirmOk");
        if (confirmBtn2) {
          confirmBtn2.textContent = message.enabled ? "Queue to Draft" : "Save to Redmine";
        }
        const toggleBtn = document.getElementById("draftModeToggle");
        if (toggleBtn) {
          toggleBtn.classList.toggle("active", message.enabled);
          toggleBtn.textContent = message.enabled ? "Disable Draft Mode" : "Enable Draft Mode";
        }
        const draftBadge2 = document.getElementById("draftBadge");
        if (draftBadge2) {
          if (message.enabled) {
            draftBadge2.classList.remove("hidden");
            const c = message.queueCount ?? 0;
            draftBadge2.textContent = c;
            draftBadge2.dataset.tooltip = c === 1 ? "1 change queued - click to review" : c + " changes queued - click to review";
          } else {
            draftBadge2.classList.add("hidden");
          }
        }
      } else if (message.command === "setDraftQueueCount") {
        const draftBadge2 = document.getElementById("draftBadge");
        if (draftBadge2) {
          const c = message.count;
          draftBadge2.textContent = c;
          draftBadge2.dataset.tooltip = c === 1 ? "1 change queued - click to review" : c + " changes queued - click to review";
        }
      } else if (message.command === "pushUndoAction") {
        undoStack.push(message.action);
        redoStack.length = 0;
        updateUndoRedoButtons();
        saveState();
      } else if (message.command === "updateRelationId") {
        const stack = message.stack === "undo" ? undoStack : redoStack;
        if (stack.length > 0) {
          const lastAction = stack[stack.length - 1];
          if (lastAction.type === "relation") {
            lastAction.relationId = message.newRelationId;
            saveState();
          }
        }
      } else if (message.command === "scrollToIssue") {
        const issueId = message.issueId;
        const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
        const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
        const scrollContainer = document.getElementById("ganttScroll");
        const headerRow = document.querySelector(".gantt-header-row");
        const headerHeight = headerRow?.getBoundingClientRect().height || 60;
        if (!scrollContainer) return;
        let targetScrollTop = scrollContainer.scrollTop;
        let targetScrollLeft = scrollContainer.scrollLeft;
        if (label) {
          const labelRow = label.closest(".gantt-row");
          if (labelRow) {
            const rowTop = labelRow.offsetTop;
            const rowHeight = labelRow.getBoundingClientRect().height;
            const viewportHeight = scrollContainer.clientHeight - headerHeight;
            targetScrollTop = Math.max(0, rowTop - headerHeight - (viewportHeight - rowHeight) / 2);
          }
          label.focus();
          label.classList.add("highlighted");
          setTimeout(() => label.classList.remove("highlighted"), 2e3);
        }
        if (bar) {
          const startX = parseFloat(bar.getAttribute("data-start-x") || "0");
          const endX = parseFloat(bar.getAttribute("data-end-x") || "0");
          const barWidth = endX - startX;
          const viewportWidth = scrollContainer.clientWidth;
          const stickyLeftWidth = document.querySelector(".gantt-sticky-left")?.getBoundingClientRect().width || 0;
          const availableWidth = viewportWidth - stickyLeftWidth;
          if (barWidth <= availableWidth - 100) {
            targetScrollLeft = startX - (availableWidth - barWidth) / 2;
          } else {
            targetScrollLeft = startX - 50;
          }
          targetScrollLeft = Math.max(0, targetScrollLeft);
          bar.classList.add("highlighted");
          setTimeout(() => bar.classList.remove("highlighted"), 2e3);
        }
        scrollContainer.scrollTo({ left: targetScrollLeft, top: targetScrollTop, behavior: "smooth" });
      }
    };
    document.getElementById("lookbackSelect")?.addEventListener("change", (e) => {
      vscode.postMessage({ command: "setLookback", years: e.target.value });
    });
    document.getElementById("zoomSelect")?.addEventListener("change", (e) => {
      saveStateForZoom();
      vscode.postMessage({ command: "setZoom", zoomLevel: e.target.value });
    });
    document.getElementById("viewFocusSelect")?.addEventListener("change", (e) => {
      vscode.postMessage({ command: "setViewFocus", focus: e.target.value });
    });
    const projectSelector = document.getElementById("projectSelector");
    projectSelector?.addEventListener("change", (e) => {
      const value = e.target.value;
      const projectId = value ? parseInt(value, 10) : null;
      vscode.postMessage({ command: "setSelectedProject", projectId });
    });
    const focusSelector = document.getElementById("focusSelector");
    focusSelector?.addEventListener("change", (e) => {
      const value = e.target.value;
      vscode.postMessage({
        command: "setSelectedAssignee",
        assignee: value || null
      });
    });
    document.getElementById("filterAssignee")?.addEventListener("change", (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: "setFilter", filter: { assignee: value } });
    });
    document.getElementById("filterStatus")?.addEventListener("change", (e) => {
      const value = e.target.value;
      vscode.postMessage({ command: "setFilter", filter: { status: value } });
    });
    document.querySelectorAll(".gantt-col-header.sortable").forEach((header) => {
      header.addEventListener("click", () => {
        const sortField = header.dataset.sort;
        const currentSort = sortBy;
        const currentOrder = sortOrder;
        if (sortField === currentSort) {
          if (currentOrder === "asc") {
            vscode.postMessage({ command: "setSort", sortOrder: "desc" });
          } else {
            vscode.postMessage({ command: "setSort", sortBy: null });
          }
        } else {
          vscode.postMessage({ command: "setSort", sortBy: sortField, sortOrder: "asc" });
        }
      });
    });
    document.getElementById("menuCapacity")?.addEventListener("click", () => {
      if (document.getElementById("menuCapacity")?.hasAttribute("disabled")) return;
      saveState();
      vscode.postMessage({ command: "toggleCapacityRibbon" });
    });
    document.getElementById("menuIntensity")?.addEventListener("click", () => {
      if (document.getElementById("menuIntensity")?.hasAttribute("disabled")) return;
      saveState();
      vscode.postMessage({ command: "toggleIntensity" });
    });
    document.getElementById("overloadBadge")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const badge = e.currentTarget;
      const firstOverloadMs = parseInt(badge.dataset.firstOverloadMs || "0", 10);
      if (firstOverloadMs > 0) {
        scrollToCenterDate(firstOverloadMs);
        saveState();
      }
    });
    document.querySelectorAll(".capacity-day-bar-group").forEach((group) => {
      group.addEventListener("click", (e) => {
        const dateMs = parseInt(e.currentTarget.dataset.dateMs || "0", 10);
        if (dateMs > 0) {
          scrollToCenterDate(dateMs);
          saveState();
        }
      });
    });
    document.getElementById("menuDeps")?.addEventListener("click", () => {
      saveState();
      vscode.postMessage({ command: "toggleDependencies" });
    });
    document.getElementById("menuBadges")?.addEventListener("click", () => {
      saveState();
      vscode.postMessage({ command: "toggleBadges" });
    });
    const ganttContainer = document.querySelector(".gantt-container");
    function buildBlockingGraph() {
      const graph = /* @__PURE__ */ new Map();
      const reverseGraph = /* @__PURE__ */ new Map();
      document.querySelectorAll(".dependency-arrow").forEach((arrow) => {
        const relType = arrow.classList.contains("rel-blocks") || arrow.classList.contains("rel-precedes");
        if (!relType) return;
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        if (!graph.has(fromId)) graph.set(fromId, []);
        graph.get(fromId).push(toId);
        if (!reverseGraph.has(toId)) reverseGraph.set(toId, []);
        reverseGraph.get(toId).push(fromId);
      });
      return { graph, reverseGraph };
    }
    let focusedIssueId = null;
    function getAllConnected(issueId, graph, reverseGraph) {
      const connected = /* @__PURE__ */ new Set([issueId]);
      const queue = [issueId];
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
    function focusOnDependencyChain(issueId) {
      clearFocus();
      if (!issueId) return;
      focusedIssueId = issueId;
      const { graph, reverseGraph } = buildBlockingGraph();
      const connected = getAllConnected(issueId, graph, reverseGraph);
      ganttContainer.classList.add("focus-mode");
      document.querySelectorAll(".issue-bar").forEach((bar) => {
        if (connected.has(bar.dataset.issueId)) {
          bar.classList.add("focus-highlighted");
        }
      });
      document.querySelectorAll(".issue-label").forEach((label) => {
        if (connected.has(label.dataset.issueId)) {
          label.classList.add("focus-highlighted");
        }
      });
      document.querySelectorAll(".dependency-arrow").forEach((arrow) => {
        if (connected.has(arrow.dataset.from) && connected.has(arrow.dataset.to)) {
          arrow.classList.add("focus-highlighted");
        }
      });
      announce(`Focus: ${connected.size} issue${connected.size !== 1 ? "s" : ""} in dependency chain`);
    }
    function clearFocus() {
      focusedIssueId = null;
      ganttContainer.classList.remove("focus-mode");
      document.querySelectorAll(".focus-highlighted").forEach((el) => el.classList.remove("focus-highlighted"));
    }
    const getFocusedIssueId = () => focusedIssueId;
    const selectedIssues = /* @__PURE__ */ new Set();
    let lastClickedIssueId = null;
    const selectionCountEl = document.getElementById("selectionCount");
    const allIssueBars = Array.from(document.querySelectorAll(".issue-bar"));
    const barsByIssueId = /* @__PURE__ */ new Map();
    allIssueBars.forEach((bar) => {
      const id = bar.dataset.issueId;
      if (id) {
        if (!barsByIssueId.has(id)) barsByIssueId.set(id, []);
        barsByIssueId.get(id).push(bar);
      }
    });
    function updateSelectionForIds(changedIds) {
      changedIds.forEach((issueId) => {
        const bars = barsByIssueId.get(issueId);
        if (bars) {
          bars.forEach((bar) => bar.classList.toggle("selected", selectedIssues.has(issueId)));
        }
      });
      if (selectedIssues.size > 0) {
        selectionCountEl.textContent = `${selectedIssues.size} selected`;
        selectionCountEl.classList.remove("hidden");
        ganttContainer.classList.add("multi-select-mode");
      } else {
        selectionCountEl.classList.add("hidden");
        ganttContainer.classList.remove("multi-select-mode");
      }
    }
    function updateSelectionUI() {
      allIssueBars.forEach((bar) => {
        bar.classList.toggle("selected", selectedIssues.has(bar.dataset.issueId));
      });
      if (selectedIssues.size > 0) {
        selectionCountEl.textContent = `${selectedIssues.size} selected`;
        selectionCountEl.classList.remove("hidden");
        ganttContainer.classList.add("multi-select-mode");
      } else {
        selectionCountEl.classList.add("hidden");
        ganttContainer.classList.remove("multi-select-mode");
      }
    }
    function clearSelection() {
      const changedIds = [...selectedIssues];
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
      updateSelectionForIds([issueId]);
    }
    function selectRange(fromId, toId) {
      const fromIndex = allIssueBars.findIndex((b) => b.dataset.issueId === fromId);
      const toIndex = allIssueBars.findIndex((b) => b.dataset.issueId === toId);
      if (fromIndex === -1 || toIndex === -1) return;
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      const changedIds = [];
      for (let i = start; i <= end; i++) {
        const id = allIssueBars[i].dataset.issueId;
        if (!selectedIssues.has(id)) {
          selectedIssues.add(id);
          changedIds.push(id);
        }
      }
      updateSelectionForIds(changedIds);
    }
    function selectAll() {
      allIssueBars.forEach((bar) => selectedIssues.add(bar.dataset.issueId));
      updateSelectionUI();
      announce(`Selected all ${selectedIssues.size} issues`);
    }
    allIssueBars.forEach((bar) => {
      bar.addEventListener("mousedown", (e) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
        if (e.target.classList.contains("drag-handle") || e.target.classList.contains("link-handle")) return;
        e.preventDefault();
        e.stopPropagation();
        const issueId = bar.dataset.issueId;
        if (e.shiftKey && lastClickedIssueId) {
          selectRange(lastClickedIssueId, issueId);
        } else {
          toggleSelection(issueId);
        }
      });
    });
    addDocListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAll();
      }
      if (e.key === "Escape" && selectedIssues.size > 0) {
        e.stopImmediatePropagation();
        clearSelection();
        announce("Selection cleared");
      }
    });
    document.getElementById("refreshBtn")?.addEventListener("click", () => {
      document.getElementById("loadingOverlay")?.classList.add("visible");
      vscode.postMessage({ command: "refresh" });
    });
    document.getElementById("draftBadge")?.addEventListener("click", () => {
      vscode.postMessage({ command: "openDraftReview" });
    });
    function showDeletePicker(x, y, relationId, fromId, toId, relationType) {
      document.querySelector(".relation-picker")?.remove();
      const picker = document.createElement("div");
      picker.className = "relation-picker";
      const pickerWidth = 150;
      const pickerHeight = 120;
      const clampedX = Math.min(x, window.innerWidth - pickerWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - pickerHeight - 10);
      picker.style.left = Math.max(10, clampedX) + "px";
      picker.style.top = Math.max(10, clampedY) + "px";
      const label = document.createElement("div");
      label.style.padding = "6px 12px";
      label.style.fontSize = "11px";
      label.style.opacity = "0.7";
      label.textContent = `#${fromId} \u2192 #${toId}`;
      picker.appendChild(label);
      if (relationType === "precedes" || relationType === "follows") {
        const delayBtn = document.createElement("button");
        delayBtn.textContent = "Update delay...";
        delayBtn.addEventListener("click", () => {
          picker.remove();
          vscode.postMessage({ command: "updateRelationDelay", relationId, fromId, toId });
        });
        picker.appendChild(delayBtn);
      }
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete relation";
      deleteBtn.addEventListener("click", () => {
        saveState();
        vscode.postMessage({ command: "deleteRelation", relationId });
        picker.remove();
      });
      picker.appendChild(deleteBtn);
      document.body.appendChild(picker);
      closeOnOutsideClick(picker);
    }
    const issueBarsByIssueId = /* @__PURE__ */ new Map();
    const issueLabelsByIssueId = /* @__PURE__ */ new Map();
    const arrowsByIssueId = /* @__PURE__ */ new Map();
    const projectLabelsByKey = /* @__PURE__ */ new Map();
    const aggregateBarsByKey = /* @__PURE__ */ new Map();
    let mapsReady = false;
    function buildLookupMaps() {
      document.querySelectorAll(".issue-bar, .issue-label, .dependency-arrow, .project-label, .aggregate-bars").forEach((el) => {
        const classList = el.classList;
        if (classList.contains("issue-bar")) {
          const id = el.dataset.issueId;
          if (id) {
            if (!issueBarsByIssueId.has(id)) issueBarsByIssueId.set(id, []);
            issueBarsByIssueId.get(id).push(el);
          }
        } else if (classList.contains("issue-label")) {
          const id = el.dataset.issueId;
          if (id) {
            if (!issueLabelsByIssueId.has(id)) issueLabelsByIssueId.set(id, []);
            issueLabelsByIssueId.get(id).push(el);
          }
        } else if (classList.contains("dependency-arrow")) {
          const fromId = el.dataset.from;
          const toId = el.dataset.to;
          if (fromId) {
            if (!arrowsByIssueId.has(fromId)) arrowsByIssueId.set(fromId, []);
            arrowsByIssueId.get(fromId).push(el);
          }
          if (toId) {
            if (!arrowsByIssueId.has(toId)) arrowsByIssueId.set(toId, []);
            arrowsByIssueId.get(toId).push(el);
          }
        } else if (classList.contains("project-label")) {
          const key = el.dataset.collapseKey;
          if (key) {
            if (!projectLabelsByKey.has(key)) projectLabelsByKey.set(key, []);
            projectLabelsByKey.get(key).push(el);
          }
        } else if (classList.contains("aggregate-bars")) {
          const key = el.dataset.collapseKey;
          if (key) {
            if (!aggregateBarsByKey.has(key)) aggregateBarsByKey.set(key, []);
            aggregateBarsByKey.get(key).push(el);
          }
        }
      });
      mapsReady = true;
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => buildLookupMaps(), { timeout: 100 });
    } else {
      setTimeout(buildLookupMaps, 0);
    }
    let highlightedElements = [];
    function clearHoverHighlight() {
      document.body.classList.remove("hover-focus", "dependency-hover");
      highlightedElements.forEach((el) => el.classList.remove("hover-highlighted", "hover-source"));
      highlightedElements = [];
    }
    function highlightIssue(issueId) {
      document.body.classList.add("hover-focus");
      const bars = mapsReady ? issueBarsByIssueId.get(issueId) || [] : document.querySelectorAll('.issue-bar[data-issue-id="' + issueId + '"]');
      const labels = mapsReady ? issueLabelsByIssueId.get(issueId) || [] : document.querySelectorAll('.issue-label[data-issue-id="' + issueId + '"]');
      const arrows = mapsReady ? arrowsByIssueId.get(issueId) || [] : document.querySelectorAll('.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]');
      bars.forEach((el) => {
        el.classList.add("hover-highlighted");
        highlightedElements.push(el);
      });
      labels.forEach((el) => {
        el.classList.add("hover-highlighted");
        highlightedElements.push(el);
      });
      arrows.forEach((el) => {
        el.classList.add("hover-highlighted");
        highlightedElements.push(el);
      });
    }
    function highlightProject(collapseKey) {
      document.body.classList.add("hover-focus");
      const labels = mapsReady ? projectLabelsByKey.get(collapseKey) || [] : document.querySelectorAll('.project-label[data-collapse-key="' + collapseKey + '"]');
      const bars = mapsReady ? aggregateBarsByKey.get(collapseKey) || [] : document.querySelectorAll('.aggregate-bars[data-collapse-key="' + collapseKey + '"]');
      labels.forEach((el) => {
        el.classList.add("hover-highlighted");
        highlightedElements.push(el);
      });
      bars.forEach((el) => {
        el.classList.add("hover-highlighted");
        highlightedElements.push(el);
      });
    }
    const timelineSvg = document.querySelector(".gantt-timeline svg");
    const labelsSvg = document.querySelector(".gantt-labels svg");
    if (timelineSvg) {
      timelineSvg.addEventListener("mouseenter", (e) => {
        const bar = e.target.closest(".issue-bar");
        const aggBar = e.target.closest(".aggregate-bars");
        const arrow = e.target.closest(".dependency-arrow");
        if (bar) {
          const issueId = bar.dataset.issueId;
          if (issueId) highlightIssue(issueId);
        } else if (aggBar) {
          const key = aggBar.dataset.collapseKey;
          if (key) highlightProject(key);
        } else if (arrow) {
          const fromId = arrow.dataset.from;
          const toId = arrow.dataset.to;
          document.body.classList.add("dependency-hover");
          arrow.classList.add("hover-source");
          highlightedElements.push(arrow);
          if (fromId) highlightIssue(fromId);
          if (toId) highlightIssue(toId);
        }
      }, true);
      timelineSvg.addEventListener("mouseleave", (e) => {
        const bar = e.target.closest(".issue-bar");
        const aggBar = e.target.closest(".aggregate-bars");
        const arrow = e.target.closest(".dependency-arrow");
        if (bar || aggBar || arrow) {
          clearHoverHighlight();
        }
      }, true);
    }
    if (labelsSvg) {
      labelsSvg.addEventListener("mouseenter", (e) => {
        const label = e.target.closest(".issue-label");
        const projectLabel = e.target.closest(".project-label");
        if (label) {
          const issueId = label.dataset.issueId;
          if (issueId) highlightIssue(issueId);
        } else if (projectLabel) {
          const key = projectLabel.dataset.collapseKey;
          if (key) highlightProject(key);
        }
      }, true);
      labelsSvg.addEventListener("mouseleave", (e) => {
        const label = e.target.closest(".issue-label");
        const projectLabel = e.target.closest(".project-label");
        if (label || projectLabel) {
          clearHoverHighlight();
        }
      }, true);
    }
    if (timelineSvg) {
      let clearArrowSelection2 = function() {
        selectedArrowElements.forEach((a) => a.classList.remove("selected"));
        selectedArrowElements.length = 0;
        document.body.classList.remove("arrow-selection-mode");
        arrowConnectedElements.forEach((el) => el.classList.remove("arrow-connected"));
        arrowConnectedElements.length = 0;
        selectedArrow = null;
      };
      var clearArrowSelection = clearArrowSelection2;
      timelineSvg.addEventListener("mousedown", (e) => {
        if (e.button !== 2) return;
        const arrow = e.target.closest(".dependency-arrow");
        if (!arrow) return;
        const title = arrow.querySelector("title");
        if (title) title.remove();
      });
      timelineSvg.addEventListener("contextmenu", (e) => {
        const arrow = e.target.closest(".dependency-arrow");
        if (!arrow) return;
        e.preventDefault();
        const relationId = parseInt(arrow.dataset.relationId);
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        const relTypeClass = [...arrow.classList].find((c) => c.startsWith("rel-"));
        const relationType = relTypeClass ? relTypeClass.replace("rel-", "") : null;
        showDeletePicker(e.clientX, e.clientY, relationId, fromId, toId, relationType);
      });
      let selectedArrow = null;
      const selectedArrowElements = [];
      const arrowConnectedElements = [];
      timelineSvg.addEventListener("click", (e) => {
        const arrow = e.target.closest(".dependency-arrow");
        if (selectedArrow) {
          selectedArrow.classList.remove("selected");
          document.body.classList.remove("arrow-selection-mode");
          document.querySelectorAll(".arrow-connected").forEach((el) => el.classList.remove("arrow-connected"));
          selectedArrow = null;
        }
        if (!arrow) return;
        e.stopPropagation();
        selectedArrow = arrow;
        arrow.classList.add("selected");
        selectedArrowElements.push(arrow);
        document.body.classList.add("arrow-selection-mode");
        const fromId = arrow.dataset.from;
        const toId = arrow.dataset.to;
        const connectedBars = mapsReady ? [...issueBarsByIssueId.get(fromId) || [], ...issueBarsByIssueId.get(toId) || []] : document.querySelectorAll(`.issue-bar[data-issue-id="${fromId}"], .issue-bar[data-issue-id="${toId}"]`);
        const connectedLabels = mapsReady ? [...issueLabelsByIssueId.get(fromId) || [], ...issueLabelsByIssueId.get(toId) || []] : document.querySelectorAll(`.issue-label[data-issue-id="${fromId}"], .issue-label[data-issue-id="${toId}"]`);
        connectedBars.forEach((bar) => {
          bar.classList.add("arrow-connected");
          arrowConnectedElements.push(bar);
        });
        connectedLabels.forEach((label) => {
          label.classList.add("arrow-connected");
          arrowConnectedElements.push(label);
        });
        announce(`Selected relation from #${fromId} to #${toId}`);
      });
      if (window._ganttArrowClickHandler) {
        document.removeEventListener("click", window._ganttArrowClickHandler);
      }
      window._ganttArrowClickHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector(".dependency-arrow.selected");
        if (hasSelection && !e.target.closest(".dependency-arrow") && !e.target.closest(".blocks-badge-group") && !e.target.closest(".blocker-badge")) {
          clearArrowSelection2();
        }
      };
      document.addEventListener("click", window._ganttArrowClickHandler);
      if (window._ganttArrowKeyHandler) {
        document.removeEventListener("keydown", window._ganttArrowKeyHandler);
      }
      window._ganttArrowKeyHandler = (e) => {
        const hasSelection = selectedArrow || document.querySelector(".dependency-arrow.selected");
        if (e.key === "Escape" && hasSelection) {
          e.stopImmediatePropagation();
          clearArrowSelection2();
        }
      };
      document.addEventListener("keydown", window._ganttArrowKeyHandler);
    }
    setupDrag({
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
      allIssueBars,
      redmineBaseUrl,
      extendedRelationTypes,
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
      setAllowScrollChange,
      isDraftModeEnabled: () => currentDraftMode,
      isPerfDebugEnabled: () => PERF_DEBUG,
      // Lookup maps for O(1) element access
      getLookupMaps: () => ({ mapsReady, issueBarsByIssueId, issueLabelsByIssueId })
    });
    setupCollapse({
      vscode,
      addDocListener,
      addWinListener,
      announce,
      barHeight,
      selectedCollapseKey
    });
    function scrollToToday() {
      if (!todayInRange) {
        vscode.postMessage({ command: "todayOutOfRange" });
        return;
      }
      if (ganttScroll) {
        const stickyLeft = document.querySelector(".gantt-body .gantt-sticky-left");
        const stickyWidth = stickyLeft?.offsetWidth ?? 0;
        const visibleTimelineWidth = ganttScroll.clientWidth - stickyWidth;
        ganttScroll.scrollLeft = Math.max(0, todayX - visibleTimelineWidth / 2);
      }
    }
    function scrollToAndHighlight(issueId) {
      if (!issueId) return;
      allowScrollChange = true;
      const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
      const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
      if (label) {
        label.scrollIntoView({ behavior: "smooth", block: "center" });
        label.classList.add("highlighted");
        setTimeout(() => label.classList.remove("highlighted"), 1500);
      }
      if (bar && ganttScroll) {
        const barRect = bar.getBoundingClientRect();
        const scrollRect = ganttScroll.getBoundingClientRect();
        const scrollLeft = ganttScroll.scrollLeft + barRect.left - scrollRect.left - 100;
        ganttScroll.scrollTo({ left: Math.max(0, scrollLeft), behavior: "smooth" });
        bar.classList.add("highlighted");
        setTimeout(() => bar.classList.remove("highlighted"), 1500);
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
      scrollToToday
    });
    setupTooltips({
      addDocListener,
      addWinListener,
      ganttScroll
    });
    requestAnimationFrame(() => {
      if (savedCenterDateMs !== null && ganttScroll) {
        const clampedDateMs = Math.max(minDateMs, Math.min(maxDateMs, savedCenterDateMs));
        scrollToCenterDate(clampedDateMs);
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedCenterDateMs = null;
        savedScrollTop = null;
      } else if (savedScrollLeft !== null && ganttScroll) {
        ganttScroll.scrollLeft = savedScrollLeft;
        if (savedScrollTop !== null) {
          ganttScroll.scrollTop = savedScrollTop;
        }
        savedScrollLeft = null;
        savedScrollTop = null;
      } else {
        scrollToToday();
      }
      updateMinimapViewport();
      restoringScroll = false;
    });
    document.getElementById("todayBtn")?.addEventListener("click", scrollToToday);
    const resizeHandle = document.getElementById("resizeHandle");
    const resizeHandleHeader = document.getElementById("resizeHandleHeader");
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;
    let activeResizeHandle = null;
    function startResize(e, handle) {
      isResizing = true;
      activeResizeHandle = handle;
      resizeStartX = e.clientX;
      resizeStartWidth = labelsColumn.offsetWidth;
      handle.classList.add("dragging");
      document.body.classList.add("cursor-col-resize", "user-select-none");
      e.preventDefault();
    }
    resizeHandle?.addEventListener("mousedown", (e) => startResize(e, resizeHandle));
    resizeHandleHeader?.addEventListener("mousedown", (e) => startResize(e, resizeHandleHeader));
    let resizeRafPending = false;
    let lastResizeEvent = null;
    addDocListener("mousemove", (e) => {
      if (!isResizing) return;
      lastResizeEvent = e;
      if (resizeRafPending) return;
      resizeRafPending = true;
      requestAnimationFrame(() => {
        resizeRafPending = false;
        if (!lastResizeEvent) return;
        const delta = lastResizeEvent.clientX - resizeStartX;
        const newWidth = Math.min(600, Math.max(120, resizeStartWidth + delta));
        if (ganttLeftHeader) ganttLeftHeader.style.width = newWidth + "px";
        if (labelsColumn) {
          labelsColumn.style.width = newWidth + "px";
          const labelsSvg2 = labelsColumn.querySelector("svg");
          if (labelsSvg2) labelsSvg2.setAttribute("width", String(newWidth));
        }
        const capacityLabel = document.querySelector(".capacity-ribbon-label");
        if (capacityLabel) {
          capacityLabel.style.width = newWidth + leftExtrasWidth + "px";
        }
        updateMinimapPosition();
      });
    });
    addDocListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        activeResizeHandle?.classList.remove("dragging");
        activeResizeHandle = null;
        document.body.classList.remove("cursor-col-resize", "user-select-none");
        saveState();
      }
    });
    requestAnimationFrame(() => {
      document.getElementById("loadingOverlay")?.classList.remove("visible");
    });
    perfMark("initializeGantt-end");
    perfMeasure("initializeGantt", "initializeGantt-start", "initializeGantt-end");
  }
})();
//# sourceMappingURL=gantt.js.map
