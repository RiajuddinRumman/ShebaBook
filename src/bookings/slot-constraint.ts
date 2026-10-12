import { Prisma } from '../generated/prisma/client.js';

export const PROVIDER_SLOT_CONSTRAINT = 'bookings_provider_slot_exclusive';
export const CUSTOMER_SLOT_CONSTRAINT = 'bookings_customer_slot_exclusive';

export type SlotOwner = 'provider' | 'customer';

interface PostgresCause {
  message?: unknown;
  originalMessage?: unknown;
}

/**
 * Prisma wraps a Postgres exclusion violation in a generic request error, so
 * the constraint name in the wrapped message is what distinguishes "this
 * provider is busy" from "this customer is double booked".
 */
function diagnosticText(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: PostgresCause } } })?.meta
    ?.driverAdapterError?.cause;

  return [
    error instanceof Error ? error.message : '',
    typeof cause?.message === 'string' ? cause.message : '',
    typeof cause?.originalMessage === 'string' ? cause.originalMessage : '',
  ].join('\n');
}

export function slotViolationOwner(error: unknown): SlotOwner | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return null;
  }
  const text = diagnosticText(error);
  if (text.includes(PROVIDER_SLOT_CONSTRAINT)) {
    return 'provider';
  }
  return text.includes(CUSTOMER_SLOT_CONSTRAINT) ? 'customer' : null;
}
