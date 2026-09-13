export class DatabaseConfigurationError extends Error {
  constructor() { super('The database connection is not configured correctly.'); this.name = 'DatabaseConfigurationError' }
}
