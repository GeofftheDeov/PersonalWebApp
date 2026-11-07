/**
 * @gtd/shared: what the portfolio and Hearthside share (spec #69). Import from
 * a subpath (`@gtd/shared/api`) to pull in only that piece.
 */
export * from "./api";
// The React hooks and components are `@gtd/shared/session/react`,
// `@gtd/shared/realtime/react`, `@gtd/shared/letters/react` and
// `@gtd/shared/topbar`, kept out of here so bearer clients (scripts, desktop
// and mobile apps) never load React.
export * from "./session";
export * from "./realtime";
export * from "./letters";
