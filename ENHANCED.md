# pi-ask-user, enhanced build

This is [pi-ask-user](https://github.com/edlsh/pi-ask-user) 0.17.2 by Enzo Lucchesi (MIT license), with extra features and fixes.

| | |
|---|---|
| Version | `0.17.2-enhanced.1.3.0` (shown at the bottom of every prompt) |
| Upstream base | pi-ask-user 0.17.2 |
| Tested with | Pi 0.74.2, 1.0.2 and 1.5.0 |

Everything upstream documents in [README.md](README.md) still applies. This file covers what is different. The tool is still called `ask_user`, and it reads the same `ask-user.json` file and `PI_ASK_USER_*` environment variables, so it is a drop-in replacement.

## Install

Install it from a local folder (or your own git repository). Don't install `npm:pi-ask-user` alongside it: both register `ask_user`, and Pi reports a load error. Don't reinstall it from npm either, since that would replace it with upstream.

```fish
# Remove the npm copy if you have one
pi remove npm:pi-ask-user

# Install this folder (Pi loads local packages in place, and `pi update --extensions` leaves them alone)
pi install ~/pi-extensions/pi-ask-user
```

## What's different

### Display modes and the fullscreen key

`displayMode` accepts two more values, per call, in `PI_ASK_USER_DISPLAY_MODE` or in `ask-user.json`:

| Mode | Size |
|---|---|
| `overlay` (default) | Centered popup with an 8-row option area, as upstream |
| `inline` | In the conversation, as upstream |
| `adaptive` | Centered popup sized to fit the longest option description, never taller than 65% of the terminal. It keeps one height while you move between options or filter |
| `fullscreen` | The whole terminal |

While a popup is open, **Alt+M** switches between its size and fullscreen. Set another key with `fullscreenToggleKey` (per call), `PI_ASK_USER_FULLSCREEN_TOGGLE_KEY` or `fullscreenToggleKey` in `ask-user.json`; `"off"` turns it off. If it's the same as the hide or comment key, it's ignored. Alt+M works with or without the Kitty keyboard protocol.

### The option preview

The panel next to the options shows the highlighted option's description:

- One header row: the option's title, and the visible range (for example `1–7 / 17`) only when the text is longer than the panel.
- `↑ 3` and `↓ 10` at the edges show how many lines are hidden. A scrollbar appears only when the text overflows.
- **PgUp/PgDn** page through the description while it overflows. When it fits, they scroll the question and context instead, as upstream. The help line says which.
- **Alt+↑/↓** (or Alt+K/J) move one line, **Alt+Home/End** jump to the start or end.
- Links in descriptions are clickable in terminals that support them (Ghostty, WezTerm, kitty, iTerm2 and others).

### Look

Colors come from your Pi theme, so they follow it, and older or limited themes fall back to the plain look.

- The focused option row has the selection background, like Pi's own pickers.
- The preview sits on a tinted panel.
- The scrollbar moves in 1/8-row steps.
- A row of buttons above the key hints: Select or Submit, Cancel, and Fullscreen. It appears when there's room for two help rows.

### Mouse

In Pi's fullscreen interface (`tuiMode: "fullscreen"`, Pi's default) the prompt takes mouse input. Every action still has a key, and in `regular` mode the mouse stays with the terminal.

- Click an option to highlight it. Double-click chooses it (single-select) or ticks it (multi-select).
- Click a checkbox to tick it without moving the highlight.
- On your own text in multi-select, click the box to tick or untick it, the text to edit it, and "⌫ clear" to remove it.
- The wheel moves through the options over the list, and scrolls the description over the preview.
- Drag the scrollbar, or click above or below the thumb to jump a page.
- Click the buttons. In batches, clicks go to the current question, and the review page has Submit and Cancel buttons.

Ghostty doesn't show its link preview while Pi has the mouse; hold Shift+Ctrl to use Ghostty's own link handling.

### Narrow terminals

The option area changes layout with the prompt's inner width:

| Width | Layout |
|---|---|
| 84 columns or more | List on the left, preview on the right |
| 60–83 | List, then the highlighted option's description in a strip underneath |
| Under 60 | Only the highlighted option expands its description, in place |

When no option has a description there is nothing to preview, so narrow prompts keep upstream's plain list. `singleSelectLayout: "list"` keeps every description under its option at any width, for multi-select too. On short terminals, long context collapses to one line (Ctrl+E expands it) so the options stay visible.

### Your own text in multi-select

In a multi-select question, the "Type something" row works like one more checkbox. On the row, Space ticks, Enter submits and Backspace removes, the same as on the other rows.

- **Writing:** while the row is empty, Space, Enter, `e` or → opens the editor. The editor shows what is already ticked.
- **Enter in the editor** saves the text and returns to the list, where the row shows it ticked. It doesn't submit the prompt.
- **Esc in the editor** undoes that edit and keeps what was saved before. Text you type and then leave with Esc is never sent.
- **Space** on saved text ticks and unticks it. Unticked text stays on the row, dimmed, and the preview says "○ not sent". It isn't sent until you tick it again.
- **`e` or →** edits saved text, ticked or not. Saving an edit ticks it again.
- **Enter** on saved text submits the prompt, so you don't have to move up first.
- **Backspace** (or Delete) on the row removes the text for good.
- **Submit** sends the ticked options plus your text (if ticked) as a `combined` answer, or the text alone as a `freeform` answer when nothing else is ticked.

The help line changes while the row is highlighted to show these keys. In Tern's native card, tapping the row edits the text; the card shows whether it's ticked but can't untick it.

Single-select is unchanged: custom text replaces the choice and submits.

### Numbered options

Give every option a unique positive integer `id` to refer to options by number. Answers then include `selectedIds`, in the same order as `selections`. `preselectedIds` starts the prompt with options ticked (multi-select) or highlighted (single-select, one id at most).

```json
{
  "question": "Which checks should run before deploy?",
  "options": [
    { "id": 1, "title": "Unit tests" },
    { "id": 2, "title": "Integration tests", "description": "About 8 minutes" },
    { "id": 3, "title": "Security scan" }
  ],
  "allowMultiple": true,
  "preselectedIds": [1, 3]
}
```

- Once any option has an `id`, every option needs one, and ids must be unique. A call that breaks this fails with a message saying how to fix it.
- `preselectedIds: []` means nothing is preselected.
- In a batch, set `preselectedIds` on each question. A top-level `preselectedIds` next to `questions` is ignored, like the other per-question fields (upstream #88).

### Without the interactive UI (RPC and headless hosts)

Multi-select questions are asked in one text box with numbered options. When custom text is allowed, the list ends with one more entry, "✏️ Type something (add your own text)", and a second box opens only when you pick it. If what you type isn't a valid choice, the box asks again, quoting what you typed, instead of failing the tool call. Option numbers always work, and titles work when they're unique. An empty answer keeps the preselected options.

Single-select lists use plain titles, as upstream. They're numbered only when two options share a title.

## Settings

New and changed entries. Everything else is as in the README.

| `ask-user.json` | Environment variable | Per call | Default |
|---|---|---|---|
| `displayMode`: also `"adaptive"`, `"fullscreen"` | `PI_ASK_USER_DISPLAY_MODE` | `displayMode` | `"overlay"` |
| `fullscreenToggleKey` | `PI_ASK_USER_FULLSCREEN_TOGGLE_KEY` | `fullscreenToggleKey` | `"alt+m"` |

```fish
# ~/.config/fish/config.fish
set -gx PI_ASK_USER_DISPLAY_MODE adaptive
set -gx PI_ASK_USER_FULLSCREEN_TOGGLE_KEY alt+m
```

## Answers and events

Answers can have a third kind, and selections can carry ids:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; selectedIds?: number[]; comment?: string }
  | { kind: "combined"; selections: string[]; selectedIds?: number[]; text: string; comment?: string }
  | { kind: "freeform"; text: string };
```

`ask:answered` events report `kind: "combined"` for these answers. The tool card shows the ticked options and the text, in Tern too.

## Compatibility

- Pi 0.74.2, 1.0.2 and 1.5.0: typecheck, all 222 tests (upstream's 181 plus 41 for this build), upstream's host smoke test through Pi's real extension loader, and the README and skill examples against Pi's validator.
- Option ids are declared as whole numbers (`multipleOf: 1`) rather than with `Type.Integer`, so hosts with limited TypeBox shims still register the tool.
- Mouse support works in Pi 1.0.2 and 1.5.0. Pi 0.74 has no mouse input for extensions, so there everything works from the keyboard.

## Changelog

### enhanced 1.3.0 (on upstream 0.17.2)

- Your own text in multi-select is a real checkbox: Space or clicking the box ticks and unticks it, and unticked text stays on screen without being sent.
- Enter on your text row submits the prompt instead of opening the editor. `e`, → or clicking the text edits it; saving an edit ticks it again.
- The help line shows the right keys on that row. Before, it said "enter submit" while Enter opened the editor.

### enhanced 1.2.0 (on upstream 0.17.2)

- Rebased onto upstream 0.17.2 (top-level batch fields ignored instead of rejected, Tern prompt in the composer, wrapping by terminal columns).
- Multi-select custom text works like a checkbox; abandoned text is no longer sent.
- PgUp/PgDn scroll the question again when the description fits.
- Headless multi-select asks again on bad input, and opens the custom-text box only when chosen.
- Fullscreen key is configurable, defaults to Alt+M, works without the Kitty keyboard protocol, and appears in the help line.
- Fixed the multi-select preview's custom-text wording and a type error.
- `combined` answers show in the Tern tool card.
- Compact preview header; `adaptive` fits its content.
- `preselectedIds: []` is accepted.
- Highlight bar, tinted preview, smooth scrollbar, clickable links, mouse support, action bar, and strip and accordion layouts for narrow terminals.

### enhanced 1.1.3 (on upstream 0.17.0)

- `adaptive` and `fullscreen` display modes with a fullscreen key.
- Option ids, `preselectedIds` and `selectedIds`.
- Ticked options and custom text in one `combined` answer.
- Scrollable option preview, including for multi-select.
