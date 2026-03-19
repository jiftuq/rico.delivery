import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Auto-release delivered tasks to courier after 2h (every 5 min check)
crons.interval("auto-release delivered tasks", { minutes: 5 }, internal.payments.processAutoRelease);

// Auto-refund stuck in_progress tasks after 4h (every 5 min check)
crons.interval("auto-refund stuck tasks", { minutes: 5 }, internal.payments.processRefunds);

export default crons;
