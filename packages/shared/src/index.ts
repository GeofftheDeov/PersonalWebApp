/**
 * @gtd/shared: what the portfolio and Hearthside share (spec #69). Import from
 * a subpath (`@gtd/shared/api`) to pull in only that piece.
 */
export * from "./api";
// The session's React hooks are `@gtd/shared/session/react`, kept out of here
// so bearer clients (scripts, desktop and mobile apps) never load React.
export * from "./session";
