import * as pty from "node-pty";

interface TerminalState {
  id: string;
  label: string;
  dangerous: boolean;
  ptyProcess: pty.IPty;
  ws: Set<{ send: (data: string) => void }>;
}

const terminals = new Map<string, TerminalState>();
let counter = 0;

const MAX_TERMINALS = 10;
const SCROLLBACK_SIZE = 5000;

// Per-terminal scrollback buffer so new WS clients get history
const scrollback = new Map<string, string>();

function appendScrollback(id: string, data: string): void {
  const existing = scrollback.get(id) ?? "";
  const combined = existing + data;
  // Keep last ~200KB of output
  if (combined.length > 200_000) {
    scrollback.set(id, combined.slice(-200_000));
  } else {
    scrollback.set(id, combined);
  }
}

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

  const args: string[] = [];
  if (dangerous) {
    args.push("--dangerously-skip-permissions");
  }

  const ptyProcess = pty.spawn("claude", args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME || "/config",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as Record<string, string>,
  });

  const state: TerminalState = {
    id,
    label,
    dangerous,
    ptyProcess,
    ws: new Set(),
  };

  scrollback.set(id, "");

  ptyProcess.onData((data: string) => {
    appendScrollback(id, data);
    for (const ws of state.ws) {
      try {
        ws.send(JSON.stringify({ type: "output", data }));
      } catch {}
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const msg = `\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
    appendScrollback(id, msg);
    for (const ws of state.ws) {
      try {
        ws.send(JSON.stringify({ type: "output", data: msg }));
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      } catch {}
    }
  });

  terminals.set(id, state);
  console.log(
    `[${new Date().toLocaleTimeString()}] Terminal ${label}: created (${dangerous ? "dangerous" : "normal"}, ${cols}x${rows})`
  );

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
  return scrollback.get(id) ?? "";
}

export function attachWs(
  id: string,
  ws: { send: (data: string) => void }
): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.ws.add(ws);
  return true;
}

export function detachWs(
  id: string,
  ws: { send: (data: string) => void }
): void {
  const terminal = terminals.get(id);
  if (terminal) terminal.ws.delete(ws);
}

export function writeToTerminal(id: string, data: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  terminal.ptyProcess.write(data);
  return true;
}

export function resizeTerminal(
  id: string,
  cols: number,
  rows: number
): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;
  try {
    terminal.ptyProcess.resize(cols, rows);
  } catch {}
  return true;
}

export function killTerminal(id: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;

  try {
    terminal.ptyProcess.kill();
  } catch {}

  for (const ws of terminal.ws) {
    try {
      ws.send(JSON.stringify({ type: "exit", code: -1 }));
    } catch {}
  }

  terminals.delete(id);
  scrollback.delete(id);
  console.log(`[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: killed`);
  return true;
}
