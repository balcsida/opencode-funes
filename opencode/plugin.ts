import type { Plugin } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, index, listSessions } from "./core";

// What is recorded beside this plugin under `name`, by `setup add` or by the plugin itself, or ""
// when nothing is.
function bound(name: string) {
  try { return readFileSync(resolve(import.meta.dir, name), "utf8").trim(); } catch { return ""; }
}

// A line in the log beside this plugin: OpenCode shows a plugin's console nowhere.
function log(line: string) {
  try { appendFileSync(join(import.meta.dir, "funes-sync.log"), `${new Date().toISOString()} ${line}\n`); } catch {}
}
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plugin: Plugin = async ({ client, directory }) => {
  const funes = bound("bin") || "funes";
  const memory = bound("memory");
  // The directory funes drains for this install. A plugin `funes add` did not install has none,
  // and converts nothing.
  const spool = bound("spool");
  const pending = new Set<string>();
  const abort = new AbortController();
  let sweep = true;
  // When the last sweep of this directory to finish had started: the sessions unchanged since
  // are funes's already. funes drains the spool, so only a mark kept here can say so.
  const mark = join(import.meta.dir, "swept", createHash("sha1").update(directory).digest("hex"));
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
        const sessions = await listSessions(client, directory, abort.signal);
        for (const session of sessions) if (session.time.updated > since) pending.add(session.id);
        sweep = false;
        log(`sweep ${directory}: ${pending.size} of ${sessions.length} sessions changed since ${since}`);
      }
      // A session that cannot be converted waits for the retry, and keeps nothing from funes:
      // what the others wrote is indexed first.
      let failed: unknown;
      for (const id of [...pending]) {
        if (abort.signal.aborted) return;
        pending.delete(id); // An idle during the conversion re-adds this ID for a fresh snapshot.
        try { if (await emit(client, directory, id, spool, import.meta.dir, abort.signal)) written = true; }
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
        await Bun.write(mark, String(swept));
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
  if (spool) wake();
  else log("no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
  return {
    config: async config => {
      config.mcp ??= {};
      config.mcp.funes ??= { type: "local", command: [funes, "mcp", ...(memory ? [memory] : [])], enabled: true };
    },
    event: async ({ event }) => {
      if (spool && event.type === "session.idle" && !abort.signal.aborted) {
        pending.add(event.properties.sessionID);
        wake();
      }
    },
    dispose: async () => {
      abort.abort();
      clearTimeout(timer);
      await running;
    },
  };
};

export default plugin;
