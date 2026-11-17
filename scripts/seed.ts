import "dotenv/config";
import { connectDB, disconnectDB } from "../src/db/connect";
import { seedDemo } from "../src/seed/demo";

async function main() {
  await connectDB();
  await seedDemo();
  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
