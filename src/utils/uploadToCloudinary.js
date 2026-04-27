import cloudinary from "../config/cloudinary.js"

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer - File buffer from multer memoryStorage
 * @param {string} folder - Cloudinary folder path (e.g. "quickserve/business-logos")
 * @param {string} [mimeType="image/jpeg"] - MIME type for the base64 data URI
 * @returns {{ secure_url: string, public_id: string }}
 */
export async function uploadToCloudinary(buffer, folder, mimeType = "image/jpeg") {
  const base64 = buffer.toString("base64")
  const dataUri = `data:${mimeType};base64,${base64}`

  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: "image",
  })

  return {
    secure_url: result.secure_url,
    public_id: result.public_id,
  }
}

/**
 * Delete an image from Cloudinary by its public_id.
 * Silently succeeds if the image doesn't exist.
 * @param {string} publicId
 */
export async function deleteFromCloudinary(publicId) {
  if (!publicId) return
  try {
    await cloudinary.uploader.destroy(publicId)
  } catch (err) {
    console.error("[deleteFromCloudinary] Failed to delete:", publicId, err.message)
  }
}
