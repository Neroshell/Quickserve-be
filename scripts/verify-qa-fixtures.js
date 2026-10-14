import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });
import Business from '../src/models/Business.js';
import { getReservationEligibility } from '../src/services/reservationEligibilityService.js';
import { evaluateDiscoveryPublicationEligibility } from '../src/services/discoveryPublicationService.js';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const ids = [
    'qa-biz-incomplete-onboarding',
    'qa-biz-suspended-business',
    'qa-biz-active-unpublished'
  ];
  const fixtures = await Business.find({ businessId: { $in: ids } }).lean();
  for (const b of fixtures) {
    const eligibility = getReservationEligibility(b);
    const pub = evaluateDiscoveryPublicationEligibility(b);
    console.log(JSON.stringify({
      businessId: b.businessId,
      status: b.status,
      onboardingCompleted: b.onboardingCompleted,
      discoveryPublished: b.propertyProfile?.discoveryPublished,
      bookingEligibility: eligibility,
      discoveryPublicationState: pub
    }, null, 2));
  }
  await mongoose.disconnect();
}
main().catch(console.error);
