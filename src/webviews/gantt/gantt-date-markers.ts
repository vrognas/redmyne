import { formatLocalDate, getLocalToday } from "../../utilities/date-utils";
import { dateToX } from "./gantt-coords";
import { computeHeaderDimRects, computeFutureDimStartMs } from "./header-dim";

export type ZoomLevel = "day" | "week" | "month" | "quarter" | "year";

/** Get today's date as YYYY-MM-DD string */
const getTodayStr = (): string => formatLocalDate(getLocalToday());

const WEEKDAYS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Get ISO week number for a date (uses UTC to avoid timezone issues) */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Generate the timeline header/body/today-marker SVG for a date range.
 * Pure presentation — moved verbatim from GanttPanel._generateDateMarkers.
 */
export function generateDateMarkers(
    minDate: Date,
    maxDate: Date,
    svgWidth: number,
    zoomLevel: ZoomLevel = "day",
    windowEndMs: number | null = null
  ): { header: string; body: string; todayMarker: string } {
    const headerContent: string[] = [];
    const weekendBackgrounds: string[] = [];
    const bodyGridLines: string[] = [];
    let todayMarkerSvg = "";
    let currentPeriodHighlight = "";
    const current = new Date(minDate);
    // The x-axis maps calendar dates to UTC-midnight instants, so every
    // today/period comparison must live in the UTC frame too. todayUTC is
    // the UTC midnight of the user's LOCAL calendar day — comparing via
    // formatLocalDate shifted the marker one gridline right west of UTC.
    const todayLocal = getTodayStr();
    const todayUTC = new Date(todayLocal);
    const todayYear = todayUTC.getUTCFullYear();
    const todayMonth = todayUTC.getUTCMonth();
    const todayQuarter = Math.floor(todayMonth / 3);
    const todayDayOfWeek = todayUTC.getUTCDay();

    // Get start of current period (for highlight)
    let periodStart: Date;
    let periodDays: number;
    switch (zoomLevel) {
      case "day":
      case "week": {
        // Highlight the whole current week (Monday–Sunday). In Day zoom this
        // keeps the current week one uniform shade instead of splitting it
        // (past-dim before today, today bright, future-dim after); the
        // today-marker still points at today.
        periodStart = new Date(todayUTC);
        const daysFromMonday = todayDayOfWeek === 0 ? 6 : todayDayOfWeek - 1;
        periodStart.setUTCDate(periodStart.getUTCDate() - daysFromMonday);
        periodDays = 7;
        break;
      }
      case "month":
        periodStart = new Date(Date.UTC(todayYear, todayMonth, 1));
        periodDays = new Date(Date.UTC(todayYear, todayMonth + 1, 0)).getUTCDate();
        break;
      case "quarter": {
        const quarterStartMonth = todayQuarter * 3;
        periodStart = new Date(Date.UTC(todayYear, quarterStartMonth, 1));
        const quarterEndMonth = quarterStartMonth + 3;
        const quarterEnd = new Date(Date.UTC(todayYear, quarterEndMonth, 0));
        periodDays = Math.round((quarterEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        break;
      }
      case "year":
        periodStart = new Date(Date.UTC(todayYear, 0, 1));
        periodDays = (todayYear % 4 === 0 && (todayYear % 100 !== 0 || todayYear % 400 === 0)) ? 366 : 365;
        break;
    }
    // UTC string — compared against UTC-frame `current` in the loop below.
    const periodStartStr = periodStart.toISOString().slice(0, 10);

    const dayWidth =
      svgWidth /
      ((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));

    // Track last shown markers to avoid duplicates
    let lastMonth = -1;
    let lastQuarter = -1;
    let lastYear = -1;

    // Cache month names to avoid expensive toLocaleString() calls in loop
    const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    while (current <= maxDate) {
      const x = dateToX(current.getTime(), minDate.getTime(), maxDate.getTime(), svgWidth);

      const dayOfWeek = current.getUTCDay();
      const dayOfMonth = current.getUTCDate();
      const month = current.getUTCMonth();
      const year = current.getUTCFullYear();
      const quarter = Math.floor(month / 3) + 1;

      // Generate weekend backgrounds for day/week zoom
      if ((zoomLevel === "day" || zoomLevel === "week") && (dayOfWeek === 0 || dayOfWeek === 6)) {
        weekendBackgrounds.push(`
          <rect x="${x}" y="0" width="${dayWidth}" height="100%" class="weekend-bg"/>
        `);
      }

      // Year markers (for year zoom only - quarter zoom includes year in Q label)
      if (zoomLevel === "year" && month === 0 && dayOfMonth === 1 && lastYear !== year) {
        lastYear = year;
        headerContent.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
          <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="12" font-weight="bold">${year}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
      }

      // Quarter markers (for quarter zoom)
      if (zoomLevel === "quarter" && dayOfMonth === 1 && (month % 3 === 0) && lastQuarter !== quarter) {
        lastQuarter = quarter;
        const quarterLabel = `Q${quarter} ${year}`;
        headerContent.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
          <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">${quarterLabel}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
      }

      // Month markers (for month/quarter/year zoom)
      if ((zoomLevel === "month" || zoomLevel === "quarter" || zoomLevel === "year") && dayOfMonth === 1 && lastMonth !== month) {
        lastMonth = month;
        const monthLabel = MONTH_SHORT[month];
        if (zoomLevel === "month") {
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">${monthLabel} ${year}</text>
          `);
          // Month zoom: use week gridlines only for even spacing (skip month gridlines in body)
        } else if (zoomLevel === "quarter") {
          // Show all month labels on second line (quarter label is on top line)
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">${monthLabel}</text>
          `);
          // Quarter zoom: add month gridlines (lighter)
          if (month % 3 !== 0) { // Don't double line on Q boundaries
            bodyGridLines.push(`
              <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid opacity-02"/>
            `);
          }
        } else if (zoomLevel === "year") {
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">${monthLabel}</text>
          `);
          // Year zoom: add month gridlines
          if (month !== 0) { // Don't double line on Jan 1
            bodyGridLines.push(`
              <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid opacity-02"/>
            `);
          }
        }
      }

      // Week markers (for day/week/month zoom)
      if ((zoomLevel === "day" || zoomLevel === "week" || zoomLevel === "month") && dayOfWeek === 1) {
        const weekNum = getWeekNumber(current);
        const weekEnd = new Date(current);
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        const startDay = dayOfMonth;
        const startMonth = MONTH_SHORT[current.getUTCMonth()];
        const endDay = weekEnd.getUTCDate();
        const endMonth = MONTH_SHORT[weekEnd.getUTCMonth()];
        const dateRange = startMonth === endMonth
          ? `${startDay}-${endDay} ${endMonth}`
          : `${startDay} ${startMonth} - ${endDay} ${endMonth}`;

        if (zoomLevel === "day") {
          // Day zoom: full week info on top line
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + 4}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold">W${weekNum} (${dateRange}) ${year}</text>
          `);
        } else if (zoomLevel === "week") {
          // Week zoom: W48, 2025 on top, 24-30 Nov on bottom (centered within week)
          const weekWidth = dayWidth * 7;
          headerContent.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="40" class="date-marker"/>
            <text x="${x + weekWidth / 2}" y="14" fill="var(--vscode-foreground)" font-size="11" font-weight="bold" text-anchor="middle">W${weekNum}, ${year}</text>
            <text x="${x + weekWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10" text-anchor="middle">${dateRange}</text>
          `);
        } else {
          // Month zoom - just show week number
          headerContent.push(`
            <text x="${x + 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="9">W${weekNum}</text>
          `);
        }
        if (zoomLevel !== "day") {
          // Day zoom has its own grid lines for each day
          bodyGridLines.push(`
            <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
          `);
        }
      }

      // Day markers (for day zoom - show ALL days)
      if (zoomLevel === "day") {
        const dayLabel = `${dayOfMonth} ${WEEKDAYS_SHORT[dayOfWeek]}`;
        headerContent.push(`
          <text x="${x + dayWidth / 2}" y="30" fill="var(--vscode-descriptionForeground)" font-size="10" text-anchor="middle">${dayLabel}</text>
        `);
        bodyGridLines.push(`
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="day-grid"/>
        `);
      }

      // Current period highlight (zoom-level dependent).
      // `current` is a UTC-midnight instant for a calendar day — format it
      // in UTC so the comparison stays timezone-independent.
      const currentStr = current.toISOString().slice(0, 10);
      if (currentStr === periodStartStr) {
        const highlightWidth = dayWidth * periodDays;
        // Header highlight for current period
        currentPeriodHighlight = `
          <rect x="${x}" y="0" width="${highlightWidth}" height="40" class="today-header-bg"/>
          <rect x="${x}" y="37" width="${highlightWidth}" height="3" class="today-header-underline"/>
        `;
      }

      // Today marker line (all zoom levels) - always on current day, only in body (not header)
      if (currentStr === todayLocal) {
        // Separate today-marker for highest z-index (rendered after all bars/milestones)
        todayMarkerSvg = `
          <line x1="${x}" y1="0" x2="${x}" y2="100%" class="today-marker"/>
        `;
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    const weekendGroup = `<g class="weekend-layer">${weekendBackgrounds.join("")}</g>`;

    // Dim the header outside the active window: before the current period
    // (past) and after the active window's end (future), so the active
    // development window stands out. The future boundary is the later of
    // today's period end and the day after the last scheduled task, so
    // today's period and the last task's own cell stay bright. Overlays
    // paint last (on top of labels).
    const dim = computeHeaderDimRects(
      periodStart.getTime(),
      computeFutureDimStartMs(windowEndMs, periodStart.getTime(), periodDays),
      minDate.getTime(),
      maxDate.getTime(),
      svgWidth
    );
    const dimOverlay =
      (dim.past ? `<rect class="header-dim" x="${dim.past.x}" y="0" width="${dim.past.width}" height="100%" pointer-events="none"/>` : "") +
      (dim.future ? `<rect class="header-dim" x="${dim.future.x}" y="0" width="${dim.future.width}" height="100%" pointer-events="none"/>` : "");

    return {
      header: currentPeriodHighlight + headerContent.join("") + dimOverlay,
      body: weekendGroup + bodyGridLines.join(""),
      todayMarker: todayMarkerSvg,
    };
  }
