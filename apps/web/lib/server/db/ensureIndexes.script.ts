/** Run with `npm run db:indexes`. Mongo has no schema to migrate; indexes are the
 * only thing to declare (port of `make indexes` / backend/app/db/session.py::create_all). */
import { config } from "dotenv";
config({ path: ".env.local" });

// Dynamic import, deliberately: see the comment in scripts/seed.ts. tsx runs this
// file as ESM, so a static `import { ensureIndexes } from "./session"` would be
// hoisted above the dotenv config() call and read process.env before it is populated.
import("./session")
  .then(({ ensureIndexes }) => ensureIndexes())
  .then(() => {
    console.log("indexes ensured");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
