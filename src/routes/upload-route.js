import express from "express"
import multer from "multer"
import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import { uploadToCloudinary, deleteFromCloudinary } from "../utils/uploadToCloudinary.js"
import { requireAuth, requireRole } from "../middleware/authMiddleware.js"

const router = express.Router()

// Require manager/owner level access for all uploads
router.use(requireAuth, requireRole("owner", "admin", "manager"))

// Memory storage — no files written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"]
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Only JPEG, PNG, and WEBP images are allowed."))
    }
    cb(null, true)
  },
})

/**
 * @openapi
 * /upload/image:
 *   post:
 *     summary: General image upload to Cloudinary (no DB write)
 *     tags:
 *       - Uploads
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *               folder:
 *                 type: string
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 publicId:
 *                   type: string
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
 * @openapi
 * /upload/business-logo:
 *   post:
 *     summary: Upload and update business logo
 *     tags:
 *       - Uploads
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *               - businessId
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *               businessId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logo uploaded and saved successfully
 */
router.post("/business-logo", upload.single("image"), async (req, res) => {
  try {
    // Always the authenticated user's own business — never a businessId from the body.
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
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
 * @openapi
 * /upload/menu-item:
 *   post:
 *     summary: Upload and update menu item image
 *     tags:
 *       - Uploads
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *               - menuItemId
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *               menuItemId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Menu item image uploaded and saved successfully
 */
router.post("/menu-item", upload.single("image"), async (req, res) => {
  try {
    // Scope to the authenticated user's business so one tenant can't overwrite
    // (or delete the Cloudinary asset of) another tenant's menu item.
    const businessId = req.session?.user?.businessId
    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" })
    }

    const { menuItemId } = req.body

    if (!menuItemId) {
      return res.status(400).json({ error: "menuItemId is required" })
    }
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" })
    }

    const menuItem = await MenuItem.findOne({ _id: menuItemId, businessId })
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


export default router

