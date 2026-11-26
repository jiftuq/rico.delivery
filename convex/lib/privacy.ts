import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

// What people may see of a task, its bids and its runners.
//
//   poster, accepted runners  everything: exact addresses and positions, the
//                             person to meet, live position, proof, chat
//   everyone else             the street and area without the house number,
//                             positions snapped to the task's privacy zone,
//                             and no live or last-known positions
//
// This is enforced here, on the server. The web app's own blurring is only
// cosmetic: whatever a query returns, anyone can read.

export type Viewer = "poster" | "runner" | "public";

export const MIN_ZONE_M = 100;
export const MAX_ZONE_M = 2000;
/** How precisely a poster sees where a bid was placed from (1 km cells). */
const BID_ZONE_M = 500;
const M_PER_DEG = 111_320;

export const clampZone = (zone?: number) =>
  Math.min(MAX_ZONE_M, Math.max(MIN_ZONE_M, Math.round(Number.isFinite(zone) ? (zone as number) : MIN_ZONE_M)));

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * Snap a position to the centre of a grid cell twice the zone wide. Every
 * point in the cell maps to the same centre, so the original can't be worked
 * back out (unlike a random offset seeded from public data).
 */
export function snap(lat: number, lng: number, zoneM: number) {
  const cell = 2 * zoneM;
  const dLat = cell / M_PER_DEG;
  const sLat = (Math.floor(lat / dLat) + 0.5) * dLat;
  // Longitude cells are sized from the snapped latitude, not the real one.
  const dLng = cell / (M_PER_DEG * Math.max(Math.cos((sLat * Math.PI) / 180), 0.01));
  const sLng = (Math.floor(lng / dLng) + 0.5) * dLng;
  return { lat: round5(sLat), lng: round5(sLng) };
}

/**
 * An address without its house number. Numbers sit in the first part in the
 * formats we get ("59, Rue Haute, …", "Rue Haute 35, 1000 Brussels",
 * "123 Main St, …"), so digits are removed from that part only and postcodes
 * survive. Best effort for free text; the snapped position is the guarantee.
 */
export function publicAddress(addr?: string): string | undefined {
  if (!addr) return addr;
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = parts[0].replace(/\S*\d\S*/g, "").replace(/\s+/g, " ").trim();
  return [first, ...parts.slice(1)].filter(Boolean).join(", ") || undefined;
}

/** Drop keys whose value is undefined (Convex return values can't hold them). */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

/** How the user behind a token relates to a task. */
export async function viewerOf(ctx: QueryCtx, task: Doc<"tasks">, userId?: Id<"users"> | null): Promise<Viewer> {
  if (!userId) return "public";
  if (task.posterId === userId) return "poster";
  if (task.courierId === userId) return "runner";
  if ((task.maxRunners || 1) > 1) {
    const tr = await ctx.db.query("taskRunners")
      .withIndex("by_task_runner", (q) => q.eq("taskId", task._id).eq("runnerId", userId)).first();
    if (tr && tr.status !== "expired") return "runner";
  }
  return "public";
}

/** A task as `viewer` may see it. */
export function taskView(task: Doc<"tasks">, viewer: Viewer) {
  if (viewer !== "public") return { ...task, viewer };
  const zone = clampZone(task.privacyZone);
  const at = (lat?: number, lng?: number) =>
    typeof lat === "number" && typeof lng === "number" ? snap(lat, lng, zone) : undefined;
  const location = at(task.locationLat, task.locationLng);
  const pickup = at(task.pickupLat, task.pickupLng);
  const dropoff = at(task.dropoffLat, task.dropoffLng);
  // Removed outright: live position, proof, the person to meet, dispute text, payment reference.
  const { courierLat: _cl, courierLng: _cg, proofData: _pd, targetPerson: _tp, disputeReason: _dr, paymentTx: _px, ...rest } = task;
  return clean({
    ...rest,
    viewer,
    locationAddr: publicAddress(task.locationAddr), locationLat: location?.lat, locationLng: location?.lng,
    pickupAddr: publicAddress(task.pickupAddr), pickupLat: pickup?.lat, pickupLng: pickup?.lng,
    dropoffAddr: publicAddress(task.dropoffAddr), dropoffLat: dropoff?.lat, dropoffLng: dropoff?.lng,
    steps: task.steps?.map((s) => {
      const p = at(s.locationLat, s.locationLng);
      const { proofData: _sp, ...step } = s;
      return clean({ ...step, locationAddr: publicAddress(s.locationAddr), locationLat: p?.lat, locationLng: p?.lng });
    }),
  });
}

/**
 * A bid as someone may see it: the bidder sees their own exactly, the
 * task's poster sees roughly where it came from (1 km), others see no position.
 */
export function bidView(bid: Doc<"bids">, viewer: Viewer, userId?: Id<"users"> | null) {
  if (userId && bid.courierId === userId) return bid;
  const { lat, lng, ...rest } = bid;
  if (viewer === "poster") return { ...rest, ...snap(lat, lng, BID_ZONE_M) };
  return rest;
}

/** A runner on a multi-runner task: positions, proof and dispute text only for the people on the task. */
export function runnerView(tr: Doc<"taskRunners">, viewer: Viewer) {
  if (viewer !== "public") return tr;
  const { lat: _la, lng: _ln, proofData: _pd, disputeReason: _dr, ...rest } = tr;
  return rest;
}
