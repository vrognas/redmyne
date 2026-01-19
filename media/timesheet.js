"use strict";

(() => {
  // Get VS Code API
  const vscode = acquireVsCodeApi();

  // State
  let state = {
    rows: [],
    week: null,
    totals: null,
    projects: [],
    issuesByProject: new Map(),
    activitiesByProject: new Map(),
    isDraftMode: false,
  };

  // Elements
  const gridBody = document.getElementById("gridBody");
  const totalsRow = document.getElementById("totalsRow");
  const weekLabel = document.getElementById("weekLabel");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const weekTotal = document.getElementById("weekTotal");

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

    // Task cell
    const taskTd = document.createElement("td");
    taskTd.className = "col-task";
    const taskBtn = document.createElement("button");
    taskBtn.className = "task-btn" + (row.issueId ? " selected" : "");
    if (row.issueId) {
      taskBtn.innerHTML = `<span class="issue-id">#${row.issueId}</span> ${escapeHtml(row.issueSubject || "")}`;
    } else {
      taskBtn.textContent = "Select task...";
    }
    taskBtn.title = row.issueSubject || "Click to select a task";
    taskBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "pickIssue", rowId: row.id });
    });
    taskTd.appendChild(taskBtn);
    tr.appendChild(taskTd);

    // Activity cell
    const activityTd = document.createElement("td");
    activityTd.className = "col-activity";
    const activitySelect = document.createElement("select");
    activitySelect.className = "activity-select";
    activitySelect.innerHTML = '<option value="">Activity...</option>';

    // Populate activities if available
    const activities = state.activitiesByProject.get(row.projectId) || [];
    for (const activity of activities) {
      const option = document.createElement("option");
      option.value = activity.id;
      option.textContent = activity.name;
      if (activity.id === row.activityId) option.selected = true;
      activitySelect.appendChild(option);
    }
    activitySelect.addEventListener("change", () => {
      const value = activitySelect.value ? parseInt(activitySelect.value, 10) : null;
      vscode.postMessage({
        type: "updateRowField",
        rowId: row.id,
        field: "activity",
        value,
      });
    });
    activityTd.appendChild(activitySelect);
    tr.appendChild(activityTd);

    // Day cells
    const todayIndex = getTodayDayIndex(state.week);
    for (let i = 0; i < 7; i++) {
      const dayTd = document.createElement("td");
      dayTd.className = "col-day day-cell";
      dayTd.dataset.day = i;
      if (i === todayIndex) dayTd.classList.add("today");

      const cell = row.days[i] || { hours: 0, isDirty: false };
      const input = document.createElement("input");
      input.type = "text";
      input.className = "day-input" + (cell.isDirty ? " dirty" : "") + (cell.hours === 0 ? " zero" : "");
      input.value = formatHours(cell.hours);
      input.title = state.week ? state.week.dayDates[i] : "";
      input.addEventListener("focus", (e) => e.target.select());
      input.addEventListener("blur", (e) => {
        const hours = parseHours(e.target.value);
        e.target.value = formatHours(hours);
        vscode.postMessage({
          type: "updateCell",
          rowId: row.id,
          dayIndex: i,
          hours,
        });
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Tab") {
          // Navigate to next cell
        }
      });
      dayTd.appendChild(input);
      tr.appendChild(dayTd);
    }

    // Row total cell
    const totalTd = document.createElement("td");
    totalTd.className = "col-total row-total";
    totalTd.textContent = formatHours(row.weekTotal);
    tr.appendChild(totalTd);

    // Actions cell
    const actionsTd = document.createElement("td");
    actionsTd.className = "col-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "action-btn copy-btn";
    copyBtn.textContent = "⎘";
    copyBtn.title = "Duplicate row";
    copyBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "duplicateRow", rowId: row.id });
    });
    actionsTd.appendChild(copyBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "action-btn delete-btn";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete row";
    deleteBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "deleteRow", rowId: row.id });
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);

    return tr;
  }

  // Render grid
  function renderGrid() {
    gridBody.innerHTML = "";

    if (state.rows.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      const td = document.createElement("td");
      td.colSpan = 11;
      td.textContent = 'No time entries. Click "+" to add a row.';
      tr.appendChild(td);
      gridBody.appendChild(tr);
    } else {
      for (const row of state.rows) {
        gridBody.appendChild(renderRow(row));
      }
    }

    renderTotals();
  }

  // Render totals row
  function renderTotals() {
    if (!state.totals) return;

    const todayIndex = getTodayDayIndex(state.week);
    const dayCells = totalsRow.querySelectorAll(".col-day.total-cell");
    dayCells.forEach((cell, i) => {
      const hours = state.totals.days[i];
      const target = state.totals.targetHours[i];
      cell.textContent = formatHours(hours);

      // Color based on target
      cell.classList.remove("under", "met", "over");
      if (target > 0) {
        if (hours < target * 0.9) cell.classList.add("under");
        else if (hours >= target) cell.classList.add("met");
      }

      // Add target indicator
      if (target > 0) {
        const indicator = document.createElement("span");
        indicator.className = "target-indicator";
        indicator.textContent = `/${target}`;
        cell.appendChild(indicator);
      }

      // Today highlight
      cell.classList.toggle("today", i === todayIndex);
    });

    // Week total
    weekTotal.textContent = `${formatHours(state.totals.weekTotal)}`;
    weekTotal.classList.remove("under", "met", "over");
    const targetTotal = state.totals.weekTargetTotal;
    if (targetTotal > 0) {
      if (state.totals.weekTotal < targetTotal * 0.9) weekTotal.classList.add("under");
      else if (state.totals.weekTotal >= targetTotal) weekTotal.classList.add("met");

      const indicator = document.createElement("span");
      indicator.className = "target-indicator";
      indicator.textContent = `/${targetTotal}`;
      weekTotal.appendChild(indicator);
    }
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
        state.isDraftMode = message.isDraftMode;
        weekLabel.textContent = formatWeekLabel(state.week);
        // Update header for weekend
        updateWeekHeaders();
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

      case "updateIssues":
        state.issuesByProject.set(message.forProjectId, message.issues);
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

  document.getElementById("addRowBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "addRow" });
  });

  document.getElementById("saveBtn")?.addEventListener("click", () => {
    vscode.postMessage({ type: "saveAll" });
  });

  // Notify extension that webview is ready
  vscode.postMessage({ type: "webviewReady" });
})();
