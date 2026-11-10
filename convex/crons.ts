import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Pay runners whose delivery went unconfirmed for 2 hours
crons.interval("auto-release delivered tasks", { minutes: 5 }, internal.tasks.autoRelease);

// Refund work that was accepted but not delivered within 4 hours
crons.interval("auto-refund stuck tasks", { minutes: 5 }, internal.tasks.refundStuck);

// Pick up withdrawals still waiting on a receipt, or left behind by a crash
crons.interval("process withdrawals", { minutes: 5 }, internal.payments.processWithdrawals);

crons.interval("purge expired sign-ins", { hours: 6 }, internal.auth.purgeExpired);

export default crons;
