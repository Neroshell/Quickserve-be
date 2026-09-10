import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import express from "express"
import {
    MAX_IMAGE_UPLOAD_BYTES,
    uploadSingleImage,
} from "../src/routes/upload-route.js"

async function withUploadServer(run) {
    const app = express()
    app.post("/upload", uploadSingleImage, (req, res) => {
        res.json({ size: req.file.size, type: req.file.mimetype })
    })
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener))
    })
    try {
        const address = server.address()
        await run(`http://127.0.0.1:${address.port}/upload`)
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
}

function imageForm(byteLength, type = "image/png") {
    const form = new FormData()
    form.append("image", new Blob([new Uint8Array(byteLength)], { type }), "menu-image.png")
    return form
}

test("image middleware accepts the advertised 5MB maximum", async () => {
    await withUploadServer(async (url) => {
        const response = await fetch(url, {
            method: "POST",
            body: imageForm(MAX_IMAGE_UPLOAD_BYTES),
        })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), {
            size: MAX_IMAGE_UPLOAD_BYTES,
            type: "image/png",
        })
    })
})

test("image middleware returns a useful error above 5MB", async () => {
    await withUploadServer(async (url) => {
        const response = await fetch(url, {
            method: "POST",
            body: imageForm(MAX_IMAGE_UPLOAD_BYTES + 1),
        })
        assert.equal(response.status, 413)
        assert.deepEqual(await response.json(), { error: "Image must be 5MB or smaller." })
    })
})

test("image middleware rejects unsupported media types explicitly", async () => {
    await withUploadServer(async (url) => {
        const response = await fetch(url, {
            method: "POST",
            body: imageForm(32, "text/plain"),
        })
        assert.equal(response.status, 415)
        assert.deepEqual(await response.json(), {
            error: "Invalid file type. Only JPEG, PNG, and WEBP images are allowed.",
        })
    })
})

test("menu image replacement saves the new reference before deleting the old asset", async () => {
    const source = await readFile(new URL("../src/routes/upload-route.js", import.meta.url), "utf8")
    const uploadIndex = source.indexOf("const { secure_url, public_id } = await uploadToCloudinary", source.indexOf('"/menu-item"'))
    const saveIndex = source.indexOf("await menuItem.save()", uploadIndex)
    const oldCleanupIndex = source.indexOf("await deleteFromCloudinary(previousPublicId)", saveIndex)
    assert.ok(uploadIndex >= 0)
    assert.ok(saveIndex > uploadIndex)
    assert.ok(oldCleanupIndex > saveIndex)
    assert.match(source, /await deleteFromCloudinary\(public_id\)/)
    assert.match(source, /MenuItem\.findOne\(\{ _id: menuItemId, businessId, archivedAt: null \}\)/)
})
