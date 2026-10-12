import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingService } from './booking.service.js';

@Module({
  imports: [AuthModule],
  controllers: [BookingsController],
  providers: [BookingService],
})
export class BookingsModule {}
