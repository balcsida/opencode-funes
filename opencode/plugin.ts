import type { Plugin } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, index, listSessions } from "./core";

// What `setup add` recorded beside this plugin, or "" when it recorded nothing.
function bound(name: string) {
  try { return readFileSync(join(import.meta.dir, name), "utf8").trim(); } catch { return ""; }
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
        for (const session of await listSessions(client, directory, abort.signal)) pending.add(session.id);
        sweep = false;
      }
      while (pending.size && !abort.signal.aborted) {
        const id = pending.values().next().value!;
        pending.delete(id); // An idle during the conversion re-adds this ID for a fresh snapshot.
        try { if (await emit(client, directory, id, spool, import.meta.dir, abort.signal)) written = true; }
        catch (error) { pending.add(id); throw error; }
      }
      if (written && !abort.signal.aborted) {
        await index(funes, abort.signal);
        written = false;
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
