/*
  Warnings:

  - Added the required column `providerId` to the `bookings` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "providerId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "bookings_providerId_startsAt_endsAt_idx" ON "bookings"("providerId", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "provider_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- gist index support for the TEXT id columns used on the `WITH =` side below.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The service checks for conflicts, but two requests can both read "no
-- conflict". These constraints make the overlap state unwritable, so the race
-- has no window. tsrange matches the naive UTC TIMESTAMP(3) columns exactly, so
-- no session timezone is ever consulted. '[)' keeps back-to-back slots legal and
-- bookings_time_range_is_ordered guarantees the range is never empty.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_slot_exclusive"
  EXCLUDE USING gist (
    "providerId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'));

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_slot_exclusive"
  EXCLUDE USING gist (
    "customerId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'));
