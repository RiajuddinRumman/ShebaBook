import { Injectable } from '@nestjs/common';

import { Booking, BookingStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ConflictSummary,
  CustomerDoubleBookingException,
  ListingNotBookableException,
  OutsideBookingWindowException,
  ProviderBusyException,
} from './booking-errors.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { computeEndsAt } from './overlap.js';
import { slotViolationOwner, type SlotOwner } from './slot-constraint.js';

/** Only these two states occupy the provider's calendar. */
const BOOKING_STATUSES = [BookingStatus.PENDING, BookingStatus.CONFIRMED];

const MIN_LEAD_MS = 60 * 60_000;
const MAX_HORIZON_MS = 90 * 24 * 60 * 60_000;

interface Slot {
  readonly customerId: string;
  readonly providerId: string;
  readonly listingId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

@Injectable()
export class BookingService {
  constructor(private readonly prisma: PrismaService) {}

  async create(customerId: string, dto: CreateBookingDto): Promise<Booking> {
    const startsAt = new Date(dto.startsAt);

    const listing = await this.prisma.serviceListing.findUnique({
      where: { id: dto.listingId },
    });
    if (!listing || !listing.active) {
      throw new ListingNotBookableException();
    }

    // endsAt is derived here, never taken from the request. The database CHECK
    // on durationMinutes guarantees this range is non-empty.
    const slot: Slot = {
      customerId,
      providerId: listing.providerId,
      listingId: listing.id,
      startsAt,
      endsAt: computeEndsAt(startsAt, listing.durationMinutes),
    };
    this.assertInsideWindow(slot.startsAt, new Date());

    try {
      return await this.prisma.$transaction(async (tx) => {
        const providerConflict = await tx.booking.findFirst({
          where: occupancyWhere('provider', slot),
          select: conflictSelect,
        });
        if (providerConflict) {
          throw new ProviderBusyException(toSummary(providerConflict));
        }

        const customerConflict = await tx.booking.findFirst({
          where: occupancyWhere('customer', slot),
          select: conflictSelect,
        });
        if (customerConflict) {
          throw new CustomerDoubleBookingException(toSummary(customerConflict));
        }

        return tx.booking.create({
          data: {
            customerId: slot.customerId,
            providerId: slot.providerId,
            listingId: slot.listingId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          },
        });
      });
    } catch (error) {
      // Both read-no-conflict requests can pass the checks above; the exclusion
      // constraint then rejects the loser. Its row is committed by now, so
      // re-reading it produces the same 409 the pre-check would have.
      const occupant = slotViolationOwner(error);
      if (!occupant) {
        throw error;
      }
      throw (await this.occupancyConflict(occupant, slot)) ?? error;
    }
  }

  private async occupancyConflict(
    occupant: SlotOwner,
    slot: Slot,
  ): Promise<ProviderBusyException | CustomerDoubleBookingException | null> {
    const conflict = await this.prisma.booking.findFirst({
      where: occupancyWhere(occupant, slot),
      select: conflictSelect,
    });
    // A concurrent cancellation can clear the slot between the failed write and
    // this read, which leaves nothing to name in the report.
    if (!conflict) {
      return null;
    }
    const summary = toSummary(conflict);
    return occupant === 'provider'
      ? new ProviderBusyException(summary)
      : new CustomerDoubleBookingException(summary);
  }

  private assertInsideWindow(startsAt: Date, now: Date): void {
    if (startsAt.getTime() <= now.getTime()) {
      throw new OutsideBookingWindowException('startsAt must be in the future');
    }
    if (startsAt.getTime() < now.getTime() + MIN_LEAD_MS) {
      throw new OutsideBookingWindowException(
        'startsAt must be at least one hour ahead',
      );
    }
    if (startsAt.getTime() > now.getTime() + MAX_HORIZON_MS) {
      throw new OutsideBookingWindowException(
        'startsAt must be no more than 90 days ahead',
      );
    }
  }
}

const conflictSelect = { id: true, startsAt: true, endsAt: true } as const;

function occupancyWhere(
  occupant: SlotOwner,
  slot: Slot,
): Prisma.BookingWhereInput {
  return {
    status: { in: BOOKING_STATUSES },
    startsAt: { lt: slot.endsAt },
    endsAt: { gt: slot.startsAt },
    ...(occupant === 'provider'
      ? { providerId: slot.providerId }
      : { customerId: slot.customerId }),
  };
}

function toSummary(conflict: {
  id: string;
  startsAt: Date;
  endsAt: Date;
}): ConflictSummary {
  return {
    bookingId: conflict.id,
    startsAt: conflict.startsAt,
    endsAt: conflict.endsAt,
  };
}
