/**
 * Rendering and mouse helpers added by the enhanced build of pi-ask-user.
 *
 * Kept apart from index.ts so upstream changes merge cleanly. Everything here
 * degrades on older Pi versions and limited themes: colors come from the Pi
 * theme (never hard-coded), and features that need newer theme APIs fall back
 * to the plain look.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";

// ── Layout by width (R1) ─────────────────────────────────────────────────────

/** Inner widths at which the option area switches layout. */
export const SPLIT_LAYOUT_MIN_WIDTH = 84;
export const STRIP_LAYOUT_MIN_WIDTH = 60;

/**
 * - `split`: list on the left, preview on the right.
 * - `strip`: list, then the focused option's preview underneath.
 * - `accordion`: only the focused option expands its description in place.
 * - `list`: every description under its option (upstream layout, and the
 *   `singleSelectLayout: "list"` preference).
 */
export type OptionLayout = "split" | "strip" | "accordion" | "list";

export function chooseOptionLayout(width: number, preference: "auto" | "list", splitFits: boolean): OptionLayout {
   if (preference === "list") return "list";
   if (width >= SPLIT_LAYOUT_MIN_WIDTH && splitFits) return "split";
   if (width >= STRIP_LAYOUT_MIN_WIDTH) return "strip";
   return "accordion";
}

// ── Theme helpers ────────────────────────────────────────────────────────────

/** The opening escape of a theme background token, or "" when the theme can't provide it. */
export function themeBgOpen(theme: Theme, token: string): string {
   try {
      const probe = (theme as unknown as { bg(token: string, text: string): string }).bg(token, "\u0000");
      const at = probe.indexOf("\u0000");
      return at > 0 ? probe.slice(0, at) : "";
   } catch {
      return "";
   }
}

/** Background for the focused list row (V1): Pi's selection color, as in Pi's own pickers. */
export const HIGHLIGHT_BG = "selectedBg";
/** Background for the preview panel (V2): Pi's card color for pending tool output. */
export const PANEL_BG = "toolPendingBg";

/**
 * Paint a row with a background across `width` cells. Resets inside the row
 * (from styled spans) re-open the background, so the color doesn't stop at
 * the first styled word.
 */
export function paintRow(line: string, width: number, open: string): string {
   const padded = truncateToWidth(line, width, "", true);
   if (!open) return padded;
   return `${open}${padded.replace(/\x1b\[(?:0|49)?m/g, (reset) => `${reset}${open}`)}\x1b[49m`;
}

type StyleFn = (text: string, options: { fg?: unknown; bg?: unknown }) => string;

/** Thumb and track colors for the smooth scrollbar, or null when the theme can't style both slots. */
function scrollbarColors(theme: Theme): { style: StyleFn; thumb: unknown; track: unknown } | null {
   try {
      const t = theme as unknown as { style?: StyleFn; colors?: Record<string, unknown> };
      if (typeof t.style !== "function" || !t.colors) return null;
      const thumb = t.colors.accent;
      const track = t.colors.scrollbarTrack ?? t.colors.borderMuted;
      if (!thumb || !track) return null;
      return { style: t.style.bind(theme), thumb, track };
   } catch {
      return null;
   }
}

// ── Scrollbar (V3) ───────────────────────────────────────────────────────────

const LOWER_BLOCKS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface RailRender {
   /** One cell per row, already styled. */
   cells: string[];
   /** Rows covered by the thumb (end exclusive), or null when nothing overflows. */
   thumb: { start: number; end: number } | null;
   maxOffset: number;
}

/**
 * A scrollbar `rows` tall. With a capable theme the thumb moves in 1/8-row
 * steps using block characters; the cell where the thumb's top edge falls is
 * drawn as a lower block in track color over a thumb-colored background.
 * Older themes get the plain █ thumb on a │ track.
 */
export function renderRail(theme: Theme, rows: number, total: number, viewport: number, offset: number): RailRender {
   const maxOffset = Math.max(0, total - viewport);
   if (rows <= 0) return { cells: [], thumb: null, maxOffset };
   if (maxOffset <= 0) return { cells: Array.from({ length: rows }, () => " "), thumb: null, maxOffset };
   const ratio = Math.min(1, Math.max(0, offset / maxOffset));
   const colors = scrollbarColors(theme);
   if (!colors) {
      const len = Math.max(1, Math.min(rows, Math.round((rows * viewport) / total)));
      const start = Math.round(ratio * (rows - len));
      return {
         cells: Array.from({ length: rows }, (_, row) =>
            row >= start && row < start + len ? theme.fg("accent", "█") : theme.fg("dim", "│")),
         thumb: { start, end: start + len },
         maxOffset,
      };
   }
   const trackEighths = rows * 8;
   const lenEighths = Math.max(8, Math.min(trackEighths, Math.round((trackEighths * viewport) / total)));
   const startEighths = Math.round(ratio * (trackEighths - lenEighths));
   const endEighths = startEighths + lenEighths;
   const { style, thumb, track } = colors;
   const cells = Array.from({ length: rows }, (_, row) => {
      const top = row * 8;
      const bottom = top + 8;
      const covered = Math.max(0, Math.min(bottom, endEighths) - Math.max(top, startEighths));
      if (covered <= 0) return style(" ", { bg: track });
      if (covered >= 8) return style("█", { fg: thumb, bg: track });
      // Thumb fills the lower part of this cell.
      if (startEighths > top) return style(LOWER_BLOCKS[bottom - startEighths]!, { fg: thumb, bg: track });
      // Thumb fills the upper part: draw the empty lower part in track color.
      return style(LOWER_BLOCKS[8 - (endEighths - top)]!, { fg: track, bg: thumb });
   });
   return { cells, thumb: { start: Math.floor(startEighths / 8), end: Math.ceil(endEighths / 8) }, maxOffset };
}

// ── Preview pane (Fix 8 "1A") ────────────────────────────────────────────────

export interface PreviewSubject {
   title: string;
   /** Markdown shown under the title. */
   detail: string;
   /** Short styled note after the title, e.g. "✓ will be sent". */
   badge?: string;
   /** Render the detail dim (placeholder text such as "No description"). */
   muted?: boolean;
}

/** The detail as display lines: markdown when Pi's theme is available (links become OSC 8 links), plain wrapping otherwise. */
export function previewDocLines(theme: Theme, subject: PreviewSubject, width: number, mdTheme: MarkdownTheme | undefined): string[] {
   const textWidth = Math.max(4, width);
   let lines: string[];
   if (mdTheme && !subject.muted) {
      lines = new Markdown(subject.detail, 0, 0, mdTheme).render(textWidth);
   } else {
      lines = [];
      for (const raw of subject.detail.split(/\r?\n/)) {
         const wrapped = wrapTextWithAnsi(raw, textWidth);
         lines.push(...(wrapped.length ? wrapped : [""]));
      }
      if (subject.muted) lines = lines.map((line) => theme.fg("dim", line));
   }
   while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
   return lines;
}

export interface PreviewRender {
   lines: string[];
   total: number;
   viewport: number;
   offset: number;
   overflow: boolean;
   /** Column of the scrollbar inside the pane. */
   railCol: number;
   thumb: { start: number; end: number } | null;
   maxOffset: number;
}

export interface PreviewOptions {
   mdTheme?: MarkdownTheme;
   /** Background escape for the whole pane (V2), or "" for none. */
   tint?: string;
   /** Draw the title row; the accordion shows the title as the list row instead. */
   titleRow?: boolean;
}

/** Rows the pane needs to show `subject` without scrolling, at `width`. */
export function previewNeedRows(theme: Theme, subject: PreviewSubject, width: number, options: PreviewOptions = {}): number {
   return (options.titleRow === false ? 0 : 1) + previewDocLines(theme, subject, Math.max(4, width - 3), options.mdTheme).length;
}

/**
 * The compact preview: one header row with the title (and, only when the text
 * overflows, the visible range on the right), then the description with ↑/↓
 * markers on the edge rows and a scrollbar only when it overflows. Every line
 * is exactly `width` cells: text, a space, the scrollbar column, a space.
 */
export function renderPreviewPane(
   theme: Theme,
   subject: PreviewSubject,
   width: number,
   rows: number,
   offset: number,
   options: PreviewOptions = {},
): PreviewRender {
   const textWidth = Math.max(4, width - 3);
   const doc = previewDocLines(theme, subject, textWidth, options.mdTheme);
   const titleRow = options.titleRow !== false;
   const limit = Math.max(1, rows);
   const viewport = Math.max(1, limit - (titleRow ? 1 : 0));
   const maxOffset = Math.max(0, doc.length - viewport);
   const off = Math.max(0, Math.min(Math.floor(offset), maxOffset));
   const overflow = maxOffset > 0;
   const tint = options.tint ?? "";
   const content: string[] = [];

   if (titleRow) {
      const range = overflow ? `${off + 1}–${Math.min(doc.length, off + viewport)} / ${doc.length}` : "";
      const badge = subject.badge ? `  ${subject.badge}` : "";
      const title = `${theme.fg("text", theme.bold(subject.title))}${badge}`;
      if (range) {
         const room = Math.max(1, textWidth - visibleWidth(range) - 2);
         content.push(`${truncateToWidth(title, room, "…", true)}  ${theme.fg("dim", range)}`);
      } else {
         content.push(title);
      }
   }
   for (let row = 0; row < viewport; row++) {
      const text = doc[off + row];
      if (text === undefined) {
         content.push("");
         continue;
      }
      let marker = "";
      if (row === 0 && off > 0) marker = `↑ ${off}`;
      if (row === viewport - 1 && off + viewport < doc.length) marker = `↓ ${doc.length - off - viewport}`;
      content.push(marker
         ? `${truncateToWidth(text, Math.max(1, textWidth - visibleWidth(marker) - 1), "", true)} ${theme.fg("dim", marker)}`
         : text);
   }

   const rail = renderRail(theme, limit, doc.length, viewport, off);
   const lines = content.slice(0, limit).map((line, row) => {
      const body = paintRow(`${truncateToWidth(line, textWidth, "", true)} `, textWidth + 1, tint);
      // Without a scrollbar the column stays part of the panel, so the tint has no gap.
      const railCell = rail.thumb ? rail.cells[row] ?? " " : paintRow(" ", 1, tint);
      return `${body}${railCell}${paintRow(" ", 1, tint)}`;
   });
   return { lines, total: doc.length, viewport, offset: off, overflow, railCol: textWidth + 1, thumb: rail.thumb, maxOffset };
}

/** Where a description is scrolled to, reset whenever the highlighted option changes. */
export class PreviewScroll {
   offset = 0;
   total = 0;
   viewport = 0;
   active = false;
   private key = "";

   /** Start from the top when `key` (the highlighted option) changes. */
   follow(key: string): void {
      if (key !== this.key) {
         this.key = key;
         this.offset = 0;
      }
   }

   record(render: { offset: number; total: number; viewport: number }): void {
      this.offset = render.offset;
      this.total = render.total;
      this.viewport = render.viewport;
   }

   get maxOffset(): number {
      return Math.max(0, this.total - this.viewport);
   }

   /** True when the visible description is longer than its area. */
   get overflow(): boolean {
      return this.active && this.maxOffset > 0;
   }

   scrollBy(delta: number): boolean {
      const next = Math.max(0, Math.min(this.maxOffset, this.offset + Math.trunc(delta)));
      if (next === this.offset) return false;
      this.offset = next;
      return true;
   }

   scrollTo(offset: number): boolean {
      return this.scrollBy(offset - this.offset);
   }

   /**
    * Preview keys, claimed only while the description overflows (Fix 2): then
    * PgUp/PgDn page it, Alt+↑/↓ (or Alt+K/J) move a line, Alt+Home/End jump.
    * Otherwise the keys fall through, so PgUp/PgDn scroll the question.
    */
   handleKeys(data: string): boolean {
      if (!this.overflow) return false;
      const page = Math.max(1, this.viewport - 1);
      if (matchesKey(data, Key.alt("down")) || matchesKey(data, Key.alt("j"))) this.scrollBy(1);
      else if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("k"))) this.scrollBy(-1);
      else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.alt("pageDown"))) this.scrollBy(page);
      else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.alt("pageUp"))) this.scrollBy(-page);
      else if (matchesKey(data, Key.alt("home"))) this.scrollTo(0);
      else if (matchesKey(data, Key.alt("end"))) this.scrollTo(this.maxOffset);
      else return false;
      return true;
   }
}

// ── Mouse (Fix 11) ───────────────────────────────────────────────────────────

/** What a mouse event landed on. */
export type HitTarget =
   | { kind: "row"; index: number }
   | { kind: "check"; index: number }
   | { kind: "clear" }
   | { kind: "list" }
   | { kind: "preview" }
   | { kind: "rail"; thumbStart: number; thumbEnd: number; maxOffset: number }
   | { kind: "button"; id: string };

export interface HitRect {
   row: number;
   rows: number;
   col: number;
   cols: number;
   target: HitTarget;
}

/** The most specific target at (x, y): rects added earlier win. */
export function hitAt(rects: readonly HitRect[], x: number, y: number): HitRect | undefined {
   return rects.find((rect) => y >= rect.row && y < rect.row + rect.rows && x >= rect.col && x < rect.col + rect.cols);
}

/** Shift rects into a parent's coordinates. */
export function offsetRects(rects: readonly HitRect[], row: number, col: number): HitRect[] {
   return rects.map((rect) => ({ ...rect, row: rect.row + row, col: rect.col + col }));
}

/** The offset that puts the thumb's top on `row` (rail-relative), for dragging. */
export function offsetForThumbRow(row: number, railRows: number, thumbRows: number, maxOffset: number): number {
   const span = Math.max(1, railRows - thumbRows);
   return Math.round((Math.max(0, Math.min(span, row)) / span) * maxOffset);
}

/** Mouse event fields this package reads (pi-tui's TuiMouseEvent, kept structural for older hosts). */
export interface AskMouseEvent {
   type: string;
   x: number;
   y: number;
   wheelDelta?: number;
   clickCount?: number;
   button?: string;
}

export interface AskMouseResult {
   handled?: boolean;
   capture?: boolean;
   render?: boolean;
}

// ── Action bar (I4) ──────────────────────────────────────────────────────────

/** Reverse video, via the theme when it offers it (older Pi themes don't). */
function inverse(theme: Theme, text: string): string {
   const t = theme as unknown as { inverse?: (text: string) => string };
   return typeof t.inverse === "function" ? t.inverse(text) : `\x1b[7m${text}\x1b[27m`;
}

export interface ActionButton {
   id: string;
   label: string;
   key: string;
   primary?: boolean;
}

/**
 * One row of buttons, e.g. "[ Select ⏎ ] [ Cancel esc ]". The primary button
 * is drawn inverse in accent; the others on Pi's pending-tool background.
 * Returns the row and each button's column range for mouse hits.
 */
export function renderActionBar(theme: Theme, buttons: readonly ActionButton[], width: number): { line: string; hits: HitRect[] } {
   const secondary = themeBgOpen(theme, PANEL_BG);
   let line = " ";
   let col = 1;
   const hits: HitRect[] = [];
   for (const button of buttons) {
      const text = ` ${button.label} ${button.key} `;
      const cells = visibleWidth(text);
      if (col + cells > width) break;
      const styled = button.primary
         ? theme.fg("accent", inverse(theme, theme.bold(text)))
         : secondary
            ? paintRow(theme.fg("text", text), cells, secondary)
            : theme.fg("text", `[${text.trim()}]`.padEnd(cells));
      line += `${styled} `;
      hits.push({ row: 0, rows: 1, col, cols: cells, target: { kind: "button", id: button.id } });
      col += cells + 1;
   }
   return { line, hits };
}

// ── List windowing ───────────────────────────────────────────────────────────

/** Rows of one list item (an option with its wrapped title or description lines). */
export interface RowBlock {
   /** Item index, or a negative number for rows that aren't items (filter line, inline description). */
   item: number;
   lines: string[];
}

export interface WindowedRows {
   lines: string[];
   /** Item index per line (negative for non-items). */
   items: number[];
}

/**
 * Fit blocks into `maxRows`, keeping the rows from `pinStart` to `pinEnd`
 * (absolute row indexes, end exclusive) in view. When `indicator` is given and
 * rows had to be cut, the last row shows it, as upstream's "(2/5)".
 */
export function windowRows(blocks: readonly RowBlock[], maxRows: number, pinStart: number, pinEnd: number, indicator?: string): WindowedRows {
   const lines: string[] = [];
   const items: number[] = [];
   for (const block of blocks) {
      for (const line of block.lines) {
         lines.push(line);
         items.push(block.item);
      }
   }
   const limit = Math.max(1, Math.floor(maxRows));
   if (lines.length <= limit) return { lines, items };
   const room = indicator ? Math.max(1, limit - 1) : limit;
   let start = Math.max(0, Math.min(pinStart, lines.length - room));
   if (pinEnd > start + room) start = Math.max(0, Math.min(pinStart, pinEnd - room));
   const out = { lines: lines.slice(start, start + room), items: items.slice(start, start + room) };
   if (indicator && limit > 1) {
      out.lines.push(indicator);
      out.items.push(-1);
   }
   return out;
}

/** The first and end-exclusive row of `item` among `blocks`. */
export function blockSpan(blocks: readonly RowBlock[], item: number): { start: number; end: number } {
   let row = 0;
   for (const block of blocks) {
      if (block.item === item) return { start: row, end: row + block.lines.length };
      row += block.lines.length;
   }
   return { start: 0, end: 0 };
}
