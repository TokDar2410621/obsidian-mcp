import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatToolResult } from '@/mcp/tool-registrations';
import type { ToolResponse } from '@/mcp/handlers';
import type { BucketStore } from '@/services/storage/bucket-store';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap on base64 uploads
const MAX_EXPIRY = 604800; // 7 days — the SigV4 presigned-URL maximum

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

function inferMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

function normalizeKey(p: string): string {
  const key = p.replace(/^\/+/, '').trim();
  if (!key || key.includes('..')) throw new Error(`Invalid path: "${p}"`);
  return key;
}

function mdSnippet(key: string, url: string, contentType: string): string {
  const name = key.split('/').pop() ?? key;
  return contentType.startsWith('image/') ? `![${name}](${url})` : `[${name}](${url})`;
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
    const body = Buffer.from(args.content, 'base64');
    if (body.length === 0) return fail('Empty content (expected base64-encoded bytes).');
    if (body.length > MAX_BYTES) {
      return fail(
        `File too large: ${body.length} bytes (max ${MAX_BYTES}). Upload large files directly with a presigned URL instead.`,
      );
    }
    const key = normalizeKey(args.path);
    const contentType = args.mime_type || inferMime(key);
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
    if (!(await store.exists(key))) return fail(`No file at "${key}" in the bucket.`);
    const expiresIn = Math.min(Math.max(args.expires_in ?? MAX_EXPIRY, 1), MAX_EXPIRY);
    const url = await store.presignGet(key, expiresIn);
    return ok({ key, url, expires_in: expiresIn });
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
        'Upload a binary file (base64) to the object-storage bucket and get back a shareable presigned URL + a ready-to-paste markdown link. Use this for images, PDFs, and other binaries instead of committing them to the vault.',
      inputSchema: {
        path: z
          .string()
          .describe('Destination key in the bucket, e.g. "01-raw/images/photo.png"'),
        content: z.string().describe('File bytes, base64-encoded (max 10 MB)'),
        mime_type: z
          .string()
          .optional()
          .describe('MIME type; inferred from the extension when omitted'),
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
          .optional()
          .describe('Presigned URL lifetime in seconds (default and max 604800 = 7 days)'),
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
}
