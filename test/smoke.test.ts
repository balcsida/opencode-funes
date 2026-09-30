import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real OpenCode binaries of both lines, each installed with the bundle the way funes installs it
// and driven through one prompt to a fake model, until funes is handed the session. Skipped
// unless the binaries are named: `bun run smoke` fetches the pinned ones and names them.
const V1 = process.env.OPENCODE_V1;
const V2 = process.env.OPENCODE_V2;
const ANSWER = "Hello from the fake model";
const PROMPT = "Say hello";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await Bun.sleep(100); }
}
function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// The only model OpenCode is given: an OpenAI-compatible endpoint that streams the same answer to
// every prompt, as `@ai-sdk/openai-compatible` asks for it.
function fakeModel() {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    return new Response(chunk({ role: "assistant", content: ANSWER }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  cleanups.push(() => server.stop(true));
  return server.url;
}

// A home of its own for one OpenCode: the bundle installed by its real `setup add`, a funes that
// records what it is asked and drains the spool as `funes index` does, the fake model as the only
// provider, and a project to work in.
async function home(model: URL) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "opencode-funes-smoke-")));
  // SMOKE_KEEP=1 leaves the home behind, logs and all, for a look after a failure.
  cleanups.push(() => (process.env.SMOKE_KEEP ? console.log(`kept ${tmp}`) : rm(tmp, { recursive: true, force: true })));
  const dirs = { HOME: join(tmp, "home"), XDG_CONFIG_HOME: join(tmp, "config"), XDG_STATE_HOME: join(tmp, "state"), XDG_DATA_HOME: join(tmp, "data"), XDG_CACHE_HOME: join(tmp, "cache") };
  const project = join(tmp, "project");
  for (const dir of [...Object.values(dirs), project]) await mkdir(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });
  const bundle = join(dirs.HOME, ".funes/agents/opencode");
  await cp(join(import.meta.dir, "../opencode"), bundle, { recursive: true });
  const spool = join(dirs.HOME, ".funes/spool/opencode");
  const imported = join(tmp, "imported.jsonl");
  const funes = join(tmp, "funes");
  await writeFile(funes, `#!/bin/sh
echo "$*" >> ${JSON.stringify(join(tmp, "funes-calls"))}
[ "$1" = index ] || exit 0
for f in ${JSON.stringify(spool)}/*.funes.jsonl; do [ -f "$f" ] && cat "$f" >> ${JSON.stringify(imported)} && rm "$f"; done
exit 0
`);
  await chmod(funes, 0o755);
  const added = Bun.spawnSync([join(bundle, "setup"), "add"], {
    env: { HOME: dirs.HOME, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: dirs.XDG_CONFIG_HOME, FUNES_BIN: funes, FUNES_HOME: join(dirs.HOME, ".funes"), FUNES_AGENT_ID: "opencode" },
    stdout: "pipe", stderr: "pipe",
  });
  if (added.exitCode !== 0) throw new Error(added.stderr.toString());
  // The OpenCode 1 shape; OpenCode 2 reads it as well.
  await writeFile(join(dirs.XDG_CONFIG_HOME, "opencode/opencode.json"), JSON.stringify({
    autoupdate: false, share: "disabled",
    provider: { fake: { name: "Fake", npm: "@ai-sdk/openai-compatible", options: { baseURL: new URL("/v1", model).href, apiKey: "fake-key" }, models: { "fake-model": { name: "Fake Model" } } } },
  }));
  const env = { ...dirs, PATH: process.env.PATH ?? "/usr/bin:/bin", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  // A child that is stopped, then waited for, when the test ends; its output kept in `tmp`.
  function spawn(cmd: string[], extra: Record<string, string>, name: string) {
    const child = Bun.spawn(cmd, { cwd: project, env: { ...env, ...extra }, stdout: Bun.file(join(tmp, `${name}.out`)), stderr: Bun.file(join(tmp, `${name}.err`)) });
    cleanups.push(async () => {
      child.kill();
      await Promise.race([child.exited, Bun.sleep(10_000).then(() => child.kill(9))]);
    });
    return { child, out: () => readFile(join(tmp, `${name}.out`), "utf8"), err: () => readFile(join(tmp, `${name}.err`), "utf8") };
  }
  // One `opencode run` of the prompt; what it printed, once it has exited well.
  async function prompt(cmd: string[], extra: Record<string, string>) {
    const run = spawn(cmd, extra, "run");
    const code = await run.child.exited;
    const out = await run.out();
    if (code !== 0) throw new Error(`opencode run exited ${code}\n${out}\n${await run.err()}`);
    expect(out).toContain(ANSWER);
    expect(out).not.toContain('"type":"error"');
    return out;
  }
  // The session as funes was handed it: the prompt and the answer, one turn each.
  async function converted() {
    await until(async () => (await readFile(imported, "utf8").catch(() => "")).includes(ANSWER), "the plugin to convert the session and funes to drain it").catch(async error => {
      throw new Error(`${error.message}\n--- funes-sync.log:\n${await readFile(join(bundle, "funes-sync.log"), "utf8").catch(() => "(none)")}`);
    });
    const turns = new Map((await readFile(imported, "utf8")).trim().split("\n").map(line => JSON.parse(line)).map(turn => [turn.turn_uuid, turn]));
    const [user, assistant] = [...turns.values()].sort((a, b) => a.seq - b.seq);
    // OpenCode 1's `run` quotes the prompt it records; the words are what matter here.
    expect([user.role, user.seq, user.harness, user.blocks.length, user.blocks[0].block_type]).toEqual(["user", 0, "opencode", 1, "text"]);
    expect(user.blocks[0].text).toContain(PROMPT);
    expect([assistant.role, assistant.seq, assistant.session_id]).toEqual(["assistant", 1, user.session_id]);
    expect(assistant.blocks).toContainEqual({ block_type: "text", text: ANSWER });
    expect(user.cwd).toBe(project);
    expect(await readFile(join(tmp, "funes-calls"), "utf8")).toContain("index --harness opencode");
  }
  // The OpenCode under test, served in the background; a failure of the test says what it logged.
  async function serving(cmd: string[], extra: Record<string, string>, check: () => Promise<void>) {
    const serve = spawn(cmd, extra, "serve");
    try { await check(); } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\n--- opencode serve stderr:\n${(await serve.err().catch(() => "")).slice(-4000)}`);
    }
  }
  return { tmp, project, env, spawn, prompt, converted, serving };
}
const basic = (password: string) => ({ authorization: `Basic ${btoa(`opencode:${password}`)}` });

test.skipIf(!V1)("OpenCode 1: the plugin registers funes and converts a prompted session when it goes idle", async () => {
  const h = await home(fakeModel());
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const auth = { OPENCODE_SERVER_PASSWORD: "smoke" };
  const headers = basic("smoke");
  await h.serving([V1!, "serve", "--hostname", "127.0.0.1", "--port", String(port)], auth, async () => {
    await until(() => fetch(`${url}/config`, { headers }).then(r => r.ok, () => false), "OpenCode 1 to serve");
    await h.prompt([V1!, "run", "--attach", url, "--dir", h.project, "--format", "json", "-m", "fake/fake-model", PROMPT], auth);
    // Registered by the plugin's config hook; OpenCode lists it once it has tried to connect.
    await until(async () => Object.keys(await (await fetch(`${url}/mcp?directory=${encodeURIComponent(h.project)}`, { headers })).json()).includes("funes"), "funes among the MCP servers");
    await h.converted();
  });
}, 120_000);

test.skipIf(!V2)("OpenCode 2: the plugin registers funes and converts a prompted session when it goes idle", async () => {
  const h = await home(fakeModel());
  const port = freePort();
  await h.serving([V2!, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info"], {}, async () => {
    // The background service registers itself, and the plugin reads sessions through that registration.
    const registration = join(h.env.XDG_STATE_HOME, "opencode/service.json");
    await until(() => existsSync(registration), "the OpenCode 2 service to register");
    const { url, password } = JSON.parse(await readFile(registration, "utf8"));
    const headers = basic(password);
    await until(() => fetch(`${url}/api/info`, { headers }).then(r => r.ok, () => false), "OpenCode 2 to serve");
    await h.prompt([V2!, "run", "--server", url, "--format", "json", "-m", "fake/fake-model", PROMPT], { OPENCODE_PASSWORD: password });
    // Registered by the plugin's MCP transform; OpenCode lists it once it has tried to connect.
    await until(async () => ((await (await fetch(`${url}/api/mcp?directory=${encodeURIComponent(h.project)}`, { headers })).json()).data as Array<{ name: string }>).some(s => s.name === "funes"), "funes among the MCP servers");
    await h.converted();
  });
}, 120_000);
