/**
 * Terminal manager using a Node.js PTY bridge process.
 *
 * Bun doesn't integrate with libuv, so node-pty callbacks don't fire.
 * Instead we spawn a small Node.js helper that runs node-pty and communicates
 * via newline-delimited JSON over stdin/stdout.
 */

import { join } from "path";

interface WsLike {
  send: (data: string) => void;
}

interface TerminalState {
  id: string;
  label: string;
  dangerous: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
  ws: Set<WsLike>;
  scrollback: string;
  exited: boolean;
}

const terminals = new Map<string, TerminalState>();
let counter = 0;

const MAX_TERMINALS = 10;
const MAX_SCROLLBACK = 200_000;

// Path to the bridge script (lives next to this file)
const BRIDGE_SCRIPT = join(import.meta.dir, "pty-bridge.cjs");

export function createTerminal(opts?: {
  label?: string;
  dangerous?: boolean;
  cols?: number;
  rows?: number;
}): { id: string; label: string; dangerous: boolean } {
  if (terminals.size >= MAX_TERMINALS) {
    throw new Error(`Terminal limit reached (${MAX_TERMINALS})`);
  }

  counter++;
  const id = crypto.randomUUID();
  const dangerous = opts?.dangerous ?? false;
  const label = opts?.label || (dangerous ? `Dangerous ${counter}` : `Terminal ${counter}`);
  const cols = opts?.cols ?? 120;
  const rows = opts?.rows ?? 30;

  const state: TerminalState = {
    id,
    label,
    dangerous,
    proc: null,
    ws: new Set(),
    scrollback: "",
    exited: false,
  };

  terminals.set(id, state);

  // Every terminal runs with bypass permissions and in the daemon's cwd,
  // matching the behaviour of chat / telegram / discord / jobs.
  const claudeArgs: string[] = ["--dangerously-skip-permissions"];

  const bridgeConfig = JSON.stringify({
    cmd: "claude",
    args: claudeArgs,
    cols,
    rows,
    cwd: process.cwd(),
  });

  // Spawn the Node.js bridge process
  const proc = Bun.spawn(["node", BRIDGE_SCRIPT, bridgeConfig], {
    stdout: "pipe",
    stdin: "pipe",
    stderr: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string")
      ),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as Record<string, string>,
  });

  state.proc = proc;

  console.log(
    `[${new Date().toLocaleTimeString()}] Terminal ${label}: created (${dangerous ? "dangerous" : "normal"}, ${cols}x${rows}, bridge pid ${proc.pid})`
  );

  // Read stdout from bridge (newline-delimited JSON)
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "data") {
              const data = msg.data as string;
              state.scrollback += data;
              if (state.scrollback.length > MAX_SCROLLBACK) {
                state.scrollback = state.scrollback.slice(-MAX_SCROLLBACK);
              }
              const payload = JSON.stringify({ type: "output", data });
              for (const ws of state.ws) {
                try { ws.send(payload); } catch {}
              }
            } else if (msg.type === "exit") {
              state.exited = true;
              const exitMsg = `\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`;
              state.scrollback += exitMsg;
              const payload = JSON.stringify({ type: "output", data: exitMsg });
              const exitPayload = JSON.stringify({ type: "exit", code: msg.code });
              for (const ws of state.ws) {
                try { ws.send(payload); ws.send(exitPayload); } catch {}
              }
              console.log(`[${new Date().toLocaleTimeString()}] Terminal ${label}: claude exited (code ${msg.code})`);
            }
          } catch {}
        }
      }
    } catch {}
  })();

  // Read stderr for debugging
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) console.error(`[Terminal ${label} stderr] ${text.trim()}`);
      }
    } catch {}
  })();

  return { id, label, dangerous };
}

export function listTerminals(): Array<{
  id: string;
  label: string;
  dangerous: boolean;
}> {
  return Array.from(terminals.values()).map((t) => ({
    id: t.id,
    label: t.label,
    dangerous: t.dangerous,
  }));
}

export function getTerminal(id: string): TerminalState | undefined {
  return terminals.get(id);
}

export function getScrollback(id: string): string {
  return terminals.get(id)?.scrollback ?? "";
}

export function attachWs(id: string, ws: WsLike): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.ws.add(ws);
  return true;
}

export function detachWs(id: string, ws: WsLike): void {
  terminals.get(id)?.ws.delete(ws);
}

export function writeToTerminal(id: string, data: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal?.proc) return false;
  try {
    const msg = JSON.stringify({ type: "input", data }) + "\n";
    terminal.proc.stdin.write(msg);
    return true;
  } catch {
    return false;
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const terminal = terminals.get(id);
  if (!terminal?.proc) return false;
  try {
    const msg = JSON.stringify({ type: "resize", cols, rows }) + "\n";
    terminal.proc.stdin.write(msg);
    return true;
  } catch {
    return false;
  }
}

export function killTerminal(id: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;

  if (terminal.proc) {
    try { terminal.proc.kill(); } catch {}
  }

  for (const ws of terminal.ws) {
    try { ws.send(JSON.stringify({ type: "exit", code: -1 })); } catch {}
  }

  terminals.delete(id);
  console.log(`[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: killed`);
  return true;
}
