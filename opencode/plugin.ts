import type { Plugin } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, index, listSessions } from "./core";

// What is recorded beside this plugin under `name`, by `setup add` or by the plugin itself, or ""
// when nothing is.
function bound(name: string) {
  try { return readFileSync(resolve(import.meta.dir, name), "utf8").trim(); } catch { return ""; }
}

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
        for (const session of await listSessions(client, directory, abort.signal)) if (session.time.updated > since) pending.add(session.id);
        sweep = false;
      }
      while (pending.size && !abort.signal.aborted) {
        const id = pending.values().next().value!;
        pending.delete(id); // An idle during the conversion re-adds this ID for a fresh snapshot.
        try { if (await emit(client, directory, id, spool, import.meta.dir, abort.signal)) written = true; }
        catch (error) { pending.add(id); throw error; }
      }
      if (abort.signal.aborted) return;
      if (written) {
        await index(funes, abort.signal);
        written = false;
      }
      if (swept) {
        await Bun.write(mark, String(swept));
        swept = 0;
      }
      retry = 1000;
    } catch (error) {
      if (abort.signal.aborted) return;
      console.warn("opencode-funes: indexing failed; retrying", error);
      timer = setTimeout(() => { timer = undefined; wake(); }, retry);
      timer.unref();
      retry = Math.min(retry * 2, 60_000);
    }
  }
  if (spool) wake();
  else console.warn("opencode-funes: no spool is recorded, so sessions are not indexed; install with `funes add opencode --from <bundle>`");
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
