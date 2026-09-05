# Glassbox — accessibility and ease-of-use study

*v0.1.0 · 5 September 2026 · method: axe-core 4.13 in Chromium across five UI states in light and dark, computed WCAG contrast for every colour-token pair the page uses, a scripted keyboard walk, semantic inspection of the DOM, 390 / 768 / 1280 px viewports with touch emulation, and a stress run on a 16.6 MB synthetic session (5,000 tool calls, 5,040 requests). Harness: `test/audit.mjs`; raw output: `dist/audit.json`.*

> **Status (later on 5 Sep 2026):** Tier A, Tier B and the CLI from Tier C are implemented in v0.2. `npm run audit` now passes with zero serious/critical violations and every text pair at AA; the remaining Tier C items (Stop hook, compare, live tail, importers) are open.

## 1. Summary

Glassbox works well for a sighted mouse user on a laptop, which is who it was built for in twenty minutes. For everyone else it has real gaps. Screen-reader and keyboard users cannot reach the two things the page is for — the timeline spans and the tool rows — and the drawer that shows detail is announced as hidden even when open. Contrast fails WCAG AA in the light theme for the accent, the faint labels and most span labels, and in the dark theme for the span labels. Touch users can't zoom or pan the timeline at all. None of this is structural; the fixes are token changes, attributes and a few dozen lines of focus handling, and the page is fast enough (a 16 MB transcript parses in 0.26 s and renders in 1.4 s) that adding them costs nothing.

Beyond compliance, the biggest ease-of-use hurdle is the first ten seconds: finding the `.jsonl` file. Everything in section 4 flows from that.

## 2. Accessibility findings

Severity: **A** blocks a group of users outright · **B** makes a task materially harder · **C** polish. WCAG references are 2.2 AA.

| # | Sev | Finding | Evidence | WCAG |
|---|---|---|---|---|
| A1 | A | Timeline spans (model, tool, idle) and burn-chart bars are `<rect>`s with no `tabindex`, no `role`, no accessible name. The core visualisation is invisible to keyboard and screen-reader users. | `timelineSpans: false`, `burnBars: false`; SVGs carry no `<title>`/`aria-label` | 1.1.1, 2.1.1, 4.1.2 |
| A2 | A | Tool table rows and turn steps are click-only `<tr>`/`<div>`s with no keyboard access; the table's scroll container is unfocusable, so its content can't be scrolled by keyboard either. | `tableRows: false`, `turnSteps: false`; axe `scrollable-region-focusable` ×2 | 2.1.1 |
| A3 | A | Detail drawer: `aria-hidden="true"` while its close button remains in the tab order (axe `aria-hidden-focus`, serious); when it opens, focus does not move into it; it has no `role="dialog"` or accessible name. A screen reader never learns the drawer opened. | `drawerFocusMoves: false`, `drawerRole: null` | 2.4.3, 4.1.2, 1.3.1 |
| A4 | A | Rate-card dialog: 75 numeric inputs with no label (axe `label`, critical). Each cell needs an `aria-label` like "claude-sonnet-4 · input price". | axe light/dark `rates-dialog` | 1.3.1, 4.1.2 |
| B1 | B | Contrast, light theme: `--faint` on panel 3.03 (tile labels, rule ids, ticks at 10–11 px), `--faint` on ground 2.75, `--accent` on panel 3.58 (links, cost line), primary-button text on accent 3.58, `--warn` count 2.95, `--info` 4.11. White labels on span colours: write 2.3, exec 3.36, read 4.11, mcp 4.36. | 42 axe `color-contrast` nodes in loaded state | 1.4.3 |
| B2 | B | Contrast, dark theme: white span labels on every category colour fail (read 2.86, write 1.87, exec 2.46, agent 3.0, user 3.16, mcp 2.93). `--faint` on panel 3.93. | 41 axe nodes | 1.4.3 |
| B3 | B | Non-text contrast: panel borders 1.3:1, model spans 1.8:1 (light) / 2.3:1 (dark), idle hatch 1.2:1. Low-vision users lose the boundaries of the very shapes that encode time. | computed | 1.4.11 |
| B4 | B | Tooltip is mouse-only (`mousemove`), has no `role="tooltip"`, and its content (duration, status, tokens) exists nowhere else for a keyboard user until they click. | `tooltipRole: null` | 1.4.13, 2.1.1 |
| B5 | B | Zoom and pan are wheel and mouse-drag only. No keyboard zoom (only `0` resets), no on-screen +/− controls, no touch handlers (pinch or drag do nothing on a phone). | `keyboardZoom: false`, `touchZoom: false` | 2.1.1, 2.5.7 |
| B6 | B | Share mode is a two-state control with no `aria-pressed`, and the only way to leave it is a **right-click** on the button — undiscoverable for everyone and impossible on touch or keyboard. | `shareExitMethod` | 4.1.2, 2.1.1 |
| B7 | B | No live region: after a drop the page silently swaps landing for results. A screen reader gets no "Loaded 58 tool calls, 10 findings". Parse problems (`#problems`) appear the same way. | `liveRegionForLoad: false` | 4.1.3 |
| B8 | B | Sortable headers have no `aria-sort`; sort direction is only the ↓/↑ glyph. Stat tiles are unlabelled `<div>`s (a `<dl>` would read as "Wall time: 25 m 12 s"). | `tableHeadersAriaSort: false`, `statTilesHaveRoles: false` | 1.3.1 |
| C1 | C | No `<main>` landmark; eight regions outside any landmark (axe `landmark-one-main`, `region`). | axe | best practice |
| C2 | C | Smallest text is 10 px (axis ticks, span labels). Fine for AA (no minimum) but at 200 % zoom the SVG text scales while the tick density does not, so labels collide. | `fontSizeMinPx: 10` | 1.4.4 |
| C3 | C | Findings severity is colour bar + count; the bar has no text equivalent, though the rule id and title carry the meaning. Category colours in the legend have text; category on table rows is a colour swatch only. | inspection | 1.4.1 |
| C4 | C | Rate-card table has an empty header cell over the delete column (axe minor). | axe | 1.3.1 |
| — | ok | `lang="en"` set; `prefers-reduced-motion` honoured; heading outline is sane; no page-level horizontal overflow at 320 CSS px (200 % zoom) or on a 390 px phone — the tools table scrolls inside its own panel; native `<dialog>` used for the two modals (focus trap and Escape for free); findings are keyboard-reachable with Enter/Space. | audit | — |

## 3. Ease-of-use findings (sighted, mouse, laptop)

**Finding the file is the whole onboarding.** The landing panel gives two shell commands. Most Claude Code users have never looked in `~/.claude/projects`, the folder names are the project path with slashes turned into dashes, and the file names are UUIDs. A user has to open a terminal, list by date, guess which UUID is "the session where it broke", then drag it from Finder/Explorer. Nothing in the tool helps with this, and it is the single step most likely to lose a first-time visitor.

**The demo is the only thing that shows what the page does.** Until a file is loaded the page is a paragraph and a drop zone. The demo button is there, but the "at rest" state doesn't preview the product.

**Timeline learning curve.** Zoom-by-wheel with no visible controls and no minimap means users don't discover that they can zoom; at session length the spans are slivers. There's no "fit to turn" or "jump to finding" beyond clicking a finding, and no time cursor showing where you are.

**Findings are a list, not a workflow.** You can click one to see it, but you can't dismiss, mark as read, copy it, or export the set. The obvious next action after reading "Bash failed 6 of 6" is to paste it into an issue or back into the agent — there's no button for that.

**Share mode's second click exports.** Same button, different action depending on state, no confirmation. The download also silently does nothing inside the hosted artifact sandbox.

**Small screens.** At 390 px the stat strip and findings read well; the timeline lane labels take a third of the width and the SVG height (194 px) shows about six seconds of useful span area; the tools table needs sideways scrolling inside its panel with no sticky first column, so the tool name scrolls away while you read its numbers.

**Performance is not a problem.** 16.6 MB / 5,000 tool calls: parse 258 ms, diagnose 22 ms, first render 1.4 s, 10,186 SVG nodes, a zoom step re-renders in 33 ms (two frames), 104 MB heap. A 50 MB transcript would still be fine; at 200 MB the full-SVG-rebuild approach would start to stutter and canvas would be the fix.

## 4. What users would need next

Grouped as three tiers. Effort is a rough guide for one focused session each.

### Tier A — make it correct for everyone (half a day)

Everything in section 2 is fixable inside `viewer.html` without touching the engine. Token changes: darken `--faint` and `--accent` in light, put span labels in dark text on the lighter category fills or drop labels below 40 px and rely on the tooltip, raise `--line` and `--c-model` to 3:1. Attributes: `role="img"` + `<title>` on both SVGs, `tabindex="0"` + `role="button"` + `aria-label` on every span and row and step, `aria-sort` on headers, `<dl>` for the stat strip, `aria-pressed` on Share, `aria-label` on every rate input, `<main>`. Behaviour: roving focus in the timeline (arrow keys move between spans, Enter opens the drawer), `+`/`−` keys and on-screen buttons for zoom, pointer events with pinch for touch, focus moved into the drawer on open and restored on close, a polite live region announcing load results, and a proper Share dropdown (on / off / export) instead of right-click.

### Tier B — make it easy (a day)

- **Open the folder, not the file.** Chrome and Edge support `showDirectoryPicker()`. One button — "Open ~/.claude/projects" — lists every project and session with its title (from the `summary` record), date, size and turn count; click to load, subagents picked up automatically. The directory handle can be remembered in IndexedDB so the next visit shows "Recent sessions" instantly. This removes the terminal from onboarding for most users. Firefox and Safari keep the drop zone.
- **Landing state that shows the product.** Render the demo behind a translucent "your session goes here" overlay, or a static screenshot strip, so a first visit shows what the page does before any file is loaded.
- **Timeline controls**: zoom buttons, "fit to turn N", a minimap of the whole session with the current viewport marked, a time cursor with the timestamp, and a `?` shortcut sheet.
- **Findings as a workflow**: copy one as Markdown, "Copy all findings", "Export report" (Markdown or JSON) sized for pasting into an issue or a Claude Code prompt ("here's what went wrong last session, avoid it").
- **Search** across prompts, tool inputs and results, with hits marked on the timeline.
- **In-page theme toggle** and a density toggle (the tool is dense by design; some people want 16 px).
- **Sticky first column** on the tools table and turn steps on small screens; lane labels collapse to icons under 600 px.
- **Permalinks**: `#req=17` / `#tool=toolu_…` so a colleague opens the file at the same spot (works with the hosted artifact and with `file://`).

### Tier C — make it a product (each a small project)

- **`npx glassbox`**: a tiny Node CLI that finds the newest session (or `--last 5`, or `--grep "failed"`), builds a self-contained HTML with the trace embedded, and opens it. Also `glassbox check session.jsonl --fail-on error` for CI and for people who never want a browser. The engine already runs in Node; this is packaging.
- **Let the agent read its own recorder.** A Claude Code Stop hook or `/glassbox` skill that runs `diagnose()` on the current session and prints the findings back into the conversation: "3 retry loops, context at 180k, consider compacting." This is the "your own system benefits" half of the original brief, and nobody has shipped it.
- **Compare two sessions** side by side (before/after a prompt change, two models on the same task): same turns, cost delta, tool-mix delta.
- **Live tail**: watch a session as it runs (`glassbox tail`), the timeline growing at the right edge. Needs the CLI, since browsers can't watch files.
- **Rate card auto-update** from a pinned JSON in the repo, with the fetched date shown, so cost estimates stop going stale on their own.
- **Import for other agents**: OpenAI Agents SDK traces, LangGraph / LangSmith exports, Cursor and Codex logs. The data model is already agent-neutral (requests, tool calls, turns, agents); only the parsers differ. This is the route from "Claude Code tool" to "the trace viewer".

## 5. Recommended order

Tier A first, because the tool's name is Glassbox and it currently isn't transparent to a screen reader; it's also the cheapest work here and the audit harness in `test/audit.mjs` will confirm the fixes mechanically. Then the folder picker and findings export from Tier B — those two change the first-run experience more than everything else combined. Then the CLI and the Stop hook from Tier C, which are what would make Claude Code users adopt it as a habit rather than a curiosity.

## Appendix — numbers

Contrast table, tab order, semantics flags, responsive metrics and performance figures are in `dist/audit.json`. Reproduce with `npm run build && node test/audit.mjs`.
