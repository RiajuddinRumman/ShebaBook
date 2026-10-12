import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

export interface ConflictSummary {
  bookingId: string;
  startsAt: Date;
  endsAt: Date;
}

export class ListingNotBookableException extends NotFoundException {
  constructor() {
    super({
      code: 'LISTING_NOT_BOOKABLE',
      message: 'This service listing is not available for booking',
    });
  }
}

export class OutsideBookingWindowException extends BadRequestException {
  constructor(reason: string) {
    super({ code: 'OUTSIDE_BOOKING_WINDOW', message: reason });
  }
}

export class ProviderBusyException extends ConflictException {
  constructor(conflict: ConflictSummary) {
    super({
      code: 'PROVIDER_BUSY',
      message: 'The provider already has a booking overlapping this time',
      conflict,
    });
  }
}

export class CustomerDoubleBookingException extends ConflictException {
  constructor(conflict: ConflictSummary) {
    super({
      code: 'CUSTOMER_DOUBLE_BOOKED',
      message: 'You already have a booking overlapping this time',
      conflict,
    });
  }
}
