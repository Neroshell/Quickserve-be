import { INVENTORY_JOB_NAMES } from "../../queues/index.js"
import {
    reconcileInventoryReservation,
    runInventoryReservationRepairScan,
} from "../../services/inventoryReservationRepairService.js"

export async function processInventoryJob(job, dependencies = {}) {
    const reconcile = dependencies.reconcile || reconcileInventoryReservation
    const repairScan = dependencies.repairScan || runInventoryReservationRepairScan
    if (job.name === INVENTORY_JOB_NAMES.HOLD_REPAIR_SCAN) {
        return repairScan({ now: dependencies.now || new Date() })
    }
    if (job.name === INVENTORY_JOB_NAMES.RECONCILE_RESERVATION) {
        return reconcile({
            ...job.data,
            now: dependencies.now || new Date(),
        })
    }
    throw new TypeError(`Unsupported inventory job: ${job.name}`)
}

