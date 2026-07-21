import type { HardwareProfile, ModelCatalogEntry, ModelEligibility } from '@queryload/shared';
import { smallestModel } from './catalog.js';

/** Absolute RAM floor — below this QueryLoad refuses everything (D39). */
export const RAM_FLOOR_GB = 8;

/**
 * Decides whether a model may run on this machine (D38/D39):
 *  - total RAM < 8GB           → BLOCKED for everything.
 *  - below the model's minimum → BLOCKED, unless it's the smallest model, which
 *    is allowed as the only option (so an underpowered machine still works).
 *  - below recommended         → WARN (allowed).
 *  - free disk < model size    → BLOCKED (can't even download it).
 *  - otherwise                 → OK.
 *
 * All copy is plain, professional English — no jargon (appliance surface).
 */
export function evaluateEligibility(
  entry: ModelCatalogEntry,
  hw: HardwareProfile,
): ModelEligibility {
  if (hw.totalRamGB < RAM_FLOOR_GB) {
    return {
      status: 'blocked',
      reason: `This computer has ${hw.totalRamGB} GB of memory. QueryLoad needs at least ${RAM_FLOOR_GB} GB to run a local model.`,
    };
  }

  const sizeGB = entry.sizeBytes / (1024 * 1024 * 1024);
  if (hw.freeDiskGB > 0 && hw.freeDiskGB < sizeGB) {
    return {
      status: 'blocked',
      reason: `Not enough free disk space. ${entry.name} needs about ${Math.ceil(sizeGB)} GB, but only ${Math.floor(hw.freeDiskGB)} GB is free.`,
    };
  }

  if (hw.totalRamGB < entry.minRamGB) {
    if (entry.id === smallestModel().id) {
      return {
        status: 'warn',
        reason: `This is below the usual memory for ${entry.name}, but it's the lightest model and the only one this computer can run. Expect slower responses.`,
      };
    }
    return {
      status: 'blocked',
      reason: `${entry.name} needs about ${entry.minRamGB} GB of memory; this computer has ${hw.totalRamGB} GB. Choose the lightest model instead.`,
    };
  }

  if (hw.totalRamGB < entry.recommendedRamGB) {
    return {
      status: 'warn',
      reason: `This computer meets the minimum for ${entry.name} but is below the recommended ${entry.recommendedRamGB} GB. It will work, with slower responses on long documents.`,
    };
  }

  return { status: 'ok', reason: `${entry.name} is a good fit for this computer.` };
}
