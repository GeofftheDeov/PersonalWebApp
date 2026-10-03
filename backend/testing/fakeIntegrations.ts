/**
 * A recording fake for the integrations module (#79). Test code only:
 * production never imports anything under testing/, and
 * scripts/test-integrations-stub.ts checks that.
 *
 *   const fake = createFakeIntegrations();
 *   const uninstall = fake.install();              // every integrations() caller now gets the fake
 *   ...drive the app over HTTP...
 *   fake.calls("discord.createScheduledEvent")     // [{ name, args, result | error }], in call order
 *   fake.fail("google.createCalendarEvent", new Error("Google Calendar API 500"));   // the next call throws
 *   fake.respond("uploads.presignPut", async (input) => ({ ... }));                 // script the result
 *   uninstall();
 *
 * Each call is recorded under "<service>.<method>", e.g. "discord.createScheduledEvent".
 * By default calls succeed with predictable fake values, so a test only sets up what it cares about.
 */
import { installIntegrations, type Integrations } from "../utils/integrations.js";

type Service = keyof Integrations;

/** Every call the module offers, as "<service>.<method>". */
export type CallName = { [S in Service]: `${S}.${keyof Integrations[S] & string}` }[Service];

/** The function signature behind a call name. */
export type CallFn<N extends CallName> = N extends `${infer S extends Service}.${infer M}`
    ? M extends keyof Integrations[S] ? Integrations[S][M] extends (...args: any[]) => any ? Integrations[S][M] : never : never
    : never;

export interface RecordedCall<N extends CallName = CallName> {
    name: N;
    args: Parameters<CallFn<N>>;
    /** Set when the call succeeded. */
    result?: Awaited<ReturnType<CallFn<N>>>;
    /** Set when the call threw (e.g. one made to fail with `fail`). */
    error?: Error;
}

type Handlers = { [N in CallName]: CallFn<N> };

/**
 * Default results: predictable ids, numbered in call order across the fake.
 * Adding a method to `Integrations` makes this table fail to compile until it
 * has a default here too.
 */
function defaultHandlers(next: () => number): Handlers {
    return {
        "discord.createScheduledEvent": async () => ({ id: `fake-discord-event-${next()}` }),
        "google.createCalendarEvent": async () => ({ id: `fake-google-event-${next()}` }),
        "google.freeBusy": async () => [],   // an empty calendar
        "uploads.presignPut": async (input) => ({
            url: `https://fake-uploads.test/${input.key}?signature=fake-${next()}`,
            method: "PUT",
            headers: { "Content-Type": input.contentType },
            key: input.key,
            expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? 300) * 1000),
        }),
    };
}

export function createFakeIntegrations() {
    let counter = 0;
    const next = () => ++counter;
    let handlers = defaultHandlers(next);
    let failures = new Map<CallName, { error: Error; remaining: number }[]>();
    const recorded: RecordedCall[] = [];

    async function dispatch(name: CallName, args: unknown[]): Promise<unknown> {
        const entry = { name, args } as RecordedCall;
        recorded.push(entry);
        const queue = failures.get(name);
        const failure = queue?.[0];
        if (failure) {
            if (--failure.remaining <= 0) queue!.shift();
            entry.error = failure.error;
            throw failure.error;
        }
        try {
            const result = await (handlers[name] as (...a: unknown[]) => Promise<unknown>)(...args);
            entry.result = result as any;
            return result;
        } catch (err: any) {
            entry.error = err;
            throw err;
        }
    }

    // Build { service: { method: (...args) => dispatch("service.method", args) } } from the handler table.
    const integrations = {} as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    for (const name of Object.keys(handlers) as CallName[]) {
        const [service, method] = name.split(".");
        (integrations[service] ??= {})[method] = (...args) => dispatch(name, args);
    }

    return {
        /** The fake itself, for code that takes an `Integrations` directly. */
        integrations: integrations as unknown as Integrations,

        /** Make every `integrations()` caller use this fake. Returns the uninstaller. */
        install: () => installIntegrations(integrations as unknown as Integrations),

        /** Calls received so far, in order, optionally only those of one name. */
        calls<N extends CallName>(name?: N): RecordedCall<N>[] {
            return (name ? recorded.filter((c) => c.name === name) : [...recorded]) as RecordedCall<N>[];
        },

        /**
         * Make the next call of this name throw `error` (still recorded, with `error` set).
         * `times` makes it fail that many calls in a row; `Infinity` until `reset`.
         * Several `fail`s for one name queue up in order.
         */
        fail(name: CallName, error: Error = new Error(`fake ${name} failed`), { times = 1 }: { times?: number } = {}) {
            if (!(times >= 1)) throw new Error(`fail(${name}): times must be at least 1`);
            failures.set(name, [...(failures.get(name) ?? []), { error, remaining: times }]);
        },

        /** Replace what calls of this name return (or throw), until `reset`. */
        respond<N extends CallName>(name: N, handler: CallFn<N>) {
            (handlers as Record<CallName, unknown>)[name] = handler;
        },

        /** Forget the recorded calls. Pending failures and scripted responses stay. */
        clear() {
            recorded.length = 0;
        },

        /** Back to a fresh fake: no calls, failures or scripted responses. */
        reset() {
            recorded.length = 0;
            failures = new Map();
            counter = 0;
            handlers = defaultHandlers(next);
        },
    };
}

export type FakeIntegrations = ReturnType<typeof createFakeIntegrations>;
