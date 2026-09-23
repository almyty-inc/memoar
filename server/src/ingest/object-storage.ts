import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";


export interface ObjectStorage {
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(objectKey: string): Promise<Uint8Array>;
  signedDownloadUrl(objectKey: string, expiresSeconds: number): Promise<string>;
  health(): Promise<void>;
}

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  put(objectKey: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(objectKey, Uint8Array.from(bytes));
    return Promise.resolve();
  }
  get(objectKey: string): Promise<Uint8Array> {
    const value = this.objects.get(objectKey);
    return value ? Promise.resolve(Uint8Array.from(value)) : Promise.reject(new Error("object_not_found"));
  }
  signedDownloadUrl(objectKey: string): Promise<string> { return Promise.resolve(`memory://memoar/${encodeURIComponent(objectKey)}`); }
  health(): Promise<void> { return Promise.resolve(); }
}

export interface S3ClientPort {
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array>;
  signedGetUrl(input: { bucket: string; key: string; expiresSeconds: number }): Promise<string>;
  ensureBucket(bucket: string): Promise<void>;
}

export class AwsS3ClientPort implements S3ClientPort {
  private readonly internal: S3Client;
  private readonly publicSigner: S3Client;

  /**
   * Path-style addressing, unless the provider wants the other kind.
   *
   * MinIO needs `bucket/key` in the path. Amazon deprecated that shape, and
   * DigitalOcean Spaces documents the opposite — its own SDK guidance is to set
   * `forcePathStyle` to false and use the virtual-hosted form,
   * `bucket.fra1.digitaloceanspaces.com`. Hard-coding `true` meant a provider
   * could only be adopted by editing this file, and the failure it produces is
   * a signature error rather than a connection error, which reads like bad
   * credentials rather than the wrong address shape.
   *
   * The default stays `true`, so the local Compose stack and every existing
   * deployment behave exactly as before. Path-style presigned URLs also cannot
   * be served through a CDN, which is the other reason a provider might want
   * this turned off.
   */
  constructor(config: {
    endpoint: string; publicEndpoint?: string; region: string;
    accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean;
  }) {
    const shared = {
      region: config.region,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    };
    this.internal = new S3Client({ ...shared, endpoint: config.endpoint });
    this.publicSigner = config.publicEndpoint
      ? new S3Client({ ...shared, endpoint: config.publicEndpoint })
      : this.internal;
  }

  async putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string }): Promise<void> {
    await this.internal.send(new PutObjectCommand({ Bucket: input.bucket, Key: input.key, Body: input.body, ContentType: input.contentType }));
  }

  async getObject(input: { bucket: string; key: string }): Promise<Uint8Array> {
    const response = await this.internal.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
    if (!response.Body) throw new Error("object_not_found");
    return response.Body.transformToByteArray();
  }

  signedGetUrl(input: { bucket: string; key: string; expiresSeconds: number }): Promise<string> {
    return getSignedUrl(this.publicSigner, new GetObjectCommand({ Bucket: input.bucket, Key: input.key }), { expiresIn: input.expiresSeconds });
  }

  async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status !== 404 && name !== "NotFound" && name !== "NoSuchBucket") throw error;
      await this.internal.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(private readonly client: S3ClientPort, private readonly bucket: string) {}
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
    return this.client.putObject({ bucket: this.bucket, key: objectKey, body: bytes, contentType });
  }
  get(objectKey: string): Promise<Uint8Array> { return this.client.getObject({ bucket: this.bucket, key: objectKey }); }
  signedDownloadUrl(objectKey: string, expiresSeconds: number): Promise<string> {
    return this.client.signedGetUrl({ bucket: this.bucket, key: objectKey, expiresSeconds });
  }
  health(): Promise<void> { return this.client.ensureBucket(this.bucket); }
}
