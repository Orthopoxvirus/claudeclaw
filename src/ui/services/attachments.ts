import { mkdir, readdir, rename, rm, stat } from "fs/promises";
import { join, basename } from "path";
import { ATTACHMENTS_DIR, JOBS_DIR, MAX_UPLOAD_BYTES } from "../constants";

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const PENDING_PREFIX = "_pending-";
const PENDING_RE = /^[a-zA-Z0-9]+$/;

function validateJobName(name: string): string {
  const jobName = String(name || "").trim();
  if (!SAFE_NAME_RE.test(jobName)) throw new Error("Invalid job name.");
  return jobName;
}

function validatePendingId(id: string): string {
  const pendingId = String(id || "").trim();
  if (!PENDING_RE.test(pendingId)) throw new Error("Invalid pending ID.");
  return pendingId;
}

function sanitizeFilename(raw: string): string {
  // Strip directory components
  let name = basename(raw.replace(/\\/g, "/"));
  // Remove anything that isn't alphanumeric, dot, dash, underscore, or space
  name = name.replace(/[^a-zA-Z0-9._\- ]/g, "_");
  // Reject traversal attempts
  if (name === "." || name === ".." || !name) throw new Error("Invalid filename.");
  // Truncate to 255 chars
  return name.slice(0, 255);
}

/** Write files into a directory, handling size checks and name collisions. */
async function writeFilesToDir(
  dir: string,
  files: File[],
): Promise<{ saved: string[]; errors: string[] }> {
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const sanitized = sanitizeFilename(file.name);

    if (file.size > MAX_UPLOAD_BYTES) {
      const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
      errors.push(`${sanitized}: exceeds ${limitMb} MB limit`);
      continue;
    }

    // Disambiguate collisions with timestamp prefix
    let targetName = sanitized;
    if (await Bun.file(join(dir, targetName)).exists()) {
      targetName = `${Date.now()}-${sanitized}`;
    }

    try {
      await Bun.write(join(dir, targetName), await file.arrayBuffer());
      saved.push(targetName);
    } catch (err) {
      errors.push(`${sanitized}: ${String(err)}`);
    }
  }

  return { saved, errors };
}

/** List files in a directory as {name, size} entries. */
async function listDir(dir: string): Promise<{ name: string; size: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const result: { name: string; size: number }[] = [];
  for (const entry of entries) {
    try {
      const info = await stat(join(dir, entry));
      if (info.isFile()) result.push({ name: entry, size: info.size });
    } catch { /* skip */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Job attachment operations (for existing jobs)
// ---------------------------------------------------------------------------

export async function uploadAttachments(
  jobName: string,
  files: File[],
): Promise<{ saved: string[]; errors: string[] }> {
  const name = validateJobName(jobName);
  const jobPath = join(JOBS_DIR, `${name}.md`);
  if (!(await Bun.file(jobPath).exists())) throw new Error("Job not found.");
  return writeFilesToDir(join(ATTACHMENTS_DIR, name), files);
}

export async function listAttachments(
  jobName: string,
): Promise<{ name: string; size: number }[]> {
  return listDir(join(ATTACHMENTS_DIR, validateJobName(jobName)));
}

export async function deleteAttachment(
  jobName: string,
  filename: string,
): Promise<void> {
  const name = validateJobName(jobName);
  const sanitized = sanitizeFilename(filename);
  await Bun.file(join(ATTACHMENTS_DIR, name, sanitized)).delete();
}

export async function deleteAllAttachments(jobName: string): Promise<void> {
  const dir = join(ATTACHMENTS_DIR, validateJobName(jobName));
  try {
    await rm(dir, { recursive: true, force: true });
  } catch { /* may not exist */ }
}

// ---------------------------------------------------------------------------
// Pending attachment operations (pre-job-creation staging)
// ---------------------------------------------------------------------------

function pendingDir(id: string): string {
  return join(ATTACHMENTS_DIR, `${PENDING_PREFIX}${validatePendingId(id)}`);
}

export async function uploadPendingAttachments(
  pendingId: string,
  files: File[],
): Promise<{ saved: string[]; errors: string[] }> {
  return writeFilesToDir(pendingDir(pendingId), files);
}

export async function listPendingAttachments(
  pendingId: string,
): Promise<{ name: string; size: number }[]> {
  return listDir(pendingDir(pendingId));
}

export async function deletePendingAttachment(
  pendingId: string,
  filename: string,
): Promise<void> {
  const sanitized = sanitizeFilename(filename);
  await Bun.file(join(pendingDir(pendingId), sanitized)).delete();
}

export async function cleanupPendingAttachments(pendingId: string): Promise<void> {
  try {
    await rm(pendingDir(pendingId), { recursive: true, force: true });
  } catch { /* may not exist */ }
}

/**
 * Move staged pending attachments to a real job's attachment directory.
 * No-op if the pending directory doesn't exist.
 */
export async function promotePendingAttachments(
  pendingId: string,
  jobName: string,
): Promise<void> {
  const src = pendingDir(pendingId);
  const dest = join(ATTACHMENTS_DIR, validateJobName(jobName));
  try {
    const entries = await readdir(src);
    if (entries.length === 0) {
      await rm(src, { recursive: true, force: true });
      return;
    }
  } catch {
    return; // no pending dir
  }

  // If job already has an attachment dir (shouldn't on fresh create, but be safe),
  // merge files into it rather than overwriting.
  let destExists = false;
  try {
    const info = await stat(dest);
    destExists = info.isDirectory();
  } catch { /* doesn't exist */ }

  if (destExists) {
    const files = await readdir(src);
    for (const f of files) {
      await rename(join(src, f), join(dest, f));
    }
    await rm(src, { recursive: true, force: true });
  } else {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    await rename(src, dest);
  }
}

// ---------------------------------------------------------------------------
// Prompt augmentation
// ---------------------------------------------------------------------------

/**
 * Read a job's attachment directory and return prompt lines referencing each file.
 * Returns the original prompt unchanged if no attachments exist.
 */
export async function augmentPromptWithAttachments(
  jobName: string,
  prompt: string,
): Promise<string> {
  const dir = join(ATTACHMENTS_DIR, jobName);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return prompt;
  }
  if (files.length === 0) return prompt;

  const references = files
    .map((f) => `File ${f} - @${join(dir, f)}`)
    .join("\n");

  return `${prompt}\n\n---\nAttached files:\n${references}`;
}
