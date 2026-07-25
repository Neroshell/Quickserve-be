Created At: 2026-07-25T06:42:49Z
Completed At: 2026-07-25T06:42:50Z
File Path: `file:///C:/Users/pc/Desktop/Quickserve-be/src/controllers/publicController.js`
Total Lines: 605
Total Bytes: 23204
Showing lines 550 to 600
The following code has been modified to include a line number before every line, in the format: <line_number>: <original_line>. Please note that any changes targeting the original code should remove the line number, colon, and leading space.
550:     res.status(500).json({ error: "Server error" });
551:   }
552: }
553: 
554: /**
555:  * GET /public/reservations/by-id/:reservationId
556:  * Fetch a reservation by its MongoDB _id for the confirmation page (post-payment).
557:  * Only returns safe fields; does NOT expose secureToken.
558:  */
559: export async function getReservationById(req, res) {
560:   try {
561:     const { reservationId } = req.params;
562:     if (!reservationId) {
563:       return res.status(400).json({ error: "reservationId is required" });
564:     }
565: 
566:     const reservation = await Reservation.findById(reservationId)
567:       .select("-secureToken -stripeSessionId -paymentExpiresAt")
568:       .lean();
569:     if (!reservation) {
570:       return res.status(404).json({ error: "Reservation not found" });
571:     }
572: 
573:     const business = await Business.findOne({ businessId: reservation.businessId })
574:       .select("businessId name displayName logoUrl currency country")
575:       .lean();
576:     if (!business) {
577:       return res.status(404).json({ error: "Business not found" });
578:     }
579: 
580:     const pricing = getCustomerReservationPricing(reservation);
581:     delete reservation.stripeCheckoutSessionId;
582:     delete reservation.stripePaymentIntentId;
583:     delete reservation.stripeConnectedAccountId;
584:     delete reservation.platformFeeCents;
585:     delete reservation.businessAbsorbedPlatformFeeCents;
586:     delete reservation.platformFeeMode;
587:     delete reservation.customerPlatformFeePercent;
588:     delete reservation.planApplied;
589:     delete reservation.commissionRateApplied;
590:     delete reservation.commissionAmountCents;
591:     delete reservation.planAtOrder;
592:     delete reservation.commissionRateAtOrder;
593:     delete reservation.platformFeeRateAtOrder;
594:     delete reservation.grossAmount;
595:     delete reservation.netToBusinessAmount;
596:     delete reservation.amountPaidCents;
597: 
598:     res.json({ reservation: { ...reservation, pricing }, business });
599:   } catch (error) {
600:     console.error("[publicController.getReservationById] Error:", error);
The above content does NOT show the entire file contents. If you need to view any lines of the file which were not shown to complete your task, call this tool again to view those lines.
