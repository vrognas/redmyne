# MVP Implementation Decisions

**Date**: 2025-11-23
**Status**: Finalized based on subagent analysis

## Critical Design Changes

### 1. MVP-1: Dual Flexibility Score (MERGED with MVP-2)

**Decision**: Show BOTH planning quality (static) AND current risk (dynamic)

**Formula**:
```typescript
// Initial Flexibility (Planning Quality - Static)
initial_flexibility = (available_time_total / estimated_hours - 1) * 100

where:
  available_time_total = count_working_days(start_date, due_date) * hours_per_day

// Remaining Flexibility (Current Risk - Dynamic)
remaining_flexibility = (available_time_remaining / work_remaining - 1) * 100

where:
  available_time_remaining = count_working_days(TODAY, due_date) * hours_per_day
  work_remaining = max(estimated_hours - spent_hours, 0)
```

**Display Format**:
```
Fix auth bug    3.5/8h 2d +100%→+60% 🟢  #123
```

**Components**:
- `3.5/8h` = spent/estimated hours
- `2d` = working days remaining
- `+100%→+60%` = initial→remaining flexibility
- `🟢` = risk icon (based on remaining flexibility)

**Rationale**:
- Initial flexibility shows if issue was well-planned
- Remaining flexibility shows if you can finish on time TODAY
- Both together enable: "planned well, on track" vs "tight plan, falling behind"

---

### 2. Merge MVP-1 and MVP-2

**Decision**: Combine Flexibility Score + Spent Hours into single "Timeline & Progress Display"

**Rationale**:
- Both modify same tree item description field (conflict if separate)
- Synergistic value: flexibility needs spent_hours to calculate remaining risk
- Reduces implementation time (no separate MVP-2)
- Better UX (all info visible at once)

**New MVP-1**: Timeline & Progress Display (6-8h)

---

### 3. Promote Time Verification to P0

**Decision**: MVP-2 (Time Entry Viewing) is P0, not P1

**Rationale**:
- Critical for billing accuracy (legal/financial requirement)
- User verifies time logs 2-3x daily before EOD
- Can't invoice without accurate verification
- Same priority as timeline indicators

**New MVP-2**: Time Entry Viewing (P0, 4-6h)

---

### 4. Add Workload Overview

**Decision**: Add MVP-4 for capacity planning

**Problem**: Can't answer "Do I have capacity for 8h new request?"

**Solution**: Status bar item (always visible, minimal code)
```
Status Bar: "$(pulse) 25h left, +7h 🟢"

Tooltip (hover):
─────────────────
Workload Overview

Total estimated: 48h
Total spent: 23h
Remaining work: 25h
Available this week: 32h
Capacity: +7h buffer 🟢

Top 3 Urgent:
- #123: DUE TODAY, 8h left 🔴
- #456: 2d left, 5h left 🟡
- #789: 7d left, 12h left 🟢
```

**New MVP-4**: Workload Overview (P1, 1-2h)

**⚠️ Validation Update**: Changed from tree view (120 LOC) to status bar item (20 LOC) - 6× simpler, always visible

---

### 5. Skip Export Feature

**Decision**: No timesheet export in MVP-3

**Rationale**:
- User can manually copy from tree view
- Export adds complexity without critical value
- Can add later if needed

---

## Updated MVP Structure

| # | MVP | Priority | Effort | Merged From |
|---|-----|----------|--------|-------------|
| **MVP-1** | Timeline & Progress Display | P0 | 8-10h | Old MVP-1 + MVP-2 |
| **MVP-2** | Time Entry Viewing | P0 | 4-6h | Old MVP-3 (promoted) |
| **MVP-3** | Quick Time Logging | P1 | 3-4h | Old MVP-4 (renumbered) |
| **MVP-4** | Workload Overview (Status Bar) | P1 | 1-2h | NEW |

**Total**: 16-22 hours (2-3 days)

**⚠️ Validation Update (2025-11-24)**: Effort revised after ultrathink validation review. MVP-1 increased (+2h pre-calc caching), MVP-4 decreased (-4h status bar vs tree view).

---

## Recommended Implementation Order

**⚠️ IMPLEMENT IN THIS SEQUENCE** (not by MVP number):

1. **MVP-3: Quick Time Logging** (3-4h) ⭐ START HERE
   - Simplest design, highest ROI
   - `Ctrl+K Ctrl+L` keybinding
   - 1-issue globalState cache
   - v3.2.0-alpha

2. **MVP-2: Time Entry Viewing** (4-6h)
   - Moderate complexity, P0 priority
   - Cached time entries
   - v3.2.0-beta

3. **MVP-1: Timeline & Progress Display** (8-10h)
   - Most complex, P0 priority
   - Pre-calc caching critical
   - v3.2.0 (P0 complete)

4. **MVP-4: Workload Overview** (1-2h)
   - Trivial status bar item
   - Quick polish
   - v3.3.0 (full suite)

**Rationale**: De-risk by implementing simple→complex, validate patterns early

---

## Priority-Based Phases (Reference)

### Phase 1: P0 Features - 12-16h
1. **MVP-1**: Timeline & Progress Display (8-10h)
2. **MVP-2**: Time Entry Viewing (4-6h)

**Release**: v3.2.0
**Value**: Core billing workflow

### Phase 2: P1 Features - 4-6h
1. **MVP-3**: Quick Time Logging (3-4h)
2. **MVP-4**: Workload Overview (1-2h)

**Release**: v3.3.0
**Value**: Workflow efficiency

---

## Expected Impact

**Current State**: 30-35% workflow coverage, ~10 browser visits/day

**After MVP-1+2 (P0)**: 60-65% workflow coverage, ~4-5 browser visits/day
- ✅ Work prioritization (answered by remaining flexibility)
- ✅ Time verification (view logged entries)
- ❌ Capacity assessment (still need mental math)
- ❌ Timesheet generation (manual copy)

**After MVP-3+4 (P1)**: 75-80% workflow coverage, ~2-3 browser visits/day
- ✅ Quick time logging (10 seconds vs 60 seconds)
- ✅ Capacity assessment (workload overview)
- ❌ Timesheet export (minor gap)
- ❌ Advanced features (issue relations, comments)

**Browser visits reduced**: 10/day → 2-3/day (70-80% reduction)

---

## Risk Assessment Based on Remaining Flexibility

```typescript
remaining_flexibility < 0%   → 🔴 OVERBOOKED (impossible - need more time)
remaining_flexibility = 0%   → 🔴 CRITICAL (no buffer - need every minute)
remaining_flexibility < 20%  → 🟡 TIGHT (minimal buffer)
remaining_flexibility < 50%  → 🟡 LIMITED (some buffer)
remaining_flexibility >= 50% → 🟢 COMFORTABLE (healthy buffer)
```

**Note**: Risk uses **remaining** (dynamic), not initial (static)

---

## Configuration

```json
{
  "redmine.workingHours.hoursPerDay": 8,
  "redmine.workingHours.workingDays": ["Mon", "Tue", "Wed", "Thu"]
}
```

---

## Key Findings from Subagent Analysis

1. **Original MVP-1 was fundamentally flawed**:
   - Calculated planning quality, not current risk
   - Showed static "was this planned well?" instead of dynamic "can I finish on time?"
   - Ignored spent_hours and elapsed time
   - Would have wasted 4-5h implementing wrong feature

2. **Time verification is P0, not P1**:
   - Critical for billing (legal requirement)
   - Must verify before EOD daily
   - Assessment underestimated importance

3. **MVP-1 and MVP-2 must merge**:
   - Both modify same UI field (conflict)
   - Synergistic value (flexibility needs spent_hours)
   - Better UX

4. **Workload overview is critical gap**:
   - Can't answer "do I have capacity?"
   - Missing from original plan
   - Required for 75-80% target

---

## Action Items

1. ✅ Redesign MVP-1 with dual flexibility formula
2. ✅ Merge MVP-1 and MVP-2
3. ✅ Promote time verification to P0
4. ✅ Add workload overview as MVP-4
5. ⏭️ Update MVP_IMPLEMENTATION_PLAN.md with these decisions
6. ⏭️ Begin implementation (MVP-1 first, TDD approach)
