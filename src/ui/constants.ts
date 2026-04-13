import { join } from "path";

export const HEARTBEAT_DIR = join(process.cwd(), "claudeclaw");
export const LOGS_DIR = join(HEARTBEAT_DIR, "logs");
export const JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
export const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
export const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");
export const STATE_FILE = join(HEARTBEAT_DIR, "state.json");
export const ATTACHMENTS_DIR = join(HEARTBEAT_DIR, "attachments");
export const MAX_UPLOAD_BYTES = Number(process.env.CLAUDECLAW_MAX_UPLOAD_MB || "50") * 1024 * 1024;
