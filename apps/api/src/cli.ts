/**
 * Admin provisioning. There is no self-signup (DECISIONS.md D-009), so orgs,
 * users and identity providers are created here until the Setup UI (step 9).
 * Connects as the app role, so row-level security applies like in the API.
 *
 *   pnpm --filter @crm/api cli create-org --name "Acme UK" --slug acme-uk \
 *        --admin-email ana@acme.test --admin-name "Ana Ruiz"
 *   pnpm --filter @crm/api cli add-user   --org acme-uk --email ben@acme.test --name "Ben Ode"
 *   CRM_PASSWORD='…' pnpm --filter @crm/api cli set-password --org acme-uk --email ben@acme.test
 *   pnpm --filter @crm/api cli add-idp    --org acme-uk --name Entra --issuer https://login.microsoftonline.com/<tenant>/v2.0 \
 *        --client-id <id> --secret-env ACME_ENTRA_SECRET [--email-linking]
 */
import { parseArgs } from "node:util";
import { KeyPrefix, createDb, newId, resolveOrgBySlug, withOrg } from "@crm/db";
import { hashPassword } from "./auth/password.js";

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    org: { type: "string" },
    email: { type: "string" },
    "admin-email": { type: "string" },
    "admin-name": { type: "string" },
    issuer: { type: "string" },
    "client-id": { type: "string" },
    "secret-env": { type: "string" },
    "email-linking": { type: "boolean", default: false },
  },
});

function need(key: keyof typeof args): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") throw new Error(`--${key} is required`);
  return v;
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const db = createDb(url, { max: 1 });

async function orgId(): Promise<string> {
  const id = await resolveOrgBySlug(db, need("org"));
  if (!id) throw new Error(`No org with slug ${args.org}`);
  return id;
}

try {
  switch (command) {
    case "create-org": {
      const id = newId(KeyPrefix.Org);
      const userId = newId(KeyPrefix.User);
      await withOrg(db, id, async (tx) => {
        await tx
          .insertInto("org")
          .values({ id, name: need("name"), slug: need("slug") })
          .execute();
        await tx
          .insertInto("app_user")
          .values({ id: userId, org_id: id, email: need("admin-email"), name: need("admin-name") })
          .execute();
      });
      console.log(JSON.stringify({ orgId: id, adminUserId: userId }));
      break;
    }
    case "add-user": {
      const org = await orgId();
      const id = newId(KeyPrefix.User);
      await withOrg(db, org, (tx) =>
        tx
          .insertInto("app_user")
          .values({ id, org_id: org, email: need("email"), name: need("name") })
          .execute(),
      );
      console.log(JSON.stringify({ userId: id }));
      break;
    }
    case "set-password": {
      // Read from the environment, never argv, so it doesn't land in shell history.
      const password = process.env.CRM_PASSWORD;
      if (!password) throw new Error("Put the password in CRM_PASSWORD");
      const org = await orgId();
      const hash = await hashPassword(password);
      await withOrg(db, org, async (tx) => {
        const user = await tx
          .selectFrom("app_user")
          .select("id")
          .where("email", "=", need("email"))
          .executeTakeFirst();
        if (!user) throw new Error(`No user ${args.email} in ${args.org}`);
        await tx
          .insertInto("local_credential")
          .values({ user_id: user.id, org_id: org, password_hash: hash })
          .onConflict((oc) =>
            oc.column("user_id").doUpdateSet({ password_hash: hash, updated_at: new Date() }),
          )
          .execute();
      });
      console.log("Password set. It works only where ALLOW_LOCAL_LOGIN=true.");
      break;
    }
    case "add-idp": {
      const org = await orgId();
      const id = newId(KeyPrefix.AuthProvider);
      await withOrg(db, org, (tx) =>
        tx
          .insertInto("identity_provider")
          .values({
            id,
            org_id: org,
            name: need("name"),
            issuer: need("issuer"),
            client_id: need("client-id"),
            client_secret_env: need("secret-env"),
            allow_email_linking: args["email-linking"] === true,
          })
          .execute(),
      );
      console.log(JSON.stringify({ providerId: id, signInPath: `/auth/${args.org}/oidc/${id}` }));
      break;
    }
    default:
      throw new Error("Commands: create-org, add-user, set-password, add-idp");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
