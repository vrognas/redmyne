"use strict";

(() => {
  // Get VS Code API
  const vscode = acquireVsCodeApi();

  // Sentinel value for orphan projects
  const OTHERS_PARENT_ID = -1;

  // Undo/Redo stacks
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO_STACK = 50;

  // State
  let state = {
    rows: [],
    week: null,
    totals: null,
    projects: [],
    parentProjects: [],
    childProjectsByParent: new Map(), // parentId -> ProjectOption[]
    issuesByProject: new Map(), // projectId -> IssueOption[]
    activitiesByProject: new Map(), // projectId -> ActivityOption[]
    issueDetails: new Map(), // issueId -> IssueDetails (for tooltips)
    isDraftMode: false,
    sortColumn: null, // 'client' | 'project' | 'task' | 'activity' | 'comments' | 'total' | null
    sortDirection: "asc", // 'asc' | 'desc'
    groupBy: "none", // 'none' | 'client' | 'project' | 'issue' | 'activity'
    collapsedGroups: new Set(), // Group keys that are collapsed
    aggregateRows: false, // Merge identical rows (same issue+activity+comment)
    expandedCells: new Set(), // Set of "rowId:dayIndex" for expanded multi-entry cells
  };

  // Push action to undo stack
  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > MAX_UNDO_STACK) {
      undoStack.shift();
    }
    // Clear redo stack on new action
    redoStack.length = 0;
    updateUndoRedoButtons();
  }

  // Undo last action
  function undo() {
    if (undoStack.length === 0) return;
    const action = undoStack.pop();
    redoStack.push(action);
    applyAction(action, true);
    updateUndoRedoButtons();
  }

  // Redo last undone action
  function redo() {
    if (redoStack.length === 0) return;
    const action = redoStack.pop();
    undoStack.push(action);
    applyAction(action, false);
    updateUndoRedoButtons();
  }

  // Update undo/redo button state
  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  // Apply an undo/redo action
  function applyAction(action, isUndo) {
    const value = isUndo ? action.oldValue : action.newValue;
    switch (action.type) {
      case "cell":
        vscode.postMessage({
          type: "updateCell",
          rowId: action.rowId,
          dayIndex: action.dayIndex,
          hours: value,
          skipUndo: true,
        });
        // Update input visually
        const input = document.querySelector(
          `tr[data-row-id="${action.rowId}"] .day-cell[data-day="${action.dayIndex}"] .day-input`
        );
        if (input) {
          input.value = formatHours(value);
          input.classList.toggle("zero", value === 0);
        }
        break;
      case "field":
        vscode.postMessage({
          type: "updateRowField",
          rowId: action.rowId,
          field: action.field,
          value: value,
          skipUndo: true,
        });
        break;
      case "duplicateRow":
        if (isUndo) {
          // Undo: delete the duplicated row
          vscode.postMessage({
            type: "deleteRow",
            rowId: action.newRowId,
            skipUndo: true,
          });
        } else {
          // Redo: re-duplicate from source (will create new row with new ID)
          vscode.postMessage({
            type: "duplicateRow",
            rowId: action.sourceRowId,
          });
        }
        break;
      case "deleteRow":
        if (isUndo) {
          // Undo: restore the deleted row
          vscode.postMessage({
            type: "restoreRow",
            row: action.deletedRow,
          });
        } else {
          // Redo: delete the row again
          vscode.postMessage({
            type: "deleteRow",
            rowId: action.deletedRow.id,
            skipUndo: true,
          });
        }
        break;
    }
  }

  // Elements
  const gridBody = document.getElementById("gridBody");
  const totalsRow = document.getElementById("totalsRow");
  const weekLabel = document.getElementById("weekLabel");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const weekTotal = document.getElementById("weekTotal");
  const groupBySelect = document.getElementById("groupBySelect");
  const draftModeWarning = document.getElementById("draftModeWarning");
  const enableDraftModeBtn = document.getElementById("enableDraftModeBtn");
  const addEntryBtn = document.getElementById("addEntryBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const weekPickerInput = document.getElementById("weekPickerInput");

  // Initialize flatpickr week picker
  let weekPicker = null;
  if (typeof flatpickr !== "undefined" && weekPickerInput) {
    weekPicker = flatpickr(weekPickerInput, {
      weekNumbers: true,
      locale: { firstDayOfWeek: 1 }, // Monday
      plugins: typeof weekSelectPlugin !== "undefined" ? [new weekSelectPlugin({})] : [],
      onChange: function(selectedDates) {
        if (selectedDates.length > 0) {
          const selectedDate = selectedDates[0];
          // Format as YYYY-MM-DD for navigation
          const year = selectedDate.getFullYear();
          const month = String(selectedDate.getMonth() + 1).padStart(2, "0");
          const day = String(selectedDate.getDate()).padStart(2, "0");
          const dateStr = `${year}-${month}-${day}`;
          vscode.postMessage({ type: "navigateWeek", direction: "date", targetDate: dateStr });
        }
      },
      onOpen: function(selectedDates, dateStr, instance) {
        // Position calendar near the week label
        const rect = weekLabel.getBoundingClientRect();
        const calendar = this.calendarContainer;
        if (calendar) {
          calendar.style.top = `${rect.bottom + 4}px`;
          calendar.style.left = `${rect.left}px`;
        }
        // Add Escape key listener when calendar opens
        instance._escHandler = function(e) {
          if (e.key === "Escape") {
            instance.close();
          }
        };
        document.addEventListener("keydown", instance._escHandler);
      },
      onClose: function(selectedDates, dateStr, instance) {
        // Remove Escape key listener when calendar closes
        if (instance._escHandler) {
          document.removeEventListener("keydown", instance._escHandler);
          instance._escHandler = null;
        }
      }
    });

    // Open picker when clicking week label
    weekLabel?.addEventListener("click", () => {
      if (weekPicker) {
        // Set current week's Monday as the default date
        if (state.week?.startDate) {
          weekPicker.setDate(state.week.startDate, false);
        }
        weekPicker.open();
      }
    });
  }

  // Update draft mode UI state
  function updateDraftModeUI() {
    if (state.isDraftMode) {
      draftModeWarning.classList.add("hidden");
      document.body.classList.remove("draft-mode-disabled");
    } else {
      draftModeWarning.classList.remove("hidden");
      document.body.classList.add("draft-mode-disabled");
    }
  }

  // Format week label
  function formatWeekLabel(week) {
    if (!week) return "Loading...";
    const startDate = new Date(week.startDate + "T12:00:00");
    const endDate = new Date(week.endDate + "T12:00:00");
    const options = { day: "numeric", month: "short" };
    const startStr = startDate.toLocaleDateString("en-US", options);
    const endStr = endDate.toLocaleDateString("en-US", options);
    return `W${String(week.weekNumber).padStart(2, "0")} (${startStr} - ${endStr} ${week.year})`;
  }

  // Format hours for display
  function formatHours(hours) {
    if (hours === 0) return "";
    if (hours === Math.floor(hours)) return hours.toString();
    return hours.toFixed(1);
  }

  // Parse hours input
  function parseHours(value) {
    const str = value.trim();
    if (!str) return 0;
    // Support formats: 1, 1.5, 1:30 (1h 30min), 1h30, 1h 30m
    if (str.includes(":")) {
      const [h, m] = str.split(":").map(Number);
      return h + (m || 0) / 60;
    }
    const match = str.match(/^(\d+(?:\.\d+)?)\s*h?\s*(\d+)?\s*m?$/i);
    if (match) {
      const hours = parseFloat(match[1]) || 0;
      const minutes = parseInt(match[2] || "0", 10);
      return hours + minutes / 60;
    }
    const parsed = parseFloat(str);
    return isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  // Escape HTML
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Get sorted rows based on current sort state
  function getSortedRows() {
    if (!state.sortColumn) return state.rows;
    return [...state.rows].sort((a, b) => {
      let valA, valB;
      switch (state.sortColumn) {
        case "client":
          valA = a.parentProjectName || "";
          valB = b.parentProjectName || "";
          break;
        case "project":
          valA = a.projectName || "";
          valB = b.projectName || "";
          break;
        case "task":
          valA = a.issueId || 0;
          valB = b.issueId || 0;
          break;
        case "activity":
          valA = a.activityName || "";
          valB = b.activityName || "";
          break;
        case "comments":
          valA = a.comments || "";
          valB = b.comments || "";
          break;
        case "total":
          valA = a.weekTotal;
          valB = b.weekTotal;
          break;
        default:
          return 0;
      }
      const cmp = typeof valA === "string" ? valA.localeCompare(valB) : valA - valB;
      return state.sortDirection === "asc" ? cmp : -cmp;
    });
  }

  // Get today's day index in current week (0=Mon, 6=Sun)
  function getTodayDayIndex(week) {
    if (!week) return -1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr =
      today.getFullYear() +
      "-" +
      String(today.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(today.getDate()).padStart(2, "0");
    return week.dayDates.indexOf(todayStr);
  }

  // Render a single row
  function renderRow(row) {
    const tr = document.createElement("tr");
    tr.dataset.rowId = row.id;

    // Check if this is an aggregated row (read-only)
    const isAggregated = row.isAggregated === true;
    if (isAggregated) {
      tr.classList.add("aggregated-row");
    }

    // Check if this is an incomplete row (new, has hours, but missing issue/activity)
    const isIncomplete = row.isNew && (!row.issueId || !row.activityId) && row.weekTotal > 0;
    if (isIncomplete) {
      tr.classList.add("incomplete-row");
    }

    // --- Parent (Client) cell ---
    const parentTd = document.createElement("td");
    parentTd.className = "col-parent";
    const parentSelect = document.createElement("select");
    parentSelect.className = "parent-select";
    // Aggregated rows can edit fields (will update all source entries)
    parentSelect.innerHTML = '<option value="">Client...</option>';

    for (const parent of state.parentProjects) {
      const option = document.createElement("option");
      option.value = parent.id;
      option.textContent = parent.id === OTHERS_PARENT_ID ? parent.name : `#${parent.id} ${parent.name}`;
      if (parent.id === row.parentProjectId) option.selected = true;
      parentSelect.appendChild(option);
    }

    // Set tooltip for selected client
    if (row.parentProjectId !== null) {
      const label = row.parentProjectId === OTHERS_PARENT_ID
        ? "Others"
        : `#${row.parentProjectId} ${row.parentProjectName || ""}`;
      parentSelect.dataset.tooltip = label;
      // Context menu data (only for real projects, not "Others")
      if (row.parentProjectId !== OTHERS_PARENT_ID) {
        const parentProject = state.parentProjects.find(p => p.id === row.parentProjectId);
        parentSelect.dataset.vscodeContext = JSON.stringify({
          webviewSection: "tsClient",
          projectId: row.parentProjectId,
          projectIdentifier: parentProject?.identifier || "",
          preventDefaultContextMenuItems: true,
        });
      }
    }

    parentSelect.addEventListener("change", () => {
      const value = parentSelect.value ? parseInt(parentSelect.value, 10) : null;
      if (isAggregated && row.sourceRowIds?.length > 0) {
        vscode.postMessage({
          type: "updateAggregatedField",
          aggRowId: row.id,
          field: "parentProject",
          value,
          sourceRowIds: row.sourceRowIds,
          confirmed: false,
        });
      } else {
        vscode.postMessage({
          type: "updateRowField",
          rowId: row.id,
          field: "parentProject",
          value,
        });
      }
      // Request child projects for this parent
      if (value !== null) {
        vscode.postMessage({
          type: "requestChildProjects",
          parentId: value,
        });
      }
    });
    parentTd.appendChild(parentSelect);
    tr.appendChild(parentTd);

    // --- Project (Child) cell ---
    const projectTd = document.createElement("td");
    projectTd.className = "col-project";
    const projectSelect = document.createElement("select");
    projectSelect.className = "project-select";
    projectSelect.innerHTML = '<option value="">Project...</option>';

    // Disable if no parent selected (aggregated rows can still edit)
    const hasParent = row.parentProjectId !== null;
    projectSelect.disabled = !hasParent;

    // Populate projects from cache
    if (hasParent) {
      const children = state.childProjectsByParent.get(row.parentProjectId) || [];
      for (const child of children) {
        const option = document.createElement("option");
        option.value = child.id;
        option.textContent = `#${child.id} ${child.name}`;
        if (child.id === row.projectId) option.selected = true;
        projectSelect.appendChild(option);
      }
    }

    // Set tooltip for selected project
    if (row.projectId !== null) {
      projectSelect.dataset.tooltip = `#${row.projectId} ${row.projectName || ""}`;
      const childProject = state.projects.find(p => p.id === row.projectId);
      projectSelect.dataset.vscodeContext = JSON.stringify({
        webviewSection: "tsProject",
        projectId: row.projectId,
        projectIdentifier: childProject?.identifier || "",
        preventDefaultContextMenuItems: true,
      });
    }

    projectSelect.addEventListener("change", () => {
      const value = projectSelect.value ? parseInt(projectSelect.value, 10) : null;
      if (isAggregated && row.sourceRowIds?.length > 0) {
        vscode.postMessage({
          type: "updateAggregatedField",
          aggRowId: row.id,
          field: "project",
          value,
          sourceRowIds: row.sourceRowIds,
          confirmed: false,
        });
      } else {
        vscode.postMessage({
          type: "updateRowField",
          rowId: row.id,
          field: "project",
          value,
        });
      }
      // Request issues for this project
      if (value !== null) {
        vscode.postMessage({
          type: "requestIssues",
          projectId: value,
        });
      }
    });
    projectTd.appendChild(projectSelect);
    tr.appendChild(projectTd);

    // --- Task (Issue) cell ---
    const taskTd = document.createElement("td");
    taskTd.className = "col-task";
    const taskContent = document.createElement("div");
    taskContent.className = "task-cell-content";

    const taskSelect = document.createElement("select");
    taskSelect.className = "task-select";
    taskSelect.innerHTML = '<option value="">Task...</option>';

    // Disable if no project selected (aggregated rows can still edit)
    const hasProject = row.projectId !== null;
    taskSelect.disabled = !hasProject;

    // Populate issues from cache
    if (hasProject) {
      const issues = state.issuesByProject.get(row.projectId) || [];
      for (const issue of issues) {
        const option = document.createElement("option");
        option.value = issue.id;
        option.textContent = `#${issue.id} ${issue.subject}`;
        if (issue.id === row.issueId) option.selected = true;
        taskSelect.appendChild(option);
      }
    }

    // Set data for tooltip and context menu
    if (row.issueId !== null) {
      taskTd.dataset.issueId = row.issueId;
      taskSelect.dataset.vscodeContext = JSON.stringify({
        webviewSection: "tsTask",
        issueId: row.issueId,
        preventDefaultContextMenuItems: true,
      });
    }

    taskSelect.addEventListener("change", () => {
      const value = taskSelect.value ? parseInt(taskSelect.value, 10) : null;
      if (isAggregated && row.sourceRowIds?.length > 0) {
        vscode.postMessage({
          type: "updateAggregatedField",
          aggRowId: row.id,
          field: "issue",
          value,
          sourceRowIds: row.sourceRowIds,
          confirmed: false,
        });
      } else {
        vscode.postMessage({
          type: "updateRowField",
          rowId: row.id,
          field: "issue",
          value,
        });
      }
    });
    taskContent.appendChild(taskSelect);

    // Search button (always enabled, bypasses cascade)
    const searchBtn = document.createElement("button");
    searchBtn.className = "search-btn";
    searchBtn.textContent = "🔍";
    searchBtn.dataset.tooltip = "Search all issues";
    searchBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "pickIssue", rowId: row.id });
    });
    taskContent.appendChild(searchBtn);

    taskTd.appendChild(taskContent);
    tr.appendChild(taskTd);

    // --- Activity cell ---
    const activityTd = document.createElement("td");
    activityTd.className = "col-activity";
    const activitySelect = document.createElement("select");
    activitySelect.className = "activity-select";
    activitySelect.innerHTML = '<option value="">Activity...</option>';

    // Disable if no project selected (aggregated rows can still edit)
    activitySelect.disabled = !hasProject;

    // Populate activities if available
    const activities = state.activitiesByProject.get(row.projectId) || [];
    for (const activity of activities) {
      const option = document.createElement("option");
      option.value = activity.id;
      option.textContent = activity.name;
      if (activity.id === row.activityId) option.selected = true;
      activitySelect.appendChild(option);
    }

    // Set tooltip for selected activity
    if (row.activityId !== null && row.activityName) {
      activitySelect.dataset.tooltip = row.activityName;
    }

    activitySelect.addEventListener("change", () => {
      const value = activitySelect.value ? parseInt(activitySelect.value, 10) : null;
      if (isAggregated && row.sourceRowIds?.length > 0) {
        vscode.postMessage({
          type: "updateAggregatedField",
          aggRowId: row.id,
          field: "activity",
          value,
          sourceRowIds: row.sourceRowIds,
          confirmed: false,
        });
      } else {
        vscode.postMessage({
          type: "updateRowField",
          rowId: row.id,
          field: "activity",
          value,
        });
      }
    });
    activityTd.appendChild(activitySelect);
    tr.appendChild(activityTd);

    // --- Comments cell ---
    const commentsTd = document.createElement("td");
    commentsTd.className = "col-comments";
    const commentsInput = document.createElement("input");
    commentsInput.type = "text";
    commentsInput.className = "comments-input";
    commentsInput.value = row.comments || "";
    // Aggregated rows can edit comments (will update all source entries)
    commentsInput.addEventListener("blur", (e) => {
      const value = e.target.value.trim() || null;
      if (isAggregated && row.sourceRowIds?.length > 0) {
        vscode.postMessage({
          type: "updateAggregatedField",
          aggRowId: row.id,
          field: "comments",
          value,
          sourceRowIds: row.sourceRowIds,
          confirmed: false,
        });
      } else {
        vscode.postMessage({
          type: "updateRowField",
          rowId: row.id,
          field: "comments",
          value,
        });
      }
    });
    commentsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.target.blur();
    });
    commentsTd.appendChild(commentsInput);
    tr.appendChild(commentsTd);

    // --- Day cells ---
    const todayIndex = getTodayDayIndex(state.week);
    for (let i = 0; i < 7; i++) {
      const dayTd = document.createElement("td");
      dayTd.className = "col-day day-cell";
      dayTd.dataset.day = i;
      if (i === todayIndex) dayTd.classList.add("today");

      const cell = row.days[i] || { hours: 0, isDirty: false, sourceEntries: [] };
      const sourceEntryCount = cell.sourceEntries?.length || 0;

      // Add has-value class for cells with hours
      if (cell.hours > 0) dayTd.classList.add("has-value");

      // Mark multi-entry aggregated cells with visual indicator
      const cellKey = `${row.id}:${i}`;
      const isExpanded = state.expandedCells.has(cellKey);
      if (isAggregated && sourceEntryCount > 1) {
        dayTd.classList.add("multi-entry");
        dayTd.dataset.entryCount = sourceEntryCount;
        if (isExpanded) {
          dayTd.classList.add("expanded");
        }
      }

      const input = document.createElement("input");
      input.type = "text";
      input.className = "day-input" + (cell.isDirty ? " dirty" : "") + (cell.hours === 0 ? " zero" : "");
      // Add dashed border class for aggregated cells (editable but special)
      if (isAggregated) {
        input.classList.add("aggregated-cell-input");
      }
      input.value = formatHours(cell.hours);
      input.dataset.tooltip = state.week ? state.week.dayDates[i] : "";
      input.dataset.oldValue = cell.hours; // Store for undo
      // Store source entries for aggregated row handling
      if (isAggregated && cell.sourceEntries) {
        input.dataset.sourceEntries = JSON.stringify(cell.sourceEntries);
        input.dataset.isAggregated = "true";
      }
      // Aggregated rows are now editable
      input.addEventListener("focus", (e) => {
        e.target.dataset.oldValue = parseHours(e.target.value); // Capture before edit
        e.target.select();
      });
      input.addEventListener("blur", (e) => {
        const oldHours = parseFloat(e.target.dataset.oldValue) || 0;
        const newHours = parseHours(e.target.value);
        e.target.value = formatHours(newHours);
        // Only send message and track undo if value changed
        if (oldHours !== newHours) {
          // Check if this is an aggregated row
          if (e.target.dataset.isAggregated === "true") {
            handleAggregatedCellBlur(row, i, newHours, oldHours, cell);
          } else {
            pushUndo({
              type: "cell",
              rowId: row.id,
              dayIndex: i,
              oldValue: oldHours,
              newValue: newHours,
            });
            vscode.postMessage({
              type: "updateCell",
              rowId: row.id,
              dayIndex: i,
              hours: newHours,
            });
          }
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          // Restore old value on Escape
          e.target.value = formatHours(parseFloat(e.target.dataset.oldValue) || 0);
          e.target.blur();
        }
      });
      dayTd.appendChild(input);

      // Add expand dropdown for multi-entry cells
      if (isAggregated && sourceEntryCount > 1) {
        // Add expand button (clicking the badge)
        const expandBtn = document.createElement("button");
        expandBtn.className = "expand-btn";
        expandBtn.dataset.tooltip = isExpanded ? "Collapse" : `Expand ${sourceEntryCount} entries`;
        expandBtn.textContent = isExpanded ? "▲" : "▼";
        expandBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleCellExpand(row.id, i);
        });
        dayTd.appendChild(expandBtn);

        // Render expanded dropdown if this cell is expanded
        if (isExpanded && cell.sourceEntries) {
          const dropdown = renderExpandedCellDropdown(row, i, cell.sourceEntries);
          dayTd.appendChild(dropdown);
        }
      }

      tr.appendChild(dayTd);
    }

    // --- Row total cell ---
    const totalTd = document.createElement("td");
    totalTd.className = "col-total row-total";
    totalTd.textContent = formatHours(row.weekTotal);
    tr.appendChild(totalTd);

    // --- Actions cell ---
    const actionsTd = document.createElement("td");
    actionsTd.className = "col-actions";

    const sourceCount = isAggregated ? (row.sourceRowIds?.length || 1) : 1;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "action-btn delete-btn";
    deleteBtn.textContent = "🗑️";
    deleteBtn.dataset.tooltip = isAggregated ? `Delete ${sourceCount} entries` : "Delete";
    deleteBtn.addEventListener("click", () => {
      if (isAggregated && sourceCount > 1) {
        // Show toast with count for aggregated row deletion
        showToast(`Deleted ${sourceCount} entries`);
      }
      vscode.postMessage({ type: "deleteRow", rowId: row.id });
    });
    actionsTd.appendChild(deleteBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "action-btn copy-btn";
    copyBtn.textContent = "📋";
    copyBtn.dataset.tooltip = isAggregated ? "Duplicate as single row" : "Duplicate";
    copyBtn.addEventListener("click", () => {
      if (isAggregated) {
        showToast("Duplicated as single row");
      }
      vscode.postMessage({ type: "duplicateRow", rowId: row.id });
    });
    actionsTd.appendChild(copyBtn);

    tr.appendChild(actionsTd);

    return tr;
  }

  // Get group key for a row based on groupBy setting
  function getGroupKey(row) {
    switch (state.groupBy) {
      case "client":
        return row.parentProjectId !== null ? `client:${row.parentProjectId}` : "client:none";
      case "project":
        return row.projectId !== null ? `project:${row.projectId}` : "project:none";
      case "issue":
        return row.issueId !== null ? `issue:${row.issueId}` : "issue:none";
      case "activity":
        return row.activityId !== null ? `activity:${row.activityId}` : "activity:none";
      default:
        return null;
    }
  }

  // Get group label for display
  function getGroupLabel(row) {
    switch (state.groupBy) {
      case "client":
        // parentProjectId -1 = "Others" synthetic group
        if (row.parentProjectId === OTHERS_PARENT_ID) return row.parentProjectName || "Others";
        return row.parentProjectId ? `#${row.parentProjectId} ${row.parentProjectName || ""}` : "(No client)";
      case "project":
        return row.projectId ? `#${row.projectId} ${row.projectName || ""}` : "(No project)";
      case "issue":
        return row.issueId ? `#${row.issueId} ${row.issueSubject || ""}` : "(No task)";
      case "activity":
        return row.activityName || "(No activity)";
      default:
        return "";
    }
  }

  // Calculate group total hours
  function getGroupTotal(rows) {
    return rows.reduce((sum, r) => sum + r.weekTotal, 0);
  }

  // Render a group header row
  function renderGroupHeader(groupKey, label, total, isCollapsed) {
    const tr = document.createElement("tr");
    tr.className = "group-header" + (isCollapsed ? " collapsed" : "");
    tr.dataset.groupKey = groupKey;

    const td = document.createElement("td");
    td.colSpan = 12; // 5 data cols + 7 day cols
    td.className = "group-header-cell";

    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.textContent = isCollapsed ? "▶" : "▼";

    const labelSpan = document.createElement("span");
    labelSpan.className = "group-label";
    labelSpan.textContent = label;

    td.appendChild(chevron);
    td.appendChild(labelSpan);

    td.addEventListener("click", () => {
      if (state.collapsedGroups.has(groupKey)) {
        state.collapsedGroups.delete(groupKey);
      } else {
        state.collapsedGroups.add(groupKey);
      }
      vscode.postMessage({ type: "toggleGroup", groupKey });
      renderGrid();
    });

    tr.appendChild(td);

    // Total cell
    const totalTd = document.createElement("td");
    totalTd.className = "col-total group-total";
    totalTd.textContent = formatHours(total);
    tr.appendChild(totalTd);

    // Empty actions cell for alignment
    const actionsTd = document.createElement("td");
    actionsTd.className = "col-actions";
    tr.appendChild(actionsTd);

    return tr;
  }

  /**
   * Aggregate rows with identical (issueId, activityId, comments)
   * Merges hours per day, returns new array of aggregated rows
   * Tracks source entries per day cell for edit/undo support
   */
  function aggregateIdenticalRows(rows) {
    if (!rows || rows.length === 0) return rows;

    const groups = new Map(); // key -> merged row

    for (const row of rows) {
      // Build aggregation key: issueId:activityId:comments
      const key = `${row.issueId ?? "null"}:${row.activityId ?? "null"}:${row.comments ?? ""}`;

      if (!groups.has(key)) {
        // Create new aggregated row (copy structure)
        const aggRow = {
          ...row,
          id: `agg-${key}`, // Mark as aggregated
          isAggregated: true, // Flag for special handling
          sourceRowIds: [row.id], // Track original rows
          days: {},
          weekTotal: 0,
        };
        // Copy days with source entry tracking
        for (let d = 0; d < 7; d++) {
          if (row.days[d]) {
            const sourceEntries = [];
            // Only add source entry if there's an actual entry (not new row)
            if (row.days[d].entryId && row.days[d].hours > 0) {
              sourceEntries.push({
                rowId: row.id,
                entryId: row.days[d].entryId,
                hours: row.days[d].hours,
                issueId: row.issueId,
                activityId: row.activityId,
                comments: row.comments,
                spentOn: state.week?.dayDates[d] || "",
              });
            }
            aggRow.days[d] = {
              hours: row.days[d].hours,
              originalHours: row.days[d].originalHours,
              entryId: null, // Aggregated has no single entry
              isDirty: false,
              sourceEntries,
            };
            aggRow.weekTotal += row.days[d].hours || 0;
          }
        }
        groups.set(key, aggRow);
      } else {
        // Merge into existing aggregated row
        const aggRow = groups.get(key);
        aggRow.sourceRowIds.push(row.id);
        for (let d = 0; d < 7; d++) {
          if (row.days[d]) {
            if (!aggRow.days[d]) {
              aggRow.days[d] = {
                hours: 0,
                originalHours: 0,
                entryId: null,
                isDirty: false,
                sourceEntries: [],
              };
            }
            aggRow.days[d].hours += row.days[d].hours || 0;
            aggRow.days[d].originalHours += row.days[d].originalHours || 0;
            aggRow.weekTotal += row.days[d].hours || 0;
            // Add source entry for this day
            if (row.days[d].entryId && row.days[d].hours > 0) {
              aggRow.days[d].sourceEntries.push({
                rowId: row.id,
                entryId: row.days[d].entryId,
                hours: row.days[d].hours,
                issueId: row.issueId,
                activityId: row.activityId,
                comments: row.comments,
                spentOn: state.week?.dayDates[d] || "",
              });
            }
          }
        }
      }
    }

    return [...groups.values()];
  }

  // Render grid
  function renderGrid() {
    gridBody.innerHTML = "";

    // Get rows to render (aggregated or original)
    const rowsToRender = state.aggregateRows
      ? aggregateIdenticalRows(state.rows)
      : state.rows;

    if (rowsToRender.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      const td = document.createElement("td");
      td.colSpan = 14;
      td.textContent = "No time entries yet.";
      tr.appendChild(td);
      gridBody.appendChild(tr);
    } else if (state.groupBy === "none") {
      // No grouping - flat list
      const sortedRows = sortRows(rowsToRender);
      for (const row of sortedRows) {
        gridBody.appendChild(renderRow(row));
      }
    } else {
      // Grouped rendering
      const groups = new Map(); // groupKey -> { label, rows }

      // First pass: organize rows into groups
      for (const row of rowsToRender) {
        const groupKey = getGroupKey(row);
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { label: getGroupLabel(row), rows: [] });
        }
        groups.get(groupKey).rows.push(row);
      }

      // Sort groups by label
      const sortedGroups = [...groups.entries()].sort((a, b) =>
        a[1].label.localeCompare(b[1].label)
      );

      // Render each group
      for (const [groupKey, group] of sortedGroups) {
        const isCollapsed = state.collapsedGroups.has(groupKey);
        const total = getGroupTotal(group.rows);

        // Group header
        gridBody.appendChild(renderGroupHeader(groupKey, group.label, total, isCollapsed));

        // Rows (if not collapsed)
        if (!isCollapsed) {
          // Sort rows within group
          const sortedGroupRows = sortRows(group.rows);
          for (const row of sortedGroupRows) {
            gridBody.appendChild(renderRow(row));
          }
        }
      }
    }

    renderTotals();
    updateSortIndicators();
  }

  // Sort rows (extracted for reuse in grouping)
  function sortRows(rows) {
    if (!state.sortColumn) return rows;
    return [...rows].sort((a, b) => {
      let valA, valB;
      switch (state.sortColumn) {
        case "client":
          valA = a.parentProjectName || "";
          valB = b.parentProjectName || "";
          break;
        case "project":
          valA = a.projectName || "";
          valB = b.projectName || "";
          break;
        case "task":
          valA = a.issueId || 0;
          valB = b.issueId || 0;
          break;
        case "activity":
          valA = a.activityName || "";
          valB = b.activityName || "";
          break;
        case "comments":
          valA = a.comments || "";
          valB = b.comments || "";
          break;
        case "total":
          valA = a.weekTotal;
          valB = b.weekTotal;
          break;
        default:
          return 0;
      }
      const cmp = typeof valA === "string" ? valA.localeCompare(valB) : valA - valB;
      return state.sortDirection === "asc" ? cmp : -cmp;
    });
  }

  // Render totals row
  function renderTotals() {
    if (!state.totals) return;

    const todayIndex = getTodayDayIndex(state.week);
    const dayCells = totalsRow.querySelectorAll(".col-day.total-cell");
    dayCells.forEach((cell, i) => {
      const hours = state.totals.days[i];
      const target = state.totals.targetHours[i];

      // Update value display - always show "hours / target" format
      const valueSpan = cell.querySelector(".total-value");
      if (valueSpan) {
        const hoursDisplay = hours === 0 ? "0" : formatHours(hours);
        valueSpan.textContent = `${hoursDisplay} / ${target}`;
      }

      // Update progress bar
      const progressFill = cell.querySelector(".progress-fill");
      if (progressFill && target > 0) {
        const percent = Math.min((hours / target) * 100, 100);
        progressFill.style.width = `${percent}%`;
        progressFill.classList.remove("met", "over");
        if (hours > target) {
          progressFill.classList.add("over");
        } else if (hours >= target) {
          progressFill.classList.add("met");
        }
      } else if (progressFill) {
        progressFill.style.width = "0%";
      }

      // Today highlight
      cell.classList.toggle("today", i === todayIndex);
    });

    // Week total - always show "hours / target" format
    const targetTotal = state.totals.weekTargetTotal;
    const weekHours = state.totals.weekTotal;
    const weekHoursDisplay = weekHours === 0 ? "0" : formatHours(weekHours);
    weekTotal.textContent = `${weekHoursDisplay} / ${targetTotal}`;
  }

  // Update a single row
  function updateRow(row, totals) {
    const existingRow = gridBody.querySelector(`tr[data-row-id="${row.id}"]`);
    if (existingRow) {
      const newRow = renderRow(row);
      existingRow.replaceWith(newRow);
    }
    if (totals) {
      state.totals = totals;
      renderTotals();
    }
  }

  // Handle messages from extension
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "render":
        state.rows = message.rows;
        state.week = message.week;
        state.totals = message.totals;
        state.projects = message.projects;
        state.parentProjects = message.parentProjects || [];
        state.isDraftMode = message.isDraftMode;
        // Apply persisted sort state
        state.sortColumn = message.sortColumn ?? null;
        state.sortDirection = message.sortDirection ?? "asc";
        // Apply persisted grouping state
        state.groupBy = message.groupBy ?? "none";
        state.collapsedGroups = new Set(message.collapsedGroups || []);
        state.aggregateRows = message.aggregateRows ?? false;
        // Update dropdowns and toggles
        if (groupBySelect) groupBySelect.value = state.groupBy;
        const aggregateToggle = document.getElementById("aggregateToggle");
        if (aggregateToggle) aggregateToggle.checked = state.aggregateRows;
        weekLabel.textContent = formatWeekLabel(state.week);
        // Update header for weekend
        updateWeekHeaders();
        // Update draft mode UI
        updateDraftModeUI();
        renderGrid();
        break;

      case "updateRow":
        // Find and update the row in state
        const rowIndex = state.rows.findIndex((r) => r.id === message.row.id);
        if (rowIndex !== -1) {
          state.rows[rowIndex] = message.row;
        }
        state.totals = message.totals;
        updateRow(message.row, message.totals);
        break;

      case "updateChildProjects":
        state.childProjectsByParent.set(message.forParentId, message.projects);
        // Re-render rows for this parent
        for (const row of state.rows) {
          if (row.parentProjectId === message.forParentId) {
            updateRow(row, null);
          }
        }
        break;

      case "updateIssues":
        state.issuesByProject.set(message.forProjectId, message.issues);
        // Re-render rows for this project
        for (const row of state.rows) {
          if (row.projectId === message.forProjectId) {
            updateRow(row, null);
          }
        }
        break;

      case "updateActivities":
        state.activitiesByProject.set(message.forProjectId, message.activities);
        // Re-render rows for this project to show activities
        for (const row of state.rows) {
          if (row.projectId === message.forProjectId) {
            updateRow(row, null);
          }
        }
        break;

      case "setLoading":
        loadingOverlay.classList.toggle("hidden", !message.loading);
        break;

      case "weekChanged":
        state.week = message.week;
        weekLabel.textContent = formatWeekLabel(state.week);
        updateWeekHeaders();
        break;

      case "showError":
        console.error(message.message);
        // Could show a toast notification
        break;

      case "draftModeChanged":
        state.isDraftMode = message.isDraftMode;
        updateDraftModeUI();
        break;

      case "updateIssueDetails":
        state.issueDetails.set(message.issueId, message.details);
        // If we're waiting to show tooltip for this issue, show it now
        if (pendingTooltipIssueId === message.issueId && tooltipTarget) {
          showIssueTooltip(tooltipTarget, pendingTooltipX, pendingTooltipY);
          pendingTooltipIssueId = null;
        }
        break;
      case "rowDuplicated":
        // Push undo action for the duplicated row
        pushUndo({
          type: "duplicateRow",
          sourceRowId: message.sourceRowId,
          newRowId: message.newRowId,
        });
        break;
      case "rowDeleted":
        // Push undo action for the deleted row
        pushUndo({
          type: "deleteRow",
          deletedRow: message.deletedRow,
        });
        break;

      case "showToast":
        showToast(message.message, message.undoAction, message.duration);
        break;

      case "requestAggregatedCellConfirm":
        // Extension is asking us to confirm editing multiple entries
        handleAggregatedCellConfirm(message);
        break;
    }
  });

  // Update header cells with dates
  function updateWeekHeaders() {
    if (!state.week) return;
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const headerCells = document.querySelectorAll("thead .col-day");
    const todayIndex = getTodayDayIndex(state.week);
    headerCells.forEach((cell, i) => {
      const date = new Date(state.week.dayDates[i] + "T12:00:00");
      const day = date.getDate();
      cell.textContent = `${dayNames[i]} ${day}`;
      cell.classList.toggle("today", i === todayIndex);
    });
  }

  // Update sort indicators on headers
  function updateSortIndicators() {
    const sortableHeaders = document.querySelectorAll("thead .sortable");
    sortableHeaders.forEach((header) => {
      const sortKey = header.dataset.sort;
      const existingIndicator = header.querySelector(".sort-indicator");
      if (existingIndicator) existingIndicator.remove();

      if (sortKey === state.sortColumn) {
        const indicator = document.createElement("span");
        indicator.className = "sort-indicator";
        indicator.textContent = state.sortDirection === "asc" ? "▲" : "▼";
        header.appendChild(indicator);
      }
    });
  }

  // Handle sort header click
  function handleSortClick(sortKey) {
    if (state.sortColumn === sortKey) {
      if (state.sortDirection === "asc") {
        state.sortDirection = "desc";
      } else {
        // Clear sort
        state.sortColumn = null;
        state.sortDirection = "asc";
      }
    } else {
      state.sortColumn = sortKey;
      state.sortDirection = "asc";
    }
    // Notify extension to persist
    vscode.postMessage({
      type: "sortChanged",
      sortColumn: state.sortColumn,
      sortDirection: state.sortDirection,
    });
    renderGrid();
  }

  // Setup sort header click handlers
  function setupSortHandlers() {
    const sortableHeaders = document.querySelectorAll("thead .sortable");
    sortableHeaders.forEach((header) => {
      const sortKey = header.dataset.sort;
      if (sortKey) {
        header.addEventListener("click", () => handleSortClick(sortKey));
      }
    });
  }

  // Event listeners
  document.getElementById("prevWeek")?.addEventListener("click", () => {
    vscode.postMessage({ type: "navigateWeek", direction: "prev" });
  });

  document.getElementById("nextWeek")?.addEventListener("click", () => {
    vscode.postMessage({ type: "navigateWeek", direction: "next" });
  });

  document.getElementById("todayBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "navigateWeek", direction: "today" });
  });

  document.getElementById("saveBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "saveAll" });
  });

  // Grouping dropdown
  groupBySelect?.addEventListener("change", (e) => {
    state.groupBy = e.target.value;
    vscode.postMessage({ type: "setGroupBy", groupBy: state.groupBy });
    renderGrid();
  });

  // Aggregate toggle
  document.getElementById("aggregateToggle")?.addEventListener("change", (e) => {
    state.aggregateRows = e.target.checked;
    vscode.postMessage({ type: "setAggregateRows", aggregateRows: state.aggregateRows });
    renderGrid();
  });

  // Copy/Paste buttons
  document.getElementById("copyWeekBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "copyWeek" });
  });

  document.getElementById("pasteWeekBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "pasteWeek" });
  });

  // Enable Draft Mode button
  enableDraftModeBtn?.addEventListener("click", () => {
    vscode.postMessage({ type: "enableDraftMode" });
  });

  // Add time entry button
  addEntryBtn?.addEventListener("click", () => {
    vscode.postMessage({ type: "addRow" });
  });

  // Undo/redo buttons
  undoBtn?.addEventListener("click", () => {
    undo();
  });

  redoBtn?.addEventListener("click", () => {
    redo();
  });

  // Setup sort handlers on page load
  setupSortHandlers();

  // Keyboard shortcuts for undo/redo and navigation
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;
    const isInInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT";

    if (ctrlOrCmd && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (ctrlOrCmd && e.key === "z" && e.shiftKey) {
      e.preventDefault();
      redo();
    } else if (ctrlOrCmd && e.key === "y" && !isMac) {
      // Ctrl+Y for redo on Windows/Linux
      e.preventDefault();
      redo();
    } else if (e.key.toLowerCase() === "t" && !ctrlOrCmd && !e.altKey && !isInInput) {
      // T for Today (when not in input field)
      e.preventDefault();
      vscode.postMessage({ type: "navigateWeek", direction: "today" });
    }
  });

  // ========== Issue Tooltips ==========
  const issueTooltip = document.getElementById("issueTooltip");
  const tooltipContent = issueTooltip?.querySelector(".issue-tooltip-content");

  let tooltipTarget = null;
  let tooltipShowTimer = null;
  let tooltipHideTimer = null;
  let pendingTooltipIssueId = null;
  let pendingTooltipX = 0;
  let pendingTooltipY = 0;

  function showIssueTooltip(target, x, y) {
    if (!issueTooltip || !tooltipContent) return;

    const issueId = parseInt(target.dataset.issueId, 10);
    if (!issueId) return;

    const details = state.issueDetails.get(issueId);
    if (!details) {
      // Request details from extension and track pending state
      pendingTooltipIssueId = issueId;
      pendingTooltipX = x;
      pendingTooltipY = y;
      vscode.postMessage({ type: "requestIssueDetails", issueId });
      return;
    }

    // Build tooltip content
    tooltipContent.innerHTML = "";

    // Title line
    const title = document.createElement("div");
    title.className = "issue-tooltip-line issue-tooltip-title";
    title.textContent = `#${details.id} ${details.subject}`;
    tooltipContent.appendChild(title);

    // Divider
    const divider = document.createElement("div");
    divider.className = "issue-tooltip-divider";
    tooltipContent.appendChild(divider);

    // Standard fields
    const fields = [
      { key: "Status", value: details.status },
      { key: "Priority", value: details.priority },
      { key: "Tracker", value: details.tracker },
      { key: "Assignee", value: details.assignedTo || "Unassigned" },
      { key: "Done", value: `${details.doneRatio}%` },
    ];

    if (details.estimatedHours !== null) {
      fields.push({ key: "Estimated", value: `${details.estimatedHours}h` });
    }
    if (details.spentHours !== null) {
      fields.push({ key: "Spent", value: `${details.spentHours}h` });
    }
    if (details.startDate) {
      fields.push({ key: "Start", value: details.startDate });
    }
    if (details.dueDate) {
      fields.push({ key: "Due", value: details.dueDate });
    }

    for (const field of fields) {
      const line = document.createElement("div");
      line.className = "issue-tooltip-line";
      const keySpan = document.createElement("span");
      keySpan.className = "issue-tooltip-key";
      keySpan.textContent = `${field.key}: `;
      line.appendChild(keySpan);
      line.appendChild(document.createTextNode(field.value));
      tooltipContent.appendChild(line);
    }

    // Custom fields
    if (details.customFields && details.customFields.length > 0) {
      const cfDivider = document.createElement("div");
      cfDivider.className = "issue-tooltip-divider";
      tooltipContent.appendChild(cfDivider);

      for (const cf of details.customFields) {
        const line = document.createElement("div");
        line.className = "issue-tooltip-line";
        const keySpan = document.createElement("span");
        keySpan.className = "issue-tooltip-key";
        keySpan.textContent = `${cf.name}: `;
        line.appendChild(keySpan);
        line.appendChild(document.createTextNode(cf.value));
        tooltipContent.appendChild(line);
      }
    }

    // Position tooltip
    positionTooltip(x, y);
    issueTooltip.classList.add("visible");
    issueTooltip.setAttribute("aria-hidden", "false");
  }

  function positionTooltip(x, y) {
    const padding = 8;
    const offset = 12;
    issueTooltip.style.left = "0";
    issueTooltip.style.top = "0";
    const rect = issueTooltip.getBoundingClientRect();
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

    issueTooltip.style.left = `${Math.round(left)}px`;
    issueTooltip.style.top = `${Math.round(top)}px`;
  }

  function hideIssueTooltip() {
    if (tooltipShowTimer) {
      clearTimeout(tooltipShowTimer);
      tooltipShowTimer = null;
    }
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    tooltipTarget = null;
    pendingTooltipIssueId = null;
    issueTooltip?.classList.remove("visible");
    issueTooltip?.setAttribute("aria-hidden", "true");
  }

  // Event delegation for tooltip on task cells
  document.addEventListener("pointerover", (e) => {
    const target = e.target.closest("[data-issue-id]");
    if (!target || !gridBody.contains(target)) {
      return;
    }
    if (tooltipTarget === target) return;

    // Cancel any pending hide
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    tooltipTarget = target;

    // Delay before showing
    if (tooltipShowTimer) clearTimeout(tooltipShowTimer);
    tooltipShowTimer = setTimeout(() => {
      tooltipShowTimer = null;
      if (tooltipTarget === target) {
        showIssueTooltip(target, e.clientX, e.clientY);
      }
    }, 400);
  }, true);

  document.addEventListener("pointerout", (e) => {
    const target = e.target.closest("[data-issue-id]");
    if (!target || target !== tooltipTarget) return;

    // Check if we're moving to another element within the same tooltip target
    const relatedTarget = e.relatedTarget;
    if (relatedTarget && target.contains(relatedTarget)) {
      // Still within the same element, don't hide
      return;
    }

    // Cancel pending show
    if (tooltipShowTimer) {
      clearTimeout(tooltipShowTimer);
      tooltipShowTimer = null;
    }

    // Delay before hiding
    tooltipHideTimer = setTimeout(() => {
      hideIssueTooltip();
    }, 100);
  }, true);

  // Hide tooltip on scroll
  document.querySelector(".timesheet-grid-container")?.addEventListener("scroll", () => {
    hideIssueTooltip();
  });

  // ========== Generic Tooltip (for data-tooltip attributes) ==========
  const genericTooltip = document.getElementById("genericTooltip");
  let genericTooltipTarget = null;
  let genericTooltipTimer = null;

  function showGenericTooltip(target, x, y) {
    if (!genericTooltip) return;
    const text = target.dataset.tooltip;
    if (!text) return;

    genericTooltip.textContent = text;

    // Position tooltip
    const padding = 8;
    const offset = 10;
    genericTooltip.style.left = "0";
    genericTooltip.style.top = "0";
    genericTooltip.classList.add("visible");

    const rect = genericTooltip.getBoundingClientRect();
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

    genericTooltip.style.left = `${Math.round(left)}px`;
    genericTooltip.style.top = `${Math.round(top)}px`;
  }

  function hideGenericTooltip() {
    if (genericTooltipTimer) {
      clearTimeout(genericTooltipTimer);
      genericTooltipTimer = null;
    }
    genericTooltipTarget = null;
    genericTooltip?.classList.remove("visible");
  }

  // Event delegation for generic tooltips
  document.addEventListener("pointerover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    // Skip if this is an issue tooltip target (handled separately)
    if (!target || target.dataset.issueId) return;
    if (genericTooltipTarget === target) return;

    hideGenericTooltip();
    genericTooltipTarget = target;

    genericTooltipTimer = setTimeout(() => {
      genericTooltipTimer = null;
      if (genericTooltipTarget === target) {
        showGenericTooltip(target, e.clientX, e.clientY);
      }
    }, 400);
  }, true);

  document.addEventListener("pointerout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target || target !== genericTooltipTarget) return;

    const relatedTarget = e.relatedTarget;
    if (relatedTarget && target.contains(relatedTarget)) return;

    hideGenericTooltip();
  }, true);

  // Hide generic tooltip on scroll
  document.querySelector(".timesheet-grid-container")?.addEventListener("scroll", () => {
    hideGenericTooltip();
  });

  // ========== Toast Notification System ==========
  let activeToast = null;
  let toastTimeout = null;

  function showToast(message, undoAction = null, duration = 5000) {
    // Remove existing toast if any
    hideToast();

    const toast = document.createElement("div");
    toast.className = "toast-notification";
    toast.innerHTML = `
      <span class="toast-message">${escapeHtml(message)}</span>
      ${undoAction ? '<button class="toast-undo-btn">Undo</button>' : ''}
      <button class="toast-dismiss-btn">×</button>
    `;

    // Add undo handler
    if (undoAction) {
      const undoBtn = toast.querySelector(".toast-undo-btn");
      undoBtn?.addEventListener("click", () => {
        vscode.postMessage(undoAction);
        hideToast();
      });
    }

    // Dismiss handler
    const dismissBtn = toast.querySelector(".toast-dismiss-btn");
    dismissBtn?.addEventListener("click", () => hideToast());

    document.body.appendChild(toast);
    activeToast = toast;

    // Trigger enter animation
    requestAnimationFrame(() => {
      toast.classList.add("visible");
    });

    // Auto-dismiss
    if (duration > 0) {
      toastTimeout = setTimeout(() => hideToast(), duration);
    }
  }

  function hideToast() {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
    if (activeToast) {
      activeToast.classList.remove("visible");
      activeToast.classList.add("hiding");
      setTimeout(() => {
        activeToast?.remove();
        activeToast = null;
      }, 200);
    }
  }

  /**
   * Toggle expand/collapse state for a multi-entry cell
   */
  function toggleCellExpand(rowId, dayIndex) {
    const cellKey = `${rowId}:${dayIndex}`;
    if (state.expandedCells.has(cellKey)) {
      state.expandedCells.delete(cellKey);
    } else {
      // Collapse all other cells first (only one expanded at a time)
      state.expandedCells.clear();
      state.expandedCells.add(cellKey);
    }
    render();
  }

  /**
   * Collapse all expanded cells
   */
  function collapseAllCells() {
    if (state.expandedCells.size > 0) {
      state.expandedCells.clear();
      render();
    }
  }

  /**
   * Render expanded dropdown for multi-entry cell
   */
  function renderExpandedCellDropdown(row, dayIndex, sourceEntries) {
    const dropdown = document.createElement("div");
    dropdown.className = "expanded-cell-dropdown";

    // Prevent clicks inside dropdown from bubbling
    dropdown.addEventListener("click", (e) => e.stopPropagation());

    // Header showing total
    const header = document.createElement("div");
    header.className = "dropdown-header";
    const totalHours = sourceEntries.reduce((sum, e) => sum + e.hours, 0);
    header.textContent = `${sourceEntries.length} entries (${formatHours(totalHours)})`;
    dropdown.appendChild(header);

    // List of individual entries
    const list = document.createElement("div");
    list.className = "dropdown-entry-list";

    for (const entry of sourceEntries) {
      const entryRow = document.createElement("div");
      entryRow.className = "dropdown-entry";

      // Hours input
      const hoursInput = document.createElement("input");
      hoursInput.type = "text";
      hoursInput.className = "dropdown-entry-hours";
      hoursInput.value = formatHours(entry.hours);
      hoursInput.dataset.entryId = entry.entryId;
      hoursInput.dataset.rowId = entry.rowId;
      hoursInput.dataset.oldValue = entry.hours;
      hoursInput.addEventListener("focus", (e) => {
        e.target.dataset.oldValue = parseHours(e.target.value);
        e.target.select();
      });
      hoursInput.addEventListener("blur", (e) => {
        const oldHours = parseFloat(e.target.dataset.oldValue) || 0;
        const newHours = parseHours(e.target.value);
        e.target.value = formatHours(newHours);
        if (oldHours !== newHours) {
          // Update individual entry
          vscode.postMessage({
            type: "updateExpandedEntry",
            rowId: entry.rowId,
            entryId: entry.entryId,
            dayIndex,
            newHours,
            oldHours,
          });
        }
      });
      hoursInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") {
          e.target.value = formatHours(parseFloat(e.target.dataset.oldValue) || 0);
          e.target.blur();
        }
      });
      entryRow.appendChild(hoursInput);

      // Entry ID label
      const idLabel = document.createElement("span");
      idLabel.className = "dropdown-entry-id";
      idLabel.textContent = `#${entry.entryId}`;
      entryRow.appendChild(idLabel);

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "dropdown-entry-delete";
      deleteBtn.textContent = "×";
      deleteBtn.dataset.tooltip = "Delete this entry";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "deleteExpandedEntry",
          rowId: entry.rowId,
          entryId: entry.entryId,
          aggRowId: row.id,
          dayIndex,
        });
        showToast("Deleted 1 entry");
      });
      entryRow.appendChild(deleteBtn);

      list.appendChild(entryRow);
    }
    dropdown.appendChild(list);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "dropdown-close-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapseAllCells();
    });
    dropdown.appendChild(closeBtn);

    return dropdown;
  }

  /**
   * Handle blur on aggregated cell
   * Determines the appropriate action based on source entry count
   */
  function handleAggregatedCellBlur(row, dayIndex, newHours, oldHours, cell) {
    const sourceEntries = cell.sourceEntries || [];
    const sourceCount = sourceEntries.length;

    if (sourceCount === 0) {
      // Empty aggregated cell → create new entry (no confirm)
      vscode.postMessage({
        type: "updateAggregatedCell",
        aggRowId: row.id,
        dayIndex,
        newHours,
        sourceEntries: [],
        confirmed: true,
      });
      showToast("Created entry");
    } else if (sourceCount === 1) {
      // Single source entry → simple update (no confirm)
      vscode.postMessage({
        type: "updateAggregatedCell",
        aggRowId: row.id,
        dayIndex,
        newHours,
        sourceEntries,
        confirmed: true,
      });
      showToast("Updated 1 entry");
    } else {
      // Multiple source entries → send to extension (may need confirm)
      vscode.postMessage({
        type: "updateAggregatedCell",
        aggRowId: row.id,
        dayIndex,
        newHours,
        sourceEntries,
        confirmed: false, // Extension will request confirm via toast
      });
    }
  }

  /**
   * Handle confirmation request for editing aggregated cell with multiple entries
   * Uses toast+undo pattern instead of blocking confirm dialog
   */
  function handleAggregatedCellConfirm(message) {
    const { aggRowId, dayIndex, newHours, oldHours, sourceEntryCount, sourceEntries } = message;

    // Apply immediately with toast showing undo option
    const action = newHours === 0 ? "Deleted" : "Replaced";
    showToast(
      `${action} ${sourceEntryCount} entries`,
      {
        type: "restoreAggregatedEntries",
        entries: sourceEntries,
        aggRowId,
        dayIndex,
      },
      5000
    );

    // Send confirmed message to extension
    vscode.postMessage({
      type: "updateAggregatedCell",
      aggRowId,
      dayIndex,
      newHours,
      sourceEntries,
      confirmed: true,
    });
  }

  // Notify extension that webview is ready
  vscode.postMessage({ type: "webviewReady" });
})();
