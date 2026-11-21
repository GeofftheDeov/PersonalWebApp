/**
 * A campaign's records (#225, spec #69): which sessions are Previous (the
 * rest are Coming up or on the Notice Board), how each reads, the GM's Add a
 * session form, and the party's characters. Also the Notice Board's kickoff
 * form and earlier rounds.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SESSION_FORM, attendanceLabel, characterGroups, characterLine, playedBy, sessionFormNeeds, sessionLists,
  sessionFormProblem, sessionPayload, sessionWhenLabel,
  type CampaignSession, type PartyCharacter, type SessionForm,
} from "../src/lib/campaignRecords";
import { EMPTY_KICKOFF, kickoffPayload, kickoffReady, roundOutcome, type Poll, type Upcoming } from "../src/lib/noticeBoard";

const NOW = new Date("2026-11-19T12:00:00Z");
const s = (id: string, over: Partial<CampaignSession> = {}): CampaignSession => ({ _id: id, title: id, status: "scheduled", ...over });
const up = (id: string): Upcoming => ({ id, title: id, date: "2026-11-25T19:00:00Z", endDate: null, isOnline: true, canChangeNight: true, venue: null, hostId: null });

test("sessions split by their end: over or called off is Previous; tonight's and the board's leftovers stay Coming up", () => {
  const list = [
    s("planning", { status: "planning", date: null }),
    s("next", { date: "2026-11-25T19:00:00Z" }),
    s("far-off", { date: "2027-02-25T19:00:00Z" }),
    s("no-night", { date: null }),
    s("later", { date: "2026-12-25T19:00:00Z" }),
    s("old", { date: "2026-10-01T19:00:00Z" }),
    // Started at 10:00 with no end: over 4 hours later, so still under way at noon.
    s("tonight", { date: "2026-11-19T10:00:00Z" }),
    s("this-morning", { date: "2026-11-19T07:00:00Z", endDate: "2026-11-19T11:00:00Z" }),
    s("called-off", { status: "cancelled", date: "2026-11-30T19:00:00Z" }),
    s("marked-played", { status: "completed", date: "2026-11-01T19:00:00Z" }),
  ];
  const { previous, underWay, later } = sessionLists(list, [up("next"), up("later")], NOW);
  assert.deepEqual(previous.map((x) => x._id), ["called-off", "this-morning", "marked-played", "old"]);
  assert.deepEqual(underWay.map((x) => x._id), ["tonight"]);
  assert.deepEqual(later.map((x) => x._id), ["far-off", "no-night"]);
});

test("a previous session's night, and who came", () => {
  assert.equal(sessionWhenLabel(s("a", { date: "2026-11-03T19:00:00Z" })), "Nov 3, 2026");
  assert.equal(sessionWhenLabel(s("a", { status: "cancelled", date: "2026-11-03T19:00:00Z" })), "Cancelled · Nov 3, 2026");
  assert.equal(sessionWhenLabel(s("a", { status: "planning" })), "Planning");
  assert.equal(sessionWhenLabel(s("a", { date: null })), "Date TBD");
  assert.equal(attendanceLabel(s("a", { attendeeCount: 3 })), "3 attended");
  assert.equal(attendanceLabel(s("a", { attendeeCount: 0, attendanceConfirmedAt: "2026-11-03T23:00:00Z" })), "0 attended");
  assert.equal(attendanceLabel(s("a", { attendeeCount: 0 })), "Attendance not taken");
  assert.equal(attendanceLabel(s("a", { attendeeCount: 2, status: "cancelled" })), null);
  assert.equal(attendanceLabel(s("a")), null);
});

test("Add a session: events elsewhere need both times, and Discord a location unless there's a voice channel", () => {
  const form = (over: Partial<SessionForm>): SessionForm => ({ ...EMPTY_SESSION_FORM, title: "The Drowned Chapel", ...over });
  const discord = { discordGuildId: "g", discordChannelId: null };
  assert.equal(sessionFormProblem(form({}), discord), null);
  assert.equal(sessionFormProblem(form({ title: "  " }), discord), "Give the session a title.");
  assert.deepEqual(sessionFormNeeds(form({ createGoogleEvent: true }), discord), { times: true, location: false });
  assert.match(sessionFormProblem(form({ createGoogleEvent: true, date: "2026-11-25T19:00" }), discord)!, /start and an end/);
  assert.match(sessionFormProblem(form({ createGoogleEvent: true, date: "2026-11-25T19:00", endDate: "2026-11-25T18:00" }), discord)!, /after the start/);
  const timed = { date: "2026-11-25T19:00", endDate: "2026-11-25T23:00" };
  assert.deepEqual(sessionFormNeeds(form({ createDiscordEvent: true }), discord), { times: true, location: true });
  assert.match(sessionFormProblem(form({ createDiscordEvent: true, ...timed }), discord)!, /needs a location/);
  assert.equal(sessionFormProblem(form({ createDiscordEvent: true, ...timed, isOnline: true }), discord), null);
  assert.equal(sessionFormProblem(form({ createDiscordEvent: true, ...timed }), { ...discord, discordChannelId: "v" }), null);
});

test("Add a session sends instants in the browser's time, and the campaign", () => {
  const body = sessionPayload({ ...EMPTY_SESSION_FORM, title: " Night ", date: "2026-11-25T19:00", location: " Inn " }, "c1");
  assert.equal(body.campaign, "c1");
  assert.equal(body.title, "Night");
  assert.equal(body.location, "Inn");
  assert.equal(body.date, new Date(2026, 10, 25, 19, 0).toISOString());
  assert.equal(body.endDate, undefined);
});

test("characters: the party, the former party, and their lines", () => {
  const c = (over: Partial<PartyCharacter>): PartyCharacter => ({ _id: "x", name: "Isolde", player: null, playerActive: true, ...over });
  const { current, former } = characterGroups([c({ _id: "1" }), c({ _id: "2", playerActive: false })]);
  assert.deepEqual([current.map((x) => x._id), former.map((x) => x._id)], [["1"], ["2"]]);
  assert.equal(characterLine(c({ class: "Rogue", level: 3 })), "Rogue · Level 3");
  assert.equal(characterLine(c({})), "Adventurer");
  assert.equal(playedBy(c({ player: { _id: "p", name: "Wren Talbot", handle: "wren" } })), "Played by @wren");
  assert.equal(playedBy(c({ player: { _id: "p", name: "Wren Talbot", handle: null } })), "Played by Wren Talbot");
  assert.equal(playedBy(c({})), "No player");
});

test("Plan a session: a title, and in person the food (and who provides it)", () => {
  assert.equal(kickoffReady(EMPTY_KICKOFF), false);
  assert.equal(kickoffReady({ ...EMPTY_KICKOFF, title: "Night" }), true);
  assert.equal(kickoffReady({ ...EMPTY_KICKOFF, title: "Night", isOnline: false }), false);
  assert.equal(kickoffReady({ ...EMPTY_KICKOFF, title: "Night", isOnline: false, foodMode: "provided" }), false);
  assert.equal(kickoffReady({ ...EMPTY_KICKOFF, title: "Night", isOnline: false, foodMode: "provided", foodOwnerId: "p" }), true);
  assert.deepEqual(kickoffPayload({ ...EMPTY_KICKOFF, title: " Night ", foodMode: "potluck" }),
    { title: "Night", agenda: "", isOnline: true, foodMode: null });
  assert.deepEqual(kickoffPayload({ ...EMPTY_KICKOFF, title: "Night", isOnline: false, foodMode: "provided", foodOwnerId: "p" }),
    { title: "Night", agenda: "", isOnline: false, foodMode: "provided", foodOwnerId: "p" });
});

test("how an earlier round ended", () => {
  const r = (over: Partial<Poll>): Poll => ({
    id: "r", round: 1, status: "closed", result: null, closedReason: null, quorum: 2, eligibleIds: [], voted: [],
    winningOptionId: null, tiedOptionIds: [], options: [], ...over,
  });
  assert.equal(roundOutcome(r({ closedReason: "gm_reshortlisted", result: "tie" })), "replaced by a new shortlist");
  assert.equal(roundOutcome(r({ closedReason: "cancelled" })), "cancelled");
  assert.equal(roundOutcome(r({ result: "no_quorum" })), "failed: nothing reached quorum");
  assert.equal(roundOutcome(r({ result: "tie" })), "tied");
  assert.equal(roundOutcome(r({ result: "winner" })), "decided");
  assert.equal(roundOutcome(r({ status: "open" })), "open");
});
