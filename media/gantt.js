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
        minimapDragOffset = viewportWidth / timelineWidth * rect.width / 2;
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

  // src/webviews/gantt-html-escape.ts
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\\/g, "&#92;").replace(/`/g, "&#96;").replace(/\$/g, "&#36;");
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, "&#10;");
  }

  // src/webviews/gantt/arrow-svg.js
  var RELATION_STYLES = {
    blocks: {
      dash: "",
      label: "blocks",
      tip: "Target cannot be closed until source is closed"
    },
    precedes: {
      dash: "",
      label: "precedes",
      tip: "Source must complete before target can start"
    },
    relates: {
      dash: "4,3",
      label: "relates to",
      tip: "Simple link (no constraints)"
    },
    duplicates: {
      dash: "2,2",
      label: "duplicates",
      tip: "Closing target auto-closes source"
    },
    copied_to: {
      dash: "6,2",
      label: "copied to",
      tip: "Source was copied to create target"
    },
    // Extended scheduling types (requires Gantt plugin)
    finish_to_start: {
      dash: "4,2",
      label: "FS",
      tip: "Finish-to-Start: Target starts after source finishes"
    },
    start_to_start: {
      dash: "4,2",
      label: "SS",
      tip: "Start-to-Start: Target starts when source starts"
    },
    finish_to_finish: {
      dash: "4,2",
      label: "FF",
      tip: "Finish-to-Finish: Target finishes when source finishes"
    },
    start_to_finish: {
      dash: "2,4",
      label: "SF",
      tip: "Start-to-Finish: Target finishes when source starts"
    }
  };
  var SCHEDULING_TYPES = ["blocks", "precedes", "finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"];
  function computeArrowGeometry(source, target, relType, barHeight) {
    const arrowSize = 4;
    const sameRow = Math.abs(source.y - target.y) < 5;
    const snapGutter = (y) => Math.round(y / barHeight) * barHeight;
    const isScheduling = SCHEDULING_TYPES.includes(relType);
    const fromStart = relType === "start_to_start" || relType === "start_to_finish";
    const toEnd = relType === "finish_to_finish" || relType === "start_to_finish";
    let x1, y1, x2, y2;
    let path = "";
    const r = 4;
    if (!isScheduling) {
      const centerX1 = (source.startX + source.endX) / 2;
      const centerX2 = (target.startX + target.endX) / 2;
      const goingDown = target.y > source.y;
      const sameRowCenter = Math.abs(source.y - target.y) < 5;
      const centersAligned = Math.abs(centerX1 - centerX2) < 5;
      if (sameRowCenter) {
        x1 = centerX1;
        y1 = source.y - barHeight / 2;
        x2 = centerX2;
        y2 = target.y - barHeight / 2;
        const routeY = y1 - 8;
        path = `M ${x1} ${y1} V ${routeY + r} q 0 ${-r} ${x2 > x1 ? r : -r} ${-r} H ${x2 + (x2 > x1 ? -r : r)} q ${x2 > x1 ? r : -r} 0 ${x2 > x1 ? r : -r} ${r} V ${y2}`;
      } else if (centersAligned) {
        x1 = centerX1;
        y1 = goingDown ? source.y + barHeight / 2 : source.y - barHeight / 2;
        x2 = centerX1;
        y2 = goingDown ? target.y - barHeight / 2 : target.y + barHeight / 2;
        path = `M ${x1} ${y1} V ${y2}`;
      } else {
        x1 = centerX1;
        y1 = goingDown ? source.y + barHeight / 2 : source.y - barHeight / 2;
        x2 = centerX2;
        y2 = goingDown ? target.y - barHeight / 2 : target.y + barHeight / 2;
        const rawMidY = (source.y + target.y) / 2;
        const snappedMidY = snapGutter(rawMidY);
        const midY = Math.abs(snappedMidY - y1) < 2 * r || Math.abs(snappedMidY - y2) < 2 * r ? rawMidY : snappedMidY;
        path = `M ${x1} ${y1} V ${midY + (goingDown ? -r : r)} q 0 ${goingDown ? r : -r} ${x2 > x1 ? r : -r} ${goingDown ? r : -r} H ${x2 + (x2 > x1 ? -r : r)} q ${x2 > x1 ? r : -r} 0 ${x2 > x1 ? r : -r} ${goingDown ? r : -r} V ${y2}`;
      }
    } else {
      x1 = fromStart ? source.startX - 2 : source.endX + 2;
      y1 = source.y;
      x2 = toEnd ? target.endX + 2 : target.startX - 2;
      y2 = target.y;
    }
    const goingRight = x2 > x1;
    const jogDir = fromStart ? -1 : 1;
    const approachDir = toEnd ? 1 : -1;
    const arrivalX = -approachDir;
    let verticalArrival = false;
    let verticalArrivalY = 0;
    if (!isScheduling) {
    } else if (sameRow && goingRight) {
      path = `M ${x1} ${y1} H ${x2}`;
    } else if (sameRow && !goingRight) {
      const routeY = y1 - barHeight;
      path = `M ${x1} ${y1} V ${routeY + r} q 0 ${-r} ${jogDir * -r} ${-r} H ${x2 + approachDir * 12 - approachDir * r} q ${approachDir * -r} 0 ${approachDir * -r} ${r} V ${y2} H ${x2}`;
    } else {
      const jogX = 8;
      const goingDown = y2 > y1;
      const vdir = goingDown ? 1 : -1;
      const gutterY = y2 - vdir * (barHeight / 2);
      const ex = x1 + jogDir * jogX;
      const ax = x2 + approachDir * jogX;
      if (Math.abs(ax - ex) < 2 * r + 2) {
        verticalArrival = true;
        verticalArrivalY = y2 - vdir * (barHeight / 2 - 2);
        if (Math.abs(x2 - x1) < r + 2) {
          path = `M ${x2} ${y1} V ${verticalArrivalY}`;
        } else {
          const dH1 = x2 > x1 ? 1 : -1;
          path = `M ${x1} ${y1} H ${x2 - dH1 * r} q ${dH1 * r} 0 ${dH1 * r} ${vdir * r} V ${verticalArrivalY}`;
        }
      } else {
        const hdir = ax > ex ? 1 : -1;
        path = `M ${x1} ${y1} H ${ex - jogDir * r} q ${jogDir * r} 0 ${jogDir * r} ${vdir * r} V ${gutterY - vdir * r} q 0 ${vdir * r} ${hdir * r} ${vdir * r} H ${ax - hdir * r} q ${hdir * r} 0 ${hdir * r} ${vdir * r} V ${y2 - vdir * r} q 0 ${vdir * r} ${-approachDir * r} ${vdir * r} H ${x2}`;
      }
    }
    let arrowHead;
    if (!isScheduling) {
      const goingDown = target.y > source.y;
      const sameRowCenter = Math.abs(source.y - target.y) < 5;
      if (sameRowCenter) {
        arrowHead = `M ${x2 - arrowSize * 0.6} ${y2 - arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 - arrowSize}`;
      } else {
        arrowHead = goingDown ? `M ${x2 - arrowSize * 0.6} ${y2 - arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 - arrowSize}` : `M ${x2 - arrowSize * 0.6} ${y2 + arrowSize} L ${x2} ${y2} L ${x2 + arrowSize * 0.6} ${y2 + arrowSize}`;
      }
    } else {
      if (verticalArrival) {
        const goingDown = target.y > source.y;
        arrowHead = goingDown ? `M ${x2 - arrowSize * 0.6} ${verticalArrivalY - arrowSize} L ${x2} ${verticalArrivalY} L ${x2 + arrowSize * 0.6} ${verticalArrivalY - arrowSize}` : `M ${x2 - arrowSize * 0.6} ${verticalArrivalY + arrowSize} L ${x2} ${verticalArrivalY} L ${x2 + arrowSize * 0.6} ${verticalArrivalY + arrowSize}`;
      } else {
        arrowHead = arrivalX > 0 ? `M ${x2 - arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 - arrowSize} ${y2 + arrowSize * 0.6}` : `M ${x2 + arrowSize} ${y2 - arrowSize * 0.6} L ${x2} ${y2} L ${x2 + arrowSize} ${y2 + arrowSize * 0.6}`;
      }
    }
    return { path, arrowHead, isScheduling };
  }
  function buildArrowSvg(source, target, rel, barHeight) {
    const style = RELATION_STYLES[rel.type] || RELATION_STYLES.relates;
    const { path, arrowHead, isScheduling } = computeArrowGeometry(source, target, rel.type, barHeight);
    const dashAttr = style.dash ? `stroke-dasharray="${style.dash}"` : "";
    const arrowTooltip = `#${rel.fromId} ${style.label} #${rel.toId}
${style.tip}
(right-click to delete)`;
    const healthClass = isScheduling ? rel.risk ? " arrow-risk" : " arrow-ok" : "";
    return {
      svg: `
            <g class="dependency-arrow rel-${rel.type}${healthClass} cursor-pointer" data-relation-id="${rel.relationId}" data-from="${rel.fromId}" data-to="${rel.toId}">
              <title>${escapeAttr(arrowTooltip)}</title>
              <!-- Wide invisible hit area for easier clicking -->
              <path class="arrow-hit-area" d="${path}" stroke="transparent" stroke-width="24" fill="none"/>
              <path class="arrow-line" d="${path}" stroke-width="2" fill="none" ${dashAttr}/>
              <path class="arrow-head" d="${arrowHead}" fill="none"/>
            </g>
          `,
      hasDash: !!style.dash
    };
  }
  function buildArrowsMarkup(arrows, getPosition, barHeight) {
    return arrows.map((rel) => {
      const source = getPosition(rel.fromId);
      const target = getPosition(rel.toId);
      if (!source || !target) return null;
      return buildArrowSvg(source, target, rel, barHeight);
    }).filter((item) => item !== null).sort((a, b) => a.hasDash === b.hasDash ? 0 : a.hasDash ? 1 : -1).map((item) => item.svg).join("");
  }

  // src/webviews/gantt/selection-utils.js
  function parseTranslateY(transform, fallback) {
    const match = /translate\([^,]+,\s*([-\d.]+)/.exec(transform || "");
    return match ? parseFloat(match[1]) : fallback;
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
      pinHighlight,
      isDraftModeEnabled,
      lookupMaps,
      rowWindow: rowWindow2
    } = ctx;
    let highlightedArrows = [];
    let highlightedConnected = [];
    rowWindow2?.onRefresh(({ layersRebuilt } = {}) => {
      if (!layersRebuilt || highlightedArrows.length === 0) return;
      highlightedArrows.forEach((a) => a.classList.remove("selected"));
      highlightedArrows = [];
      highlightedConnected.forEach((el) => el.classList.remove("arrow-connected"));
      highlightedConnected = [];
      if (!document.querySelector(".dependency-arrow.selected")) {
        document.body.classList.remove("arrow-selection-mode");
      }
    });
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
            const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            const html = '<a href="' + esc(url) + '">#' + issueId + " " + esc(subject) + "</a>";
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
    function barCenterY(bar) {
      const transformY = parseTranslateY(bar.getAttribute("transform"), NaN);
      return Number.isNaN(transformY) ? parseFloat(bar.dataset.centerY) : transformY + barHeight / 2;
    }
    function getConnectedArrows(issueId) {
      const selector = '.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]';
      return collectArrows(selector);
    }
    function collectArrows(selector) {
      const arrows = [];
      let localBars = null;
      const barFor = (id) => {
        if (lookupMaps?.isReady()) return lookupMaps.getIssueBars(id)[0] ?? null;
        if (!localBars) {
          localBars = /* @__PURE__ */ new Map();
          document.querySelectorAll(".issue-bar").forEach((b) => {
            const bid = b.dataset.issueId;
            if (bid && !localBars.has(bid)) localBars.set(bid, b);
          });
        }
        return localBars.get(id) ?? null;
      };
      const stubFor = (id) => {
        const meta = rowWindow2?.getRowMetaByIssueId(id);
        if (!meta || meta.barStartX === null || meta.barEndX === null) return null;
        const y = rowWindow2.getVirtualY(meta.key);
        if (y === null) return null;
        return {
          dataset: { startX: String(meta.barStartX), endX: String(meta.barEndX) },
          getAttribute: () => `translate(0, ${y})`
        };
      };
      document.querySelectorAll(selector).forEach((arrow) => {
        const fromId = arrow.getAttribute("data-from");
        const toId = arrow.getAttribute("data-to");
        const classList = arrow.getAttribute("class") || "";
        const relMatch = classList.match(/rel-(\w+)/);
        const relType = relMatch ? relMatch[1] : "relates";
        const fromBar = barFor(fromId) ?? stubFor(fromId);
        const toBar = barFor(toId) ?? stubFor(toId);
        if (!fromBar || !toBar) return;
        arrows.push({
          element: arrow,
          fromId,
          toId,
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
        const fromStartX = a.fromId == draggedIssueId ? newStartX : parseFloat(a.fromBar.dataset.startX);
        const fromEndX = a.fromId == draggedIssueId ? newEndX : parseFloat(a.fromBar.dataset.endX);
        const fromY = barCenterY(a.fromBar);
        const toStartX = a.toId == draggedIssueId ? newStartX : parseFloat(a.toBar.dataset.startX);
        const toEndX = a.toId == draggedIssueId ? newEndX : parseFloat(a.toBar.dataset.endX);
        const toY = barCenterY(a.toBar);
        const { path, arrowHead } = computeArrowGeometry(
          { startX: fromStartX, endX: fromEndX, y: fromY },
          { startX: toStartX, endX: toEndX, y: toY },
          a.relType,
          barHeight
        );
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
    addDocListener("mousedown", (e) => {
      const handle = e.target.closest(".drag-handle");
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();
      dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
      {
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
        ctx.pinRow?.(bar.dataset.collapseKey);
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
        const currentDate = isLeft ? oldStartDate : oldDueDate;
        if (currentDate) {
          showDragTooltip((isLeft ? "Start: " : "Due: ") + formatDateShort(currentDate));
          positionDragTooltip(e.clientX, e.clientY);
        }
      }
    });
    addDocListener("mousedown", (e) => {
      if (e.target.closest(".drag-handle")) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      const outline = e.target.closest(".bar-outline");
      if (!outline) return;
      e.preventDefault();
      e.stopPropagation();
      dragScrollSnapshot = { left: ganttScroll?.scrollLeft, top: ganttScroll?.scrollTop };
      {
        const bar = outline.closest(".issue-bar");
        if (!bar) return;
        if (bar.classList.contains("parent-bar")) return;
        const issueId = bar.dataset.issueId;
        const isBulkDrag = selectedIssues.size > 1 && selectedIssues.has(issueId);
        if (isBulkDrag) {
          const keys = [];
          selectedIssues.forEach((id) => {
            const meta = rowWindow2?.getRowMetaByIssueId(id);
            if (meta) keys.push(meta.key);
          });
          ctx.pinRows?.(keys);
        }
        const barsToMove = isBulkDrag ? Array.from(document.querySelectorAll(".issue-bar")).filter((b) => selectedIssues.has(b.dataset.issueId)) : [bar];
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
        if (isBulkDrag) {
          const mountedIds = new Set(barsToMove.map((b) => b.dataset.issueId));
          selectedIssues.forEach((id) => {
            if (mountedIds.has(id)) return;
            const meta = rowWindow2?.getRowMetaByIssueId(id);
            if (!meta || meta.barStartX === null || meta.barEndX === null) return;
            bulkBars.push({
              issueId: id,
              startX: meta.barStartX,
              endX: meta.barEndX,
              oldStartDate: meta.startDate || null,
              oldDueDate: meta.dueDate || null,
              barOutline: null,
              barMain: null,
              leftHandle: null,
              rightHandle: null,
              leftGripCircles: [],
              rightGripCircles: [],
              leftHandleRect: null,
              rightHandleRect: null,
              bar: null,
              barLabels: null,
              labelsOnLeft: false,
              connectedArrows: [],
              linkHandle: null,
              linkHandleCircles: []
            });
          });
        }
        bulkBars.forEach((b) => b.bar?.classList.add("dragging"));
        const singleBarLabels = bar.querySelector(".bar-labels");
        const singleLabelsOnLeft = singleBarLabels?.classList.contains("labels-left");
        const connectedArrows = getConnectedArrows(issueId);
        const singleLinkHandle = bar.querySelector(".link-handle");
        const singleLeftHandle = bar.querySelector(".drag-left");
        const singleRightHandle = bar.querySelector(".drag-right");
        ctx.pinRow?.(bar.dataset.collapseKey);
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
      }
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
      const types = baseTypes;
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
    addDocListener("click", (e) => {
      if (e.target.closest(interactiveSelector)) return;
      const bar = e.target.closest(".issue-bar");
      if (!bar) return;
      if (dragState || linkingState || justEndedDrag) return;
      if (getFocusedIssueId()) {
        clearFocus();
      }
      pinHighlight(bar.dataset.issueId);
    });
    addDocListener("dblclick", (e) => {
      const bar = e.target.closest(".issue-bar");
      if (!bar) return;
      if (dragState || linkingState || justEndedDrag) return;
      e.preventDefault();
      focusOnDependencyChain(bar.dataset.issueId);
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
      connectedIds.forEach((id) => {
        if (lookupMaps?.isReady()) {
          lookupMaps.getIssueBars(id).forEach((el) => {
            el.classList.add("arrow-connected");
            highlightedConnected.push(el);
          });
          lookupMaps.getIssueLabels(id).forEach((el) => {
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
    addDocListener("mousedown", (e) => {
      if (!e.target.closest(".blocks-badge-group, .blocker-badge")) return;
      e.preventDefault();
      e.stopPropagation();
    });
    addDocListener("click", (e) => {
      const badge = e.target.closest(".blocks-badge-group, .blocker-badge");
      if (!badge) return;
      e.preventDefault();
      e.stopPropagation();
      const issueBar = badge.closest(".issue-bar");
      if (!issueBar) return;
      const issueId = issueBar.dataset.issueId;
      const attr = badge.classList.contains("blocks-badge-group") ? "data-from" : "data-to";
      const arrows = Array.from(document.querySelectorAll(`.dependency-arrow[${attr}="${issueId}"]`));
      highlightArrows(arrows, issueId);
    });
    const PAGE_JUMP = 10;
    function focusBarByIssueId(issueId, prefix) {
      const meta = rowWindow2?.getRowMetaByIssueId(issueId);
      if (meta) rowWindow2.scrollToKey(meta.key);
      const target = document.querySelector(`.issue-bar[data-issue-id="${issueId}"]`);
      if (!target) return;
      target.focus();
      announce(`${prefix}${target.getAttribute("aria-label")}`);
    }
    addDocListener("keydown", (e) => {
      const bar = e.target.closest?.(".issue-bar");
      if (!bar) return;
      const issueId = bar.dataset.issueId;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        scrollToAndHighlight(issueId);
        return;
      }
      if (e.key === "Tab" && e.shiftKey) {
        const label = document.querySelector(`.issue-label[data-issue-id="${issueId}"]`);
        if (label) {
          e.preventDefault();
          label.focus();
          announce(`Label for issue #${issueId}`);
        }
        return;
      }
      const issueIds = (rowWindow2?.getVisibleList() ?? []).filter((r) => r.issueId !== null && r.issueId !== void 0).map((r) => String(r.issueId));
      const index = issueIds.indexOf(issueId);
      if (index === -1) return;
      let nextIdx = null;
      let prefix = "Issue ";
      if (e.key === "ArrowDown" && index < issueIds.length - 1) {
        nextIdx = index + 1;
      } else if (e.key === "ArrowUp" && index > 0) {
        nextIdx = index - 1;
      } else if (e.key === "Home") {
        nextIdx = 0;
        prefix = "First issue: ";
      } else if (e.key === "End") {
        nextIdx = issueIds.length - 1;
        prefix = "Last issue: ";
      } else if (e.key === "PageDown") {
        nextIdx = Math.min(index + PAGE_JUMP, issueIds.length - 1);
      } else if (e.key === "PageUp") {
        nextIdx = Math.max(index - PAGE_JUMP, 0);
      }
      if (nextIdx === null) return;
      e.preventDefault();
      focusBarByIssueId(issueIds[nextIdx], prefix);
    });
    addDocListener("mousedown", (e) => {
      const handle = e.target.closest(".link-handle");
      if (!handle) return;
      {
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
      }
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
              if (b.barOutline) {
                b.barOutline.setAttribute("x", newStartX);
                b.barOutline.setAttribute("width", width);
              }
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
            const leftRect = dragState.leftHandle?.querySelector("rect");
            const rightRect = dragState.rightHandle?.querySelector("rect");
            if (leftRect) leftRect.setAttribute("x", newStartX);
            if (rightRect) rightRect.setAttribute("x", newEndX - 14);
            (dragState.leftGripCircles || []).forEach((c) => c.setAttribute("cx", newStartX + 9));
            (dragState.rightGripCircles || []).forEach((c) => c.setAttribute("cx", newEndX - 9));
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
          bulkBars.forEach((b) => b.bar?.classList.remove("dragging"));
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
          ctx.unpinRow?.();
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
        ctx.unpinRow?.();
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
            relationType: action.relationType,
            delay: action.delay
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
            relationType: action.relationType,
            delay: action.delay
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

  // src/webviews/gantt/gantt-row-interaction.js
  function setupRowInteraction(ctx) {
    const { vscode: vscode2, addDocListener, addWinListener, announce, barHeight, selectedCollapseKey, allExpandableKeys, rowWindow: rowWindow2, perfLog: perfLog2 = () => {
    } } = ctx;
    const scrollEl = document.getElementById("ganttScroll");
    if (!scrollEl || !rowWindow2) return;
    function setAllExpanded(keys, label) {
      const t0 = performance.now();
      rowWindow2.setAllExpanded(keys);
      vscode2.postMessage({ command: "collapseStateSyncBulk", expandedKeys: keys });
      perfLog2(`${label}: ${(performance.now() - t0).toFixed(1)}ms windowed (${keys.length} expanded)`);
    }
    document.getElementById("menuExpand")?.addEventListener("click", () => {
      setAllExpanded(allExpandableKeys ?? [], "expand-all");
    });
    document.getElementById("menuCollapse")?.addEventListener("click", () => {
      setAllExpanded([], "collapse-all");
    });
    function toggleCollapseClientSide(collapseKey, action) {
      const meta = rowWindow2.getRowMeta(collapseKey);
      if (!meta || !meta.hasChildren) return;
      const wasExpanded = rowWindow2.isExpanded(collapseKey);
      const shouldExpand = action === "expand" ? true : action === "collapse" ? false : !wasExpanded;
      if (shouldExpand === wasExpanded) return;
      const t0 = performance.now();
      rowWindow2.setExpanded(collapseKey, shouldExpand);
      vscode2.postMessage({ command: "collapseStateSync", collapseKey, isExpanded: shouldExpand });
      updateRowSelectionOverlays();
      perfLog2(`toggle ${collapseKey} ${shouldExpand ? "expand" : "collapse"}: ${(performance.now() - t0).toFixed(1)}ms windowed`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        perfLog2(`toggle ${collapseKey}: frame painted ${(performance.now() - t0).toFixed(1)}ms after click`);
      }));
    }
    let activeKey = null;
    let activeEl = null;
    const LABEL_SELECTOR = ".project-label, .issue-label, .time-group-label";
    function setActiveKey(key, { notify = true, focus = true, scroll = false } = {}) {
      if (activeEl) activeEl.classList.remove("active");
      activeKey = key;
      if (scroll && key) rowWindow2.scrollToKey(key);
      const el = key ? rowWindow2.getLabelElement(key) : null;
      activeEl = el;
      if (el) {
        el.classList.add("active");
        if (focus) el.focus({ preventScroll: true });
      }
      if (notify) {
        vscode2.postMessage({ command: "setSelectedKey", collapseKey: key ?? null });
      }
      updateRowSelectionOverlays();
    }
    const SVG_NS2 = "http://www.w3.org/2000/svg";
    const selectionOverlays = [];
    rowWindow2.getBodySvgs().forEach((svg) => {
      const rect = document.createElementNS(SVG_NS2, "rect");
      rect.setAttribute("class", "row-selection-overlay");
      rect.setAttribute("x", "0");
      rect.setAttribute("width", "100%");
      rect.setAttribute("height", String(barHeight + 2));
      rect.setAttribute("visibility", "hidden");
      svg.insertBefore(rect, svg.firstChild);
      selectionOverlays.push(rect);
    });
    const hoverOverlays = [];
    rowWindow2.getBodySvgs().forEach((svg) => {
      const rect = document.createElementNS(SVG_NS2, "rect");
      rect.setAttribute("class", "row-hover-overlay");
      rect.setAttribute("x", "0");
      rect.setAttribute("width", "100%");
      rect.setAttribute("height", String(barHeight + 2));
      rect.setAttribute("visibility", "hidden");
      rect.setAttribute("pointer-events", "none");
      svg.insertBefore(rect, svg.firstChild);
      hoverOverlays.push(rect);
    });
    let hoverRowY = null;
    function setHoverRowY(y) {
      if (y === hoverRowY) return;
      hoverRowY = y;
      if (y === null) {
        hoverOverlays.forEach((r) => r.setAttribute("visibility", "hidden"));
      } else {
        hoverOverlays.forEach((r) => {
          r.setAttribute("y", String(y - 1));
          r.setAttribute("visibility", "visible");
        });
      }
    }
    let hoverBodyTop = null;
    const invalidateHoverTop = () => {
      hoverBodyTop = null;
    };
    addDocListener("mousemove", (e) => {
      const body = e.target.closest && e.target.closest(".gantt-body");
      if (!body) {
        setHoverRowY(null);
        return;
      }
      if (hoverBodyTop === null) hoverBodyTop = body.getBoundingClientRect().top;
      const index = Math.floor((e.clientY - hoverBodyTop) / barHeight);
      const y = index * barHeight;
      if (y === hoverRowY) return;
      setHoverRowY(rowWindow2.keyAtIndex(index) ? y : null);
    });
    addDocListener("mouseleave", () => setHoverRowY(null));
    addWinListener("blur", () => setHoverRowY(null));
    addWinListener("resize", invalidateHoverTop);
    addDocListener("scroll", () => {
      invalidateHoverTop();
      setHoverRowY(null);
    }, { capture: true });
    rowWindow2.onRefresh(() => {
      invalidateHoverTop();
      setHoverRowY(null);
    });
    function updateRowSelectionOverlays() {
      const y = activeKey ? rowWindow2.getVirtualY(activeKey) : null;
      if (y === null) {
        selectionOverlays.forEach((rect) => rect.setAttribute("visibility", "hidden"));
        return;
      }
      selectionOverlays.forEach((rect) => {
        rect.setAttribute("y", String(y - 1));
        rect.setAttribute("visibility", "visible");
      });
    }
    rowWindow2.onRefresh(() => {
      if (!activeKey) return;
      const el = rowWindow2.getLabelElement(activeKey);
      if (el && el !== activeEl) {
        if (activeEl) activeEl.classList.remove("active");
        el.classList.add("active");
        activeEl = el;
      }
      if (el && (document.activeElement === document.body || document.activeElement === document.documentElement)) {
        el.focus({ preventScroll: true });
      }
      updateRowSelectionOverlays();
    });
    addWinListener("focus", () => {
      const el = activeKey ? rowWindow2.getLabelElement(activeKey) : null;
      if (el) el.focus({ preventScroll: true });
    });
    addDocListener("keydown", (e) => {
      if (e.key === "Escape" && activeKey) {
        const el = rowWindow2.getLabelElement(activeKey);
        if (el) el.blur();
        setActiveKey(null);
      }
    });
    scrollEl.addEventListener("click", (e) => {
      if (e.target.closest(".collapse-toggle, .chevron-hit-area")) {
        const label2 = e.target.closest("[data-collapse-key]");
        if (label2?.dataset.collapseKey) {
          e.stopPropagation();
          toggleCollapseClientSide(label2.dataset.collapseKey);
        }
        return;
      }
      const label = e.target.closest(LABEL_SELECTOR);
      if (!label) return;
      const key = label.dataset.collapseKey;
      const issueId = label.dataset.issueId;
      const isProjectish = label.classList.contains("project-label") || label.classList.contains("time-group-label");
      const clickedOnText = e.target.classList?.contains("issue-text") || e.target.closest(".issue-text");
      setActiveKey(key);
      if (isProjectish && label.dataset.hasChildren === "true") {
        toggleCollapseClientSide(key);
      } else if (issueId && !clickedOnText && label.dataset.hasChildren === "true") {
        toggleCollapseClientSide(key);
      }
    });
    scrollEl.addEventListener("dblclick", (e) => {
      if (e.target.closest(".collapse-toggle, .chevron-hit-area")) return;
      const label = e.target.closest(".issue-label");
      const issueId = label?.dataset.issueId;
      const clickedOnText = e.target.classList?.contains("issue-text") || e.target.closest(".issue-text");
      if (issueId && clickedOnText) {
        e.preventDefault();
        vscode2.postMessage({ command: "openIssue", issueId: parseInt(issueId, 10) });
      }
    });
    function focusKey(key) {
      if (!key) return;
      setActiveKey(key, { scroll: true });
    }
    function nearestVisibleAncestorIndex(fromKey) {
      let key = rowWindow2.getRowMeta(fromKey)?.parentKey;
      let hops = 0;
      while (key && hops < 100) {
        const idx = rowWindow2.visibleIndexOf(key);
        if (idx >= 0) return idx;
        key = rowWindow2.getRowMeta(key)?.parentKey;
        hops++;
      }
      return -1;
    }
    function navRelative(fromKey, delta) {
      const list = rowWindow2.getVisibleList();
      if (list.length === 0) return null;
      let idx = rowWindow2.visibleIndexOf(fromKey);
      if (idx < 0) {
        const anchor = nearestVisibleAncestorIndex(fromKey);
        if (anchor < 0) {
          return (delta > 0 ? list[0] : list[list.length - 1])?.key ?? null;
        }
        const target2 = delta < 0 ? Math.max(0, anchor + delta + 1) : Math.min(list.length - 1, anchor + delta);
        return list[target2]?.key ?? null;
      }
      const target = Math.max(0, Math.min(list.length - 1, idx + delta));
      return list[target]?.key ?? null;
    }
    function handleNavKeydown(e, key) {
      const meta = key ? rowWindow2.getRowMeta(key) : null;
      const hasChildren = !!meta?.hasChildren;
      const expanded = key ? rowWindow2.isExpanded(key) : false;
      const issueId = meta?.issueId ?? null;
      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          if (issueId !== null) {
            vscode2.postMessage({ command: "openIssue", issueId });
          }
          return true;
        case "ArrowDown":
          e.preventDefault();
          focusKey(navRelative(key, 1));
          return true;
        case "ArrowUp":
          e.preventDefault();
          focusKey(navRelative(key, -1));
          return true;
        case "Home":
          e.preventDefault();
          focusKey(rowWindow2.keyAtIndex(0));
          return true;
        case "End":
          e.preventDefault();
          focusKey(rowWindow2.keyAtIndex(rowWindow2.getVisibleList().length - 1));
          return true;
        case "PageDown":
          e.preventDefault();
          focusKey(navRelative(key, 10));
          return true;
        case "PageUp":
          e.preventDefault();
          focusKey(navRelative(key, -10));
          return true;
        case "ArrowLeft":
          e.preventDefault();
          if (hasChildren && expanded) {
            toggleCollapseClientSide(key, "collapse");
          } else if (meta?.parentKey) {
            focusKey(meta.parentKey);
          }
          return true;
        case "ArrowRight":
          e.preventDefault();
          if (hasChildren && !expanded) {
            toggleCollapseClientSide(key, "expand");
          } else if (hasChildren && expanded) {
            const idx = rowWindow2.visibleIndexOf(key);
            const next = rowWindow2.keyAtIndex(idx + 1);
            const nextMeta = next ? rowWindow2.getRowMeta(next) : null;
            if (nextMeta && nextMeta.parentKey === key) focusKey(next);
          }
          return true;
        case "Tab":
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
    scrollEl.addEventListener("keydown", (e) => {
      const label = e.target.closest?.(LABEL_SELECTOR);
      if (!label) return;
      handleNavKeydown(e, label.dataset.collapseKey);
    });
    const DOC_NAV_KEYS = /* @__PURE__ */ new Set([
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ]);
    addDocListener("keydown", (e) => {
      if (e.defaultPrevented || !activeKey) return;
      if (!DOC_NAV_KEYS.has(e.key)) return;
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (document.activeElement?.closest?.(".issue-bar")) return;
      if (e.target.closest?.(LABEL_SELECTOR)) return;
      handleNavKeydown(e, activeKey);
    });
    const onGhostPointer = (e) => {
      if (!e.target.closest?.(".ghost-projection")) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.type !== "mousedown") return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      const key = e.target.closest(".gantt-row[data-collapse-key]")?.dataset.collapseKey ?? e.target.closest(".issue-bar")?.dataset.collapseKey;
      if (key) setActiveKey(key, { focus: false });
    };
    ["mousedown", "click", "dblclick"].forEach(
      (type) => addDocListener(type, onGhostPointer, { capture: true })
    );
    addDocListener("mousedown", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!e.target.closest("#ganttScroll")) return;
      if (e.target.closest(".collapse-toggle, .chevron-hit-area, .drag-handle, .link-handle, .blocks-badge-group, .blocker-badge, .progress-badge-group, .flex-badge-group, button, input, select")) {
        return;
      }
      const row = e.target.closest(".gantt-row[data-collapse-key]");
      if (row && row.matches(LABEL_SELECTOR)) return;
      let key = row?.dataset.collapseKey || null;
      if (!key) {
        const timeline = e.target.closest(".gantt-timeline");
        if (!timeline) return;
        const svg = timeline.querySelector("svg");
        if (!svg) return;
        const contentY = e.clientY - svg.getBoundingClientRect().top;
        key = rowWindow2.keyAtIndex(Math.floor(contentY / barHeight));
        if (!key) return;
      }
      setActiveKey(key);
    });
    if (selectedCollapseKey && rowWindow2.getRowMeta(selectedCollapseKey)) {
      setActiveKey(selectedCollapseKey, { notify: false, focus: false });
    }
  }

  // src/webviews/gantt/lookup-maps.js
  function createLookupMaps() {
    const issueBarsByIssueId = /* @__PURE__ */ new Map();
    const issueLabelsByIssueId = /* @__PURE__ */ new Map();
    const arrowsByIssueId = /* @__PURE__ */ new Map();
    const projectLabelsByKey = /* @__PURE__ */ new Map();
    const aggregateBarsByKey = /* @__PURE__ */ new Map();
    let ready = false;
    function rebuild() {
      issueBarsByIssueId.clear();
      issueLabelsByIssueId.clear();
      arrowsByIssueId.clear();
      projectLabelsByKey.clear();
      aggregateBarsByKey.clear();
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
      ready = true;
    }
    return {
      isReady: () => ready,
      rebuild,
      rebuildIfReady: () => {
        if (ready) rebuild();
      },
      getIssueBars: (id) => issueBarsByIssueId.get(id) || [],
      getIssueLabels: (id) => issueLabelsByIssueId.get(id) || [],
      getArrows: (id) => arrowsByIssueId.get(id) || [],
      getProjectLabels: (key) => projectLabelsByKey.get(key) || [],
      getAggregateBars: (key) => aggregateBarsByKey.get(key) || []
    };
  }

  // src/webviews/gantt/gantt-keyboard.js
  function setupKeyboard(ctx) {
    const { vscode: vscode2, addDocListener, menuUndo, menuRedo, undoStack, redoStack, saveState, updateUndoRedoButtons, announce, scrollToAndHighlight, scrollToToday, rowWindow: rowWindow2 } = ctx;
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
      } else if (e.key >= "1" && e.key <= "5" && !modKey && !e.altKey) {
        const zoomSelect = document.getElementById("zoomSelect");
        if (zoomSelect) {
          const levels = ["day", "week", "month", "quarter", "year"];
          zoomSelect.value = levels[parseInt(e.key) - 1];
          zoomSelect.dispatchEvent(new Event("change"));
        }
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
          const pad = (n) => String(n).padStart(2, "0");
          return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
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
      const searchRows = (rowWindow2?.getVisibleList() ?? []).filter((r) => r.issueId !== null && r.issueId !== void 0).map((r) => ({ key: r.key, issueId: String(r.issueId), text: "open issue #" + r.issueId }));
      let matchedRows = [];
      let searchTimeout = null;
      input.addEventListener("input", () => {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const query = input.value.toLowerCase();
          matchedRows = query ? searchRows.filter((r) => r.text.includes(query)) : [];
          const matchedIds = new Set(matchedRows.map((r) => r.issueId));
          document.querySelectorAll(".issue-label").forEach((el) => {
            el.classList.toggle("search-match", matchedIds.has(el.dataset.issueId));
          });
        }, 50);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeQuickSearch();
        } else if (e.key === "Enter") {
          const match = matchedRows[0];
          if (match) {
            closeQuickSearch();
            rowWindow2?.scrollToKey(match.key);
            document.querySelector(`.issue-label[data-issue-id="${match.issueId}"]`)?.focus({ preventScroll: true });
            scrollToAndHighlight(match.issueId);
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

  // src/webviews/gantt/row-window-utils.js
  function computeVisibleList(rows, expandedSet) {
    const visibleByKey = /* @__PURE__ */ new Map();
    const out = [];
    for (const row of rows) {
      const p = row.parentKey;
      const isVisible = !p || !visibleByKey.has(p) ? true : visibleByKey.get(p) && expandedSet.has(p);
      visibleByKey.set(row.key, isVisible);
      if (isVisible) out.push(row);
    }
    return out;
  }
  function computeMountRange(scrollTop, viewportHeight, barHeight, totalRows, buffer) {
    if (totalRows <= 0) return { first: 0, last: -1 };
    const first = Math.max(0, Math.floor(scrollTop / barHeight) - buffer);
    const last = Math.min(
      totalRows - 1,
      Math.ceil((scrollTop + viewportHeight) / barHeight) + buffer
    );
    return { first, last };
  }
  function computeZebraBands(visibleList, useTopLevelGrouping) {
    if (visibleList.length === 0) return [];
    let isBoundary;
    if (useTopLevelGrouping) {
      isBoundary = (row) => row.depth === 0;
    } else {
      const issueDepths = visibleList.filter((r) => r.type === "issue").map((r) => r.depth);
      const minIssueDepth = issueDepths.length > 0 ? Math.min(...issueDepths) : Infinity;
      isBoundary = (row) => row.type === "issue" && row.depth === minIssueDepth;
    }
    const bands = [];
    let start = 0;
    for (let i = 1; i < visibleList.length; i++) {
      if (isBoundary(visibleList[i])) {
        bands.push({ startIdx: start, endIdx: i - 1, bandIdx: bands.length });
        start = i;
      }
    }
    bands.push({ startIdx: start, endIdx: visibleList.length - 1, bandIdx: bands.length });
    return bands;
  }
  function computeIndentSpans(visibleList) {
    const spans = [];
    for (let i = 0; i < visibleList.length; i++) {
      const rowItem = visibleList[i];
      if (!rowItem.hasChildren) continue;
      let end = i;
      for (let j = i + 1; j < visibleList.length && visibleList[j].depth > rowItem.depth; j++) {
        end = j;
      }
      if (end > i) {
        spans.push({ parentKey: rowItem.key, depth: rowItem.depth, startIdx: i + 1, endIdx: end });
      }
    }
    return spans;
  }

  // src/webviews/gantt/row-window.js
  var SVG_NS = "http://www.w3.org/2000/svg";
  var PANELS = ["status", "id", "labels", "start", "due", "assignee", "timeline"];
  var BUFFER_ROWS = 10;
  var MIN_CONTENT_HEIGHT = 600;
  var BODY_PADDING = 10;
  function createRowWindow({ perfLog: perfLog2 = () => {
  } } = {}) {
    let rows = [];
    let arrows = [];
    let state = null;
    let barHeight = 22;
    let expandedSet = /* @__PURE__ */ new Set();
    let visibleList = [];
    let indexByKey = /* @__PURE__ */ new Map();
    let rowByKey = /* @__PURE__ */ new Map();
    let rowByIssueId = /* @__PURE__ */ new Map();
    let elementCache = /* @__PURE__ */ new Map();
    let mountedKeys = /* @__PURE__ */ new Set();
    let layerEls = null;
    let scrollEl = null;
    let pinnedKeys = /* @__PURE__ */ new Set();
    let lastRange = { first: -1, last: -2 };
    let rafPending = false;
    let disposed = false;
    const refreshListeners = [];
    function collectLayers() {
      const panels = {};
      document.querySelectorAll(".row-layer[data-panel]").forEach((el) => {
        panels[el.dataset.panel] = el;
      });
      layerEls = {
        panels,
        zebraLayers: Array.from(document.querySelectorAll(".gantt-body .zebra-layer")),
        indentLayer: document.querySelector(".gantt-body .indent-layer"),
        dependencyLayer: document.querySelector(".gantt-body .dependency-layer"),
        svgs: Array.from(
          document.querySelectorAll(".gantt-body .gantt-sticky-left svg, .gantt-body .gantt-timeline svg")
        )
      };
      scrollEl = document.getElementById("ganttScroll");
    }
    function attachScroll() {
      if (!scrollEl) return;
      scrollEl.addEventListener("scroll", () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (disposed) return;
          const range = currentRange();
          if (range.first !== lastRange.first || range.last !== lastRange.last) {
            remountWindow();
          }
        });
      }, { passive: true });
    }
    function currentRange() {
      if (!scrollEl) return { first: 0, last: visibleList.length - 1 };
      return computeMountRange(
        scrollEl.scrollTop,
        scrollEl.clientHeight,
        barHeight,
        visibleList.length,
        BUFFER_ROWS
      );
    }
    function materialize(key) {
      let els = elementCache.get(key);
      if (els) return els;
      const rowPayload = rowByKey.get(key);
      els = {};
      for (const panel of PANELS) {
        const frag = rowPayload.panels[panel];
        if (!frag) {
          els[panel] = null;
          continue;
        }
        const host = document.createElementNS(SVG_NS, "g");
        host.innerHTML = frag;
        els[panel] = host.firstElementChild;
      }
      elementCache.set(key, els);
      return els;
    }
    function mountKey(key, index) {
      const els = materialize(key);
      const transform = `translate(0, ${index * barHeight})`;
      for (const panel of PANELS) {
        const el = els[panel];
        if (!el) continue;
        el.setAttribute("transform", transform);
        const layer = layerEls.panels[panel];
        if (layer && el.parentNode !== layer) layer.appendChild(el);
      }
      const meta = rowByKey.get(key);
      if (meta && meta.hasChildren && els.labels) {
        const expanded = expandedSet.has(key);
        els.labels.dataset.expanded = String(expanded);
        const chevron = els.labels.querySelector(".collapse-toggle");
        if (chevron) chevron.classList.toggle("expanded", expanded);
      }
      mountedKeys.add(key);
    }
    function unmountKey(key) {
      const els = elementCache.get(key);
      if (els) {
        for (const panel of PANELS) {
          if (els[panel]) els[panel].remove();
        }
      }
      mountedKeys.delete(key);
    }
    function remountWindow(layersRebuilt = false) {
      if (disposed || !layerEls) return;
      const range = currentRange();
      lastRange = range;
      const wanted = /* @__PURE__ */ new Set();
      for (let i = range.first; i <= range.last; i++) {
        wanted.add(visibleList[i].key);
      }
      pinnedKeys.forEach((key) => {
        if (indexByKey.has(key)) wanted.add(key);
      });
      for (const key of Array.from(mountedKeys)) {
        if (!wanted.has(key)) unmountKey(key);
      }
      wanted.forEach((key) => mountKey(key, indexByKey.get(key)));
      refreshListeners.forEach((cb) => cb({ layersRebuilt }));
    }
    function updateHeights() {
      const h = Math.max(visibleList.length * barHeight + BODY_PADDING, MIN_CONTENT_HEIGHT);
      layerEls.svgs.forEach((svg) => svg.setAttribute("height", String(h)));
    }
    function renderZebra() {
      const bands = computeZebraBands(visibleList, state.useTopLevelGrouping);
      const markup = bands.map((b) => {
        const y = b.startIdx * barHeight;
        const h = (b.endIdx - b.startIdx + 1) * barHeight;
        const opacity = b.bandIdx % 2 === 0 ? 0.03 : 0.06;
        return `<rect class="zebra-stripe" x="0" y="${y}" width="100%" height="${h}" opacity="${opacity}"/>`;
      }).join("");
      layerEls.zebraLayers.forEach((layer) => {
        layer.innerHTML = markup;
      });
    }
    function renderIndent() {
      if (!layerEls.indentLayer) return;
      const indentSize = state.indentSize;
      layerEls.indentLayer.innerHTML = computeIndentSpans(visibleList).map((s) => {
        const x = 8 + s.depth * indentSize;
        return `<line class="indent-guide-line" x1="${x}" y1="${s.startIdx * barHeight}" x2="${x}" y2="${(s.endIdx + 1) * barHeight}" stroke="var(--vscode-tree-indentGuidesStroke)" stroke-width="1" opacity="0.4"/>`;
      }).join("");
    }
    function renderArrows() {
      if (!layerEls.dependencyLayer) return;
      const getPosition = (issueId) => {
        const r = rowByIssueId.get(issueId);
        if (!r || r.barStartX === null || r.barEndX === null) return null;
        const idx = indexByKey.get(r.key);
        if (idx === void 0) return null;
        return { startX: r.barStartX, endX: r.barEndX, y: idx * barHeight + barHeight / 2 };
      };
      layerEls.dependencyLayer.innerHTML = buildArrowsMarkup(arrows, getPosition, barHeight);
    }
    function refresh() {
      if (disposed) return;
      const t0 = performance.now();
      visibleList = computeVisibleList(rows, expandedSet);
      indexByKey = new Map(visibleList.map((r, i) => [r.key, i]));
      updateHeights();
      renderZebra();
      renderIndent();
      renderArrows();
      remountWindow(true);
      perfLog2(`rowWindow refresh: ${(performance.now() - t0).toFixed(1)}ms (visible=${visibleList.length}, mounted=${mountedKeys.size})`);
    }
    function setData(payload) {
      rows = payload.rows || [];
      arrows = payload.arrows || [];
      state = payload.state || {};
      barHeight = state.barHeight || 22;
      expandedSet = new Set(state.expandedKeys || []);
      rowByKey = new Map(rows.map((r) => [r.key, r]));
      rowByIssueId = /* @__PURE__ */ new Map();
      rows.forEach((r) => {
        if (r.issueId !== null && r.issueId !== void 0) rowByIssueId.set(r.issueId, r);
      });
      elementCache = /* @__PURE__ */ new Map();
      mountedKeys = /* @__PURE__ */ new Set();
      pinnedKeys = /* @__PURE__ */ new Set();
      lastRange = { first: -1, last: -2 };
      collectLayers();
      if (rows.length === 0 && Object.keys(layerEls.panels).length === 0) return;
      attachScroll();
      refresh();
    }
    function scrollToKey(key) {
      const idx = indexByKey.get(key);
      if (idx === void 0 || !scrollEl) return;
      const headerH = document.querySelector(".gantt-header-row")?.getBoundingClientRect().height || 60;
      const bodyEl = document.querySelector(".gantt-body");
      const bodyTop = bodyEl ? bodyEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop : headerH;
      const y = bodyTop + idx * barHeight;
      const viewTop = scrollEl.scrollTop;
      const viewBottom = viewTop + scrollEl.clientHeight;
      if (y < viewTop + bodyTop) {
        scrollEl.scrollTop = Math.max(0, y - bodyTop - 4);
      } else if (y + barHeight > viewBottom) {
        scrollEl.scrollTop = y + barHeight - scrollEl.clientHeight + 4;
      }
      remountWindow();
    }
    return {
      setData,
      refresh,
      // collapse state
      isExpanded: (key) => expandedSet.has(key),
      setExpanded: (key, expand) => {
        if (expand) expandedSet.add(key);
        else expandedSet.delete(key);
        refresh();
      },
      setAllExpanded: (keys) => {
        expandedSet = new Set(keys);
        refresh();
      },
      // lookups
      getRowMeta: (key) => rowByKey.get(key),
      // Resolve by issue id — keeps the extension's collapse-key format
      // ('issue-{id}') out of consumer code
      getRowMetaByIssueId: (issueId) => rowByIssueId.get(Number(issueId)),
      getVisibleList: () => visibleList,
      // Full document order (includes collapse-hidden rows) for select-all/range
      getAllIssueIds: () => rows.filter((r) => r.issueId !== null && r.issueId !== void 0).map((r) => String(r.issueId)),
      // All relations as data (arrows under collapsed rows have no DOM)
      getArrows: () => arrows,
      visibleIndexOf: (key) => indexByKey.has(key) ? indexByKey.get(key) : -1,
      keyAtIndex: (i) => i >= 0 && i < visibleList.length ? visibleList[i].key : null,
      getVirtualY: (key) => {
        const idx = indexByKey.get(key);
        return idx === void 0 ? null : idx * barHeight;
      },
      getLabelElement: (key) => mountedKeys.has(key) ? elementCache.get(key)?.labels ?? null : null,
      // The 7 column/timeline body SVGs — single source for overlay/height
      // consumers (a second hand-enumerated selector list would drift)
      getBodySvgs: () => layerEls ? layerEls.svgs : [],
      // window control
      scrollToKey,
      // Pinned rows must be mounted immediately (drag reads their elements).
      // pinAll batches: ONE remount + listener cascade for N keys — per-key
      // remounts made bulk-drag mousedown O(N) full rebuilds.
      pin: (key) => {
        pinnedKeys.add(key);
        remountWindow();
      },
      pinAll: (keys) => {
        keys.forEach((key) => pinnedKeys.add(key));
        remountWindow();
      },
      unpin: () => {
        pinnedKeys.clear();
      },
      onRefresh: (cb) => {
        refreshListeners.push(cb);
      },
      dispose: () => {
        disposed = true;
        refreshListeners.length = 0;
      }
    };
  }

  // src/webviews/gantt/index.js
  var vscode = acquireVsCodeApi();
  var rowWindow = null;
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
  function perfLog(message) {
    if (PERF_DEBUG) {
      console.log(`[Gantt Perf] ${message}`);
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
  var projectMembersById = /* @__PURE__ */ new Map();
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
          const link = document.createElement("a");
          link.href = openMatch[1];
          link.textContent = "Open in Browser";
          link.title = openMatch[1];
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
      const projectId = target.dataset.projectId;
      if (projectId) {
        const memberText = projectMembersById.get(String(projectId));
        if (memberText) {
          const existing = (target.dataset.tooltip || "").trimEnd();
          if (existing && !existing.includes(memberText)) {
            target.dataset.tooltip = existing + "\n\n---\n\n" + memberText;
          }
        } else if (!target.dataset.membersRequested) {
          target.dataset.membersRequested = "1";
          vscode.postMessage({ command: "requestProjectMembers", projectId: Number(projectId) });
        }
      }
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
      let target = node.closest?.("[data-tooltip], [title]");
      if (!target) {
        let el = node;
        while (el && el !== root) {
          if (el.querySelector?.(":scope > title")) {
            target = el;
            break;
          }
          el = el.parentElement;
        }
      }
      if (!target || !root.contains(target)) return null;
      if (target.hasAttribute("title")) {
        const title = normalizeTooltipText(target.getAttribute("title"));
        target.removeAttribute("title");
        if (title) {
          target.dataset.tooltip = title;
        }
      }
      const childTitle = target.querySelector?.(":scope > title");
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
    perfMark("mountRows-start");
    rowWindow?.dispose();
    rowWindow = createRowWindow({ perfLog });
    rowWindow.setData(payload);
    perfMark("mountRows-end");
    perfMeasure("mountRows", "mountRows-start", "mountRows-end");
    initializeGantt(payload.state, rowWindow);
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
    if (message.command === "appendProjectMembers" && message.projectId && message.memberLines?.length) {
      projectMembersById.set(String(message.projectId), message.memberLines.join("\n"));
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
  function initializeGantt(state, rowWindow2) {
    perfMark("initializeGantt-start");
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
      badge.dataset.tooltip = count === 1 ? "1 change queued - click to review" : count + " changes queued - click to review";
    }
    let currentDraftMode = isDraftMode;
    const confirmBtn = document.getElementById("dragConfirmOk");
    if (confirmBtn) {
      confirmBtn.textContent = isDraftMode ? "Queue to Draft" : "Save to Redmine";
    }
    const draftBadge = document.getElementById("draftBadge");
    if (draftBadge) {
      if (isDraftMode) {
        draftBadge.classList.remove("hidden");
        setDraftBadgeContent(draftBadge, draftQueueCount ?? 0);
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
    const extraCleanups = [];
    window._ganttCleanup = () => {
      docListeners.forEach((l) => document.removeEventListener(l.type, l.handler, l.options));
      winListeners.forEach((l) => window.removeEventListener(l.type, l.handler, l.options));
      extraCleanups.forEach((fn) => fn());
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
    let savedScrollLeft = previousState.scrollLeft ?? null;
    let savedScrollTop = previousState.scrollTop ?? null;
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
      trimHistoryStack(undoStack);
      trimHistoryStack(redoStack);
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
    const viewToggleTable = {
      setDependenciesState: { targetSel: ".dependency-layer", menuId: "menuDeps", className: "hidden", addWhenEnabled: false },
      setBadgesState: { targetSel: ".gantt-container", menuId: "menuBadges", className: "hide-badges", addWhenEnabled: false },
      setMyIssuesHighlightState: { targetSel: ".gantt-container", menuId: "menuMyIssues", className: "hide-my-issues", addWhenEnabled: false },
      setCapacityRibbonState: { targetSel: ".capacity-ribbon", menuId: "menuCapacity", className: "hidden", addWhenEnabled: false },
      setIntensityState: { targetSel: ".gantt-container", menuId: "menuIntensity", className: "intensity-enabled", addWhenEnabled: true }
    };
    function applyViewToggle(cfg, enabled) {
      const target = document.querySelector(cfg.targetSel);
      const menu = document.getElementById(cfg.menuId);
      const on = cfg.addWhenEnabled ? enabled : !enabled;
      if (target) target.classList.toggle(cfg.className, on);
      if (menu) menu.classList.toggle("active", enabled);
    }
    window.__ganttHandleExtensionMessage = (message) => {
      const toggleCfg = viewToggleTable[message.command];
      if (toggleCfg) {
        applyViewToggle(toggleCfg, message.enabled);
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
            setDraftBadgeContent(draftBadge2, message.queueCount ?? 0);
          } else {
            draftBadge2.classList.add("hidden");
          }
        }
      } else if (message.command === "setDraftQueueCount") {
        const draftBadge2 = document.getElementById("draftBadge");
        if (draftBadge2) {
          setDraftBadgeContent(draftBadge2, message.count);
        }
      } else if (message.command === "pushUndoAction") {
        undoStack.push(message.action);
        trimHistoryStack(undoStack);
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
        const scrollContainer = document.getElementById("ganttScroll");
        if (!scrollContainer) return;
        const meta = rowWindow2?.getRowMetaByIssueId(issueId);
        if (meta) rowWindow2.scrollToKey(meta.key);
        const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
        const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
        let targetScrollLeft = scrollContainer.scrollLeft;
        if (label) {
          label.focus({ preventScroll: true });
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
        scrollContainer.scrollTo({ left: targetScrollLeft, behavior: "smooth" });
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
    document.getElementById("filterTaskType")?.addEventListener("change", (e) => {
      vscode.postMessage({ command: "setTaskTypeFilter", taskType: e.target.value });
    });
    document.getElementById("lateFilterBtn")?.addEventListener("click", () => {
      saveState();
      vscode.postMessage({ command: "toggleLateFilter" });
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
    document.getElementById("menuMyIssues")?.addEventListener("click", () => {
      saveState();
      vscode.postMessage({ command: "toggleMyIssuesHighlight" });
    });
    const ganttContainer = document.querySelector(".gantt-container");
    function buildBlockingGraph() {
      const graph = /* @__PURE__ */ new Map();
      const reverseGraph = /* @__PURE__ */ new Map();
      (rowWindow2?.getArrows() ?? []).forEach((rel) => {
        if (rel.type !== "blocks" && rel.type !== "precedes") return;
        const fromId = String(rel.fromId);
        const toId = String(rel.toId);
        if (!graph.has(fromId)) graph.set(fromId, []);
        graph.get(fromId).push(toId);
        if (!reverseGraph.has(toId)) reverseGraph.set(toId, []);
        reverseGraph.get(toId).push(fromId);
      });
      return { graph, reverseGraph };
    }
    let focusedIssueId = null;
    let focusedConnectedIds = null;
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
    function applyFocusClasses() {
      if (!focusedConnectedIds) return;
      document.querySelectorAll(".issue-bar").forEach((bar) => {
        bar.classList.toggle("focus-highlighted", focusedConnectedIds.has(bar.dataset.issueId));
      });
      document.querySelectorAll(".issue-label").forEach((label) => {
        label.classList.toggle("focus-highlighted", focusedConnectedIds.has(label.dataset.issueId));
      });
      document.querySelectorAll(".dependency-arrow").forEach((arrow) => {
        arrow.classList.toggle(
          "focus-highlighted",
          focusedConnectedIds.has(arrow.dataset.from) && focusedConnectedIds.has(arrow.dataset.to)
        );
      });
    }
    function focusOnDependencyChain(issueId) {
      clearFocus();
      if (!issueId) return;
      focusedIssueId = issueId;
      const { graph, reverseGraph } = buildBlockingGraph();
      focusedConnectedIds = getAllConnected(String(issueId), graph, reverseGraph);
      ganttContainer.classList.add("focus-mode");
      applyFocusClasses();
      announce(`Focus: ${focusedConnectedIds.size} issue${focusedConnectedIds.size !== 1 ? "s" : ""} in dependency chain`);
    }
    function clearFocus() {
      focusedIssueId = null;
      focusedConnectedIds = null;
      ganttContainer.classList.remove("focus-mode");
      document.querySelectorAll(".focus-highlighted").forEach((el) => el.classList.remove("focus-highlighted"));
    }
    const getFocusedIssueId = () => focusedIssueId;
    const selectedIssues = /* @__PURE__ */ new Set();
    let lastClickedIssueId = null;
    const selectionCountEl = document.getElementById("selectionCount");
    function rebuildMultiSelectOverlays() {
      const labelsSvg2 = document.querySelector(".gantt-labels svg");
      if (!labelsSvg2) return;
      let layer = labelsSvg2.querySelector(".multi-select-layer");
      if (!layer) {
        layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        layer.setAttribute("class", "multi-select-layer");
        layer.setAttribute("pointer-events", "none");
        const zebra = labelsSvg2.querySelector(".zebra-layer");
        if (zebra && zebra.nextSibling) labelsSvg2.insertBefore(layer, zebra.nextSibling);
        else labelsSvg2.insertBefore(layer, labelsSvg2.firstChild);
      }
      let rects = "";
      selectedIssues.forEach((id) => {
        const meta = rowWindow2?.getRowMetaByIssueId(id);
        if (!meta) return;
        const y = rowWindow2.getVirtualY(meta.key);
        if (y === null || y === void 0) return;
        rects += '<rect x="0" y="' + y + '" width="100%" height="' + barHeight + '" fill="var(--vscode-list-activeSelectionBackground)" opacity="0.45"/>';
      });
      layer.innerHTML = rects;
    }
    function refreshSelectionChrome() {
      if (selectedIssues.size > 0) {
        selectionCountEl.textContent = `${selectedIssues.size} selected`;
        selectionCountEl.classList.remove("hidden");
        ganttContainer.classList.add("multi-select-mode");
      } else {
        selectionCountEl.classList.add("hidden");
        ganttContainer.classList.remove("multi-select-mode");
      }
    }
    function updateSelectionForIds(_changedIds) {
      rebuildMultiSelectOverlays();
      refreshSelectionChrome();
    }
    function updateSelectionUI() {
      rebuildMultiSelectOverlays();
      refreshSelectionChrome();
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
      const ids = rowWindow2?.getAllIssueIds() ?? [];
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
      (rowWindow2?.getAllIssueIds() ?? []).forEach((id) => selectedIssues.add(id));
      updateSelectionUI();
      announce(`Selected all ${selectedIssues.size} issues`);
    }
    addDocListener("mousedown", (e) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
      const label = e.target.closest(".issue-label");
      if (!label) return;
      e.preventDefault();
      e.stopPropagation();
      const issueId = label.dataset.issueId;
      if (e.shiftKey && lastClickedIssueId) {
        selectRange(lastClickedIssueId, issueId);
      } else {
        toggleSelection(issueId);
      }
    });
    addDocListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAll();
      }
      if (e.key === "Escape" && pinnedIssueId) {
        pinHighlight(pinnedIssueId);
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
    const lookupMaps = createLookupMaps();
    if (typeof requestIdleCallback !== "undefined") {
      const idleHandle = requestIdleCallback(() => lookupMaps.rebuild(), { timeout: 100 });
      extraCleanups.push(() => cancelIdleCallback(idleHandle));
    } else {
      const timeoutHandle = setTimeout(() => lookupMaps.rebuild(), 0);
      extraCleanups.push(() => clearTimeout(timeoutHandle));
    }
    rowWindow2?.onRefresh(() => {
      lookupMaps.rebuildIfReady();
      updateSelectionUI();
      applyFocusClasses();
      applyPinnedHighlight();
      clearHoverHighlight();
    });
    let highlightedElements = [];
    let currentHoverKey = null;
    function clearHoverHighlight() {
      if (currentHoverKey === null && highlightedElements.length === 0) return;
      currentHoverKey = null;
      document.body.classList.remove("hover-focus", "dependency-hover");
      highlightedElements.forEach((el) => el.classList.remove("hover-highlighted", "hover-source"));
      highlightedElements = [];
    }
    function highlightIssue(issueId) {
      const bars = lookupMaps.isReady() ? lookupMaps.getIssueBars(issueId) : document.querySelectorAll('.issue-bar[data-issue-id="' + issueId + '"]');
      const labels = lookupMaps.isReady() ? lookupMaps.getIssueLabels(issueId) : document.querySelectorAll('.issue-label[data-issue-id="' + issueId + '"]');
      const arrows = lookupMaps.isReady() ? lookupMaps.getArrows(issueId) : document.querySelectorAll('.dependency-arrow[data-from="' + issueId + '"], .dependency-arrow[data-to="' + issueId + '"]');
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
      const labels = lookupMaps.isReady() ? lookupMaps.getProjectLabels(collapseKey) : document.querySelectorAll('.project-label[data-collapse-key="' + collapseKey + '"]');
      const bars = lookupMaps.isReady() ? lookupMaps.getAggregateBars(collapseKey) : document.querySelectorAll('.aggregate-bars[data-collapse-key="' + collapseKey + '"]');
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
          if (!issueId || currentHoverKey === "issue:" + issueId) return;
          clearHoverHighlight();
          currentHoverKey = "issue:" + issueId;
          highlightIssue(issueId);
        } else if (aggBar) {
          const key = aggBar.dataset.collapseKey;
          if (!key || currentHoverKey === "project:" + key) return;
          clearHoverHighlight();
          currentHoverKey = "project:" + key;
          highlightProject(key);
        } else if (arrow) {
          const fromId = arrow.dataset.from;
          const toId = arrow.dataset.to;
          const hoverKey = "arrow:" + fromId + "-" + toId;
          if (currentHoverKey === hoverKey) return;
          clearHoverHighlight();
          currentHoverKey = hoverKey;
          document.body.classList.add("hover-focus", "dependency-hover");
          arrow.classList.add("hover-source");
          highlightedElements.push(arrow);
          if (fromId) highlightIssue(fromId);
          if (toId) highlightIssue(toId);
        }
      }, true);
      timelineSvg.addEventListener("mouseleave", (e) => {
        const container = e.target.closest(".issue-bar, .aggregate-bars, .dependency-arrow");
        if (!container) return;
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        clearHoverHighlight();
      }, true);
    }
    if (labelsSvg) {
      labelsSvg.addEventListener("mouseenter", (e) => {
        const label = e.target.closest(".issue-label");
        const projectLabel = e.target.closest(".project-label");
        if (label) {
          const issueId = label.dataset.issueId;
          if (!issueId || currentHoverKey === "issue:" + issueId) return;
          clearHoverHighlight();
          currentHoverKey = "issue:" + issueId;
          highlightIssue(issueId);
        } else if (projectLabel) {
          const key = projectLabel.dataset.collapseKey;
          if (!key || currentHoverKey === "project:" + key) return;
          clearHoverHighlight();
          currentHoverKey = "project:" + key;
          highlightProject(key);
        }
      }, true);
      labelsSvg.addEventListener("mouseleave", (e) => {
        const container = e.target.closest(".issue-label, .project-label");
        if (!container) return;
        if (e.relatedTarget && container.contains(e.relatedTarget)) return;
        clearHoverHighlight();
      }, true);
    }
    let pinnedIssueId = null;
    let pinnedEls = [];
    function applyPinnedHighlight() {
      pinnedEls.forEach((el) => el.classList.remove("pinned-highlight"));
      pinnedEls = [];
      if (!pinnedIssueId) return;
      const id = pinnedIssueId;
      const bars = lookupMaps.isReady() ? lookupMaps.getIssueBars(id) : document.querySelectorAll('.issue-bar[data-issue-id="' + id + '"]');
      const labels = lookupMaps.isReady() ? lookupMaps.getIssueLabels(id) : document.querySelectorAll('.issue-label[data-issue-id="' + id + '"]');
      const arrows = lookupMaps.isReady() ? lookupMaps.getArrows(id) : document.querySelectorAll('.dependency-arrow[data-from="' + id + '"], .dependency-arrow[data-to="' + id + '"]');
      bars.forEach((el) => {
        el.classList.add("pinned-highlight");
        pinnedEls.push(el);
      });
      labels.forEach((el) => {
        el.classList.add("pinned-highlight");
        pinnedEls.push(el);
      });
      arrows.forEach((el) => {
        el.classList.add("pinned-highlight");
        pinnedEls.push(el);
      });
    }
    function pinHighlight(issueId) {
      pinnedIssueId = pinnedIssueId === issueId ? null : issueId;
      applyPinnedHighlight();
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
        const connectedBars = lookupMaps.isReady() ? [...lookupMaps.getIssueBars(fromId), ...lookupMaps.getIssueBars(toId)] : document.querySelectorAll(`.issue-bar[data-issue-id="${fromId}"], .issue-bar[data-issue-id="${toId}"]`);
        const connectedLabels = lookupMaps.isReady() ? [...lookupMaps.getIssueLabels(fromId), ...lookupMaps.getIssueLabels(toId)] : document.querySelectorAll(`.issue-label[data-issue-id="${fromId}"], .issue-label[data-issue-id="${toId}"]`);
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
      rowWindow2?.onRefresh(() => {
        if (!selectedArrow) return;
        const relationId = selectedArrow.dataset.relationId;
        const fresh = relationId ? document.querySelector(`.dependency-arrow[data-relation-id="${relationId}"]`) : null;
        if (!fresh) {
          clearArrowSelection2();
          return;
        }
        selectedArrow = fresh;
        selectedArrowElements.length = 0;
        selectedArrowElements.push(fresh);
        fresh.classList.add("selected");
        arrowConnectedElements.forEach((el) => el.classList.remove("arrow-connected"));
        arrowConnectedElements.length = 0;
        [fresh.dataset.from, fresh.dataset.to].forEach((id) => {
          document.querySelectorAll(`.issue-bar[data-issue-id="${id}"], .issue-label[data-issue-id="${id}"]`).forEach((el) => {
            el.classList.add("arrow-connected");
            arrowConnectedElements.push(el);
          });
        });
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
      // Keep the dragged row(s) mounted while a drag is in progress
      pinRow: (key) => rowWindow2?.pin(key),
      pinRows: (keys) => rowWindow2?.pinAll(keys),
      unpinRow: () => rowWindow2?.unpin(),
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
      pinHighlight,
      isDraftModeEnabled: () => currentDraftMode,
      isPerfDebugEnabled: () => PERF_DEBUG,
      lookupMaps,
      rowWindow: rowWindow2
    });
    setupRowInteraction({
      vscode,
      addDocListener,
      addWinListener,
      announce,
      barHeight,
      selectedCollapseKey,
      allExpandableKeys: state.allExpandableKeys,
      rowWindow: rowWindow2,
      perfLog
    });
    function scrollToToday(announceOutOfRange = true) {
      if (!todayInRange) {
        if (announceOutOfRange) {
          vscode.postMessage({ command: "todayOutOfRange" });
        } else if (ganttScroll) {
          ganttScroll.scrollLeft = todayX < 0 ? 0 : ganttScroll.scrollWidth;
        }
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
      const meta = rowWindow2?.getRowMetaByIssueId(issueId);
      if (meta) rowWindow2.scrollToKey(meta.key);
      const label = document.querySelector('.issue-label[data-issue-id="' + issueId + '"]');
      const bar = document.querySelector('.issue-bar[data-issue-id="' + issueId + '"]');
      if (label) {
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
      scrollToToday,
      rowWindow: rowWindow2
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
        scrollToToday(false);
      }
      updateMinimapViewport();
      restoringScroll = false;
    });
    document.getElementById("todayBtn")?.addEventListener("click", () => scrollToToday());
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
