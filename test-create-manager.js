import mongoose from 'mongoose';

async function test() {
    await mongoose.connect('mongodb+srv://neromustlearn_db_user:HsDArn1Eb394vWct@cluster0.nin3vkd.mongodb.net/quickserve?retryWrites=true&w=majority');
    console.log("Connected to MongoDB");

    const ALLOWED_ROLES = ["waiter", "kitchen", "manager", "bartender", "co_owner"];

    const StaffSchema = new mongoose.Schema({
        businessId: { type: String, required: true, index: true },
        businessId: { type: String, index: true, sparse: true },
        staffId: { type: String, required: true },
        staffId: { type: String },
        role: {
            type: String,
            enum: ALLOWED_ROLES,
            default: "waiter"
        },
        name: { type: String, required: true },
        email: { 
            type: String, 
            required: true, 
            lowercase: true, 
            trim: true 
        },
        accountStatus: {
            type: String,
            enum: ["pending", "active", "disabled"],
            default: "pending"
        },
        presenceStatus: {
            type: String,
            enum: ["active", "offline"],
            default: "offline"
        },
        status: { 
            type: String, 
            enum: ["active", "offline"], 
            default: "offline" 
        },
        passwordHash: { type: String },
        inviteToken: { type: String, select: false },
        inviteTokenExpires: { type: Date },
        passwordResetToken: { type: String, index: true, select: false },
        passwordResetExpires: { type: Date },
    }, { timestamps: true });

    const Staff = mongoose.models.Staff || mongoose.model("Staff", StaffSchema, "waiters");

    try {
        const staff = await Staff.create({
            businessId: "test_biz",
            staffId: "MGR-1234",
            staffId: "MGR-1234",
            role: "manager",
            name: "Test Manager",
            email: "test.mgr@test.com",
            accountStatus: "pending",
            presenceStatus: "offline",
            status: "offline",
            inviteToken: "test",
            inviteTokenExpires: new Date()
        });
        console.log("Created successfully:", staff);
    } catch (err) {
        console.error("FAILED TO CREATE:", err);
    }
    
    await mongoose.disconnect();
}

test();
