import { SetMetadata } from '@nestjs/common';

import type { UserRole } from '../generated/prisma/client.js';

export const ROLES_KEY = 'auth:allowed-roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
