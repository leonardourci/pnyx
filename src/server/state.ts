// Files that announce a running server and guard its writes: server.json and the
// ingest socket per board, and one local write token per install.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir, pnyxHome } from "../store/board-store.ts";

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  // Null when the ingest socket could not be bound; hooks then spool.
  socket: string | null;
}

export const infoPath = (board: string) => join(boardDir(board), "server.json");
export const socketPath = (board: string) => join(boardDir(board), "server.sock");

// The board's server, or null when none is running. A server.json left by a
// process that is gone counts as not running.
export function readServer(board: string): ServerInfo | null {
  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(infoPath(board), "utf8")) as ServerInfo;
    process.kill(info.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? info! : null;
  }
  return info;
}

// Created on first use, readable only by this user. Clients send it as a bearer token on writes.
export function localToken(): string {
  const path = join(pnyxHome(), "token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(pnyxHome(), { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Another process created it first; use theirs.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}
