import assert from "assert";
import { resolveBusinessCapabilities } from "./services/businessCapabilityService.js";

async function runTests() {
  console.log("Starting capability regression tests...");
  let passed = 0;
  let failed = 0;

  function check(name, condition) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name}`);
      failed++;
    }
  }

  // 1. Resolver direct tests
  console.log("\n--- A. Explicit module hotel ---");
  const explicitHotel = { businessType: "hotel", modules: ["lodging"] };
  const capA = resolveBusinessCapabilities(explicitHotel);
  check("resolver derives visibleModules with lodging", capA.visibleModules.includes("lodging"));
  check("capabilities.lodging is strictly undefined (the regression contract)", capA.lodging === undefined);

  console.log("\n--- B. Legacy hotel without modules array ---");
  const legacyHotel = { businessType: "hotel" };
  const capB = resolveBusinessCapabilities(legacyHotel);
  check("resolver derives lodging from legacy businessType", capB.visibleModules.includes("lodging"));
  check("capabilities.lodging is strictly undefined (the regression contract)", capB.lodging === undefined);

  console.log("\n--- C. Restaurant without lodging ---");
  const restaurant = { businessType: "restaurant" };
  const capC = resolveBusinessCapabilities(restaurant);
  check("resolver does NOT derive lodging", !capC.visibleModules.includes("lodging"));
  check("capabilities.lodging is strictly undefined", capC.lodging === undefined);
  
  console.log("\n--- D. Hotel with lodging module explicitly disabled ---");
  const explicitNoLodgingHotel = { businessType: "restaurant", modules: ["foodService"] }; // Simulating a business that isn't a hotel and doesn't have lodging
  const capD = resolveBusinessCapabilities(explicitNoLodgingHotel);
  check("resolver does NOT derive lodging", !capD.visibleModules.includes("lodging"));
  check("capabilities.lodging is strictly undefined", capD.lodging === undefined);

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
}

runTests().catch(console.error);
