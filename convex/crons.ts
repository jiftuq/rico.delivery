import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Auto-refund stuck in_progress tasks every 5 minutes
crons.interval("auto-refund stuck tasks", { minutes: 5 }, internal.payments.processRefunds);

export default crons;
