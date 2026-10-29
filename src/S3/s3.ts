import { S3Client } from "@aws-sdk/client-s3";
import { requiredEnv } from "../config/env.ts";

const s3 = new S3Client({
  region: requiredEnv("AWS_REGION"),
  credentials: {
    accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
  },
});

export default s3;
