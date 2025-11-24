# MVP UX Guidelines Compliance

**Date**: 2025-11-24
**Source**: 7-subagent analysis of VSCode UX guidelines

---

## Executive Summary

**Overall Grade: B+ (85/100)**

MVP plan follows VSCode patterns well but has **3 critical accessibility issues** and **2 design violations** that must be fixed before implementation.

**Strengths**: Native UI, webview avoidance, proper keybindings, minimal views
**Weaknesses**: Emoji overuse, accessibility gaps, status bar multi-icon

---

## CRITICAL ISSUES (Must Fix)

### 1. 🔴 Accessibility - Emoji Without Text Alternatives

**Violation**: Color-only risk indicators (🟢🟡🔴) lack screen reader support

**Current (MVP-1)**:
```typescript
treeItem.description = `3.5/8h 2d +100%→+60% 🟢  #123`;
```

**Impact**:
- Screen readers announce "green circle" with no context
- Color-blind users cannot distinguish risk levels
- WCAG 2.1 Level AA violation

**Fix (Option A - ThemeIcon)**:
```typescript
// Use ThemeIcon with semantic colors
treeItem.iconPath = new vscode.ThemeIcon(
  'pass',  // or 'warning', 'error'
  new vscode.ThemeColor('testing.iconPassed')
);
treeItem.description = `3.5/8h 2d At Risk  #123`;  // Text status

treeItem.tooltip = new vscode.MarkdownString(`
**Status: At Risk (Overbooked)**
Remaining flexibility: -50%
`);
```

**Fix (Option B - Text + Codicon)**:
```typescript
// Use codicon + descriptive text
treeItem.description = `3.5/8h 2d $(check) Comfortable  #123`;
// $(check) = green, $(warning) = yellow, $(error) = red
```

**Recommendation**: Option A (ThemeIcon) - theme-aware, fully accessible

---

### 2. 🔴 Status Bar Multiple Icons

**Violation**: "Don't include more than one icon unless essential"

**Current (MVP-4)**:
```typescript
statusBar.text = "$(pulse) 25h left, +7h 🟢";  // TWO icons
```

**Impact**:
- Visual clutter
- Unclear icon metaphor (pulse = workload?)
- Emoji inconsistent with codicon patterns

**Fix (Recommended)**:
```typescript
statusBar.text = "25h left, +7h buffer";  // No icons, pure data
```

**Alternative**:
```typescript
statusBar.text = "$(clock) 25h left, +7h";  // Single icon, clear metaphor
```

**Priority**: High - violates explicit guideline

---

### 3. ⚠️ Visual Density - Cluttered Descriptions

**Issue**: MVP-1 description too long for typical sidebar width

**Current**:
```
Fix auth bug              3.5/8h 2d +100%→+60% 🟢  #123
```

**Problems**:
- 35+ characters (truncates on narrow sidebars)
- Cognitive overload: 2 fractions + 2 percentages + arrow + emoji + ID
- Arrow (→) metaphor unclear without context

**Fix**:
```typescript
// Simplified - current status only
treeItem.label = "Fix auth bug";
treeItem.description = "#123 3.5/8h $(check) +60%";  // 20 chars

// Move initial flexibility to tooltip
treeItem.tooltip = new vscode.MarkdownString(`
**Issue #123: Fix auth bug**

**Progress:** 3.5h / 8h (44% complete)

**Initial Plan:** +100% flexibility (2× time buffer) 🟢
**Current Status:** +60% flexibility (still comfortable) 🟢
`);
```

**Rationale**: Description = "what matters NOW", tooltip = full analysis

---

## DESIGN IMPROVEMENTS (Recommended)

### 4. ⚠️ Status Bar Configuration

**Issue**: Always-visible workload may be noise for some users

**Current**: Status bar always shown

**Fix**:
```json
"redmine.statusBar.showWorkload": {
  "type": "boolean",
  "default": false,  // Opt-in to reduce noise
  "description": "Show workload overview in status bar"
}
```

**Rationale**: VSCode guideline - status bar for "contextual" info, workload is global

---

### 5. ⚠️ Missing Loading States

**Issue**: Tree views show empty until data arrives (jarring on slow networks)

**Fix**:
```typescript
async getChildren(element?: TreeItem): Promise<TreeItem[]> {
  if (!element && this.isLoading) {
    return [{
      label: 'Loading time entries...',
      iconPath: new vscode.ThemeIcon('loading~spin'),
      isPlaceholder: true
    }];
  }
  // ... existing fetch logic
}
```

**Applies to**: MVP-2 (Time Entries), any async tree views

---

### 6. 💡 Welcome View for Onboarding

**Missing**: Setup guidance when no server configured

**Add to package.json**:
```json
"viewsWelcome": [{
  "view": "redmine-explorer-my-issues",
  "contents": "No Redmine server configured.\n\n[Configure Server](command:redmine.configure)\n\n[Documentation](https://github.com/vrognas/positron-redmine)"
}]
```

**Priority**: Medium - improves first-time UX

---

### 7. 💡 Collapsible State Documentation

**Inconsistency**: Design says "Today = Expanded", code says "Collapsed"

**Current code** (correct):
```typescript
collapsibleState: vscode.TreeItemCollapsibleState.Collapsed  // Bug #127711 workaround
```

**Fix**: Update design docs to match implementation
```markdown
**Collapsible States**: Start ALL items Collapsed
- Reason: VSCode bug #127711 - `Expanded` items reset on config change
- User preference persists when they manually expand
```

**Priority**: Low - documentation fix only

---

## COMPLIANT PATTERNS (Keep)

### ✅ Overview Guidelines
- Native UI components (QuickPick, InputBox, TreeView)
- Webview avoidance (explicitly rejected as "2-3x complexity")
- Command palette integration
- Keybinding chord pattern (`Ctrl+K Ctrl+L`)

### ✅ Activity Bar Guidelines
- No new Activity Bar items (uses existing container)
- 3 views within recommended 3-5 range
- Clear, descriptive names

### ✅ Sidebar Guidelines
- Minimal view count (only 1 new view)
- Single refresh action (no toolbar clutter)
- Empty state handling ("No time logged today")
- Rich tooltips for context

### ✅ Panel Guidelines
- No panels used (correct - primary sidebar appropriate)
- Vertical hierarchy suits issue tracking

### ✅ Views Guidelines
- Limited nesting (2 levels max)
- Descriptive labels with context
- Secondary info in `description` field

### ✅ Editor Actions Guidelines
- Command naming follows `redmine.commandName` pattern
- Category prefix "Redmine:" in command palette
- Platform-specific keybindings (`cmd` for Mac)
- No conflicts (fixed Ctrl+K Ctrl+T issue)

---

## IMPLEMENTATION PRIORITY

### Phase 1: Critical Fixes (Block implementation)
1. ✅ Replace emoji risk indicators with ThemeIcon (MVP-1)
2. ✅ Remove multi-icon from status bar (MVP-4)
3. ✅ Simplify tree descriptions (MVP-1)
4. ✅ Add accessible status text (all MVPs)

**Effort**: ~2-3 hours

---

### Phase 2: Quality Improvements (Before v3.2.0)
5. ✅ Add loading states (MVP-2)
6. ✅ Add Welcome View (all views)
7. ✅ Make status bar opt-in (MVP-4)
8. ✅ Update collapsible state docs (MVP-2)

**Effort**: ~1-2 hours

---

### Phase 3: Polish (v3.3.0+)
9. ⏭️ Audit Activity Bar icon (existing extension)
10. ⏭️ Consider container rename (if confusing)
11. ⏭️ Test high-contrast themes

**Effort**: ~1 hour

---

## UPDATED FILES WITH FIXES

### MVP-1: Timeline & Progress Display

**File**: `src/utilities/tree-item-factory.ts`

```typescript
// BEFORE (violations):
treeItem.description = `3.5/8h 2d +100%→+60% 🟢  #123`;

// AFTER (compliant):
treeItem.description = `#123 3.5/8h 2d $(check) +60%`;

treeItem.iconPath = new vscode.ThemeIcon(
  'pass',  // or 'warning', 'error' based on risk
  new vscode.ThemeColor('testing.iconPassed')
);

treeItem.tooltip = new vscode.MarkdownString(`
**Issue #123: ${issue.subject}**

**Progress:** 3.5h / 8h (44% complete)

**Initial Plan:**
- Flexibility: +100% (2× time buffer)
- Status: Comfortable

**Current Status:**
- Remaining: 2 working days (16h available)
- Flexibility: +60% (still comfortable)
- Status: On Track

[View in Redmine](${serverUrl}/issues/${issue.id})
`);
```

**Risk level mapping**:
```typescript
function getRiskIcon(flexibility: number): { icon: string, color: string, status: string } {
  if (flexibility < 0) return { icon: 'error', color: 'errorForeground', status: 'Overbooked' };
  if (flexibility < 20) return { icon: 'warning', color: 'warningForeground', status: 'At Risk' };
  return { icon: 'pass', color: 'testing.iconPassed', status: 'On Track' };
}
```

---

### MVP-4: Workload Overview

**File**: `src/extension.ts`

```typescript
// BEFORE (violations):
statusBar.text = "$(pulse) 25h left, +7h 🟢";

// AFTER (compliant):
const config = vscode.workspace.getConfiguration('redmine.statusBar');
if (config.get<boolean>('showWorkload', false)) {  // Opt-in
  statusBar.text = "25h left, +7h buffer";  // No icons
  statusBar.show();
}
```

**package.json**:
```json
"redmine.statusBar.showWorkload": {
  "type": "boolean",
  "default": false,
  "description": "Show workload overview in status bar"
}
```

---

### All MVPs: Welcome View

**File**: `package.json`

```json
"contributes": {
  "viewsWelcome": [
    {
      "view": "redmine-explorer-my-issues",
      "contents": "No Redmine server configured.\n\n[$(gear) Configure Server](command:redmine.configure)\n\n[$(book) Documentation](https://github.com/vrognas/positron-redmine)",
      "when": "!redmine:serverConfigured"
    },
    {
      "view": "redmine-explorer-my-time-entries",
      "contents": "No Redmine server configured.\n\n[$(gear) Configure Server](command:redmine.configure)",
      "when": "!redmine:serverConfigured"
    }
  ]
}
```

---

## TESTING CHECKLIST

### Accessibility
- [ ] Screen reader announces risk status as text (not "green circle")
- [ ] High-contrast theme shows clear icon differentiation
- [ ] Color-blind mode distinguishes risk levels
- [ ] Keyboard navigation works for all tree items

### Visual Consistency
- [ ] Icons match VSCode theme (dark/light/high-contrast)
- [ ] Status bar text readable without icons
- [ ] Tree descriptions don't truncate on 280px sidebar
- [ ] Tooltips render correctly in all themes

### Functional
- [ ] Loading states appear during API calls
- [ ] Welcome view shows when no server configured
- [ ] Status bar configurable via settings
- [ ] Collapsible state persists after manual expansion

---

## EFFORT IMPACT

**Original MVP estimates**: 16-22h
**UX compliance fixes**: +2-3h (Phase 1) + 1-2h (Phase 2) = +3-5h
**New total**: **19-27h** (2.5-3.5 days)

**Breakdown**:
- MVP-1: 8-10h → 9-11h (+1h for ThemeIcon refactor)
- MVP-2: 4-6h → 5-7h (+1h for loading states)
- MVP-3: 3-4h (no change)
- MVP-4: 1-2h → 2-3h (+1h for configuration)

---

## SUMMARY

### What's Working
- Architecture follows VSCode patterns (native UI, no webviews)
- Keybinding conventions correct
- Minimal view proliferation
- Proper command structure

### What Needs Fixing
- **Accessibility**: Emoji → ThemeIcon + text alternatives
- **Status Bar**: Remove multi-icon, add configuration
- **Visual Density**: Simplify descriptions
- **Polish**: Loading states, welcome views

### Impact
- Critical fixes prevent accessibility violations (legal/compliance risk)
- Design improvements enhance first-time UX
- Total overhead: +3-5 hours (15-20% increase)
- Result: Fully compliant, accessible extension

---

## NEXT STEPS

1. ✅ Integrate UX fixes into MVP_IMPLEMENTATION_PLAN.md
2. ⏭️ Update tree-item-factory design with ThemeIcon pattern
3. ⏭️ Update MVP-4 status bar code examples
4. ⏭️ Add accessibility testing to QA checklist
5. ⏭️ Begin implementation with UX-compliant patterns

---

## REFERENCES

- [Overview Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)
- [Activity Bar Guidelines](https://code.visualstudio.com/api/ux-guidelines/activity-bar)
- [Sidebar Guidelines](https://code.visualstudio.com/api/ux-guidelines/sidebars)
- [Panel Guidelines](https://code.visualstudio.com/api/ux-guidelines/panel)
- [Status Bar Guidelines](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [Views Guidelines](https://code.visualstudio.com/api/ux-guidelines/views)
- [Editor Actions Guidelines](https://code.visualstudio.com/api/ux-guidelines/editor-actions)
- [VSCode Bug #127711: Collapsible State Persistence](https://github.com/microsoft/vscode/issues/127711)
