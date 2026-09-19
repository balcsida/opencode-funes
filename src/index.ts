import type { Plugin } from "@opencode-ai/plugin";
import { indexSession, listSessions } from "./core";

const plugin: Plugin = async ({ client, directory }, options) => {
  const executable = options?.funes ?? "funes";
  if (typeof executable !== "string" || !executable) throw new Error("funes must be an executable path or name");
  const funes = executable;
  const pending = new Set<string>();
  const abort = new AbortController();
  let sweep = true;
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
        pending.delete(id); // An idle during ingestion re-adds this ID for a fresh snapshot.
        try { await indexSession(client, directory, id, funes, abort.signal); }
        catch (error) { pending.add(id); throw error; }
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
  wake();
  return {
    config: async config => {
      config.mcp ??= {};
      config.mcp.funes ??= { type: "local", command: [funes, "mcp"], enabled: true };
    },
    event: async ({ event }) => {
      if (event.type === "session.idle" && !abort.signal.aborted) {
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
