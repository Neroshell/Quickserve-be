import express from "express"
import multer from "multer"
import Business from "../models/Business.js"
import MenuItem from "../models/menuItem.js"
import {
  invalidateMenuItems,
  invalidatePublicBusinessConfig,
  invalidatePublicBusinessRoute,
} from "../services/cacheInvalidationService.js"
import { uploadToCloudinary, deleteFromCloudinary } from "../utils/uploadToCloudinary.js"
import { requireAnyPermission, requireAuth, requireManagementArea, requirePermission } from "../middleware/authMiddleware.js"
import { PERMISSIONS } from "../constants/permissions.js"
import { MANAGEMENT_ACCESS_AREAS } from "../constants/managementAccess.js"

const router = express.Router()

router.use(requireAuth)

// Memory storage — no files written to disk
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  // Multer emits LIMIT_FILE_SIZE when the byte count reaches this boundary,
  // so allow one parser byte beyond the public maximum and enforce 5MB below.
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES + 1 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"]
    if (!allowedMimes.includes(file.mimetype)) {
      return cb(new Error("Invalid file type. Only JPEG, PNG, and WEBP images are allowed."))
    }
    cb(null, true)
  },
})

export function uploadSingleImage(req, res, next) {
  upload.single("image")(req, res, (error) => {
    if (!error) {
      if (req.file?.size > MAX_IMAGE_UPLOAD_BYTES) {
        return res.status(413).json({ error: "Image must be 5MB or smaller." })
      }
      return next()
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Image must be 5MB or smaller." })
    }
    if (error?.message?.startsWith("Invalid file type")) {
      return res.status(415).json({ error: error.message })
    }
    console.error("[upload/image-middleware]", error)
    return res.status(400).json({ error: "Image upload could not be processed." })
  })
}

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
router.post(
  "/image",
  requireAnyPermission(PERMISSIONS.MENU_MANAGE, PERMISSIONS.SERVICE_POINTS_MANAGE),
  uploadSingleImage,
  async (req, res) => {
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
  },
)

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
router.post(
  "/business-logo",
  requireManagementArea(MANAGEMENT_ACCESS_AREAS.BRANDING),
  uploadSingleImage,
  async (req, res) => {
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
      $or: [{ businessId }, { businessId: businessId }],
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

    await Promise.all([
      invalidatePublicBusinessConfig(businessId),
      invalidatePublicBusinessRoute(business.countryCode, business.slug),
    ])

    return res.json({ logoUrl: secure_url, publicId: public_id })
  } catch (err) {
    console.error("[upload/business-logo]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
  },
)

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
router.post(
  "/menu-item",
  requirePermission(PERMISSIONS.MENU_MANAGE),
  uploadSingleImage,
  async (req, res) => {
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

    const menuItem = await MenuItem.findOne({ _id: menuItemId, businessId, archivedAt: null })
    if (!menuItem) {
      return res.status(404).json({ error: "Menu item not found" })
    }

    const previousPublicId = menuItem.imagePublicId || null
    const { secure_url, public_id } = await uploadToCloudinary(
      req.file.buffer,
      "quickserve/menu-items",
      req.file.mimetype
    )

    try {
      menuItem.imageUrl = secure_url
      menuItem.imagePublicId = public_id
      await menuItem.save()
    } catch (saveError) {
      try {
        await deleteFromCloudinary(public_id)
      } catch (cleanupError) {
        console.error("[upload/menu-item] failed to clean up replacement image", cleanupError)
      }
      throw saveError
    }

    try {
      await invalidateMenuItems(businessId)
    } catch (cacheError) {
      console.error("[upload/menu-item] cache invalidation failed", cacheError)
    }

    if (previousPublicId && previousPublicId !== public_id) {
      try {
        await deleteFromCloudinary(previousPublicId)
      } catch (cleanupError) {
        console.error("[upload/menu-item] previous image cleanup failed", cleanupError)
      }
    }

    return res.json({ imageUrl: secure_url, publicId: public_id })
  } catch (err) {
    console.error("[upload/menu-item]", err)
    return res.status(500).json({ error: err.message || "Upload failed" })
  }
  },
)


export default router

