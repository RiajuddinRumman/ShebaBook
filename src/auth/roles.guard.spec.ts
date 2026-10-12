import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { CredentialsRequiredException } from './auth-errors.js';
import { RolesGuard } from './roles.guard.js';

const ROLES_KEY = 'auth:allowed-roles';

function guardRequiring(roles: UserRole[] | undefined): { guard: RolesGuard; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const reflector = {
    getAllAndOverride: vi.fn((key: string, targets: unknown[]) => {
      calls.push([key, targets]);
      return roles;
    }),
  } as unknown as Reflector;

  return { guard: new RolesGuard(reflector), calls };
}

function contextWith(user?: { role: UserRole }): ExecutionContext {
  const handler = function handler() {};
  class TestController {}

  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler,
    getClass: () => TestController,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('passes when a route declares no roles', () => {
    const { guard } = guardRequiring(undefined);
    expect(guard.canActivate(contextWith(undefined))).toBe(true);
  });

  it('passes when a route declares an empty role list', () => {
    const { guard } = guardRequiring([]);
    expect(guard.canActivate(contextWith(undefined))).toBe(true);
  });

  it.each([
    [UserRole.CUSTOMER, [UserRole.CUSTOMER]],
    [UserRole.PROVIDER, [UserRole.PROVIDER]],
    [UserRole.PROVIDER, [UserRole.CUSTOMER, UserRole.PROVIDER]],
  ])('allows a %s user on a route requiring %s', (role, required) => {
    const { guard } = guardRequiring(required as UserRole[]);
    expect(guard.canActivate(contextWith({ role }))).toBe(true);
  });

  it('forbids a provider from a customer-only booking route', () => {
    const { guard } = guardRequiring([UserRole.CUSTOMER]);

    expect(() => guard.canActivate(contextWith({ role: UserRole.PROVIDER }))).toThrow(
      ForbiddenException,
    );
  });

  it('reports required and actual roles in the 403 payload', () => {
    const { guard } = guardRequiring([UserRole.CUSTOMER]);

    let caught: unknown;
    try {
      guard.canActivate(contextWith({ role: UserRole.PROVIDER }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ForbiddenException);
    const response = (caught as ForbiddenException).getResponse() as Record<string, unknown>;
    expect(response.code).toBe('INSUFFICIENT_ROLE');
    expect(response.actual).toBe(UserRole.PROVIDER);
    expect(response.message).toContain(UserRole.CUSTOMER);
  });

  it('returns 401 rather than 403 when no authenticated user is present', () => {
    const { guard } = guardRequiring([UserRole.CUSTOMER]);

    expect(() => guard.canActivate(contextWith(undefined))).toThrow(CredentialsRequiredException);

    let caught: unknown;
    try {
      guard.canActivate(contextWith(undefined));
    } catch (error) {
      caught = error;
    }
    expect((caught as CredentialsRequiredException).getStatus()).toBe(401);
  });

  it('checks handler metadata before class metadata', () => {
    const { guard, calls } = guardRequiring(undefined);
    guard.canActivate(contextWith({ role: UserRole.CUSTOMER }));

    expect(calls).toHaveLength(1);
    const [key, targets] = calls[0] as [string, (() => unknown)[]];
    expect(key).toBe(ROLES_KEY);
    expect(targets).toHaveLength(2);
    expect(typeof targets[0]).toBe('function');
    expect(typeof targets[1]).toBe('function');
  });
});
