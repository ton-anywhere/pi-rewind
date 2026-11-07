/**
 * pi-rewind — Checkpoint picker
 *
 * The rewind screen. A custom select list (not `ctx.ui.select`, which cannot
 * show extra key hints) whose footer advertises `alt+shift+c`, the same
 * "copy prompt" chord as the omp composer. Copying writes OSC 52 — the escape
 * sequence the host's own clipboard helper emits — so it reaches the terminal
 * clipboard directly, including over SSH.
 *
 * Renders raw lines and takes `theme`/`keybindings` from `ctx.ui.custom`, so
 * this module has no runtime host imports and stays unit-testable.
 */

/** Rows of checkpoints shown at once; the window follows the selection. */
const MAX_VISIBLE = 12;
/** pi's own OSC 52 guard: longer base64 payloads are dropped by terminals. */
const MAX_OSC52_ENCODED = 100_000;
const FLASH_MS = 1500;

/**
 * alt+shift+c as terminals encode it: legacy ESC+C, Kitty CSI-u, modifyOtherKeys.
 * Modifier bits are 1 + shift(1) + alt(2) = 4, so plain alt+c (3) does not match.
 */
const ALT_SHIFT_C = /^(?:\x1bC|\x1b\[(?:99|67)(?::\d+)?;4u|\x1b\[27;4;(?:99|67)~)$/;

type Theme = { fg(color: string, text: string): string };
type Keybindings = {
  matches?(data: string, binding: string): boolean;
  getKeys?(binding: string): string[];
};

export type PickerComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
};

export type PickerParams = {
  title: string;
  items: string[];
  /** Prompt behind the item at `index`, or undefined when there is none (e.g. the undo row). */
  copyText(index: number): string | undefined;
  theme: Theme;
  keybindings: Keybindings;
  requestRender(): void;
  done(index?: number): void;
};

/** Context slice the picker needs; narrower than the host's context type. */
export type PickerCtx = {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    custom?(factory: unknown): Promise<unknown>;
  };
};

/**
 * Full user prompt that a checkpoint was taken from: the last user message at
 * or before `timestamp` on the active branch.
 */
export function promptAt(branch: readonly unknown[], timestamp: number): string | undefined {
  let bestText: string | undefined;
  let bestTs = -Infinity;
  for (const raw of branch) {
    const entry = raw as
      | { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } }
      | null
      | undefined;
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(ts) || ts > timestamp || ts < bestTs) continue;
    const text = messageText(entry.message.content);
    if (text === undefined) continue;
    bestTs = ts;
    bestText = text;
  }
  return bestText;
}

/** Text of a user message; content is a string or an array of parts. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    const candidate = part as { type?: string; text?: unknown } | null | undefined;
    if (candidate?.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  const text = parts.join("\n");
  return text.trim() ? text : undefined;
}

/**
 * True for a copy request: whatever the host binds to copy-prompt/copy-message,
 * or alt+shift+c itself on hosts that do not bind it (pi binds ctrl+x instead).
 */
export function isCopyKey(data: string, keybindings?: Keybindings): boolean {
  const matches = keybindings?.matches;
  if (
    typeof matches === "function" &&
    (matches.call(keybindings, data, "app.clipboard.copyPrompt") ||
      matches.call(keybindings, data, "app.message.copy"))
  ) {
    return true;
  }
  return ALT_SHIFT_C.test(data);
}

/** shortcut: OSC 52 only; terminals with clipboard writes disabled need a native fallback. */
export function writeOsc52(text: string): boolean {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED) return false;
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

/** Display label for the copy chord, honoring a host remap when it exposes one. */
export function copyKeyLabel(keybindings: Keybindings): string {
  const getKeys = keybindings.getKeys;
  const keys = typeof getKeys === "function" ? getKeys.call(keybindings, "app.clipboard.copyPrompt") : [];
  return keys.length > 0 ? keys.join("/") : "alt+shift+c";
}

export function createPickerComponent(params: PickerParams): PickerComponent {
  const { title, items, copyText, theme, keybindings, requestRender, done } = params;
  // Bound: the host theme's `fg` reads private fields through `this`.
  const fg = theme.fg.bind(theme);
  const copyLabel = copyKeyLabel(keybindings);
  let selected = 0;
  let flash: string | undefined;
  let flashTimer: NodeJS.Timeout | undefined;

  const hintSegments: readonly HintSegment[] = [
    { color: "dim", text: "↑↓" },
    { color: "muted", text: " navigate  " },
    { color: "dim", text: "enter" },
    { color: "muted", text: " select  " },
    { color: "dim", text: copyLabel },
    { color: "muted", text: " copy prompt  " },
    { color: "dim", text: "esc" },
    { color: "muted", text: " cancel" },
  ];

  let finished = false;

  // Done may arrive without a later dispose(); clear the flash here too.
  const finish = (index?: number): void => {
    if (finished) return;
    finished = true;
    clearTimeout(flashTimer);
    flashTimer = undefined;
    done(index);
  };

  const showFlash = (message: string): void => {
    if (finished) return;
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = undefined;
      requestRender();
    }, FLASH_MS);
    requestRender();
  };

  const copySelected = (): void => {
    if (finished) return;
    const text = copyText(selected);
    if (!text) {
      showFlash("Nothing to copy");
      return;
    }
    showFlash(writeOsc52(text) ? "Copied prompt to clipboard" : "Prompt too large to copy");
  };

  return {
    render(width: number): string[] {
      const border = fg("border", "─".repeat(Math.max(1, width)));
      // The fixed 3-column row prefix cannot fit below 4 columns.
      if (width < 4) return [border];
      const start = windowStart(selected, items.length, MAX_VISIBLE);
      const lines = [border, " " + fg("accent", clamp(title, width - 2)), ""];
      for (let i = start; i < Math.min(items.length, start + MAX_VISIBLE); i++) {
        const label = clamp(items[i]!, width - 3);
        lines.push(i === selected ? " " + fg("accent", "→ ") + fg("accent", label) : "   " + fg("text", label));
      }
      lines.push("", " " + (flash ? fg("success", clamp(flash, width - 2)) : paintHint(fg, hintSegments, width - 2)), border);
      return lines;
    },

    handleInput(data: string): void {
      if (isCopyKey(data, keybindings)) {
        copySelected();
        return;
      }
      if (keybindings.matches?.(data, "tui.select.up") || data === "k") {
        selected = Math.max(0, selected - 1);
        requestRender();
        return;
      }
      if (keybindings.matches?.(data, "tui.select.down") || data === "j") {
        selected = Math.min(items.length - 1, selected + 1);
        requestRender();
        return;
      }
      if (keybindings.matches?.(data, "tui.select.confirm") || data === "\r" || data === "\n") {
        finish(selected);
        return;
      }
      if (keybindings.matches?.(data, "tui.select.cancel") || data === "\x1b" || data === "\x03") {
        finish(undefined);
      }
    },

    invalidate(): void {},

    dispose(): void {
      clearTimeout(flashTimer);
    },
  };
}

/**
 * Pick an item index. Uses `ctx.ui.custom` so the copy hint can live in the
 * footer; falls back to plain `ctx.ui.select` on hosts without it.
 */
export async function pickCheckpoint(
  ctx: PickerCtx,
  title: string,
  items: string[],
  copyText: (index: number) => string | undefined,
): Promise<number | undefined> {
  if (typeof ctx.ui.custom !== "function") {
    const choice = await ctx.ui.select(title, items);
    const index = choice === undefined ? -1 : items.indexOf(choice);
    return index >= 0 ? index : undefined;
  }

  const factory = (
    tui: { requestRender(): void },
    theme: Theme,
    keybindings: Keybindings,
    done: (index?: number) => void,
  ) => createPickerComponent({ title, items, copyText, theme, keybindings, requestRender: () => tui.requestRender(), done });

  const result = await ctx.ui.custom(factory);
  return typeof result === "number" ? result : undefined;
}

export type HintSegment = { color: string; text: string };

/** Paint hint segments, cutting the hint at the budget so the row fits `max`. */
export function paintHint(
  fg: (color: string, text: string) => string,
  segments: readonly HintSegment[],
  max: number,
): string {
  const total = segments.reduce((length, segment) => length + segment.text.length, 0);
  if (total <= max) return segments.map(segment => fg(segment.color, segment.text)).join("");
  let budget = Math.max(0, max - 1);
  let out = "";
  for (const segment of segments) {
    if (budget === 0) break;
    const part = segment.text.slice(0, budget);
    out += fg(segment.color, part);
    budget -= part.length;
  }
  return out + fg("muted", "…");
}

/** First visible row, centering the selection until the list ends. */
function windowStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(selected - half, total - size));
}

/** Terminal columns a code point occupies: 2 for CJK, Hangul, fullwidth forms and emoji. */
function charWidth(code: number): number {
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
    ? 2
    : 1;
}

/** Clamp to `max` terminal columns, ellipsizing. Emoji sequences still count per code point. */
export function clamp(raw: string, max: number): string {
  if (max <= 0) return "";
  // A control character would break the row: a pasted prompt can carry newlines or tabs.
  const text = raw.replace(/[\r\n\t]+/g, " ");
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0)!);
  if (width <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = charWidth(char.codePointAt(0)!);
    if (used + size > max - 1) break;
    out += char;
    used += size;
  }
  return out + "…";
}
