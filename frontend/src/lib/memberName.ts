/** The account behind a campaign member, as GET /api/campaigns/:id/members populates it. */
export interface MemberPerson {
    handle?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
}

/**
 * What to call a campaign member: their account's handle, then name, then
 * first and last name, the same order as personDisplayName on the backend.
 *
 * The member row's own name and email are only a fallback. Since Phase 3 the
 * row points at its person by person_id alone, and Salesforce-synced rows carry
 * no name or email at all (#108).
 */
export function memberName(m: { person?: MemberPerson | null; firstName?: string; lastName?: string; email?: string }): string {
    const p = m.person;
    if (p?.handle) return p.handle;
    if (p?.name) return p.name;
    const personName = [p?.firstName, p?.lastName].filter(Boolean).join(' ');
    if (personName) return personName;
    const rowName = [m.firstName, m.lastName].filter(Boolean).join(' ');
    if (rowName) return rowName;
    // Never the full address.
    if (m.email) return m.email.split('@')[0];
    return 'Unknown Player';
}
