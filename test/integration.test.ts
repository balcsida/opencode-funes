import { afterEach, expect, test } from "bun:test";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, emit, index, sourceV1, sourceV2, type SessionV2 } from "../opencode/core";
import type installed from "../opencode/plugin";
import { messages, messagesV2, session } from "./fixtures";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out"); await Bun.sleep(20); }
}
const idle = (sessionID: string) => ({ event: { type: "session.idle" as const, properties: { sessionID } } });
const BASIC_V1 = "Basic dGVzdDp0ZXN0"; // test:test, what the CLI and the OpenCode 1 client are given
const BASIC_V2 = "Basic b3BlbmNvZGU6dGVzdA=="; // opencode:test, from the service registration

// The bundle installed as funes installs it — copied under ~/.funes/agents, its real `setup add`
// run — against an OpenCode that serves `count` sessions, as OpenCode 1 or, with `v2`, as the
// OpenCode 2 background service this process is registered as, and a funes that drains the spool
// the way `funes index --harness opencode` does: each turns file read whole, then deleted.
async function fixture(count = 1, { memory = "", setup = true, v2 = false, pid = process.pid } = {}) {
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
  let plugin: typeof installed;
  if (setup) {
    const env = { HOME: home, PATH: "/usr/bin:/bin", FUNES_BIN: binary, FUNES_HOME: join(home, ".funes"), FUNES_AGENT_ID: "opencode" };
    const added = Bun.spawnSync([join(bundle, "setup"), "add", ...(memory ? [memory] : [])], { env, stdout: "pipe", stderr: "pipe" });
    if (added.exitCode !== 0) throw new Error(added.stderr.toString());
    plugin = (await import(join(home, ".config/opencode/plugins/funes.ts"))).default;
  } else {
    plugin = (await import(join(bundle, "plugin.ts"))).default;
  }

  const rows: Session[] = Array.from({ length: count }, (_, i) => ({ ...session, id: `ses_${i}`, directory }));
  const rowsV2 = (): SessionV2[] => rows.map(r => ({ id: r.id, location: { directory: r.directory }, time: r.time }));
  const requests: URL[] = [];
  const headers: Array<string | null> = [];
  let current: unknown = structuredClone(v2 ? messagesV2 : messages);
  let saturated = false;
  let failList = 0;
  const broken = new Set<string>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const url = new URL(req.url); requests.push(url); headers.push(req.headers.get("authorization"));
    // OpenCode 2 mounts the same routes under /api.
    const [group, id, tail] = url.pathname.split("/").slice(v2 ? 2 : 1);
    if (v2) {
      if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      if (url.pathname === "/api/info") return Response.json({ name: "opencode", version: "2.0.20" });
      if (url.pathname === "/api/session") {
        if (failList-- > 0) return Response.json({ error: "offline" }, { status: 503 });
        // Offset cursors: enough to prove every page is asked for.
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const all = rowsV2();
        return Response.json({ data: all.slice(offset, offset + limit), cursor: offset + limit < all.length ? { next: String(offset + limit) } : {} });
      }
      if (tail === "message") return broken.has(id) ? Response.json({ error: "unreadable" }, { status: 500 }) : Response.json({ data: current, cursor: {} });
      const row = rowsV2().find(r => r.id === id);
      return row ? Response.json({ data: row }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/session") {
      if (failList-- > 0) return Response.json({ error: "offline" }, { status: 503 });
      const limit = Number(url.searchParams.get("limit"));
      return Response.json(saturated ? Array.from({ length: limit }, (_, i) => ({ ...session, id: `ses_${i}` })) : rows.slice(0, limit));
    }
    if (group === "session" && tail === "message") return broken.has(id) ? Response.json({ error: "unreadable" }, { status: 500 }) : Response.json(current);
    const row = group === "session" && rows.find(r => r.id === id);
    return row ? Response.json(row) : new Response("Not found", { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  const client = createOpencodeClient({ baseUrl: server.url.toString(), headers: { Authorization: BASIC_V1 } });
  const source = v2 ? sourceV2(server.url, directory, { authorization: BASIC_V2 }) : sourceV1(client, directory);
  const input: PluginInput = { client, directory, worktree: directory, serverUrl: server.url,
    project: { id: "project", worktree: directory, time: { created: 1000 } },
    experimental_workspace: { register() {} }, $: Bun.$ };
  // What OpenCode 2 hands a plugin, as far as this one uses it: its location, the event stream,
  // and the MCP editor. The service registration it reads is written where XDG_STATE_HOME says.
  const state = join(tmp, "state");
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  cleanups.push(() => { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; });
  await mkdir(join(state, "opencode"), { recursive: true });
  await writeFile(join(state, "opencode/service.json"), JSON.stringify({ id: "svc", version: "2.0.20", url: server.url.toString(), pid, password: "test" }));
  const events: Array<{ type: string; data?: { sessionID?: string } }> = [];
  let arrived: (() => void) | undefined;
  const mcp = new Map<string, unknown>();
  const ctx = {
    location: { directory },
    event: { async *subscribe({ signal }: { signal?: AbortSignal } = {}) {
      while (!signal?.aborted) {
        if (events.length) { yield events.shift()!; continue; }
        await new Promise<void>(resolve => { arrived = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
      }
    } },
    mcp: { async transform(edit: (editor: { get(name: string): unknown; set(name: string, config: unknown): void }) => void) {
      edit({ get: name => mcp.get(name), set: (name, config) => mcp.set(name, config) });
    } },
  };
  async function lines(name: string) { try { return (await readFile(join(tmp, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  async function start() {
    const hooks = await plugin.server(input);
    cleanups.push(() => hooks.dispose?.());
    return hooks;
  }
  async function startV2() {
    const cleanup = await plugin.setup(ctx);
    cleanups.push(() => cleanup?.());
    return cleanup;
  }
  return { tmp, directory, bundle, spool, binary, input, source, requests, headers, rows, lines, start, startV2, mcp,
    hold: () => writeFile(join(tmp, "hold"), ""), release: () => rm(join(tmp, "hold")), fail: () => writeFile(join(tmp, "fail"), ""),
    setMessages(value: unknown) { current = value; }, saturate() { saturated = true; }, failListing() { failList = 1; },
    breakSession(id: string) { broken.add(id); },
    idleV2(sessionID: string) { events.push({ type: "session.idle", data: { sessionID } }); arrived?.(); } };
}

test("real SDK grows snapshots beyond 100 tied timestamps and converts every session", async () => {
  const f = await fixture(106);
  const out = join(f.tmp, "out");
  expect(await backfill(f.source, out)).toBe(106);
  expect(f.requests.filter(r => r.pathname === "/session").map(r => r.searchParams.get("limit"))).toEqual(["100", "200"]);
  expect(f.requests.every(r => r.searchParams.get("directory") === f.directory)).toBe(true);
  expect(f.requests.filter(r => r.pathname.endsWith("/message")).every(r => !r.searchParams.has("limit"))).toBe(true);
  expect((await readdir(out)).sort()).toEqual(f.rows.map(row => `${row.id}.funes.jsonl`).sort());
  expect(f.headers.every(h => h === BASIC_V1)).toBe(true);
}, 20000);

test("snapshot ceiling and HTTP failures are explicit", async () => {
  const f = await fixture();
  f.failListing();
  await expect(f.source.list()).rejects.toThrow();
  f.saturate();
  await expect(f.source.list()).rejects.toThrow("102400");
  expect(f.requests.at(-1)?.searchParams.get("limit")).toBe("102400");
});

test("an exactly full page grows again to prove completeness", async () => {
  const f = await fixture(100);
  expect(await f.source.list()).toHaveLength(100);
  expect(f.requests.map(r => r.searchParams.get("limit"))).toEqual(["100", "200"]);
});

test("OpenCode 2 lists sessions by cursor, and messages oldest first", async () => {
  const f = await fixture(250, { v2: true });
  expect(await backfill(f.source, join(f.tmp, "out"))).toBe(250);
  const listings = f.requests.filter(r => r.pathname === "/api/session");
  expect(listings.map(r => [r.searchParams.get("limit"), r.searchParams.get("directory"), r.searchParams.get("cursor")])).toEqual([["200", f.directory, null], ["200", null, "200"]]);
  const reads = f.requests.filter(r => r.pathname.endsWith("/message"));
  expect(reads).toHaveLength(250);
  expect(reads.every(r => r.searchParams.get("order") === "asc" && r.searchParams.get("limit") === "200")).toBe(true);
  expect(f.headers.every(h => h === BASIC_V2)).toBe(true);
  await expect(f.source.read("ses_999")).rejects.toThrow("404");
}, 20000);

test("a session is one turns file named from its id, one turn a line, stamped with the session's own time", async () => {
  const f = await fixture();
  expect(await emit(f.source, "ses_0", f.spool)).toBe(true);
  expect(await readdir(f.spool)).toEqual(["ses_0.funes.jsonl"]);
  const file = join(f.spool, "ses_0.funes.jsonl");
  const body = await readFile(file, "utf8");
  expect(body.endsWith("\n")).toBe(true);
  expect(body.trim().split("\n").map(line => JSON.parse(line)).map(t => [t.session_id, t.turn_uuid, t.seq, t.harness])).toEqual([
    ["ses_0", "msg_001", 0, "opencode"], ["ses_0", "msg_002", 1, "opencode"],
  ]);
  expect((await stat(file)).mtimeMs).toBe(1000);
});

// funes's own verdict on the format, for a funes on the box: `FUNES_BIN=/path/to/funes bun test`.
test.skipIf(!process.env.FUNES_BIN)("funes index --check accepts a session as it is written", async () => {
  const f = await fixture();
  await emit(f.source, "ses_0", f.spool);
  const env = { ...process.env, FUNES_HOME: join(f.tmp, "checked") };
  const check = Bun.spawnSync([process.env.FUNES_BIN!, "index", "--check", f.spool], { env, stdout: "pipe", stderr: "pipe" });
  expect(check.exitCode).toBe(0);
});

test("a session with nothing finished writes no file", async () => {
  const f = await fixture();
  f.setMessages([]);
  expect(await emit(f.source, "ses_0", f.spool)).toBe(false);
  expect(await readdir(f.spool)).toEqual([]);
});

test("a write that cannot finish leaves nothing funes would list as a turns file", async () => {
  const f = await fixture();
  // A directory where the turns file goes: the rename over it fails, and what was written stays.
  await mkdir(join(f.spool, "ses_0.funes.jsonl", "in the way"), { recursive: true });
  await expect(emit(f.source, "ses_0", f.spool)).rejects.toThrow();
  expect((await readdir(f.spool)).filter(name => name.endsWith(".jsonl"))).toEqual(["ses_0.funes.jsonl"]);
  expect(await readdir(f.spool)).toHaveLength(2);
});

test("a session id that cannot name a file is refused before anything is asked or written", async () => {
  const f = await fixture();
  await expect(emit(f.source, "../escaped", f.spool)).rejects.toThrow("../escaped");
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

test("a session that cannot be converted does not keep the others from funes", async () => {
  const f = await fixture(3);
  f.breakSession("ses_1");
  await f.start();
  await until(async () => (await f.lines("imported")).length === 4);
  expect(new Set((await f.lines("imported")).map(t => t.session_id))).toEqual(new Set(["ses_0", "ses_2"]));
  // OpenCode shows a plugin's console nowhere, so the failure is written beside the bundle.
  await until(async () => (await readFile(join(f.bundle, "funes-sync.log"), "utf8").catch(() => "")).includes("ses_1"));
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

test("OpenCode 2: setup registers the MCP server, sweeps through the service, follows idle events, and its cleanup stops the work", async () => {
  const f = await fixture(2, { v2: true, memory: "acme/kb" });
  const cleanup = await f.startV2();
  expect(f.mcp.get("funes")).toEqual({ type: "local", command: [f.binary, "mcp", "acme/kb"] });
  await until(async () => (await f.lines("imported")).length === 4);
  expect(f.requests.map(r => r.pathname)).toEqual(["/api/session", "/api/session/ses_0", "/api/session/ses_0/message", "/api/session/ses_1", "/api/session/ses_1/message"]);
  expect(f.headers.every(h => h === BASIC_V2)).toBe(true);
  expect((await f.lines("imported")).map(t => [t.session_id, t.turn_uuid, t.seq, t.cwd]).sort()).toEqual([
    ["ses_0", "msg_001", 0, f.directory], ["ses_0", "msg_002", 1, f.directory], ["ses_1", "msg_001", 0, f.directory], ["ses_1", "msg_002", 1, f.directory],
  ]);
  const newer = structuredClone(messagesV2);
  if (newer[0].type === "user") newer[0].text = "newer snapshot";
  f.setMessages(newer);
  f.idleV2("ses_1");
  await until(async () => (await f.lines("imported")).length === 6);
  expect((await f.lines("imported"))[4].blocks[0].text).toBe("newer snapshot");
  await cleanup?.();
  f.idleV2("ses_0");
  await Bun.sleep(100);
  expect(await f.lines("attempts")).toHaveLength(2);
});

test("OpenCode 2: a funes MCP server already configured is left alone, and the sweep is marked", async () => {
  const f = await fixture(1, { v2: true });
  f.mcp.set("funes", { type: "local", command: ["custom"], disabled: true });
  await f.startV2();
  expect(f.mcp.get("funes")).toEqual({ type: "local", command: ["custom"], disabled: true });
  await until(async () => (await readdir(join(f.bundle, "swept")).catch(() => [])).length === 1);
});

test("OpenCode 2: a registration naming another process converts nothing, and says so", async () => {
  const f = await fixture(1, { v2: true, pid: process.pid + 1 });
  expect(await f.startV2()).toBeUndefined();
  f.idleV2("ses_0");
  await Bun.sleep(100);
  expect(f.requests).toEqual([]);
  expect(await readFile(join(f.bundle, "funes-sync.log"), "utf8")).toContain("service");
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
  expect(f.requests[0].pathname).toBe("/api/info");
  expect(f.headers.every(h => h === BASIC_V1)).toBe(true);
});

test("CLI backfill tells an OpenCode 2 server by its /api and converts through it", async () => {
  const f = await fixture(1, { v2: true });
  const out = join(f.tmp, "out");
  const child = Bun.spawn([process.execPath, "src/cli.ts", "backfill", "--url", f.input.serverUrl.toString(), "--directory", f.directory, "--out", out], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "test" }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  expect(stdout).toContain("Converted 1 OpenCode 2 sessions");
  const turns = (await readFile(join(out, "ses_0.funes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(turns.map(t => [t.turn_uuid, t.seq, t.blocks.length])).toEqual([["msg_001", 0, 1], ["msg_002", 1, 6]]);
  expect(f.headers.every(h => h === BASIC_V2)).toBe(true);
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
