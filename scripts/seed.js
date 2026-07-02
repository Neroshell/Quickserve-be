import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: './.env' });
import Plan from '../src/models/Plan.js';

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    try {
        const defaultPlans = [
            { name: 'Basic', slug: 'basic', offlineCommissionRate: 2.5, monthlyPrice: 0, level: 1 },
            { name: 'Growth', slug: 'growth', offlineCommissionRate: 3.0, monthlyPrice: 0, level: 2 },
            { name: 'Pro', slug: 'pro', offlineCommissionRate: 4.0, monthlyPrice: 0, level: 3 },
        ];
        
        for (const p of defaultPlans) {
            await Plan.findOneAndUpdate(
                { name: p.name },
                { $set: p },
                { upsert: true, new: true }
            );
        }
        console.log('Plans seeded successfully!');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});

const plan = await Plan.findOne({ slug: "growth" })

console.log(plan.commissionPercentage)