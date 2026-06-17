import swaggerJSDoc from "swagger-jsdoc"
import swaggerUi from "swagger-ui-express"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Read package.json to pull name and version dynamically
const packageJsonPath = path.resolve(__dirname, "../../package.json")
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: packageJson.name || "quickserve-be",
      version: packageJson.version || "1.0.0",
      description: "API Documentation for QuickServe backend application.",
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 5000}`,
        description: "Development Server",
      },
      {
        url: process.env.BACKEND_BASE_URL || "https://api.quickserve.com",
        description: "Production Server",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your Supabase JWT access token to authenticate as a platform admin.",
        },
      },
    },
  },
  apis: ["./src/routes/*.js"],
}

const swaggerSpec = swaggerJSDoc(options)

export const setupSwagger = (app) => {
  // Serve Swagger UI
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec))

  // Serve Swagger JSON representation
  app.get("/api-docs.json", (req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.send(swaggerSpec)
  })
}
