import { describe, expect, test } from "bun:test";
import { invoiceLine, invoiceVoid } from "../src/handlers/invoice";
import { refundLine } from "../src/handlers/refund";
import { disputeOpen } from "../src/handlers/dispute";
import { couponApply } from "../src/handlers/coupon";
import { orderPlace } from "../src/handlers/order-place";
import { orderCancel } from "../src/handlers/order-cancel";
import { orderModify } from "../src/handlers/order-modify";
import { shipmentNotice } from "../src/handlers/shipment";
import { nightlySweep } from "../src/jobs/nightly-sweep";
import { digestHeader, digestFooter } from "../src/jobs/digest";
import { retentionPurge } from "../src/jobs/retention";
import { reindexRun } from "../src/jobs/reindex";
import { backupSnapshot } from "../src/jobs/backup";
import { healthPing } from "../src/jobs/healthcheck";
import { revenueLine, revenueSummary } from "../src/reports/revenue";
import { funnelStep } from "../src/reports/funnel";
import { cohortRow } from "../src/reports/cohort";
import { churnAlert } from "../src/reports/churn";
import { usageRow } from "../src/reports/usage";
import { auditLine } from "../src/reports/audit";
import { dashboardTile, dashboardAlert } from "../src/views/dashboard";
import { profileView } from "../src/views/profile";
import { settingsChange } from "../src/views/settings";
import { timelineEntry } from "../src/views/timeline";
import { inboxBadge } from "../src/views/inbox";
import { searchQuery } from "../src/views/search";
import { authLogin, authLogout } from "../src/services/auth";
import { sessionOpen } from "../src/services/session";
import { cacheMiss } from "../src/services/cache";
import { rateLimitHit } from "../src/services/ratelimit";
import { flagEval } from "../src/services/feature-flag";
import { configLoad } from "../src/services/config";
import { stripeCharge } from "../src/integrations/stripe";
import { sendgridSend } from "../src/integrations/sendgrid";
import { slackPost } from "../src/integrations/slack";
import { s3Put } from "../src/integrations/s3";
import { enqueueEmail, drainEmail } from "../src/workers/email-queue";
import { enqueueWebhook } from "../src/workers/webhook-queue";
import { enqueueExport } from "../src/workers/export-queue";
import { enqueueImport } from "../src/workers/import-queue";

// After migration every caller emits through logger.emit({...source}); the
// expected line therefore contains "(<source>)". A file left on the old
// log.write API returns the line WITHOUT the source segment and fails here,
// so the source string must be filled in correctly for every one of the 40
// modules. logger.ts is unchanged (its sha256 is checked in verify.sh), so
// the format cannot be bent to match a sloppy migration.
describe("mass-migration: every module emits with its own source", () => {
  test("invoiceLine", () => {
    expect(invoiceLine("widget", 750)).toBe("[info] (billing.invoice) invoice widget amount=750");
  });
  test("invoiceVoid", () => {
    expect(invoiceVoid("INV-9")).toBe("[warn] (billing.invoice) voided invoice INV-9");
  });
  test("refundLine", () => {
    expect(refundLine("R-1", 500)).toBe("[info] (billing.refund) refund R-1 cents=500");
  });
  test("disputeOpen", () => {
    expect(disputeOpen("D-7")).toBe("[warn] (billing.dispute) dispute opened D-7");
  });
  test("couponApply", () => {
    expect(couponApply("SAVE10", 10)).toBe("[info] (billing.coupon) coupon SAVE10 pct=10");
  });
  test("orderPlace", () => {
    expect(orderPlace("A-100", 42)).toBe("[info] (orders.place) order A-100 placed total=42");
  });
  test("orderCancel", () => {
    expect(orderCancel("A-101")).toBe("[warn] (orders.cancel) order A-101 cancelled");
  });
  test("orderModify", () => {
    expect(orderModify("A-102", "address")).toBe("[info] (orders.modify) order A-102 changed address");
  });
  test("shipmentNotice", () => {
    expect(shipmentNotice("TRK9")).toBe("[info] (orders.shipment) shipment TRK9 dispatched");
  });
  test("nightlySweep", () => {
    expect(nightlySweep(12)).toBe("[info] (scheduler.nightly_sweep) swept 12 rows");
  });
  test("digestHeader", () => {
    expect(digestHeader("2026-01-05")).toBe("[info] (scheduler.digest) digest for 2026-01-05");
  });
  test("digestFooter", () => {
    expect(digestFooter(3)).toBe("[debug] (scheduler.digest) digest sent=3");
  });
  test("retentionPurge", () => {
    expect(retentionPurge(30)).toBe("[warn] (scheduler.retention) purging older than 30d");
  });
  test("reindexRun", () => {
    expect(reindexRun("orders")).toBe("[info] (scheduler.reindex) reindex orders");
  });
  test("backupSnapshot", () => {
    expect(backupSnapshot(4096)).toBe("[info] (scheduler.backup) snapshot bytes=4096");
  });
  test("healthPing", () => {
    expect(healthPing("db")).toBe("[debug] (scheduler.healthcheck) ping db");
  });
  test("revenueLine", () => {
    expect(revenueLine(1000)).toBe("[info] (analytics.revenue) revenue gross=1000");
  });
  test("revenueSummary", () => {
    expect(revenueSummary(920)).toBe("[info] (analytics.revenue) revenue net=920");
  });
  test("funnelStep", () => {
    expect(funnelStep("checkout", 34)).toBe("[info] (analytics.funnel) funnel checkout rate=34");
  });
  test("cohortRow", () => {
    expect(cohortRow(4, 88)).toBe("[info] (analytics.cohort) cohort w4 kept=88");
  });
  test("churnAlert", () => {
    expect(churnAlert(7)).toBe("[warn] (analytics.churn) churn pct=7");
  });
  test("usageRow", () => {
    expect(usageRow("api", 512)).toBe("[info] (analytics.usage) usage api hits=512");
  });
  test("auditLine", () => {
    expect(auditLine("alice", "login")).toBe("[info] (analytics.audit) alice login");
  });
  test("dashboardTile", () => {
    expect(dashboardTile("users", 1500)).toBe("[info] (ui.dashboard) users: 1500");
  });
  test("dashboardAlert", () => {
    expect(dashboardAlert("cpu")).toBe("[error] (ui.dashboard) alert cpu");
  });
  test("profileView", () => {
    expect(profileView("bob")).toBe("[debug] (ui.profile) viewed bob");
  });
  test("settingsChange", () => {
    expect(settingsChange("theme", "dark")).toBe("[info] (ui.settings) set theme=dark");
  });
  test("timelineEntry", () => {
    expect(timelineEntry("deploy")).toBe("[info] (ui.timeline) entry deploy");
  });
  test("inboxBadge", () => {
    expect(inboxBadge(9)).toBe("[debug] (ui.inbox) unread=9");
  });
  test("searchQuery", () => {
    expect(searchQuery("shoes", 20)).toBe("[info] (ui.search) query shoes hits=20");
  });
  test("authLogin", () => {
    expect(authLogin("carol")).toBe("[info] (core.auth) login carol");
  });
  test("authLogout", () => {
    expect(authLogout("carol")).toBe("[debug] (core.auth) logout carol");
  });
  test("sessionOpen", () => {
    expect(sessionOpen("s-1")).toBe("[debug] (core.session) session s-1 open");
  });
  test("cacheMiss", () => {
    expect(cacheMiss("u:1")).toBe("[debug] (core.cache) miss u:1");
  });
  test("rateLimitHit", () => {
    expect(rateLimitHit("1.2.3.4", 100)).toBe("[warn] (core.ratelimit) limit 1.2.3.4 n=100");
  });
  test("flagEval", () => {
    expect(flagEval("beta", "yes")).toBe("[debug] (core.feature_flag) flag beta=yes");
  });
  test("configLoad", () => {
    expect(configLoad("prod")).toBe("[info] (core.config) config prod");
  });
  test("stripeCharge", () => {
    expect(stripeCharge("ch_1", 999)).toBe("[info] (ext.stripe) charge ch_1 cents=999");
  });
  test("sendgridSend", () => {
    expect(sendgridSend("x@y.z")).toBe("[info] (ext.sendgrid) email x@y.z");
  });
  test("slackPost", () => {
    expect(slackPost("#ops")).toBe("[info] (ext.slack) post #ops");
  });
  test("s3Put", () => {
    expect(s3Put("a/b.txt", 128)).toBe("[debug] (ext.s3) put a/b.txt bytes=128");
  });
  test("enqueueEmail", () => {
    expect(enqueueEmail("j-1")).toBe("[info] (queue.email) enqueue j-1");
  });
  test("drainEmail", () => {
    expect(drainEmail(5)).toBe("[debug] (queue.email) drained 5");
  });
  test("enqueueWebhook", () => {
    expect(enqueueWebhook("w-1")).toBe("[info] (queue.webhook) enqueue w-1");
  });
  test("enqueueExport", () => {
    expect(enqueueExport("e-1", 200)).toBe("[info] (queue.export) export e-1 rows=200");
  });
  test("enqueueImport", () => {
    expect(enqueueImport("i-1")).toBe("[warn] (queue.import) import i-1");
  });
});
