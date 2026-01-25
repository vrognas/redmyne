export function setupKeyboard(ctx) {
  const { vscode, addDocListener, menuUndo, menuRedo, undoStack, redoStack, saveState, updateUndoRedoButtons, announce, scrollToAndHighlight, scrollToToday } = ctx;

  // Keyboard shortcuts
  addDocListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    // Skip if user is typing in an input/select
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (modKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      menuUndo?.click();
    } else if (modKey && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      menuRedo?.click();
    } else if (modKey && e.key === 'y') {
      e.preventDefault();
      menuRedo?.click();
    }
    // Zoom shortcuts (1-5)
    else if (e.key >= '1' && e.key <= '5') {
      const zoomSelect = document.getElementById('zoomSelect');
      const levels = ['day', 'week', 'month', 'quarter', 'year'];
      zoomSelect.value = levels[parseInt(e.key) - 1];
      zoomSelect.dispatchEvent(new Event('change'));
    }
    // Toggle shortcuts (trigger menu items)
    else if (e.key.toLowerCase() === 'h') { document.getElementById('menuHeatmap')?.click(); }
    else if (e.key.toLowerCase() === 'y') { document.getElementById('menuCapacity')?.click(); }
    else if (e.key.toLowerCase() === 'i') { document.getElementById('menuIntensity')?.click(); }
    else if (e.key.toLowerCase() === 'd') { document.getElementById('menuDeps')?.click(); }
    else if (e.key.toLowerCase() === 'v') {
      // Toggle view focus between Project and Person
      const viewSelect = document.getElementById('viewFocusSelect');
      viewSelect.value = viewSelect.value === 'project' ? 'person' : 'project';
      viewSelect.dispatchEvent(new Event('change'));
    }
    // Action shortcuts
    else if (e.key.toLowerCase() === 'r') { document.getElementById('refreshBtn')?.click(); }
    else if (e.key.toLowerCase() === 't') { scrollToToday(); }
    else if (e.key.toLowerCase() === 'e') { document.getElementById('menuExpand')?.click(); }
    else if (e.key.toLowerCase() === 'c' && !modKey) { document.getElementById('menuCollapse')?.click(); }
    // Health filter shortcut (F cycles through health filters, skip if Ctrl/Cmd held)
    else if (e.key.toLowerCase() === 'f' && !modKey) {
      e.preventDefault();
      document.getElementById('menuFilterHealth')?.click();
    }
    // Toggle badges (B)
    else if (e.key.toLowerCase() === 'b') { document.getElementById('menuBadges')?.click(); }
    // Arrow key date nudging for focused issue bars
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const focusedBar = document.activeElement?.closest('.issue-bar:not(.parent-bar)');
      if (!focusedBar) return;
      e.preventDefault();
      const issueId = parseInt(focusedBar.dataset.issueId);
      const startDate = focusedBar.dataset.startDate;
      const dueDate = focusedBar.dataset.dueDate;
      if (!startDate && !dueDate) return;

      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const addDays = (dateStr, days) => {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + days);
        return d.toISOString().slice(0, 10);
      };

      let newStart = null, newDue = null;
      if (e.shiftKey && dueDate) {
        // Shift+Arrow: resize end date only
        newDue = addDays(dueDate, delta);
      } else if (e.altKey && startDate) {
        // Alt+Arrow: resize start date only
        newStart = addDays(startDate, delta);
      } else {
        // Plain Arrow: move entire bar
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
        vscode.postMessage({ command: 'updateDates', issueId, startDate: newStart, dueDate: newDue });
      }
    }
    // Quick search (/)
    else if (e.key === '/' && !modKey) {
      e.preventDefault();
      showQuickSearch();
    }
    // Keyboard shortcuts help (?)
    else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      toggleKeyboardHelp();
    }
  });

  // Quick search overlay
  let quickSearchEl = null;
  function showQuickSearch() {
    if (quickSearchEl) { quickSearchEl.remove(); }
    quickSearchEl = document.createElement('div');
    quickSearchEl.className = 'quick-search';
    quickSearchEl.innerHTML = `
      <input type="text" placeholder="Search issues..." autofocus />
    `;
    document.body.appendChild(quickSearchEl);
    const input = quickSearchEl.querySelector('input');
    input.focus();

    const labels = Array.from(document.querySelectorAll('.issue-label'));
    input.addEventListener('input', () => {
      const query = input.value.toLowerCase();
      labels.forEach(label => {
        const text = label.getAttribute('aria-label')?.toLowerCase() || '';
        const match = query && text.includes(query);
        label.classList.toggle('search-match', match);
      });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeQuickSearch();
      } else if (e.key === 'Enter') {
        const match = document.querySelector('.issue-label.search-match');
        if (match) {
          closeQuickSearch();
          match.focus();
          scrollToAndHighlight(match.dataset.issueId);
        }
      }
    });

    input.addEventListener('blur', () => setTimeout(closeQuickSearch, 150));
  }

  function closeQuickSearch() {
    if (quickSearchEl) {
      quickSearchEl.remove();
      quickSearchEl = null;
      document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
    }
  }

  // Keyboard help overlay
  let keyboardHelpEl = null;
  function toggleKeyboardHelp() {
    if (keyboardHelpEl) {
      keyboardHelpEl.remove();
      keyboardHelpEl = null;
      return;
    }
    keyboardHelpEl = document.createElement('div');
    keyboardHelpEl.className = 'keyboard-help';
    keyboardHelpEl.innerHTML = `
      <div class="keyboard-help-content">
        <h3>Keyboard Shortcuts</h3>
        <div class="shortcut-grid">
          <div class="shortcut-section">
            <h4>Navigation</h4>
            <div><kbd>↑</kbd><kbd>↓</kbd> Move between issues</div>
            <div><kbd>Home</kbd><kbd>End</kbd> First/last issue</div>
            <div><kbd>PgUp</kbd><kbd>PgDn</kbd> Jump 10 rows</div>
            <div><kbd>Tab</kbd> Label → Bar</div>
            <div><kbd>Shift+Tab</kbd> Bar → Label</div>
          </div>
          <div class="shortcut-section">
            <h4>Date Editing</h4>
            <div><kbd>←</kbd><kbd>→</kbd> Move bar ±1 day</div>
            <div><kbd>Shift+←/→</kbd> Resize end</div>
            <div><kbd>Alt+←/→</kbd> Resize start</div>
            <div><kbd>Ctrl+Z</kbd> Undo</div>
            <div><kbd>Ctrl+Y</kbd> Redo</div>
          </div>
          <div class="shortcut-section">
            <h4>View</h4>
            <div><kbd>1-5</kbd> Zoom levels</div>
            <div><kbd>H</kbd> Heatmap</div>
            <div><kbd>D</kbd> Dependencies</div>
            <div><kbd>C</kbd> Critical path</div>
            <div><kbd>T</kbd> Today</div>
          </div>
          <div class="shortcut-section">
            <h4>Health & Other</h4>
            <div><kbd>F</kbd> Cycle health filter</div>
            <div><kbd>B</kbd> Next blocked issue</div>
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
    keyboardHelpEl.addEventListener('click', (e) => {
      if (e.target === keyboardHelpEl) toggleKeyboardHelp();
    });
  }

  // Close help on Escape
  addDocListener('keydown', (e) => {
    if (e.key === 'Escape' && keyboardHelpEl) {
      e.stopImmediatePropagation();
      toggleKeyboardHelp();
    }
  });
}
