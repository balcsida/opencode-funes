import type { PluginInput, PluginModule } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { emit, index, replace, sourceV1, sourceV2, type Source } from "./core";

const here = import.meta.dirname;

// What is recorded beside this plugin under `name`, by `setup add` or by the plugin itself, or ""
// when nothing is.
function bound(name: string) {
  try { return readFileSync(resolve(here, name), "utf8").trim(); } catch { return ""; }
}

// A line in the log beside this plugin: OpenCode shows a plugin's console nowhere.
function log(line: string) {
  try { appendFileSync(join(here, "funes-sync.log"), `${new Date().toISOString()} ${line}\n`); } catch {}
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const funes = bound("bin") || "funes";
const memory = bound("memory");
// The directory funes drains for this install. A plugin `funes add` did not install has none,
// and converts nothing.
const spool = bound("spool");
const command = [funes, "mcp", ...(memory ? [memory] : [])];

// What both OpenCodes share once they have handed over a source: from `start`, the sessions of
// `directory` changed since the last sweep are converted, then each session of it as it goes
// idle, and funes indexes what was written. Every event reaches every project's instance of
// this plugin; a session of another project is that project's instance's to convert.
function sync(directory: string, source: Source) {
  const pending = new Set<string>();
  const abort = new AbortController();
  let sweep = true;
  // When the last sweep of this directory to finish had started: the sessions unchanged since
  // are funes's already. funes drains the spool, so only a mark kept here can say so.
  const mark = join(here, "swept", createHash("sha1").update(directory).digest("hex"));
  // When the sweep in progress started, until the mark says so.
  let swept = 0;
  // Whether the spool holds turns funes has not been asked to index.
  let written = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 1000;

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
        for (const session of sessions) if (session.updated > since) pending.add(session.id);
        sweep = false;
        log(`sweep ${directory}: ${pending.size} of ${sessions.length} sessions changed since ${since}`);
      }
      // A session that cannot be converted waits for the retry, and keeps nothing from funes:
      // what the others wrote is indexed first.
      let failed: unknown;
      for (const id of [...pending]) {
        if (abort.signal.aborted) return;
        pending.delete(id); // An idle during the conversion re-adds this ID for a fresh snapshot.
        try { if (await emit(source, id, spool, here, abort.signal, directory)) written = true; }
        catch (error) { pending.add(id); failed ??= error; log(`convert ${id}: ${reason(error)}`); }
      }
      if (abort.signal.aborted) return;
      if (written) {
        await index(funes, abort.signal);
        written = false;
        log("index: ok");
      }
      if (failed) throw failed;
      if (swept) {
        await replace(mark, String(swept));
        swept = 0;
      }
      retry = 1000;
    } catch (error) {
      if (abort.signal.aborted) return;
      log(`retry in ${retry}ms: ${reason(error)}`);
      timer = setTimeout(() => { timer = undefined; wake(); }, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60_000);
    }
  }
  return {
    start: wake,
    idle(id: string) {
      if (abort.signal.aborted) return;
      pending.add(id);
      wake();
    },
    async dispose() {
      abort.abort();
      clearTimeout(timer);
      await running;
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

// The OpenCode 2 plugin context (packages/plugin/src/promise), as far as it is used here.
type Context = {
  location: { directory: string };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string; status?: { type: string } } }> };
  mcp: { transform(edit: (editor: { get(name: string): unknown; set(name: string, config: { type: "local"; command: string[] }): void }) => void): Promise<unknown> };
};

// The events that end a session's run in OpenCode 2, and the one its docs name for going idle.
const ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]);

// One default export for both: OpenCode 2 calls `setup`, OpenCode 1.18.29 and newer call `server`.
const plugin: PluginModule & { id: string; setup(ctx: Context): Promise<(() => Promise<void>) | undefined> } = {
  id: "funes",
  async setup(ctx) {
    // Replayable: only registers when no `funes` server, disabled or custom, is configured.
    await ctx.mcp.transform(editor => { if (!editor.get("funes")) editor.set("funes", { type: "local", command }); });
    if (!spool) return void log("no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
    const found = service();
    if (!found) return void log("no background service registration names this process, so sessions are not indexed; OpenCode 2 reads them through the service it runs as");
    const headers = found.password ? { authorization: `Basic ${Buffer.from(`opencode:${found.password}`).toString("base64")}` } : undefined;
    const { directory } = ctx.location;
    const run = sync(directory, sourceV2(found.url, directory, headers));
    const abort = new AbortController();
    // Subscribed before the sweep lists: a session that ends while this plugin loads is either
    // listed as changed or seen ending, never lost between the two.
    void (async () => {
      try {
        // A session has gone idle when its execution ends. 2.0.20 publishes no `session.idle`
        // or `session.status`, which its schema declares; they are taken too, should one appear.
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const idle = ENDED.has(event.type) || (event.type === "session.status" && event.data?.status?.type === "idle");
          if (idle && event.data?.sessionID) run.idle(event.data.sessionID);
        }
      } catch (error) { if (!abort.signal.aborted) log(`events: ${reason(error)}`); }
    })();
    run.start();
    return async () => { abort.abort(); await run.dispose(); };
  },
  async server({ client, directory }: PluginInput) {
    const run = spool ? sync(directory, sourceV1(client, directory)) : undefined;
    if (!spool) log("no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
    run?.start();
    return {
      config: async config => {
        config.mcp ??= {};
        config.mcp.funes ??= { type: "local", command, enabled: true };
      },
      event: async ({ event }) => {
        if (event.type === "session.idle") run?.idle(event.properties.sessionID);
      },
      dispose: async () => run?.dispose(),
    };
  },
};

export default plugin;
