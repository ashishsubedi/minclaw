import { Cron } from "croner";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Programmatic scheduling system.
 * "Remind me at 10" → creates a one-shot job that fires at 10:00.
 * "Remind me every day at 9am" → recurring cron job.
 *
 * Jobs are persisted to disk so they survive restarts.
 */

export type ScheduledJob = {
  id: string;
  name: string;
  cronExpr: string;
  message: string;
  channel: string;
  sender: string;
  oneShot: boolean;
  mode?: "reminder" | "agent";
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
};

export function isAgenticJob(job: ScheduledJob): boolean {
  if (job.mode === "agent") return true;
  if (job.mode === "reminder") return false;
  return (
    !job.oneShot ||
    /\b(search|find|research|digest|summarize|summary|check|scan|review|report|fetch|news|papers|briefing)\b/i.test(
      job.message
    )
  );
}

type JobCallback = (job: ScheduledJob) => void;

let JOBS_FILE = resolve(import.meta.dir, "../../sessions/scheduled-jobs.json");
const activeJobs = new Map<string, Cron>();
let onFireCallback: JobCallback | null = null;

function loadJobs(): ScheduledJob[] {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    const raw = readFileSync(JOBS_FILE, "utf-8");
    return JSON.parse(raw) as ScheduledJob[];
  } catch {
    return [];
  }
}

let jobStore: ScheduledJob[] = loadJobs();

export function setJobsFileForTest(filePath?: string): void {
  JOBS_FILE = filePath || resolve(import.meta.dir, "../../sessions/scheduled-jobs.json");
  jobStore = loadJobs();
}

export function setJobCallback(cb: JobCallback): void {
  onFireCallback = cb;
}

function saveJobs(): void {
  const dir = resolve(JOBS_FILE, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify(jobStore, null, 2), "utf-8");
}

function startCronForJob(job: ScheduledJob): void {
  if (activeJobs.has(job.id)) {
    activeJobs.get(job.id)!.stop();
  }

  const cron = new Cron(job.cronExpr, () => {
    console.log(`[scheduler] Firing job: ${job.name} (${job.id})`);
    job.lastRunAt = Date.now();

    if (onFireCallback) {
      onFireCallback(job);
    }

    if (job.oneShot) {
      removeJob(job.id);
    } else {
      saveJobs();
    }
  });

  activeJobs.set(job.id, cron);
  job.nextRunAt = cron.nextRun()?.getTime();
}

export function initScheduler(): void {
  jobStore = loadJobs();
  for (const job of jobStore) {
    startCronForJob(job);
  }
  console.log(`[scheduler] Loaded ${jobStore.length} scheduled jobs`);
}

export function addJob(job: Omit<ScheduledJob, "id" | "createdAt">): ScheduledJob {
  const newJob: ScheduledJob = {
    ...job,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  jobStore.push(newJob);
  saveJobs();
  startCronForJob(newJob);
  console.log(`[scheduler] Added job: ${newJob.name} (${newJob.cronExpr})`);
  return newJob;
}

export function removeJob(id: string): boolean {
  const cron = activeJobs.get(id);
  if (cron) {
    cron.stop();
    activeJobs.delete(id);
  }
  const before = jobStore.length;
  jobStore = jobStore.filter((j) => j.id !== id);
  saveJobs();
  return jobStore.length < before;
}

export function updateJobMode(id: string, mode?: "reminder" | "agent"): ScheduledJob | null {
  const job = jobStore.find((j) => j.id === id);
  if (!job) return null;
  job.mode = mode;
  saveJobs();
  return job;
}

export function triggerJob(id: string): ScheduledJob | null {
  const job = jobStore.find((j) => j.id === id);
  if (!job) return null;
  console.log(`[scheduler] Manually triggering job: ${job.name} (${job.id})`);
  job.lastRunAt = Date.now();
  if (onFireCallback) {
    onFireCallback(job);
  }
  if (job.oneShot) {
    removeJob(job.id);
  } else {
    saveJobs();
  }
  return job;
}

export function listJobs(): ScheduledJob[] {
  return [...jobStore];
}

export function stopScheduler(): void {
  for (const [id, cron] of activeJobs) {
    cron.stop();
  }
  activeJobs.clear();
  console.log("[scheduler] All jobs stopped");
}

/**
 * Parse natural language time into a cron expression.
 * Handles: "at 10", "at 10:30", "at 3pm", "every day at 9am", "in 5 minutes"
 */
export function parseTimeToJob(
  input: string,
  channel: string,
  sender: string
): Omit<ScheduledJob, "id" | "createdAt"> | null {
  const lower = input.toLowerCase().trim();
  const cleaned = lower
    .replace(/[.,]/g, "") // normalize a.m. -> am, p.m. -> pm
    .replace(/\s+/g, " ")
    .trim();

  // "in X minutes" / "in X mins" / "in X m"
  const inMinMatch = cleaned.match(/^in\s+(\d+)\s*(?:m|min|mins|minute|minutes)$/);
  if (inMinMatch) {
    const mins = parseInt(inMinMatch[1]!);
    const target = new Date(Date.now() + mins * 60_000);
    return {
      name: `Reminder in ${mins}m`,
      cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
      message: "",
      channel,
      sender,
      oneShot: true,
    };
  }

  // "in X hours" / "in X hrs" / "in X h"
  const inHourMatch = cleaned.match(/^in\s+(\d+)\s*(?:h|hr|hrs|hour|hours)$/);
  if (inHourMatch) {
    const hours = parseInt(inHourMatch[1]!);
    const target = new Date(Date.now() + hours * 3_600_000);
    return {
      name: `Reminder in ${hours}h`,
      cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
      message: "",
      channel,
      sender,
      oneShot: true,
    };
  }

  // "tomorrow morning/afternoon/evening/night"
  const tomorrowPeriodMatch = cleaned.match(
    /^tomorrow\s+(morning|afternoon|evening|night)$/
  );
  if (tomorrowPeriodMatch) {
    const period = tomorrowPeriodMatch[1] as string;
    const hourMap: Record<string, number> = {
      morning: 9,
      afternoon: 14,
      evening: 18,
      night: 20,
    };
    const hours = hourMap[period] ?? 10;
    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(hours, 0, 0, 0);

    return {
      name: `Reminder tomorrow ${period}`,
      cronExpr: `0 ${hours} ${target.getDate()} ${target.getMonth() + 1} *`,
      message: "",
      channel,
      sender,
      oneShot: true,
    };
  }

  // "tomorrow" or "tomorrow at/around HH:MM" or "tomorrow at/around H" or "tomorrow at/around Hpm/am"
  const tomorrowMatch = cleaned.match(
    /^tomorrow(?:\s+(?:at|around))?(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/
  );
  if (tomorrowMatch) {
    let hours = tomorrowMatch[1] ? parseInt(tomorrowMatch[1]) : 10;
    const minutes = tomorrowMatch[2] ? parseInt(tomorrowMatch[2]) : 0;
    const ampm = tomorrowMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);

    return {
      name: `Reminder tomorrow at ${hours}:${String(minutes).padStart(2, "0")}`,
      cronExpr: `${minutes} ${hours} ${target.getDate()} ${target.getMonth() + 1} *`,
      message: "",
      channel,
      sender,
      oneShot: true,
    };
  }

  // "at HH:MM" or "at H" or "at Hpm/am" or "around HH:MM"
  const atMatch = cleaned.match(
    /^(?:(?:at|around)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/
  );
  if (atMatch) {
    let hours = parseInt(atMatch[1]!);
    const minutes = atMatch[2] ? parseInt(atMatch[2]) : 0;
    const ampm = atMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    // If the time has already passed today, schedule for tomorrow
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      // Already passed — schedule for tomorrow (one-shot with day)
      target.setDate(target.getDate() + 1);
    }

    return {
      name: `Reminder at ${hours}:${String(minutes).padStart(2, "0")}`,
      cronExpr: `${minutes} ${hours} ${target.getDate()} ${target.getMonth() + 1} *`,
      message: "",
      channel,
      sender,
      oneShot: true,
    };
  }

  // "every day at HH:MM"
  const everyDayMatch = cleaned.match(
    /^every\s+day\s+(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/
  );
  if (everyDayMatch) {
    let hours = parseInt(everyDayMatch[1]!);
    const minutes = everyDayMatch[2] ? parseInt(everyDayMatch[2]) : 0;
    const ampm = everyDayMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    return {
      name: `Daily at ${hours}:${String(minutes).padStart(2, "0")}`,
      cronExpr: `${minutes} ${hours} * * *`,
      message: "",
      channel,
      sender,
      oneShot: false,
    };
  }

  // "every X hours"
  const everyHoursMatch = lower.match(/^every\s+(\d+)\s+hours?$/);
  if (everyHoursMatch) {
    const interval = parseInt(everyHoursMatch[1]!);
    return {
      name: `Every ${interval}h`,
      cronExpr: `0 */${interval} * * *`,
      message: "",
      channel,
      sender,
      oneShot: false,
    };
  }

  return null;
}
