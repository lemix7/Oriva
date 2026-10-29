import mutler from "multer";
import mutlerS3 from "multer-s3";
import { randomUUID } from "node:crypto";
import s3 from "../S3/s3.ts";
import { requiredEnv } from "../config/env.ts";

const bucket = requiredEnv("AWS_BUCKET_NAME");

const upload = mutler({

  storage: mutlerS3({
    s3,
    bucket,
    contentType: mutlerS3.AUTO_CONTENT_TYPE,
    key: (_req, file, callback) => {
      const filename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      callback(null, `uploads/${randomUUID()}-${filename}`);
    },
  }),

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

export default upload;
