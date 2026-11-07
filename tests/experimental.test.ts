import assert from "node:assert/strict";
import { buildRows, createExperimentalPicker, pickExperimental, type RewindRow } from "../src/experimental.js";

const theme = { fg: (_color: string, text: string) => text };

function rows(count: number): RewindRow[] {
  return Array.from({ length: count }, (_, index) => ({
    position: index + 1,
    timestamp: Date.UTC(2026, 0, 1, 10, index),
    description: `prompt ${index + 1}`,
    label: `#${index + 1} 10:00:00 [main] prompt ${index + 1}`,
  }));
}

function make(list: RewindRow[], overrides: Partial<Parameters<typeof createExperimentalPicker>[0]> = {}) {
  const state = { doneWith: -1 as number | undefined, renders: 0 };
  const component = createExperimentalPicker({
    rows: list,
    copyText: (index) => `prompt ${index + 1}`,
    previewFor: async () => "",
    theme,
    keybindings: { matches: () => false },
    height: () => 24,
    requestRender: () => {
      state.renders += 1;
    },
    done: (index) => {
      state.doneWith = index;
    },
    ...overrides,
  });
  return { component, state };
}

function collectStdout<T>(run: () => T): { result: T; writes: string[] } {
  const writes: string[] = [];
  const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
  const original = stdout.write;
  stdout.write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    return { result: run(), writes };
  } finally {
    stdout.write = original;
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  // ---- buildRows: label carries position, branch and description ----
  const built = buildRows(
    [
      { id: "a", timestamp: Date.UTC(2026, 0, 1, 10, 0), sessionId: "s", trigger: "tool", description: "do it", worktreeTreeSha: "t", commitSha: "c", branch: "main" } as never,
      { id: "b", timestamp: Date.UTC(2026, 0, 1, 10, 1), sessionId: "s", trigger: "resume", worktreeTreeSha: "t", commitSha: "c", branch: "feature" } as never,
    ],
    "main",
  );
  assert.equal(built[0]!.label.includes("#1"), true, "first row is numbered");
  assert.equal(built[1]!.label.includes("⚠ feature"), true, "cross-branch rows are flagged");
  assert.equal(built[1]!.description, "Session start", "resume rows fall back to a readable description");

  // ---- fullscreen frame: title, position, hint bar, exact height ----
  const { component } = make(rows(3));
  const frame = component.render(80);
  assert.equal(frame.length, 24, "the frame fills the terminal height");
  assert.match(frame[1]!, /Rewind · experimental/, "title row names the screen");
  assert.match(frame[1]!, /1\/3/, "title row carries the position");
  assert.ok(frame.some((row) => row.includes("copy")), "hint bar advertises copy");
  assert.ok(frame.some((row) => row.includes("rewind")), "hint bar advertises rewind");
  assert.ok(frame.some((row) => row.startsWith(" ❯ ")), "selected row is marked");

  // ---- navigation: j/k, page keys, window follows the selection ----
  const nav = make(rows(20));
  nav.component.handleInput("j");
  assert.match(nav.component.render(80)[1]!, /2\/20/, "j steps forward");
  nav.component.handleInput("k");
  assert.match(nav.component.render(80)[1]!, /1\/20/, "k steps back");
  nav.component.handleInput("\x1b[6~");
  assert.match(nav.component.render(80)[1]!, /6\/20/, "page down jumps five rows");
  for (let i = 0; i < 14; i++) nav.component.handleInput("j");
  assert.ok(
    nav.component.render(80).some((row) => row.includes("prompt 20")),
    "the window follows the selection past the list cap",
  );
  nav.component.dispose();

  // ---- copy: OSC 52 payload for the highlighted row ----
  const copied = make(rows(3));
  const first = collectStdout(() => copied.component.handleInput("\x1bC"));
  assert.equal(first.writes.length, 1, "copy emits one OSC 52 sequence");
  assert.equal(first.writes[0], `\x1b]52;c;${Buffer.from("prompt 1").toString("base64")}\x07`);
  copied.component.dispose();

  const promptless = make(rows(1), { copyText: () => undefined });
  const empty = collectStdout(() => promptless.component.handleInput("\x1bC"));
  assert.equal(empty.writes.length, 0, "a row without a prompt writes nothing");
  assert.ok(promptless.component.render(80).some((row) => row.includes("Nothing to copy")));
  promptless.component.dispose();

  // ---- confirm / cancel ----
  const confirming = make(rows(2));
  confirming.component.handleInput("j");
  confirming.component.handleInput("\r");
  assert.equal(confirming.state.doneWith, 1, "enter returns the highlighted index");
  confirming.component.handleInput("\x1b");
  assert.equal(confirming.state.doneWith, 1, "a late esc cannot re-settle the picker");

  const cancelling = make(rows(2));
  cancelling.component.handleInput("\x03");
  assert.equal(cancelling.state.doneWith, undefined, "ctrl+c cancels");

  // ---- preview: async diff lands in the frame, then follows the selection ----
  const previewed = make(rows(2), {
    previewFor: async (index) => `--- a\n+++ b\n@@ -1 +1 @@\n-old ${index}\n+new ${index}`,
  });
  await tick();
  const previewFrame = previewed.component.render(80);
  assert.ok(previewFrame.some((row) => row.includes("diff vs HEAD")), "preview header names the diff");
  assert.ok(previewFrame.some((row) => row.includes("+new 0")), "preview shows diff additions");
  previewed.component.handleInput("j");
  await tick();
  assert.ok(previewed.component.render(80).some((row) => row.includes("+new 1")), "preview follows the selection");
  previewed.component.dispose();

  // ---- narrow terminal: no row overflows ----
  for (const row of component.render(40)) {
    assert.ok(row.length <= 40, `row fits width 40: ${JSON.stringify(row)}`);
  }

  // ---- fallback: hosts without custom() get the plain selector ----
  const fallback = await pickExperimental(
    { ui: { select: async (_title: string, options: string[]) => options[2] } },
    { rows: rows(4), copyText: () => undefined, previewFor: async () => "", fullscreen: false },
  );
  assert.equal(fallback, 2, "select fallback maps the chosen label back to its index");

  const dismissed = await pickExperimental(
    { ui: { select: async () => undefined } },
    { rows: rows(2), copyText: () => undefined, previewFor: async () => "", fullscreen: false },
  );
  assert.equal(dismissed, undefined, "dismissed selector yields no index");

  console.log("✅ experimental picker tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
