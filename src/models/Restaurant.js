import mongoose from "mongoose"

const OperatingDaySchema = new mongoose.Schema({
    enabled: { type: Boolean, default: true },
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "22:00" }
}, { _id: false })

const OperatingHoursSchema = new mongoose.Schema({
    Monday: { type: OperatingDaySchema, default: () => ({}) },
    Tuesday: { type: OperatingDaySchema, default: () => ({}) },
    Wednesday: { type: OperatingDaySchema, default: () => ({}) },
    Thursday: { type: OperatingDaySchema, default: () => ({}) },
    Friday: { type: OperatingDaySchema, default: () => ({}) },
    Saturday: { type: OperatingDaySchema, default: () => ({}) },
    Sunday: { type: OperatingDaySchema, default: () => ({}) }
}, { _id: false })

const RestaurantSchema = new mongoose.Schema({
    restaurantId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    slug: {
        type: String,
        required: true,
        unique: true,
        index: true,
        lowercase: true,
        trim: true,
        minlength: 3,
        maxlength: 40,
        match: /^[a-z0-9-]+$/
    },
    address: { type: String, default: "" },
    phoneNumber: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    currency: { type: String, default: "USD" },
    timezone: { type: String, default: "America/New_York" },
    logoUrl: { type: String, default: "" },
    operatingHours: { type: OperatingHoursSchema, default: () => ({}) }
}, { timestamps: true })

export default mongoose.model("Restaurant", RestaurantSchema)
