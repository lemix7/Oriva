import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import s3 from "../S3/s3.ts";

type ProfilePicture = {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
};

function getBucket(): string {
  const bucket = process.env.AWS_BUCKET_NAME;

  if (!bucket) {
    throw new Error("AWS_BUCKET_NAME is missing");
  }

  return bucket;
}

export async function uploadProfilePicture(
  file: ProfilePicture,
): Promise<string> {
  const bucket = getBucket();
  const filename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `uploads/${randomUUID()}-${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }),
  );

  return key;
}

export async function deleteProfilePicture(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
  );
}
