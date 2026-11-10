import type { PluginInput, PluginModule } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { emit, index, publish, replace, sourceV1, sourceV2, type Source } from "./core";

const here = import.meta.dirname;
const LOG = join(here, "funes-sync.log");

// What is recorded beside this plugin under `name`, by `setup add` or by the plugin itself, or ""
// when nothing is.
function bound(name: string) {
  try { return readFileSync(resolve(here, name), "utf8").trim(); } catch { return ""; }
}

// A line in the log beside this plugin: OpenCode shows a plugin's console nowhere.
function log(line: string) {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {}
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const funes = bound("bin") || "funes";
const memory = bound("memory");
// The directory funes drains for this install. A plugin `funes add` did not install has none,
// and converts nothing.
const spool = bound("spool");
const command = [funes, "mcp", ...(memory ? [memory] : [])];
// funes names itself and the agent in its Hub requests: hf-hub appends this to its User-Agent, and
// funes adds its own version. An origin already set is kept in front.
const environment = { HF_HUB_USER_AGENT_ORIGIN: [process.env.HF_HUB_USER_AGENT_ORIGIN, "funes; agent/opencode"].filter(Boolean).join("; ") };

// What both OpenCodes share once they have handed over a source: from `start`, and again after a
// session goes idle, the sessions changed since the last sweep are converted, then funes indexes
// what was written. OpenCode 2's source lists every project, so a session whose own instance
// never ran — a project not open, a hook that did not fire — is caught at the next turn. Every
// event reaches every instance; converting a session twice is harmless, funes drops a turn it
// holds. With a memory bound, what this host has indexed is published at the boundaries OpenCode
// has: after the sweep, catching up what a shutdown left behind, and at disposal.
function sync(directory: string, source: Source) {
  const pending = new Set<string>();
  const abort = new AbortController();
  let sweep = true;
  let publishing = Boolean(memory);
  // When the last sweep to finish had started: the sessions unchanged since are funes's already.
  // funes drains the spool, so only a mark kept here can say so. One mark for the whole sweep —
  // OpenCode 2 lists every project, and a mark per directory would import them again from each instance.
  const mark = join(here, "swept", "all");
  // When the sweep in progress started, until the mark says so.
  let swept = 0;
  // Whether the spool holds turns funes has not been asked to index.
  let written = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A `retry-ms` beside the bundle overrides the backoff. Tests shrink it; nothing writes it otherwise.
  const retryStart = Number(bound("retry-ms")) || 1000;
  let retry = retryStart;
  // How many times a session has failed to convert, and the `updated` time that failure was for.
  // A session OpenCode keeps answering 500 for is dropped after a few attempts so the sweep can
  // be marked; a later edit, a new `updated`, tries again.
  const failures = new Map<string, number>();
  const revised = new Map<string, number>();
  const giveUp = 5;

  function wake() {
    if (abort.signal.aborted || running || timer) return;
    running = drain().finally(() => {
      running = undefined;
      if (sweep || pending.size) wake();
    });
  }
  async function drain() {
    try {
      if (sweep) {
        const since = Number(bound(mark)) || 0;
        swept = Date.now();
        // ponytail: a turn another OpenCode finishes after this listing is left to that process's
        // own idle; sweep from a margin before the mark if sessions prove to go missing.
        const sessions = await source.list(abort.signal);
        for (const session of sessions) if (session.updated > since) {
          if (revised.get(session.id) !== session.updated) failures.delete(session.id);
          revised.set(session.id, session.updated);
          pending.add(session.id);
        }
        sweep = false;
        log(`sweep ${directory}: ${pending.size} of ${sessions.length} sessions changed since ${since}`);
      }
      // A session that cannot be converted waits for the retry, and keeps nothing from funes:
      // what the others wrote is indexed first.
      let failed: unknown;
      for (const id of [...pending]) {
        if (abort.signal.aborted) return;
        pending.delete(id); // An idle during the conversion re-adds this ID for a fresh snapshot.
        try { if (await emit(source, id, spool, here, abort.signal)) { written = true; failures.delete(id); } }
        catch (error) {
          const attempts = (failures.get(id) ?? 0) + 1;
          failures.set(id, attempts);
          if (attempts >= giveUp) log(`convert ${id}: giving up after ${attempts} attempts: ${reason(error)}`);
          else { pending.add(id); failed ??= error; log(`convert ${id}: ${reason(error)}`); }
        }
      }
      if (abort.signal.aborted) return;
      if (written) {
        await index(funes, abort.signal, environment);
        written = false;
        log("index: ok");
      }
      if (publishing) {
        publishing = false;
        await push();
      }
      if (failed) throw failed;
      if (swept) {
        await replace(mark, String(swept));
        swept = 0;
      }
      retry = retryStart;
    } catch (error) {
      if (abort.signal.aborted) return;
      log(`retry in ${retry}ms: ${reason(error)}`);
      timer = setTimeout(() => { timer = undefined; wake(); }, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60_000);
    }
  }
  // The first push to a freshly bound memory is `funes add`'s or `funes bind`'s, at a terminal;
  // funes refuses it from here, and says so in the log, until one has been made.
  async function push() {
    log(`push: start (${memory})`);
    try { await publish(funes, memory, LOG, environment); } catch (error) { log(`push: ${reason(error)}`); }
  }
  return {
    start: wake,
    idle(id: string) {
      if (abort.signal.aborted) return;
      pending.add(id);
      // The next drain lists again, so a session this event is not about is caught too.
      sweep = true;
      wake();
    },
    async dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      clearTimeout(timer);
      await running;
      if (memory) await push();
    },
  };
}

// OpenCode 2 hands a plugin no client. Sessions are read through the background service the
// plugin runs in, which registers its URL and password in the XDG state directory
// (packages/client/src/service.ts); another process's registration is not this server.
function service(): { url: string; password?: string } | undefined {
  try {
    const file = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");
    const info = JSON.parse(readFileSync(file, "utf8"));
    return info.pid === process.pid ? info : undefined;
  } catch { return undefined; }
}

// `opencode --standalone` serves the same API and writes no service.json. The password is
// removed from the environment once read, so it is taken from the command this process was
// started with. The port is whichever loopback socket this process is listening on that
// answers `/api/info`.
function startedPassword() {
  if (process.env.OPENCODE_PASSWORD) return process.env.OPENCODE_PASSWORD;
  try {
    const started = execFileSync("/bin/ps", ["eww", "-o", "command=", "-p", String(process.pid)], { encoding: "utf8" });
    return /(?:^|\s)OPENCODE_PASSWORD=(\S+)/.exec(started)?.[1];
  } catch { return undefined; }
}

function listeningPorts() {
  let listing = "";
  for (const bin of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try { listing = execFileSync(bin, ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }); break; }
    catch { /* the next path, or lsof is not installed */ }
  }
  const ports: number[] = [];
  for (const line of listing.split("\n")) {
    const match = /^n(?:\*|\[::\]|\[::1\]|127\.0\.0\.1|localhost):(\d+)$/.exec(line.trim());
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

async function standalone(): Promise<{ url: string; password?: string } | undefined> {
  const password = startedPassword();
  const headers = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : undefined;
  for (const port of listeningPorts()) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/api/info`, { headers, signal: AbortSignal.timeout(2000) });
      if (response.ok) return { url, password };
    } catch { /* not this port */ }
  }
  return undefined;
}

// The OpenCode 2 plugin context (packages/plugin/src/promise), as far as it is used here.
type Context = {
  location: { directory: string };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string; status?: { type: string } } }> };
  mcp: { transform(edit: (editor: { get(name: string): object | undefined; set(name: string, config: { type: "local"; command: string[]; environment?: Record<string, string> }): void }) => void): Promise<void> };
};

// The events that end a session's run in OpenCode 2, and the one its docs name for going idle.
const ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]);

// One default export for both: OpenCode 2 calls `setup`, OpenCode 1.18.29 and newer call `server`.
const plugin: PluginModule & { id: string; setup(ctx: Context): Promise<(() => Promise<void>) | undefined> } = {
  id: "funes",
  async setup(ctx) {
    // Replayable: only registers when no `funes` server, disabled or custom, is configured.
    await ctx.mcp.transform(editor => { if (!editor.get("funes")) editor.set("funes", { type: "local", command, environment }); });
    if (!spool) return void log("no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
    const abort = new AbortController();
    const waiting: string[] = [];
    let run: ReturnType<typeof sync> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    // Subscribed before the server is known: a session that ends while this plugin looks for it
    // is queued, then either listed as changed or seen ending, never lost between the two.
    void (async () => {
      try {
        // A session has gone idle when its execution ends. 2.0.20 publishes no `session.idle`
        // or `session.status`, which its schema declares; they are taken too, should one appear.
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const idle = ENDED.has(event.type) || (event.type === "session.status" && event.data?.status?.type === "idle");
          const id = event.data?.sessionID;
          if (!idle || !id) continue;
          if (run) run.idle(id);
          else waiting.push(id);
        }
      } catch (error) { if (!abort.signal.aborted) log(`events: ${reason(error)}`); }
    })();
    const attach = (found: { url: string; password?: string }) => {
      if (run || abort.signal.aborted) return;
      const headers = found.password ? { authorization: `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}` } : undefined;
      run = sync(ctx.location.directory, sourceV2(found.url, undefined, headers));
      for (const id of waiting) run.idle(id);
      waiting.length = 0;
      run.start();
    };
    // The server may not be listening when the plugin loads. Look again for two minutes.
    const look = async () => {
      if (abort.signal.aborted || run) return;
      const found = service() ?? await standalone();
      if (found) return attach(found);
      attempts++;
      if (attempts === 1) log("no background service registration names this process, so sessions are not indexed until its server answers; OpenCode 2 reads them through the service it runs as");
      if (attempts >= 60) return void log("giving up on finding this process's OpenCode server; sessions are not indexed");
      timer = setTimeout(() => { timer = undefined; void look(); }, 2000);
      timer.unref();
    };
    await look();
    return async () => { abort.abort(); clearTimeout(timer); await run?.dispose(); };
  },
  async server({ client, directory }: PluginInput) {
    const run = spool ? sync(directory, sourceV1(client, directory)) : undefined;
    if (!spool) log("no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
    run?.start();
    return {
      config: async config => {
        config.mcp ??= {};
        config.mcp.funes ??= { type: "local", command, environment, enabled: true };
      },
      event: async ({ event }) => {
        if (event.type === "session.idle") run?.idle(event.properties.sessionID);
      },
      dispose: async () => run?.dispose(),
    };
  },
};

export default plugin;
