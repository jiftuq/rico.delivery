import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Pay runners whose delivery went unconfirmed and undisputed for 24 hours
crons.interval("auto-release delivered tasks", { minutes: 5 }, internal.tasks.autoRelease, {});

// Refund work that was accepted but not delivered within 4 hours
crons.interval("auto-refund stuck tasks", { minutes: 5 }, internal.tasks.refundStuck, {});

// Multi-runner tasks stop taking runners 72 hours after the first one; empty slots are refunded
crons.interval("close stale runner slots", { minutes: 15 }, internal.tasks.closeStaleSlots, {});

// Pick up withdrawals still waiting on a receipt, or left behind by a crash
crons.interval("process withdrawals", { minutes: 5 }, internal.payments.processWithdrawals);

crons.interval("purge expired sign-ins", { hours: 6 }, internal.auth.purgeExpired, {});
crons.interval("purge expired oauth codes", { hours: 1 }, internal.oauth.purgeCodes, {});

export default crons;
