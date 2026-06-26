import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
  /** Presigned PUT URL: the client uploads bytes directly to the bucket (no
   *  bytes through the server/model). The PUT request sets the object's
   *  Content-Type via its own header. */
  presignPut(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * Content types we let the bucket serve inline. Everything else (SVG, HTML,
 * unknown blobs) is stored with `Content-Disposition: attachment` so opening a
 * presigned URL downloads it instead of letting the browser execute it — an
 * SVG/HTML payload otherwise runs its embedded script in the bucket's origin.
 */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export function contentDispositionFor(contentType: string): 'attachment' | undefined {
  return INLINE_SAFE.has(contentType) ? undefined : 'attachment';
}

export class S3BucketStore implements BucketStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentDisposition: contentDispositionFor(contentType),
      }),
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async presignPut(key: string, expiresInSeconds: number): Promise<string> {
    // Bare PutObjectCommand so any client can upload with a simple PUT; the
    // object's Content-Type comes from the upload request's own header.
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

/**
 * Build the bucket store from env, or return null when no bucket is configured
 * (the put-file/get-file tools then stay unregistered — additive, like RAG).
 *
 * Reference a Railway Bucket's variables onto the MCP service. Railway's raw
 * names (`BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`)
 * and the AWS-SDK preset names (`AWS_*`, `S3_BUCKET`, `AWS_ENDPOINT_URL_S3`) are
 * both picked up; `BUCKET_*`-prefixed names take precedence to avoid collisions.
 * Set `BUCKET_FORCE_PATH_STYLE=true` only for legacy path-style buckets.
 */
export function createBucketStore(): BucketStore | null {
  const env = process.env;
  const bucket =
    env.BUCKET_NAME || env.BUCKET || env.S3_BUCKET || env.AWS_S3_BUCKET || env.AWS_BUCKET;
  const endpoint =
    env.BUCKET_ENDPOINT || env.ENDPOINT || env.AWS_ENDPOINT_URL_S3 || env.AWS_ENDPOINT_URL;
  const accessKeyId = env.BUCKET_ACCESS_KEY_ID || env.ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    env.BUCKET_SECRET_ACCESS_KEY || env.SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    // Log (booleans only — never secrets) when partially configured, so a missing
    // variable is visible in the Railway deploy logs instead of silently disabling the tools.
    if (bucket || endpoint || accessKeyId || secretAccessKey) {
      logger.info('Bucket store not configured — some variables missing', {
        bucket: !!bucket,
        endpoint: !!endpoint,
        accessKeyId: !!accessKeyId,
        secretAccessKey: !!secretAccessKey,
      });
    }
    return null;
  }

  const region = env.BUCKET_REGION || env.REGION || env.AWS_REGION || 'auto';
  const forcePathStyle = (env.BUCKET_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle,
    // Newer SDKs bake a CRC32 checksum into requests by default. On a presigned
    // PUT that signs a placeholder empty-body checksum, which a strict S3
    // provider rejects when the real (non-empty) bytes are uploaded. WHEN_REQUIRED
    // keeps presigned upload URLs clean and portable.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  logger.info('Creating bucket store', { endpoint, bucket, region, forcePathStyle });
  return new S3BucketStore(client, bucket);
}
