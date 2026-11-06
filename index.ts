/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type {
   AgentToolResult,
   AgentToolUpdateCallback,
   ExtensionAPI,
   ExtensionContext,
   ExtensionUIContext,
   Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
   Container,
   type Component,
   CURSOR_MARKER,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   fuzzyFilter,
   isKeyRelease,
   isKeyRepeat,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   type OverlayHandle,
   type OverlayOptions,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   visibleWidth,
   wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows, type QuestionOption } from "./single-select-layout";
import {
   askToolCard,
   CHOICE_LIST_KEY,
   type ChoiceList,
   type ChoiceRow,
   choiceSheet,
   NATIVE_COMPONENT,
   type QuestionTabs,
   registerTernTool,
   reviewSheet,
   shortLabel,
   type TernContext,
   type TernEvent,
   type TernNode,
   nodeKey,
   textSheet,
} from "./tern";
import { loadAskUserSettings } from "./settings";
import {
   HIGHLIGHT_BG,
   PANEL_BG,
   PreviewScroll,
   blockSpan,
   chooseOptionLayout,
   type OptionLayout,
   hitAt,
   offsetForThumbRow,
   offsetRects,
   paintRow,
   previewNeedRows,
   renderActionBar,
   renderPreviewPane,
   themeBgOpen,
   windowRows,
   type ActionButton,
   type AskMouseEvent,
   type AskMouseResult,
   type HitRect,
   type HitTarget,
   type PreviewRender,
   type PreviewSubject,
   type RowBlock,
   type WindowedRows,
} from "./enhanced-ui";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 *
 * Some hosts (oh-my-pi) alias `@sinclair/typebox` to a shim whose `Type.Unsafe`
 * returns a plain object that `Type.Optional` cannot wrap (issue #38). On those
 * hosts a union of literals is a real runtime schema *and* already collapses to
 * the flat enum form, so we probe the builder and pick whichever path it
 * supports. `builder` is injectable for tests only.
 */
export type StringEnumBuilder = Pick<typeof Type, "Unsafe" | "Optional" | "Union" | "Literal">;

export function StringEnum<const T extends readonly string[]>(
   values: T,
   options?: { description?: string; default?: T[number] },
   builder: StringEnumBuilder = Type,
): TUnsafe<T[number]> {
   const meta = {
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
   };
   try {
      builder.Optional(builder.Unsafe<string>({ type: "string" }));
      return builder.Unsafe<T[number]>({ type: "string", enum: [...values], ...meta });
   } catch {
      // fall through to the union path below
   }
   // Shim path: the union is a runtime schema, so `Type.Optional` works and the
   // enclosing `Type.Object` keeps every optional key optional. Chainable
   // `.describe()`/`.default()` are the shim's way to attach metadata; the
   // options argument covers builders that take it positionally instead.
   // SAFETY: shim unions may expose these chainable methods; each is checked before calling.
   let schema = builder.Union(values.map((value) => builder.Literal(value)), meta) as unknown as {
      describe?: (text: string) => unknown;
      default?: (value: unknown) => unknown;
   };
   if (options?.description && typeof schema.describe === "function") {
      schema = schema.describe(options.description) as typeof schema;
   }
   if (options?.default !== undefined && typeof schema.default === "function") {
      schema = schema.default(options.default) as typeof schema;
   }
   // SAFETY: the union contains exactly the supplied string literals, matching T[number].
   return schema as unknown as TUnsafe<T[number]>;
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

type AskOptionInput = QuestionOption | string;
type IdentifiedOption = QuestionOption & { id?: number };


type AskDisplayMode = "overlay" | "inline" | "adaptive" | "fullscreen";
// PI_ASK_USER_FULLSCREEN_V4: explicit modes, no prompt-only fallbacks.
type AskSingleSelectLayout = "auto" | "list";

interface BatchQuestionInput {
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   preselectedIds?: number[];
}

interface AskParams {
   question?: string;
   questions?: BatchQuestionInput[];
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
   preselectedIds?: number[];
   displayMode?: AskDisplayMode;
   singleSelectLayout?: AskSingleSelectLayout;
   contextExpanded?: boolean;
   overlayToggleKey?: string | null;
   commentToggleKey?: string | null;
   fullscreenToggleKey?: string | null;
   timeout?: number;
}

type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      selectedIds?: number[];
      comment?: string;
   }
   | {
      kind: "combined";
      selections: string[];
      selectedIds?: number[];
      text: string;
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

interface AskToolDetails {
   question: string;
   context?: string;
   options: QuestionOption[];
   response: AskResponse | null;
   cancelled: boolean;
}

/** One validated entry of a `questions` batch. */
interface BatchQuestion {
   question: string;
   context?: string;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   preselectedIds: number[];
}

type BatchAnswer = { status: "answered"; response: AskResponse } | { status: "skipped" };

/** Result details of a `questions` batch. Single-question results keep AskToolDetails. */
interface AskBatchDetails {
   kind: "batch";
   /** The top-level question sent alongside questions, shown as the batch heading. */
   heading?: string;
   questions: Array<{ question: string; context?: string; options: QuestionOption[] }>;
   /** Index-aligned with `questions`; empty when the batch was cancelled. */
   answers: BatchAnswer[];
   cancelled: boolean;
}

function isBatchDetails<T extends AskToolDetails | AskBatchDetails>(details: T): details is Extract<T, AskBatchDetails> {
   return (details as AskBatchDetails).kind === "batch";
}

const BATCH_MIN_QUESTIONS = 2;
const BATCH_MAX_QUESTIONS = 4;

type AskUIResult = AskResponse;

// Key aliases models fall back to when a schema-mangling proxy (Google
// function calling, Codex-style backends, cmux) strips the option shape and
// the model has to guess. See issue #22.
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

function coerceOption(option: unknown): QuestionOption | null {
   if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
      const title = String(option).trim();
      return title ? { title } : null;
   }
   if (option && typeof option === "object") {
      const record = option as Record<string, unknown>;
      for (const key of OPTION_TITLE_KEYS) {
         const value = record[key];
         if (typeof value === "string" && value.trim()) {
            const description =
               typeof record.description === "string" && record.description.trim() ? record.description : undefined;
            const result: IdentifiedOption = description ? { title: value.trim(), description } : { title: value.trim() };
            if (record.id !== undefined) result.id = record.id as number;
            return result;
         }
      }
   }
   return null;
}


/**
 * Normalize options and validate numeric option IDs before any UI opens.
 * Questions without IDs keep upstream behavior. Once any option carries an
 * `id`, every option must have a unique positive integer ID, and
 * `preselectedIds` must name existing IDs. An empty `preselectedIds` array is
 * treated as absent: models often send `[]` for "nothing preselected".
 */
function normalizeIdentifiedOptions(
   rawOptions: unknown[], preselectedIds: unknown, allowMultiple: boolean, label: string,
): { options: QuestionOption[]; preselectedIds: number[] } {
   const requested = Array.isArray(preselectedIds) && preselectedIds.length === 0 ? undefined : preselectedIds;
   const usesIds = requested !== undefined || rawOptions.some((o) => o !== null && typeof o === "object" && "id" in o);
   const options = rawOptions.map(coerceOption).filter((o): o is QuestionOption => o !== null);
   if (!usesIds) return { options, preselectedIds: [] };
   const fix = "Give every option a unique positive integer id, or leave out id and preselectedIds entirely.";
   if (options.length !== rawOptions.length) {
      throw new Error(`${label}.options has malformed entries, and numbered options need every entry to be a valid option object. ${fix}`);
   }
   const ids = new Set<number>();
   for (const [index, option] of options.entries()) {
      const id = (option as IdentifiedOption).id;
      if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error(`${label}.options[${index}].id must be a positive integer. ${fix}`);
      if (ids.has(id as number)) throw new Error(`${label}.options contains duplicate id ${id}. ${fix}`);
      ids.add(id as number);
   }
   if (requested === undefined) return { options, preselectedIds: [] };
   if (!Array.isArray(requested)) throw new Error(`${label}.preselectedIds must be an array of option ids, such as [2] or [1, 3].`);
   if (!allowMultiple && requested.length > 1) {
      throw new Error(`${label}.preselectedIds can name at most one id when allowMultiple is false.`);
   }
   const seen = new Set<number>();
   for (const id of requested) {
      if (!Number.isSafeInteger(id) || !ids.has(id)) {
         throw new Error(`${label}.preselectedIds includes ${JSON.stringify(id)}, which is not one of the option ids (${[...ids].join(", ")}).`);
      }
      if (seen.has(id)) throw new Error(`${label}.preselectedIds lists id ${id} twice.`);
      seen.add(id);
   }
   return { options, preselectedIds: [...seen] };
}

function selectedIdsForIndices(options: QuestionOption[], indices: number[]): number[] | undefined {
   const ids = indices.map((index) => (options[index] as IdentifiedOption | undefined)?.id);
   return ids.every((id) => id !== undefined) ? ids as number[] : undefined;
}

function createCombinedResponse(selections: string[], text: string, selectedIds?: number[], comment?: string): AskResponse | null {
   const cleanText = text.trim();
   const cleanSelections = selections.map((value) => value.trim()).filter(Boolean);
   if (!cleanText) return createSelectionResponse(cleanSelections, comment, selectedIds);
   if (!cleanSelections.length) return createFreeformResponse(cleanText);
   return { kind: "combined", selections: cleanSelections, ...(selectedIds ? { selectedIds } : {}), text: cleanText,
      ...(normalizeOptionalComment(comment) ? { comment: normalizeOptionalComment(comment) } : {}) };
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
   if (value === undefined) return undefined;
   switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
         return true;
      case "0":
      case "false":
      case "no":
      case "off":
         return false;
      default:
         return undefined;
   }
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null, selectedIds?: number[]): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, ...(selectedIds ? { selectedIds } : {}), comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections, ...(selectedIds ? { selectedIds } : {}) };
}

function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;
   const namedSelections = response.selections.map((title, index) =>
      response.selectedIds?.[index] !== undefined ? `${response.selectedIds[index]}: ${title}` : title).join(", ");
   if (response.kind === "combined") return `${namedSelections} + ${response.text}${response.comment ? ` — ${response.comment}` : ""}`;

   const selections = namedSelections;
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" | "combined" }> {
   return response.kind === "selection" || response.kind === "combined";
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
   commentToggle: ResolvedShortcut;
   /** Switches a mounted overlay between its configured size and fullscreen (not in inline mode). */
   fullscreenToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
   return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
   // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
   // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
   if (!spec) return false;
   if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
   if (spec.startsWith("+") || spec.endsWith("+")) return false;
   if (spec.includes("++")) return false;
   return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

function resolveShortcut(
   paramValue: string | null | undefined,
   envValue: string | undefined,
   fileValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [paramValue, envValue, fileValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_MIN_RENDER_LINES = 8;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const FREEFORM_DIALOG_LABEL = "\u270f\ufe0f Type something (add your own text)";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";
const DEFAULT_FULLSCREEN_TOGGLE_KEY = "alt+m";
const CONTEXT_TOGGLE_KEYS = [Key.ctrl("e"), Key.ctrl("x"), Key.ctrl("y")];
const INLINE_CONTEXT_MAX_ROWS = 3;

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
const PROMPT_SCROLL_HOME_KEY = Key.home;
const PROMPT_SCROLL_END_KEY = Key.end;
const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

function getOverlayMaxRenderLinesForRows(rows: number): number {
   const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
   const availableRows = Math.max(1, normalizedRows - 2);
   const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
   const minimumRows = Math.min(ASK_OVERLAY_MIN_RENDER_LINES, availableRows);
   return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}

function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
): { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } | undefined {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
      case "adaptive":
      case "fullscreen":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: displayMode === "fullscreen" ? "100%" : ASK_OVERLAY_WIDTH,
               minWidth: displayMode === "fullscreen" ? 1 : ASK_OVERLAY_MIN_WIDTH,
               maxHeight: displayMode === "fullscreen" ? "100%" : displayMode === "adaptive" ? "65%" : "85%",
               margin: displayMode === "fullscreen" ? 0 : 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}

/** Placeholder detail for options sent without a description. */
const NO_DESCRIPTION = "No description provided for this option.";

/** The bordered preview panel and selection bar colors, resolved once per theme. */
function listColors(theme: Theme): { highlight: string; panel: string } {
   return { highlight: themeBgOpen(theme, HIGHLIGHT_BG), panel: themeBgOpen(theme, PANEL_BG) };
}

/** The 3-cell gap between the list and the preview: a divider, or the panel's left padding when tinted. */
function splitSeparator(theme: Theme, panel: string): string {
   return panel ? ` ${paintRow("  ", 2, panel)}` : theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
}

/** The dashed line between the list and the detail strip. */
function stripSeparator(theme: Theme, width: number): string {
   return theme.fg("dim", ` ${"╌".repeat(Math.max(0, width - 2))}`);
}

/** Mouse handling shared by both lists: wheel, scrollbar dragging, row and checkbox clicks. */
interface ListMouseHost {
   preview: PreviewScroll;
   hits: HitRect[];
   drag?: { grab: number; railTop: number; railRows: number; thumbRows: number; maxOffset: number };
   invalidate(): void;
   moveSelection(delta: number): void;
   clickTarget(target: HitTarget, clickCount: number): void;
}

function handleListMouse(host: ListMouseHost, event: AskMouseEvent): AskMouseResult | undefined {
   if (host.drag) {
      if (event.type === "drag") {
         const { grab, railTop, railRows, thumbRows, maxOffset } = host.drag;
         if (host.preview.scrollTo(offsetForThumbRow(event.y - railTop - grab, railRows, thumbRows, maxOffset))) host.invalidate();
         return { handled: true, render: true };
      }
      if (event.type === "release") {
         host.drag = undefined;
         return { handled: true };
      }
   }
   const rect = hitAt(host.hits, event.x, event.y);
   if (event.type === "wheel") {
      const step = Math.sign(event.wheelDelta ?? 0);
      if (!step) return undefined;
      const area = rect ? host.hits.find((hit) => hit.target.kind === "preview" && event.y >= hit.row && event.y < hit.row + hit.rows && event.x >= hit.col && event.x < hit.col + hit.cols) : undefined;
      if (area && host.preview.overflow) {
         if (host.preview.scrollBy(step * 3)) host.invalidate();
         return { handled: true };
      }
      const inList = host.hits.some((hit) => hit.target.kind === "list" && event.y >= hit.row && event.y < hit.row + hit.rows && event.x >= hit.col && event.x < hit.col + hit.cols);
      if (inList) {
         host.moveSelection(step);
         return { handled: true };
      }
      return undefined;
   }
   if (!rect) return undefined;
   const target = rect.target;
   if (target.kind === "rail") {
      if (event.type === "press") {
         const row = event.y - rect.row;
         if (row >= target.thumbStart && row < target.thumbEnd) {
            host.drag = { grab: row - target.thumbStart, railTop: rect.row, railRows: rect.rows, thumbRows: target.thumbEnd - target.thumbStart, maxOffset: target.maxOffset };
            return { handled: true, capture: true };
         }
         const page = Math.max(1, host.preview.viewport - 1);
         if (host.preview.scrollBy(row < target.thumbStart ? -page : page)) host.invalidate();
         return { handled: true };
      }
      return { handled: true };
   }
   if (event.type === "click" && (target.kind === "row" || target.kind === "check" || target.kind === "clear")) {
      host.clickTarget(target, event.clickCount ?? 1);
      return { handled: true };
   }
   if (event.type === "press" && (target.kind === "row" || target.kind === "check" || target.kind === "clear")) {
      // Claim the press so the click that follows comes back to this list.
      return { handled: true };
   }
   return undefined;
}

class MultiSelectList implements Component, ListMouseHost {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private layoutPreference: AskSingleSelectLayout;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private checked = new Set<number>();
   private commentEnabled = false;
   /** Saved custom text (Fix 1): shown on its row and sent with the ticked options. */
   private customText = "";
   private maxVisibleRows = 10;
   private cachedWidth?: number;
   private cachedLines?: string[];
   private needCache = new Map<string, number>();
   readonly preview = new PreviewScroll();
   hits: HitRect[] = [];
   drag?: ListMouseHost["drag"];

   public onCancel?: () => void;
   public onSubmit?: (result: string[]) => void;
   public onEnterFreeform?: () => void;
   /** Backspace or Delete on the custom-text row while it holds text. */
   public onClearCustom?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      layoutPreference: AskSingleSelectLayout,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.layoutPreference = layoutPreference;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   /** Ticked option indexes in list order; with `explicitOnly` false and nothing ticked, the highlighted option. */
   public selectedOptionIndices(explicitOnly = false): number[] {
      const indices = [...this.checked].sort((a, b) => a - b);
      if (explicitOnly || indices.length) return indices;
      return this.selectedIndex < this.options.length ? [this.selectedIndex] : [];
   }

   public preselect(ids: number[]): void {
      this.checked.clear();
      for (const id of ids) {
         const index = this.options.findIndex((option) => (option as IdentifiedOption).id === id);
         if (index >= 0) this.checked.add(index);
      }
      if (this.checked.size) this.selectedIndex = Math.min(...this.checked);
      this.invalidate();
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   public setCustomText(text: string): void {
      this.customText = text;
      this.needCache.clear();
      this.invalidate();
   }

   /** Highlight the custom-text row (after saving or discarding an edit). */
   public focusCustomRow(): void {
      if (!this.allowFreeform) return;
      this.selectedIndex = this.getFreeformIndex();
      this.invalidate();
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getItemCount(): number {
      return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private getCommentToggleIndex(): number | null {
      return this.allowComment ? this.options.length : null;
   }

   private getFreeformIndex(): number {
      return this.options.length + (this.allowComment ? 1 : 0);
   }

   private isCommentToggleRow(index: number): boolean {
      const toggleIndex = this.getCommentToggleIndex();
      return toggleIndex !== null && index === toggleIndex;
   }

   private isFreeformRow(index: number): boolean {
      return this.allowFreeform && index === this.getFreeformIndex();
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.needCache.clear();
      this.invalidate();
   }

   moveSelection(delta: number): void {
      const count = this.getItemCount();
      if (count === 0) return;
      this.selectedIndex = (this.selectedIndex + delta % count + count) % count;
      this.invalidate();
   }

   /** Preview scrolling keys (only while the description overflows). */
   public handlePreviewKeys(data: string): boolean {
      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) return false;
      if (!this.preview.handleKeys(data)) return false;
      this.invalidate();
      return true;
   }

   handleInput(data: string): void {
      if (this.handlePreviewKeys(data)) return;
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const count = this.getItemCount();
      if (count === 0) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      if (matchesSelectUp(data, this.keybindings)) {
         this.moveSelection(-1);
         return;
      }

      if (matchesSelectDown(data, this.keybindings)) {
         this.moveSelection(1);
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < this.options.length) {
            this.toggle(idx);
            this.selectedIndex = Math.min(idx, count - 1);
            this.invalidate();
         }
         return;
      }

      if (
         this.isFreeformRow(this.selectedIndex)
         && this.customText
         && (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || this.keybindings.matches(data, "tui.editor.deleteCharBackward"))
      ) {
         this.onClearCustom?.();
         return;
      }

      if (matchesKey(data, Key.space)) {
         this.activate();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.isCommentToggleRow(this.selectedIndex) || this.isFreeformRow(this.selectedIndex)) {
            this.activate();
            return;
         }
         this.submit();
      }
   }

   /** Space on the selected row: tick the option, toggle the comment, or open the custom-text editor. */
   private activate(): void {
      if (this.isCommentToggleRow(this.selectedIndex)) {
         this.toggleComment();
         return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
         this.onEnterFreeform?.();
         return;
      }
      this.toggle(this.selectedIndex);
      this.invalidate();
   }

   /**
    * Submit the ticked options, or the highlighted one when none is ticked.
    * Saved custom text goes along (the prompt adds it), so text alone also
    * submits. With nothing at all to send, nothing happens.
    */
   submit(): void {
      const selectedTitles = Array.from(this.checked)
         .sort((a, b) => a - b)
         .map((i) => this.options[i]?.title)
         .filter((t): t is string => !!t);

      const fallback = this.options[this.selectedIndex]?.title;
      const result = selectedTitles.length > 0 ? selectedTitles : fallback && !this.customText ? [fallback] : [];

      if (result.length > 0 || this.customText) this.onSubmit?.(result);
   }

   /** The rows as shown (options with their ticks, comment toggle, custom text), for Tern's native sheet. */
   nativeSheet(): ChoiceList {
      const rows: ChoiceRow[] = this.options.map((option, index) => ({
         id: `o${index}`,
         kind: "option",
         label: option.title,
         detail: option.description,
         on: this.checked.has(index),
      }));
      if (this.allowComment) rows.push({ id: "comment", kind: "comment", label: COMMENT_TOGGLE_LABEL, on: this.commentEnabled });
      if (this.allowFreeform) {
         rows.push(this.customText
            ? { id: "freeform", kind: "freeform", label: `✎ “${this.customText}”`, detail: "Your text: sent with the ticked options", on: true }
            : { id: "freeform", kind: "freeform", label: "Other" });
      }
      return { rows, selected: this.selectedIndex };
   }

   /** Select row `row` of nativeSheet(); `activate` then acts as Space on it. */
   selectRow(row: number, activate: boolean): void {
      if (row < 0 || row >= this.getItemCount()) return;
      this.selectedIndex = row;
      this.invalidate();
      if (activate) this.activate();
   }

   clickTarget(target: HitTarget, clickCount: number): void {
      if (target.kind === "clear") {
         this.selectedIndex = this.getFreeformIndex();
         this.onClearCustom?.();
         return;
      }
      if (target.kind === "check") {
         this.selectedIndex = target.index;
         this.activate();
         this.invalidate();
         return;
      }
      if (target.kind !== "row") return;
      const changed = this.selectedIndex !== target.index;
      this.selectedIndex = target.index;
      this.invalidate();
      // Double-click acts like Space: tick the option, toggle the comment, edit the text.
      if (!changed && clickCount >= 2) this.activate();
   }

   handleMouse(event: AskMouseEvent): AskMouseResult | undefined {
      return handleListMouse(this, event);
   }

   private getSplitWidths(width: number): { left: number; right: number } | null {
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;
      const available = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (available < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(Math.floor(available * 0.45), available - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = available - left;
      return right >= SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH ? { left, right } : null;
   }

   /** The layout at `width`; narrow widths keep the plain list when no option has a description to show. */
   private layoutFor(width: number): OptionLayout {
      const layout = chooseOptionLayout(width, this.layoutPreference, this.getSplitWidths(width) !== null);
      if ((layout === "strip" || layout === "accordion") && !this.options.some((o) => o.description?.trim())) return "list";
      return layout;
   }

   private subjectFor(index: number): PreviewSubject {
      if (this.isCommentToggleRow(index)) {
         return {
            title: "Extra context",
            detail: this.commentEnabled
               ? "On. After you submit, you can add a comment explaining your choices."
               : "Off. Press Space to add a comment after you submit.",
         };
      }
      if (this.isFreeformRow(index)) {
         return this.customText
            ? {
               title: "Your text",
               badge: this.theme.fg("success", "✓ will be sent"),
               detail: `“${this.customText}”\n\nSent together with the ticked options.\n\nEnter or Space: edit · Backspace: remove`,
            }
            : {
               title: "Custom response",
               detail: "Add your own text alongside the checked options. It is sent together with them.\n\nEnter or Space opens the editor.",
            };
      }
      const option = this.options[index];
      const description = option?.description?.trim();
      return { title: option?.title ?? "No option selected", detail: description || NO_DESCRIPTION, muted: !description };
   }

   /** Every list row, item by item. `hideDescriptions` keeps only titles. */
   private titleBlocks(width: number, hideDescriptions: boolean): RowBlock[] {
      const theme = this.theme;
      const { highlight } = listColors(theme);
      const blocks: RowBlock[] = [];
      for (let i = 0; i < this.getItemCount(); i++) {
         const isSelected = i === this.selectedIndex;
         const prefix = isSelected ? theme.fg("accent", "→") : " ";
         const lines: string[] = [];
         if (this.isCommentToggleRow(i)) {
            const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
            const label = isSelected
               ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
               : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
            lines.push(`${prefix}   ${checkbox} ${label}`);
         } else if (this.isFreeformRow(i)) {
            if (this.customText) {
               const clear = isSelected ? theme.fg("dim", "  ⌫ clear") : "";
               const room = Math.max(4, width - 10 - visibleWidth(clear));
               const quoted = truncateToWidth(`“${this.customText}”`, room, "…”");
               const text = isSelected ? theme.fg("accent", theme.bold(quoted)) : theme.fg("text", quoted);
               lines.push(`${prefix}   ${theme.fg("success", "[✓]")} ${theme.fg("accent", "✎")} ${text}${clear}`);
            } else {
               const label = theme.fg("text", theme.bold("Type something."));
               lines.push(`${prefix}   ${theme.fg("dim", "[ ]")} ${theme.fg("accent", "✎")} ${label} ${theme.fg("muted", "your own text")}`);
            }
         } else {
            const option = this.options[i]!;
            const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
            const num = theme.fg("dim", `${i + 1}.`);
            const title = isSelected ? theme.fg("accent", theme.bold(option.title)) : theme.fg("text", theme.bold(option.title));
            lines.push(`${prefix} ${num} ${checkbox} ${title}`);
            if (option.description && !hideDescriptions) {
               const indent = "      ";
               for (const wrapped of wrapTextWithAnsi(option.description, Math.max(10, width - indent.length))) {
                  lines.push(indent + theme.fg("muted", wrapped));
               }
            }
         }
         blocks.push({
            item: i,
            lines: lines.map((line) => (isSelected && highlight ? paintRow(line, width, highlight) : truncateToWidth(line, width, ""))),
         });
      }
      return blocks;
   }

   /** Mouse targets for list rows, given where each line went. */
   private rowHits(items: number[], top: number, width: number): void {
      items.forEach((item, row) => {
         if (item < 0) return;
         const first = row === 0 || items[row - 1] !== item;
         if (first && item < this.options.length) {
            const col = 3 + `${item + 1}.`.length;
            this.hits.push({ row: top + row, rows: 1, col, cols: 3, target: { kind: "check", index: item } });
         } else if (first && this.isCommentToggleRow(item)) {
            this.hits.push({ row: top + row, rows: 1, col: 4, cols: 3, target: { kind: "check", index: item } });
         } else if (first && this.isFreeformRow(item) && this.customText && item === this.selectedIndex) {
            this.hits.push({ row: top + row, rows: 1, col: Math.max(0, width - 9), cols: 9, target: { kind: "clear" } });
         }
         this.hits.push({ row: top + row, rows: 1, col: 0, cols: width, target: { kind: "row", index: item } });
      });
   }

   private previewHits(preview: PreviewRender, top: number, left: number, rows: number, cols: number): void {
      if (preview.thumb) {
         this.hits.push({
            row: top, rows, col: left + preview.railCol, cols: 1,
            target: { kind: "rail", thumbStart: preview.thumb.start, thumbEnd: preview.thumb.end, maxOffset: preview.maxOffset },
         });
      }
      this.hits.push({ row: top, rows, col: left, cols, target: { kind: "preview" } });
   }

   /** Rows the option area needs to show everything without scrolling (Fix 8 "2C"), at `width`. */
   preferredRows(width: number): number {
      const key = `${width}`;
      const cached = this.needCache.get(key);
      if (cached !== undefined) return cached;
      const mdTheme = safeMarkdownTheme();
      const panes = this.getSplitWidths(width);
      const layout = this.layoutFor(width);
      const subjects = Array.from({ length: this.getItemCount() }, (_, i) => this.subjectFor(i));
      const docRows = (w: number, titleRow = true) => Math.max(...subjects.map((s) => previewNeedRows(this.theme, s, w, { mdTheme, titleRow })));
      let need: number;
      if (layout === "split") {
         need = Math.max(this.titleBlocks(panes!.left, true).reduce((n, b) => n + b.lines.length, 0), docRows(panes!.right));
      } else if (layout === "strip") {
         need = this.titleBlocks(width, true).reduce((n, b) => n + b.lines.length, 0) + 1 + docRows(width);
      } else if (layout === "accordion") {
         need = this.titleBlocks(width, true).reduce((n, b) => n + b.lines.length, 0) + docRows(width - 6, false);
      } else {
         need = this.titleBlocks(width, false).reduce((n, b) => n + b.lines.length, 0);
      }
      need = Math.max(1, need);
      this.needCache.set(key, need);
      return need;
   }

   /** Fewest rows worth showing: the strip and accordion need room for a few options and some text. */
   minimumRows(width: number): number {
      const layout = this.layoutFor(width);
      const floor = layout === "strip" ? 7 : layout === "accordion" ? 6 : 3;
      return Math.min(floor, this.preferredRows(width));
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
      const theme = this.theme;
      const count = this.getItemCount();
      this.hits = [];
      if (count === 0) return [theme.fg("warning", "No options")];

      const mdTheme = safeMarkdownTheme();
      const { panel } = listColors(theme);
      const panes = this.getSplitWidths(width);
      const layout = this.layoutFor(width);
      // Stable height: what the tallest option needs, within the space the prompt gives (Fix 8).
      const rows = Math.max(1, Math.min(this.maxVisibleRows, this.preferredRows(width)));
      const subject = this.subjectFor(this.selectedIndex);
      const indicator = theme.fg("dim", `  (${this.selectedIndex + 1}/${count})`);
      this.preview.follow(`${this.selectedIndex}|${this.customText}`);
      this.preview.active = layout !== "list";
      let lines: string[];

      if (layout === "split") {
         const blocks = this.titleBlocks(panes!.left, true);
         const span = blockSpan(blocks, this.selectedIndex);
         const left = windowRows(blocks, rows, span.start, span.end, indicator);
         const preview = renderPreviewPane(theme, subject, panes!.right, rows, this.preview.offset, { mdTheme, tint: panel });
         this.preview.record(preview);
         const separator = splitSeparator(theme, panel);
         lines = Array.from({ length: rows }, (_, row) =>
            `${truncateToWidth(left.lines[row] ?? "", panes!.left, "", true)}${separator}${preview.lines[row] ?? ""}`);
         this.rowHits(left.items, 0, panes!.left);
         this.hits.push({ row: 0, rows, col: 0, cols: panes!.left, target: { kind: "list" } });
         this.previewHits(preview, 0, panes!.left + SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length, rows, panes!.right);
      } else if (layout === "strip") {
         const blocks = this.titleBlocks(width, true);
         const total = blocks.reduce((n, b) => n + b.lines.length, 0);
         const listRows = Math.max(Math.min(2, rows), Math.min(total, rows - 4));
         const separatorRows = rows - listRows >= 3 ? 1 : 0;
         const stripRows = Math.max(1, rows - listRows - separatorRows);
         const span = blockSpan(blocks, this.selectedIndex);
         const left = windowRows(blocks, listRows, span.start, span.end, indicator);
         const preview = renderPreviewPane(theme, subject, width, stripRows, this.preview.offset, { mdTheme, tint: panel });
         this.preview.record(preview);
         lines = [...left.lines, ...(separatorRows ? [stripSeparator(theme, width)] : []), ...preview.lines];
         this.rowHits(left.items, 0, width);
         this.hits.push({ row: 0, rows: left.lines.length, col: 0, cols: width, target: { kind: "list" } });
         this.previewHits(preview, left.lines.length + separatorRows, 0, stripRows, width);
      } else if (layout === "accordion") {
         const blocks = this.titleBlocks(width, true);
         const titleRows = blocks.reduce((n, b) => n + b.lines.length, 0);
         const docWidth = width - 6;
         // Options without a description don't expand: there is nothing to show.
         const wanted = subject.muted ? 0 : previewNeedRows(theme, subject, docWidth, { mdTheme, titleRow: false });
         const descRows = wanted ? Math.max(Math.min(2, wanted), Math.min(wanted, rows - titleRows)) : 0;
         const preview = renderPreviewPane(theme, subject, docWidth, Math.max(1, descRows), this.preview.offset, { mdTheme, tint: panel, titleRow: false });
         this.preview.record(descRows ? preview : { offset: 0, total: 0, viewport: 0 });
         const at = blocks.findIndex((block) => block.item === this.selectedIndex);
         const expanded: RowBlock[] = [...blocks];
         if (at >= 0 && descRows > 0) expanded.splice(at + 1, 0, { item: -2, lines: preview.lines.map((line) => `      ${line}`) });
         const span = blockSpan(blocks, this.selectedIndex);
         const window = windowRows(expanded, rows, span.start, span.end + descRows, indicator);
         lines = window.lines;
         this.rowHits(window.items, 0, width);
         const descTop = window.items.indexOf(-2);
         if (descTop >= 0) this.previewHits(preview, descTop, 6, Math.min(descRows, lines.length - descTop), docWidth);
         this.hits.push({ row: 0, rows: lines.length, col: 0, cols: width, target: { kind: "list" } });
      } else {
         const blocks = this.titleBlocks(width, false);
         const span = blockSpan(blocks, this.selectedIndex);
         const window = windowRows(blocks, this.maxVisibleRows, span.start, span.end, indicator);
         lines = window.lines;
         this.rowHits(window.items, 0, width);
         this.hits.push({ row: 0, rows: lines.length, col: 0, cols: width, target: { kind: "list" } });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

class WrappedSingleSelectList implements Component, ListMouseHost {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private singleSelectLayout: AskSingleSelectLayout;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private searchQuery = "";
   private commentEnabled = false;
   private maxVisibleRows = 12;
   private cachedWidth?: number;
   private cachedLines?: string[];
   private needCache = new Map<string, number>();
   readonly preview = new PreviewScroll();
   hits: HitRect[] = [];
   drag?: ListMouseHost["drag"];

   public onCancel?: () => void;
   public onSubmit?: (result: string) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      singleSelectLayout: AskSingleSelectLayout,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.singleSelectLayout = singleSelectLayout;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   /** The highlighted option's index among all options, or undefined on the comment or custom row. */
   public selectedOptionIndex(): number | undefined {
      const filtered = this.getFilteredOptions();
      const option = filtered[this.selectedIndex];
      return option ? this.options.indexOf(option) : undefined;
   }

   /** Start with the cursor on the preselected option (single-select allows one). */
   public preselect(ids: number[]): void {
      if (ids.length) {
         const optionIndex = this.options.findIndex((option) => (option as IdentifiedOption).id === ids[0]);
         if (optionIndex >= 0) this.selectedIndex = optionIndex;
      }
      this.invalidate();
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
   }

   private getItemCount(filteredOptions: QuestionOption[]): number {
      return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private isCommentToggleRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowComment && index === filteredOptions.length;
   }

   private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.needCache.clear();
      this.invalidate();
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      const kittyPrintable = decodeKittyPrintable(data);
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
   }

   private styleListLine(line: string, width: number, isSelected: boolean, highlight: string): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         const styled = this.theme.fg("accent", this.theme.bold(line));
         return highlight ? paintRow(styled, width, highlight) : truncateToWidth(styled, width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   /** The filter line, then each item's rows (descriptions included unless hidden). */
   private titleBlocks(width: number, filteredOptions: QuestionOption[], hideDescriptions: boolean): RowBlock[] {
      const { highlight } = listColors(this.theme);
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      const blocks: RowBlock[] = [{ item: -1, lines: [truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, "")] }];
      if (this.searchQuery && filteredOptions.length === 0) {
         blocks.push({ item: -1, lines: [truncateToWidth(this.theme.fg("warning", "No matching options"), width, "")] });
      }
      if (this.getItemCount(filteredOptions) === 0) {
         if (!this.searchQuery) blocks.push({ item: -1, lines: [truncateToWidth(this.theme.fg("warning", "No options"), width, "")] });
         return blocks;
      }
      const rows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         hideDescriptions,
      });
      for (const row of rows) {
         const line = this.styleListLine(row.line, width, row.selected, highlight);
         const last = blocks[blocks.length - 1]!;
         if (last.item === row.itemIndex && row.itemIndex >= 0) last.lines.push(line);
         else blocks.push({ item: row.itemIndex, lines: [line] });
      }
      return blocks;
   }

   /** The upstream list (with its own windowing and "(n/m)" indicator), as blocks. */
   private windowedListBlocks(width: number, filteredOptions: QuestionOption[], maxRows: number, hideDescriptions: boolean): WindowedRows {
      const { highlight } = listColors(this.theme);
      const head = this.titleBlocks(width, filteredOptions, true).filter((block) => block.item === -1);
      const lines = head.flatMap((block) => block.lines);
      const items = lines.map(() => -1);
      if (this.getItemCount(filteredOptions) === 0) return { lines: lines.slice(0, maxRows), items: items.slice(0, maxRows) };
      const rows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         maxRows: Math.max(1, maxRows - lines.length),
         hideDescriptions,
      });
      for (const row of rows) {
         lines.push(this.styleListLine(row.line, width, row.selected, highlight));
         items.push(row.itemIndex);
      }
      return { lines: lines.slice(0, maxRows), items: items.slice(0, maxRows) };
   }

   /** The layout at `width`; narrow widths keep the plain list when no option has a description to show. */
   private layoutFor(width: number): OptionLayout {
      const layout = chooseOptionLayout(width, this.singleSelectLayout, this.getSplitPaneWidths(width) !== null);
      if ((layout === "strip" || layout === "accordion") && !this.options.some((o) => o.description?.trim())) return "list";
      return layout;
   }

   private subjectFor(index: number, filteredOptions: QuestionOption[]): PreviewSubject {
      if (this.isCommentToggleRow(index, filteredOptions)) {
         return {
            title: "Additional context",
            detail: this.commentEnabled
               ? "On. After you choose an option, you can add a comment explaining it."
               : "Off. Press Enter to add a comment after you choose an option.",
         };
      }
      if (this.isFreeformRow(index, filteredOptions)) {
         let detail = "Open the editor to write **any** answer.\n\n*Use this when none of the listed options fit.*";
         if (this.searchQuery) detail += `\n\nCurrent filter: \`${this.searchQuery}\``;
         return { title: "Custom response", detail };
      }
      const option = filteredOptions[index];
      const description = option?.description?.trim();
      return { title: option?.title ?? "No option selected", detail: description || NO_DESCRIPTION, muted: !description };
   }

   /** Rows the option area needs to show everything without scrolling (Fix 8 "2C"), measured over all options. */
   preferredRows(width: number): number {
      const key = `${width}`;
      const cached = this.needCache.get(key);
      if (cached !== undefined) return cached;
      const mdTheme = safeMarkdownTheme();
      const all = this.options;
      const panes = this.getSplitPaneWidths(width);
      const layout = this.layoutFor(width);
      const subjects = Array.from({ length: this.getItemCount(all) }, (_, i) => this.subjectFor(i, all));
      const docRows = (w: number, titleRow = true) => Math.max(...subjects.map((s) => previewNeedRows(this.theme, s, w, { mdTheme, titleRow })));
      const titles = (w: number, hide: boolean) => this.titleBlocks(w, all, hide).reduce((n, b) => n + b.lines.length, 0);
      let need: number;
      if (layout === "split") need = Math.max(titles(panes!.left, true), docRows(panes!.right));
      else if (layout === "strip") need = titles(width, true) + 1 + docRows(width);
      else if (layout === "accordion") need = titles(width, true) + docRows(width - 6, false);
      else need = titles(width, false);
      need = Math.max(1, need);
      this.needCache.set(key, need);
      return need;
   }

   /** Fewest rows worth showing: the strip and accordion need room for a few options and some text. */
   minimumRows(width: number): number {
      const layout = this.layoutFor(width);
      const floor = layout === "strip" ? 7 : layout === "accordion" ? 6 : 3;
      return Math.min(floor, this.preferredRows(width));
   }

   moveSelection(delta: number): void {
      const count = this.getItemCount(this.getFilteredOptions());
      if (count === 0) return;
      this.selectedIndex = (this.selectedIndex + delta % count + count) % count;
      this.invalidate();
   }

   /** Preview scrolling keys (only while the description overflows). */
   public handlePreviewKeys(data: string): boolean {
      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) return false;
      if (!this.preview.handleKeys(data)) return false;
      this.invalidate();
      return true;
   }

   /** Enter on the selected row: toggle the comment, open the custom response, or choose the option. */
   private confirm(filteredOptions: QuestionOption[]): void {
      if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         this.toggleComment();
         return;
      }
      if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
         this.onEnterFreeform?.();
         return;
      }

      const result = filteredOptions[this.selectedIndex]?.title;
      if (result) this.onSubmit?.(result);
      else this.onCancel?.();
   }

   /** Enter on the highlighted row (the action bar's Select button). */
   public confirmSelected(): void {
      this.confirm(this.getFilteredOptions());
   }

   /** The rows as shown (filtered options, comment toggle, custom response), for Tern's native sheet. */
   nativeSheet(): ChoiceList {
      const rows: ChoiceRow[] = this.getFilteredOptions().map((option) => ({
         id: `o${this.options.indexOf(option)}`,
         kind: "option",
         label: option.title,
         detail: option.description,
      }));
      if (this.allowComment) rows.push({ id: "comment", kind: "comment", label: COMMENT_TOGGLE_LABEL, on: this.commentEnabled });
      if (this.allowFreeform) rows.push({ id: "freeform", kind: "freeform", label: "Other" });
      return { rows, selected: this.selectedIndex, query: this.searchQuery };
   }

   /** Select row `row` of nativeSheet(); `activate` then acts as Enter on it. */
   selectRow(row: number, activate: boolean): void {
      const filteredOptions = this.getFilteredOptions();
      if (row < 0 || row >= this.getItemCount(filteredOptions)) return;
      this.selectedIndex = row;
      this.invalidate();
      if (activate) this.confirm(filteredOptions);
   }

   clickTarget(target: HitTarget, clickCount: number): void {
      if (target.kind !== "row" && target.kind !== "check") return;
      const filteredOptions = this.getFilteredOptions();
      if (target.kind === "check") {
         this.selectedIndex = target.index;
         this.toggleComment();
         return;
      }
      const changed = this.selectedIndex !== target.index;
      this.selectedIndex = target.index;
      this.invalidate();
      // Double-click acts like Enter: choose the option, toggle the comment, open the editor.
      if (!changed && clickCount >= 2) this.confirm(filteredOptions);
   }

   handleMouse(event: AskMouseEvent): AskMouseResult | undefined {
      return handleListMouse(this, event);
   }

   handleInput(data: string): void {
      if (this.handlePreviewKeys(data)) return;
      if (this.searchQuery && matchesKey(data, Key.escape)) {
         this.setSearchQuery("");
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);

      if (matchesSelectUp(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch && filteredOptions.length > 0) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < filteredOptions.length) {
            this.selectedIndex = idx;
            this.invalidate();
            return;
         }
      }

      if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         this.toggleComment();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
         this.confirm(filteredOptions);
         return;
      }

      if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
         this.popSearchCharacter();
         return;
      }

      const printableInput = this.getPrintableInput(data);
      if (printableInput) {
         this.setSearchQuery(this.searchQuery + printableInput);
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const theme = this.theme;
      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;
      this.hits = [];

      const mdTheme = safeMarkdownTheme();
      const { panel } = listColors(theme);
      const panes = this.getSplitPaneWidths(width);
      const layout = this.layoutFor(width);
      const rows = Math.max(1, Math.min(this.maxVisibleRows, this.preferredRows(width)));
      const subject = this.subjectFor(this.selectedIndex, filteredOptions);
      const indicator = theme.fg("dim", `  (${this.selectedIndex + 1}/${count})`);
      this.preview.follow(`${this.searchQuery}\u0000${this.selectedIndex}\u0000${subject.title}`);
      this.preview.active = layout !== "list";
      let lines: string[];

      if (layout === "split") {
         const left = this.windowedListBlocks(panes!.left, filteredOptions, rows, true);
         const preview = renderPreviewPane(theme, subject, panes!.right, rows, this.preview.offset, { mdTheme, tint: panel });
         this.preview.record(preview);
         const separator = splitSeparator(theme, panel);
         lines = Array.from({ length: rows }, (_, row) =>
            `${truncateToWidth(left.lines[row] ?? "", panes!.left, "", true)}${separator}${preview.lines[row] ?? ""}`);
         this.rowHits(left.items, 0, panes!.left);
         this.hits.push({ row: 0, rows, col: 0, cols: panes!.left, target: { kind: "list" } });
         this.previewHits(preview, 0, panes!.left + SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length, rows, panes!.right);
      } else if (layout === "strip") {
         const total = this.titleBlocks(width, filteredOptions, true).reduce((n, b) => n + b.lines.length, 0);
         const listRows = Math.max(Math.min(2, rows), Math.min(total, rows - 4));
         const separatorRows = rows - listRows >= 3 ? 1 : 0;
         const stripRows = Math.max(1, rows - listRows - separatorRows);
         const left = this.windowedListBlocks(width, filteredOptions, listRows, true);
         const preview = renderPreviewPane(theme, subject, width, stripRows, this.preview.offset, { mdTheme, tint: panel });
         this.preview.record(preview);
         lines = [...left.lines, ...(separatorRows ? [stripSeparator(theme, width)] : []), ...preview.lines];
         this.rowHits(left.items, 0, width);
         this.hits.push({ row: 0, rows: left.lines.length, col: 0, cols: width, target: { kind: "list" } });
         this.previewHits(preview, left.lines.length + separatorRows, 0, stripRows, width);
      } else if (layout === "accordion") {
         const blocks = this.titleBlocks(width, filteredOptions, true);
         const titleRows = blocks.reduce((n, b) => n + b.lines.length, 0);
         const docWidth = width - 6;
         // Options without a description don't expand: there is nothing to show.
         const wanted = subject.muted ? 0 : previewNeedRows(theme, subject, docWidth, { mdTheme, titleRow: false });
         const descRows = wanted ? Math.max(Math.min(2, wanted), Math.min(wanted, rows - titleRows)) : 0;
         const preview = renderPreviewPane(theme, subject, docWidth, Math.max(1, descRows), this.preview.offset, { mdTheme, tint: panel, titleRow: false });
         this.preview.record(descRows ? preview : { offset: 0, total: 0, viewport: 0 });
         const at = blocks.findIndex((block) => block.item === this.selectedIndex);
         const expanded: RowBlock[] = [...blocks];
         if (at >= 0 && descRows > 0) expanded.splice(at + 1, 0, { item: -2, lines: preview.lines.map((line) => `      ${line}`) });
         const span = blockSpan(blocks, this.selectedIndex);
         const window = windowRows(expanded, rows, span.start, span.end + descRows, indicator);
         lines = window.lines;
         this.rowHits(window.items, 0, width);
         const descTop = window.items.indexOf(-2);
         if (descTop >= 0) this.previewHits(preview, descTop, 6, Math.min(descRows, lines.length - descTop), docWidth);
         this.hits.push({ row: 0, rows: lines.length, col: 0, cols: width, target: { kind: "list" } });
      } else {
         const window = this.windowedListBlocks(width, filteredOptions, this.maxVisibleRows, false);
         lines = window.lines;
         this.rowHits(window.items, 0, width);
         this.hits.push({ row: 0, rows: lines.length, col: 0, cols: width, target: { kind: "list" } });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }

   private rowHits(items: number[], top: number, width: number): void {
      const filteredOptions = this.getFilteredOptions();
      items.forEach((item, row) => {
         if (item < 0) return;
         const first = row === 0 || items[row - 1] !== item;
         if (first && this.isCommentToggleRow(item, filteredOptions)) {
            this.hits.push({ row: top + row, rows: 1, col: 4, cols: 3, target: { kind: "check", index: item } });
         }
         this.hits.push({ row: top + row, rows: 1, col: 0, cols: width, target: { kind: "row", index: item } });
      });
   }

   private previewHits(preview: PreviewRender, top: number, left: number, rows: number, cols: number): void {
      if (preview.thumb) {
         this.hits.push({
            row: top, rows, col: left + preview.railCol, cols: 1,
            target: { kind: "rail", thumbStart: preview.thumb.start, thumbEnd: preview.thumb.end, maxOffset: preview.maxOffset },
         });
      }
      this.hits.push({ row: top, rows, col: left, cols, target: { kind: "preview" } });
   }
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private displayMode: AskDisplayMode;
   private singleSelectLayout: AskSingleSelectLayout;
   private preferExpandedContext: boolean;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   /** Multi-select custom text, saved with Enter in the editor and sent with the ticked options (Fix 1). */
   private customText = "";
   /** Whether the help line currently describes PgUp/PgDn as scrolling the preview (Fix 2). */
   private hintedOverflow = false;
   /** Inner width of the last frame, for layout-dependent minimum heights. */
   private layoutWidth = 0;
   /** Where the option area and the action bar were drawn, for mouse events (Fix 11). */
   private promptMouseLayout?: { modeTop: number; modeRows: number; helpTop: number; barHits: HitRect[] };
   /** Switches the overlay between its size and fullscreen; set by the prompt runner when a key is configured. */
   private toggleFullscreen?: () => void;
   private pendingSelections: string[] = [];
   private pendingSelectedIds?: number[];
   private pendingCombinedText = "";
   private preselectedIds: number[] = [];
   private freeformDraft = "";
   private commentDraft = "";
   private promptScrollOffset = 0;
   private promptMaxScrollOffset = 0;
   private promptViewportRows = 0;
   private contextIsCollapsible = false;
   private contextExpanded = false;
   // A batch page shows its position in the frame title and a navigation hint.
   private frameTitle = "ask_user";
   private navigationHint: string | null = null;
   // A batch page's question tabs in Tern's native sheet, and where choosing one goes.
   private nativeTabs?: { tabs: QuestionTabs; go: (id: string) => void };

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      displayMode: AskDisplayMode,
      singleSelectLayout: AskSingleSelectLayout,
      contextExpanded: boolean,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
      preselectedIds: number[] = [],
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.displayMode = displayMode;
      this.singleSelectLayout = singleSelectLayout;
      this.preferExpandedContext = contextExpanded;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;
      this.preselectedIds = preselectedIds;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         const mdTheme = safeMarkdownTheme();
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      // Batch questions without options open straight in the editor, like
      // the input dialog a single question without options uses.
      if (this.options.length === 0) {
         this.showFreeformMode();
      } else {
         this.showSelectMode();
      }
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      let lines = this.renderFrame(width);
      // The preview only claims PgUp/PgDn while its text overflows, which is
      // known after the option area is drawn: refresh the hint and redraw once.
      const overflow = this.previewOverflows();
      if (overflow !== this.hintedOverflow) {
         this.hintedOverflow = overflow;
         this.updateHelpText();
         lines = this.renderFrame(width);
      }
      return lines;
   }

   private activeList(): MultiSelectList | WrappedSingleSelectList | undefined {
      if (this.mode !== "select") return undefined;
      return this.allowMultiple ? this.multiSelectList : this.singleSelectList;
   }

   private previewOverflows(): boolean {
      return !!this.activeList()?.preview.overflow;
   }

   /** True for multi-select questions whose custom text is kept and sent with the ticks (Fix 1). */
   private usesCustomTextRow(): boolean {
      return this.allowMultiple && this.allowFreeform && this.options.length > 0;
   }

   private renderFrame(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      this.layoutWidth = innerWidth;

      if (this.displayMode === "overlay" || this.displayMode === "adaptive" || this.displayMode === "fullscreen") {
         return this.renderOverlayLayout(width, innerWidth);
      }

      if (this.mode === "select" && !this.allowMultiple) {
         this.ensureSingleSelectList().setMaxVisibleRows(12);
      }

      return this.renderInlineLayout(width, innerWidth);
   }

   private renderInlineLayout(width: number, innerWidth: number): string[] {
      const fullContextLines = this.buildFullContextLines(innerWidth);
      this.setContextIsCollapsible(fullContextLines.length > INLINE_CONTEXT_MAX_ROWS);
      if (this.contextExpanded) {
         return this.renderOverlayLayout(width, innerWidth);
      }
      const promptLines = this.buildPromptLines(innerWidth, fullContextLines);
      const modeLines = this.modeContainer.render(innerWidth);
      const bar = this.renderActionBarLine(innerWidth);
      const bodyLines = [
         ...promptLines,
         "",
         ...modeLines,
         "",
         ...(bar ? [bar.line] : []),
         ...this.helpText.render(innerWidth),
      ];
      this.promptMouseLayout = {
         modeTop: promptLines.length + 1,
         modeRows: modeLines.length,
         helpTop: promptLines.length + 1 + modeLines.length + 1,
         barHits: bar?.hits ?? [],
      };
      return this.frameBodyLines(bodyLines, width, innerWidth);
   }

   private getOverlayMaxRenderLines(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.max(1, Math.floor(this.tui.terminal.rows)) : 24;
      if (this.displayMode === "fullscreen") return rows;
      if (this.displayMode === "adaptive") return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.65)));
      return getOverlayMaxRenderLinesForRows(rows);
   }
   /** Switch a live overlay without recreating the list/selection component. */
   public setDisplayMode(mode: AskDisplayMode): void {
      this.displayMode = mode;
      this.invalidate();
      this.tui.requestRender();
   }

   private renderOverlayLayout(width: number, innerWidth: number): string[] {
      const maxLines = this.getOverlayMaxRenderLines();
      if (maxLines <= 1) return [this.renderTopBorder(width)];
      if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

      const bodyCapacity = Math.max(0, maxLines - 2);
      // The action bar (I4) takes the first help row only when two help rows fit.
      const bar = bodyCapacity >= 12 ? this.renderActionBarLine(innerWidth) : undefined;
      const helpRows = () => [...(bar ? [bar.line] : []), ...this.helpText.render(innerWidth)];
      let helpFullLines = helpRows();
      const questionLines = this.buildQuestionLines(innerWidth);
      const fullContextLines = this.buildFullContextLines(innerWidth);
      const shouldCollapse = this.displayMode === "inline"
         ? this.contextIsCollapsible
         : this.mode === "select"
            ? this.shouldCollapseContextForOverlay(
               questionLines.length,
               fullContextLines.length,
               bodyCapacity,
               helpFullLines.length,
            )
            : this.contextIsCollapsible;
      this.setContextIsCollapsible(shouldCollapse);
      helpFullLines = helpRows();
      const promptLines = this.buildPromptLines(innerWidth, fullContextLines);
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpFullLines.length);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);

      let promptBudget = 0;
      let modeBudget = 0;
      let separatorRows = 0;

      if (this.mode === "select") {
         separatorRows = contentRows >= 4 ? 1 : 0;
         const promptAndModeRows = Math.max(0, contentRows - separatorRows);
         promptBudget = promptAndModeRows;

         if (promptAndModeRows > 0) {
            const promptMinRows = promptLines.length > 0 ? 1 : 0;
            const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
            const modeMinRows = Math.min(this.getMinimumModeRows(), maximumModeRows);
            modeBudget = Math.min(this.getPreferredModeRows(innerWidth), maximumModeRows);
            modeBudget = Math.max(modeMinRows, modeBudget);
            promptBudget = promptAndModeRows - modeBudget;

            const usefulPromptTarget = this.displayMode === "fullscreen" || this.displayMode === "adaptive" ? Math.min(5, promptLines.length) : this.contextIsCollapsible && !this.contextExpanded ? 3 : 2;
            const usefulPromptRows = Math.min(
               promptLines.length,
               promptAndModeRows >= modeMinRows + usefulPromptTarget ? usefulPromptTarget : promptMinRows,
            );
            if (promptBudget < usefulPromptRows && modeBudget > modeMinRows) {
               const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMinRows);
               modeBudget -= shiftedRows;
               promptBudget += shiftedRows;
            }
         }
      } else {
         modeBudget = Math.min(this.getPreferredModeRows(innerWidth), contentRows);
         modeBudget = Math.max(Math.min(this.getMinimumModeRows(), contentRows), modeBudget);
         promptBudget = Math.max(0, contentRows - modeBudget);
         if (promptBudget > 0 && modeBudget > 0) {
            separatorRows = 1;
            promptBudget = Math.max(0, promptBudget - separatorRows);
         }
      }

      const modeLines = this.renderModeLines(innerWidth, modeBudget);
      if (modeLines.length < modeBudget) {
         promptBudget += modeBudget - modeLines.length;
      }

      const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, innerWidth);
      const helpLines = this.limitLines(helpFullLines, helpBudget, innerWidth, false);
      const separator = separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : [];
      const bodyLines = [...promptPaneLines, ...separator, ...modeLines, ...helpLines];
      const modeTop = promptPaneLines.length + separator.length;
      let helpTop = modeTop + modeLines.length;

      let fitted = bodyLines.slice(0, bodyCapacity);
      if (this.displayMode === "fullscreen") {
         // Fullscreen keeps the keyboard hints at the bottom when the list is short.
         const helpCount = Math.min(helpLines.length, fitted.length);
         const padding = Math.max(0, bodyCapacity - fitted.length);
         fitted.splice(fitted.length - helpCount, 0, ...Array(padding).fill(""));
         helpTop += padding;
      }
      this.promptMouseLayout = {
         modeTop,
         modeRows: modeLines.length,
         helpTop,
         barHits: bar && helpLines.length > 0 && helpLines.length <= helpFullLines.length && helpBudget >= 2 ? bar.hits : [],
      };
      return this.frameBodyLines(fitted, width, innerWidth);
   }

   private buildQuestionLines(width: number): string[] {
      return this.questionText.render(width);
   }

   private buildFullContextLines(width: number): string[] {
      if (!this.contextComponent) return [];
      return this.contextComponent.render(width);
   }

   private setContextIsCollapsible(value: boolean): void {
      if (this.contextIsCollapsible === value) return;
      this.contextIsCollapsible = value;
      // Whenever context becomes collapsible (first render, or a resize that
      // shrinks the viewport) start in the user's preferred state; ctrl+e still
      // toggles from there.
      this.contextExpanded = value && this.preferExpandedContext;
      this.updateHelpText();
   }

   private getContextToggleKey(): string {
      const reserved = new Set(
         [this.shortcuts.overlayToggle, this.shortcuts.commentToggle, this.shortcuts.fullscreenToggle]
            .filter((shortcut) => !shortcut.disabled)
            .map((shortcut) => shortcut.spec),
      );
      return CONTEXT_TOGGLE_KEYS.find((key) => !reserved.has(key)) ?? CONTEXT_TOGGLE_KEYS[0]!;
   }

   private buildContextDisplayLines(fullContextLines: string[], width: number): string[] {
      if (fullContextLines.length === 0) return [];
      if (!this.contextIsCollapsible || this.contextExpanded) return fullContextLines;
      const label = `Context (${fullContextLines.length} lines) — ${this.getContextToggleKey()} expand`;
      return [truncateToWidth(this.theme.fg("dim", label), width, "")];
   }

   private buildPromptLines(width: number, fullContextLines: string[]): string[] {
      const questionLines = this.buildQuestionLines(width);
      const contextLines = this.buildContextDisplayLines(fullContextLines, width);
      const contextSeparator = this.contextIsCollapsible && !this.contextExpanded ? [] : [""];
      return [
         ...questionLines,
         ...(contextLines.length > 0 ? [...contextSeparator, ...contextLines] : []),
      ];
   }

   private shouldCollapseContextForOverlay(
      questionRows: number,
      contextRows: number,
      bodyCapacity: number,
      helpRows: number,
   ): boolean {
      if (contextRows === 0) return false;
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpRows);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);
      const separatorRows = contentRows >= 4 ? 1 : 0;
      const promptCapacity = Math.max(
         0,
         contentRows - separatorRows - this.getMinimumModeRows(),
      );
      return questionRows + 1 + contextRows > promptCapacity;
   }

   private getOverlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
      if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
      if (bodyCapacity >= 12) return Math.min(2, renderedHelpRows);
      return 1;
   }

   private getMinimumModeRows(): number {
      if (this.mode === "freeform") return 5;
      if (this.mode === "comment") return 6;
      // Narrow layouts (strip, accordion) need a few more rows, so long context collapses sooner.
      const list = this.allowMultiple ? this.multiSelectList : this.singleSelectList;
      return list && this.layoutWidth ? Math.max(3, list.minimumRows(this.layoutWidth)) : 3;
   }

   private getPreferredModeRows(width: number): number {
      if (this.displayMode === "fullscreen") {
         const rows = Number.isFinite(this.tui.terminal.rows) ? Math.max(1, Math.floor(this.tui.terminal.rows)) : 24;
         return rows; // The actual mode budget is clipped by the prompt/help constraints above.
      }
      if (this.mode === "freeform") return 10;
      if (this.mode === "comment") return 11;
      if (this.displayMode === "adaptive") {
         // Adaptive (Fix 8 "2C"): as tall as the tallest option needs, measured over
         // every option so the box keeps its height while you move or filter.
         const list = this.allowMultiple ? this.ensureMultiSelectList() : this.ensureSingleSelectList();
         return Math.max(this.getMinimumModeRows(), list.preferredRows(width));
      }
      return 8;
   }

   /** Buttons for the current mode (I4); undefined when there's nothing worth a button row. */
   private renderActionBarLine(width: number): { line: string; hits: HitRect[] } | undefined {
      const buttons: ActionButton[] = [];
      if (this.mode === "select") {
         buttons.push({ id: "submit", label: this.allowMultiple ? "Submit" : "Select", key: "⏎", primary: true });
         buttons.push({ id: "cancel", label: "Cancel", key: "esc" });
      } else if (this.mode === "freeform" && this.usesCustomTextRow()) {
         buttons.push({ id: "editor-submit", label: "Save", key: "⏎", primary: true });
         buttons.push({ id: "editor-back", label: "Undo edit", key: "esc" });
      } else {
         buttons.push({ id: "editor-submit", label: "Submit", key: "⏎", primary: true });
         buttons.push({ id: "editor-back", label: this.options.length === 0 ? "Cancel" : "Back", key: "esc" });
      }
      const fullscreen = this.shortcuts.fullscreenToggle;
      if (this.displayMode !== "inline" && this.toggleFullscreen && !fullscreen.disabled) {
         buttons.push({ id: "fullscreen", label: this.displayMode === "fullscreen" ? "Restore" : "Fullscreen", key: fullscreen.spec });
      }
      return renderActionBar(this.theme, buttons, width);
   }

   /** Called by the prompt runner with the function that resizes the overlay. */
   public setFullscreenToggleHandler(toggle: () => void): void {
      this.toggleFullscreen = toggle;
      this.updateHelpText();
   }

   private pressButton(id: string): void {
      if (id === "fullscreen") {
         this.toggleFullscreen?.();
         return;
      }
      if (id === "cancel") {
         this.onDone(null);
         return;
      }
      if (id === "submit") {
         if (this.allowMultiple) this.ensureMultiSelectList().submit();
         else this.ensureSingleSelectList().confirmSelected();
         this.tui.requestRender();
         return;
      }
      if (id === "editor-submit") {
         this.handleEditorSubmit(this.ensureEditor().getText());
         return;
      }
      if (id === "editor-back") {
         if (this.options.length === 0) this.onDone(null);
         else this.leaveEditor();
      }
   }

   /**
    * Mouse input in Pi's fullscreen TUI (I1–I4): the option area goes to the
    * list (clicks, wheel, scrollbar drags), and the action bar's buttons act
    * like their keys. Coordinates are relative to this component's frame.
    */
   // Typed loosely: Container's signature names pi-tui mouse types that older Pi
   // versions don't export. Pi wraps a plain { handled } result with the target itself.
   override handleMouse(event: any): any {
      return this.routeMouse(event as AskMouseEvent);
   }

   private routeMouse(event: AskMouseEvent): AskMouseResult | undefined {
      const layout = this.promptMouseLayout;
      if (!layout) return undefined;
      const x = event.x - BOX_BORDER_LEFT.length;
      const y = event.y - 1;
      const list = this.activeList();
      if (list && (list.drag || (y >= layout.modeTop && y < layout.modeTop + layout.modeRows))) {
         const result = list.handleMouse({ ...event, x, y: y - layout.modeTop });
         if (result) {
            this.tui.requestRender();
            return { handled: true, ...result };
         }
      }
      const button = hitAt(layout.barHits, x, y - layout.helpTop);
      if (button?.target.kind === "button") {
         if (event.type === "click") this.pressButton(button.target.id);
         if (event.type === "click" || event.type === "press") return { handled: true };
      }
      return undefined;
   }

   private renderModeLines(width: number, budget: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];

      if (this.mode === "select") {
         if (this.allowMultiple) {
            this.ensureMultiSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         } else {
            this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         }
         return this.limitLines(this.modeContainer.render(width), safeBudget, width, true);
      }

      return this.renderEditorModeLines(width, safeBudget);
   }

   private renderEditorModeLines(width: number, budget: number): string[] {
      const headerLines = this.buildEditorModeHeaderLines(width);
      const minimumEditorRows = Math.min(3, budget);
      const headerBudget = Math.max(0, budget - minimumEditorRows);
      const visibleHeaderLines = this.limitLines(headerLines, headerBudget, width, true);
      const editorBudget = Math.max(0, budget - visibleHeaderLines.length);

      return [
         ...visibleHeaderLines,
         ...this.limitEditorLines(this.ensureEditor().render(width), editorBudget, width),
      ];
   }

   /** The editor's heading: "Custom response", or for multi-select the saved-text heading and what is ticked. */
   private customTextHeader(): string[] {
      const theme = this.theme;
      if (!this.usesCustomTextRow()) return [theme.fg("accent", theme.bold("Custom response"))];
      const ticked = this.ensureMultiSelectList().selectedOptionIndices(true).map((index) => this.options[index]!.title);
      return [
         `${theme.fg("accent", theme.bold("Your own text"))}${theme.fg("dim", "   enter save · esc undo this edit")}`,
         `${theme.fg("muted", "Ticked so far: ")}${ticked.length ? theme.fg("text", ticked.join(", ")) : theme.fg("dim", "nothing yet")}`,
      ];
   }

   private buildEditorModeHeaderLines(width: number): string[] {
      if (this.mode === "comment") {
         const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
         return [
            ...new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0).render(width),
            ...new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0).render(width),
            "",
         ];
      }

      return [
         ...this.customTextHeader().flatMap((line) => new Text(line, 1, 0).render(width)),
         "",
      ];
   }

   private limitEditorLines(lines: string[], budget: number, width: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];

      const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
      const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
      if (safeBudget === 2) return [topBorder, bottomBorder];

      const contentLines = lines.slice(1, -1);
      const contentBudget = safeBudget - 2;
      // Locate the cursor row: prefer the zero-width CURSOR_MARKER the editor
      // emits while focused (the same mechanism pi-tui core uses for hardware
      // cursor placement), falling back to the inverse-video fake cursor.
      const cursorLineIndex = contentLines.findIndex(
         (line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
      );
      const maxStart = Math.max(0, contentLines.length - contentBudget);
      const start = cursorLineIndex >= 0
         ? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart))
         : maxStart;
      const visibleContentLines = contentLines.slice(start, start + contentBudget);
      const markedContentLines = this.applyPromptOverflowMarkers(
         visibleContentLines,
         width,
         start > 0,
         start + contentBudget < contentLines.length,
      );

      return [topBorder, ...markedContentLines, bottomBorder];
   }

   private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
      const viewportRows = Math.max(0, Math.floor(budget));
      this.promptViewportRows = viewportRows;

      if (viewportRows <= 0 || promptLines.length === 0) {
         this.promptMaxScrollOffset = 0;
         this.promptScrollOffset = 0;
         return [];
      }

      this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
      this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));

      const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
      const hasHiddenAbove = this.promptScrollOffset > 0;
      const hasHiddenBelow = this.promptScrollOffset + viewportRows < promptLines.length;
      return this.applyPromptOverflowMarkers(visibleLines, width, hasHiddenAbove, hasHiddenBelow);
   }

   private applyPromptOverflowMarkers(
      lines: string[],
      width: number,
      hasHiddenAbove: boolean,
      hasHiddenBelow: boolean,
   ): string[] {
      if (lines.length === 0) return lines;

      const marked = [...lines];
      if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width);
         return marked;
      }

      if (hasHiddenAbove) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
      }
      if (hasHiddenBelow) {
         const lastIndex = marked.length - 1;
         marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width);
      }
      return marked;
   }

   private addPromptOverflowMarker(line: string, marker: string, width: number): string {
      return truncateToWidth(`${this.theme.fg("dim", marker)} ${line}`, width, "", true);
   }

   private limitLines(lines: string[], budget: number, width: number, showOverflowMarker: boolean): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (!showOverflowMarker) {
         return lines.slice(0, safeBudget).map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];
      return [
         ...lines.slice(0, safeBudget - 1).map((line) => truncateToWidth(line, width, "", true)),
         this.theme.fg("dim", "…"),
      ];
   }

   private renderTopBorder(width: number): string {
      return new BoxBorderTop(
         (s: string) => this.theme.fg("accent", s),
         this.frameTitle,
         (s: string) => this.theme.fg("dim", this.theme.bold(s)),
      ).render(width)[0] ?? "";
   }

   private renderBottomBorder(width: number): string {
      return new BoxBorderBottom(
         (s: string) => this.theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => this.theme.fg("dim", s),
      ).render(width)[0] ?? "";
   }

   private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return [
         this.renderTopBorder(width),
         ...bodyLines.map((line) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
         }),
         this.renderBottomBorder(width),
      ];
   }

   private frameRawLines(rawLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return rawLines.map((line, index) => {
         if (index === 0) return this.renderTopBorder(width);
         if (index === rawLines.length - 1) return this.renderBottomBorder(width);
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode !== "inline" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const fullscreen = this.shortcuts.fullscreenToggle;
      const fullscreenHint = this.displayMode !== "inline" && !fullscreen.disabled && this.toggleFullscreen
         ? literalHint(theme, fullscreen.spec, this.displayMode === "fullscreen" ? "restore" : "fullscreen")
         : null;
      // PgUp/PgDn scroll the highlighted option's description only while it overflows (Fix 2).
      const previewScrolls = this.mode === "select" && this.previewOverflows();
      const promptScrollHint = previewScrolls
         ? [literalHint(theme, "PgUp/PgDn", "preview"), literalHint(theme, "alt+↑↓", "line")].join(" • ")
         : this.displayMode !== "inline" || this.contextExpanded
            ? literalHint(theme, "PgUp/PgDn", "prompt")
            : null;
      const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled
         ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
         : null;
      const contextHint = this.contextIsCollapsible
         ? literalHint(
            theme,
            this.getContextToggleKey(),
            this.contextExpanded ? "collapse context" : "expand context",
         )
         : null;
      if (this.mode === "freeform" || this.mode === "comment") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const savesText = this.mode === "freeform" && this.usesCustomTextRow();
         const hints = [
            this.navigationHint,
            keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : savesText ? "save" : "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", this.options.length === 0 ? "cancel" : savesText ? "undo edit" : "back"),
            overlayHint,
            fullscreenHint,
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.allowMultiple) {
         const hints = [
            this.navigationHint,
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            commentHint,
            contextHint,
            promptScrollHint,
            this.customText ? literalHint(theme, "⌫", "remove your text") : null,
            overlayHint,
            fullscreenHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            this.navigationHint,
            literalHint(theme, "type", "filter"),
            commentHint,
            contextHint,
            promptScrollHint,
            keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
            literalHint(theme, "↑↓", "navigate"),
            overlayHint,
            fullscreenHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "clear/cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   /** Batch pages: show the question strip in the frame title and the page-navigation hint. */
   setBatchChrome(frameTitle: string, navigationHint: string): void {
      this.frameTitle = frameTitle;
      this.navigationHint = navigationHint;
      this.updateHelpText();
   }

   /** Batch pages: the question tabs of the native sheet. */
   setNativeTabs(tabs: QuestionTabs, go: (id: string) => void): void {
      this.nativeTabs = { tabs, go };
   }

   /**
    * pi-tern's native presentation, in omp's ask style: the options as a list
    * (a click is Enter on a row, Space on a multi-select option), or the custom
    * response / comment over a native editor bound to pi's. Every pointer event
    * runs the transition the keys run.
    */
   [NATIVE_COMPONENT](native: TernContext): TernNode {
      const tabs = this.nativeTabs;
      // A tab click; true when the event was one.
      const onTab = (event: TernEvent): boolean => {
         if (event.ev !== "select" || nodeKey(event.id) !== "tabs") return false;
         tabs?.go(nodeKey(event.item));
         return true;
      };

      if (this.mode === "freeform" || this.mode === "comment") {
         const editor = this.ensureEditor();
         native.field(editor);
         const { line, col } = editor.getCursor();
         const cursor = editor.getLines().slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + col;
         const backToOptions = this.options.length > 0;
         const savesText = this.mode === "freeform" && this.usesCustomTextRow();
         const ticked = savesText ? this.ensureMultiSelectList().selectedOptionIndices(true).map((index) => this.options[index]!.title) : [];
         native.onEvent((event) => {
            if (onTab(event) || event.ev !== "action") return;
            if (event.act === "cancel" || event.act === "close") {
               if (backToOptions) this.leaveEditor();
               else this.onDone(null);
            } else if (event.act === "submit") {
               this.handleEditorSubmit(editor.getText());
            }
         });
         return textSheet({
            question: this.question,
            context: this.context,
            lead: this.mode === "comment"
               ? `Selected: ${this.pendingSelections.join(", ")}`
               : savesText ? `Your own text, sent with the ticked options. Ticked so far: ${ticked.length ? ticked.join(", ") : "nothing yet"}` : undefined,
            text: editor.getText(),
            cursor,
            placeholder: this.mode === "comment" ? "Add context for your selection" : "Type your answer",
            escape: backToOptions ? "back" : "cancel",
            ...(savesText ? { submitLabel: "Save" } : {}),
            tabs: tabs?.tabs,
         });
      }

      const list = this.allowMultiple ? this.ensureMultiSelectList() : this.ensureSingleSelectList();
      const sheet = list.nativeSheet();
      native.onEvent((event) => {
         if (onTab(event)) return;
         if (event.ev === "select" && nodeKey(event.id) === CHOICE_LIST_KEY) {
            list.selectRow(sheet.rows.findIndex((row) => row.id === nodeKey(event.item)), true);
         } else if (event.ev === "action") {
            if (event.act === "cancel" || event.act === "close") this.onDone(null);
            else if (event.act === "submit" && this.multiSelectList) this.multiSelectList.submit();
            else if (event.act === "submit") list.selectRow(sheet.selected, true);
         }
         this.tui.requestRender();
      });
      return choiceSheet({
         question: this.question,
         context: this.context,
         rows: sheet.rows,
         selected: sheet.selected,
         multiple: this.allowMultiple,
         query: sheet.query,
         tabs: tabs?.tabs,
      });
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.singleSelectLayout,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.preselect(this.preselectedIds);
      list.onSubmit = (result) => {
         const index = list.selectedOptionIndex();
         this.handleSelectionSubmit([result], list.isCommentEnabled(), index === undefined ? undefined : selectedIdsForIndices(this.options, [index]));
      };
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.singleSelectLayout,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onCancel = () => this.onDone(null);
      list.preselect(this.preselectedIds);
      list.setCustomText(this.customText);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled(),
         result.length ? selectedIdsForIndices(this.options, list.selectedOptionIndices()) : undefined);
      list.onClearCustom = () => {
         this.customText = "";
         list.setCustomText("");
         this.tui.requestRender();
      };
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean, selectedIds?: number[]): void {
      // Only text the user saved goes out; an abandoned editor draft never does (Fix 1).
      const custom = this.usesCustomTextRow() ? this.customText : "";
      if (this.allowComment && wantsComment && selections.length > 0) {
         this.pendingSelections = selections;
         this.pendingSelectedIds = selectedIds;
         this.pendingCombinedText = custom;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(custom ? createCombinedResponse(selections, custom, selectedIds) : createSelectionResponse(selections, undefined, selectedIds));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.freeformDraft = text;
         if (this.usesCustomTextRow()) {
            // Multi-select: Enter saves the text and returns to the list, where it
            // shows ticked on its row; Submit then sends it with the ticked options.
            this.customText = text.trim();
            const list = this.ensureMultiSelectList();
            list.setCustomText(this.customText);
            this.showSelectMode();
            list.focusCustomRow();
            return;
         }
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(this.pendingCombinedText
            ? createCombinedResponse(this.pendingSelections, this.pendingCombinedText, this.pendingSelectedIds, text)
            : createSelectionResponse(this.pendingSelections, text, this.pendingSelectedIds));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   /** Esc in the editor: back to the options. For multi-select custom text this undoes the edit (Fix 1). */
   private leaveEditor(): void {
      const wasCustomText = this.mode === "freeform" && this.usesCustomTextRow();
      this.showSelectMode();
      if (wasCustomText) this.ensureMultiSelectList().focusCustomRow();
   }

   private showFreeformMode(): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      // Multi-select edits the saved text; anything typed and then dropped with Esc is gone.
      this.setEditorText(this.usesCustomTextRow() ? this.customText : this.freeformDraft);
      (editor as any).focused = this._focused;

      for (const line of this.customTextHeader()) this.modeContainer.addChild(new Text(line, 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private toggleContext(): boolean {
      if (this.mode !== "select" || !this.contextIsCollapsible) return false;
      this.contextExpanded = !this.contextExpanded;
      this.promptScrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return true;
   }

   private setPromptScrollOffset(nextOffset: number): boolean {
      if (this.displayMode === "inline" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
      const changed = clamped !== this.promptScrollOffset;
      this.promptScrollOffset = clamped;
      return changed;
   }

   private handlePromptScrollInput(data: string): boolean {
      if (this.displayMode === "inline" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      // Prompt scrolling is select-mode only: in freeform/comment modes the
      // editor owns PageUp/PageDown (tui.editor.pageUp/pageDown) for paging
      // through long input, so intercepting them here would steal editor keys.
      if (this.mode !== "select") return false;

      const pageRows = Math.max(1, this.promptViewportRows - 1);
      const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
      let handled = false;

      if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) {
         handled = true;
         this.setPromptScrollOffset(0);
      } else if (matchesKey(data, PROMPT_SCROLL_END_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptMaxScrollOffset);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows);
      }

      return handled;
   }

   handleInput(data: string): void {
      if (matchesKey(data, this.getContextToggleKey() as any) && this.toggleContext()) {
         return;
      }
      // While the highlighted option's description overflows, PgUp/PgDn and
      // Alt+↑/↓ scroll it; otherwise they fall through to the prompt (Fix 2).
      if (this.mode === "select" && (this.allowMultiple
         ? this.multiSelectList?.handlePreviewKeys(data)
         : this.singleSelectList?.handlePreviewKeys(data))) {
         this.tui.requestRender();
         return;
      }
      if (this.handlePromptScrollInput(data)) {
         this.tui.requestRender();
         return;
      }
      if (this.mode === "freeform" || this.mode === "comment") {
         if (matchesKey(data, Key.escape)) {
            // Without options there is no list to go back to, so esc cancels.
            if (this.options.length === 0) {
               this.onDone(null);
               return;
            }
            this.leaveEditor();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.allowMultiple) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }
}

// Rows Pi's fullscreen layout keeps outside the input dock: the transcript's
// minimum row, the working status, and up to three footer rows.
const INLINE_DOCK_RESERVED_ROWS = 5;
// Answer rows the review page keeps before squeezing its footer.
const REVIEW_MIN_CONTENT_ROWS = 3;

/** Frame body lines in the ask_user box with the given title. */
function frameBox(theme: Theme, title: string, bodyLines: string[], width: number): string[] {
   const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
   const borderColor = (s: string) => theme.fg("accent", s);
   return [
      new BoxBorderTop(borderColor, title, (s: string) => theme.fg("dim", theme.bold(s))).render(width)[0] ?? "",
      ...bodyLines.map((line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`),
      new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => theme.fg("dim", s)).render(width)[0] ?? "",
   ];
}

/**
 * One prompt for a whole `questions` batch: a page per question plus a review
 * page. Each page is an AskComponent that stays alive, so filters, drafts, and
 * checkboxes survive moving between pages. Answers are recorded per page and
 * only the review page submits; esc that would cancel a page cancels the batch.
 */
class BatchAskComponent implements Component {
   private pages: AskComponent[];
   private answers: Array<AskResponse | undefined>;
   private current = 0;
   private title = "";
   private confirmingSkips = false;
   // The native sheets' question tabs, rebuilt with the frame title.
   private tabs: QuestionTabs = { tabs: [], tab: "q0" };
   private reviewScrollOffset = 0;
   private reviewMaxScrollOffset = 0;
   private _focused = false;
   private toggleFullscreen?: () => void;
   /** The review page's action bar position, for mouse clicks (I4). */
   private reviewBar?: { row: number; hits: HitRect[] };

   constructor(
      private questions: BatchQuestion[],
      private settings: PromptSettings,
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private onDone: (answers: BatchAnswer[] | null) => void,
      private heading?: string,
   ) {
      this.answers = questions.map(() => undefined);
      this.pages = questions.map((entry, index) => new AskComponent(
         entry.question,
         entry.context,
         entry.options,
         entry.allowMultiple,
         entry.allowFreeform,
         settings.allowComment,
         settings.displayMode,
         settings.singleSelectLayout,
         settings.contextExpanded,
         tui,
         theme,
         keybindings,
         settings.shortcuts,
         (result) => this.handlePageDone(index, result),
         entry.preselectedIds,
      ));
      this.updateChrome();
   }

   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      const page = this.pages[this.current];
      if (page) page.focused = value;
   }

   public setDisplayMode(mode: AskDisplayMode): void {
      this.settings.displayMode = mode;
      for (const page of this.pages) page.setDisplayMode(mode);
      this.tui.requestRender();
   }

   public setFullscreenToggleHandler(toggle: () => void): void {
      this.toggleFullscreen = toggle;
      for (const page of this.pages) page.setFullscreenToggleHandler(toggle);
   }

   /** Mouse events go to the current question page, or to the review page's buttons. */
   handleMouse(event: AskMouseEvent): AskMouseResult | undefined {
      const page = this.pages[this.current];
      if (page) return page.handleMouse(event);
      const bar = this.reviewBar;
      if (!bar) return undefined;
      const button = hitAt(bar.hits, event.x - BOX_BORDER_LEFT.length, event.y - 1 - bar.row);
      if (button?.target.kind !== "button") return undefined;
      if (event.type === "click") {
         if (button.target.id === "submit") this.submitReview();
         else if (button.target.id === "cancel") this.onDone(null);
         else if (button.target.id === "fullscreen") this.toggleFullscreen?.();
         this.tui.requestRender();
      }
      return { handled: true };
   }

   invalidate(): void {
      for (const page of this.pages) page.invalidate();
   }

   render(width: number): string[] {
      const page = this.pages[this.current];
      return page ? page.render(width) : this.renderReview(width);
   }

   handleInput(data: string): void {
      const pageCount = this.questions.length + 1;
      // Tab and shift+tab move between pages here; inside a page, arrows and
      // ctrl+j/k still move the option selection.
      if (matchesKey(data, Key.tab)) {
         this.goTo((this.current + 1) % pageCount);
         return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
         this.goTo((this.current + pageCount - 1) % pageCount);
         return;
      }
      const page = this.pages[this.current];
      if (page) {
         page.handleInput(data);
         return;
      }
      this.handleReviewInput(data);
   }

   private handlePageDone(index: number, result: AskUIResult | null): void {
      if (result === null) {
         this.onDone(null);
         return;
      }
      this.answers[index] = result;
      const count = this.questions.length;
      for (let step = 1; step <= count; step++) {
         const next = (index + step) % count;
         if (!this.answers[next]) {
            this.goTo(next);
            return;
         }
      }
      this.goTo(count);
   }

   private goTo(target: number): void {
      const previous = this.pages[this.current];
      if (previous) previous.focused = false;
      this.current = target;
      this.confirmingSkips = false;
      this.reviewScrollOffset = 0;
      const next = this.pages[target];
      if (next) next.focused = this._focused;
      this.updateChrome();
      this.tui.requestRender();
   }

   private updateChrome(): void {
      const labels = this.questions.map((_, index) => {
         const label = `${index + 1}${this.answers[index] ? "✓" : ""}`;
         return index === this.current ? `[${label}]` : label;
      });
      const review = this.current === this.questions.length ? "[review]" : "review";
      // The frame title is one terminal row, so the heading's line breaks collapse here only.
      const heading = this.heading ? ` · ${truncateToWidth(this.heading.replace(/\s+/g, " "), 40, "…")}` : "";
      this.title = `ask_user${heading} ${labels.join(" ")} · ${review}`;
      const hint = literalHint(this.theme, "tab/shift+tab", "questions");
      for (const page of this.pages) page.setBatchChrome(this.title, hint);
      this.tabs = {
         tabs: [
            ...this.questions.map((entry, index) => ({
               id: `q${index}`,
               label: `${this.answers[index] ? "✓ " : ""}${shortLabel(entry.question)}`,
            })),
            { id: "review", label: "Review" },
         ],
         tab: this.current < this.questions.length ? `q${this.current}` : "review",
         ...(this.heading ? { heading: this.heading } : {}),
      };
      for (const page of this.pages) page.setNativeTabs(this.tabs, (id) => this.goToTab(id));
   }

   /** A native tab (`q<index>` or `review`). */
   private goToTab(id: string): void {
      const target = id === "review" ? this.questions.length : Number(id.slice(1));
      if (Number.isInteger(target) && target >= 0 && target <= this.questions.length && target !== this.current) this.goTo(target);
   }

   /** pi-tern's native presentation: the current question's sheet, or the review sheet. */
   [NATIVE_COMPONENT](native: TernContext): TernNode {
      const page = this.pages[this.current];
      if (page) return page[NATIVE_COMPONENT](native);
      native.onEvent((event) => {
         if (event.ev === "select" && nodeKey(event.id) === "tabs") this.goToTab(nodeKey(event.item));
         else if (event.ev !== "action") return;
         else if (event.act === "cancel" || event.act === "close") this.onDone(null);
         else if (event.act === "submit") this.submitReview();
      });
      return reviewSheet({
         rows: this.questions.map((entry, index) => {
            const response = this.answers[index];
            return { question: entry.question, answer: response ? formatResponseSummary(response) : undefined };
         }),
         tabs: this.tabs,
         confirmSkips: this.confirmingSkips,
      });
   }

   /** Submit from the review page; with unanswered questions, the first submit asks to confirm. */
   private submitReview(): void {
      if (this.unansweredCount() > 0 && !this.confirmingSkips) {
         this.confirmingSkips = true;
         this.tui.requestRender();
         return;
      }
      this.onDone(this.answers.map((response): BatchAnswer =>
         response ? { status: "answered", response } : { status: "skipped" }));
   }

   private unansweredCount(): number {
      return this.answers.filter((answer) => !answer).length;
   }

   private handleReviewInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onDone(null);
         return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
         this.submitReview();
         return;
      }
      // Kitty's keyboard protocol can deliver digits as CSI-u sequences.
      const key = decodeKittyPrintable(data) ?? data;
      const jump = key.length === 1 ? Number.parseInt(key, 10) : Number.NaN;
      if (jump >= 1 && jump <= this.questions.length) {
         this.goTo(jump - 1);
         return;
      }
      const pageRows = Math.max(1, this.reviewLineCap() - 4);
      const scrollBy = matchesSelectUp(data, this.keybindings) ? -1
         : matchesSelectDown(data, this.keybindings) ? 1
            : matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY) ? -pageRows
               : matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY) ? pageRows
                  : 0;
      if (scrollBy !== 0) {
         this.reviewScrollOffset = Math.max(0, Math.min(this.reviewScrollOffset + scrollBy, this.reviewMaxScrollOffset));
         this.tui.requestRender();
      }
   }

   private renderReview(width: number): string[] {
      const theme = this.theme;
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      // Answer rows leave room for a two-cell overflow marker ("↑ ", "↓ ", "↕ "),
      // so marking a row never truncates its text. The footer is never marked.
      const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, innerWidth - 2));
      const wrapFooter = (text: string) => wrapTextWithAnsi(text, innerWidth);
      const contentLines = [
         ...wrap(theme.fg("accent", theme.bold("Review answers"))),
         ...(this.heading ? wrap(theme.fg("text", this.heading)) : []),
         "",
      ];
      this.questions.forEach((entry, index) => {
         const response = this.answers[index];
         const marker = response ? theme.fg("success", "✓") : theme.fg("warning", "○");
         contentLines.push(...wrap(`${marker} ${theme.fg("text", `${index + 1}. ${entry.question}`)}`));
         contentLines.push(...wrap(response
            ? `   ${theme.fg("dim", "→")} ${theme.fg("accent", formatResponseSummary(response))}`
            : `   ${theme.fg("warning", "unanswered")}`));
      });

      const unanswered = this.unansweredCount();
      const overlayToggle = this.settings.shortcuts.overlayToggle;
      const hints = [
         keybindingHint(theme, this.keybindings, "tui.select.confirm", unanswered > 0 ? "submit with skips" : "submit"),
         literalHint(theme, this.questions.length > 1 ? `1-${this.questions.length}` : "1", "edit"),
         literalHint(theme, "tab/shift+tab", "questions"),
         this.settings.displayMode !== "inline" && !overlayToggle.disabled
            ? literalHint(theme, overlayToggle.spec, "hide")
            : null,
         keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
      ].filter((hint): hint is string => !!hint).join(" • ");
      const warningText = this.confirmingSkips
         ? theme.fg("warning", `${unanswered} unanswered — press ${formatKeyList(this.keybindings.getKeys("tui.select.confirm"))} again to submit with skips`)
         : undefined;
      const hintText = theme.fg("dim", hints);
      const bodyCapacity = Math.max(1, this.reviewLineCap() - 2);
      const fullscreen = this.settings.shortcuts.fullscreenToggle;
      const bar = renderActionBar(theme, [
         { id: "submit", label: unanswered > 0 && this.confirmingSkips ? "Submit with skips" : "Submit", key: "⏎", primary: true },
         { id: "cancel", label: "Cancel", key: "esc" },
         ...(this.settings.displayMode !== "inline" && this.toggleFullscreen && !fullscreen.disabled
            ? [{ id: "fullscreen", label: this.settings.displayMode === "fullscreen" ? "Restore" : "Fullscreen", key: fullscreen.spec }]
            : []),
      ], innerWidth);
      let footerLines = ["", ...(warningText ? wrapFooter(warningText) : []), bar.line, ...wrapFooter(hintText)];
      // On very short prompts keep room for answers: drop the spacer and keep
      // the warning and hints to one line each (frameBox truncates them).
      if (bodyCapacity - footerLines.length < REVIEW_MIN_CONTENT_ROWS) {
         footerLines = [...(warningText ? [warningText] : []), hintText];
      }
      const barRow = footerLines.indexOf(bar.line);

      // The answers scroll inside the cap while the footer stays visible.
      const contentBudget = Math.max(1, bodyCapacity - footerLines.length);
      this.reviewMaxScrollOffset = Math.max(0, contentLines.length - contentBudget);
      this.reviewScrollOffset = Math.min(this.reviewScrollOffset, this.reviewMaxScrollOffset);
      const visibleContent = contentLines.slice(this.reviewScrollOffset, this.reviewScrollOffset + contentBudget);
      const hiddenAbove = this.reviewScrollOffset > 0;
      const hiddenBelow = this.reviewScrollOffset < this.reviewMaxScrollOffset;
      // Mark overflow in front of the first and last visible rows instead of
      // replacing them, so even a one-row viewport still shows an answer.
      const marker = (symbol: string, line: string) => `${theme.fg("dim", symbol)} ${line}`;
      const last = visibleContent.length - 1;
      if (hiddenAbove && hiddenBelow && last === 0) {
         visibleContent[0] = marker("↕", visibleContent[0]!);
      } else {
         if (hiddenAbove) visibleContent[0] = marker("↑", visibleContent[0]!);
         if (hiddenBelow) visibleContent[last] = marker("↓", visibleContent[last]!);
      }
      const reviewBody = [...visibleContent, ...footerLines];
      let spacer = 0;
      if (this.settings.displayMode === "fullscreen") {
         spacer = Math.max(0, bodyCapacity - reviewBody.length);
         reviewBody.splice(visibleContent.length, 0, ...Array(spacer).fill(""));
      }
      this.reviewBar = barRow >= 0 ? { row: visibleContent.length + spacer + barRow, hits: bar.hits } : undefined;
      return frameBox(theme, this.title, reviewBody, width);
   }

   /** Rows the review page may use, borders included. */
   private reviewLineCap(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
      const overlayCap = getOverlayMaxRenderLinesForRows(rows);
      if (this.settings.displayMode === "fullscreen") return Math.max(1, rows);
      if (this.settings.displayMode === "adaptive") return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.65)));
      if (this.settings.displayMode === "overlay") return overlayCap;
      // Inline prompts sit in Pi's fullscreen input dock, which clips anything
      // taller than what remains after the transcript's minimum row, the
      // working status, and the 2-3 row footer. Components only learn their
      // width, so stay within that space instead of growing with the content.
      return Math.max(4, Math.min(overlayCap, rows - INLINE_DOCK_RESERVED_ROWS));
   }
}

type DialogOptions = { signal?: AbortSignal; timeout?: number };

/**
 * Options for the next dialog stage. A batch shares one deadline across every
 * stage, so each stage gets only the time that is left (null once it has
 * passed); a single question keeps its fixed per-dialog timeout.
 */
function dialogStageOptions(
   dialogOpts: DialogOptions | undefined,
   deadline: number | undefined,
): DialogOptions | undefined | null {
   if (deadline === undefined) return dialogOpts;
   const remaining = deadline - Date.now();
   return remaining > 0 ? { ...dialogOpts, timeout: remaining } : null;
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   dialogOpts?: DialogOptions,
   deadline?: number,
   preselectedIds: number[] = [],
): Promise<AskUIResult | null> {
   if (dialogOpts?.signal?.aborted) return null;
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      return askMultiViaDialogs(ui, prompt, options, allowFreeform, allowComment, dialogOpts, deadline, preselectedIds);
   }

   // Plain titles, as hosts and RPC clients expect. Only when two options share a
   // title are the labels numbered, so the answer maps back to the right option.
   const duplicateTitles = new Set(options.map((o) => o.title)).size !== options.length;
   const selectOptions = options.map((o, index) => (duplicateTitles ? `${index + 1}. ${o.title}` : o.title));
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selectOpts = dialogStageOptions(dialogOpts, deadline);
   if (selectOpts === null) return null;
   const selected = await ui.select(prompt, selectOptions, selectOpts) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answerOpts = dialogStageOptions(dialogOpts, deadline);
      if (answerOpts === null) return null;
      const answer = await ui.input(prompt, "Type your answer...", answerOpts) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   const chosenIndex = selectOptions.indexOf(selected);
   // A host that returns something it was not offered still gets the upstream behavior: the text is the answer.
   const chosenTitle = chosenIndex >= 0 && chosenIndex < options.length ? options[chosenIndex]!.title : selected;
   const chosenIds = chosenIndex >= 0 && chosenIndex < options.length ? selectedIdsForIndices(options, [chosenIndex]) : undefined;
   if (!allowComment) {
      return createSelectionResponse([chosenTitle], undefined, chosenIds);
   }

   const commentOpts = dialogStageOptions(dialogOpts, deadline);
   if (commentOpts === null) return null;
   const comment = await ui.input(
      buildCommentPrompt(prompt, [chosenTitle]),
      "Optional comment (press Enter to skip)...",
      commentOpts,
   ) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(comment)) return null;
   return createSelectionResponse([chosenTitle], comment, chosenIds);
}

type MultiDialogParse =
   | { ok: true; indices: number[]; custom: boolean }
   | { ok: false; error: string };

/** Read "2, 4" or "Red, Green" from the multi-select dialog. Option numbers always work; titles work when unique. */
export function parseMultiDialogInput(raw: string, options: QuestionOption[], customNumber: number | undefined): MultiDialogParse {
   const tokens = parseDialogSelections(raw);
   const indices: number[] = [];
   let custom = false;
   const last = customNumber ?? options.length;
   for (const token of tokens) {
      let index: number | undefined;
      if (/^\d+$/.test(token)) {
         const n = Number(token);
         if (customNumber !== undefined && n === customNumber) { custom = true; continue; }
         if (n >= 1 && n <= options.length) index = n - 1;
         else return { ok: false, error: `${token} isn't an option number. Use numbers 1–${last}.` };
      } else {
         let matches = options.flatMap((o, i) => (o.title === token ? [i] : []));
         if (matches.length === 0) matches = options.flatMap((o, i) => (o.title.toLowerCase() === token.toLowerCase() ? [i] : []));
         if (matches.length === 0) return { ok: false, error: `"${token}" isn't an option. Use numbers 1–${last}.` };
         if (matches.length > 1) return { ok: false, error: `"${token}" matches more than one option. Use its number instead.` };
         index = matches[0]!;
      }
      if (!indices.includes(index)) indices.push(index);
   }
   return { ok: true, indices, custom };
}

/**
 * Multi-select in the dialog fallback. Options are numbered; when custom text is
 * allowed, one more numbered entry ("Type something") opens a text box, and only
 * then. Input that isn't a valid choice asks again, quoting what was typed,
 * instead of failing the tool call. Every stage shares the caller's deadline.
 */
async function askMultiViaDialogs(
   ui: { select: Function; input: Function },
   prompt: string,
   options: QuestionOption[],
   allowFreeform: boolean,
   allowComment: boolean,
   dialogOpts: DialogOptions | undefined,
   deadline: number | undefined,
   preselectedIds: number[],
): Promise<AskUIResult | null> {
   const customNumber = allowFreeform ? options.length + 1 : undefined;
   const optionList = formatOptionsForMessage(options) + (customNumber ? `\n${customNumber}. ${FREEFORM_DIALOG_LABEL}` : "");
   const preselected = preselectedIds
      .map((id) => options.findIndex((o) => (o as IdentifiedOption).id === id))
      .filter((index) => index >= 0);
   const keepHint = preselected.length
      ? `\n\nAlready selected: ${preselected.map((i) => `${i + 1}. ${options[i]!.title}`).join(", ")}. Press Enter to keep them.`
      : "";
   let problem = "";
   let chosen: { indices: number[]; custom: boolean };
   for (;;) {
      const selectionOpts = dialogStageOptions(dialogOpts, deadline);
      if (selectionOpts === null) return null;
      const raw = await ui.input(
         `${problem ? `⚠ ${problem}\n\n` : ""}${prompt}\n\nOptions (select one or more):\n${optionList}${keepHint}`,
         "Type your selection(s)...",
         selectionOpts,
      ) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(raw)) return null;
      const parsed = parseMultiDialogInput(raw, options, customNumber);
      if (!parsed.ok) {
         problem = `You typed "${raw.trim()}". ${parsed.error}`;
         continue;
      }
      if (parsed.indices.length === 0 && !parsed.custom) {
         if (!preselected.length) return null;
         chosen = { indices: preselected, custom: false };
      } else {
         chosen = parsed;
      }
      break;
   }

   const selections = chosen.indices.map((i) => options[i]!.title);
   const selectedIds = selectedIdsForIndices(options, chosen.indices);
   let text = "";
   if (chosen.custom) {
      const textOpts = dialogStageOptions(dialogOpts, deadline);
      if (textOpts === null) return null;
      const lead = selections.length ? `${prompt}\n\nSelected: ${selections.join(", ")}\nYour own text:` : `${prompt}\n\nYour own text:`;
      const answer = await ui.input(lead, "Type your answer...", textOpts) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(answer)) return null;
      text = answer ?? "";
   }
   if (!selections.length && !text.trim()) return null;
   if (!allowComment || selections.length === 0) {
      return createCombinedResponse(selections, text, selectedIds);
   }

   const commentOpts = dialogStageOptions(dialogOpts, deadline);
   if (commentOpts === null) return null;
   const comment = await ui.input(
      buildCommentPrompt(prompt, selections),
      "Optional comment (press Enter to skip)...",
      commentOpts,
   ) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(comment)) return null;
   return createCombinedResponse(selections, text, selectedIds, comment);
}

/**
 * RPC/headless fallback for a `questions` batch: ask each question in turn
 * with the select()/input() dialogs. There is no review step here, so
 * cancelling any question cancels the whole batch, and every dialog stage
 * shares one deadline.
 */
async function askBatchViaDialogs(
   ui: { select: Function; input: Function },
   questions: BatchQuestion[],
   allowComment: boolean,
   signal: AbortSignal | undefined,
   deadline: number | undefined,
   heading?: string,
): Promise<BatchAnswer[] | null> {
   const dialogOpts = signal ? { signal } : undefined;
   const answers: BatchAnswer[] = [];
   for (const [index, entry] of questions.entries()) {
      if (signal?.aborted) return null;
      const title = `${heading ? `${heading}\n` : ""}(${index + 1}/${questions.length}) ${entry.question}`;
      let response: AskResponse | null;
      if (entry.options.length === 0) {
         // Same as a single question without options: a plain text answer.
         const prompt = entry.context ? `${title}\n\nContext:\n${entry.context}` : title;
         const answerOpts = dialogStageOptions(dialogOpts, deadline);
         if (answerOpts === null) return null;
         const answer = await ui.input(prompt, "Type your answer...", answerOpts) as string | undefined;
         response = signal?.aborted ? null : createFreeformResponse(answer);
      } else {
         response = await askViaDialogs(
            ui,
            title,
            entry.context,
            entry.options,
            entry.allowMultiple,
            entry.allowFreeform,
            allowComment,
            dialogOpts,
            deadline,
            entry.preselectedIds,
         );
      }
      if (!response) return null;
      answers.push({ status: "answered", response });
   }
   return answers;
}

interface PromptSettings {
   displayMode: AskDisplayMode;
   singleSelectLayout: AskSingleSelectLayout;
   allowComment: boolean;
   contextExpanded: boolean;
   shortcuts: ResolvedAskShortcuts;
}

/** Resolve presentation preferences: call parameter, then env var, then ask-user.json, then built-in default. */
function resolvePromptSettings(params: AskParams): PromptSettings {
   // Re-read on every ask_user call so edits to ask-user.json apply without restarting Pi.
   const settings = loadAskUserSettings();
   const envMode = process.env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase();
   const envDisplayMode: AskDisplayMode | undefined =
      envMode === "overlay" || envMode === "inline" || envMode === "adaptive" || envMode === "fullscreen" ? envMode : undefined;
   const envSingleSelectLayout = process.env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase();
   const overlayToggle = resolveShortcut(
      params.overlayToggleKey,
      process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
      settings.overlayToggleKey,
      DEFAULT_OVERLAY_TOGGLE_KEY,
   );
   const commentToggle = resolveShortcut(
      params.commentToggleKey,
      process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
      settings.commentToggleKey,
      DEFAULT_COMMENT_TOGGLE_KEY,
   );
   let fullscreenToggle = resolveShortcut(
      params.fullscreenToggleKey,
      process.env.PI_ASK_USER_FULLSCREEN_TOGGLE_KEY,
      settings.fullscreenToggleKey,
      DEFAULT_FULLSCREEN_TOGGLE_KEY,
   );
   // A key can do only one thing: the hide and comment keys keep theirs.
   if (!fullscreenToggle.disabled && [overlayToggle, commentToggle].some((other) => !other.disabled && other.spec === fullscreenToggle.spec)) {
      fullscreenToggle = DISABLED_SHORTCUT;
   }
   return {
      displayMode: params.displayMode ?? envDisplayMode ?? settings.displayMode ?? "overlay",
      singleSelectLayout: params.singleSelectLayout
         ?? (envSingleSelectLayout === "list" || envSingleSelectLayout === "auto" ? envSingleSelectLayout : undefined)
         ?? settings.singleSelectLayout
         ?? "auto",
      allowComment: params.allowComment
         ?? parseBooleanPreference(process.env.PI_ASK_USER_ALLOW_COMMENT)
         ?? settings.allowComment
         ?? false,
      contextExpanded: params.contextExpanded
         ?? parseBooleanPreference(process.env.PI_ASK_USER_CONTEXT_EXPANDED)
         ?? settings.contextExpanded
         ?? false,
      shortcuts: {
         overlayToggle,
         commentToggle,
         fullscreenToggle,
      },
   };
}

/** Report the session as blocked on the user (`herdr:blocked`) for the duration of `run`. */
async function whileBlocked<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
   pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
   try {
      return await run();
   } finally {
      pi.events.emit("herdr:blocked", { active: false });
   }
}

interface CustomPromptRequest<T> {
   signal?: AbortSignal;
   timeout?: number;
   displayMode: AskDisplayMode;
   overlayToggle: ResolvedShortcut;
   fullscreenToggle: ResolvedShortcut;
   createComponent: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      complete: (value: T | null) => void,
   ) => Component;
   /** RPC/headless mode: ctx.ui.custom() returns undefined, so degrade to the select()/input() dialogs. */
   fallback: () => Promise<T | null>;
}

/**
 * Show one custom-UI prompt and own every resource it needs: the abort
 * listener, the timeout timer, and the hide/fullscreen terminal listener.
 * Completion is guarded so a late timer, abort, or keypress cannot resolve
 * twice, and every resource is released however the prompt ends.
 */
async function runCustomPrompt<T>(ui: ExtensionUIContext, request: CustomPromptRequest<T>): Promise<T | null> {
   const { signal, timeout, displayMode, overlayToggle, fullscreenToggle } = request;
   let overlayHandle: OverlayHandle | undefined;
   let removeOverlayInputListener: (() => void) | undefined;
   let customTimer: ReturnType<typeof setTimeout> | undefined;
   let onCustomAbort: (() => void) | undefined;
   let customCompleted = false;
   let hasAnnouncedHide = false;
   let activeComponent: Component | undefined;
   let activeTui: TUI | undefined;
   let currentDisplayMode: AskDisplayMode = displayMode;
   const initialDisplayMode: AskDisplayMode = displayMode === "fullscreen" ? "adaptive" : displayMode;
   const overlayOptions = buildCustomUIOptions(displayMode, (handle) => { overlayHandle = handle; });
   try {
      const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T | null) => void) => {
         const complete = (value: T | null) => {
            if (customCompleted) return;
            customCompleted = true;
            done(signal?.aborted ? null : value);
         };
         if (signal) {
            onCustomAbort = () => complete(null);
            signal.addEventListener("abort", onCustomAbort, { once: true });
         }

         if (signal?.aborted) {
            complete(null);
         } else if (timeout && timeout > 0) {
            customTimer = setTimeout(() => complete(null), timeout);
         }

         activeTui = tui;
         activeComponent = request.createComponent(tui, theme, keybindings, complete);
         // The Fullscreen button (I4) runs the same switch as the key.
         const withToggle = activeComponent as Component & { setFullscreenToggleHandler?: (toggle: () => void) => void };
         if (displayMode !== "inline" && !fullscreenToggle.disabled) withToggle.setFullscreenToggleHandler?.(switchFullscreen);
         return activeComponent;
      };

      // One raw terminal input listener owns the prompt's window keys, so they
      // work even while the overlay is hidden (hidden overlays do not receive
      // input): the hide/show key and the fullscreen key. Inline mode needs
      // neither, because it has no overlay to hide or resize.
      function switchFullscreen(): void {
         if (!activeTui || !overlayOptions?.overlayOptions) return;
         currentDisplayMode = currentDisplayMode === "fullscreen" ? initialDisplayMode : "fullscreen";
         resizeOverlay(currentDisplayMode);
         const component = activeComponent as (Component & { setDisplayMode?: (mode: AskDisplayMode) => void }) | undefined;
         component?.setDisplayMode?.(currentDisplayMode);
         activeTui.requestRender();
      }
      const resizeOverlay = (mode: AskDisplayMode) => {
         const bounds = overlayOptions?.overlayOptions;
         if (!bounds) return;
         // pi reads overlay options by reference on every render, so resizing in place is enough.
         bounds.width = mode === "fullscreen" ? "100%" : ASK_OVERLAY_WIDTH;
         bounds.minWidth = mode === "fullscreen" ? 1 : ASK_OVERLAY_MIN_WIDTH;
         bounds.maxHeight = mode === "fullscreen" ? "100%" : mode === "adaptive" ? "65%" : "85%";
         bounds.margin = mode === "fullscreen" ? 0 : 1;
      };
      if (
         displayMode !== "inline"
         && (!overlayToggle.disabled || !fullscreenToggle.disabled)
         && typeof ui.onTerminalInput === "function"
      ) {
         removeOverlayInputListener = ui.onTerminalInput((data) => {
            const isHideKey = overlayToggle.matches(data) && !!overlayHandle;
            const isFullscreenKey = !isHideKey && fullscreenToggle.matches(data) && !!activeTui && !!overlayOptions?.overlayOptions;
            if (!isHideKey && !isFullscreenKey) return undefined;
            // Kitty's progressive keyboard protocol reports press, repeat,
            // and release as separate events. Act only on the initial press;
            // otherwise one physical keypress can toggle twice. Still consume
            // repeat/release events so they do not reach the component
            // focused behind it.
            if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
            if (isHideKey) {
               const nextHidden = !overlayHandle!.isHidden();
               overlayHandle!.setHidden(nextHidden);
               if (nextHidden && !hasAnnouncedHide) {
                  hasAnnouncedHide = true;
                  ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, "info");
               }
               return { consume: true };
            }
            if (overlayHandle?.isHidden()) return { consume: true };
            switchFullscreen();
            return { consume: true };
         });
      }

      const customResult = signal?.aborted ? null : await ui.custom<T | null>(customFactory, overlayOptions);

      if (signal?.aborted) return null;
      if (customResult !== undefined) return customResult;
      return await request.fallback();
   } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
   } finally {
      customCompleted = true;
      if (customTimer !== undefined) clearTimeout(customTimer);
      if (onCustomAbort) signal?.removeEventListener("abort", onCustomAbort);
      removeOverlayInputListener?.();
   }
}

/** A top-level question sent with questions is the batch's heading, not another question (#80). */
function batchHeading(params: AskParams): string | undefined {
   return typeof params.question === "string" && params.question.trim() ? params.question.trim() : undefined;
}

/**
 * Validate and normalize a `questions` batch. Every problem throws before any
 * UI opens or event fires (#67), with a message that tells the model how to
 * correct the call.
 */
function normalizeBatchQuestions(params: AskParams): BatchQuestion[] {
   // Top-level context/options/allowMultiple/allowFreeform are ignored here: entries carry their own,
   // and models that echo schema defaults would otherwise loop on a validation error (#88).
   const { questions } = params;
   if (!Array.isArray(questions)) {
      throw new Error(`questions must be an array of ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} question objects.`);
   }
   if (questions.length < BATCH_MIN_QUESTIONS) {
      throw new Error(
         `questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. To ask one question, use question instead.`,
      );
   }
   if (questions.length > BATCH_MAX_QUESTIONS) {
      throw new Error(
         `questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. Ask the rest in a later ask_user call.`,
      );
   }

   const seen = new Set<string>();
   return questions.map((entry, index) => {
      const label = `questions[${index}]`;
      const question = typeof entry?.question === "string" ? entry.question.trim() : "";
      if (!question) throw new Error(`${label}.question must be a non-empty string.`);
      const key = question.toLowerCase();
      if (seen.has(key)) {
         throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
      }
      seen.add(key);

      const rawOptions = entry.options ?? [];
      if (!Array.isArray(rawOptions)) throw new Error(`${label}.options must be an array.`);
      const { options, preselectedIds } = normalizeIdentifiedOptions(rawOptions, entry.preselectedIds, entry.allowMultiple ?? false, label);
      if (rawOptions.length > 0 && options.length === 0) {
         throw new Error(
            `All ${rawOptions.length} option(s) in ${label} were malformed, so nothing could be shown to the user. `
            + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
            + `Call ask_user again with corrected options.`,
         );
      }

      return {
         question,
         context: typeof entry.context === "string" ? entry.context.trim() || undefined : undefined,
         options,
         allowMultiple: entry.allowMultiple ?? false,
         allowFreeform: entry.allowFreeform ?? true,
         preselectedIds,
      };
   });
}

interface AskEventSubject {
   question: string;
   context?: string;
   options: QuestionOption[];
}

/** Position of a question inside a `questions` batch, attached to its ask:* events. */
interface BatchPosition {
   index: number;
   total: number;
}

function createAskEventEmitter(pi: ExtensionAPI) {
   // Every installed extension receives these events. By default only the
   // question and the response kind are broadcast; the context and the
   // user's actual selections/comment/freeform text stay inside the tool
   // result unless the user opts in (#51).
   const emitFullEvents = parseBooleanPreference(process.env.PI_ASK_USER_EMIT_FULL_EVENTS)
      ?? loadAskUserSettings().emitFullEvents
      ?? false;
   return {
      answered(subject: AskEventSubject, response: AskResponse, batch?: BatchPosition): void {
         const position = batch ? { batch } : {};
         pi.events.emit(
            "ask:answered",
            emitFullEvents
               ? { question: subject.question, context: subject.context, response, ...position }
               : { question: subject.question, response: { kind: response.kind }, ...position },
         );
      },
      cancelled(subject: AskEventSubject, batch?: BatchPosition): void {
         const position = batch ? { batch } : {};
         pi.events.emit(
            "ask:cancelled",
            emitFullEvents
               ? { question: subject.question, context: subject.context, options: subject.options, ...position }
               : { question: subject.question, ...position },
         );
      },
   };
}

function formatBatchAnswers(details: AskBatchDetails): string {
   const heading = details.heading ? [details.heading] : [];
   const lines = details.questions.map((subject, index) => {
      const answer = details.answers[index]!;
      const summary = answer.status === "answered" ? formatResponseSummary(answer.response) : "(skipped)";
      return `${index + 1}. ${subject.question} → ${summary}`;
   });
   const answered = details.answers.filter((answer) => answer.status === "answered").length;
   return [...heading, `User answered ${answered} of ${details.questions.length} questions:`, ...lines].join("\n");
}

function formatBatchForMessage(questions: BatchQuestion[], allowComment: boolean, heading?: string): string {
   const blocks = questions.map((entry, index) => {
      const lines = [`${index + 1}. ${entry.question}`];
      if (entry.context) lines.push(`   Context: ${entry.context.replace(/\n/g, "\n   ")}`);
      if (entry.options.length > 0) {
         lines.push(`   Options${entry.allowMultiple ? " (choose one or more)" : ""}:`);
         lines.push(...formatOptionsForMessage(entry.options).split("\n").map((line) => `   ${line}`));
         if (entry.allowFreeform) lines.push("   You can also answer freely.");
      }
      return lines.join("\n");
   });
   const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
   const intro = heading ? `\n\n${heading}` : "";
   return `Ask requires interactive mode. Please answer these questions:${intro}\n\n${blocks.join("\n\n")}${commentHint}`;
}

async function executeBatch(
   pi: ExtensionAPI,
   params: AskParams,
   signal: AbortSignal | undefined,
   onUpdate: AgentToolUpdateCallback<AskBatchDetails> | undefined,
   ctx: ExtensionContext,
): Promise<AgentToolResult<AskBatchDetails>> {
   const questions = normalizeBatchQuestions(params);
   const heading = batchHeading(params);
   const settings = resolvePromptSettings(params);
   const events = createAskEventEmitter(pi);
   const subjects = questions.map(({ question, context, options }) => ({ question, context, options }));
   const details = (answers: BatchAnswer[], cancelled: boolean): AskBatchDetails => ({
      kind: "batch",
      ...(heading ? { heading } : {}),
      questions: subjects,
      answers,
      cancelled,
   });

   if (!ctx.hasUI || !ctx.ui) {
      throw new Error(formatBatchForMessage(questions, settings.allowComment, heading));
   }

   onUpdate?.({
      content: [{ type: "text", text: "Waiting for user input..." }],
      details: details([], false),
   });

   const deadline = params.timeout && params.timeout > 0 ? Date.now() + params.timeout : undefined;
   // One timer owns the batch deadline. It aborts the signal that every prompt
   // and dialog already listens to, so an open dialog closes exactly on time
   // (native dialog countdowns round up to whole seconds) and a late answer
   // cancels the batch. The caller's abort is forwarded to the same signal.
   const batch = new AbortController();
   const forwardAbort = () => batch.abort();
   signal?.addEventListener("abort", forwardAbort, { once: true });
   // An abort that already fired (for example inside onUpdate above) is not replayed.
   if (signal?.aborted) batch.abort();
   const deadlineTimer = deadline === undefined ? undefined : setTimeout(() => batch.abort(), params.timeout);
   let answers: BatchAnswer[] | null;
   try {
      answers = await whileBlocked(pi, () => runCustomPrompt<BatchAnswer[]>(ctx.ui, {
         signal: batch.signal,
         displayMode: settings.displayMode,
         overlayToggle: settings.shortcuts.overlayToggle,
            fullscreenToggle: settings.shortcuts.fullscreenToggle,
         createComponent: (tui, theme, keybindings, complete) =>
            new BatchAskComponent(questions, settings, tui, theme, keybindings, complete, heading),
         fallback: () => askBatchViaDialogs(ctx.ui, questions, settings.allowComment, batch.signal, deadline, heading),
      }));
   } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", forwardAbort);
   }

   if (batch.signal.aborted || answers === null) {
      subjects.forEach((subject, index) => events.cancelled(subject, { index, total: subjects.length }));
      return {
         content: [{ type: "text", text: "User cancelled the questions" }],
         details: details([], true),
      };
   }

   // Skipped questions emit nothing; each answered one emits its usual event.
   answers.forEach((answer, index) => {
      if (answer.status === "answered") {
         events.answered(subjects[index]!, answer.response, { index, total: subjects.length });
      }
   });
   const result = details(answers, false);
   return {
      content: [{ type: "text", text: formatBatchAnswers(result) }],
      details: result,
   };
}

/** Expanded-result block: every option with the selected ones marked, then the comment. */
function formatOptionMarkers(
   theme: Theme,
   options: QuestionOption[],
   response: Extract<AskResponse, { kind: "selection" | "combined" }>,
   indent = "",
): string {
   const selectedTitles = new Set(response.selections);
   const selectedIds = response.selectedIds ? new Set(response.selectedIds) : null;
   let text = `\n${indent}` + theme.fg("dim", "Options:");
   for (const opt of options) {
      const desc = opt.description ? ` — ${opt.description}` : "";
      const chosen = selectedIds ? selectedIds.has((opt as IdentifiedOption).id as number) : selectedTitles.has(opt.title);
      const marker = chosen ? theme.fg("success", "●") : theme.fg("dim", "○");
      text += `\n${indent}  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
   }
   if (response.kind === "combined") {
      text += `\n${indent}${theme.fg("dim", "Custom:")} ${theme.fg("dim", response.text)}`;
   }
   if (response.comment) {
      text += `\n${indent}${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
   }
   return text;
}

function formatBatchResult(theme: Theme, details: AskBatchDetails, expanded: boolean): string {
   if (details.cancelled) return theme.fg("warning", "Cancelled");
   const answered = details.answers.filter((answer) => answer.status === "answered").length;
   let text = theme.fg("success", "✓ ")
      + theme.fg("accent", `${answered} of ${details.questions.length} answered`);
   details.questions.forEach((subject, index) => {
      const answer = details.answers[index]!;
      text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", subject.question)}${theme.fg("dim", " → ")}`;
      if (answer.status === "skipped") {
         text += theme.fg("warning", "(skipped)");
         return;
      }
      const response = answer.response;
      if (response.kind === "freeform") {
         text += theme.fg("muted", "(wrote) ");
      }
      text += theme.fg("accent", formatResponseSummary(response));
      if (!expanded) return;
      if (subject.context) {
         text += `\n   ${theme.fg("dim", subject.context)}`;
      }
      if (isSelectionResponse(response) && subject.options.length > 0) {
         text += formatOptionMarkers(theme, subject.options, response, "   ");
      }
   });
   return text;
}

export default function(pi: ExtensionAPI) {
   // Flat object shape: union item schemas get stripped or rejected
   // by several providers/proxies (Google function calling,
   // Codex-style backends, cmux), leaving the model to guess the shape
   // and produce empty options. Plain strings are still accepted at
   // runtime for older transcripts. See issue #22.
   const optionSchema = Type.Object({
      id: Type.Optional(Type.Number({ minimum: 1, multipleOf: 1, description: "Unique positive integer option ID; required on every option when using preselectedIds" })),
      title: Type.String({ description: "Short title for this option" }),
      description: Type.Optional(
         Type.String({ description: "Longer description explaining this option" }),
      ),
   });

   // Asks the user, so only the model may call it; codemode scripts cannot open prompts. Pi types `exposure` from
   // 1.0 and older hosts ignore it, so it is spread in to keep the definition valid against every supported host.
   const modelOnly: Record<string, unknown> = { exposure: "model-only" };
   pi.registerTool({
      ...modelOnly,
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      promptSnippet:
         "Ask the user one focused question (or 2-4 independent ones together) with optional multiple-choice answers to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Ask one focused question per ask_user call by default.",
         "Use questions (2-4 entries) only for independent decisions whose prerequisites are already settled; ask anything that depends on another answer in a later ask_user call.",
         "With questions, put every question inside questions. A top-level question is only shown as the batch heading and is never asked or answered.",
         "Do not combine multiple numbered, multipart, or unrelated questions into one question's text.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential",
      parameters: Type.Object({
         question: Type.Optional(
            Type.String({ description: "The question to ask the user. With questions, it is only an optional heading for the batch; put every actual question inside questions." }),
         ),
         questions: Type.Optional(
            Type.Array(
               Type.Object({
                  question: Type.String({ description: "One question in the batch" }),
                  context: Type.Optional(
                     Type.String({ description: "Relevant context to show with this question (summary of findings)" }),
                  ),
                  options: Type.Optional(
                     Type.Array(optionSchema, { description: "List of options for this question" }),
                  ),
                  allowMultiple: Type.Optional(
                     Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
                  ),
                  allowFreeform: Type.Optional(
                     Type.Boolean({ description: "Add a freeform text option. Default: true" }),
                  ),
                  preselectedIds: Type.Optional(Type.Array(Type.Number({ minimum: 1, multipleOf: 1 }),
                     { description: "Initial checked option IDs for this batch question; at most one in single-select" })),
               }),
               {
                  minItems: BATCH_MIN_QUESTIONS,
                  maxItems: BATCH_MAX_QUESTIONS,
                  description: "2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
               },
            ),
         ),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(optionSchema, { description: "List of options for the user to choose from" }),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         preselectedIds: Type.Optional(Type.Array(Type.Number({ minimum: 1, multipleOf: 1 }),
            { description: "IDs of options to preselect; requires numeric IDs on all options" })),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: PI_ASK_USER_ALLOW_COMMENT env var or allowComment in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR) if set, otherwise false." }),
         ),
         displayMode: Type.Optional(
            StringEnum(["overlay", "inline", "adaptive", "fullscreen"] as const, {
               description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place, 'adaptive' uses 65% terminal height, 'fullscreen' fills the terminal. Default: PI_ASK_USER_DISPLAY_MODE env var, then displayMode in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'overlay'. Omit to respect the user's configured preference.",
            }),
         ),
         singleSelectLayout: Type.Optional(
            StringEnum(["auto", "list"] as const, {
               description: "Single-select layout. 'auto' uses a details pane on wide terminals; 'list' always keeps descriptions below options. Default: PI_ASK_USER_SINGLE_SELECT_LAYOUT env var, then singleSelectLayout in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'auto'.",
            }),
         ),
         contextExpanded: Type.Optional(
            Type.Boolean({
               description: "Start with oversized context expanded instead of collapsed behind a one-line summary. Default: PI_ASK_USER_CONTEXT_EXPANDED env var or contextExpanded in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR) if set, otherwise false.",
            }),
         ),
         overlayToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var, then overlayToggleKey in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'alt+o'.",
            }),
         ),
         commentToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var, then commentToggleKey in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'ctrl+g'.",
            }),
         ),
         fullscreenToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut that switches the open prompt between its normal size and fullscreen (overlay, adaptive and fullscreen modes), e.g. 'alt+m' or 'f11'. Pass 'off' to disable. Default: PI_ASK_USER_FULLSCREEN_TOGGLE_KEY env var, then fullscreenToggleKey in ~/.pi/agent/ask-user.json (respecting PI_CODING_AGENT_DIR), otherwise 'alt+m'. Omit to respect the user's configured preference.",
            }),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         if ((params as AskParams).questions != null) {
            if (signal?.aborted) {
               return {
                  content: [{ type: "text", text: "Cancelled" }],
                  details: { kind: "batch", questions: [], answers: [], cancelled: true } as AskBatchDetails,
               };
            }
            return executeBatch(pi, params as AskParams, signal, onUpdate, ctx);
         }

         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { question: params.question, options: [], response: null, cancelled: true } as AskToolDetails,
            };
         }

         if (typeof params.question !== "string") {
            throw new Error(
               "ask_user needs question (one focused question) or questions (2-4 independent questions).",
            );
         }

         const question = params.question;
         const {
            context,
            options: rawOptions = [],
            allowMultiple = false,
            allowFreeform = true,
            timeout,
         } = params as AskParams;
         const settings = resolvePromptSettings(params as AskParams);
         const { allowComment } = settings;
         const { options, preselectedIds } = normalizeIdentifiedOptions(rawOptions, (params as AskParams).preselectedIds, allowMultiple, "question");
         const normalizedContext = context?.trim() || undefined;
         const dialogOpts = signal
            ? (timeout ? { signal, timeout } : { signal })
            : (timeout ? { timeout } : undefined);
         const events = createAskEventEmitter(pi);
         const subject: AskEventSubject = { question, context: normalizedContext, options };

         if (rawOptions.length > 0 && options.length === 0) {
            throw new Error(
               `All ${rawOptions.length} option(s) were malformed, so nothing could be shown to the user. `
               + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
               + `Call ask_user again with corrected options.`,
            );
         }

         if (!ctx.hasUI || !ctx.ui) {
            const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
            const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
            const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
            const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
            throw new Error(
               `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}`,
            );
         }

         if (options.length === 0) {
            const prompt = normalizedContext ? `${question}\n\nContext:\n${normalizedContext}` : question;
            const answer = await whileBlocked(pi, () => ctx.ui.input(prompt, "Type your answer...", dialogOpts));
            const response = signal?.aborted ? null : createFreeformResponse(answer);

            if (!response) {
               events.cancelled(subject);
               return {
                  content: [{ type: "text", text: "User cancelled the question" }],
                  details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            events.answered(subject, response);
            return {
               content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
               details: { question, context: normalizedContext, options, response, cancelled: false } as AskToolDetails,
            };
         }

         onUpdate?.({
            content: [{ type: "text", text: "Waiting for user input..." }],
            details: { question, context: normalizedContext, options, response: null, cancelled: false },
         });

         const result = await whileBlocked(pi, () => runCustomPrompt<AskUIResult>(ctx.ui, {
            signal,
            timeout,
            displayMode: settings.displayMode,
            overlayToggle: settings.shortcuts.overlayToggle,
            fullscreenToggle: settings.shortcuts.fullscreenToggle,
            createComponent: (tui, theme, keybindings, complete) => new AskComponent(
               question,
               normalizedContext,
               options,
               allowMultiple,
               allowFreeform,
               allowComment,
               settings.displayMode,
               settings.singleSelectLayout,
               settings.contextExpanded,
               tui,
               theme,
               keybindings,
               settings.shortcuts,
               complete,
               preselectedIds,
            ),
            fallback: () => askViaDialogs(
               ctx.ui,
               question,
               normalizedContext,
               options,
               allowMultiple,
               allowFreeform,
               allowComment,
               dialogOpts,
               undefined,
               preselectedIds,
            ),
         }));

         if (signal?.aborted || result === null) {
            events.cancelled(subject);
            return {
               content: [{ type: "text", text: "User cancelled the question" }],
               details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
            };
         }

         events.answered(subject, result);
         return {
            content: [{ type: "text", text: `User answered: ${formatResponseSummary(result)}` }],
            details: {
               question,
               context: normalizedContext,
               options,
               response: result,
               cancelled: false,
            } as AskToolDetails,
         };
      },

      renderCall(args, theme) {
         if (Array.isArray(args.questions)) {
            const entries: unknown[] = args.questions;
            let text = theme.fg("toolTitle", theme.bold("ask_user "));
            text += theme.fg("muted", `${entries.length} questions`);
            if (typeof args.question === "string" && args.question.trim()) {
               text += theme.fg("text", ` · ${args.question.trim().replace(/\s+/g, " ")}`);
            }
            if (args.allowComment) {
               text += theme.fg("dim", " [optional comment]");
            }
            entries.forEach((entry, index) => {
               const record = (entry ?? {}) as { question?: unknown; options?: unknown; allowMultiple?: unknown };
               const question = typeof record.question === "string" ? record.question : "";
               const optionCount = Array.isArray(record.options) ? record.options.length : 0;
               const notes = [
                  optionCount > 0 ? `${optionCount} option(s)` : "",
                  record.allowMultiple ? "multi-select" : "",
               ].filter(Boolean).join(", ");
               text += "\n" + theme.fg("dim", `  ${index + 1}. ${question}${notes ? ` (${notes})` : ""}`);
            });
            return new Text(text, 0, 0);
         }

         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) => coerceOption(o)?.title ?? "<invalid>");
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme, context) {
         const details = result.details as ((AskToolDetails | AskBatchDetails) & { error?: string }) | undefined;

         if (details?.error || context?.isError) {
            const message = details?.error ?? (
               result.content
                  ?.map((part) => part.type === "text" ? part.text : "")
                  .join("\n")
                  .trim() || "ask_user failed"
            );
            return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.map((part) => part.type === "text" ? part.text : "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (details && isBatchDetails(details)) {
            return new Text(formatBatchResult(theme, details, options.expanded), 0, 0);
         }

         if (!details || details.cancelled || !details.response) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         const response = details.response;
         let text = theme.fg("success", "✓ ");
         if (response.kind === "freeform") {
            text += theme.fg("muted", "(wrote) ");
         }
         text += theme.fg("accent", formatResponseSummary(response));

         if (options.expanded) {
            text += "\n" + theme.fg("dim", `Q: ${details.question}`);
            if (details.context) {
               text += "\n" + theme.fg("dim", details.context);
            }

            if (isSelectionResponse(response) && details.options.length > 0) {
               text += formatOptionMarkers(theme, details.options, response);
            }
         }

         return new Text(text, 0, 0);
      },
   });
   // In Tern (with pi-tern), the card is drawn natively; pi's renderers above serve every other terminal.
   registerTernTool(pi, "ask_user", askToolCard);
}
