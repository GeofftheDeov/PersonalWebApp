/**
 * Session planning (#57), seam 2: the pure availability function.
 *
 * Table-driven, no database. Every expected instant below was worked out by
 * hand from the zone rules, not by running the code:
 *
 *   Europe/London    BST (UTC+1) until Sun Oct 25 2026 01:00 UTC, then GMT.
 *   America/Chicago  CDT (UTC-5) until Sun Nov 1 2026 07:00 UTC, then CST
 *                    (UTC-6); CST -> CDT on Sun Mar 8 2026 at 08:00 UTC.
 *   Oct 2026: Fri 2, 9, 16, 23, 30 · Sat 3, 10, 17, 24, 31 · Sun 4 ... Nov 1.
 *
 * Run:  npx tsx scripts/test-availability-math.ts
 */
import {
    computeOverlap, isValidTimeZone, localTimeToInstant, parseTimeOfDay, resolveQuorum,
    type AvailabilityException, type BusyBlock, type OverlapInput, type WeeklyWindow,
} from "../planning/availability.js";

let pass = 0, fail = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        pass++;
    } catch (e: any) {
        console.log(`  FAIL  ${name}\n          ${e.message}`);
        fail++;
    }
}

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString().replace(":00.000Z", "Z");
function same(actual: unknown, expected: unknown) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`expected ${e}\n          got      ${a}`);
}

const CHI = "America/Chicago", LON = "Europe/London";
const win = (personId: string, weekday: number, start: string, end: string, timeZone: string): WeeklyWindow =>
    ({ personId, weekday, start, end, timeZone });

function overlap(over: Partial<OverlapInput> & Pick<OverlapInput, "party" | "range" | "slotMinutes">) {
    return computeOverlap({ windows: [], exceptions: [], busy: [], quorum: over.party.length, ...over });
}
/** Start times (in time order) of the slots where exactly these people are free. */
const startsWhereFree = (slots: ReturnType<typeof computeOverlap>, who: string[]) =>
    slots.filter((s) => JSON.stringify(s.free) === JSON.stringify(who))
        .map((s) => s.start.getTime()).sort((a, b) => a - b).map((t) => iso(new Date(t)));

console.log("\n#57 — availability math\n");

// ── time zones ──────────────────────────────────────────────────────────────

check("local wall time maps to the right instant on an ordinary day", () => {
    same(iso(localTimeToInstant({ y: 2026, m: 11, d: 1 }, 17, 0, CHI)), "2026-11-01T23:00Z");
    same(iso(localTimeToInstant({ y: 2026, m: 10, d: 24 }, 19, 0, LON)), "2026-10-24T18:00Z");
});

check("a time the spring-forward skips moves forward by the gap (2:30 am -> 3:30 am CDT)", () => {
    same(iso(localTimeToInstant({ y: 2026, m: 3, d: 8 }, 2, 30, CHI)), "2026-03-08T08:30Z");
});

check("a time the fall-back repeats takes its first occurrence (1:30 am CDT)", () => {
    same(iso(localTimeToInstant({ y: 2026, m: 11, d: 1 }, 1, 30, CHI)), "2026-11-01T06:30Z");
});

check("time zones are validated against the runtime's IANA database", () => {
    same([CHI, LON, "UTC", "Asia/Kolkata"].map(isValidTimeZone), [true, true, true, true]);
    same(["Mars/Olympus_Mons", "", 42, null].map(isValidTimeZone), [false, false, false, false]);
});

check("times of day parse as HH:MM, 00:00-23:59 only", () => {
    same(parseTimeOfDay("21:30"), { hour: 21, minute: 30 });
    same(["24:00", "9:00", "12:60", "noon", undefined].map(parseTimeOfDay), [null, null, null, null, null]);
});

// ── players in America/Chicago and Europe/London together ───────────────────

check("Chicago + London: the overlap follows each zone's own DST change", () => {
    // Chicago plays Sat 1-5 pm, London Sat 7-11 pm. While both are on summer
    // time those are the same four hours; London falls back a week before
    // Chicago, so on Oct 31 they share three; from Nov 7 four again.
    const slots = overlap({
        party: ["chi", "lon"],
        windows: [win("chi", 6, "13:00", "17:00", CHI), win("lon", 6, "19:00", "23:00", LON)],
        range: { start: at("2026-10-24T00:00Z"), end: at("2026-11-08T00:00Z") },
        slotMinutes: 60, stepMinutes: 60,
    });
    same(startsWhereFree(slots, ["chi", "lon"]), [
        "2026-10-24T18:00Z", "2026-10-24T19:00Z", "2026-10-24T20:00Z", "2026-10-24T21:00Z",
        "2026-10-31T19:00Z", "2026-10-31T20:00Z", "2026-10-31T21:00Z",
        "2026-11-07T19:00Z", "2026-11-07T20:00Z", "2026-11-07T21:00Z", "2026-11-07T22:00Z",
    ]);
});

// ── a window crossing midnight ──────────────────────────────────────────────

check("Fri 9 pm - 1 am runs into Saturday morning", () => {
    // Fri Oct 16 9 pm CDT = Oct 17 02:00Z, until Sat 1 am CDT = 06:00Z.
    const slots = overlap({
        party: ["p"], windows: [win("p", 5, "21:00", "01:00", CHI)],
        range: { start: at("2026-10-16T20:00Z"), end: at("2026-10-17T10:00Z") },
        slotMinutes: 120,
    });
    same(startsWhereFree(slots, ["p"]),
        ["2026-10-17T02:00Z", "2026-10-17T02:30Z", "2026-10-17T03:00Z", "2026-10-17T03:30Z", "2026-10-17T04:00Z"]);
});

check("a window that began the local day before the range still counts inside it", () => {
    // The range opens at midnight Saturday, Chicago time; Friday's window is
    // still running until 1 am.
    const slots = overlap({
        party: ["p"], windows: [win("p", 5, "21:00", "01:00", CHI)],
        range: { start: at("2026-10-17T05:00Z"), end: at("2026-10-17T06:00Z") },
        slotMinutes: 60,
    });
    same(slots.map((s) => [iso(s.start), s.free]), [["2026-10-17T05:00Z", ["p"]]]);
});

check("a window ending at midnight meets one starting at midnight", () => {
    // Sat 10 pm - midnight, then Sun midnight - 2 am: one four-hour stretch.
    const slots = overlap({
        party: ["p"],
        windows: [win("p", 6, "22:00", "00:00", CHI), win("p", 0, "00:00", "02:00", CHI)],
        range: { start: at("2026-10-11T03:00Z"), end: at("2026-10-11T07:00Z") },
        slotMinutes: 240,
    });
    same(slots.map((s) => [iso(s.start), s.free]), [["2026-10-11T03:00Z", ["p"]]]);
});

// ── the DST change: Sun Nov 1 2026 in America/Chicago ────────────────────────

check("a weekly window keeps its wall time across the fall-back", () => {
    // Sun 5-11 pm: 22:00Z-04:00Z under CDT (Oct 25), 23:00Z-05:00Z under CST (Nov 1).
    const slots = overlap({
        party: ["p"], windows: [win("p", 0, "17:00", "23:00", CHI)],
        range: { start: at("2026-10-25T00:00Z"), end: at("2026-11-03T00:00Z") },
        slotMinutes: 360, stepMinutes: 60,
    });
    same(startsWhereFree(slots, ["p"]), ["2026-10-25T22:00Z", "2026-11-01T23:00Z"]);
});

check("a window spanning the fall-back ends at the first 1 am", () => {
    // Sat Oct 31 7 pm CDT (Nov 1 00:00Z) to Sun 1 am -- which happens twice;
    // the window ends at the first, 06:00Z, so it is six real hours long.
    const slots = overlap({
        party: ["p"], windows: [win("p", 6, "19:00", "01:00", CHI)],
        range: { start: at("2026-10-31T22:00Z"), end: at("2026-11-01T09:00Z") },
        slotMinutes: 30, stepMinutes: 30,
    });
    const free = startsWhereFree(slots, ["p"]);
    same([free.length, free[0], free[free.length - 1]], [12, "2026-11-01T00:00Z", "2026-11-01T05:30Z"]);
});

// ── exceptions ──────────────────────────────────────────────────────────────

check("an 'unavailable' exception overrides a window; an 'available' one adds a night", () => {
    // Sat 6-11 pm (23:00Z-04:00Z). Out all day Sat Oct 17; free Tue Oct 20, 6-11 pm.
    const exceptions: AvailabilityException[] = [
        { personId: "p", kind: "unavailable", start: at("2026-10-17T05:00Z"), end: at("2026-10-18T05:00Z") },
        { personId: "p", kind: "available", start: at("2026-10-20T23:00Z"), end: at("2026-10-21T04:00Z") },
    ];
    const slots = overlap({
        party: ["p"], windows: [win("p", 6, "18:00", "23:00", CHI)], exceptions,
        range: { start: at("2026-10-10T00:00Z"), end: at("2026-10-26T00:00Z") },
        slotMinutes: 300, stepMinutes: 60,
    });
    same(startsWhereFree(slots, ["p"]), ["2026-10-10T23:00Z", "2026-10-20T23:00Z", "2026-10-24T23:00Z"]);
});

check("'unavailable' wins where it overlaps an 'available' exception", () => {
    const slots = overlap({
        party: ["p"],
        exceptions: [
            { personId: "p", kind: "available", start: at("2026-10-20T23:00Z"), end: at("2026-10-21T04:00Z") },
            { personId: "p", kind: "unavailable", start: at("2026-10-21T01:00Z"), end: at("2026-10-21T02:00Z") },
        ],
        range: { start: at("2026-10-20T23:00Z"), end: at("2026-10-21T04:00Z") },
        slotMinutes: 60, stepMinutes: 60,
    });
    same(startsWhereFree(slots, ["p"]), ["2026-10-20T23:00Z", "2026-10-21T00:00Z", "2026-10-21T02:00Z", "2026-10-21T03:00Z"]);
});

// ── busy blocks ─────────────────────────────────────────────────────────────

check("a busy block cuts a window; touching its edge is not a clash", () => {
    // Sat Oct 10 5-11 pm CDT (22:00Z-04:00Z), busy 7-8 pm (00:00Z-01:00Z).
    const busy: BusyBlock[] = [{ personId: "p", start: at("2026-10-11T00:00Z"), end: at("2026-10-11T01:00Z") }];
    const slots = overlap({
        party: ["p"], windows: [win("p", 6, "17:00", "23:00", CHI)], busy,
        range: { start: at("2026-10-10T20:00Z"), end: at("2026-10-11T06:00Z") },
        slotMinutes: 120, stepMinutes: 60,
    });
    same(startsWhereFree(slots, ["p"]), ["2026-10-10T22:00Z", "2026-10-11T01:00Z", "2026-10-11T02:00Z"]);
});

// ── "unknown" players ───────────────────────────────────────────────────────

check("no availability set is 'unknown', not 'busy', and never counts as free", () => {
    const slots = overlap({
        party: ["set", "newbie", "calOnly", "oneOff"],
        windows: [win("set", 6, "17:00", "23:00", CHI)],
        // calOnly has no windows, only a calendar; oneOff only an 'available' exception.
        busy: [{ personId: "calOnly", start: at("2026-10-11T00:00Z"), end: at("2026-10-11T01:00Z") }],
        exceptions: [{ personId: "oneOff", kind: "available", start: at("2026-10-10T22:00Z"), end: at("2026-10-11T00:00Z") }],
        range: { start: at("2026-10-10T22:00Z"), end: at("2026-10-11T02:00Z") },
        slotMinutes: 120, stepMinutes: 120, quorum: 1,
    });
    const byStart = Object.fromEntries(slots.map((s) => [iso(s.start), { free: s.free, busy: s.busy, unknown: s.unknown, n: s.headcount }]));
    same(byStart["2026-10-10T22:00Z"], { free: ["set", "oneOff"], busy: [], unknown: ["newbie", "calOnly"], n: 2 });
    same(byStart["2026-10-11T00:00Z"], { free: ["set"], busy: ["calOnly"], unknown: ["newbie", "oneOff"], n: 1 });
});

// ── quorum ──────────────────────────────────────────────────────────────────

check("quorum resolves to the whole party by default, and never above it", () => {
    same([resolveQuorum(null, 5), resolveQuorum(undefined, 5), resolveQuorum(4, 5), resolveQuorum(9, 5), resolveQuorum(3, 0)],
        [5, 5, 4, 5, 1]);
});

check("slots meeting quorum are flagged; ranking is by headcount, then earliest", () => {
    // Five players on Sat Oct 10 (CDT): all five at 6 pm, p5 gone at 6:30, p4 at 7.
    const windows = [
        win("p1", 6, "18:00", "22:00", CHI), win("p2", 6, "18:00", "22:00", CHI),
        win("p3", 6, "18:00", "22:00", CHI), win("p4", 6, "18:00", "19:00", CHI),
        win("p5", 6, "17:00", "18:30", CHI),
    ];
    const slots = overlap({
        party: ["p1", "p2", "p3", "p4", "p5"], windows, quorum: resolveQuorum(4, 5),
        range: { start: at("2026-10-10T22:00Z"), end: at("2026-10-11T03:00Z") },
        slotMinutes: 30, stepMinutes: 30,
    });
    same(slots.slice(0, 4).map((s) => [iso(s.start), s.headcount, s.meetsQuorum]), [
        ["2026-10-10T23:00Z", 5, true],   // 6:00 pm: everyone
        ["2026-10-10T23:30Z", 4, true],   // 6:30 pm: p5 has gone
        ["2026-10-11T00:00Z", 3, false],  // 7:00 pm: p4 too -- below quorum
        ["2026-10-11T00:30Z", 3, false],
    ]);
    same(slots.filter((s) => s.meetsQuorum).length, 2);
});

// ── the rest of the contract ────────────────────────────────────────────────

check("people outside the party are ignored; a repeated party id is counted once", () => {
    const slots = overlap({
        party: ["p", "p"], windows: [win("p", 6, "17:00", "23:00", CHI), win("stranger", 6, "17:00", "23:00", CHI)],
        range: { start: at("2026-10-10T22:00Z"), end: at("2026-10-11T00:00Z") },
        slotMinutes: 120,
    });
    same(slots.map((s) => [s.free, s.busy, s.unknown]), [[["p"], [], []]]);
});

check("every slot lies inside the range, starting on the step", () => {
    const slots = overlap({
        party: ["p"], range: { start: at("2026-10-10T22:10Z"), end: at("2026-10-11T01:00Z") },
        slotMinutes: 60, stepMinutes: 30,
    });
    same(slots.map((s) => iso(s.start)).sort(), ["2026-10-10T22:30Z", "2026-10-10T23:00Z", "2026-10-10T23:30Z", "2026-10-11T00:00Z"]);
});

check("bad input is refused rather than answered", () => {
    const base = { party: ["p"], range: { start: at("2026-10-01T00:00Z"), end: at("2026-10-02T00:00Z") }, slotMinutes: 60 };
    const refusals = [
        { ...base, range: { start: at("2026-10-02T00:00Z"), end: at("2026-10-01T00:00Z") } },
        { ...base, range: { start: at("2026-10-01T00:00Z"), end: at("2026-12-15T00:00Z") } },
        { ...base, range: { start: at("2026-10-01T00:00Z"), end: new Date("nope") } },
        { ...base, slotMinutes: 10 },
        { ...base, quorum: 0 },
        { ...base, windows: [win("p", 6, "17:00", "23:00", "Mars/Olympus_Mons")] },
    ].map((input) => { try { overlap(input); return "answered"; } catch (e) { return e instanceof RangeError ? "refused" : String(e); } });
    same(refusals, ["refused", "refused", "refused", "refused", "refused", "refused"]);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
