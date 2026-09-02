/**
 * GridFS storage backend. Port of backend/app/storage/{base,gridfs}.py.
 *
 * Originals (PDFs), rendered page images, IR-JSON and rendered markdown all live in
 * GridFS inside the same MongoDB database as the metadata. Vercel functions have no
 * persistent disk, so GridFS is the only storage backend here — no `local://`
 * option, which drops storage/factory.py's provider selection entirely.
 *
 * Keys are tenant-first: `<organization_id>/<assessment_id>/<document_id>/...`.
 */
import { GridFSBucket, type Db } from "mongodb";
import { NotFoundError } from "@/lib/server/errors";
import { settings } from "@/lib/server/config";

const SCHEME = "gridfs://";

function stripScheme(keyOrUri: string): string {
  return keyOrUri.startsWith(SCHEME) ? keyOrUri.slice(SCHEME.length) : keyOrUri;
}

/** Every key is written under `<organization_id>/...`; a mismatch reads as absent,
 * never as forbidden — a 403 would confirm the object exists in another org. */
function assertTenant(key: string, organizationId?: string | null): void {
  if (organizationId && key.split("/", 1)[0] !== organizationId) {
    throw new NotFoundError("Stored object not found.", { key });
  }
}

export class GridFSStorage {
  private bucket: GridFSBucket;

  constructor(db: Db, bucketName: string = settings.gridfsBucket) {
    this.bucket = new GridFSBucket(db, { bucketName });
  }

  async put(key: string, data: Buffer, metadata: Record<string, unknown> = {}): Promise<string> {
    const meta = { organizationId: key.split("/", 1)[0], ...metadata };
    // Re-ingesting the same key replaces it: GridFS versions files by default, and
    // unbounded versions of a 40-page scan is a storage leak, not a feature.
    const existing = await this.bucket.find({ filename: key }).toArray();
    for (const file of existing) await this.bucket.delete(file._id);

    await new Promise<void>((resolve, reject) => {
      const uploadStream = this.bucket.openUploadStream(key, { metadata: meta });
      uploadStream.on("error", reject);
      uploadStream.on("finish", () => resolve());
      uploadStream.end(data);
    });
    return `${SCHEME}${key}`;
  }

  async get(uri: string, organizationId?: string | null): Promise<Buffer> {
    const key = stripScheme(uri);
    assertTenant(key, organizationId);
    const files = await this.bucket.find({ filename: key }).toArray();
    if (files.length === 0) throw new NotFoundError("Stored object not found.", { uri });

    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      const stream = this.bucket.openDownloadStreamByName(key);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  async exists(uri: string): Promise<boolean> {
    const key = stripScheme(uri);
    const files = await this.bucket.find({ filename: key }).limit(1).toArray();
    return files.length > 0;
  }

  async delete(uri: string): Promise<void> {
    const key = stripScheme(uri);
    const files = await this.bucket.find({ filename: key }).toArray();
    for (const file of files) await this.bucket.delete(file._id);
  }
}
