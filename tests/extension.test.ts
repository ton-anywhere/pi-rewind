import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Load the extension against a mock host. omp injects `logger`; pi does not. */
function setup(ompShaped: boolean) {
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const commandHandlers = new Map<string, Handler>();
  const pi: Record<string, unknown> = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: Handler }) {
      commands.push(name);
      commandHandlers.set(name, options.handler);
    },
    registerShortcut(key: string) {
      shortcuts.push(key);
    },
  };
  if (ompShaped) pi.logger = {};
  extension(pi as never);
  return { handlers, commands, shortcuts, commandHandlers };
}

function makeCtx(
  cwd: string,
  select: (title: string, options: string[]) => string | undefined,
  hooks: { customKeys?: string[]; confirm?: () => boolean; branch?: unknown[] } = {},
) {
  const theme = { fg: (_color: string, text: string) => text };
  return {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => select(title, options),
      confirm: async () => hooks.confirm?.() ?? true,
      // Drive the custom rewind picker: mount it, then feed the given keys.
      custom: (factory: unknown) => {
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        // A hung picker must fail the test, not let Node exit 0 unwatched; a
        // settle cancels the guard so async key feeds stay legal.
        const unsettled = setImmediate(() => reject(new Error("rewind picker never settled")));
        const settle = (index?: number) => {
          clearImmediate(unsettled);
          resolve(index);
        };
        const component = (
          factory as (
            tui: { requestRender(): void },
            theme: typeof theme,
            keybindings: unknown,
            done: (index?: number) => void,
          ) => { handleInput(data: string): void }
        )({ requestRender() {} }, theme, { matches: () => false }, settle);
        for (const key of hooks.customKeys ?? []) component.handleInput(key);
        return promise;
      },
      notify() {},
      setStatus() {},
      clearStatus() {},
      theme,
    },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => hooks.branch ?? [],
      getEntry: () => ({ timestamp: new Date().toISOString() }),
    },
  };
}

async function main(): Promise<void> {
  // ---- omp-shaped host: handlers registered, tree prompt deferred ----
  const omp = setup(true);
  assert.deepEqual(omp.commands.sort(), ["rewind", "rw"]);
  assert.deepEqual(omp.shortcuts, ["escape escape"]);
  for (const event of [
    "session_start",
    "session_switch",
    "session_before_fork",
    "session_before_branch",
    "session_before_tree",
    "session_tree",
  ]) {
    assert.ok(omp.handlers.has(event), `missing ${event} handler`);
  }

  const nonGitCtx = makeCtx("/tmp/pi-rewind-extension-test-non-git", () => undefined);
  for (const event of ["startup", "fork"] as const) {
    await omp.handlers.get("session_start")!({ reason: event }, nonGitCtx);
  }
  for (const reason of ["resume", "fork"] as const) {
    await omp.handlers.get("session_switch")!({ reason }, nonGitCtx);
  }
  await omp.handlers.get("session_before_fork")!({ entryId: "test-entry" }, nonGitCtx);
  await omp.handlers.get("session_before_branch")!({ entryId: "test-entry" }, nonGitCtx);
  const deferred = await omp.handlers.get("session_before_tree")!({ preparation: { targetId: "test-entry" } }, nonGitCtx);
  assert.equal(deferred, undefined, "omp must not prompt inside session_before_tree");
  await omp.handlers.get("session_tree")!({}, nonGitCtx);
  // The deferred prompt timer is still pending; node keeps the process alive
  // until it fires, so nothing is asserted against a slept duration.

  // ---- Pi host: pre-navigation prompt can cancel the navigation ----
  const repo = mkdtempSync(join(tmpdir(), "pi-rewind-ext-"));
  try {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    g("init", "-q");
    g("config", "user.email", "test@test");
    g("config", "user.name", "test");
    writeFileSync(join(repo, "a.txt"), "one\n");
    g("add", ".");
    g("commit", "-qm", "init");

    const pi = setup(false);
    const prompts: string[][] = [];
    const piCtx = makeCtx(repo, (_title, options) => {
      prompts.push(options);
      return undefined; // dismissed prompt
    });

    await pi.handlers.get("session_start")!({ reason: "startup" }, piCtx);
    const result = await pi.handlers.get("session_before_tree")!(
      { preparation: { targetId: "test-entry" } },
      piCtx,
    );

    assert.deepEqual(result, { cancel: true }, "dismissing the Pi prompt must cancel navigation");
    assert.deepEqual(prompts, [
      ["Keep current files", "Restore files to that point", "Cancel navigation"],
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  // ---- rewind flow: undo row vs checkpoint rows map to the right target ----
  const flowRepo = mkdtempSync(join(tmpdir(), "pi-rewind-flow-"));
  try {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: flowRepo });
    g("init", "-q");
    g("config", "user.email", "test@test");
    g("config", "user.name", "test");
    writeFileSync(join(flowRepo, "a.txt"), "one\n");
    g("add", ".");
    g("commit", "-qm", "init");

    const flowPi = setup(false);
    const file = join(flowRepo, "a.txt");
    const rewind = flowPi.commandHandlers.get("rewind")!;
    const filesOnly = (title: string, options: string[]) =>
      options.find((option) => option.startsWith("Files only"));
    let branch: unknown[] = [];
    const ctxFor = (customKeys: string[]) => makeCtx(flowRepo, filesOnly, { customKeys, branch });
    const ctx = ctxFor(["\r"]);

    const firstPromptTs = new Date(Date.now() - 50).toISOString();
    await flowPi.handlers.get("session_start")!({ reason: "startup" }, ctx);
    branch = [
      { type: "message", timestamp: firstPromptTs, message: { role: "user", content: "first prompt" } },
      {
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "second prompt" },
      },
    ];
    writeFileSync(file, "two\n");
    await flowPi.handlers.get("before_agent_start")!({ prompt: "do the thing" }, ctx);
    await flowPi.handlers.get("tool_call")!({ toolName: "write", toolCallId: "t1", input: { path: "a.txt" } }, ctx);
    await flowPi.handlers.get("tool_execution_end")!({ toolName: "write", toolCallId: "t1" }, ctx);
    await flowPi.handlers.get("turn_end")!({ turnIndex: 1 }, ctx);

    writeFileSync(file, "three\n");
    await rewind("", ctx);
    assert.equal(readFileSync(file, "utf-8"), "two\n", "row 1 restores the newest checkpoint");

    writeFileSync(file, "four\n");
    const copies: string[] = [];
    const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
    const originalWrite = stdout.write;
    stdout.write = (chunk: unknown) => {
      copies.push(String(chunk));
      return true;
    };
    try {
      await rewind("", ctxFor(["j", "\x1bC", "\r"]));
    } finally {
      stdout.write = originalWrite;
    }
    assert.equal(
      readFileSync(file, "utf-8"),
      "two\n",
      "the row after the undo row still maps to checkpoints[0]",
    );
    assert.ok(
      copies.includes(`\x1b]52;c;${Buffer.from("second prompt").toString("base64")}\x07`),
      "copy uses the same undo-row offset as the restore target",
    );

    writeFileSync(file, "five\n");
    await rewind("", ctxFor(["\r"]));
    assert.equal(readFileSync(file, "utf-8"), "four\n", "undo restores the pre-rewind snapshot");
  } finally {
    rmSync(flowRepo, { recursive: true, force: true });
  }

  console.log("✅ extension smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
