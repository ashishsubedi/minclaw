#!/usr/bin/env bun
/**
 * scripts/schedule-date-reminder.ts
 *
 * Deterministic helper script to schedule reminders for arbitrary calendar dates
 * (e.g., "Nov 24 at 2:30pm", "2026-11-24 14:30", "tomorrow at 3pm", "in 2 hours").
 * 
 * Target: sessions/scheduled-jobs.json (MinClaw Scheduler)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

interface ScheduledJob {
  id: string;
  name: string;
  message: string;
  channel: string;
  sender: string;
  oneShot: boolean;
  mode: "chat" | "agent";
  createdAt: number;
  nextRunAt: number;
  cronExpr?: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function parseTimeToHoursMinutes(timeStr: string): { hours: number; minutes: number } {
  const clean = timeStr.trim().toLowerCase();
  const match12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (match12) {
    let hours = parseInt(match12[1]!, 10);
    const minutes = match12[2] ? parseInt(match12[2], 10) : 0;
    const meridian = match12[3];
    if (meridian === "pm" && hours < 12) hours += 12;
    if (meridian === "am" && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const match24 = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return { hours: parseInt(match24[1]!, 10), minutes: parseInt(match24[2]!, 10) };
  }

  const matchSingleH = clean.match(/^(\d{1,2})$/);
  if (matchSingleH) {
    return { hours: parseInt(matchSingleH[1]!, 10), minutes: 0 };
  }

  throw new Error(`Cannot parse time: "${timeStr}"`);
}

export function parseDateExpression(expr: string, referenceDate: Date = new Date()): Date {
  const raw = expr.trim();
  const lower = raw.toLowerCase();

  // 1. Check relative offsets: "in X minutes/hours/days"
  const relMatch = lower.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (relMatch) {
    const val = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!;
    const ms = unit.startsWith("m") ? val * 60 * 1000 : unit.startsWith("h") ? val * 3600 * 1000 : val * 86400 * 1000;
    return new Date(referenceDate.getTime() + ms);
  }

  // 2. Direct ISO or standard date parse
  const directTimestamp = Date.parse(raw);
  if (!isNaN(directTimestamp) && (raw.includes("-") || raw.includes("T"))) {
    return new Date(directTimestamp);
  }

  // 3. "tomorrow at <time>"
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+at)?\s+(.+)$/);
  if (tomorrowMatch) {
    const { hours, minutes } = parseTimeToHoursMinutes(tomorrowMatch[1]!);
    const target = new Date(referenceDate);
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);
    return target;
  }

  // 4. "today at <time>" or "at <time>"
  const todayMatch = lower.match(/^(?:today\s+at|at)\s+(.+)$/);
  if (todayMatch) {
    const { hours, minutes } = parseTimeToHoursMinutes(todayMatch[1]!);
    const target = new Date(referenceDate);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= referenceDate.getTime()) {
      // If time has passed today, assume tomorrow
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  // 5. Month + Day + optional Year + Time (e.g. "Nov 24 at 2:30pm", "November 24, 2026 14:30", "Nov 24 15:00")
  const monthDayMatch = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:\s+at)?\s+(.+)$/);
  if (monthDayMatch) {
    const monthKey = monthDayMatch[1]!;
    const day = parseInt(monthDayMatch[2]!, 10);
    const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : referenceDate.getFullYear();
    const timeStr = monthDayMatch[4]!;

    if (MONTHS[monthKey] !== undefined) {
      const month = MONTHS[monthKey]!;
      const { hours, minutes } = parseTimeToHoursMinutes(timeStr);
      const target = new Date(year, month, day, hours, minutes, 0, 0);
      return target;
    }
  }

  // 6. Day + Month + optional Year + Time (e.g. "24 Nov at 2:30pm", "24.11.2026 14:30")
  const dayMonthMatch = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s./]+([a-z0-9]+)(?:[\s./]+(\d{4}))?(?:\s+at)?\s+(.+)$/);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1]!, 10);
    const monthToken = dayMonthMatch[2]!;
    const year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : referenceDate.getFullYear();
    const timeStr = dayMonthMatch[4]!;

    let month = -1;
    if (MONTHS[monthToken] !== undefined) {
      month = MONTHS[monthToken]!;
    } else if (/^\d{1,2}$/.test(monthToken)) {
      month = parseInt(monthToken, 10) - 1;
    }

    if (month >= 0 && month <= 11) {
      const { hours, minutes } = parseTimeToHoursMinutes(timeStr);
      const target = new Date(year, month, day, hours, minutes, 0, 0);
      return target;
    }
  }

  throw new Error(`Unable to parse date expression: "${expr}". Supported formats: "Nov 24 at 2:30pm", "tomorrow at 10am", "in 15m", "YYYY-MM-DD HH:mm", "at 8pm".`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, ...v] = key.split("=");
        if (k) parsed[k] = v.join("=");
      } else {
        parsed[key] = args[i + 1] || "";
        i++;
      }
    } else if (arg.includes("=")) {
      const [k, ...v] = arg.split("=");
      if (k) parsed[k] = v.join("=");
    }
  }

  return parsed;
}

async function main() {
  const cli = parseCliArgs();
  const when = cli.when || cli.time || cli.date;
  const message = cli.message || cli.msg || cli.text;
  const name = cli.name || (message ? message.slice(0, 30) : "Calendar Reminder");
  const channel = cli.channel || "telegram";
  const sender = cli.sender || process.env.TELEGRAM_OWNER_ID || "";

  if (!when || !message) {
    console.error("Usage: bun run scripts/schedule-date-reminder.ts --when=\"<date/time>\" --message=\"<text>\" [--name=\"<title>\"] [--channel=telegram] [--sender=<id>]");
    console.error("Examples:");
    console.error('  bun run scripts/schedule-date-reminder.ts --when="Nov 24 at 2:30pm" --message="Flu vaccination in 30m"');
    console.error('  bun run scripts/schedule-date-reminder.ts --when="2026-11-24 14:00" --message="Flu vaccination in 1h"');
    process.exit(1);
  }

  const targetDate = parseDateExpression(when);
  const now = new Date();

  if (targetDate.getTime() <= now.getTime()) {
    console.error(`Error: Target date ${targetDate.toISOString()} (${targetDate.toLocaleString()}) is in the past!`);
    process.exit(1);
  }

  const jobsPath = join(process.cwd(), "sessions", "scheduled-jobs.json");
  let jobs: ScheduledJob[] = [];
  if (existsSync(jobsPath)) {
    try {
      jobs = JSON.parse(readFileSync(jobsPath, "utf8"));
    } catch (e) {
      jobs = [];
    }
  }

  const cronExpr = `${targetDate.getMinutes()} ${targetDate.getHours()} ${targetDate.getDate()} ${targetDate.getMonth() + 1} *`;
  const newJob: ScheduledJob = {
    id: `job-${randomBytes(6).toString("hex")}`,
    name,
    cronExpr,
    message,
    channel,
    sender,
    oneShot: true,
    mode: "chat",
    createdAt: Date.now(),
    nextRunAt: targetDate.getTime(),
  };

  jobs.push(newJob);
  writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), "utf8");

  console.log(JSON.stringify({
    status: "success",
    job: {
      id: newJob.id,
      name: newJob.name,
      when: targetDate.toLocaleString(),
      iso: targetDate.toISOString(),
      nextRunAt: newJob.nextRunAt,
      channel: newJob.channel,
      sender: newJob.sender,
      message: newJob.message,
    }
  }, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
