export function setupMinimap({
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
  // Position minimap to align with timeline (skip sticky-left columns)
  function updateMinimapPosition() {
    const stickyLeft = document.querySelector('.gantt-body .gantt-sticky-left');
    const ganttContainer = document.querySelector('.gantt-container');
    if (stickyLeft && ganttContainer) {
      ganttContainer.style.setProperty('--sticky-left-width', stickyLeft.offsetWidth + 'px');
    }
  }

  // Defer to next frame to ensure layout is complete (fixes minimap alignment on project switch)
  requestAnimationFrame(updateMinimapPosition);

  // Render minimap bars (deferred to avoid blocking initial paint)
  if (minimapSvg) {
    requestAnimationFrame(() => {
      const barSpacing = minimapHeight / (minimapBarsData.length + 1);
      minimapBarsData.forEach((bar, i) => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('class', bar.classes);
        rect.setAttribute('x', (bar.startPct * timelineWidth).toString());
        rect.setAttribute('y', (barSpacing * (i + 0.5)).toString());
        rect.setAttribute('width', Math.max(2, (bar.endPct - bar.startPct) * timelineWidth).toString());
        rect.setAttribute('height', minimapBarHeight.toString());
        rect.setAttribute('rx', '1');
        rect.setAttribute('fill', bar.color);
        minimapSvg.insertBefore(rect, minimapViewport);
      });
      // Today marker line
      if (minimapTodayX > 0 && minimapTodayX < timelineWidth) {
        const todayLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        todayLine.setAttribute('class', 'minimap-today');
        todayLine.setAttribute('x1', minimapTodayX.toString());
        todayLine.setAttribute('y1', '0');
        todayLine.setAttribute('x2', minimapTodayX.toString());
        todayLine.setAttribute('y2', minimapHeight.toString());
        minimapSvg.insertBefore(todayLine, minimapViewport);
      }
    });
  }

  // Update minimap viewport on scroll
  // Use ganttScroll for single-container scroll
  function updateMinimapViewport() {
    if (!ganttScroll || !minimapViewport) return;
    // Guard against invalid dimensions during initialization
    if (!timelineWidth || !ganttScroll.scrollWidth || !ganttScroll.clientWidth) return;
    const scrollableRange = Math.max(1, ganttScroll.scrollWidth - ganttScroll.clientWidth);
    const scrollRatio = Math.min(1, ganttScroll.scrollLeft / scrollableRange);
    const viewportRatio = Math.min(1, ganttScroll.clientWidth / ganttScroll.scrollWidth);
    const viewportWidth = Math.max(20, viewportRatio * timelineWidth);
    const viewportX = scrollRatio * (timelineWidth - viewportWidth);
    // Final NaN guard
    if (isNaN(viewportX) || isNaN(viewportWidth)) return;
    minimapViewport.setAttribute('x', viewportX.toString());
    minimapViewport.setAttribute('width', viewportWidth.toString());
  }

  // Handle minimap click/drag to scroll
  let minimapDragging = false;
  let minimapDragOffset = 0; // Offset within viewport where drag started

  function scrollFromMinimap(e, useOffset = false) {
    if (!ganttScroll || !minimapSvg || !minimapViewport) return;
    const rect = minimapSvg.getBoundingClientRect();
    const viewportWidth = parseFloat(minimapViewport.getAttribute('width') || '0');
    const viewportWidthPx = (viewportWidth / timelineWidth) * rect.width;

    // Calculate target position, accounting for drag offset if dragging viewport
    let targetX = e.clientX - rect.left;
    if (useOffset) {
      targetX -= minimapDragOffset;
    } else {
      // Center viewport on click position
      targetX -= viewportWidthPx / 2;
    }

    // Use ganttScroll for single-container scroll
    const clickRatio = Math.max(0, Math.min(1, targetX / (rect.width - viewportWidthPx)));
    const scrollableRange = Math.max(0, ganttScroll.scrollWidth - ganttScroll.clientWidth);
    ganttScroll.scrollLeft = clickRatio * scrollableRange;
  }

  if (minimapSvg && minimapViewport) {
    // Clicking on viewport - drag from current position
    minimapViewport.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      minimapDragging = true;
      const rect = minimapSvg.getBoundingClientRect();
      const viewportX = parseFloat(minimapViewport.getAttribute('x') || '0');
      const viewportXPx = (viewportX / timelineWidth) * rect.width;
      minimapDragOffset = e.clientX - rect.left - viewportXPx;
    });

    // Clicking outside viewport - jump to position (center viewport on click)
    minimapSvg.addEventListener('mousedown', (e) => {
      if (e.target === minimapViewport) return;
      minimapDragging = true;
      // Set offset to viewport center so dragging maintains centering (like VS Code)
      const rect = minimapSvg.getBoundingClientRect();
      const viewportWidth = parseFloat(minimapViewport.getAttribute('width') || '0');
      minimapDragOffset = (viewportWidth / 100) * rect.width / 2;
      scrollFromMinimap(e, true);
    });

    addDocListener('mousemove', (e) => {
      if (minimapDragging) scrollFromMinimap(e, true);
    });
    addDocListener('mouseup', () => {
      minimapDragging = false;
    });
  }

  return { updateMinimapPosition, updateMinimapViewport };
}
