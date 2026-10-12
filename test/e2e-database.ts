const baseUrl = process.env.DATABASE_URL;

if (!baseUrl) {
  throw new Error('DATABASE_URL must be set to run the e2e suite (see .env.example)');
}

const url = new URL(baseUrl);

export const E2E_DATABASE_NAME = 'shebabook_e2e';
url.pathname = `/${E2E_DATABASE_NAME}`;
export const E2E_DATABASE_URL = url.toString();

const maintenance = new URL(E2E_DATABASE_URL);
maintenance.pathname = '/postgres';
export const MAINTENANCE_DATABASE_URL = maintenance.toString();
