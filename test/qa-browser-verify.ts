import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DASHBOARD_URL = "http://127.0.0.1:8787";
const SCREENSHOT_DIR = resolve(process.cwd(), "qa_screenshots");

if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

type QAStep = {
  name: string;
  status: "pass" | "fail";
  details?: string;
  durationMs: number;
};

async function runQAVerification() {
  const steps: QAStep[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  console.log("🚀 Launching Headless Chrome for QA Verification...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`${msg.text()} (${msg.location()?.url || "no-loc"})`);
    }
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      networkErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  page.on("pageerror", (err: any) => {
    consoleErrors.push(String(err?.message || err));
  });

  // Handle window.confirm / window.alert
  page.on("dialog", async (dialog) => {
    console.log(`[QA Dialog] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  async function step(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    try {
      await fn();
      const dur = Date.now() - start;
      steps.push({ name, status: "pass", durationMs: dur });
      console.log(`  ✓ ${name} (${dur}ms)`);
    } catch (err: any) {
      const dur = Date.now() - start;
      steps.push({ name, status: "fail", details: err.message, durationMs: dur });
      console.error(`  ✗ ${name} (${dur}ms): ${err.message}`);
    }
  }

  try {
    // Step 1: Initial Page Load
    await step("1. Page Load & Title Check", async () => {
      await page.goto(DASHBOARD_URL, { waitUntil: "networkidle0", timeout: 10000 });
      const title = await page.title();
      if (!title.includes("MinClaw")) {
        throw new Error(`Unexpected page title: ${title}`);
      }
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01_overview.png") });
    });

    // Step 2: Overview Tab Vitals & Dock
    await step("2. Overview Tab Vitals & Extension Dock Check", async () => {
      await page.waitForSelector("#statTotalSpend", { timeout: 3000 });
      const spend = await page.$eval("#statTotalSpend", (el) => el.textContent);
      const rss = await page.$eval("#statMemoryRss", (el) => el.textContent);
      const dockDot = await page.$eval("#dockExtensionDot", (el) => el.className);

      if (!spend || !rss) throw new Error("Vitals cards missing values");
      if (!dockDot.includes("dot-green")) throw new Error("Dock extension dot is not green");
    });

    // Step 3: Switch to Sessions & Activity
    await step("3. Sessions & Activity Tab Navigation & Chat Interface", async () => {
      await page.click('button[data-tab="sessions"]');
      await page.waitForSelector("#page-sessions:not(.hidden)", { timeout: 3000 });
      const overviewHidden = await page.$eval("#page-overview", (el) => el.classList.contains("hidden"));
      if (!overviewHidden) throw new Error("Overview page is not hidden");

      // Verify conversation list has rendered
      await page.waitForSelector("#sessionsListContainer > div", { timeout: 3000 });
      await page.waitForSelector("#chatInput", { timeout: 3000 });
      await page.waitForSelector("#chatSendBtn", { timeout: 3000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, "02_sessions.png") });

      // Test sending a chat message directly from the UI
      await page.click("#chatInput");
      await page.type("#chatInput", "Ping from automated QA browser test");
      await page.click("#chatSendBtn");

      // Verify user bubble appeared immediately
      await page.waitForSelector(".chat-msg-user", { timeout: 3000 });
      const userMsgs = await page.$$eval(".chat-msg-user .markdown-body", (els) => els.map((el) => el.textContent || ""));
      if (!userMsgs.some((t) => t.includes("Ping from automated QA"))) {
        throw new Error(`User message bubble not found in stream. Found messages: ${JSON.stringify(userMsgs)}`);
      }

      // Wait a moment for assistant response or thinking state
      await new Promise((r) => setTimeout(r, 2000));
      await page.screenshot({ path: join(SCREENSHOT_DIR, "02_sessions_chatted.png") });
    });

    // Step 4: Switch to Permanent Memory
    await step("4. Permanent Memory Dossier Check", async () => {
      await page.click('button[data-tab="memory"]');
      await page.waitForSelector("#page-memory:not(.hidden)", { timeout: 3000 });
      
      // Wait for memory content to load
      await page.waitForFunction(
        () => {
          const el = document.querySelector("#memoryContentDisplay");
          return el && el.textContent && el.textContent.trim().length > 10;
        },
        { timeout: 5000 }
      );

      const memText = await page.$eval("#memoryContentDisplay", (el) => el.textContent || "");
      if (memText.trim().length < 10) throw new Error("Empty permanent memory content in display");
      await page.screenshot({ path: join(SCREENSHOT_DIR, "03_memory.png") });
    });

    // Step 5: Switch to Integrations Hub
    await step("5. Integrations Hub & Subnav Check", async () => {
      await page.click('button[data-tab="integrations"]');
      await page.waitForSelector("#page-integrations:not(.hidden)", { timeout: 3000 });

      // Verify voice-mac HUD card is present
      await page.waitForSelector("#voiceMacExtensionCard", { timeout: 3000 });
      const pidText = await page.$eval("#extVoicePidBadge", (el) => el.textContent || "");
      if (pidText === "PID: --") {
        throw new Error(`extVoicePidBadge was not populated: ${pidText}`);
      }

      // Test subnav filtering
      await page.evaluate(() => (window as any).showIntegrationSub("mail"));
      const isMailVisible = await page.$eval("#sub-mail", (el) => !el.classList.contains("hidden"));
      const isExtHidden = await page.$eval("#sub-extensions", (el) => el.classList.contains("hidden"));
      if (!isMailVisible || !isExtHidden) throw new Error("Subnav filtering failed");

      // Reset to all
      await page.evaluate(() => (window as any).showIntegrationSub("all"));
      await page.screenshot({ path: join(SCREENSHOT_DIR, "04_integrations.png") });

      // Test WhatsApp Modal & QR Code Generation or Paired State
      await page.evaluate(() => (window as any).openWhatsAppModal());
      await page.waitForFunction(
        () => {
          const qrBox = document.querySelector("#waQrBox");
          return qrBox && (qrBox.querySelector("svg") || qrBox.textContent?.includes("Paired"));
        },
        { timeout: 6000 }
      );
      await page.screenshot({ path: join(SCREENSHOT_DIR, "04_whatsapp_modal_qr.png") });
      await page.evaluate(() => (window as any).closeWhatsAppModal());
    });

    // Step 6: Scheduler - Create, Toggle, Cancel Job
    await step("6. Scheduler Tab Job Lifecycle (Add, Toggle Mode, Cancel)", async () => {
      await page.click('button[data-tab="scheduler"]');
      await page.waitForSelector("#page-scheduler:not(.hidden)", { timeout: 3000 });

      // Fill in new job form
      await page.type("#jobWhen", "in 45 minutes");
      await page.select("#jobMode", "agent");
      await page.type("#jobName", "QA Auto Test Job");
      await page.type("#jobMessage", "Test prompt for QA subagent");
      await page.click('#scheduleJobForm button[type="submit"]');

      // Wait for job to appear in table
      await page.waitForFunction(
        () => {
          const text = document.querySelector("#schedulerJobsTableBody")?.textContent || "";
          return text.includes("QA Auto Test Job");
        },
        { timeout: 5000 }
      );

      await page.screenshot({ path: join(SCREENSHOT_DIR, "05_scheduler_added.png") });

      // Find cancel button for the test job
      const cancelled = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#schedulerJobsTableBody tr"));
        for (const row of rows) {
          if (row.textContent?.includes("QA Auto Test Job")) {
            const btn = row.querySelector("button.btn-danger") as HTMLButtonElement | null;
            if (btn) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });

      if (!cancelled) throw new Error("Could not find cancel button for test job");

      // Wait for job to be removed
      await new Promise((r) => setTimeout(r, 1000));
    });

    // Step 7: Configuration JSON5 Editor
    await step("7. Configuration Editor JSON5 Validation", async () => {
      await page.click('button[data-tab="config"]');
      await page.waitForSelector("#page-config:not(.hidden)", { timeout: 3000 });

      // Wait for config text to load
      await page.waitForFunction(
        () => {
          const el = document.querySelector("#cfgEditor") as HTMLTextAreaElement | null;
          return el && el.value.length > 50;
        },
        { timeout: 5000 }
      );

      const status = await page.$eval("#cfgStatusBadge", (el) => el.textContent || "");
      if (!status.includes("Valid")) throw new Error(`Unexpected config validation status: ${status}`);
      await page.screenshot({ path: join(SCREENSHOT_DIR, "06_config.png") });
    });

    // Step 8: Interactive Pinned Extension Dock Navigation
    await step("8. Pinned Extension Dock Click-Through Navigation", async () => {
      // Return to overview
      await page.click('button[data-tab="overview"]');
      await page.waitForSelector("#page-overview:not(.hidden)", { timeout: 3000 });

      // Click pinned extension dock in sidebar
      await page.click("#sidebarExtensionDock");

      // Must navigate to integrations
      await page.waitForSelector("#page-integrations:not(.hidden)", { timeout: 3000 });
      const hash = await page.evaluate(() => window.location.hash);
      if (hash !== "#integrations") throw new Error(`Expected hash #integrations, got ${hash}`);
    });

    // Step 9: Process Vitals Link to Telemetry & Full Telemetry Tab Verification
    await step("9. Process Vitals Card Link & Telemetry Dashboard Check", async () => {
      // 1. Return to overview
      await page.click('button[data-tab="overview"]');
      await page.waitForSelector("#page-overview:not(.hidden)", { timeout: 3000 });

      // 2. Click Process Vitals card (which links to telemetry)
      await page.click("#statMemoryRss");

      // 3. Must navigate to telemetry page
      await page.waitForSelector("#page-telemetry:not(.hidden)", { timeout: 3000 });
      const hash = await page.evaluate(() => window.location.hash);
      if (hash !== "#telemetry") throw new Error(`Expected hash #telemetry, got ${hash}`);

      // 4. Verify telemetry metrics rendered
      await page.waitForSelector("#telemetryRss", { timeout: 3000 });
      await page.waitForSelector("#telemetryLoad1m", { timeout: 3000 });
      await page.waitForSelector("#telemetryTokensTotal", { timeout: 3000 });
      await page.waitForSelector("#telemetryMemoryChart", { timeout: 3000 });

      const rssText = await page.$eval("#telemetryRss", (el) => el.textContent);
      if (!rssText || !rssText.includes("MB")) throw new Error(`Telemetry RSS not populated: ${rssText}`);

      // 5. Trigger Garbage Collection button
      await page.click("#btnTelemetryGc");
      await new Promise((r) => setTimeout(r, 600));

      await page.screenshot({ path: join(SCREENSHOT_DIR, "07_telemetry.png") });
    });

    // Step 10: Zero Console & Network Errors Check
    await step("10. Console & Network Error Invariant", async () => {
      if (consoleErrors.length > 0) {
        throw new Error(`Console errors detected: ${consoleErrors.join("; ")}`);
      }
      if (networkErrors.length > 0) {
        throw new Error(`Network errors detected: ${networkErrors.join("; ")}`);
      }
    });

  } finally {
    await browser.close();
  }

  const failedSteps = steps.filter((s) => s.status === "fail");
  console.log("\n==========================================");
  console.log(`QA Result: ${failedSteps.length === 0 ? "✅ ALL PASSED" : "❌ FAILED"}`);
  console.log(`Total Steps: ${steps.length} | Passed: ${steps.length - failedSteps.length} | Failed: ${failedSteps.length}`);
  console.log("==========================================\n");

  if (failedSteps.length > 0) {
    process.exit(1);
  }
}

runQAVerification().catch((err) => {
  console.error("QA Subagent Fatal Error:", err);
  process.exit(1);
});
