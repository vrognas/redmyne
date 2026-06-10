/**
 * Mounted-element lookup maps for O(1) hover/selection/arrow access (instead
 * of repeated querySelectorAll over the SVG tree). Mounted rows churn with
 * the window, so consumers rebuild after every row-window refresh; the first
 * build is deferred to idle (callers fall back to DOM queries until ready).
 */
export function createLookupMaps() {
  const issueBarsByIssueId = new Map();
  const issueLabelsByIssueId = new Map();
  const arrowsByIssueId = new Map(); // arrows connected to an issue
  const projectLabelsByKey = new Map();
  const aggregateBarsByKey = new Map();
  let ready = false;

  function rebuild() {
    issueBarsByIssueId.clear();
    issueLabelsByIssueId.clear();
    arrowsByIssueId.clear();
    projectLabelsByKey.clear();
    aggregateBarsByKey.clear();
    // Single query for all indexable elements (reduces DOM traversals from 5 to 1)
    document.querySelectorAll('.issue-bar, .issue-label, .dependency-arrow, .project-label, .aggregate-bars').forEach(el => {
      const classList = el.classList;
      if (classList.contains('issue-bar')) {
        const id = el.dataset.issueId;
        if (id) {
          if (!issueBarsByIssueId.has(id)) issueBarsByIssueId.set(id, []);
          issueBarsByIssueId.get(id).push(el);
        }
      } else if (classList.contains('issue-label')) {
        const id = el.dataset.issueId;
        if (id) {
          if (!issueLabelsByIssueId.has(id)) issueLabelsByIssueId.set(id, []);
          issueLabelsByIssueId.get(id).push(el);
        }
      } else if (classList.contains('dependency-arrow')) {
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
      } else if (classList.contains('project-label')) {
        const key = el.dataset.collapseKey;
        if (key) {
          if (!projectLabelsByKey.has(key)) projectLabelsByKey.set(key, []);
          projectLabelsByKey.get(key).push(el);
        }
      } else if (classList.contains('aggregate-bars')) {
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
    getAggregateBars: (key) => aggregateBarsByKey.get(key) || [],
  };
}
