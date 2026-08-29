const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://neromustlearn_db_user:HsDArn1Eb394vWct@cluster0.nin3vkd.mongodb.net/test').then(async () => {
    const res = await mongoose.connection.collection('reservations').find({ secureToken: { $ne: null } }).sort({ _id: -1 }).limit(1).toArray();
    console.log("Latest reservation with secureToken:", res[0]);
    if (res[0]) {
       const business = await mongoose.connection.collection('businesses').findOne({ businessId: res[0].businessId });
       console.log("Business stripe details:", {
          stripeAccountId: business.stripeAccountId,
          stripeChargesEnabled: business.stripeChargesEnabled,
          stripePayoutsEnabled: business.stripePayoutsEnabled
       });
    }
    process.exit();
});
