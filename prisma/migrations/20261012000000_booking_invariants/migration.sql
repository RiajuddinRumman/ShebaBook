-- Prisma's schema language cannot express CHECK constraints. These guard the
-- invariant that Step 2 proved the overlap logic depends on: an invalid range
-- compares false against everything, which silently disables conflict
-- detection. Kept here so writes outside the service layer cannot poison data.

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_time_range_is_ordered"
  CHECK ("endsAt" > "startsAt");

ALTER TABLE "service_listings"
  ADD CONSTRAINT "service_listings_duration_is_positive"
  CHECK ("durationMinutes" > 0);

ALTER TABLE "service_listings"
  ADD CONSTRAINT "service_listings_price_is_non_negative"
  CHECK ("priceCents" >= 0);
