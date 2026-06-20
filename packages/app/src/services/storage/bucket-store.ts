import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@/utils/logger';

/**
 * S3-compatible object storage (a Railway Bucket). Keeps binaries — images,
 * PDFs, attachments — out of the git vault (which stays light for mobile sync),
 * exposing them through time-limited presigned URLs instead.
 */
export interface BucketStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export class S3BucketStore implements BucketStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Build the bucket store from env, or return null when no bucket is configured
 * (the put-file/get-file tools then stay unregistered — additive, like RAG).
 *
 * Reference a Railway Bucket's variables onto the MCP service. Railway's raw
 * names (`BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`)
 * are picked up directly; `BUCKET_*`-prefixed names take precedence if you want
 * to avoid collisions. Set `BUCKET_FORCE_PATH_STYLE=true` only for legacy
 * path-style buckets.
 */
export function createBucketStore(): BucketStore | null {
  const bucket = process.env.BUCKET_NAME || process.env.BUCKET;
  const endpoint = process.env.BUCKET_ENDPOINT || process.env.ENDPOINT;
  const accessKeyId =
    process.env.BUCKET_ACCESS_KEY_ID || process.env.ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.BUCKET_SECRET_ACCESS_KEY ||
    process.env.SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY;

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;

  const region =
    process.env.BUCKET_REGION || process.env.REGION || process.env.AWS_REGION || 'auto';
  const forcePathStyle = (process.env.BUCKET_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
  });

  logger.info('Creating bucket store', { endpoint, bucket, forcePathStyle });
  return new S3BucketStore(client, bucket);
}
