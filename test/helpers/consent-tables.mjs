/** Reset-only dependency list for disposable native fixtures; never use for production cleanup. */
export const consentTables = ['consent_ceremonies', 'consent_commands', 'consent_decisions', 'consent_recipients',
  'consent_requests', 'consent_authorities', 'consent_roster_members', 'consent_rosters', 'consent_policies', 'consent_budgets']
