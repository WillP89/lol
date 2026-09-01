-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_planId_fkey";

-- DropForeignKey
ALTER TABLE "BookingParticipant" DROP CONSTRAINT "BookingParticipant_userId_fkey";

-- DropForeignKey
ALTER TABLE "CrewRecommendation" DROP CONSTRAINT "CrewRecommendation_planId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_bookingId_fkey";

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_senderId_fkey";

-- DropForeignKey
ALTER TABLE "RewindSignal" DROP CONSTRAINT "RewindSignal_userId_fkey";

-- AddForeignKey
ALTER TABLE "CrewRecommendation" ADD CONSTRAINT "CrewRecommendation_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingParticipant" ADD CONSTRAINT "BookingParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewindSignal" ADD CONSTRAINT "RewindSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
