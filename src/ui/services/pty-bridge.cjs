#!/usr/bin/env node
/**
 * PTY bridge — runs under Node.js (not Bun) so that node-pty's
 * libuv-based callbacks work correctly.
 *
 * Protocol (newline-delimited JSON over stdin/stdout):
 *   Parent → Bridge:  { type: "input", data: "..." }
 *                      { type: "resize", cols: N, rows: N }
 *   Bridge → Parent:  { type: "data", data: "..." }
 *                      { type: "exit", code: N }
 *
 * Usage: node pty-bridge.cjs '{"cmd":"claude","args":[],"cols":120,"rows":30,"cwd":"/config"}'
 */

const pty = require("node-pty");
const config = JSON.parse(process.argv[2] || "{}");

const cmd = config.cmd || "claude";
const args = config.args || [];
const cols = config.cols || 120;
const rows = config.rows || 30;
const cwd = config.cwd || process.env.HOME || "/tmp";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const term = pty.spawn(cmd, args, {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: process.env,
});

term.onData(function (data) {
  send({ type: "data", data: data });
});

term.onExit(function (e) {
  send({ type: "exit", code: e.exitCode });
  // Give parent a moment to read, then exit
  setTimeout(function () { process.exit(0); }, 500);
});

// Read commands from stdin (newline-delimited JSON)
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "input" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        term.resize(msg.cols, msg.rows);
      }
    } catch (e) {
      process.stderr.write("bridge parse error: " + e.message + "\n");
    }
  }
});

process.stdin.on("end", function () {
  try { term.kill(); } catch (e) {}
  process.exit(0);
});
