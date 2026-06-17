import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleKey, UserStatus } from "../src/generated/prisma/client";
import { hashPassword } from "../src/modules/auth/password";

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

  // Seed the initial admin user when both env vars are provided.
  const adminEmail = process.env.RD_SYNC_ADMIN_EMAIL;
  const adminPassword = process.env.RD_SYNC_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log(
      "RD_SYNC_ADMIN_EMAIL or RD_SYNC_ADMIN_PASSWORD not set — skipping admin user seed.",
    );
    return;
  }

  const normalizedEmail = adminEmail.toLowerCase();
  const passwordHash = await hashPassword(adminPassword);

  const adminUser = await prisma.user.upsert({
    where: { email: normalizedEmail },
    update: {
      displayName: "Administrator",
      status: UserStatus.ACTIVE,
      passwordHash,
    },
    create: {
      email: normalizedEmail,
      displayName: "Administrator",
      status: UserStatus.ACTIVE,
      passwordHash,
    },
  });

  // Resolve the ADMIN role record.
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { key: RoleKey.ADMIN },
  });

  // Idempotent: create the UserRole link only if it does not already exist.
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });

  console.log(`Admin user seeded: ${normalizedEmail}`);
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
