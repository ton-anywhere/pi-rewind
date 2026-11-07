/**
 * pi-rewind — Experimental rewind command (`/re`)
 *
 * A fullscreen picker in the style of omp's native rewind selector. Kept in its
 * own module and its own command so it can be exercised without touching the
 * `/rewind`, `/rw` or `Esc+Esc` paths: no shared picker, no redo-stack writes,
 * files-only restore.
 *
 * Rendered as a custom overlay (`fullscreen` on hosts that support alt-screen
 * overlays) and drawn from raw rows, so it has no runtime host imports.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CheckpointData } from "./core.js";
import { createCheckpoint, diffCheckpoints, git, restoreCheckpoint } from "./core.js";
import type { RewindState } from "./state.js";
import {
  clamp,
  copyKeyLabel,
  isCopyKey,
  paintHint,
  promptAt,
  writeOsc52,
  type HintSegment,
} from "./picker.js";

const MAX_ROWS = 25;
const LIST_CAP = 12;
const PREVIEW_CAP = 200;

type Theme = { fg(color: string, text: string): string };
type Keybindings = {
  matches?(data: string, binding: string): boolean;
  getKeys?(binding: string): string[];
};

export type RewindRow = {
  /** 1-based position as shown to the user. */
  position: number;
  timestamp: number;
  label: string;
  description: string;
};

export type ExperimentalPicker = {
  rows: RewindRow[];
  /** Prompt behind the row at `index`, or undefined when it has none. */
  copyText(index: number): string | undefined;
  /** Diff of the checkpoint against HEAD; resolves to free-form text. */
  previewFor(index: number): Promise<string>;
  theme: Theme;
  keybindings: Keybindings;
  /** Terminal height in rows; read per render so resizes follow. */
  height(): number;
  requestRender(): void;
  done(index?: number): void;
};

export type ExperimentalComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
};

export type ExperimentalCtx = {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    custom?(factory: unknown, options?: unknown): Promise<unknown>;
    notify?(message: string, level?: "info" | "warning" | "error"): void;
  };
  sessionManager?: { getBranch?(): readonly unknown[] };
};

/** Compact row label: `#2 23:53:50 [main] "prompt" → write → a.ts`. */
export function buildRows(checkpoints: readonly CheckpointData[], currentBranch: string): RewindRow[] {
  return checkpoints.map((cp, index) => {
    const tag = cp.branch && currentBranch && cp.branch !== currentBranch ? ` ⚠ ${cp.branch}` : cp.branch ? ` [${cp.branch}]` : "";
    const description = cp.description ?? (cp.trigger === "resume" ? "Session start" : cp.trigger);
    const time = formatTime(cp.timestamp);
    return {
      position: index + 1,
      timestamp: cp.timestamp,
      description,
      label: `#${index + 1} ${time}${tag} ${description}`,
    };
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** First visible row, centered on the selection until the list ends. */
function windowStart(selected: number, total: number, size: number): number {
  if (total <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(selected - half, total - size));
}

export function createExperimentalPicker(params: ExperimentalPicker): ExperimentalComponent {
  const { rows, copyText, previewFor, theme, keybindings, height, requestRender, done } = params;
  // Bound: the host theme's `fg` reads private fields through `this`.
  const fg = theme.fg.bind(theme);
  const copyLabel = copyKeyLabel(keybindings);
  let selected = 0;
  let finished = false;
  let flash: string | undefined;
  let flashTimer: NodeJS.Timeout | undefined;
  const cache = new Map<number, string[]>();
  let preview: { index: number; lines: string[] } | undefined;

  const segments: readonly HintSegment[] = [
    { color: "dim", text: "↑↓" },
    { color: "muted", text: " step  " },
    { color: "dim", text: "enter" },
    { color: "muted", text: " rewind  " },
    { color: "dim", text: copyLabel },
    { color: "muted", text: " copy  " },
    { color: "dim", text: "esc" },
    { color: "muted", text: " cancel" },
  ];

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
    }, 1500);
    requestRender();
  };

  const loadPreview = (): void => {
    const index = selected;
    if (preview?.index === index) return;
    const cached = cache.get(index);
    if (cached) {
      preview = { index, lines: cached };
      return;
    }
    preview = { index, lines: ["  loading…"] };
    void previewFor(index)
      .then((text) => {
        const lines = text
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(0, PREVIEW_CAP);
        cache.set(index, lines);
        if (!finished && selected === index) {
          preview = { index, lines };
          requestRender();
        }
      })
      .catch(() => {
        cache.set(index, ["  (preview unavailable)"]);
        if (!finished && selected === index) {
          preview = { index, lines: cache.get(index)! };
          requestRender();
        }
      });
  };

  const move = (delta: number): void => {
    const next = Math.max(0, Math.min(rows.length - 1, selected + delta));
    if (next === selected) return;
    selected = next;
    loadPreview();
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

  const paintDiff = (line: string, max: number): string => {
    const text = clamp(line, max);
    if (text.startsWith("+++") || text.startsWith("---")) return fg("dim", text);
    if (text.startsWith("@@")) return fg("accent", text);
    if (text.startsWith("+")) return fg("success", text);
    if (text.startsWith("-")) return fg("error", text);
    return fg("muted", text);
  };

  loadPreview();

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(16, width);
      const safeHeight = Math.max(10, height());
      const row = rows[selected];
      const border = fg("border", "─".repeat(safeWidth));
      const out: string[] = [border, titleLine(fg, safeWidth, selected, rows.length), ""];

      const previewRows = safeHeight >= 20 ? Math.max(4, Math.floor((safeHeight - 6) * 0.35)) : 0;
      const listRows = Math.min(LIST_CAP, Math.max(3, safeHeight - 5 - previewRows));
      const start = windowStart(selected, rows.length, listRows);
      for (let i = start; i < Math.min(rows.length, start + listRows); i++) {
        const label = clamp(rows[i]!.label, safeWidth - 3);
        out.push(i === selected ? fg("accent", " ❯ ") + fg("accent", label) : "   " + fg("text", label));
      }

      if (previewRows > 0 && row) {
        if (preview?.index === selected) {
          out.push(fg("dim", " " + clamp(`diff vs HEAD · ${row.description}`, safeWidth - 2)));
          const lines = preview.lines.slice(0, Math.max(0, previewRows - 1));
          for (const line of lines) out.push(" " + paintDiff(line, safeWidth - 2));
        } else {
          out.push(fg("dim", " …"));
        }
      }
      while (out.length < safeHeight - 2) out.push("");
      out.push(" " + (flash ? fg("success", clamp(flash, safeWidth - 2)) : paintHint(fg, segments, safeWidth - 2)));
      out.push(border);
      return out.length > safeHeight ? out.slice(0, safeHeight) : out;
    },

    handleInput(data: string): void {
      if (isCopyKey(data, keybindings)) {
        copySelected();
        return;
      }
      if (keybindings.matches?.(data, "tui.select.up") || data === "k") {
        move(-1);
        return;
      }
      if (keybindings.matches?.(data, "tui.select.down") || data === "j") {
        move(1);
        return;
      }
      if (keybindings.matches?.(data, "tui.select.pageUp") || data === "\x1b[5~") {
        move(-5);
        return;
      }
      if (keybindings.matches?.(data, "tui.select.pageDown") || data === "\x1b[6~") {
        move(5);
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

/** Title row: `↺ Rewind · experimental` on the left, `3/12` on the right. */
function titleLine(fg: (color: string, text: string) => string, width: number, selected: number, total: number): string {
  const left = " ↺ Rewind · experimental";
  const right = `${selected + 1}/${total} `;
  const pad = Math.max(1, width - left.length - right.length);
  return fg("accent", " ↺ ") + fg("text", "Rewind") + fg("dim", " · experimental") + " ".repeat(pad) + fg("dim", right);
}

/**
 * Pick a row in a fullscreen overlay. `fullscreen` is opt-in because only omp
 * supports alt-screen overlays; pi composites the same frame in place.
 */
export async function pickExperimental(
  ctx: ExperimentalCtx,
  options: {
    rows: RewindRow[];
    copyText(index: number): string | undefined;
    previewFor(index: number): Promise<string>;
    fullscreen: boolean;
  },
): Promise<number | undefined> {
  if (typeof ctx.ui.custom !== "function") {
    const labels = options.rows.map((row) => row.label);
    const choice = await ctx.ui.select("Rewind to checkpoint (/re):", labels);
    const index = choice === undefined ? -1 : labels.indexOf(choice);
    return index >= 0 ? index : undefined;
  }

  const factory = (tui: { terminal?: { rows?: number }; requestRender(): void }, theme: Theme, keybindings: Keybindings, done: (index?: number) => void) =>
    createExperimentalPicker({
      rows: options.rows,
      copyText: options.copyText,
      previewFor: options.previewFor,
      theme,
      keybindings,
      height: () => tui.terminal?.rows ?? process.stdout.rows ?? 30,
      requestRender: () => tui.requestRender(),
      done,
    });

  const overlayOptions: Record<string, unknown> = options.fullscreen
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true }
    : { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 };
  const result = await ctx.ui.custom(factory, { overlay: true, overlayOptions });
  return typeof result === "number" ? result : undefined;
}

/**
 * `/re` flow: fullscreen picker, files-only restore.
 *
 * Deliberately isolated from `runRewindFlow`: it never touches `state.redoStack`
 * (so `/rw`'s undo row is unaffected) and always writes its own safety
 * checkpoint ref first.
 */
export async function runExperimentalRewind(
  state: RewindState,
  ctx: ExperimentalCtx,
  options: { fullscreen: boolean },
): Promise<void> {
  const notify = (message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify?.(message, level);
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    notify("Experimental rewind not available (no git repo or session)", "warning");
    return;
  }

  const checkpoints = [...state.checkpoints.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_ROWS);
  if (checkpoints.length === 0) {
    notify("No checkpoints available", "warning");
    return;
  }

  const repoRoot = state.repoRoot;
  const currentBranch = await git("rev-parse --abbrev-ref HEAD", repoRoot).catch(() => "");
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const rows = buildRows(checkpoints, currentBranch);

  const index = await pickExperimental(ctx, {
    rows,
    copyText: (row) => {
      const checkpoint = checkpoints[row];
      return checkpoint ? promptAt(branch, checkpoint.timestamp) : undefined;
    },
    previewFor: (row) => {
      const checkpoint = checkpoints[row];
      if (!checkpoint) return Promise.resolve("");
      return diffCheckpoints(repoRoot, checkpoint.worktreeTreeSha, "HEAD").catch(() => "");
    },
    fullscreen: options.fullscreen,
  });
  if (index === undefined) {
    notify("Experimental rewind cancelled");
    return;
  }
  const target = checkpoints[index];
  if (!target) return;

  const mode = await ctx.ui.select("Restore mode (/re):", ["Files only (keep conversation)", "Cancel"]);
  if (mode !== "Files only (keep conversation)") {
    notify("Experimental rewind cancelled");
    return;
  }

  try {
    await createCheckpoint({
      root: repoRoot,
      id: `before-re-${state.sessionId}-${Date.now()}`,
      sessionId: state.sessionId,
      trigger: "before-restore",
      turnIndex: 0,
      description: "before /re",
    });
  } catch {
    // Safety net is best effort; the restore still proceeds.
  }

  try {
    await restoreCheckpoint(repoRoot, target);
    notify(`Files rewound to checkpoint #${index + 1} (/re)`);
  } catch (error) {
    notify(`Restore failed: ${error instanceof Error ? error.message : error}`, "error");
  }
}

export function registerExperimentalCommand(pi: ExtensionAPI, state: RewindState, isOmp: boolean): void {
  pi.registerCommand("re", {
    description: "Experimental fullscreen rewind (files only)",
    handler: async (_args, ctx) => {
      await runExperimentalRewind(state, ctx as never, { fullscreen: isOmp });
    },
  });
}
