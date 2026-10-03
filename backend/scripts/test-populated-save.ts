/**
 * Regression test — save() on a document whose ref was populate()d.
 *
 * Accepting a campaign invite 500'd in production on the first day of the
 * Postgres build:
 *
 *   [invites] respond error: invalid input syntax for type uuid:
 *   "{"title":"Test Campaign",...,"_id":"d8a358dd-..."}"
 *
 * The route loads the invite with .populate("campaign", "title"), flips
 * `status`, and saves. Mongoose depopulated on save; the model layer diffed the
 * populated Campaign against the loaded id, counted it as a change, and sent
 * the whole document to the uuid column. The CampaignMember insert before it
 * had already committed, so the invitee became a member while the invite stayed
 * "pending" and the inviter was never told.
 *
 * Since Phase 3 (#35) both ends of an invite are FKs to accounts(id), so the
 * inviter and invitee are accounts rows.
 *
 * Run against a throwaway database loaded from db/schema.sql (it inserts rows,
 * and refuses to run against anything but localhost):
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/pwatest npx tsx scripts/test-populated-save.ts
 */
import pool from "../db/index.js";
import Campaign from "../models/Campaign.js";
import CampaignInvite from "../models/CampaignInvite.js";
import CampaignMember from "../models/CampaignMember.js";

if (!/(\/\/|@)(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("\n  Refusing to run: DATABASE_URL must be a local throwaway database.\n");
  process.exit(2);
}

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  FAIL  ${name}\n          ${e.message}`);
    fail++;
  }
}

function assertEq(actual: any, expected: any, what: string) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log("\nsave() with a populated ref\n");

  const campaign = await Campaign.create({ title: "Test Campaign" });
  const other = await Campaign.create({ title: "Other Campaign" });
  const { rows: people } = await pool.query(
    `INSERT INTO accounts (id, name) VALUES (gen_random_uuid(), 'inviter'), (gen_random_uuid(), 'invitee')
     RETURNING id`);

  const newInvite = () => CampaignInvite.create({
    campaign: String(campaign._id), from: people[0].id, to: people[1].id,
  });

  await check("campaign_invites: populate('campaign') -> change status -> save() (the accept path)", async () => {
    const created = await newInvite();
    const invite = await CampaignInvite.findById(created._id).populate("campaign", "title");
    assertEq(invite.campaign?.title, "Test Campaign", "populated title");
    invite.status = "accepted";
    await invite.save();
    const { rows } = await pool.query(`SELECT status, campaign_id FROM campaign_invites WHERE id = $1`, [created._id]);
    assertEq(rows[0].status, "accepted", "status");
    assertEq(rows[0].campaign_id, campaign._id, "campaign_id");
  });

  await check("populating a ref does not mark it modified", async () => {
    const created = await newInvite();
    const invite = await CampaignInvite.findById(created._id).populate("campaign", "title");
    if (invite.isModified("campaign")) throw new Error("isModified('campaign') was true after populate()");
  });

  await check("assigning a document to a ref saves that document's id", async () => {
    const created = await newInvite();
    const invite = await CampaignInvite.findById(created._id).populate("campaign", "title");
    invite.campaign = other;
    await invite.save();
    const { rows } = await pool.query(`SELECT campaign_id FROM campaign_invites WHERE id = $1`, [created._id]);
    assertEq(rows[0].campaign_id, other._id, "campaign_id");
  });

  await check("a new document with a document as its ref inserts the id", async () => {
    const m = await new CampaignMember({
      campaign, person: people[1].id, email: "invitee@example.com", status: "Player",
    }).save();
    const { rows } = await pool.query(`SELECT campaign_id FROM campaign_members WHERE id = $1`, [m._id]);
    assertEq(rows[0].campaign_id, campaign._id, "campaign_id");
  });

  await check("updateOne $set with a document as the ref writes the id", async () => {
    const created = await newInvite();
    await CampaignInvite.updateOne({ _id: created._id }, { $set: { campaign: other } });
    const { rows } = await pool.query(`SELECT campaign_id FROM campaign_invites WHERE id = $1`, [created._id]);
    assertEq(rows[0].campaign_id, other._id, "campaign_id");
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
