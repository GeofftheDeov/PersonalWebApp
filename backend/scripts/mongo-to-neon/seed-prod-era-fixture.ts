/**
 * Seed a Mongo database with a prod-shaped fixture for the #49 rehearsal.
 *
 * WHY THIS EXISTS. The migration must be proven against data shaped exactly
 * like production's, and production's shape is whatever the July build
 * (4ca0afec, the image prod runs) wrote. So this does not hand-write BSON: it
 * imports THAT build's Mongoose models and saves through them, so passwords are
 * hashed by the real pre-save hooks, defaults and `__v` are what Mongoose
 * really adds, subdocuments get the `_id`s Mongoose really gives them, and refs
 * are real ObjectIds. On top of that it recreates, through the same models, the
 * messes the July build is known to leave behind:
 *
 *   - Lead -> Account conversion (routes/accountRoutes.ts) DELETES the Lead, so
 *     every friend, DM, request, character and seat that pointed at it dangles.
 *   - Deleting a campaign / dungeon leaves members and characters pointing at it.
 *   - Documents written before a field existed (no createdAt, no friends array,
 *     an extra field the schema no longer knows).
 *   - A Lead who stored an API key (api_key_vault's FK only admits Users).
 *
 * The result is dumped with a real `mongodump` and committed as the fixture the
 * test reads (scripts/mongo-to-neon/fixture-dump). Regenerate it only if the
 * fixture needs to change:
 *
 *   git worktree add ../prod-era 4ca0afec && (cd ../prod-era/backend && npm ci)
 *   PROD_ERA_BACKEND=../prod-era/backend MONGO_URI=mongodb://127.0.0.1:27017/personal_web_app \
 *     ../prod-era/backend/node_modules/.bin/tsx scripts/mongo-to-neon/seed-prod-era-fixture.ts
 *   mongodump --uri mongodb://127.0.0.1:27017/personal_web_app --out scripts/mongo-to-neon/fixture-dump
 *
 * Every password below is a test value that exists only in this fixture.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROD = process.env.PROD_ERA_BACKEND;
const URI = process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/personal_web_app";
if (!PROD) {
    console.error("Set PROD_ERA_BACKEND to a checkout of 4ca0afec's backend/ with node_modules installed.");
    process.exit(2);
}

// The models import "mongoose" from THEIR node_modules; use that same instance.
const req = createRequire(resolve(PROD, "package.json"));
const mongoose = req("mongoose");
const bcrypt = req("bcryptjs");
const model = async (name: string) =>
    (await import(pathToFileURL(resolve(PROD, "models", `${name}.ts`)).href)).default;

/** Passwords the test logs in with. Exported shape mirrored in test-mongo-to-neon.ts. */
export const PASSWORDS = {
    admin: "Admin-Pass-1!",
    user2: "second user pw",
    lead: "lead-pässwörd-ü",       // non-ASCII: bcrypt hashes bytes, both sides must agree
    contact: "contact-pw-42",
    converted: "was-a-lead-first",
    legacy: "legacy-pw",
};

async function main() {
    await mongoose.connect(URI);
    const db = mongoose.connection.db;
    await db.dropDatabase();

    const [User, Lead, Contact, Account, Campaign, CampaignMember, CampaignInvite, Character,
        Dungeon, Encounter, Event, FriendRequest, Message, Notification, Opportunity,
        PlayerSession, Session, Task, ApiKeyVault, CloudClawSession, AlpacaSnapshot] =
        await Promise.all(["User", "Lead", "Contact", "Account", "Campaign", "CampaignMember",
            "CampaignInvite", "Character", "Dungeon", "Encounter", "Event", "FriendRequest",
            "Message", "Notification", "Opportunity", "PlayerSession", "Session", "Task",
            "ApiKeyVault", "CloudClawSession", "AlpacaSnapshot"].map(model));

    // ---------------------------------------------------------------- people
    // Saved through the models: the pre-save hooks hash every password below.
    const admin = await new User({
        name: "Geoff Admin", email: "Geoff.Admin@Example.test", password: PASSWORDS.admin,
        role: "admin", handle: "geoff", discordId: "123456789012345678", discordHandle: "geoff#0001",
        favoriteGames: ["D&D 5e", "Blades in the Dark"], isVerified: true,
    }).save();
    const user2 = await new User({
        name: "Sam Second", email: "sam@example.test", password: PASSWORDS.user2, handle: "sam",
    }).save();

    // sfLeadId is set so the July postSave hook does not try to reach Salesforce.
    const lead = await new Lead({
        firstName: "Lena", lastName: "Lead", email: "lena@example.test", password: PASSWORDS.lead,
        company: "Tavern Co", status: "Contacted", sfLeadId: "00QHs00000LEAD001", handle: "lena",
    }).save();

    // A business Account that came from Salesforce: no password (login answers
    // "Password not set" before and after — parity, not a bug to fix here).
    const bizAccount = await new Account({
        name: "Dragon Dice LLC", email: "hello@dragondice.test", industry: "Games",
        website: "https://dragondice.test", sfID: "001Hs00000ACCT001",
    }).save();

    const contact = await new Contact({
        name: "Casey Contact", email: "casey@example.test", password: PASSWORDS.contact,
        accountId: bizAccount._id, role: "Player", sfID: "003Hs00000CONT001",
    }).save();

    // The conversion path in routes/accountRoutes.ts, step for step: a Lead
    // registers and plays, then Salesforce converts it to an Account. The Account
    // inherits the Lead's HASH and the Lead document is deleted.
    const doomedLead = await new Lead({
        firstName: "Morgan", lastName: "Convert", email: "morgan@example.test",
        password: PASSWORDS.converted, sfLeadId: "00QHs00000LEAD002",
    }).save();
    const doomedId = doomedLead._id;

    // Same email in two collections: login's cascade picks the User.
    const dupLead = await new Lead({
        firstName: "Sam", lastName: "Again", email: "SAM@example.test", password: "unused",
        sfLeadId: "00QHs00000LEAD003",
    }).save();

    // ---------------------------------------------------------------- tabletop
    const campaign = await new Campaign({ title: "Curse of Strahd", status: "In Progress",
        startDate: new Date("2026-05-01T00:00:00Z"), sfID: "701Hs00000CAMP001" }).save();
    const doomedCampaign = await new Campaign({ title: "Abandoned One-shot" }).save();
    const dungeon = await new Dungeon({ name: "Castle Ravenloft", level: 5 }).save();
    const doomedDungeon = await new Dungeon({ name: "Deleted Crypt" }).save();
    const event = await new Event({ title: "Session Zero", status: "Completed",
        startDate: new Date("2026-05-02T00:00:00Z") }).save();

    const session = await new Session({
        title: "Into the Mists", campaign: campaign._id, date: new Date("2026-06-01T23:00:00Z"),
        isOnline: true, discordEventId: "998877665544332211",
        readyCheck: {
            sentAt: new Date("2026-05-31T12:00:00Z"),
            responses: [
                { playerId: String(user2._id), name: "Sam Second", ready: true, respondedAt: new Date("2026-05-31T13:00:00Z") },
                { playerId: String(contact._id), name: "Casey Contact", ready: false },
                { playerId: String(doomedId), name: "Morgan Convert", ready: true },
            ],
        },
    }).save();
    const session2 = await new Session({ title: "The Village of Barovia", campaign: campaign._id }).save();

    await new CampaignMember({ campaign: campaign._id, lead: lead._id, email: lead.email,
        firstName: "Lena", lastName: "Lead", status: "Accepted" }).save();
    await new CampaignMember({ campaign: campaign._id, contact: contact._id, email: contact.email,
        status: "Accepted", sfID: "00vHs00000MEMB001" }).save();
    await new CampaignMember({ campaign: campaign._id, account: bizAccount._id, status: "Invited" }).save();
    await new CampaignMember({ campaign: campaign._id, email: "walkin@example.test",
        firstName: "Walk", lastName: "In", status: "Accepted" }).save();                 // email-only seat
    await new CampaignMember({ campaign: campaign._id, lead: doomedId, email: "morgan@example.test",
        status: "Accepted" }).save();                                                    // lead about to vanish
    await new CampaignMember({ campaign: doomedCampaign._id, lead: lead._id, status: "Accepted" }).save();

    await new CampaignInvite({ campaign: campaign._id, from: admin._id, to: lead._id }).save();
    await new CampaignInvite({ campaign: campaign._id, from: admin._id, to: contact._id, status: "accepted" }).save();
    await new CampaignInvite({ campaign: campaign._id, from: admin._id, to: doomedId, status: "declined" }).save();

    await new Character({ name: "Ireena", player: lead._id, campaign: campaign._id,
        dungeon: dungeon._id, gameType: "D&D 5e", class: "Paladin", level: 4 }).save();
    await new Character({ name: "Strahd's Rival", player: user2._id, campaign: campaign._id,
        dungeon: doomedDungeon._id, class: "Wizard", level: 5, isDead: true }).save();
    await new Character({ name: "Morgan's Rogue", player: doomedId, campaign: campaign._id }).save();

    await new PlayerSession({ name: "Sam @ Into the Mists", session: session._id,
        player: user2._id, campaign: campaign._id }).save();
    await new PlayerSession({ name: "Morgan @ Into the Mists", session: session._id,
        player: doomedId, campaign: campaign._id }).save();
    await new Encounter({ name: "Wolves at the Gate", difficulty: "Hard", session: session._id,
        dungeon: dungeon._id }).save();

    // ---------------------------------------------------------------- social
    const addFriends = async (a: any, b: any) => {
        await a.constructor.updateOne({ _id: a._id }, { $addToSet: { friends: b._id } });
        await b.constructor.updateOne({ _id: b._id }, { $addToSet: { friends: a._id } });
    };
    await addFriends(admin, user2);
    await addFriends(admin, lead);
    await addFriends(admin, contact);
    await addFriends(user2, doomedLead);

    const fr1 = await new FriendRequest({ from: admin._id, to: lead._id, status: "accepted" }).save();
    const fr2 = await new FriendRequest({ from: user2._id, to: contact._id }).save();
    await new FriendRequest({ from: contact._id, to: user2._id, status: "rejected" }).save();
    await new FriendRequest({ from: doomedId, to: admin._id }).save();

    const dmKeyFor = (a: any, b: any) => [String(a), String(b)].sort().join(":");
    const who = (p: any, name: string) => ({ id: String(p._id), name, email: p.email });
    const t0 = Date.parse("2026-06-02T18:00:00Z");
    // Enough traffic to cross the migration's insert batches.
    for (let i = 0; i < 240; i++) {
        const fromAdmin = i % 2 === 0;
        await new Message({
            dmKey: dmKeyFor(admin._id, lead._id),
            recipient: String(fromAdmin ? lead._id : admin._id),
            sender: fromAdmin ? who(admin, "Geoff Admin") : who(lead, "Lena Lead"),
            body: `dm ${i}: ${fromAdmin ? "ping" : "pong"}`,
            createdAt: new Date(t0 + i * 60_000),
        }).save();
    }
    // A short thread for every other pair. The migration must RE-SORT each DM key
    // after mapping ids, because uuid order is not ObjectId order. With one or two
    // threads the mapped order can match by luck and a missing sort passes; the
    // test refuses a fixture in which no pair flips.
    const cast: [any, string][] = [[admin, "Geoff Admin"], [user2, "Sam Second"], [lead, "Lena Lead"], [contact, "Casey Contact"]];
    for (let i = 0; i < cast.length; i++) {
        for (let j = i + 1; j < cast.length; j++) {
            const [[a, an], [b, bn]] = [cast[i], cast[j]];
            if (a === admin && b === lead) continue;             // the long thread above
            await new Message({ dmKey: dmKeyFor(a._id, b._id), recipient: String(b._id), sender: who(a, an), body: `hi ${bn}` }).save();
            await new Message({ dmKey: dmKeyFor(a._id, b._id), recipient: String(a._id), sender: who(b, bn), body: `hey ${an}` }).save();
        }
    }
    await new Message({ dmKey: dmKeyFor(user2._id, doomedId), recipient: String(doomedId),
        sender: who(user2, "Sam Second"), body: "you still playing Friday?" }).save();
    await new Message({ dmKey: dmKeyFor(user2._id, doomedId), recipient: String(user2._id),
        sender: { id: String(doomedId), name: "Morgan Convert", email: "morgan@example.test" },
        body: "yes!" }).save();
    for (let i = 0; i < 30; i++) {
        await new Message({ campaign: campaign._id, sender: who(i % 3 ? user2 : admin, i % 3 ? "Sam Second" : "Geoff Admin"),
            body: `table talk ${i}`, createdAt: new Date(t0 + i * 3_600_000) }).save();
    }
    await new Message({ campaign: campaign._id, event: event._id, sender: who(admin, "Geoff Admin"),
        body: "Pinned: bring dice" }).save();

    // Notifications in exactly the shapes the July routes write them.
    const note = (doc: any) => new Notification(doc).save();
    await note({ user: lead._id, type: "friend_request", title: "Geoff sent you a friend request",
        sourceKey: `fr:${fr1._id}`, meta: { requestId: String(fr1._id) }, read: true });
    await note({ user: contact._id, type: "friend_request", title: "Sam sent you a friend request",
        sourceKey: `fr:${fr2._id}`, meta: { requestId: String(fr2._id) } });
    await note({ user: admin._id, type: "message", title: "New messages in Curse of Strahd",
        link: `/game-night/campaigns/${campaign._id}`, sourceKey: `campaign:${campaign._id}`,
        meta: { campaignId: String(campaign._id) }, count: 7 });
    await note({ user: lead._id, type: "message", title: "Geoff messaged you",
        sourceKey: `dm:${admin._id}`, meta: { fromUserId: String(admin._id) }, count: 3 });
    await note({ user: user2._id, type: "system", title: "Ready check: Into the Mists",
        link: `/game-night/sessions/${session._id}`, sourceKey: `ready:${session._id}`,
        meta: { sessionId: String(session._id), campaignId: String(campaign._id) } });
    await note({ user: admin._id, type: "system", title: "Welcome back" });
    // meta carrying a 24-hex string that is NOT any document's id.
    await note({ user: admin._id, type: "system", title: "Imported",
        meta: { importBatch: "abcdefabcdefabcdefabcdef", nested: { campaignId: String(campaign._id) } } });

    // ---------------------------------------------------------------- CRM / misc
    await new Task({ title: "Prep Session 2", ownerId: String(admin._id), ownerName: "Geoff Admin",
        dueDate: new Date("2026-06-08T00:00:00Z") }).save();
    await new Task({ title: "Synced from SF", sfID: "00THs00000TASK001",
        ownerId: "005Hs00000OWNER01", ownerName: "SF Owner" }).save();
    await new Opportunity({ name: "Patreon tier", amount: 25.5, accountId: bizAccount._id }).save();

    await new ApiKeyVault({ userId: admin._id, provider: "alpaca_paper", label: "paper",
        encryptedKeyId: "iv:tag:cipher-key", encryptedSecret: "iv:tag:cipher-secret" }).save();
    // A Lead's stored key. The July build allowed it; the release schema's FK
    // (api_key_vault.user_id -> sf_users) does not. Must be reported, not lost silently.
    await new ApiKeyVault({ userId: lead._id, provider: "google",
        encryptedKeyId: "iv:tag:lead-key", encryptedSecret: "iv:tag:lead-secret" }).save();
    await new CloudClawSession({ userId: admin._id, messages: [
        { role: "user", content: "summarise my week" }, { role: "assistant", content: "You played twice." },
    ] }).save();
    await new AlpacaSnapshot({ equity: 10234.12, last_equity: 10100, cash: 500.5, buying_power: 1001,
        day_pl: 134.12, positions: [{ symbol: "AAPL", qty: 3, market_value: 690.3, unrealized_pl: 12.1, current_price: 230.1 }] }).save();

    // ---------------------------------------------------------------- the conversion
    // routes/accountRoutes.ts: find the matching Lead, take its hash, delete it,
    // create the Account. Account's pre-save leaves a $2a$/$2b$ value alone.
    const convertedAccount = await new Account({
        name: "Morgan Convert", email: doomedLead.email, password: doomedLead.password,
        sfID: "001Hs00000ACCT002",
    }).save();
    await Lead.deleteOne({ _id: doomedId });
    await addFriends(admin, convertedAccount);
    await new Opportunity({ name: "Orphaned opp", accountId: new mongoose.Types.ObjectId() }).save();

    await Campaign.deleteOne({ _id: doomedCampaign._id });
    await Dungeon.deleteOne({ _id: doomedDungeon._id });

    // ---------------------------------------------------------------- legacy shapes
    // Written before later fields existed, straight into the collection the way
    // an old build or a manual fix would have left them.
    await db.collection("users").insertOne({
        name: "Legacy Larry", email: "Legacy.Larry@Example.test",
        password: await bcrypt.hash(PASSWORDS.legacy, 10),
        username: "larry_old",            // field the schema no longer has
        __v: 0,                           // no createdAt, updatedAt, friends, role, isVerified
    });
    await db.collection("contacts").insertOne({
        name: "Null Arrays", email: null, favoriteGames: null, friends: null,
        createdAt: new Date("2026-01-15T10:00:00Z"),
    });
    // A collection no model owns.
    await db.collection("migrations").insertOne({ name: "0900310d-v3-dbpath", ranAt: new Date() });

    const counts: Record<string, number> = {};
    for (const c of await db.listCollections().toArray()) counts[c.name] = await db.collection(c.name).countDocuments();
    console.log(JSON.stringify({ seeded: counts, dupLead: String(dupLead._id), session2: String(session2._id) }, null, 2));
    await mongoose.disconnect();
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect(); process.exit(1); });
