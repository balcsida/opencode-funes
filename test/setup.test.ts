import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The bundle where funes installs it, and its `setup` run as funes runs it: with the contract's
// environment and nothing else.
async function installed(extra: Record<string, string> = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-funes-setup-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const bundle = join(home, ".funes/agents/opencode");
  await cp(join(import.meta.dir, "../opencode"), bundle, { recursive: true });
  const funes = join(tmp, "fake funes");
  await writeFile(funes, "#!/bin/sh\n");
  await chmod(funes, 0o755);
  const env = { HOME: home, PATH: "/usr/bin:/bin", FUNES_BIN: funes, FUNES_HOME: join(home, ".funes"), FUNES_AGENT_ID: "opencode", ...extra };
  const setup = (...args: string[]) => Bun.spawnSync([join(bundle, "setup"), ...args], { env, stdout: "pipe", stderr: "pipe" }).exitCode;
  const record = (name: string) => readFile(join(bundle, name), "utf8");
  return { tmp, home, bundle, funes, setup, record, shim: join(home, ".config/opencode/plugins/funes.ts"), spool: join(home, ".funes/spool/opencode") };
}

test("add puts one plugin file where OpenCode loads it, exporting the plugin alone", async () => {
  const f = await installed();
  expect(f.setup("add")).toBe(0);
  const loaded = await import(f.shim);
  // OpenCode calls every export of a plugin file as a plugin.
  expect(Object.keys(loaded)).toEqual(["default"]);
  expect(typeof loaded.default).toBe("function");
});

test("add records the spool it created, the funes it was handed and the memory it was bound to", async () => {
  const f = await installed();
  expect(f.setup("add", "acme/kb")).toBe(0);
  expect(await f.record("spool")).toBe(f.spool + "\n");
  expect(existsSync(f.spool)).toBe(true);
  expect(await f.record("bin")).toBe(f.funes + "\n");
  expect(await f.record("memory")).toBe("acme/kb\n");
});

test("a funes named without its directory is recorded where PATH finds it", async () => {
  const bin = await mkdtemp(join(tmpdir(), "opencode-funes-bin-"));
  cleanups.push(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "funes"), "#!/bin/sh\n");
  await chmod(join(bin, "funes"), 0o755);
  const f = await installed({ FUNES_BIN: "funes", PATH: `${bin}:/usr/bin:/bin` });
  expect(f.setup("add")).toBe(0);
  expect(await f.record("bin")).toBe(join(bin, "funes") + "\n");
});

test("a re-run without a memory unbinds the one bound before", async () => {
  const f = await installed();
  expect(f.setup("add", "acme/kb")).toBe(0);
  expect(f.setup("add")).toBe(0);
  expect(existsSync(join(f.bundle, "memory"))).toBe(false);
});

test("add again forgets what was swept and keeps the seq each turn was given", async () => {
  const f = await installed();
  expect(f.setup("add")).toBe(0);
  await mkdir(join(f.bundle, "swept"));
  await writeFile(join(f.bundle, "swept/project"), "1000");
  await mkdir(join(f.bundle, "seq"));
  await writeFile(join(f.bundle, "seq/ses_one.json"), '["msg_001"]');
  expect(f.setup("add")).toBe(0);
  // History is converted anew, which is how a memory is rebuilt; funes drops what it holds.
  expect(existsSync(join(f.bundle, "swept"))).toBe(false);
  expect(await f.record("seq/ses_one.json")).toBe('["msg_001"]');
});

test("the plugin file follows XDG_CONFIG_HOME", async () => {
  const xdg = await mkdtemp(join(tmpdir(), "opencode-funes-xdg-"));
  cleanups.push(() => rm(xdg, { recursive: true, force: true }));
  const f = await installed({ XDG_CONFIG_HOME: xdg });
  expect(f.setup("add")).toBe(0);
  expect(existsSync(join(xdg, "opencode/plugins/funes.ts"))).toBe(true);
  expect(existsSync(f.shim)).toBe(false);
});

test("remove takes the plugin file, the spool and the records, and may be repeated", async () => {
  const f = await installed();
  expect(f.setup("add", "acme/kb")).toBe(0);
  await mkdir(join(f.bundle, "seq"));
  await mkdir(join(f.bundle, "swept"));
  await writeFile(join(f.bundle, "funes-sync.log"), "");
  expect(f.setup("remove")).toBe(0);
  for (const gone of [f.shim, f.spool, ...["spool", "bin", "memory", "seq", "swept", "funes-sync.log"].map(name => join(f.bundle, name))]) {
    expect(existsSync(gone)).toBe(false);
  }
  expect(f.setup("remove")).toBe(0);
});

test("a plugin file funes did not write is neither replaced nor removed", async () => {
  const f = await installed();
  await mkdir(join(f.home, ".config/opencode/plugins"), { recursive: true });
  await writeFile(f.shim, "export default async () => ({});\n");
  expect(f.setup("add")).not.toBe(0);
  expect(f.setup("remove")).toBe(0);
  expect(await readFile(f.shim, "utf8")).toBe("export default async () => ({});\n");
});

test("anything but add [MEMORY] or remove is a usage error", async () => {
  const f = await installed();
  expect(f.setup()).toBe(2);
  expect(f.setup("add", "acme/kb", "extra")).toBe(2);
  expect(f.setup("remove", "extra")).toBe(2);
  expect(existsSync(f.shim)).toBe(false);
});
