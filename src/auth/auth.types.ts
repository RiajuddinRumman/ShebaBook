import { UserRole } from '../generated/prisma/client.js';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  email: string;
}

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  email: string;
}

/** Shape safe to serialise back to clients -- never the password hash. */
export type PublicUser = AuthenticatedUser;
