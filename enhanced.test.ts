/**
 * Tests for the enhanced build (fixes 1–11 on top of upstream 0.17.2).
 * Uses the real pi-tui (key parsing, wrapping) and a plain theme; only the Pi
 * host package is stubbed, since its bundle can't load outside Pi.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

mock.module("@earendil-works/pi-coding-agent", () => ({
   getMarkdownTheme: () => {
      throw new Error("no theme in tests");
   },
}));

const KEY = {
   up: "\x1b[A",
   down: "\x1b[B",
   enter: "\r",
   esc: "\x1b",
   space: " ",
   backspace: "\x7f",
   pageDown: "\x1b[6~",
   pageUp: "\x1b[5~",
   altM: "\x1bm",
   altO: "\x1bo",
   ctrlE: "\x05",
};

const plainTheme = {
   fg: (_c: string, t: string) => t,
   bg: (_c: string, t: string) => t,
   bold: (t: string) => t,
   italic: (t: string) => t,
   underline: (t: string) => t,
   inverse: (t: string) => t,
   strikethrough: (t: string) => t,
};

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

interface Session {
   component: any;
   render(): string[];
   text(): string;
   find(fragment: string): { x: number; y: number };
   keys(...data: string[]): void;
   type(text: string): void;
   mouse(event: Record<string, unknown>): any;
   click(fragment: string, dx?: number, clickCount?: number): void;
}

interface Run {
   result: any;
   session: Session;
   overlayOptions: any;
   listener?: (data: string) => any;
}

async function setupTool() {
   const { default: ext } = await import("./index");
   let tool: any;
   const events: Array<{ name: string; payload: any }> = [];
   ext({ registerTool: (t: any) => (tool = t), on() {}, events: { emit: (name: string, payload: any) => events.push({ name, payload }) } } as any);
   return { tool, events };
}

/** Run one ask_user call against an interactive host; `drive` acts on the open prompt. */
async function run(params: Record<string, unknown>, drive: (s: Session) => void, size = { cols: 120, rows: 40 }): Promise<Run> {
   const { tool } = await setupTool();
   let session!: Session;
   let overlayOptions: any;
   let listener: ((data: string) => any) | undefined;
   const ui = {
      custom: (factory: any, options: any) => new Promise((resolve) => {
         overlayOptions = options;
         const tui = { terminal: { rows: size.rows, columns: size.cols }, requestRender() {} };
         const component = factory(tui, plainTheme, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => resolve(value));
         const mode = options?.overlayOptions?.width === "100%" ? "full" : "box";
         const width = () => (overlayOptions?.overlayOptions?.width === "100%" || mode === "full" && !overlayOptions?.overlayOptions ? size.cols : Math.min(size.cols - 2, Math.max(40, Math.floor(size.cols * 0.92))));
         let frame: string[] = [];
         session = {
            component,
            render: () => (frame = component.render(width()).map(strip)),
            text: () => session.render().join("\n"),
            find(fragment) {
               session.render();
               for (let y = 0; y < frame.length; y++) {
                  const x = [...frame[y]!].join("").indexOf(fragment);
                  if (x >= 0) return { x: [...frame[y]!.slice(0, x)].length, y };
               }
               throw new Error(`"${fragment}" not on screen:\n${frame.join("\n")}`);
            },
            keys: (...data) => data.forEach((d) => component.handleInput(d)),
            type: (text) => [...text].forEach((ch) => component.handleInput(ch)),
            mouse: (event) => component.handleMouse({ button: "left", ...event }),
            click(fragment, dx = 0, clickCount = 1) {
               const { x, y } = session.find(fragment);
               session.mouse({ type: "press", x: x + dx, y });
               session.mouse({ type: "release", x: x + dx, y });
               session.mouse({ type: "click", x: x + dx, y, clickCount });
            },
         };
         session.render();
         drive(session);
         setTimeout(() => resolve(null), 0);
      }),
      onTerminalInput: (fn: (data: string) => any) => {
         listener = fn;
         return () => {};
      },
      notify() {},
   };
   const result = await tool.execute("id", params, undefined, () => {}, { hasUI: true, ui });
   return { result, session, overlayOptions, listener };
}

const hardening = {
   question: "Select the first-wave hardening items to implement now.",
   options: [
      { title: "Rate limiting", description: "Token-bucket limits at the gateway." },
      { title: "Audit logging", description: "Append-only log of security events." },
      { title: "Input schema validation" },
   ],
   allowMultiple: true,
};

const longText = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long description.`).join("\n");

// ── Fix 1: custom text in multi-select ─────────────────────────────────────

describe("Fix 1: multi-select custom text behaves like a checkbox", () => {
   test("text typed and abandoned with Esc is never sent", async () => {
      const { result } = await run(hardening, (s) => {
         s.keys(KEY.up, KEY.space); // custom-text row → editor
         s.type("never mind");
         s.keys(KEY.esc); // undo the edit
         s.keys(KEY.up, KEY.up, KEY.space); // tick Audit logging
         s.keys(KEY.enter);
      });
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Audit logging"] });
   });

   test("Enter in the editor saves the text and returns to the list; submit sends it with the ticks", async () => {
      let shown = "";
      const { result } = await run(hardening, (s) => {
         s.keys(KEY.up, KEY.space);
         s.type("include the dashboard");
         s.keys(KEY.enter); // save → back to the list
         shown = s.text();
         s.keys(KEY.down, KEY.space); // wrap to Rate limiting, tick it
         s.keys(KEY.enter);
      });
      expect(shown).toContain("[✓] ✎ “include the dashboard”");
      expect(shown).toContain("✓ will be sent");
      expect(result.details.response).toEqual({ kind: "combined", selections: ["Rate limiting"], text: "include the dashboard" });
   });

   test("Esc after editing saved text restores the saved text", async () => {
      const { result } = await run(hardening, (s) => {
         s.keys(KEY.up, KEY.space);
         s.type("keep JSON bodies");
         s.keys(KEY.enter);
         s.keys(KEY.space); // edit again
         for (let i = 0; i < 20; i++) s.keys(KEY.backspace);
         s.type("skip it");
         s.keys(KEY.esc); // undo this edit
         s.keys(KEY.down, KEY.space, KEY.enter);
      });
      expect(result.details.response.text).toBe("keep JSON bodies");
   });

   test("Backspace on the custom-text row removes the text", async () => {
      let shown = "";
      const { result } = await run(hardening, (s) => {
         s.keys(KEY.up, KEY.space);
         s.type("log exports at WARN");
         s.keys(KEY.enter, KEY.backspace);
         shown = s.text();
         s.keys(KEY.up, KEY.up, KEY.space, KEY.enter);
      });
      expect(shown).not.toContain("log exports at WARN");
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Audit logging"] });
   });

   test("saved text alone is sent as a custom answer", async () => {
      const { result } = await run(hardening, (s) => {
         s.keys(KEY.up, KEY.space);
         s.type("none of these yet");
         s.keys(KEY.enter);
         s.mouse({ type: "press", ...s.find("Submit") });
         s.mouse({ type: "click", ...s.find("Submit") });
      });
      expect(result.details.response).toEqual({ kind: "freeform", text: "none of these yet" });
   });

   test("the editor shows what is already ticked", async () => {
      let shown = "";
      await run(hardening, (s) => {
         s.keys(KEY.space, KEY.up, KEY.space);
         shown = s.text();
      });
      expect(shown).toContain("Your own text");
      expect(shown).toContain("Ticked so far: Rate limiting");
      expect(shown).toContain("esc undo this edit");
   });

   test("comments still follow the ticks, and the text is kept", async () => {
      const { result } = await run({ ...hardening, allowComment: true }, (s) => {
         s.keys(KEY.space); // tick Rate limiting
         s.keys(KEY.down, KEY.down, KEY.down, KEY.space); // comment toggle on
         s.keys(KEY.down, KEY.space);
         s.type("plus a dashboard");
         s.keys(KEY.enter); // save text
         s.keys(KEY.up, KEY.up, KEY.up, KEY.up, KEY.enter); // submit from an option row → comment step
         s.type("start Monday");
         s.keys(KEY.enter);
      });
      expect(result.details.response).toEqual({ kind: "combined", selections: ["Rate limiting"], text: "plus a dashboard", comment: "start Monday" });
   });

   test("single-select custom text is unchanged: Enter submits it", async () => {
      const { result } = await run({ question: "Pick", options: ["A", "B"] }, (s) => {
         s.keys(KEY.down, KEY.down, KEY.enter);
         s.type("something else");
         s.keys(KEY.enter);
      });
      expect(result.details.response).toEqual({ kind: "freeform", text: "something else" });
   });
});

// ── Fix 2: PgUp/PgDn ───────────────────────────────────────────────────────

describe("Fix 2: PgUp/PgDn scroll the preview only when it overflows", () => {
   const context = Array.from({ length: 40 }, (_, i) => `context line ${i + 1}`).join("\n");

   test("a short description leaves PgDn to the question", async () => {
      let before = "";
      let after = "";
      let help = "";
      await run({ question: "Pick", context, options: [{ title: "A", description: "short" }, { title: "B" }] }, (s) => {
         s.keys(KEY.ctrlE);
         before = s.text();
         s.keys(KEY.pageDown);
         after = s.text();
         help = after;
      });
      expect(before).toMatch(/context line 1 /);
      expect(after).not.toMatch(/context line 1 /);
      expect(help).toContain("PgUp/PgDn prompt");
   });

   test("a long description takes PgDn and says so in the help line", async () => {
      let before = "";
      let after = "";
      await run({ question: "Pick", options: [{ title: "Long", description: longText }, { title: "B" }] }, (s) => {
         before = s.text();
         s.keys(KEY.pageDown);
         after = s.text();
      });
      expect(before).toContain("PgUp/PgDn preview");
      expect(before).toContain("Line 1 of");
      expect(after).not.toContain("Line 1 of");
   });
});

// ── Fix 3: headless fallback ───────────────────────────────────────────────

describe("Fix 3: dialog fallback for multi-select", () => {
   async function headless(params: Record<string, unknown>, answers: Array<string | undefined>) {
      const { tool } = await setupTool();
      const prompts: string[] = [];
      const ui = {
         custom: async () => undefined,
         select: async () => undefined,
         input: async (title: string) => {
            prompts.push(title);
            return answers.shift();
         },
      };
      const result = await tool.execute("id", params, undefined, () => {}, { hasUI: true, ui });
      return { result, prompts };
   }

   test("a typo asks again, quoting what was typed, instead of failing", async () => {
      const { result, prompts } = await headless(hardening, ["Rate limiting, Auditt", "1, 2"]);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('You typed "Rate limiting, Auditt". "Auditt" isn\'t an option. Use numbers 1–4.');
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Rate limiting", "Audit logging"] });
   });

   test("custom text has its own number and opens a text box only when chosen", async () => {
      const { result, prompts } = await headless(hardening, ["2, 4", "with retention notes"]);
      expect(prompts[0]).toContain("4. ✏️ Type something (add your own text)");
      expect(prompts[1]).toContain("Selected: Audit logging");
      expect(result.details.response).toEqual({ kind: "combined", selections: ["Audit logging"], text: "with retention notes" });
   });

   test("no extra text box when custom text isn't chosen", async () => {
      const { prompts } = await headless(hardening, ["1"]);
      expect(prompts).toHaveLength(1);
   });

   test("an empty answer keeps preselected options", async () => {
      const { result } = await headless({
         ...hardening,
         options: hardening.options.map((o, i) => ({ ...o, id: i + 1 })),
         preselectedIds: [3],
      }, [""]);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Input schema validation"], selectedIds: [3] });
   });

   test("single-select keeps plain titles, numbering them only when titles repeat", async () => {
      const { tool } = await setupTool();
      let items: string[] = [];
      await tool.execute("id", { question: "Pick", options: ["Same", "Same", "Other"], allowFreeform: false }, undefined, () => {}, {
         hasUI: true,
         ui: { custom: async () => undefined, select: async (_t: string, list: string[]) => { items = list; return list[1]; }, input: async () => undefined },
      });
      expect(items).toEqual(["1. Same", "2. Same", "3. Other"]);
   });
});

// ── Fix 4: fullscreen key ──────────────────────────────────────────────────

describe("Fix 4: Alt+M switches fullscreen", () => {
   test("alt+m (legacy ESC m) resizes the overlay and restores it", async () => {
      let help = "";
      const { overlayOptions, listener } = await run({ question: "Pick", options: ["A", "B"] }, (s) => {
         help = s.text();
      });
      expect(help).toContain("alt+m fullscreen");
      expect(listener?.(KEY.altM)).toEqual({ consume: true });
      expect(overlayOptions.overlayOptions.maxHeight).toBe("100%");
      expect(overlayOptions.overlayOptions.width).toBe("100%");
      listener?.(KEY.altM);
      expect(overlayOptions.overlayOptions.maxHeight).toBe("85%");
   });

   test("the key is configurable and can be turned off", async () => {
      const custom = await run({ question: "Pick", options: ["A"], fullscreenToggleKey: "f11" }, () => {});
      expect(custom.listener?.(KEY.altM)).toBeUndefined();
      expect(custom.listener?.("\x1b[23~")).toEqual({ consume: true });
      const off = await run({ question: "Pick", options: ["A"], fullscreenToggleKey: "off" }, () => {});
      expect(off.listener?.(KEY.altM)).toBeUndefined();
   });

   test("a fullscreen key that clashes with the hide key is dropped; hide still works", async () => {
      const { listener, overlayOptions } = await run({ question: "Pick", options: ["A"], fullscreenToggleKey: "alt+o" }, () => {});
      listener?.(KEY.altO);
      expect(overlayOptions.overlayOptions.maxHeight).toBe("85%");
   });

   test("env var and ask-user.json set the key", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ask-user-fs-"));
      writeFileSync(join(dir, "ask-user.json"), JSON.stringify({ fullscreenToggleKey: "alt+z" }));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      try {
         const fromFile = await run({ question: "Pick", options: ["A"] }, () => {});
         expect(fromFile.listener?.("\x1bz")).toEqual({ consume: true });
         process.env.PI_ASK_USER_FULLSCREEN_TOGGLE_KEY = "alt+y";
         const fromEnv = await run({ question: "Pick", options: ["A"] }, () => {});
         expect(fromEnv.listener?.("\x1bz")).toBeUndefined();
         expect(fromEnv.listener?.("\x1by")).toEqual({ consume: true });
      } finally {
         delete process.env.PI_ASK_USER_FULLSCREEN_TOGGLE_KEY;
         if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
         else process.env.PI_CODING_AGENT_DIR = previous;
      }
   });

   test("inline mode has no fullscreen key", async () => {
      const { listener } = await run({ question: "Pick", options: ["A"], displayMode: "inline" }, () => {});
      expect(listener).toBeUndefined();
   });
});

// ── Fix 5 and Fix 6 ────────────────────────────────────────────────────────

describe("Fix 5: multi-select custom-text preview wording", () => {
   test("the preview says the text goes alongside the ticked options", async () => {
      let shown = "";
      await run(hardening, (s) => {
         s.keys(KEY.up);
         shown = s.text();
      });
      expect(shown).toContain("alongside the checked options");
      expect(shown).not.toContain("instead of the listed options");
   });
});

describe("Fix 6: the Tern tool card shows combined answers", () => {
   test("ticks the chosen options and lists the custom text", async () => {
      const { askToolCard } = await import("./tern");
      const card = askToolCard({
         name: "ask_user",
         args: {},
         status: "done",
         result: {
            details: {
               question: "Pick",
               options: [{ title: "A" }, { title: "B" }],
               response: { kind: "combined", selections: ["B"], text: "also C", comment: "soon" },
               cancelled: false,
            },
         },
      });
      const flat = JSON.stringify(card);
      expect(flat).toContain('"role":"omp.tool.answer"');
      expect(flat).toContain("“also C”");
      expect(flat).toContain("soon");
   });
});

// ── Fix 8: preview and heights ─────────────────────────────────────────────

describe("Fix 8: compact preview and fit-to-content adaptive", () => {
   test("the preview has one header row: title, and the range only when it overflows", async () => {
      let shortShown = "";
      let longShown = "";
      await run({ question: "Pick", options: [{ title: "Short", description: "One line." }, { title: "Long", description: longText }] }, (s) => {
         shortShown = s.text();
         s.keys(KEY.down);
         longShown = s.text();
      });
      expect(shortShown).not.toContain("Preview 1/");
      expect(shortShown).not.toMatch(/\d+–\d+ \/ \d+/);
      expect(longShown).toMatch(/Long\s+1–\d+ \/ 30/);
      expect(longShown).toMatch(/↓ \d+/);
      expect(longShown).not.toContain("Scroll ");
   });

   test("adaptive keeps one height while moving between options", async () => {
      const heights: number[] = [];
      await run({ question: "Pick", displayMode: "adaptive", options: [{ title: "Short", description: "x" }, { title: "Long", description: longText }, { title: "Mid", description: "a\nb\nc" }] }, (s) => {
         for (let i = 0; i < 4; i++) {
            heights.push(s.render().length);
            s.keys(KEY.down);
         }
      });
      expect(new Set(heights).size).toBe(1);
   });

   test("adaptive fits a yes/no question instead of filling 65%", async () => {
      let rows = 0;
      await run({ question: "Apply now?", displayMode: "adaptive", options: ["Yes", "No"] }, (s) => {
         rows = s.render().length;
      });
      expect(rows).toBeLessThan(Math.floor(40 * 0.65));
   });

   test("adaptive grows for a long description, up to 65% of the terminal", async () => {
      let rows = 0;
      await run({ question: "Pick", displayMode: "adaptive", options: [{ title: "Long", description: longText }, { title: "B" }] }, (s) => {
         rows = s.render().length;
      });
      expect(rows).toBe(Math.floor(40 * 0.65));
   });
});

// ── Fix 9: ID validation ───────────────────────────────────────────────────

describe("Fix 9: option IDs", () => {
   test("an empty preselectedIds array is treated as absent", async () => {
      const { result } = await run({ question: "Pick", options: ["A", "B"], preselectedIds: [] }, (s) => s.keys(KEY.enter));
      expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
   });

   test("partial ids still fail with a message that says how to fix the call", async () => {
      const { tool } = await setupTool();
      await expect(tool.execute("id", { question: "Pick", options: [{ id: 1, title: "A" }, { title: "B" }] }, undefined, () => {}, { hasUI: true, ui: {} }))
         .rejects.toThrow(/positive integer\. Give every option a unique positive integer id/);
   });

   test("preselected ids and selectedIds round-trip", async () => {
      const { result } = await run({ question: "Pick", allowMultiple: true, options: [{ id: 10, title: "A" }, { id: 20, title: "B" }], preselectedIds: [20] }, (s) => s.keys(KEY.enter));
      expect(result.details.response).toEqual({ kind: "selection", selections: ["B"], selectedIds: [20] });
   });

   test("a top-level preselectedIds next to questions is ignored, like upstream #88", async () => {
      const { tool } = await setupTool();
      const result = await tool.execute("id", {
         questions: [{ question: "One", options: ["A"] }, { question: "Two", options: ["B"] }],
         preselectedIds: [5],
      }, undefined, () => {}, { hasUI: true, ui: { custom: async () => null } });
      expect(result.details.cancelled).toBe(true);
   });
});

// ── Fix 11: visuals, mouse, narrow widths ──────────────────────────────────

describe("Fix 11: mouse", () => {
   test("click highlights, double-click chooses (single-select)", async () => {
      let shown = "";
      const { result } = await run({ question: "Pick", options: [{ title: "Alpha", description: "a" }, { title: "Beta", description: "b" }] }, (s) => {
         s.click("2. Beta");
         shown = s.text();
         s.click("2. Beta", 0, 2);
      });
      expect(shown).toContain("→ 2. Beta");
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
   });

   test("clicking a checkbox ticks it (multi-select)", async () => {
      const { result } = await run(hardening, (s) => {
         s.click("[ ] Audit", 1);
         s.keys(KEY.enter);
      });
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Audit logging"] });
   });

   test("the wheel scrolls the preview and moves the list", async () => {
      let scrolled = "";
      let moved = "";
      await run({ question: "Pick", options: [{ title: "Long", description: longText }, { title: "B", description: "b" }] }, (s) => {
         const at = s.find("Line 2 of");
         s.mouse({ type: "wheel", x: at.x, y: at.y, wheelDelta: 1 });
         scrolled = s.text();
         const row = s.find("1. Long");
         s.mouse({ type: "wheel", x: row.x, y: row.y, wheelDelta: 1 });
         moved = s.text();
      });
      expect(scrolled).not.toContain("Line 1 of");
      expect(moved).toContain("→ 2. B");
   });

   test("dragging the scrollbar thumb scrolls the description", async () => {
      let after = "";
      await run({ question: "Pick", options: [{ title: "Long", description: longText }, { title: "B" }] }, (s) => {
         const rail = s.find("█");
         const result = s.mouse({ type: "press", x: rail.x, y: rail.y });
         expect(result?.capture).toBe(true);
         s.mouse({ type: "drag", x: rail.x, y: rail.y + 5 });
         s.mouse({ type: "release", x: rail.x, y: rail.y + 5 });
         after = s.text();
      });
      expect(after).not.toContain("Line 1 of");
      expect(after).toMatch(/↑ \d+/);
   });

   test("action bar buttons act like their keys", async () => {
      const { result } = await run({ question: "Pick", options: ["A", "B"] }, (s) => {
         s.keys(KEY.down);
         s.click("Select");
      });
      expect(result.details.response).toEqual({ kind: "selection", selections: ["B"] });
      const cancelled = await run({ question: "Pick", options: ["A", "B"] }, (s) => s.click("Cancel"));
      expect(cancelled.result.details.cancelled).toBe(true);
   });

   test("batch prompts pass mouse events to the current question", async () => {
      const { result } = await run({ questions: [{ question: "One", options: ["A", "B"] }, { question: "Two", options: ["C", "D"] }] }, (s) => {
         s.click("2. B", 0, 1);
         s.click("2. B", 0, 2); // answers question one, moves to question two
         s.click("1. C", 0, 2);
         s.click("Submit");
      });
      expect(result.details.answers).toEqual([
         { status: "answered", response: { kind: "selection", selections: ["B"] } },
         { status: "answered", response: { kind: "selection", selections: ["C"] } },
      ]);
   });
});

describe("Fix 11: layouts by width", () => {
   const options = [{ title: "Alpha", description: "The alpha option." }, { title: "Beta", description: "The beta option." }];

   test("wide: split pane", async () => {
      let shown = "";
      await run({ question: "Pick", options }, (s) => (shown = s.text()), { cols: 120, rows: 40 });
      expect(shown).toContain(" │ Alpha");
   });

   test("60–83 columns: list with a detail strip", async () => {
      let shown = "";
      await run({ question: "Pick", options }, (s) => (shown = s.text()), { cols: 80, rows: 30 });
      expect(shown).toContain("╌╌╌");
      expect(shown).not.toContain(" │ Alpha");
   });

   test("under 60 columns: the focused option expands in place", async () => {
      let first = "";
      let second = "";
      await run({ question: "Pick", options }, (s) => {
         first = s.text();
         s.keys(KEY.down);
         second = s.text();
      }, { cols: 52, rows: 30 });
      expect(first).toContain("The alpha option.");
      expect(first).not.toContain("The beta option.");
      expect(second).toContain("The beta option.");
      expect(second).not.toContain("The alpha option.");
   });

   test("narrow widths keep the plain list when no option has a description", async () => {
      let shown = "";
      await run({ question: "Pick", options: ["Alpha", "Beta"] }, (s) => (shown = s.text()), { cols: 52, rows: 30 });
      expect(shown).not.toContain("No description");
      expect(shown).toContain("1. Alpha");
   });
});

describe("Fix 10: version", () => {
   test("the frame shows the enhanced version", async () => {
      let shown = "";
      await run({ question: "Pick", options: ["A"] }, (s) => (shown = s.text()));
      expect(shown).toContain("v0.17.2-enhanced.1.2.0");
   });
});
