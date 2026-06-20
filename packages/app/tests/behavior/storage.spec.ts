import { describe, expect, it } from 'vitest';
import { handlePutFile, handleGetFile } from '@/mcp/storage-tool-registrations';
import type { BucketStore } from '@/services/storage/bucket-store';

class FakeBucket implements BucketStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async presignGet(key: string, expiresIn: number): Promise<string> {
    return `https://bucket.test/${key}?exp=${expiresIn}`;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
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
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, { path: 'photo.png', content: b64('x') });

    expect(res.data!.content_type).toBe('image/png');
    expect((res.data!.markdown as string).startsWith('![')).toBe(true);
  });

  it('put-file rejects files over the 10 MB limit', async () => {
    const bucket = new FakeBucket();
    const big = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const res = await handlePutFile(bucket, { path: 'big.bin', content: big });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too large/i);
  });

  it('put-file rejects path traversal', async () => {
    const bucket = new FakeBucket();
    const res = await handlePutFile(bucket, { path: '../escape.png', content: b64('x') });
    expect(res.success).toBe(false);
  });

  it('get-file returns a presigned URL for an existing object', async () => {
    const bucket = new FakeBucket();
    await bucket.put('img/x.png', Buffer.from('x'), 'image/png');
    const res = await handleGetFile(bucket, { path: 'img/x.png' });

    expect(res.success).toBe(true);
    expect(res.data!.url).toContain('img/x.png');
  });

  it('get-file fails when the object is missing', async () => {
    const bucket = new FakeBucket();
    const res = await handleGetFile(bucket, { path: 'nope.png' });
    expect(res.success).toBe(false);
  });
});
