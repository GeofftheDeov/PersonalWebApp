/**
 * Phase 3 (#35) fixture.
 *
 * Phase 2's fixture (`test-phase2-backfill.ts`) seeded every Salesforce Id as
 * NULL, so 19/19 green proved nothing about Salesforce-Id handling and hid two
 * real defects. This fixture is built the other way round: it deliberately
 * populates every column the cutover depends on, and it points references at
 * ids that LOSE their merge, because that is the case Phase 3 breaks on.
 *
 * Shape mirrors dev (see the #27 adjudication), scaled down but structurally
 * identical:
 *
 *   A  Geoff / System Administrator  sf_users WINS, sf_accounts + sf_contacts lose
 *   B  Zpecterr test account         sf_leads wins (sole row in its group)
 *   C  no-email person               sf_accounts wins, sf_contacts loses
 *                                    (34 of 40 dev rows carry no email at all)
 *   D  Ashley Early                  sf_contacts wins, no parent Account
 *   E  JOHNNY SILVERHAND             EXCLUDED — landing row, no account, no link
 *
 * 9 landing rows -> 4 accounts, 7 links, 4 primary, and THREE ids that are not
 * any accounts.id (A1, C1, C2). Every dependent table below points at one of
 * those three at least once.
 */
import bcrypt from "bcryptjs";
import type pg from "pg";

/** Stable ids so assertions can name rows instead of re-querying for them. */
export const IDS = {
    // Group A — Geoff. sf_users donates the UUID (it is the account id).
    acctA: "0a000000-0000-4000-8000-00000000000a",   // = U1
    U1: "0a000000-0000-4000-8000-00000000000a",
    A1: "0a000000-0000-4000-8000-0000000000a1",      // LOSES
    C1: "0a000000-0000-4000-8000-0000000000c1",      // LOSES

    // Group B — Zpecterr test lead.
    acctB: "0b000000-0000-4000-8000-00000000000b",
    L1: "0b000000-0000-4000-8000-00000000000b",

    // Group C — no email on any row.
    acctC: "0c000000-0000-4000-8000-00000000000c",   // = A2
    A2: "0c000000-0000-4000-8000-00000000000c",
    C2: "0c000000-0000-4000-8000-0000000000c2",      // LOSES

    // Group D — Contact with no parent Account.
    acctD: "0d000000-0000-4000-8000-00000000000d",   // = C3
    C3: "0d000000-0000-4000-8000-00000000000d",

    // Group E — excluded from the merge entirely.
    L2: "0e000000-0000-4000-8000-00000000000e",

    campaign: "0f000000-0000-4000-8000-00000000000f",
    session: "0f000000-0000-4000-8000-0000000000f5",
} as const;

/** The three source ids that are not an accounts.id. */
export const LOSING_IDS = [IDS.A1, IDS.C1, IDS.C2];

/** Plaintext for every seeded password, so login tests can actually log in. */
export const PASSWORD = "correct-horse-battery-staple";

export async function buildFixture(client: pg.PoolClient | pg.Client): Promise<void> {
    const pw = await bcrypt.hash(PASSWORD, 10);

    await client.query(`TRUNCATE
        accounts, account_source_links, person_outbox,
        sf_users, sf_leads, sf_contacts, sf_accounts,
        campaigns, campaign_members, campaign_invites, game_sessions,
        characters, player_sessions, notifications, friend_requests, messages,
        api_key_vault, cloud_claw_sessions
      RESTART IDENTITY CASCADE`);

    // ── Landing tables ───────────────────────────────────────────────────────
    // Every row carries a distinct, object-prefixed Salesforce Id. A wrong id
    // has something to contradict it (the Phase 2 lesson).
    await client.query(
        `INSERT INTO sf_users (id, name, email, handle, password, is_verified, role,
                               user_number, user_digit, sf_id, friends)
         VALUES ($1,'Geoffrey Murray','geoffrey.murray.1995@gmail.com','geoff',$2,true,'admin',
                 '0001','ADM','005000000000001AAA', ARRAY[$3]::uuid[])`,
        [IDS.U1, pw, IDS.C2],   // friends[] points at a LOSING id on purpose
    );

    await client.query(
        `INSERT INTO sf_accounts (id, name, email, password, is_verified, handle,
                                  user_number, user_digit, sf_id, company)
         VALUES ($1,'Murray LLC','geoffrey.murray.1995@gmail.com',$2,true,'geoffacct',
                 '0002','ACC','001000000000001AAA','Murray LLC')`,
        [IDS.A1, pw],
    );
    await client.query(
        `INSERT INTO sf_contacts (id, name, email, password, is_verified, handle,
                                  account_id, user_number, user_digit, sf_id)
         VALUES ($1,'Geoffrey Murray','geoffrey.murray.1995@gmail.com',$2,true,'geoffcon',
                 $3,'0003','CON','003000000000001AAA')`,
        [IDS.C1, pw, IDS.A1],
    );

    await client.query(
        `INSERT INTO sf_leads (id, first_name, last_name, email, password, is_verified,
                               handle, user_number, user_digit, sf_lead_id, status)
         VALUES ($1,'Test','Player','gdrumz@momurrays.com',$2,true,
                 'Zpecterr','0004','LED','00Q000000000001AAA','New')`,
        [IDS.L1, pw],
    );

    // Group C — no email anywhere. These accounts exist and have passwords but
    // cannot log in, which is true of most of dev.
    await client.query(
        `INSERT INTO sf_accounts (id, name, password, handle, user_number, user_digit, sf_id)
         VALUES ($1,'Tyler Campbell',$2,'tylerA','0005','ACC','001000000000002AAA')`,
        [IDS.A2, pw],
    );
    await client.query(
        `INSERT INTO sf_contacts (id, name, password, handle, account_id,
                                  user_number, user_digit, sf_id)
         VALUES ($1,'Tyler Campbell',$2,'tylerC',$3,'0006','CON','003000000000002AAA')`,
        [IDS.C2, pw, IDS.A2],
    );

    await client.query(
        `INSERT INTO sf_contacts (id, name, email, password, is_verified, handle,
                                  user_number, user_digit, sf_id)
         VALUES ($1,'Ashley Early','ashley.early@example.com',$2,true,'ashley',
                 '0007','CON','003000000000003AAA')`,
        [IDS.C3, pw],
    );

    // Excluded from the merge. Never graduates; nothing may reference it.
    await client.query(
        `INSERT INTO sf_leads (id, first_name, last_name, email, password, handle,
                               user_number, user_digit, sf_lead_id, status)
         VALUES ($1,'JOHNNY','SILVERHAND','name@example.com',$2,'johnny',
                 '0008','LED','00Q000000000002AAA','New')`,
        [IDS.L2, pw],
    );

    // ── accounts + links (the Phase 2 output) ────────────────────────────────
    const acct = async (
        id: string, email: string | null, name: string, handle: string,
        sfObject: string, sfId: string, role: string, roleSource: string,
        tier: string, friends: string[],
    ) => client.query(
        `INSERT INTO accounts (id, email, password, is_verified, name, handle,
                               user_number, app_role, app_role_source,
                               account_tier, account_tier_source,
                               sf_object, sf_id, friends)
         VALUES ($1,$2,$3,true,$4,$5,'0001',$6,$7,$8,'sf',$9,$10,$11::uuid[])`,
        [id, email, pw, name, handle, role, roleSource, tier, sfObject, sfId, friends],
    );

    // Geoff: admin by MANUAL pin, not by sf_profile. sf_profile is NULL on every
    // dev row, so every admin gate in Phase 3 rests on this single row.
    // friends[] holds BOTH a losing Contact and the account it merged into, so
    // the remap has to de-duplicate rather than just substitute.
    await acct(IDS.acctA, "geoffrey.murray.1995@gmail.com", "Geoffrey Murray", "geoff",
        "User", "005000000000001AAA", "admin", "manual", "patron", [IDS.C2, IDS.acctC]);
    await acct(IDS.acctB, "gdrumz@momurrays.com", "Test Player", "Zpecterr",
        "Lead", "00Q000000000001AAA", "user", "sf", "free", [IDS.acctA]);
    await acct(IDS.acctC, null, "Tyler Campbell", "tylerA",
        "Account", "001000000000002AAA", "user", "sf", "patron", []);
    await acct(IDS.acctD, "ashley.early@example.com", "Ashley Early", "ashley",
        "Contact", "003000000000003AAA", "user", "sf", "member", []);

    // Each link carries its OWN row's Salesforce Id — the 07ffc66 fix. A link
    // holding the winner's id would aim a write-back at the wrong SF record.
    const link = (table: string, sourceId: string, accountId: string,
                  sfObject: string, sfId: string, primary: boolean) =>
        client.query(
            `INSERT INTO account_source_links
               (source_table, source_id, account_id, sf_object, sf_id, is_primary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [table, sourceId, accountId, sfObject, sfId, primary]);

    await link("sf_users", IDS.U1, IDS.acctA, "User", "005000000000001AAA", true);
    await link("sf_accounts", IDS.A1, IDS.acctA, "Account", "001000000000001AAA", false);
    await link("sf_contacts", IDS.C1, IDS.acctA, "Contact", "003000000000001AAA", false);
    await link("sf_leads", IDS.L1, IDS.acctB, "Lead", "00Q000000000001AAA", true);
    await link("sf_accounts", IDS.A2, IDS.acctC, "Account", "001000000000002AAA", true);
    await link("sf_contacts", IDS.C2, IDS.acctC, "Contact", "003000000000002AAA", false);
    await link("sf_contacts", IDS.C3, IDS.acctD, "Contact", "003000000000003AAA", true);

    // ── Dependent rows, every one aimed at a losing id at least once ─────────
    await client.query(
        `INSERT INTO campaigns (id, title, status) VALUES ($1,'The Long Dark','In Progress')`,
        [IDS.campaign]);
    // ready_check.responses[].playerId is a person id living in jsonb. It was
    // not in Phase 2's reference sweep and is not in #35's file list; a stale id
    // here means a returning player's ready state silently doesn't match them.
    await client.query(
        `INSERT INTO game_sessions (id, title, campaign_id, ready_check)
         VALUES ($1,'Session 1',$2,$3::jsonb)`,
        [IDS.session, IDS.campaign, JSON.stringify({
            sentAt: new Date().toISOString(),
            responses: [
                { playerId: IDS.C1, name: "Geoffrey Murray", ready: true, respondedAt: new Date().toISOString() },
                { playerId: IDS.acctB, name: "Test Player", ready: false, respondedAt: new Date().toISOString() },
            ],
        })]);

    await client.query(
        `INSERT INTO characters (name, player_id, campaign_id, level)
         VALUES ('Vex', $1, $2, 3)`, [IDS.C1, IDS.campaign]);          // losing
    await client.query(
        `INSERT INTO player_sessions (name, session_id, player_id, campaign_id)
         VALUES ('Vex', $1, $2, $3)`, [IDS.session, IDS.A1, IDS.campaign]);  // losing
    await client.query(
        `INSERT INTO notifications (user_id, type, title)
         VALUES ($1,'system','Welcome')`, [IDS.A1]);                    // losing
    await client.query(
        `INSERT INTO friend_requests (from_user, to_user, status)
         VALUES ($1,$2,'pending')`, [IDS.acctB, IDS.C2]);               // losing target
    // Both ends of this one collapse onto Group A, so remapping it produces a
    // request from a person to themselves. It has to be dropped, not rewritten.
    await client.query(
        `INSERT INTO friend_requests (from_user, to_user, status)
         VALUES ($1,$2,'pending')`, [IDS.C1, IDS.acctA]);
    await client.query(
        `INSERT INTO campaign_invites (campaign_id, from_user, to_user, status)
         VALUES ($1,$2,$3,'pending')`, [IDS.campaign, IDS.acctB, IDS.C1]);  // losing

    // messages.sender_id is text, and messages.recipient is a person id that
    // Phase 2's reference sweep never checked.
    await client.query(
        `INSERT INTO messages (campaign_id, sender_id, sender_name, sender_email, body)
         VALUES ($1,$2,'Geoffrey Murray','geoffrey.murray.1995@gmail.com','hello')`,
        [IDS.campaign, IDS.C1]);
    // dm_key is sorted("<idA>:<idB>"). If one half still names a losing id after
    // the cutover, dmKeyFor(newId, otherId) computes a different key and the
    // whole existing thread becomes unreachable — a silent split, not an error.
    await client.query(
        `INSERT INTO messages (dm_key, recipient, sender_id, sender_name, sender_email, body)
         VALUES ($1,$2,$3,'Test Player','gdrumz@momurrays.com','dm')`,
        [[IDS.acctB, IDS.A1].sort().join(":"), IDS.A1, IDS.acctB]);
    await client.query(
        `INSERT INTO messages (campaign_id, sender_id, sender_name, sender_email, body)
         VALUES ($1,'system','System','system@geoffthedeov.net','a system message')`,
        [IDS.campaign]);

    // campaign_members: one via the winning Account, one via a LOSING Contact,
    // and one EMAIL-ONLY row — the shape campaignRoutes' `else` branch writes
    // when the creator is a User. #27 counted zero of these on dev today, but
    // the code path that makes them is still live.
    await client.query(
        `INSERT INTO campaign_members (campaign_id, lead_id, email, first_name, status)
         VALUES ($1,$2,NULL,'Test','Player')`, [IDS.campaign, IDS.L1]);
    await client.query(
        `INSERT INTO campaign_members (campaign_id, contact_id, email, first_name, status)
         VALUES ($1,$2,NULL,'Tyler','Player')`, [IDS.campaign, IDS.C2]);   // losing Contact
    await client.query(
        `INSERT INTO campaign_members (campaign_id, email, first_name, status)
         VALUES ($1,'geoffrey.murray.1995@gmail.com','Geoffrey','Game Master')`,
        [IDS.campaign]);

    // Staff-only integrations. These are the two deliberate sf_users FKs
    // (see the person-polymorphism note); Phase 3 repoints them at accounts.
    await client.query(
        `INSERT INTO api_key_vault (user_id, provider, encrypted_key_id, encrypted_secret)
         VALUES ($1,'anthropic','key-ciphertext','secret-ciphertext')`, [IDS.U1]);
    await client.query(
        `INSERT INTO cloud_claw_sessions (user_id, messages)
         VALUES ($1,'[]'::jsonb)`, [IDS.U1]);
}
