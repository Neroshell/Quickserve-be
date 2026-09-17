import express from "express"
import { PERMISSIONS } from "../constants/permissions.js"
import {
    acknowledgeInventoryException,
    assignCleaning,
    changeCleaningPriority,
    completeCleaning,
    getEligibleHousekeepers,
    listHousekeepingRooms,
    listHousekeepingHistory,
    resolveInventoryException,
    saveHousekeepingSettings,
    setNoSuppliesUsed,
    startCleaning,
} from "../controllers/housekeepingController.js"
import { requireAuth, requireOperationalPermission } from "../middleware/authMiddleware.js"

const router = express.Router()

router.use(requireAuth)
router.get(
    "/rooms",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_VIEW),
    listHousekeepingRooms,
)
router.get(
    "/eligible-staff",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_ASSIGN),
    getEligibleHousekeepers,
)
router.get(
    "/history",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_ASSIGN, PERMISSIONS.HOUSEKEEPING_MANAGE),
    listHousekeepingHistory,
)
router.put(
    "/settings",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_MANAGE),
    saveHousekeepingSettings,
)
router.put(
    "/operations/:operationId/assignment",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_ASSIGN),
    assignCleaning,
)
router.put(
    "/operations/:operationId/priority",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_MANAGE),
    changeCleaningPriority,
)
router.post(
    "/operations/:operationId/inventory-exception/acknowledge",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_MANAGE),
    acknowledgeInventoryException,
)
router.post(
    "/operations/:operationId/inventory-exception/resolve",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_MANAGE),
    resolveInventoryException,
)
router.post(
    "/operations/:operationId/start",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_PERFORM),
    startCleaning,
)
router.post(
    "/operations/:operationId/no-supplies",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_PERFORM),
    setNoSuppliesUsed,
)
router.post(
    "/operations/:operationId/complete",
    requireOperationalPermission(PERMISSIONS.HOUSEKEEPING_PERFORM),
    completeCleaning,
)

export default router
