import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();

  const allChats = await prisma.chat.findMany({
    include: {
      participants: true,
    },
  });
  console.log(allChats);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })