import { describe, expect, it } from 'vitest';
import {
  handlePutFile,
  handleGetFile,
  handleGetUploadUrl,
} from '@/mcp/storage-tool-registrations';
import type { BucketStore } from '@/services/storage/bucket-store';

class FakeBucket implements BucketStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async presignGet(key: string, expiresIn: number): Promise<string> {
    return `https://bucket.test/${key}?exp=${expiresIn}`;
  }
  async presignPut(key: string, expiresIn: number): Promise<string> {
    return `https://bucket.test/${key}?put&exp=${expiresIn}`;
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('Object-storage tools', () => {
  it('put-file stores decoded bytes, infers MIME, returns a URL + markdown', async () => {
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, { path: '/01-raw/doc.pdf', content: b64('hello pdf') });

    expect(res.success).toBe(true);
    expect(res.data!.key).toBe('01-raw/doc.pdf'); // leading slash stripped
    expect(res.data!.content_type).toBe('application/pdf');
    expect(bucket.objects.get('01-raw/doc.pdf')?.body.toString()).toBe('hello pdf');
    expect(res.data!.url).toContain('01-raw/doc.pdf');
  });

  it('put-file builds an image markdown snippet for images', async () => {
    const res = await handlePutFile(new FakeBucket(), { path: 'photo.png', content: b64('x') });
    expect(res.data!.content_type).toBe('image/png');
    expect((res.data!.markdown as string).startsWith('![')).toBe(true);
  });

  it('put-file strips a data: URI prefix and decodes the real bytes', async () => {
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, {
      path: 'img/p.png',
      content: `data:image/png;base64,${b64('hello')}`,
    });
    expect(res.success).toBe(true);
    expect(bucket.objects.get('img/p.png')?.body.toString()).toBe('hello');
  });

  it('put-file rejects non-base64 content instead of storing garbage', async () => {
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, { path: 'x.bin', content: 'not really base64 !!!@@@' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/base64/i);
    expect(bucket.objects.size).toBe(0);
  });

  it('put-file rejects empty / whitespace-only content', async () => {
    const res = await handlePutFile(new FakeBucket(), { path: 'x.bin', content: '   ' });
    expect(res.success).toBe(false);
  });

  it('put-file rejects files over the 10 MB limit', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const res = await handlePutFile(new FakeBucket(), { path: 'big.bin', content: big });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too large/i);
  });

  it('put-file rejects real path-traversal segments', async () => {
    const res = await handlePutFile(new FakeBucket(), { path: '../escape.png', content: b64('x') });
    expect(res.success).toBe(false);
  });

  it('put-file accepts filenames that merely contain ".." (not a traversal segment)', async () => {
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, { path: '01-raw/report..2024.pdf', content: b64('x') });
    expect(res.success).toBe(true);
    expect(res.data!.key).toBe('01-raw/report..2024.pdf');
  });

  it('put-file rejects control characters in the path', async () => {
    const res = await handlePutFile(new FakeBucket(), {
      path: `a${String.fromCharCode(0)}b.png`,
      content: b64('x'),
    });
    expect(res.success).toBe(false);
  });

  it('put-file ignores a bogus mime_type and infers from the extension', async () => {
    const res = await handlePutFile(new FakeBucket(), {
      path: 'a.png',
      content: b64('x'),
      mime_type: 'totally bogus',
    });
    expect(res.data!.content_type).toBe('image/png');
  });

  it('put-file escapes markdown-significant chars in the snippet label', async () => {
    const res = await handlePutFile(new FakeBucket(), { path: 'a(b).png', content: b64('x') });
    expect(res.data!.markdown).toContain('a\\(b\\).png');
  });

  it('get-file returns a presigned URL with no existence pre-check', async () => {
    const res = await handleGetFile(new FakeBucket(), { path: 'img/x.png' });
    expect(res.success).toBe(true);
    expect(res.data!.url).toContain('img/x.png');
  });

  it('get-file defaults to 1 hour and clamps over-long / non-finite lifetimes', async () => {
    const bucket = new FakeBucket();
    expect((await handleGetFile(bucket, { path: 'a' })).data!.expires_in).toBe(3600);
    expect((await handleGetFile(bucket, { path: 'a', expires_in: 99_999_999 })).data!.expires_in).toBe(
      604800,
    );
    expect((await handleGetFile(bucket, { path: 'a', expires_in: NaN })).data!.expires_in).toBe(3600);
    expect((await handleGetFile(bucket, { path: 'a', expires_in: 1.9 })).data!.expires_in).toBe(1);
  });

  it('get-upload-url returns a presigned PUT URL + content-type hint', async () => {
    const res = await handleGetUploadUrl(new FakeBucket(), { path: '/01-raw/docs/contrat.pdf' });
    expect(res.success).toBe(true);
    expect(res.data!.key).toBe('01-raw/docs/contrat.pdf');
    expect(res.data!.method).toBe('PUT');
    expect(res.data!.content_type).toBe('application/pdf');
    expect(res.data!.url ?? res.data!.upload_url).toBeDefined();
    expect(res.data!.upload_url).toContain('put');
  });

  it('get-upload-url rejects path traversal', async () => {
    const res = await handleGetUploadUrl(new FakeBucket(), { path: '../escape.png' });
    expect(res.success).toBe(false);
  });
});
