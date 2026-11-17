/**
 * Runs the API against an in-memory MongoDB replica set seeded with demo data.
 * Useful for trying LeadFlow locally without installing MongoDB or creating an Atlas cluster.
 * Data is discarded when the process exits.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { connectDB } from "../src/db/connect";
import { seedDemo } from "../src/seed/demo";

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri("leadflow-dev");
  process.env.JWT_SECRET ??= "local-dev-secret-change-me-please";
  process.env.DEMO_MODE ??= "true";
  process.env.CRON_SECRET ??= "local-cron-secret";
  await connectDB();
  await seedDemo();
  const { PORT } = env();
  createApp().listen(PORT, () => console.log(`LeadFlow API (in-memory DB) listening on http://localhost:${PORT}`));

  const stop = async () => {
    await replSet.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
