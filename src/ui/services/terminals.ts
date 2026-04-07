import { getSettings } from "../../config";
import { buildChildEnv, buildSecurityArgs } from "../../runner";

interface TerminalState {
  id: string;
  sessionId: string | null;
  label: string;
  dangerous: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
  busy: boolean;
  outputBuffer: Array<{ role: string; text: string }>;
}

const terminals = new Map<string, TerminalState>();
let counter = 0;

const MAX_TERMINALS = 10;
const MAX_BUFFER = 500;

export function createTerminal(opts?: { label?: string; dangerous?: boolean }): {
  id: string;
  label: string;
  dangerous: boolean;
} {
  if (terminals.size >= MAX_TERMINALS) {
    throw new Error(`Terminal limit reached (${MAX_TERMINALS})`);
  }
  counter++;
  const id = crypto.randomUUID();
  const dangerous = opts?.dangerous ?? false;
  const label = opts?.label || (dangerous ? `Dangerous ${counter}` : `Terminal ${counter}`);
  terminals.set(id, {
    id,
    sessionId: null,
    label,
    dangerous,
    proc: null,
    busy: false,
    outputBuffer: [],
  });
  return { id, label, dangerous };
}

export function listTerminals(): Array<{
  id: string;
  label: string;
  sessionId: string | null;
  dangerous: boolean;
  busy: boolean;
  messageCount: number;
}> {
  return Array.from(terminals.values()).map((t) => ({
    id: t.id,
    label: t.label,
    sessionId: t.sessionId,
    dangerous: t.dangerous,
    busy: t.busy,
    messageCount: t.outputBuffer.length,
  }));
}

export function getTerminal(id: string): TerminalState | undefined {
  return terminals.get(id);
}

export async function sendMessage(
  id: string,
  message: string,
  onChunk: (text: string) => void,
  onSession: (sessionId: string) => void
): Promise<void> {
  const terminal = terminals.get(id);
  if (!terminal) throw new Error("Terminal not found");
  if (terminal.busy) throw new Error("Terminal is busy");

  terminal.busy = true;
  terminal.outputBuffer.push({ role: "user", text: message });
  trimBuffer(terminal);

  try {
    const { security, model, api } = getSettings();

    const args = ["claude", "-p", message, "--output-format", "stream-json", "--verbose"];

    if (terminal.sessionId) {
      args.push("--resume", terminal.sessionId);
    }

    if (terminal.dangerous) {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push(...buildSecurityArgs(security));
    }

    const normalizedModel = model.trim().toLowerCase();
    if (model.trim() && normalizedModel !== "glm") {
      args.push("--model", model.trim());
    }

    const { CLAUDECODE: _, ...cleanEnv } = process.env;
    const childEnv = buildChildEnv(cleanEnv as Record<string, string>, model, api);

    console.log(
      `[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: running (session: ${terminal.sessionId?.slice(0, 8) ?? "new"})`
    );

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    });
    terminal.proc = proc;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;

          if (event.type === "system" && (event.subtype === "init" || event.session_id)) {
            const sid = event.session_id as string | undefined;
            if (sid && !terminal.sessionId) {
              terminal.sessionId = sid;
              onSession(sid);
              console.log(
                `[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: session ${sid}`
              );
            }
          } else if (event.type === "assistant") {
            type ContentBlock = { type: string; text?: string };
            const msg = event.message as { content?: ContentBlock[] } | undefined;
            const blocks = msg?.content ?? [];
            for (const block of blocks) {
              if (block.type === "text" && block.text) {
                onChunk(block.text);
                fullText += block.text;
              }
            }
          } else if (event.type === "result") {
            const resultText = (event as Record<string, unknown>).result as string | undefined;
            if (resultText && !fullText) {
              onChunk(resultText);
              fullText = resultText;
            }
          }
        } catch {}
      }
    }

    await proc.exited;

    if (fullText) {
      terminal.outputBuffer.push({ role: "assistant", text: fullText });
      trimBuffer(terminal);
    }

    console.log(`[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: done`);
  } finally {
    terminal.proc = null;
    terminal.busy = false;
  }
}

export function killTerminal(id: string): boolean {
  const terminal = terminals.get(id);
  if (!terminal) return false;

  if (terminal.proc) {
    try {
      terminal.proc.kill("SIGTERM");
    } catch {}
  }

  terminals.delete(id);
  console.log(`[${new Date().toLocaleTimeString()}] Terminal ${terminal.label}: killed`);
  return true;
}

function trimBuffer(terminal: TerminalState): void {
  if (terminal.outputBuffer.length > MAX_BUFFER) {
    terminal.outputBuffer = terminal.outputBuffer.slice(-MAX_BUFFER);
  }
}
