/**
 * Seeds a demo organization with a few demo accounts. Port of
 * backend/app/scripts/seed_demo.py, minus `--with-assessment` (building a demo
 * assessment end-to-end needs the question/answer pipeline, mapping and grading,
 * which are Phase 2+ — this only seeds accounts to log in with).
 *
 *   npm run seed [-- --clean]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

// Dynamic imports, deliberately: tsx runs this file as ESM, where static `import`
// declarations are hoisted above the rest of the module body regardless of source
// position. That would evaluate `lib/server/db/session` (and, through it,
// `lib/server/config`, which reads `process.env.MONGO_URI` at module-load time)
// BEFORE the `config({ path: ".env.local" })` call above ever runs — so it would
// silently fall back to the default `mongodb://localhost:27017` no matter what
// `.env.local` says. Deferring these imports to inside `main()` guarantees dotenv
// has already populated `process.env` by the time they resolve.
async function loadDeps() {
  const [{ ensureIndexes, withSession, getDatabase }, { AuthService }] = await Promise.all([
    import("@/lib/server/db/session"),
    import("@/lib/server/auth/service"),
  ]);
  return { ensureIndexes, withSession, getDatabase, AuthService };
}

const DEMO_PASSWORD = "Pass@123";
const DEMO_USERS = ["admin@gmail.com", "teacher@gmail.com", "reviewer@gmail.com"];

async function clean(getDatabase: Awaited<ReturnType<typeof loadDeps>>["getDatabase"]): Promise<void> {
  const db = await getDatabase();
  const emails = DEMO_USERS;
  const existing = await db
    .collection("users")
    .find({ email: { $in: emails } })
    .project({ organizationId: 1 })
    .toArray();
  const orgIds = [...new Set(existing.map((u) => u.organizationId as string))];
  if (orgIds.length === 0) {
    console.log("[clean] nothing to remove.");
    return;
  }
  for (const name of await db.listCollections().toArray()) {
    await db.collection(name.name).deleteMany({ organizationId: { $in: orgIds } });
  }
  await db
    .collection<{ _id: string }>("organizations")
    .deleteMany({ _id: { $in: orgIds } });
  console.log(`[clean] removed ${orgIds.length} demo organization(s) and their data.`);
}

async function main() {
  const { ensureIndexes, withSession, getDatabase, AuthService } = await loadDeps();

  await ensureIndexes();
  if (process.argv.includes("--clean")) await clean(getDatabase);

  await withSession(async (session) => {
    const auth = new AuthService(session);
    const organization = await auth.createOrganization("Demo School");
    console.log(`organization=${organization.id}`);
    for (const email of DEMO_USERS) {
      await auth.createUser(organization.id, email, DEMO_PASSWORD);
      console.log(`user=${email} password=${DEMO_PASSWORD}`);
    }
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
