/**
 * Windowed row renderer: keeps every row's SVG fragments as data and mounts
 * only the rows intersecting the viewport (± buffer) into the panel
 * row-layers. Owns the visible-row list (rows + expanded keys), panel SVG
 * heights, and the data-computed layers (zebra bands, indent guides,
 * dependency arrows). Fragments are single-rooted <g> elements generated at
 * y=0; mounting sets transform="translate(0, virtualY)" on the cached root.
 */
import {
  computeVisibleList,
  computeMountRange,
  computeZebraBands,
  computeIndentSpans,
} from './row-window-utils.js';
import { buildArrowsMarkup } from './arrow-svg.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PANELS = ['status', 'id', 'labels', 'start', 'due', 'assignee', 'timeline'];
const BUFFER_ROWS = 10;
const MIN_CONTENT_HEIGHT = 600; // matches the extension's empty-board floor
const BODY_PADDING = 10;        // matches the extension's barGap tail

export function createRowWindow({ perfLog = () => {} } = {}) {
  let rows = [];
  let arrows = [];
  let state = null;
  let barHeight = 22;
  let expandedSet = new Set();
  let visibleList = [];
  let indexByKey = new Map();   // key -> visible index
  let rowByKey = new Map();     // key -> payload row
  let rowByIssueId = new Map(); // issueId -> payload row
  let elementCache = new Map(); // key -> { [panel]: Element|null } (recycled across mounts)
  let mountedKeys = new Set();
  let layerEls = null;
  let scrollEl = null;
  let pinnedKeys = new Set();
  let lastRange = { first: -1, last: -2 };
  let rafPending = false;
  let disposed = false; // re-render replaces the instance; zombie rAFs must no-op
  const refreshListeners = [];

  function collectLayers() {
    const panels = {};
    document.querySelectorAll('.row-layer[data-panel]').forEach((el) => {
      panels[el.dataset.panel] = el;
    });
    layerEls = {
      panels,
      zebraLayers: Array.from(document.querySelectorAll('.gantt-body .zebra-layer')),
      indentLayer: document.querySelector('.gantt-body .indent-layer'),
      dependencyLayer: document.querySelector('.gantt-body .dependency-layer'),
      svgs: Array.from(
        document.querySelectorAll('.gantt-body .gantt-sticky-left svg, .gantt-body .gantt-timeline svg')
      ),
    };
    scrollEl = document.getElementById('ganttScroll');
  }

  function attachScroll() {
    if (!scrollEl) return;
    scrollEl.addEventListener('scroll', () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (disposed) return; // queued before a re-render; DOM is detached
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

  // Parse a row's panel fragments into elements once; recycle across mounts.
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
      const host = document.createElementNS(SVG_NS, 'g');
      host.innerHTML = frag;
      els[panel] = host.firstElementChild; // fragments are single-rooted <g>
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
      el.setAttribute('transform', transform);
      const layer = layerEls.panels[panel];
      if (layer && el.parentNode !== layer) layer.appendChild(el);
    }
    // Fragments bake render-time expanded state; the window owns the live one
    const meta = rowByKey.get(key);
    if (meta && meta.hasChildren && els.labels) {
      const expanded = expandedSet.has(key);
      els.labels.dataset.expanded = String(expanded);
      const chevron = els.labels.querySelector('.collapse-toggle');
      if (chevron) chevron.classList.toggle('expanded', expanded);
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
    const wanted = new Set();
    for (let i = range.first; i <= range.last; i++) {
      wanted.add(visibleList[i].key);
    }
    pinnedKeys.forEach((key) => {
      if (indexByKey.has(key)) wanted.add(key);
    });
    for (const key of Array.from(mountedKeys)) {
      if (!wanted.has(key)) unmountKey(key);
    }
    // mountKey also refreshes transforms of already-mounted rows (indices
    // shift when collapse state changes)
    wanted.forEach((key) => mountKey(key, indexByKey.get(key)));
    // layersRebuilt: true when zebra/indent/dependency layers were rewritten
    // (full refresh) — listeners holding arrow element refs must re-resolve
    refreshListeners.forEach((cb) => cb({ layersRebuilt }));
  }

  function updateHeights() {
    const h = Math.max(visibleList.length * barHeight + BODY_PADDING, MIN_CONTENT_HEIGHT);
    layerEls.svgs.forEach((svg) => svg.setAttribute('height', String(h)));
  }

  function renderZebra() {
    const bands = computeZebraBands(visibleList, state.useTopLevelGrouping ?? true);
    const markup = bands
      .map((b) => {
        const y = b.startIdx * barHeight;
        const h = (b.endIdx - b.startIdx + 1) * barHeight;
        const opacity = b.bandIdx % 2 === 0 ? 0.03 : 0.06;
        return `<rect class="zebra-stripe" x="0" y="${y}" width="100%" height="${h}" opacity="${opacity}"/>`;
      })
      .join('');
    layerEls.zebraLayers.forEach((layer) => {
      layer.innerHTML = markup;
    });
  }

  function renderIndent() {
    if (!layerEls.indentLayer) return;
    const indentSize = (state && state.indentSize) || 8;
    layerEls.indentLayer.innerHTML = computeIndentSpans(visibleList)
      .map((s) => {
        const x = 8 + s.depth * indentSize;
        return `<line class="indent-guide-line" x1="${x}" y1="${s.startIdx * barHeight}" x2="${x}" y2="${(s.endIdx + 1) * barHeight}" stroke="var(--vscode-tree-indentGuidesStroke)" stroke-width="1" opacity="0.4"/>`;
      })
      .join('');
  }

  function renderArrows() {
    if (!layerEls.dependencyLayer) return;
    const getPosition = (issueId) => {
      const r = rowByIssueId.get(issueId);
      if (!r || r.barStartX === null || r.barEndX === null) return null;
      const idx = indexByKey.get(r.key);
      if (idx === undefined) return null; // hidden under a collapsed parent
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
    perfLog(`rowWindow refresh: ${(performance.now() - t0).toFixed(1)}ms (visible=${visibleList.length}, mounted=${mountedKeys.size})`);
  }

  function setData(payload) {
    rows = payload.rows || [];
    arrows = payload.arrows || [];
    state = payload.state || {};
    barHeight = state.barHeight || 22;
    expandedSet = new Set(state.expandedKeys || []);
    rowByKey = new Map(rows.map((r) => [r.key, r]));
    rowByIssueId = new Map();
    rows.forEach((r) => {
      if (r.issueId !== null && r.issueId !== undefined) rowByIssueId.set(r.issueId, r);
    });
    elementCache = new Map();
    mountedKeys = new Set();
    pinnedKeys = new Set();
    lastRange = { first: -1, last: -2 };
    collectLayers();
    // Loading/empty chrome ships rows: [] and no row-layer panels, but DOES
    // carry pre-rendered zebra stripes in its markup — refresh() would wipe
    // them (computeZebraBands([]) is empty) before the skeleton ever paints
    if (rows.length === 0 && Object.keys(layerEls.panels).length === 0) return;
    attachScroll();
    refresh();
  }

  function scrollToKey(key) {
    const idx = indexByKey.get(key);
    if (idx === undefined || !scrollEl) return;
    // Rows do NOT start at scroll-content y=0: the sticky-but-in-flow header
    // row (and capacity ribbon, when visible) precede .gantt-body, and the
    // same sticky stack occludes the top of the viewport.
    const headerH = document.querySelector('.gantt-header-row')?.getBoundingClientRect().height || 60;
    const bodyEl = document.querySelector('.gantt-body');
    const bodyTop = bodyEl
      ? bodyEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      : headerH;
    const y = bodyTop + idx * barHeight; // row top in scroll-content space
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;
    if (y < viewTop + bodyTop) {
      scrollEl.scrollTop = Math.max(0, y - bodyTop - 4);
    } else if (y + barHeight > viewBottom) {
      scrollEl.scrollTop = y + barHeight - scrollEl.clientHeight + 4;
    }
    remountWindow(); // target must be mounted before the caller focuses it
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
    getExpandedKeys: () => Array.from(expandedSet),
    // lookups
    getRowMeta: (key) => rowByKey.get(key),
    getVisibleList: () => visibleList,
    // Full document order (includes collapse-hidden rows) for select-all/range
    getAllIssueIds: () =>
      rows.filter((r) => r.issueId !== null && r.issueId !== undefined).map((r) => String(r.issueId)),
    // All relations as data (arrows under collapsed rows have no DOM)
    getArrows: () => arrows,
    visibleIndexOf: (key) => (indexByKey.has(key) ? indexByKey.get(key) : -1),
    keyAtIndex: (i) => (i >= 0 && i < visibleList.length ? visibleList[i].key : null),
    getVirtualY: (key) => {
      const idx = indexByKey.get(key);
      return idx === undefined ? null : idx * barHeight;
    },
    getLabelElement: (key) =>
      mountedKeys.has(key) ? elementCache.get(key)?.labels ?? null : null,
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
    },
  };
}
