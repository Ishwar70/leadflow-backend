import "dotenv/config";
import { env } from "./config/env";
import { createApp } from "./app";
import { connectDB } from "./db/connect";

async function main() {
  const { PORT } = env();
  await connectDB();
  createApp().listen(PORT, () => {
    console.log(`LeadFlow API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
