import assert from "node:assert/strict";
import { createPickerComponent, isCopyKey, pickCheckpoint, promptAt } from "../src/picker.js";

const theme = { fg: (_color: string, text: string) => text };

/** Rows between the top border (0) and the bottom border (last). */
function body(lines: string[]): string[] {
  return lines.slice(1, -1);
}

/** The footer row, which carries the hint or a flash message. */
function footer(lines: string[]): string {
  return body(lines).at(-1) ?? "";
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

async function main(): Promise<void> {
  // ---- promptAt: last user prompt at or before the checkpoint ----
  const branch = [
    { type: "message", timestamp: "2026-01-01T10:00:00.000Z", message: { role: "user", content: "first prompt" } },
    { type: "message", timestamp: "2026-01-01T10:00:01.000Z", message: { role: "assistant", content: "reply" } },
    {
      type: "message",
      timestamp: "2026-01-01T10:05:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "text", text: "prompt" },
        ],
      },
    },
    { type: "message", timestamp: "2026-01-01T10:09:00.000Z", message: { role: "user", content: "later prompt" } },
  ];
  assert.equal(
    promptAt(branch, Date.parse("2026-01-01T10:06:00.000Z")),
    "second\nprompt",
    "takes the latest user prompt at or before the checkpoint, ignoring later ones",
  );
  assert.equal(promptAt(branch, Date.parse("2026-01-01T10:00:00.500Z")), "first prompt");
  assert.equal(promptAt(branch, Date.parse("2025-12-31T00:00:00.000Z")), undefined, "nothing before the first prompt");

  // ---- isCopyKey: alt+shift+c in every terminal encoding, plus host bindings ----
  assert.ok(isCopyKey("\x1bC"), "legacy ESC+C");
  assert.ok(isCopyKey("\x1b[99;4u"), "Kitty CSI-u");
  assert.ok(isCopyKey("\x1b[27;4;99~"), "modifyOtherKeys");
  const hostBindings = {
    matches: (data: string, binding: string) => binding === "app.clipboard.copyPrompt" && data === "\x18",
  };
  assert.ok(isCopyKey("\x18", hostBindings), "host copy-prompt binding");
  assert.ok(!isCopyKey("c", hostBindings), "plain c is not a copy");
  assert.ok(!isCopyKey("\x1b[B"), "arrow keys are not a copy");
  assert.ok(!isCopyKey("\x1b[99;3u"), "alt+c (Kitty) is not alt+shift+c");
  assert.ok(!isCopyKey("\x1b[27;3;99~"), "alt+c (modifyOtherKeys) is not alt+shift+c");

  // ---- picker: hint, navigation, copy, confirm, cancel ----
  const items = ['#1 [10:00:00] "first prompt"', '#2 [10:01:00] "second prompt"'];
  const prompts = ["first prompt", "second prompt"];
  const make = () => {
    const state = { doneWith: -1 as number | undefined, renders: 0 };
    const component = createPickerComponent({
      title: "Rewind to checkpoint:",
      items,
      copyText: (index) => prompts[index],
      theme,
      keybindings: {
        matches: (data: string, binding: string) => binding === "tui.select.down" && data === "\x1b[B",
      },
      requestRender: () => {
        state.renders += 1;
      },
      done: (index) => {
        state.doneWith = index;
      },
    });
    return { component, state };
  };

  const { component } = make();
  assert.match(footer(component.render(80)), /alt\+shift\+c copy prompt/, "footer advertises the copy chord");
  assert.match(body(component.render(80))[2] ?? "", /^ → #1/, "first row starts selected");

  component.handleInput("\x1b[B");
  assert.match(body(component.render(80))[3] ?? "", /^ → #2/, "down moves the selection");

  const copiedSecond = collectStdout(() => component.handleInput("\x1bC"));
  assert.equal(copiedSecond.writes.length, 1, "copy emits one OSC 52 sequence");
  assert.equal(
    copiedSecond.writes[0],
    `\x1b]52;c;${Buffer.from("second prompt").toString("base64")}\x07`,
    "copies the highlighted item's full prompt",
  );
  assert.match(footer(component.render(80)), /Copied prompt to clipboard/);

  component.handleInput("k");
  assert.match(body(component.render(80))[2] ?? "", /^ → #1/, "k moves back up");
  component.dispose();

  const { component: ending, state: endingState } = make();
  ending.handleInput("\r");
  assert.equal(endingState.doneWith, 0, "enter returns the highlighted index");

  const cancelling = make();
  cancelling.component.handleInput("\x1b");
  assert.equal(cancelling.state.doneWith, undefined, "esc cancels");

  const interrupt = make();
  interrupt.component.handleInput("\x03");
  assert.equal(interrupt.state.doneWith, undefined, "ctrl+c cancels");

  // Narrow terminal: no row may exceed the width it was rendered for.
  const narrow = make();
  for (const row of narrow.component.render(40)) {
    assert.ok(row.length <= 40, `row fits width 40: ${JSON.stringify(row)}`);
  }
  narrow.component.dispose();

  // More rows than fit: the window keeps the selected row visible.
  const many = Array.from({ length: 20 }, (_, index) => `#${index + 1} row`);
  const long = createPickerComponent({
    title: "Rewind to checkpoint:",
    items: many,
    copyText: () => undefined,
    theme,
    keybindings: { matches: () => false },
    requestRender() {},
    done() {},
  });
  for (let i = 0; i < 19; i++) long.handleInput("j");
  assert.ok(
    long.render(80).some((row) => row.includes("#20")),
    "the selected row stays visible past MAX_VISIBLE",
  );
  long.dispose();

  // Wide glyphs are clamped by terminal columns, not by UTF-16 length.
  const wide = createPickerComponent({
    title: "Rewind to checkpoint:",
    items: ["漢".repeat(30)],
    copyText: () => undefined,
    theme,
    keybindings: { matches: () => false },
    requestRender() {},
    done() {},
  });
  const wideRow = wide.render(20).find((row) => row.includes("漢")) ?? "";
  assert.ok(wideRow.includes("漢"), "the wide-glyph row is rendered");
  assert.ok(
    (wideRow.match(/漢/g) ?? []).length <= 8,
    `wide glyphs must not overflow a 20-column row: ${JSON.stringify(wideRow)}`,
  );
  wide.dispose();

  // Control characters in a label cannot split the row.
  const multiline = createPickerComponent({
    title: "Rewind to checkpoint:",
    items: ['#1 "fix\nthe bug"'],
    copyText: () => undefined,
    theme,
    keybindings: { matches: () => false },
    requestRender() {},
    done() {},
  });
  const multilineRow = multiline.render(80).find((row) => row.includes("fix")) ?? "";
  assert.ok(multilineRow.includes("fix the bug"), `newlines are flattened: ${JSON.stringify(multilineRow)}`);
  assert.ok(!multilineRow.includes("\n"), "no raw newline survives into a row");
  multiline.dispose();

  // The footer reverts to the hint after the flash expires.
  const flashing = make();
  collectStdout(() => flashing.component.handleInput("\x1bC"));
  assert.match(footer(flashing.component.render(80)), /Copied prompt to clipboard/);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.match(footer(flashing.component.render(80)), /copy prompt/, "hint returns after the flash expires");
  flashing.component.dispose();

  // Undo row and other prompt-less items copy nothing and say so.
  const promptless = createPickerComponent({
    title: "Rewind to checkpoint:",
    items: ["↩ Undo last rewind"],
    copyText: () => undefined,
    theme,
    keybindings: { matches: () => false },
    requestRender() {},
    done() {},
  });
  const nothing = collectStdout(() => promptless.handleInput("\x1bC"));
  assert.equal(nothing.writes.length, 0, "a prompt-less row writes nothing");
  assert.match(footer(promptless.render(80)), /Nothing to copy/);
  promptless.dispose();

  // An over-limit prompt is reported, not silently dropped.
  const oversized = createPickerComponent({
    title: "Rewind to checkpoint:",
    items: ["#1 huge"],
    copyText: () => "x".repeat(200_000),
    theme,
    keybindings: { matches: () => false },
    requestRender() {},
    done() {},
  });
  const tooLarge = collectStdout(() => oversized.handleInput("\x1bC"));
  assert.equal(tooLarge.writes.length, 0, "an over-limit prompt writes nothing");
  assert.match(footer(oversized.render(80)), /Prompt too large to copy/);
  oversized.dispose();

  // ---- pickCheckpoint: custom component path and select fallback ----
  const mounted = Promise.withResolvers<number | undefined>();
  const picked = await pickCheckpoint(
    {
      ui: {
        select: async () => undefined,
        custom: (factory: unknown) => {
          const component = (
            factory as (
              tui: { requestRender(): void },
              theme: typeof theme,
              kb: unknown,
              done: (i?: number) => void,
            ) => { handleInput(data: string): void }
          )({ requestRender() {} }, theme, { matches: () => false }, mounted.resolve);
          component.handleInput("\r");
          return mounted.promise;
        },
      },
    },
    "Rewind to checkpoint:",
    ["only"],
    () => undefined,
  );
  assert.equal(picked, 0, "custom picker returns the chosen index");

  const nonNumeric = await pickCheckpoint(
    { ui: { select: async () => undefined, custom: async () => null } } as never,
    "Rewind to checkpoint:",
    ["a"],
    () => undefined,
  );
  assert.equal(nonNumeric, undefined, "a non-numeric custom result is not a selection");

  const fallbackIndex = await pickCheckpoint(
    { ui: { select: async (_title: string, options: string[]) => options[1] } },
    "Rewind to checkpoint:",
    ["a", "b"],
    () => undefined,
  );
  assert.equal(fallbackIndex, 1, "falls back to ctx.ui.select when custom is unavailable");

  const dismissed = await pickCheckpoint(
    { ui: { select: async () => undefined } },
    "Rewind to checkpoint:",
    ["a", "b"],
    () => undefined,
  );
  assert.equal(dismissed, undefined, "dismissed select yields no index");

  console.log("✅ picker tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
