import { afterEach, expect, test } from "bun:test";
import { createOpencodeClient, type Session } from "@opencode-ai/sdk";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { mkdtemp, rm, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, ingest, listSessions, mapSession } from "../opencode/core";
import plugin from "../opencode/plugin";
import { messages, session } from "./fixtures";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out"); await Bun.sleep(20); }
}
async function fixture(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-funes-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "fake funes");
  await writeFile(binary, `#!${process.execPath}
import { existsSync, appendFileSync, unlinkSync } from "node:fs";
const body = await Bun.stdin.text();
appendFileSync("attempts", JSON.stringify({args:process.argv.slice(2), body}) + "\\n");
while (existsSync("hold")) await Bun.sleep(10);
if (existsSync("fail")) { unlinkSync("fail"); console.error("memory busy"); process.exit(1); }
for (const line of body.trim().split("\\n")) { const session = JSON.parse(line); for (const turn of session.turns) appendFileSync("imported", JSON.stringify({session:session.session_id, turn}) + "\\n"); }
`);
  await chmod(binary, 0o755);
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
  async function lines(name: string) { try { return (await readFile(join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  return { directory, binary, input, requests, headers, rows, lines,
    setMessages(value: typeof messages) { current = value; }, saturate() { saturated = true; }, failListing() { failList = 1; } };
}

test("real SDK grows snapshots beyond 100 tied timestamps and imports all content", async () => {
  const f = await fixture(106);
  await backfill(f.input.client, f.directory, f.binary);
  expect(f.requests.filter(r => r.pathname === "/session").map(r => r.searchParams.get("limit"))).toEqual(["100", "200"]);
  expect(f.requests.every(r => r.searchParams.get("directory") === f.directory)).toBe(true);
  expect(f.requests.filter(r => r.pathname.endsWith("/message")).every(r => !r.searchParams.has("limit"))).toBe(true);
  expect(new Set((await f.lines("imported")).map(r => r.session)).size).toBe(106);
  expect((await f.lines("imported"))[1].turn.blocks[2].text).toBe("A memory tool");
  expect((await f.lines("attempts"))[0].args).toEqual(["ingest", "-"]);
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

test("ingest rejects oversized input before spawning and reports child failure", async () => {
  const f = await fixture();
  const record = mapSession(session, messages);
  record.turns[0].blocks[0].text = "x".repeat(64 * 1024 * 1024);
  await expect(ingest(record, f.directory, f.binary)).rejects.toThrow("64 MiB");
  expect(await f.lines("attempts")).toEqual([]);
  await writeFile(join(f.directory, "fail"), "");
  await expect(ingest(mapSession(session, messages), f.directory, f.binary)).rejects.toThrow("memory busy");
  await expect(ingest(mapSession(session, messages), f.directory, join(f.directory, "missing"))).rejects.toThrow();
});

test("plugin preserves MCP config, retries startup and coalesces newer work during a failed child", async () => {
  const f = await fixture();
  f.failListing();
  await writeFile(join(f.directory, "hold"), "");
  await writeFile(join(f.directory, "fail"), "");
  const hooks = await plugin(f.input, { funes: f.binary });
  cleanups.push(() => hooks.dispose?.());
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
  for (let i = 0; i < 5; i++) await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_0" } } });
  expect(await f.lines("imported")).toEqual([]);
  await rm(join(f.directory, "hold"));
  await until(async () => (await f.lines("imported")).length === 2);
  expect((await f.lines("imported"))[0].turn.blocks[0].text).toBe("newer snapshot");
  expect((await f.lines("attempts")).length).toBe(2);
}, 15000);

test("idle received during successful ingest survives; dispose stops future work", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "hold"), "");
  const hooks = await plugin(f.input, { funes: f.binary });
  cleanups.push(() => hooks.dispose?.());
  await until(async () => (await f.lines("attempts")).length === 1);
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_0" } } });
  await rm(join(f.directory, "hold"));
  await until(async () => (await f.lines("imported")).length === 4);
  await hooks.dispose?.();
  await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_0" } } });
  await Bun.sleep(100);
  expect((await f.lines("attempts")).length).toBe(2);
});

test("CLI backfill uses Basic auth and the shared ingest mapping", async () => {
  const f = await fixture();
  const child = Bun.spawn([process.execPath, "src/cli.ts", "backfill", "--url", f.input.serverUrl.toString(), "--directory", f.directory, "--funes", f.binary], {
    env: { ...process.env, OPENCODE_SERVER_USERNAME: "test", OPENCODE_SERVER_PASSWORD: "test" }, stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  expect((await f.lines("imported"))[1].turn).toEqual(mapSession(session, messages).turns[1]);
  expect(f.headers.every(h => h === "Basic dGVzdDp0ZXN0")).toBe(true);
});

test("disposal terminates an active child without importing held content", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "hold"), "");
  const hooks = await plugin(f.input, { funes: f.binary });
  cleanups.push(() => hooks.dispose?.());
  await until(async () => (await f.lines("attempts")).length === 1);
  await hooks.dispose?.();
  await rm(join(f.directory, "hold"));
  await Bun.sleep(100);
  expect(await f.lines("imported")).toEqual([]);
});

test("CLI rejects missing scope and reports failed import with nonzero exit", async () => {
  const missing = Bun.spawn([process.execPath, "src/cli.ts", "backfill"], { stdout: "ignore", stderr: "pipe" });
  expect(await new Response(missing.stderr).text()).toContain("--directory");
  expect(await missing.exited).toBe(1);
  const f = await fixture();
  await writeFile(join(f.directory, "fail"), "");
  const child = Bun.spawn([process.execPath, "src/cli.ts", "backfill", "--url", f.input.serverUrl.toString(), "--directory", f.directory, "--funes", f.binary], { stdout: "ignore", stderr: "pipe" });
  expect(await new Response(child.stderr).text()).toContain("memory busy");
  expect(await child.exited).toBe(1);
});
