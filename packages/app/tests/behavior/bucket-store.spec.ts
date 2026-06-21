import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureLogger } from '@/utils/logger';
import { createBucketStore, contentDispositionFor } from '@/services/storage/bucket-store';

const KEYS = [
  'BUCKET',
  'BUCKET_NAME',
  'S3_BUCKET',
  'AWS_S3_BUCKET',
  'AWS_BUCKET',
  'ENDPOINT',
  'BUCKET_ENDPOINT',
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL',
  'ACCESS_KEY_ID',
  'BUCKET_ACCESS_KEY_ID',
  'AWS_ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'BUCKET_SECRET_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'REGION',
  'BUCKET_REGION',
  'AWS_REGION',
];

function clearBucketEnv() {
  for (const k of KEYS) delete process.env[k];
}

beforeAll(() => {
  configureLogger({ stream: { write: () => true } as unknown as NodeJS.WriteStream });
});

afterEach(clearBucketEnv);

describe('createBucketStore env resolution', () => {
  it('returns null when no bucket is configured', () => {
    clearBucketEnv();
    expect(createBucketStore()).toBeNull();
  });

  it('builds a store from Railway raw variable names', () => {
    clearBucketEnv();
    Object.assign(process.env, {
      BUCKET: 'b',
      ENDPOINT: 'https://storage.railway.app',
      ACCESS_KEY_ID: 'a',
      SECRET_ACCESS_KEY: 's',
    });
    expect(createBucketStore()).not.toBeNull();
  });

  it('builds a store from AWS-SDK preset variable names', () => {
    clearBucketEnv();
    Object.assign(process.env, {
      AWS_S3_BUCKET: 'b',
      AWS_ENDPOINT_URL_S3: 'https://storage.railway.app',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 's',
    });
    expect(createBucketStore()).not.toBeNull();
  });

  it('returns null when the endpoint is missing (partial config)', () => {
    clearBucketEnv();
    Object.assign(process.env, {
      BUCKET: 'b',
      ACCESS_KEY_ID: 'a',
      SECRET_ACCESS_KEY: 's',
    });
    expect(createBucketStore()).toBeNull();
  });
});

describe('contentDispositionFor (stored-XSS mitigation)', () => {
  it('serves known inline-safe types inline (no attachment)', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) {
      expect(contentDispositionFor(t)).toBeUndefined();
    }
  });

  it('forces attachment for active or unknown content', () => {
    for (const t of [
      'image/svg+xml',
      'text/html',
      'application/xhtml+xml',
      'application/octet-stream',
    ]) {
      expect(contentDispositionFor(t)).toBe('attachment');
    }
  });
});
