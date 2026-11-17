import mongoose from "mongoose";
import { env } from "../config/env";

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

const globalForMongoose = globalThis as unknown as { __mongoose?: Cache };
const cache: Cache = globalForMongoose.__mongoose ?? { conn: null, promise: null };
globalForMongoose.__mongoose = cache;

mongoose.set("strictQuery", true);

export async function connectDB(uri = env().MONGODB_URI) {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;
  if (!cache.promise) {
    cache.promise = mongoose
      .connect(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 })
      .catch((err) => {
        cache.promise = null;
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  cache.conn = null;
  cache.promise = null;
}
