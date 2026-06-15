"use strict";
(() => {
  // src/webviews/timesheet/index.js
  (() => {
    const vscode = acquireVsCodeApi();
    const OTHERS_PARENT_ID = -1;
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO_STACK = 50;
    let state = {
      expandedCells: /* @__PURE__ */ new Set(),
      // Set of "rowId:dayIndex" for expanded multi-entry cells
      issueDetails: /* @__PURE__ */ new Map()
      // issueId -> IssueDetails (cached for tooltips)
    };
    let lastRenderContext = null;
    let pendingFocus = null;
    function pushUndo(action) {
      undoStack.push(action);
      if (undoStack.length > MAX_UNDO_STACK) {
        undoStack.shift();
      }
      redoStack.length = 0;
      updateUndoRedoButtons();
    }
    function undo() {
      if (undoStack.length === 0) {
        return;
      }
      const action = undoStack.pop();
      if (action.type === "barrier") {
        showToast(action.message || "Cannot undo this action");
        updateUndoRedoButtons();
        return;
      }
      redoStack.push(action);
      applyAction(action, true);
      updateUndoRedoButtons();
    }
    function redo() {
      if (redoStack.length === 0) {
        return;
      }
      const action = redoStack.pop();
      if (action.type === "paste") {
        showToast("Redo paste not supported - use Paste again");
        updateUndoRedoButtons();
        return;
      }
      undoStack.push(action);
      applyAction(action, false);
      updateUndoRedoButtons();
    }
    function updateUndoRedoButtons() {
      if (undoBtn) undoBtn.disabled = undoStack.length === 0;
      if (redoBtn) redoBtn.disabled = redoStack.length === 0;
    }
    function applyAction(action, isUndo) {
      const value = isUndo ? action.oldValue : action.newValue;
      switch (action.type) {
        case "cell":
          vscode.postMessage({
            type: "updateCell",
            rowId: action.rowId,
            dayIndex: action.dayIndex,
            hours: value,
            skipUndo: true
          });
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
            value,
            skipUndo: true
          });
          break;
        case "duplicateRow":
          if (isUndo) {
            vscode.postMessage({
              type: "deleteRow",
              rowId: action.newRowId,
              skipUndo: true
            });
          } else {
            vscode.postMessage({
              type: "duplicateRow",
              rowId: action.sourceRowId
            });
          }
          break;
        case "deleteRow":
          if (isUndo) {
            vscode.postMessage({
              type: "restoreRow",
              row: action.deletedRow
            });
          } else {
            vscode.postMessage({
              type: "deleteRow",
              rowId: action.deletedRow.id,
              skipUndo: true
            });
          }
          break;
        case "aggregatedCell":
          if (isUndo && (action.sourceEntries?.length || 0) > 1) {
            vscode.postMessage({
              type: "restoreAggregatedEntries",
              entries: action.sourceEntries,
              aggRowId: action.aggRowId,
              dayIndex: action.dayIndex
            });
            break;
          }
          vscode.postMessage({
            type: "updateAggregatedCell",
            aggRowId: action.aggRowId,
            dayIndex: action.dayIndex,
            newHours: value,
            sourceEntries: action.sourceEntries,
            confirmed: true,
            skipUndo: true
          });
          const aggInput = document.querySelector(
            `tr[data-row-id="${action.aggRowId}"] .day-cell[data-day="${action.dayIndex}"] .day-input`
          );
          if (aggInput) {
            aggInput.value = formatHours(value);
            aggInput.classList.toggle("zero", value === 0);
          }
          break;
        case "aggregatedField":
          vscode.postMessage({
            type: "updateAggregatedField",
            aggRowId: action.aggRowId,
            field: action.field,
            value,
            sourceRowIds: action.sourceRowIds,
            confirmed: true,
            skipUndo: true
          });
          const fieldInput = document.querySelector(
            `tr[data-row-id="${action.aggRowId}"] .comments-input`
          );
          if (fieldInput) {
            fieldInput.value = value || "";
          }
          break;
        case "expandedEntry":
          vscode.postMessage({
            type: "updateExpandedEntry",
            rowId: action.rowId,
            entryId: action.entryId,
            dayIndex: action.dayIndex,
            newHours: value,
            oldHours: isUndo ? action.newValue : action.oldValue,
            skipUndo: true
          });
          break;
        case "paste":
          vscode.postMessage({
            type: "undoPaste",
            draftIds: action.draftIds
          });
          showToast(`Undid paste of ${action.count} entries`);
          break;
      }
    }
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
    let weekPicker = null;
    if (typeof flatpickr !== "undefined" && weekPickerInput) {
      weekPicker = flatpickr(weekPickerInput, {
        weekNumbers: true,
        locale: { firstDayOfWeek: 1 },
        // Monday
        positionElement: weekLabel,
        // Position relative to week label
        plugins: typeof weekSelectPlugin !== "undefined" ? [new weekSelectPlugin({})] : [],
        onChange: function(selectedDates) {
          if (selectedDates.length > 0) {
            const selectedDate = selectedDates[0];
            const year = selectedDate.getFullYear();
            const month = String(selectedDate.getMonth() + 1).padStart(2, "0");
            const day = String(selectedDate.getDate()).padStart(2, "0");
            const dateStr = `${year}-${month}-${day}`;
            vscode.postMessage({ type: "navigateWeek", direction: "date", targetDate: dateStr });
          }
        },
        onReady: function(selectedDates, dateStr, instance) {
          const thisWeekBtn = document.createElement("button");
          thisWeekBtn.className = "flatpickr-this-week-btn";
          thisWeekBtn.textContent = "This week";
          thisWeekBtn.type = "button";
          thisWeekBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            instance.jumpToDate(/* @__PURE__ */ new Date());
          });
          instance.calendarContainer.appendChild(thisWeekBtn);
        },
        onOpen: function(selectedDates, dateStr, instance) {
          instance._escHandler = function(e) {
            if (e.key === "Escape") {
              instance.close();
            }
          };
          document.addEventListener("keydown", instance._escHandler);
        },
        onClose: function(selectedDates, dateStr, instance) {
          if (instance._escHandler) {
            document.removeEventListener("keydown", instance._escHandler);
            instance._escHandler = null;
          }
        }
      });
      weekLabel?.addEventListener("click", () => {
        if (weekPicker) {
          if (lastRenderContext?.week?.startDate) {
            weekPicker.setDate(lastRenderContext.week.startDate, false);
          }
          weekPicker.open();
        }
      });
    }
    function updateDraftModeUI(ctx) {
      if (ctx.isDraftMode) {
        draftModeWarning.classList.add("hidden");
        document.body.classList.remove("draft-mode-disabled");
      } else {
        draftModeWarning.classList.remove("hidden");
        document.body.classList.add("draft-mode-disabled");
      }
    }
    function formatWeekLabel(week) {
      if (!week) return "Loading...";
      const startDate = /* @__PURE__ */ new Date(week.startDate + "T12:00:00");
      const endDate = /* @__PURE__ */ new Date(week.endDate + "T12:00:00");
      const options = { day: "numeric", month: "short" };
      const startStr = startDate.toLocaleDateString("en-US", options);
      const endStr = endDate.toLocaleDateString("en-US", options);
      return `W${String(week.weekNumber).padStart(2, "0")} (${startStr} - ${endStr} ${week.year})`;
    }
    function formatHours(hours) {
      if (hours === 0) return "";
      if (hours === Math.floor(hours)) return hours.toString();
      return String(Number(hours.toFixed(2)));
    }
    function formatHoursAsHHMM(hours) {
      const totalMinutes = Math.round(hours * 60);
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      return `${h}:${m.toString().padStart(2, "0")}`;
    }
    function parseHours(value) {
      const str = value.trim();
      if (!str) return 0;
      if (str.includes(":")) {
        const [h, m] = str.split(":").map(Number);
        if (!Number.isFinite(h)) return 0;
        return Math.max(0, h + (Number.isFinite(m) ? m : 0) / 60);
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
    function wouldExceed24Hours(dayIndex, oldHours, newHours) {
      if (!lastRenderContext?.totals?.days) return false;
      const currentDayTotal = lastRenderContext.totals.days[dayIndex] || 0;
      const newDayTotal = currentDayTotal - oldHours + newHours;
      return newDayTotal > 24;
    }
    function escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function getTodayDayIndex(week) {
      if (!week) return -1;
      const today = /* @__PURE__ */ new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
      return week.dayDates.indexOf(todayStr);
    }
    function renderRow(row, ctx) {
      const tr = document.createElement("tr");
      tr.dataset.rowId = row.id;
      const isAggregated = row.isAggregated === true;
      if (isAggregated) {
        tr.classList.add("aggregated-row");
      }
      const isIncomplete = row.isNew && (!row.issueId || !row.activityId) && row.weekTotal > 0;
      if (isIncomplete) {
        tr.classList.add("incomplete-row");
      }
      const parentTd = document.createElement("td");
      parentTd.className = "col-parent";
      const parentSelect = document.createElement("select");
      parentSelect.className = "parent-select";
      parentSelect.innerHTML = '<option value="">Client...</option>';
      for (const parent of ctx.parentProjects) {
        const option = document.createElement("option");
        option.value = parent.id;
        option.textContent = parent.id === OTHERS_PARENT_ID ? parent.name : `#${parent.id} ${parent.name}`;
        if (parent.id === row.parentProjectId) option.selected = true;
        parentSelect.appendChild(option);
      }
      if (row.parentProjectId !== null) {
        const label = row.parentProjectId === OTHERS_PARENT_ID ? "Others" : `#${row.parentProjectId} ${row.parentProjectName || ""}`;
        parentSelect.dataset.tooltip = label;
        if (row.parentProjectId !== OTHERS_PARENT_ID) {
          const parentProject = ctx.parentProjects.find((p) => p.id === row.parentProjectId);
          parentSelect.dataset.vscodeContext = JSON.stringify({
            webviewSection: "tsClient",
            projectId: row.parentProjectId,
            projectIdentifier: parentProject?.identifier || "",
            preventDefaultContextMenuItems: true
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
            confirmed: false
          });
        } else {
          vscode.postMessage({
            type: "updateRowField",
            rowId: row.id,
            field: "parentProject",
            value
          });
        }
        if (value !== null) {
          vscode.postMessage({
            type: "requestChildProjects",
            parentId: value
          });
        }
      });
      parentTd.appendChild(parentSelect);
      tr.appendChild(parentTd);
      const projectTd = document.createElement("td");
      projectTd.className = "col-project";
      const projectSelect = document.createElement("select");
      projectSelect.className = "project-select";
      projectSelect.innerHTML = '<option value="">Project...</option>';
      const hasParent = row.parentProjectId !== null;
      projectSelect.disabled = !hasParent;
      if (hasParent) {
        const children = ctx.childProjectsByParent.get(String(row.parentProjectId)) || [];
        for (const child of children) {
          const option = document.createElement("option");
          option.value = child.id;
          option.textContent = `#${child.id} ${child.name}`;
          if (child.id === row.projectId) option.selected = true;
          projectSelect.appendChild(option);
        }
      }
      if (row.projectId !== null) {
        projectSelect.dataset.tooltip = `#${row.projectId} ${row.projectName || ""}`;
        const childProject = ctx.projects.find((p) => p.id === row.projectId);
        projectSelect.dataset.vscodeContext = JSON.stringify({
          webviewSection: "tsProject",
          projectId: row.projectId,
          projectIdentifier: childProject?.identifier || "",
          preventDefaultContextMenuItems: true
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
            confirmed: false
          });
        } else {
          vscode.postMessage({
            type: "updateRowField",
            rowId: row.id,
            field: "project",
            value
          });
        }
        if (value !== null) {
          vscode.postMessage({
            type: "requestIssues",
            projectId: value
          });
        }
      });
      projectTd.appendChild(projectSelect);
      tr.appendChild(projectTd);
      const taskTd = document.createElement("td");
      taskTd.className = "col-task";
      const taskContent = document.createElement("div");
      taskContent.className = "task-cell-content";
      const taskSelect = document.createElement("select");
      taskSelect.className = "task-select";
      taskSelect.innerHTML = '<option value="">Task...</option>';
      const hasProject = row.projectId !== null;
      taskSelect.disabled = !hasProject;
      if (hasProject) {
        const issues = ctx.issuesByProject.get(String(row.projectId)) || [];
        for (const issue of issues) {
          const option = document.createElement("option");
          option.value = issue.id;
          option.textContent = `#${issue.id} ${issue.subject}`;
          if (issue.id === row.issueId) option.selected = true;
          taskSelect.appendChild(option);
        }
      }
      if (row.issueId !== null) {
        taskTd.dataset.issueId = row.issueId;
        taskSelect.dataset.vscodeContext = JSON.stringify({
          webviewSection: "tsTask",
          issueId: row.issueId,
          preventDefaultContextMenuItems: true
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
            confirmed: false
          });
        } else {
          vscode.postMessage({
            type: "updateRowField",
            rowId: row.id,
            field: "issue",
            value
          });
        }
      });
      taskContent.appendChild(taskSelect);
      const searchBtn = document.createElement("button");
      searchBtn.className = "search-btn";
      searchBtn.textContent = "\u{1F50D}";
      searchBtn.dataset.tooltip = "Search all issues";
      searchBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "pickIssue", rowId: row.id });
      });
      taskContent.appendChild(searchBtn);
      taskTd.appendChild(taskContent);
      tr.appendChild(taskTd);
      const activityTd = document.createElement("td");
      activityTd.className = "col-activity";
      const activitySelect = document.createElement("select");
      activitySelect.className = "activity-select";
      activitySelect.innerHTML = '<option value="">Activity...</option>';
      activitySelect.disabled = !hasProject;
      const activities = ctx.activitiesByProject.get(String(row.projectId)) || [];
      for (const activity of activities) {
        const option = document.createElement("option");
        option.value = activity.id;
        option.textContent = activity.name;
        if (activity.id === row.activityId) option.selected = true;
        activitySelect.appendChild(option);
      }
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
            confirmed: false
          });
        } else {
          vscode.postMessage({
            type: "updateRowField",
            rowId: row.id,
            field: "activity",
            value
          });
        }
      });
      activityTd.appendChild(activitySelect);
      tr.appendChild(activityTd);
      const isRowComplete = row.parentProjectId !== null && row.projectId !== null && row.issueId !== null && row.activityId !== null;
      const commentsTd = document.createElement("td");
      commentsTd.className = "col-comments";
      const commentsInput = document.createElement("input");
      commentsInput.type = "text";
      commentsInput.className = "comments-input";
      commentsInput.value = row.comments || "";
      commentsInput.placeholder = isRowComplete ? "" : "Select client/project/task/activity first";
      commentsInput.disabled = !isRowComplete;
      let commentsOldValue = row.comments || null;
      commentsInput.addEventListener("focus", (e) => {
        commentsOldValue = e.target.value.trim() || null;
      });
      commentsInput.addEventListener("blur", (e) => {
        const value = e.target.value.trim() || null;
        if (value === commentsOldValue) {
          return;
        }
        if (isAggregated && row.sourceRowIds?.length > 0) {
          pushUndo({
            type: "aggregatedField",
            aggRowId: row.id,
            field: "comments",
            oldValue: commentsOldValue,
            newValue: value,
            sourceRowIds: row.sourceRowIds
          });
          vscode.postMessage({
            type: "updateAggregatedField",
            aggRowId: row.id,
            field: "comments",
            value,
            sourceRowIds: row.sourceRowIds,
            confirmed: false
          });
        } else {
          pushUndo({
            type: "field",
            rowId: row.id,
            field: "comments",
            oldValue: commentsOldValue,
            newValue: value
          });
          vscode.postMessage({
            type: "updateRowField",
            rowId: row.id,
            field: "comments",
            value
          });
        }
      });
      commentsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.target.blur();
      });
      commentsTd.appendChild(commentsInput);
      tr.appendChild(commentsTd);
      const todayIndex = getTodayDayIndex(ctx.week);
      for (let i = 0; i < 7; i++) {
        const dayTd = document.createElement("td");
        dayTd.className = "col-day day-cell";
        dayTd.dataset.day = i;
        if (i === todayIndex) dayTd.classList.add("today");
        const cell = row.days[i] || { hours: 0, isDirty: false, sourceEntries: [] };
        const sourceEntryCount = cell.sourceEntries?.length || 0;
        if (cell.hours > 0) dayTd.classList.add("has-value");
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
        if (isAggregated) {
          input.classList.add("aggregated-cell-input");
        }
        input.value = formatHours(cell.hours);
        if (isAggregated && cell.sourceEntries?.length > 1) {
          input.dataset.tooltip = `${cell.sourceEntries.length} entries`;
        } else if (cell.entryId) {
          input.dataset.tooltip = `#${cell.entryId}`;
        } else if (cell.hours > 0) {
          input.dataset.tooltip = "Draft";
        } else {
          input.dataset.tooltip = "";
        }
        input.disabled = !isRowComplete;
        input.dataset.oldValue = cell.hours;
        if (isAggregated && cell.sourceEntries) {
          input.dataset.sourceEntries = JSON.stringify(cell.sourceEntries);
          input.dataset.isAggregated = "true";
        }
        input.addEventListener("focus", (e) => {
          e.target.dataset.oldValue = parseHours(e.target.value);
          e.target.select();
        });
        input.addEventListener("blur", (e) => {
          const oldHours = parseFloat(e.target.dataset.oldValue) || 0;
          const newHours = parseHours(e.target.value);
          if (newHours > oldHours && wouldExceed24Hours(i, oldHours, newHours)) {
            e.target.value = formatHours(oldHours);
            showToast("Cannot exceed 24h per day");
            return;
          }
          e.target.value = formatHours(newHours);
          if (oldHours !== newHours) {
            if (e.target.dataset.isAggregated === "true") {
              handleAggregatedCellBlur(row, i, newHours, oldHours, cell);
            } else {
              pushUndo({
                type: "cell",
                rowId: row.id,
                dayIndex: i,
                oldValue: oldHours,
                newValue: newHours
              });
              vscode.postMessage({
                type: "updateCell",
                rowId: row.id,
                dayIndex: i,
                hours: newHours
              });
            }
          }
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") {
            e.target.value = formatHours(parseFloat(e.target.dataset.oldValue) || 0);
            e.target.blur();
          }
        });
        dayTd.appendChild(input);
        if (isAggregated && sourceEntryCount > 1) {
          const badge = document.createElement("span");
          badge.className = "multi-entry-badge";
          badge.dataset.tooltip = isExpanded ? "Click to collapse" : `${sourceEntryCount} entries - click to expand`;
          badge.textContent = sourceEntryCount;
          badge.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleCellExpand(row.id, i);
          });
          dayTd.appendChild(badge);
          if (isExpanded && cell.sourceEntries) {
            const dropdown = renderExpandedCellDropdown(row, i, cell.sourceEntries);
            dayTd.appendChild(dropdown);
          }
        }
        tr.appendChild(dayTd);
      }
      const totalTd = document.createElement("td");
      totalTd.className = "col-total row-total";
      totalTd.textContent = formatHours(row.weekTotal);
      tr.appendChild(totalTd);
      const actionsTd = document.createElement("td");
      actionsTd.className = "col-actions";
      const sourceCount = isAggregated ? row.sourceRowIds?.length || 1 : 1;
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "action-btn delete-btn";
      deleteBtn.textContent = "\u{1F5D1}\uFE0F";
      deleteBtn.dataset.tooltip = isAggregated ? `Delete ${sourceCount} entries` : "Delete";
      deleteBtn.addEventListener("click", () => {
        if (isAggregated && sourceCount > 1) {
          showToast(`Deleted ${sourceCount} entries`);
        }
        vscode.postMessage({ type: "deleteRow", rowId: row.id });
      });
      actionsTd.appendChild(deleteBtn);
      const copyBtn = document.createElement("button");
      copyBtn.className = "action-btn copy-btn";
      copyBtn.textContent = "\u{1F4CB}";
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
    function getGroupKey(row, ctx) {
      switch (ctx.groupBy) {
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
    function getGroupLabel(row, ctx) {
      switch (ctx.groupBy) {
        case "client":
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
    function getGroupTotal(rows) {
      return rows.reduce((sum, r) => sum + r.weekTotal, 0);
    }
    function renderGroupHeader(groupKey, label, total, isCollapsed, ctx) {
      const tr = document.createElement("tr");
      tr.className = "group-header" + (isCollapsed ? " collapsed" : "");
      tr.dataset.groupKey = groupKey;
      const td = document.createElement("td");
      td.colSpan = 12;
      td.className = "group-header-cell";
      const chevron = document.createElement("span");
      chevron.className = "group-chevron";
      chevron.textContent = isCollapsed ? "\u25B6" : "\u25BC";
      const labelSpan = document.createElement("span");
      labelSpan.className = "group-label";
      labelSpan.textContent = label;
      td.appendChild(chevron);
      td.appendChild(labelSpan);
      td.addEventListener("click", () => {
        if (!lastRenderContext) return;
        if (lastRenderContext.collapsedGroups.has(groupKey)) {
          lastRenderContext.collapsedGroups.delete(groupKey);
        } else {
          lastRenderContext.collapsedGroups.add(groupKey);
        }
        vscode.postMessage({ type: "toggleGroup", groupKey });
        renderGrid(lastRenderContext);
      });
      tr.appendChild(td);
      const totalTd = document.createElement("td");
      totalTd.className = "col-total group-total";
      totalTd.textContent = formatHours(total);
      tr.appendChild(totalTd);
      const actionsTd = document.createElement("td");
      actionsTd.className = "col-actions";
      tr.appendChild(actionsTd);
      return tr;
    }
    function aggregateIdenticalRows(rows, ctx) {
      if (!rows || rows.length === 0) return rows;
      const groups = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const key = `${row.issueId ?? "null"}::${row.activityId ?? "null"}::${row.comments ?? ""}`;
        if (!groups.has(key)) {
          const aggRow = {
            ...row,
            id: `agg-${key}`,
            // Mark as aggregated
            isAggregated: true,
            // Flag for special handling
            sourceRowIds: [row.id],
            // Track original rows
            days: {},
            weekTotal: 0
          };
          for (let d = 0; d < 7; d++) {
            if (row.days[d]) {
              const sourceEntries = [];
              if (row.days[d].hours > 0) {
                sourceEntries.push({
                  rowId: row.id,
                  entryId: row.days[d].entryId,
                  // null for drafts
                  hours: row.days[d].hours,
                  originalHours: row.days[d].originalHours || 0,
                  issueId: row.issueId,
                  activityId: row.activityId,
                  comments: row.comments,
                  spentOn: ctx.week?.dayDates[d] || "",
                  isDraft: !row.days[d].entryId
                  // Flag for drafts
                });
              }
              aggRow.days[d] = {
                hours: row.days[d].hours,
                originalHours: row.days[d].originalHours,
                entryId: null,
                // Aggregated has no single entry
                isDirty: row.days[d].isDirty || false,
                sourceEntries
              };
              aggRow.weekTotal += row.days[d].hours || 0;
            }
          }
          groups.set(key, aggRow);
        } else {
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
                  sourceEntries: []
                };
              }
              aggRow.days[d].hours += row.days[d].hours || 0;
              aggRow.days[d].originalHours += row.days[d].originalHours || 0;
              aggRow.weekTotal += row.days[d].hours || 0;
              if (row.days[d].isDirty) aggRow.days[d].isDirty = true;
              if (row.days[d].hours > 0) {
                aggRow.days[d].sourceEntries.push({
                  rowId: row.id,
                  entryId: row.days[d].entryId,
                  // null for drafts
                  hours: row.days[d].hours,
                  originalHours: row.days[d].originalHours || 0,
                  issueId: row.issueId,
                  activityId: row.activityId,
                  comments: row.comments,
                  spentOn: ctx.week?.dayDates[d] || "",
                  isDraft: !row.days[d].entryId
                  // Flag for drafts
                });
              }
            }
          }
        }
      }
      return [...groups.values()];
    }
    function renderGrid(ctx) {
      while (gridBody.firstChild) {
        gridBody.removeChild(gridBody.firstChild);
      }
      const rowsToRender = ctx.aggregateRows ? aggregateIdenticalRows(ctx.rows, ctx) : ctx.rows;
      if (rowsToRender.length === 0) {
        const tr = document.createElement("tr");
        tr.className = "empty-row";
        const td = document.createElement("td");
        td.colSpan = 14;
        td.textContent = "No time entries yet.";
        tr.appendChild(td);
        gridBody.appendChild(tr);
      } else if (ctx.groupBy === "none") {
        const sortedRows = sortRows(rowsToRender, ctx);
        for (const row of sortedRows) {
          gridBody.appendChild(renderRow(row, ctx));
        }
      } else {
        const groups = /* @__PURE__ */ new Map();
        for (const row of rowsToRender) {
          const groupKey = getGroupKey(row, ctx);
          if (!groups.has(groupKey)) {
            groups.set(groupKey, { label: getGroupLabel(row, ctx), rows: [] });
          }
          groups.get(groupKey).rows.push(row);
        }
        const sortedGroups = [...groups.entries()].sort(
          (a, b) => a[1].label.localeCompare(b[1].label)
        );
        for (const [groupKey, group] of sortedGroups) {
          const isCollapsed = ctx.collapsedGroups.has(groupKey);
          const total = getGroupTotal(group.rows);
          gridBody.appendChild(renderGroupHeader(groupKey, group.label, total, isCollapsed, ctx));
          if (!isCollapsed) {
            const sortedGroupRows = sortRows(group.rows, ctx);
            for (const row of sortedGroupRows) {
              gridBody.appendChild(renderRow(row, ctx));
            }
          }
        }
      }
      renderTotals(ctx);
      updateSortIndicators(ctx);
      restorePendingFocus();
    }
    function sortRows(rows, ctx) {
      if (!ctx.sortColumn) return rows;
      return [...rows].sort((a, b) => {
        let valA, valB;
        switch (ctx.sortColumn) {
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
        return ctx.sortDirection === "asc" ? cmp : -cmp;
      });
    }
    function renderTotals(ctx) {
      if (!ctx.totals) return;
      const todayIndex = getTodayDayIndex(ctx.week);
      const dayCells = totalsRow.querySelectorAll(".col-day.total-cell");
      dayCells.forEach((cell, i) => {
        const hours = ctx.totals.days[i];
        const target = ctx.totals.targetHours[i];
        const valueSpan = cell.querySelector(".total-value");
        if (valueSpan) {
          const hoursDisplay = hours === 0 ? "0" : formatHours(hours);
          valueSpan.textContent = `${hoursDisplay} / ${target}`;
        }
        const progressFill = cell.querySelector(".progress-fill");
        if (progressFill && target > 0) {
          const percent = Math.min(hours / target * 100, 100);
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
        cell.classList.toggle("today", i === todayIndex);
      });
      const targetTotal = ctx.totals.weekTargetTotal;
      const weekHours = ctx.totals.weekTotal;
      const weekHoursDisplay = weekHours === 0 ? "0" : formatHours(weekHours);
      weekTotal.textContent = `${weekHoursDisplay} / ${targetTotal}`;
    }
    function updateRow(row, totals, ctx) {
      if (ctx.aggregateRows) {
        if (totals) ctx.totals = totals;
        renderGrid(ctx);
        return;
      }
      const existingRow = gridBody.querySelector(`tr[data-row-id="${row.id}"]`);
      if (existingRow) {
        const newRow = renderRow(row, ctx);
        existingRow.replaceWith(newRow);
      }
      if (totals) {
        ctx.totals = totals;
        renderTotals(ctx);
      }
    }
    window.addEventListener("message", (event) => {
      const message = event.data;
      switch (message.type) {
        case "render": {
          const ctx = {
            rows: message.rows,
            week: message.week,
            totals: message.totals,
            projects: message.projects || [],
            parentProjects: message.parentProjects || [],
            childProjectsByParent: new Map(Object.entries(message.childProjectsByParent || {})),
            issuesByProject: new Map(Object.entries(message.issuesByProject || {})),
            activitiesByProject: new Map(Object.entries(message.activitiesByProject || {})),
            isDraftMode: message.isDraftMode,
            sortColumn: message.sortColumn ?? null,
            sortDirection: message.sortDirection ?? "asc",
            groupBy: message.groupBy ?? "none",
            collapsedGroups: new Set(message.collapsedGroups || []),
            aggregateRows: message.aggregateRows ?? false
          };
          lastRenderContext = ctx;
          if (groupBySelect) groupBySelect.value = ctx.groupBy;
          const aggregateToggle = document.getElementById("aggregateToggle");
          if (aggregateToggle) aggregateToggle.checked = ctx.aggregateRows;
          weekLabel.textContent = formatWeekLabel(ctx.week);
          updateWeekHeaders(ctx);
          updateDraftModeUI(ctx);
          renderGrid(ctx);
          break;
        }
        case "updateRow": {
          if (!lastRenderContext) break;
          if (message.rowCascadeData) {
            const { childProjects, issues, activities } = message.rowCascadeData;
            if (childProjects && message.row.parentProjectId !== null) {
              lastRenderContext.childProjectsByParent.set(String(message.row.parentProjectId), childProjects);
            }
            if (issues && message.row.projectId !== null) {
              lastRenderContext.issuesByProject.set(String(message.row.projectId), issues);
            }
            if (activities && message.row.projectId !== null) {
              lastRenderContext.activitiesByProject.set(String(message.row.projectId), activities);
            }
          }
          const rowIndex = lastRenderContext.rows.findIndex((r) => r.id === message.row.id);
          if (rowIndex !== -1) {
            lastRenderContext.rows[rowIndex] = message.row;
          }
          lastRenderContext.totals = message.totals;
          updateRow(message.row, message.totals, lastRenderContext);
          break;
        }
        case "updateChildProjects":
          if (lastRenderContext) {
            lastRenderContext.childProjectsByParent.set(String(message.forParentId), message.projects);
            renderGrid(lastRenderContext);
          }
          break;
        case "updateIssues":
          if (lastRenderContext) {
            lastRenderContext.issuesByProject.set(String(message.forProjectId), message.issues);
            renderGrid(lastRenderContext);
          }
          break;
        case "updateActivities":
          if (lastRenderContext) {
            lastRenderContext.activitiesByProject.set(String(message.forProjectId), message.activities);
            renderGrid(lastRenderContext);
          }
          break;
        case "setLoading":
          loadingOverlay.classList.toggle("hidden", !message.loading);
          break;
        case "showError":
          console.error(message.message);
          showToast(message.message, null, 8e3);
          break;
        case "draftModeChanged":
          if (lastRenderContext) {
            lastRenderContext.isDraftMode = message.isDraftMode;
            updateDraftModeUI(lastRenderContext);
          }
          break;
        case "updateIssueDetails":
          state.issueDetails.set(message.issueId, message.details);
          if (pendingTooltipIssueId === message.issueId && tooltipTarget) {
            showIssueTooltip(tooltipTarget, pendingTooltipX, pendingTooltipY);
            pendingTooltipIssueId = null;
          }
          break;
        case "rowDuplicated":
          pushUndo({
            type: "duplicateRow",
            sourceRowId: message.sourceRowId,
            newRowId: message.newRowId
          });
          break;
        case "rowDeleted":
          pushUndo({
            type: "deleteRow",
            deletedRow: message.deletedRow
          });
          break;
        case "showToast":
          showToast(message.message, message.undoAction, message.duration);
          break;
        case "requestAggregatedCellConfirm":
          handleAggregatedCellConfirm(message);
          break;
        case "requestAggregatedFieldConfirm":
          handleAggregatedFieldConfirm(message);
          break;
        case "pasteComplete":
          pushUndo({
            type: "paste",
            draftIds: message.draftIds,
            count: message.count
          });
          break;
      }
    });
    function updateWeekHeaders(ctx) {
      if (!ctx.week) return;
      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const headerCells = document.querySelectorAll("thead .col-day");
      const todayIndex = getTodayDayIndex(ctx.week);
      headerCells.forEach((cell, i) => {
        const date = /* @__PURE__ */ new Date(ctx.week.dayDates[i] + "T12:00:00");
        const day = date.getDate();
        cell.textContent = `${dayNames[i]} ${day}`;
        cell.classList.toggle("today", i === todayIndex);
      });
    }
    function updateSortIndicators(ctx) {
      const sortableHeaders = document.querySelectorAll("thead .sortable");
      sortableHeaders.forEach((header) => {
        const sortKey = header.dataset.sort;
        const existingIndicator = header.querySelector(".sort-indicator");
        if (existingIndicator) existingIndicator.remove();
        if (sortKey === ctx.sortColumn) {
          const indicator = document.createElement("span");
          indicator.className = "sort-indicator";
          indicator.textContent = ctx.sortDirection === "asc" ? "\u25B2" : "\u25BC";
          header.appendChild(indicator);
        }
      });
    }
    function handleSortClick(sortKey) {
      if (!lastRenderContext) return;
      if (lastRenderContext.sortColumn === sortKey) {
        if (lastRenderContext.sortDirection === "asc") {
          lastRenderContext.sortDirection = "desc";
        } else {
          lastRenderContext.sortColumn = null;
          lastRenderContext.sortDirection = "asc";
        }
      } else {
        lastRenderContext.sortColumn = sortKey;
        lastRenderContext.sortDirection = "asc";
      }
      vscode.postMessage({
        type: "sortChanged",
        sortColumn: lastRenderContext.sortColumn,
        sortDirection: lastRenderContext.sortDirection
      });
      renderGrid(lastRenderContext);
    }
    function setupSortHandlers() {
      const sortableHeaders = document.querySelectorAll("thead .sortable");
      sortableHeaders.forEach((header) => {
        const sortKey = header.dataset.sort;
        if (sortKey) {
          header.addEventListener("click", () => handleSortClick(sortKey));
        }
      });
    }
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
    groupBySelect?.addEventListener("change", (e) => {
      if (!lastRenderContext) return;
      lastRenderContext.groupBy = e.target.value;
      vscode.postMessage({ type: "setGroupBy", groupBy: lastRenderContext.groupBy });
      renderGrid(lastRenderContext);
    });
    document.getElementById("aggregateToggle")?.addEventListener("change", (e) => {
      if (!lastRenderContext) return;
      lastRenderContext.aggregateRows = e.target.checked;
      vscode.postMessage({ type: "setAggregateRows", aggregateRows: lastRenderContext.aggregateRows });
      renderGrid(lastRenderContext);
    });
    document.getElementById("copyWeekBtn")?.addEventListener("click", () => {
      vscode.postMessage({ type: "copyWeek" });
    });
    document.getElementById("pasteWeekBtn")?.addEventListener("click", () => {
      vscode.postMessage({ type: "pasteWeek" });
    });
    enableDraftModeBtn?.addEventListener("click", () => {
      vscode.postMessage({ type: "enableDraftMode" });
    });
    addEntryBtn?.addEventListener("click", () => {
      vscode.postMessage({ type: "addRow" });
    });
    undoBtn?.addEventListener("click", () => {
      undo();
    });
    redoBtn?.addEventListener("click", () => {
      redo();
    });
    setupSortHandlers();
    document.addEventListener("keydown", (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;
      const isInInput = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT";
      const isDayInput = e.target.classList?.contains("day-input");
      if (ctrlOrCmd && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (ctrlOrCmd && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (ctrlOrCmd && e.key === "y" && !isMac) {
        e.preventDefault();
        redo();
      } else if (e.key.toLowerCase() === "t" && !ctrlOrCmd && !e.altKey && !isInInput) {
        e.preventDefault();
        vscode.postMessage({ type: "navigateWeek", direction: "today" });
      } else if (isDayInput && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab"].includes(e.key)) {
        handleGridNavigation(e);
      }
    });
    function handleGridNavigation(e) {
      const currentInput = e.target;
      const currentCell = currentInput.closest("td");
      const currentRow = currentCell?.closest("tr");
      if (!currentCell || !currentRow) return;
      const allDayInputs = Array.from(document.querySelectorAll(".day-input:not(:disabled)"));
      const currentIndex = allDayInputs.indexOf(currentInput);
      if (currentIndex === -1) return;
      const rowInputs = Array.from(currentRow.querySelectorAll(".day-input:not(:disabled)"));
      const colIndex = rowInputs.indexOf(currentInput);
      const allRows = Array.from(document.querySelectorAll("#gridBody tr:not(.group-header-row)"));
      const rowIndex = allRows.indexOf(currentRow);
      let targetInput = null;
      switch (e.key) {
        case "ArrowRight":
          if (colIndex < rowInputs.length - 1) {
            targetInput = rowInputs[colIndex + 1];
          }
          break;
        case "ArrowLeft":
          if (colIndex > 0) {
            targetInput = rowInputs[colIndex - 1];
          }
          break;
        case "ArrowDown":
        case "Enter":
          if (rowIndex < allRows.length - 1) {
            const nextRow = allRows[rowIndex + 1];
            const nextRowInputs = Array.from(nextRow.querySelectorAll(".day-input:not(:disabled)"));
            if (nextRowInputs[colIndex]) {
              targetInput = nextRowInputs[colIndex];
            }
          }
          break;
        case "ArrowUp":
          if (rowIndex > 0) {
            const prevRow = allRows[rowIndex - 1];
            const prevRowInputs = Array.from(prevRow.querySelectorAll(".day-input:not(:disabled)"));
            if (prevRowInputs[colIndex]) {
              targetInput = prevRowInputs[colIndex];
            }
          }
          break;
        case "Tab":
          return;
      }
      if (targetInput) {
        e.preventDefault();
        const targetCell = targetInput.closest("td");
        const targetRow = targetCell?.closest("tr");
        if (targetRow && targetCell) {
          pendingFocus = {
            rowId: targetRow.dataset.rowId,
            dayIndex: Number(targetCell.dataset.day)
          };
        }
        currentInput.blur();
        targetInput.focus();
        targetInput.select();
      }
    }
    function restorePendingFocus() {
      if (!pendingFocus) return;
      const { rowId, dayIndex } = pendingFocus;
      pendingFocus = null;
      const input = document.querySelector(
        `tr[data-row-id="${rowId}"] .day-cell[data-day="${dayIndex}"] .day-input`
      );
      if (input && !input.disabled) {
        input.focus();
        input.select();
      }
    }
    const issueTooltip = document.getElementById("issueTooltip");
    const tooltipContent = issueTooltip?.querySelector(".issue-tooltip-content");
    let tooltipTarget = null;
    let tooltipShowTimer = null;
    let tooltipHideTimer = null;
    let pendingTooltipIssueId = null;
    let pendingTooltipX = 0;
    let pendingTooltipY = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;
    document.addEventListener("pointermove", (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }, { passive: true });
    function showIssueTooltip(target, x, y) {
      if (!issueTooltip || !tooltipContent) return;
      const issueId = parseInt(target.dataset.issueId, 10);
      if (!issueId) return;
      const details = state.issueDetails.get(issueId);
      if (!details) {
        pendingTooltipIssueId = issueId;
        pendingTooltipX = x;
        pendingTooltipY = y;
        vscode.postMessage({ type: "requestIssueDetails", issueId });
        return;
      }
      tooltipContent.innerHTML = "";
      const title = document.createElement("div");
      title.className = "issue-tooltip-line issue-tooltip-title";
      title.textContent = `#${details.id} ${details.subject}`;
      tooltipContent.appendChild(title);
      const divider = document.createElement("div");
      divider.className = "issue-tooltip-divider";
      tooltipContent.appendChild(divider);
      const fields = [
        { key: "Status", value: details.status },
        { key: "Priority", value: details.priority },
        { key: "Tracker", value: details.tracker },
        { key: "Assignee", value: details.assignedTo || "Unassigned" },
        { key: "Done", value: `${details.doneRatio}%` }
      ];
      if (details.estimatedHours !== null) {
        fields.push({ key: "Estimated", value: formatHoursAsHHMM(details.estimatedHours) });
      }
      if (details.spentHours !== null) {
        fields.push({ key: "Spent", value: formatHoursAsHHMM(details.spentHours) });
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
      positionTooltip(x, y);
      issueTooltip.classList.add("visible");
      issueTooltip.setAttribute("aria-hidden", "false");
    }
    function clampTooltipPosition(x, y, rect, padding, offset) {
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
      return { left: Math.round(left), top: Math.round(top) };
    }
    function positionTooltip(x, y) {
      issueTooltip.style.left = "0";
      issueTooltip.style.top = "0";
      const rect = issueTooltip.getBoundingClientRect();
      const { left, top } = clampTooltipPosition(x, y, rect, 8, 12);
      issueTooltip.style.left = `${left}px`;
      issueTooltip.style.top = `${top}px`;
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
    document.addEventListener("pointerover", (e) => {
      const target = e.target.closest("[data-issue-id]");
      if (!target || !gridBody.contains(target)) {
        return;
      }
      if (tooltipTarget === target) return;
      if (tooltipHideTimer) {
        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
      }
      tooltipTarget = target;
      if (tooltipShowTimer) clearTimeout(tooltipShowTimer);
      tooltipShowTimer = setTimeout(() => {
        tooltipShowTimer = null;
        if (tooltipTarget === target) {
          showIssueTooltip(target, lastMouseX, lastMouseY);
        }
      }, 400);
    }, true);
    document.addEventListener("pointerout", (e) => {
      const target = e.target.closest("[data-issue-id]");
      if (!target || target !== tooltipTarget) return;
      const relatedTarget = e.relatedTarget;
      if (relatedTarget && target.contains(relatedTarget)) {
        return;
      }
      if (tooltipShowTimer) {
        clearTimeout(tooltipShowTimer);
        tooltipShowTimer = null;
      }
      tooltipHideTimer = setTimeout(() => {
        hideIssueTooltip();
      }, 100);
    }, true);
    document.querySelector(".timesheet-grid-container")?.addEventListener("scroll", () => {
      hideIssueTooltip();
    });
    const genericTooltip = document.getElementById("genericTooltip");
    let genericTooltipTarget = null;
    let genericTooltipTimer = null;
    function showGenericTooltip(target, x, y) {
      if (!genericTooltip) return;
      const text = target.dataset.tooltip;
      if (!text) return;
      genericTooltip.textContent = text;
      genericTooltip.style.left = "0";
      genericTooltip.style.top = "0";
      genericTooltip.classList.add("visible");
      const rect = genericTooltip.getBoundingClientRect();
      const { left, top } = clampTooltipPosition(x, y, rect, 8, 10);
      genericTooltip.style.left = `${left}px`;
      genericTooltip.style.top = `${top}px`;
    }
    function hideGenericTooltip() {
      if (genericTooltipTimer) {
        clearTimeout(genericTooltipTimer);
        genericTooltipTimer = null;
      }
      genericTooltipTarget = null;
      genericTooltip?.classList.remove("visible");
    }
    document.addEventListener("pointerover", (e) => {
      const target = e.target.closest("[data-tooltip]");
      if (!target || target.dataset.issueId) return;
      if (genericTooltipTarget === target) return;
      hideGenericTooltip();
      genericTooltipTarget = target;
      genericTooltipTimer = setTimeout(() => {
        genericTooltipTimer = null;
        if (genericTooltipTarget === target) {
          showGenericTooltip(target, lastMouseX, lastMouseY);
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
    document.querySelector(".timesheet-grid-container")?.addEventListener("scroll", () => {
      hideGenericTooltip();
    });
    let activeToast = null;
    let toastTimeout = null;
    function showToast(message, undoAction = null, duration = 5e3) {
      hideToast();
      const toast = document.createElement("div");
      toast.className = "toast-notification";
      toast.innerHTML = `
      <span class="toast-message">${escapeHtml(message)}</span>
      ${undoAction ? '<button class="toast-undo-btn">Undo</button>' : ""}
      <button class="toast-dismiss-btn">\xD7</button>
    `;
      if (undoAction) {
        const undoBtn2 = toast.querySelector(".toast-undo-btn");
        undoBtn2?.addEventListener("click", () => {
          vscode.postMessage(undoAction);
          hideToast();
        });
      }
      const dismissBtn = toast.querySelector(".toast-dismiss-btn");
      dismissBtn?.addEventListener("click", () => hideToast());
      const container = document.querySelector(".timesheet-container") || document.body;
      container.appendChild(toast);
      activeToast = toast;
      requestAnimationFrame(() => {
        toast.classList.add("visible");
      });
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
    function toggleCellExpand(rowId, dayIndex) {
      const cellKey = `${rowId}:${dayIndex}`;
      if (state.expandedCells.has(cellKey)) {
        state.expandedCells.delete(cellKey);
      } else {
        state.expandedCells.clear();
        state.expandedCells.add(cellKey);
      }
      if (lastRenderContext) renderGrid(lastRenderContext);
    }
    function collapseAllCells() {
      if (state.expandedCells.size > 0) {
        state.expandedCells.clear();
        if (lastRenderContext) renderGrid(lastRenderContext);
      }
    }
    function renderExpandedCellDropdown(row, dayIndex, sourceEntries) {
      const dropdown = document.createElement("div");
      dropdown.className = "expanded-cell-dropdown";
      dropdown.addEventListener("click", (e) => e.stopPropagation());
      const header = document.createElement("div");
      header.className = "dropdown-header";
      const headerLabel = document.createElement("span");
      headerLabel.textContent = `${sourceEntries.length} time entries`;
      header.appendChild(headerLabel);
      const savedEntries = sourceEntries.filter((e) => e.entryId);
      if (savedEntries.length >= 2) {
        const mergeBtn = document.createElement("button");
        mergeBtn.className = "dropdown-merge-btn";
        mergeBtn.textContent = "Merge";
        mergeBtn.dataset.tooltip = "Combine all entries into one";
        mergeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: "mergeEntries",
            aggRowId: row.id,
            dayIndex,
            sourceEntries: savedEntries
          });
        });
        header.appendChild(mergeBtn);
      }
      const totalHours = sourceEntries.reduce((sum, e) => sum + e.hours, 0);
      const headerTotal = document.createElement("span");
      headerTotal.className = "dropdown-header-total";
      headerTotal.textContent = `${formatHours(totalHours)}h total`;
      header.appendChild(headerTotal);
      dropdown.appendChild(header);
      const list = document.createElement("div");
      list.className = "dropdown-entry-list";
      sourceEntries.forEach((entry, index) => {
        const entryRow = document.createElement("div");
        entryRow.className = "dropdown-entry";
        const contextLabel = document.createElement("span");
        contextLabel.className = "dropdown-entry-context";
        if (!entry.entryId) {
          contextLabel.textContent = "Draft";
          contextLabel.classList.add("draft");
          contextLabel.dataset.tooltip = `Draft entry on ${entry.spentOn}`;
        } else {
          contextLabel.textContent = `#${entry.entryId}`;
          const date = /* @__PURE__ */ new Date(entry.spentOn + "T12:00:00");
          const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          contextLabel.dataset.tooltip = `Created on ${dateStr}`;
        }
        entryRow.appendChild(contextLabel);
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
          if (newHours > oldHours && wouldExceed24Hours(dayIndex, oldHours, newHours)) {
            e.target.value = formatHours(oldHours);
            showToast("Cannot exceed 24h per day");
            return;
          }
          e.target.value = formatHours(newHours);
          if (oldHours !== newHours) {
            pushUndo({
              type: "expandedEntry",
              rowId: entry.rowId,
              entryId: entry.entryId,
              dayIndex,
              oldValue: oldHours,
              newValue: newHours
            });
            vscode.postMessage({
              type: "updateExpandedEntry",
              rowId: entry.rowId,
              entryId: entry.entryId,
              dayIndex,
              newHours,
              oldHours
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
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "dropdown-entry-delete";
        deleteBtn.textContent = "\xD7";
        deleteBtn.dataset.tooltip = "Delete this entry";
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          pushUndo({
            type: "barrier",
            message: "Cannot undo entry delete"
          });
          vscode.postMessage({
            type: "deleteExpandedEntry",
            rowId: entry.rowId,
            entryId: entry.entryId,
            aggRowId: row.id,
            dayIndex
          });
          showToast("Deleted 1 entry");
        });
        entryRow.appendChild(deleteBtn);
        list.appendChild(entryRow);
      });
      dropdown.appendChild(list);
      return dropdown;
    }
    function handleAggregatedCellBlur(row, dayIndex, newHours, oldHours, cell) {
      const sourceEntries = cell.sourceEntries || [];
      const sourceCount = sourceEntries.length;
      pushUndo({
        type: "aggregatedCell",
        aggRowId: row.id,
        dayIndex,
        oldValue: oldHours,
        newValue: newHours,
        sourceEntries
      });
      if (sourceCount === 0) {
        vscode.postMessage({
          type: "updateAggregatedCell",
          aggRowId: row.id,
          dayIndex,
          newHours,
          sourceEntries: [],
          confirmed: true
        });
        showToast("Created entry");
      } else if (sourceCount === 1) {
        vscode.postMessage({
          type: "updateAggregatedCell",
          aggRowId: row.id,
          dayIndex,
          newHours,
          sourceEntries,
          confirmed: true
        });
        showToast("Updated 1 entry");
      } else {
        vscode.postMessage({
          type: "updateAggregatedCell",
          aggRowId: row.id,
          dayIndex,
          newHours,
          sourceEntries,
          confirmed: false
          // Extension will request confirm via toast
        });
      }
    }
    function handleAggregatedCellConfirm(message) {
      const { aggRowId, dayIndex, newHours, oldHours, sourceEntryCount, sourceEntries } = message;
      const action = newHours === 0 ? "Deleted" : "Replaced";
      showToast(
        `${action} ${sourceEntryCount} entries`,
        {
          type: "restoreAggregatedEntries",
          entries: sourceEntries,
          aggRowId,
          dayIndex
        },
        5e3
      );
      vscode.postMessage({
        type: "updateAggregatedCell",
        aggRowId,
        dayIndex,
        newHours,
        sourceEntries,
        confirmed: true
      });
    }
    function handleAggregatedFieldConfirm(message) {
      const { aggRowId, field, value, oldValue, sourceRowIds, sourceEntryCount } = message;
      showToast(
        `Updated ${sourceEntryCount} entries`,
        {
          type: "updateAggregatedField",
          aggRowId,
          field,
          value: oldValue,
          // Undo restores old value
          sourceRowIds,
          confirmed: true
        },
        5e3
      );
      vscode.postMessage({
        type: "updateAggregatedField",
        aggRowId,
        field,
        value,
        sourceRowIds,
        confirmed: true
      });
    }
    document.addEventListener("click", (e) => {
      if (state.expandedCells.size === 0) return;
      const dropdown = e.target.closest(".expanded-cell-dropdown");
      const badge = e.target.closest(".multi-entry-badge");
      if (!dropdown && !badge) {
        collapseAllCells();
      }
    });
    vscode.postMessage({ type: "webviewReady" });
  })();
})();
