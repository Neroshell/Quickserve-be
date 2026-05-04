import express from "express"
import multer from "multer"
import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import { uploadToCloudinary, deleteFromCloudinary } from "../utils/uploadToCloudinary.js"

const router = express.Router()

// Memory storage — no files written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"))
    }
    cb(null, true)
  },
})

/**
 * POST /upload/image
 * General-purpose upload — returns URL + publicId, no DB write.
 * Body (multipart/form-data): image (file), folder (optional string, default: "quickserve/general")
 */
router.post("/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" })
    }
    const folder = req.body.folder || "quickserve/general"
    const { secure_url, public_id } = await uploadToCloudinary(
      req.file.buffer,
      folder,
      req.file.mimetype
    )
    return res.json({ url: secure_url, publicId: public_id })
  } catch (err) {
    console.error("[upload/image]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
})

/**
 * POST /upload/business-logo
 * Body (multipart/form-data): image (file), businessId (string)
 */
router.post("/business-logo", upload.single("image"), async (req, res) => {
  try {
    const { businessId } = req.body

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    // Delete old logo from Cloudinary if it exists
    if (business.logoPublicId) {
      await deleteFromCloudinary(business.logoPublicId)
    }

    // Upload new logo
    const { secure_url, public_id } = await uploadToCloudinary(
      req.file.buffer,
      "quickserve/business-logos",
      req.file.mimetype
    )

    // Persist to database
    business.logoUrl = secure_url
    business.logoPublicId = public_id
    await business.save()

    return res.json({ logoUrl: secure_url, publicId: public_id })
  } catch (err) {
    console.error("[upload/business-logo]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
})

/**
 * POST /upload/menu-item
 * Body (multipart/form-data): image (file), menuItemId (string)
 */
router.post("/menu-item", upload.single("image"), async (req, res) => {
  try {
    const { menuItemId } = req.body

    if (!menuItemId) {
      return res.status(400).json({ error: "menuItemId is required" })
    }
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" })
    }

    const menuItem = await MenuItem.findById(menuItemId)
    if (!menuItem) {
      return res.status(404).json({ error: "Menu item not found" })
    }

    // Delete old image from Cloudinary if it exists
    if (menuItem.imagePublicId) {
      await deleteFromCloudinary(menuItem.imagePublicId)
    }

    // Upload new image
    const { secure_url, public_id } = await uploadToCloudinary(
      req.file.buffer,
      "quickserve/menu-items",
      req.file.mimetype
    )

    // Persist to database
    menuItem.imageUrl = secure_url
    menuItem.imagePublicId = public_id
    await menuItem.save()

    return res.json({ imageUrl: secure_url, publicId: public_id })
  } catch (err) {
    console.error("[upload/menu-item]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
})

/**
 * POST /upload/menu-banner
 * Upload a promotional banner image and attach it to the business.
 * Body (multipart/form-data): image (file), businessId (string)
 * Sets menuBannerEnabled = true automatically on upload.
 */
router.post("/menu-banner", upload.single("image"), async (req, res) => {
  try {
    const { businessId } = req.body

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    // Delete previous banner from Cloudinary if one exists
    if (business.menuBannerPublicId) {
      await deleteFromCloudinary(business.menuBannerPublicId)
    }

    const { secure_url, public_id } = await uploadToCloudinary(
      req.file.buffer,
      "quickserve/menu-banners",
      req.file.mimetype
    )

    business.menuBannerImageUrl = secure_url
    business.menuBannerPublicId = public_id
    business.menuBannerEnabled  = true
    await business.save()

    return res.json({
      menuBannerImageUrl: secure_url,
      menuBannerPublicId: public_id,
      menuBannerEnabled:  true,
    })
  } catch (err) {
    console.error("[upload/menu-banner POST]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
})

/**
 * PATCH /upload/menu-banner
 * Enable or disable the menu banner without deleting the image.
 * Body: { businessId: string, menuBannerEnabled: boolean }
 */
router.patch("/menu-banner", async (req, res) => {
  try {
    const { businessId, menuBannerEnabled } = req.body

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }
    if (typeof menuBannerEnabled !== "boolean") {
      return res.status(400).json({ error: "menuBannerEnabled (boolean) is required" })
    }

    const business = await Business.findOneAndUpdate(
      { $or: [{ businessId }, { restaurantId: businessId }] },
      { menuBannerEnabled },
      { new: true }
    )
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    return res.json({ menuBannerEnabled: business.menuBannerEnabled })
  } catch (err) {
    console.error("[upload/menu-banner PATCH]", err)
    return res.status(500).json({ error: err.message || "Failed to update banner" })
  }
})

/**
 * DELETE /upload/menu-banner
 * Remove the banner image from Cloudinary and clear all banner fields.
 * Body: { businessId: string }
 */
router.delete("/menu-banner", async (req, res) => {
  try {
    const { businessId } = req.body

    if (!businessId) {
      return res.status(400).json({ error: "businessId is required" })
    }

    const business = await Business.findOne({
      $or: [{ businessId }, { restaurantId: businessId }],
    })
    if (!business) {
      return res.status(404).json({ error: "Business not found" })
    }

    if (business.menuBannerPublicId) {
      await deleteFromCloudinary(business.menuBannerPublicId)
    }

    business.menuBannerImageUrl = ""
    business.menuBannerPublicId = ""
    business.menuBannerEnabled  = false
    await business.save()

    return res.json({ success: true })
  } catch (err) {
    console.error("[upload/menu-banner DELETE]", err)
    return res.status(500).json({ error: err.message || "Failed to delete banner" })
  }
})

export default router

