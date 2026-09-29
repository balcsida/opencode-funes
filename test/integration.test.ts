import { afterEach, expect, test } from "bun:test";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";
import type { Config, Plugin, PluginInput } from "@opencode-ai/plugin";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, emit, index, listSessions } from "../opencode/core";
import { messages, session } from "./fixtures";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out"); await Bun.sleep(20); }
}
const idle = (sessionID: string) => ({ event: { type: "session.idle" as const, properties: { sessionID } } });

// The bundle installed as funes installs it — copied under ~/.funes/agents, its real `setup add`
// run — against an OpenCode that serves `count` sessions and a funes that drains the spool the
// way `funes index --harness opencode` does: each turns file read whole, then deleted.
async function fixture(count = 1, { memory = "", setup = true } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-funes-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const directory = join(tmp, "project");
  const bundle = join(home, ".funes/agents/opencode");
  const spool = join(home, ".funes/spool/opencode");
  await cp(join(import.meta.dir, "../opencode"), bundle, { recursive: true });
  const binary = join(tmp, "fake funes");
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
const at = name => ${JSON.stringify(tmp)} + "/" + name;
const spool = ${JSON.stringify(spool)};
appendFileSync(at("attempts"), JSON.stringify({ args: process.argv.slice(2), files: readdirSync(spool).sort() }) + "\\n");
while (existsSync(at("hold"))) await Bun.sleep(10);
if (existsSync(at("fail"))) { unlinkSync(at("fail")); console.error("memory busy"); process.exit(1); }
for (const name of readdirSync(spool)) {
  appendFileSync(at("imported"), readFileSync(spool + "/" + name, "utf8"));
  unlinkSync(spool + "/" + name);
}
`);
  await chmod(binary, 0o755);
  let plugin: Plugin;
  if (setup) {
    const env = { HOME: home, PATH: "/usr/bin:/bin", FUNES_BIN: binary, FUNES_HOME: join(home, ".funes"), FUNES_AGENT_ID: "opencode" };
    const added = Bun.spawnSync([join(bundle, "setup"), "add", ...(memory ? [memory] : [])], { env, stdout: "pipe", stderr: "pipe" });
    if (added.exitCode !== 0) throw new Error(added.stderr.toString());
    plugin = (await import(join(home, ".config/opencode/plugins/funes.ts"))).default;
  } else {
    plugin = (await import(join(bundle, "plugin.ts"))).default;
  }

  const rows: Session[] = Array.from({ length: count }, (_, i) => ({ ...session, id: `ses_${i}`, directory }));
  const requests: URL[] = [];
  const headers: Array<string | null> = [];
  let current = structuredClone(messages);
  let saturated = false;
  let failList = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const url = new URL(req.url); requests.push(url); headers.push(req.headers.get("authorization"));
    if (url.pathname === "/session") {
      if (failList-- > 0) return Response.json({ error: "offline" }, { status: 503 });
      const limit = Number(url.searchParams.get("limit"));
      return Response.json(saturated ? Array.from({ length: limit }, (_, i) => ({ ...session, id: `ses_${i}` })) : rows.slice(0, limit));
    }
    if (url.pathname.endsWith("/message")) return Response.json(current);
    return Response.json(rows.find(row => url.pathname.endsWith(row.id)) ?? rows[0]);
  } });
  cleanups.push(() => server.stop(true));
  const client = createOpencodeClient({ baseUrl: server.url.toString(), headers: { Authorization: "Basic dGVzdDp0ZXN0" } });
  const input: PluginInput = { client, directory, worktree: directory, serverUrl: server.url,
    project: { id: "project", worktree: directory, time: { created: 1000 } },
    experimental_workspace: { register() {} }, $: Bun.$ };
  async function lines(name: string) { try { return (await readFile(join(tmp, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  async function start() {
    const hooks = await plugin(input);
    cleanups.push(() => hooks.dispose?.());
    return hooks;
  }
  return { tmp, directory, bundle, spool, binary, input, requests, headers, rows, lines, start,
    hold: () => writeFile(join(tmp, "hold"), ""), release: () => rm(join(tmp, "hold")), fail: () => writeFile(join(tmp, "fail"), ""),
    setMessages(value: typeof messages) { current = value; }, saturate() { saturated = true; }, failListing() { failList = 1; } };
}

test("real SDK grows snapshots beyond 100 tied timestamps and converts every session", async () => {
  const f = await fixture(106);
  const out = join(f.tmp, "out");
  expect(await backfill(f.input.client, f.directory, out)).toBe(106);
  expect(f.requests.filter(r => r.pathname === "/session").map(r => r.searchParams.get("limit"))).toEqual(["100", "200"]);
  expect(f.requests.every(r => r.searchParams.get("directory") === f.directory)).toBe(true);
  expect(f.requests.filter(r => r.pathname.endsWith("/message")).every(r => !r.searchParams.has("limit"))).toBe(true);
  expect((await readdir(out)).sort()).toEqual(f.rows.map(row => `${row.id}.funes.jsonl`).sort());
  expect(f.headers.every(h => h === "Basic dGVzdDp0ZXN0")).toBe(true);
}, 20000);

test("snapshot ceiling and HTTP failures are explicit", async () => {
  const f = await fixture();
  f.failListing();
  await expect(listSessions(f.input.client, f.directory)).rejects.toThrow();
  f.saturate();
  await expect(listSessions(f.input.client, f.directory)).rejects.toThrow("102400");
  expect(f.requests.at(-1)?.searchParams.get("limit")).toBe("102400");
});

test("an exactly full page grows again to prove completeness", async () => {
  const f = await fixture(100);
  expect(await listSessions(f.input.client, f.directory)).toHaveLength(100);
  expect(f.requests.map(r => r.searchParams.get("limit"))).toEqual(["100", "200"]);
});

test("a session is one turns file named from its id, one turn a line, stamped with the session's own time", async () => {
  const f = await fixture();
  expect(await emit(f.input.client, f.directory, "ses_0", f.spool)).toBe(true);
  expect(await readdir(f.spool)).toEqual(["ses_0.funes.jsonl"]);
  const file = join(f.spool, "ses_0.funes.jsonl");
  const body = await readFile(file, "utf8");
  expect(body.endsWith("\n")).toBe(true);
  expect(body.trim().split("\n").map(line => JSON.parse(line)).map(t => [t.session_id, t.turn_uuid, t.seq, t.harness])).toEqual([
    ["ses_0", "msg_001", 0, "opencode"], ["ses_0", "msg_002", 1, "opencode"],
  ]);
  expect((await stat(file)).mtimeMs).toBe(1000);
});

test("a session with nothing finished writes no file", async () => {
  const f = await fixture();
  f.setMessages([]);
  expect(await emit(f.input.client, f.directory, "ses_0", f.spool)).toBe(false);
  expect(await readdir(f.spool)).toEqual([]);
});

test("a write that cannot finish leaves nothing funes would list as a turns file", async () => {
  const f = await fixture();
  // A directory where the turns file goes: the rename over it fails, and what was written stays.
  await mkdir(join(f.spool, "ses_0.funes.jsonl", "in the way"), { recursive: true });
  await expect(emit(f.input.client, f.directory, "ses_0", f.spool)).rejects.toThrow();
  expect((await readdir(f.spool)).filter(name => name.endsWith(".jsonl"))).toEqual(["ses_0.funes.jsonl"]);
  expect(await readdir(f.spool)).toHaveLength(2);
});

test("a session id that cannot name a file is refused before anything is asked or written", async () => {
  const f = await fixture();
  await expect(emit(f.input.client, f.directory, "../escaped", f.spool)).rejects.toThrow("../escaped");
  expect(f.requests).toEqual([]);
  expect(existsSync(join(f.spool, "../escaped.funes.jsonl"))).toBe(false);
});

test("a failed funes index is reported with what funes said", async () => {
  const f = await fixture();
  await f.fail();
  await expect(index(f.binary)).rejects.toThrow("memory busy");
  expect((await f.lines("attempts"))[0].args).toEqual(["index", "--harness", "opencode"]);
  await expect(index(join(f.tmp, "missing"))).rejects.toThrow();
});

test("plugin preserves MCP config, retries startup and coalesces newer work during a failed index", async () => {
  const f = await fixture();
  f.failListing();
  await f.hold();
  await f.fail();
  const hooks = await f.start();
  const config: Config = { mcp: { other: { type: "local", command: ["other"] } } };
  await hooks.config?.(config);
  expect(config).toEqual({ mcp: { other: { type: "local", command: ["other"] }, funes: { type: "local", command: [f.binary, "mcp"], enabled: true } } });
  const existing: Config = { mcp: { funes: { type: "local", command: ["custom"], enabled: false } } };
  await hooks.config?.(existing);
  expect(existing.mcp?.funes).toEqual({ type: "local", command: ["custom"], enabled: false });
  await until(async () => (await f.lines("attempts")).length === 1);
  const newer = structuredClone(messages);
  const p = newer[0].parts[0]; if (p.type === "text") p.text = "newer snapshot";
  f.setMessages(newer);
  for (let i = 0; i < 5; i++) await hooks.event?.(idle("ses_0"));
  expect(await f.lines("imported")).toEqual([]);
  await f.release();
  await until(async () => (await f.lines("imported")).length === 2);
  expect((await f.lines("imported"))[0].blocks[0].text).toBe("newer snapshot");
  expect(await f.lines("attempts")).toEqual([
    { args: ["index", "--harness", "opencode"], files: ["ses_0.funes.jsonl"] },
    { args: ["index", "--harness", "opencode"], files: ["ses_0.funes.jsonl"] },
  ]);
}, 15000);

test("the startup sweep converts every session before funes is asked once", async () => {
  const f = await fixture(3);
  await f.start();
  await until(async () => (await f.lines("imported")).length === 6);
  expect(await f.lines("attempts")).toEqual([
    { args: ["index", "--harness", "opencode"], files: ["ses_0.funes.jsonl", "ses_1.funes.jsonl", "ses_2.funes.jsonl"] },
  ]);
});

test("a startup sweep takes only the sessions changed since the last one that finished", async () => {
  const f = await fixture(2);
  const first = await f.start();
  await until(async () => (await readdir(join(f.bundle, "swept")).catch(() => [])).length === 1);
  await first.dispose?.();
  expect(await f.lines("imported")).toHaveLength(4);

  let seen = f.requests.length;
  const second = await f.start();
  await until(() => f.requests.length > seen);
  await Bun.sleep(100);
  expect(f.requests.slice(seen).map(r => r.pathname)).toEqual(["/session"]);
  await second.dispose?.();

  f.rows[1] = { ...f.rows[1], time: { created: 1000, updated: Date.now() + 1000 } };
  seen = f.requests.length;
  await f.start();
  await until(async () => (await f.lines("imported")).length === 6);
  expect(f.requests.slice(seen).map(r => r.pathname).filter(path => path.endsWith("/message"))).toEqual(["/session/ses_1/message"]);
});

test("the MCP server is registered on the memory the install was bound to", async () => {
  const f = await fixture(1, { memory: "acme/kb" });
  const hooks = await f.start();
  const config: Config = {};
  await hooks.config?.(config);
  expect(config.mcp?.funes).toEqual({ type: "local", command: [f.binary, "mcp", "acme/kb"], enabled: true });
});

test("a plugin no setup has run for registers recall and converts nothing", async () => {
  const f = await fixture(1, { setup: false });
  const hooks = await f.start();
  const config: Config = {};
  await hooks.config?.(config);
  expect(config.mcp?.funes).toEqual({ type: "local", command: ["funes", "mcp"], enabled: true });
  await hooks.event?.(idle("ses_0"));
  await Bun.sleep(100);
  expect(f.requests).toEqual([]);
  expect(await f.lines("attempts")).toEqual([]);
});

test("a turn keeps its seq across restarts once the message before it is reverted", async () => {
  const f = await fixture();
  const first = await f.start();
  await until(async () => (await f.lines("imported")).length === 2);
  await first.dispose?.();
  const [user, answer] = structuredClone(messages);
  answer.info.id = "msg_003";
  f.setMessages([user, answer]);
  const second = await f.start();
  await second.event?.(idle("ses_0"));
  await until(async () => (await f.lines("imported")).some(t => t.turn_uuid === "msg_003"));
  expect(new Set((await f.lines("imported")).map(t => `${t.turn_uuid}=${t.seq}`))).toEqual(new Set(["msg_001=0", "msg_002=1", "msg_003=2"]));
});

test("idle received during a successful index survives; dispose stops future work", async () => {
  const f = await fixture();
  await f.hold();
  const hooks = await f.start();
  await until(async () => (await f.lines("attempts")).length === 1);
  await hooks.event?.(idle("ses_0"));
  await f.release();
  await until(async () => (await f.lines("imported")).length === 4);
  await hooks.dispose?.();
  await hooks.event?.(idle("ses_0"));
  await Bun.sleep(100);
  expect((await f.lines("attempts")).length).toBe(2);
});

test("disposal terminates an active index without importing held content", async () => {
  const f = await fixture();
  await f.hold();
  const hooks = await f.start();
  await until(async () => (await f.lines("attempts")).length === 1);
  await hooks.dispose?.();
  await f.release();
  await Bun.sleep(100);
  expect(await f.lines("imported")).toEqual([]);
});

test("CLI backfill uses Basic auth and writes each session as a turns file", async () => {
  const f = await fixture();
  const out = join(f.tmp, "out");
  const child = Bun.spawn([process.execPath, "src/cli.ts", "backfill", "--url", f.input.serverUrl.toString(), "--directory", f.directory, "--out", out], {
    env: { ...process.env, OPENCODE_SERVER_USERNAME: "test", OPENCODE_SERVER_PASSWORD: "test" }, stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  const turns = (await readFile(join(out, "ses_0.funes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(turns.map(t => [t.session_id, t.turn_uuid, t.seq, t.blocks.length])).toEqual([["ses_0", "msg_001", 0, 1], ["ses_0", "msg_002", 1, 6]]);
  expect(f.headers.every(h => h === "Basic dGVzdDp0ZXN0")).toBe(true);
});

test("CLI rejects missing scope and reports a failed conversion with nonzero exit", async () => {
  const missing = Bun.spawn([process.execPath, "src/cli.ts", "backfill"], { stdout: "ignore", stderr: "pipe" });
  expect(await new Response(missing.stderr).text()).toContain("--out");
  expect(await missing.exited).toBe(1);
  const f = await fixture();
  f.failListing();
  const child = Bun.spawn([process.execPath, "src/cli.ts", "backfill", "--url", f.input.serverUrl.toString(), "--directory", f.directory, "--out", join(f.tmp, "out")], { stdout: "ignore", stderr: "pipe" });
  expect(await new Response(child.stderr).text()).toContain("503");
  expect(await child.exited).toBe(1);
});
