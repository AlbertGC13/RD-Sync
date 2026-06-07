import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleKey } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed RD-Sync roles.");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const roles = [
  {
    key: RoleKey.ADMIN,
    name: "Admin",
    description: "Can manage bank sessions, scraper operations, users, and transaction visibility.",
  },
  {
    key: RoleKey.REVIEWER,
    name: "Reviewer",
    description: "Can view transactions and mark them as seen or internally validated.",
  },
  {
    key: RoleKey.VIEWER,
    name: "Viewer",
    description: "Can view minimized transaction records only.",
  },
];

async function main() {
  for (const role of roles) {
    await prisma.role.upsert({
      where: { key: role.key },
      update: {
        name: role.name,
        description: role.description,
      },
      create: role,
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
