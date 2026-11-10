/**
 * The test hosts: the production and dev hostnames (spec #69's "Hosts" table)
 * moved under `geoffthedeov.test`, a parent domain of their own, so the session
 * cookie goes on the parent domain and reaches both sites as it does in prod.
 *
 * They resolve to 127.0.0.1 only inside the test browser, through Chromium's
 * host-resolver rules: no hosts file, no DNS, no network. `.test` is reserved
 * (RFC 2606), so none of them can be anyone's real site. The ports are the
 * stack's, chosen per run, and cookies ignore ports.
 *
 * Node's own HTTP clients (Playwright's `request`, fetch) don't use those
 * rules, which is why the fixtures talk to the backend at 127.0.0.1 instead.
 */
export const PARENT_DOMAIN = "geoffthedeov.test";

export interface Environment {
  /** The portfolio's host. */
  portfolio: string;
  /** Hearthside's host. */
  hearthside: string;
  /** The session cookie's name (SESSION_COOKIE_NAME), as in the environment it stands for. */
  cookieName: string;
}

/** Production's hosts, which the stack serves. */
export const PROD: Environment = {
  portfolio: PARENT_DOMAIN,
  hearthside: `hearthside.${PARENT_DOMAIN}`,
  cookieName: "gtd_session",
};

/**
 * Dev's hosts (`deov.`). They resolve and the certificate covers them, but the
 * stack doesn't serve a dev environment: a test of the two environments' cookies
 * starts one alongside (a backend with DEV's cookie name and its own secret).
 */
export const DEV: Environment = {
  portfolio: `deov.${PARENT_DOMAIN}`,
  hearthside: `deov.hearthside.${PARENT_DOMAIN}`,
  cookieName: "gtd_session_deov",
};

export const ALL_HOSTS = [PROD.portfolio, PROD.hearthside, DEV.portfolio, DEV.hearthside];

/** Chromium's --host-resolver-rules: the parent domain and every name under it go to loopback. */
export const HOST_RESOLVER_RULES = `MAP ${PARENT_DOMAIN} 127.0.0.1, MAP *.${PARENT_DOMAIN} 127.0.0.1`;
