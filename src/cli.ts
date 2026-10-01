#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { backfill, sourceV1, sourceV2 } from "../opencode/core";

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true,
    options: { url: { type: "string" }, directory: { type: "string" }, out: { type: "string" } } });
  if (positionals.length !== 1 || positionals[0] !== "backfill" || !values.url || !values.directory || !isAbsolute(values.directory) || !values.out) {
    throw new Error("Usage: opencode-funes backfill --url http://localhost:4096 --directory /absolute/project --out /directory/for/turns");
  }
  const url = new URL(values.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must use HTTP or HTTPS");
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const headers = password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` } : undefined;
  // OpenCode 2 serves its API under /api, where OpenCode 1 has nothing.
  const v2 = (await fetch(new URL("/api/info", url), { headers })).ok;
  const source = v2 ? sourceV2(url, values.directory, headers) : sourceV1(createOpencodeClient({ baseUrl: url.toString(), headers }), values.directory);
  const count = await backfill(source, values.out);
  console.log(`Converted ${count} OpenCode ${v2 ? 2 : 1} sessions into ${values.out}. Index them with: funes index ${values.out}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
