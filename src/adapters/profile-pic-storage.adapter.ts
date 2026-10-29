import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import s3 from "../S3/s3.ts";
import { requiredEnv } from "../config/env.ts";

const bucket = requiredEnv("AWS_BUCKET_NAME");

type ProfilePicture = {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
};

export async function uploadProfilePicture(
  file: ProfilePicture,
): Promise<string> {
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
      Bucket: bucket,
      Key: key,
    }),
  );
}
