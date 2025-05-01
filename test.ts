import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();

  const allUsers = await prisma.user.findMany({
    select: {
      id: true, // Fetch scalar fields using `select`
      name: true,
      email: true,
    },
  });

  console.log(allUsers, { depth: null });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })