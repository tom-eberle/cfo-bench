import { constants, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { ComptaError, ExitCode } from '../output/errors.js';

/** File types Compta accepts as justifying documents, and the only ones a plan may upload. */
export const UPLOAD_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.heic', '.webp']);

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
};

export function mimeType(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export interface UploadPolicy {
  /** Directory relative paths resolve against (the plan file's directory). */
  baseDir: string;
  cwd: string;
  /** Allow files outside baseDir and cwd (explicit opt-in: --allow-any-path). */
  allowAnyPath?: boolean;
}

function unsafe(message: string, hint?: string): ComptaError {
  return new ComptaError('UNSAFE_ATTACHMENT', message, { exitCode: ExitCode.usage, hint });
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Resolve an attach step's file to the real absolute path that will be uploaded.
 * A plan can come from an agent or a shared file, so it may only upload receipt
 * file types, and only from the plan's directory or the working directory
 * (symlinks resolved), unless the user explicitly allows any path.
 */
export function resolveUpload(file: string, policy: UploadPolicy): string {
  const candidate = isAbsolute(file) ? file : resolve(policy.baseDir, file);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ComptaError('FILE_NOT_FOUND', `File to attach not found: ${candidate}`, {
      exitCode: ExitCode.usage,
    });
  }
  if (!statSync(real).isFile()) throw unsafe(`Not a regular file: ${real}`);
  if (!UPLOAD_EXTENSIONS.has(extname(real).toLowerCase()))
    throw unsafe(
      `Refusing to upload ${real}: only ${[...UPLOAD_EXTENSIONS].join(', ')} files can be attached`,
    );
  if (
    !policy.allowAnyPath &&
    !isInside(real, realDir(policy.baseDir)) &&
    !isInside(real, realDir(policy.cwd))
  )
    throw unsafe(
      `Refusing to upload ${real}: it is outside the plan's directory and the current directory`,
      'move the file next to the plan, or re-run with --allow-any-path if you trust this plan',
    );
  return real;
}

export interface Upload {
  path: string;
  bytes: Uint8Array;
}

/**
 * Validate and read an upload in one go. The bytes sent are the bytes of the
 * file that was checked: the resolved path is opened without following
 * symlinks and must still be the same inode, so swapping the file between the
 * check and the read (TOCTOU) fails instead of uploading something else.
 */
export async function readUpload(file: string, policy: UploadPolicy): Promise<Upload> {
  const path = resolveUpload(file, policy);
  const checked = statSync(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw unsafe(`Could not open ${path} safely`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev)
      throw unsafe(`${path} changed while it was being checked; refusing to upload it`);
    return { path, bytes: new Uint8Array(await handle.readFile()) };
  } finally {
    await handle.close();
  }
}
