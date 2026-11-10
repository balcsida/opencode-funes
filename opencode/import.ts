#!/usr/bin/env bun
// Import every OpenCode session into the spool recorded beside this file, at `setup add`.
// A running server is read through its API. Otherwise OpenCode 2's database is, which is how
// history is imported while OpenCode is not running. The plugin's next start sweeps again.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backfill, index, sourceSqlite, sourceV2 } from "./core";

const here = import.meta.dirname;
const read = (name: string) => { try { return readFileSync(join(here, name), "utf8").trim(); } catch { return ""; } };

// `undefined` when no server of ours is up, so the database is tried. A server that answers,
// even with nothing to convert, is a number.
async function fromServer(): Promise<number | undefined> {
  const file = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");
  if (!existsSync(file)) return;
  let info: { url?: string; pid?: number; password?: string };
  try { info = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!info.url || !info.pid) return;
  try { process.kill(info.pid, 0); } catch { return; }
  const headers = info.password ? { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` } : undefined;
  return await backfill(sourceV2(info.url, undefined, headers), read("spool"));
}

async function fromDatabase(): Promise<number> {
  const file = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
  if (!existsSync(file)) return 0;
  return await backfill(await sourceSqlite(file), read("spool"));
}

const spool = read("spool");
if (!spool) throw new Error("no spool is recorded beside this plugin");
let written: number | undefined;
try { written = await fromServer(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
if (written === undefined) written = await fromDatabase();
console.log(`imported ${written} OpenCode sessions into ${spool}`);
if (written) {
  const origin = [process.env.HF_HUB_USER_AGENT_ORIGIN, "funes; agent/opencode"].filter(Boolean).join("; ");
  await index(read("bin") || "funes", undefined, { HF_HUB_USER_AGENT_ORIGIN: origin });
}
