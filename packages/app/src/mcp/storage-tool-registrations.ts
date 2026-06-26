import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { ToolResponse } from '@/mcp/handlers';
import type { BucketStore } from '@/services/storage/bucket-store';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap on base64 uploads
const MAX_EXPIRY = 604800; // 7 days — the SigV4 presigned-URL maximum
const DEFAULT_GET_EXPIRY = 3600; // 1 hour — a presigned URL is a bearer credential
const DEFAULT_PUT_EXPIRY = 3600; // 1 hour — upload URLs are used immediately

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
};

const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+$/i;

/** True if the string contains an ASCII control character (0x00–0x1F or 0x7F). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Extension lookup from the basename only (so `a/b.c/file` and dotfiles behave). */
function inferMime(key: string): string {
  const base = key.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

function normalizeKey(p: string): string {
  const key = p.replace(/^\/+/, '').trim();
  if (!key) throw new Error(`Invalid path: "${p}"`);
  // Reject genuine traversal segments only — not any ".." substring (so
  // "report..2024.pdf" is fine; S3 keys are a flat namespace anyway).
  if (key.split('/').some(seg => seg === '..' || seg === '.')) {
    throw new Error(`Invalid path (traversal segment): "${p}"`);
  }
  if (hasControlChars(key)) throw new Error(`Invalid path (control character): "${p}"`);
  if (Buffer.byteLength(key, 'utf8') > 1024) throw new Error('Key too long (max 1024 bytes).');
  return key;
}

/**
 * Decode caller-supplied content. Strips a `data:...;base64,` prefix (LLM clients
 * commonly emit those) and validates the payload is canonical base64 — Node's
 * decoder is lenient and would otherwise turn invalid input into silent garbage.
 */
function decodeBase64(input: string): { body: Buffer } | { error: string } {
  const cleaned = input.replace(/^data:[^;,]*;base64,/, '').replace(/\s/g, '');
  if (cleaned === '') return { error: 'Empty content (expected base64-encoded bytes).' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return { error: 'content is not valid base64.' };
  const body = Buffer.from(cleaned, 'base64');
  if (body.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
    return { error: 'content is not valid base64 (non-canonical or truncated).' };
  }
  return { body };
}

function mdSnippet(key: string, url: string, contentType: string): string {
  const name = (key.split('/').pop() ?? key).replace(/[[\]()\\]/g, '\\$&');
  return contentType.startsWith('image/') ? `![${name}](${url})` : `[${name}](${url})`;
}

function clampExpiry(value: number | undefined, fallback: number): number {
  const raw = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(Math.max(raw, 1), MAX_EXPIRY);
}

const ok = (data: Record<string, unknown>): ToolResponse => ({
  success: true,
  data,
  metadata: { timestamp: new Date().toISOString() },
});
const fail = (error: string): ToolResponse => ({
  success: false,
  error,
  metadata: { timestamp: new Date().toISOString() },
});

export async function handlePutFile(
  store: BucketStore,
  args: { path: string; content: string; mime_type?: string },
): Promise<ToolResponse> {
  try {
    const decoded = decodeBase64(args.content);
    if ('error' in decoded) return fail(decoded.error);
    const body = decoded.body;
    if (body.length > MAX_BYTES) {
      return fail(
        `File too large: ${body.length} bytes (max ${MAX_BYTES}). Upload large files directly with a presigned URL instead.`,
      );
    }
    const key = normalizeKey(args.path);
    // Trust a caller-supplied mime_type only if it looks like a real MIME; else infer.
    const contentType =
      args.mime_type && MIME_RE.test(args.mime_type) ? args.mime_type : inferMime(key);
    await store.put(key, body, contentType);
    const url = await store.presignGet(key, MAX_EXPIRY);
    return ok({
      key,
      bytes: body.length,
      content_type: contentType,
      url,
      expires_in: MAX_EXPIRY,
      markdown: mdSnippet(key, url, contentType),
    });
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
}

export async function handleGetFile(
  store: BucketStore,
  args: { path: string; expires_in?: number },
): Promise<ToolResponse> {
  try {
    const key = normalizeKey(args.path);
    const expiresIn = clampExpiry(args.expires_in, DEFAULT_GET_EXPIRY);
    // Presigning is offline and never contacts the bucket; the URL itself 404s if
    // the key is absent, so we don't pre-check existence (it only added a network
    // round-trip and a misleading "not found" on auth/network errors).
    const url = await store.presignGet(key, expiresIn);
    return ok({ key, url, expires_in: expiresIn });
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
}

export async function handleGetUploadUrl(
  store: BucketStore,
  args: { path: string; expires_in?: number; content_type?: string },
): Promise<ToolResponse> {
  try {
    const key = normalizeKey(args.path);
    const expiresIn = clampExpiry(args.expires_in, DEFAULT_PUT_EXPIRY);
    const uploadUrl = await store.presignPut(key, expiresIn);
    const contentType =
      args.content_type && MIME_RE.test(args.content_type) ? args.content_type : inferMime(key);
    return ok({
      key,
      upload_url: uploadUrl,
      method: 'PUT',
      content_type: contentType,
      expires_in: expiresIn,
      hint: `curl -X PUT --upload-file <file> -H "Content-Type: ${contentType}" "${uploadUrl}"`,
    });
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
}

export async function handleDeleteFile(
  store: BucketStore,
  args: { path: string; confirm?: boolean },
): Promise<ToolResponse> {
  try {
    if (args.confirm !== true) {
      return fail('Refusing to delete: set confirm: true to remove this file.');
    }
    const key = normalizeKey(args.path);
    await store.delete(key);
    return ok({ deleted: key });
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
}

/**
 * Registers the object-storage tools. Imported ONLY from the http/stdio
 * entrypoints (never the lambda bundle), so the AWS S3 SDK stays out of the
 * Lambda build. No `outputSchema` is declared — the JSON travels in the text
 * content, avoiding the -32602 masking that bit the LLM tools.
 */
export function registerStorageTools(server: McpServer, store: BucketStore): void {
  server.registerTool(
    'put-file',
    {
      title: 'Put File (bucket)',
      description:
        'Upload a binary file (base64, optionally a data: URI) to the object-storage bucket and get back a shareable presigned URL + a ready-to-paste markdown link. Use this for images, PDFs, and other binaries instead of committing them to the vault.',
      inputSchema: {
        path: z.string().describe('Destination key in the bucket, e.g. "01-raw/images/photo.png"'),
        content: z.string().describe('File bytes, base64-encoded (max 10 MB)'),
        mime_type: z
          .string()
          .optional()
          .describe('MIME type; inferred from the extension when omitted or invalid'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async args => formatToolResult(await handlePutFile(store, args)),
  );

  server.registerTool(
    'get-file',
    {
      title: 'Get File (bucket)',
      description:
        'Return a time-limited presigned download URL for a file stored in the object-storage bucket.',
      inputSchema: {
        path: z.string().describe('Key of the file in the bucket'),
        expires_in: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Presigned URL lifetime in seconds (default 3600, max 604800 = 7 days)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async args => formatToolResult(await handleGetFile(store, args)),
  );

  server.registerTool(
    'get-upload-url',
    {
      title: 'Get Upload URL (bucket)',
      description:
        'Return a presigned PUT URL so a file can be uploaded straight to the object-storage bucket from a browser, app, or curl — the bytes never pass through the model. Use this when the user wants to put a photo/PDF/file into the cerveau but you cannot access its raw bytes.',
      inputSchema: {
        path: z.string().describe('Destination key in the bucket, e.g. "01-raw/docs/contrat.pdf"'),
        content_type: z
          .string()
          .optional()
          .describe('MIME type hint for the upload (inferred from the extension when omitted)'),
        expires_in: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Upload URL lifetime in seconds (default 3600, max 604800)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async args => formatToolResult(await handleGetUploadUrl(store, args)),
  );

  server.registerTool(
    'delete-file',
    {
      title: 'Delete File (bucket)',
      description: 'Delete a file from the object-storage bucket. Requires confirm: true.',
      inputSchema: {
        path: z.string().describe('Key of the file to delete'),
        confirm: z.boolean().describe('Must be true to confirm deletion'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async args => formatToolResult(await handleDeleteFile(store, args)),
  );
}
