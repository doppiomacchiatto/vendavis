/**
 * Org Health Check definitions — shared between OrgHealth tab and ClaudeChat.
 * Each check: { id, label, category, tip, drillQuery, run(alias, api) → { status, detail, rows? } }
 * status: "pass" | "warn" | "fail" | "info"
 */

export const CATEGORY_ICONS = {
  "API Limits":      "📡",
  "Security":        "🔒",
  "Audit & Changes": "📋",
  "Automation":      "⚡",
  "Storage":         "💾",
  "Data Volume":     "📦",
  "Metadata":        "🧩",
};

export const STATUS_ICON = {
  pass:    "✅",
  warn:    "⚠️",
  fail:    "❌",
  info:    "ℹ️",
  running: "⏳",
};

export const STATUS_COLOR = {
  pass:    "text-green-400",
  warn:    "text-yellow-400",
  fail:    "text-red-400",
  info:    "text-blue-300",
  running: "text-blue-300",
};

// ── Shared security-settings cache (one fetch per run, reused by all 9 checks) ─
const _ssCache = {};
async function fetchSecuritySettings(alias, _api) {
  if (_ssCache[alias]) return _ssCache[alias];
  try {
    const d = await _api(`/api/orgs/${alias}/security-settings`);
    _ssCache[alias] = { ok: true, data: d };
  } catch (e) {
    _ssCache[alias] = { ok: false, error: e?.message ?? "Failed to retrieve SecuritySettings" };
  }
  // Cache busts after 2 minutes so a re-run gets fresh data
  setTimeout(() => { delete _ssCache[alias]; }, 120_000);
  return _ssCache[alias];
}

export const HEALTH_CHECKS = [
  // ── API Limits ─────────────────────────────────────────────────────────────
  {
    id: "daily_api", label: "Daily API Requests", category: "API Limits",
    tip: "Reduce API usage by enabling caching, consolidating calls with Composite API, or scheduling heavy integrations during off-peak hours. In Setup → API Usage, you can see which connected apps are consuming the most calls.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api(`/api/orgs/${alias}/limits`);
      const { used, max } = d.dailyApiRequests;
      const pct = max ? Math.round((used / max) * 100) : 0;
      const detail = `${used.toLocaleString()} / ${max.toLocaleString()} (${pct}% used)`;
      const rows = [{ Metric: "Daily API Requests", Used: used.toLocaleString(), Max: max.toLocaleString(), "% Used": `${pct}%` }];
      if (pct >= 80) return { status: "fail", detail, rows };
      if (pct >= 50) return { status: "warn", detail, rows };
      return { status: "pass", detail };
    },
  },
  {
    id: "bulk_api", label: "Bulk API Daily Limit", category: "API Limits",
    tip: "Bulk API usage spikes often come from data migration tools or nightly ETL jobs. Review your integration schedule in Setup → Scheduled Jobs and stagger large data loads.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api(`/api/orgs/${alias}/limits`);
      const bulk = d.limits?.DailyBulkV2QueryFileStorageMB || d.limits?.DailyBulkApiRequests;
      if (!bulk) return { status: "info", detail: "Bulk API limit not reported by this org" };
      const used = bulk.Max - bulk.Remaining;
      const pct  = bulk.Max ? Math.round((used / bulk.Max) * 100) : 0;
      const detail = `${used.toLocaleString()} / ${bulk.Max.toLocaleString()} (${pct}% used)`;
      const rows = [{ Metric: "Bulk API Requests", Used: used.toLocaleString(), Max: bulk.Max.toLocaleString(), "% Used": `${pct}%` }];
      return pct >= 80 ? { status: "fail", detail, rows } : pct >= 50 ? { status: "warn", detail, rows } : { status: "pass", detail };
    },
  },
  {
    id: "streaming_api", label: "Streaming API Concurrent Clients", category: "API Limits",
    tip: "Too many concurrent Streaming API clients can block new subscribers. Review which integrations use Platform Events or PushTopics in Setup → Streaming Monitor, and reduce polling frequency or consolidate subscribers.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api(`/api/orgs/${alias}/limits`);
      const s = d.limits?.StreamingApiConcurrentClients;
      if (!s) return { status: "info", detail: "Streaming API limit not available" };
      const used = s.Max - s.Remaining;
      const pct  = s.Max ? Math.round((used / s.Max) * 100) : 0;
      const detail = `${used} / ${s.Max} concurrent clients (${pct}% used)`;
      return pct >= 80 ? { status: "fail", detail } : pct >= 50 ? { status: "warn", detail } : { status: "pass", detail };
    },
  },

  // ── Security ───────────────────────────────────────────────────────────────
  {
    id: "sysadmin_count", label: "System Administrator Count", category: "Security",
    tip: "Follow the principle of least privilege — System Admin gives unrestricted access to all data and configuration. Audit each admin: remove the profile from users who only need a subset of permissions and replace with a custom profile or permission set.",
    drillQuery: "SELECT Name, Username, LastLoginDate FROM User WHERE Profile.Name = 'System Administrator' AND IsActive = true ORDER BY LastLoginDate DESC NULLS LAST LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM User WHERE Profile.Name = 'System Administrator' AND IsActive = true" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?";
      if (count === "?") return { status: "info", detail: "Could not query user count" };
      if (count > 10) return { status: "fail", detail: `${count} active System Admins — review for least-privilege` };
      if (count > 5)  return { status: "warn", detail: `${count} active System Admins` };
      return { status: "pass", detail: `${count} active System Admins` };
    },
  },
  {
    id: "active_users", label: "Total Active Users", category: "Security",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM User WHERE IsActive = true" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?";
      return { status: "info", detail: `${count} active licensed users` };
    },
  },
  {
    id: "guest_user", label: "Guest User Profile Check", category: "Security",
    tip: "Guest users access your org without authentication — they should have minimal permissions. In Setup → Profiles → Guest User Profile, remove any object/field access that isn't strictly required for your public-facing site. Enable 'Secure guest user record access' in Setup → Sharing Settings.",
    drillQuery: "SELECT Name, Username, Profile.Name, LastLoginDate FROM User WHERE IsActive = true AND Profile.UserType = 'Guest' LIMIT 10",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM User WHERE IsActive = true AND Profile.UserType = 'Guest'" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 0) return { status: "warn", detail: `${count} active guest user(s) — verify their profile permissions` };
      return { status: "pass", detail: "No active guest users found" };
    },
  },
  {
    id: "inactive_users_with_access", label: "Inactive Users (Last 90 Days)", category: "Security",
    tip: "Users who haven't logged in for 90+ days may be former employees or dormant service accounts. In Setup → Users, deactivate them to free up licenses and reduce your attack surface. Use Setup → Login History to verify last login dates.",
    drillQuery: "SELECT Name, Username, LastLoginDate, Profile.Name FROM User WHERE IsActive = true AND (LastLoginDate < LAST_N_DAYS:90 OR LastLoginDate = null) ORDER BY LastLoginDate ASC NULLS FIRST LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM User WHERE IsActive = true AND (LastLoginDate < LAST_N_DAYS:90 OR LastLoginDate = null)" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 20) return { status: "fail", detail: `${count} active users haven't logged in for 90+ days` };
      if (count > 5)  return { status: "warn", detail: `${count} active users haven't logged in for 90+ days` };
      return { status: "pass", detail: `${count} dormant active users (90+ days)` };
    },
  },
  {
    id: "login_failures", label: "Failed Logins (Last 24h)", category: "Security",
    tip: "A spike in failed logins can indicate a brute-force attack or a broken integration. In Setup → Login History, filter by Status = Failed to see which usernames and IPs are involved. Consider IP allowlisting in Setup → Network Access.",
    drillQuery: "SELECT Username, LoginType, SourceIp, Status FROM LoginHistory WHERE Status != 'Success' AND LoginTime = LAST_N_DAYS:1 ORDER BY LoginTime DESC LIMIT 25",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM LoginHistory WHERE Status != 'Success' AND LoginTime = LAST_N_DAYS:1" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 50) return { status: "fail", detail: `${count} failed login attempts in last 24h — possible brute-force` };
      if (count > 10) return { status: "warn", detail: `${count} failed login attempts in last 24h` };
      return { status: "pass", detail: `${count} failed login attempts in last 24h` };
    },
  },

  // ── Security Settings (Metadata) ───────────────────────────────────────────
  {
    id: "ip_ranges", label: "IP Allowlisting (Network Access)", category: "Security",
    tip: "Restricting logins to known IP ranges (Setup → Security → Network Access) is one of the most effective controls for preventing unauthorized access. Without IP ranges, any credential compromise can be exploited from anywhere. Add your office/VPN CIDRs to reduce your attack surface.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const ranges = r.data.ipRanges ?? [];
      if (ranges.length === 0) return { status: "warn", detail: "No IP allowlist ranges configured — logins allowed from any IP" };
      const rows = ranges.map(rng => ({
        "Start IP": rng.start ?? "",
        "End IP":   rng.end ?? "",
        "Description": rng.description ?? "",
      }));
      return { status: "pass", detail: `${ranges.length} IP range(s) configured`, rows };
    },
  },
  {
    id: "require_https", label: "Require HTTPS (TLS)", category: "Security",
    tip: "Salesforce enforces TLS on all connections, but the requireHttps session setting should still be true to prevent any HTTP downgrade attempts. Verify in Setup → Session Settings → Require secure connections (HTTPS).",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const val = r.data.sessionSettings?.requireHttps;
      if (val === "false") return { status: "fail", detail: "requireHttps is disabled — org allows non-HTTPS sessions" };
      return { status: "pass", detail: "HTTPS required for all sessions" };
    },
  },
  {
    id: "session_timeout", label: "Session Timeout Policy", category: "Security",
    tip: "Long or unlimited session timeouts increase the risk of session hijacking from unattended workstations. Best practice is ≤ 2 hours for internal users. Configure in Setup → Session Settings → Timeout Value.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const timeout = r.data.sessionSettings?.sessionTimeout;
      if (!timeout) return { status: "info", detail: "Session timeout value not returned by this org" };
      const longTimeouts = ["TwelveHours", "TwentyFourHours"];
      const medTimeouts  = ["FourHours", "EightHours"];
      if (longTimeouts.includes(timeout)) return { status: "warn", detail: `Session timeout: ${timeout} — consider reducing to 2h or less` };
      if (medTimeouts.includes(timeout))  return { status: "warn", detail: `Session timeout: ${timeout}` };
      return { status: "pass", detail: `Session timeout: ${timeout}` };
    },
  },
  {
    id: "password_min_length", label: "Password Minimum Length", category: "Security",
    tip: "NIST SP 800-63B recommends at least 8 characters, and most orgs should target 12+. Configure in Setup → Password Policies. Pair with MFA for best protection.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const len = parseInt(r.data.passwordPolicies?.minimumPasswordLength ?? "0", 10);
      if (!len) return { status: "info", detail: "Password minimum length not returned by this org" };
      if (len < 8)  return { status: "fail", detail: `Minimum password length is ${len} — below NIST minimum of 8` };
      if (len < 12) return { status: "warn", detail: `Minimum password length is ${len} — consider 12+ for stronger security` };
      return { status: "pass", detail: `Minimum password length: ${len} characters` };
    },
  },
  {
    id: "password_complexity", label: "Password Complexity", category: "Security",
    tip: "Password complexity enforcement prevents trivially guessable passwords. Set at least 'AlphaNumeric' in Setup → Password Policies. 'SpecialCharacters' provides the strongest baseline.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const complexity = r.data.passwordPolicies?.complexity;
      if (!complexity) return { status: "info", detail: "Password complexity not returned by this org" };
      if (complexity === "NoRestriction") return { status: "fail", detail: "Password complexity set to NoRestriction — any password is accepted" };
      return { status: "pass", detail: `Password complexity: ${complexity}` };
    },
  },
  {
    id: "password_expiry", label: "Password Expiration Policy", category: "Security",
    tip: "Passwords that never expire can remain compromised indefinitely. Configure expiration in Setup → Password Policies. 90–180 day rotation is a common enterprise baseline; pair with MFA to reduce rotation pressure.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const expiry = r.data.passwordPolicies?.expiration;
      if (!expiry) return { status: "info", detail: "Password expiration not returned by this org" };
      if (expiry === "Never") return { status: "warn", detail: "Passwords never expire — consider setting a rotation policy" };
      return { status: "pass", detail: `Password expiration: ${expiry}` };
    },
  },
  {
    id: "max_login_attempts", label: "Login Lockout Threshold", category: "Security",
    tip: "No lockout (or 10+ attempts) makes brute-force attacks easier. Set max login attempts to 5 or fewer in Setup → Password Policies → Maximum Invalid Login Attempts. Combine with IP allowlisting for defense-in-depth.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const attempts = r.data.passwordPolicies?.maxLoginAttempts;
      if (!attempts) return { status: "info", detail: "Login lockout setting not returned by this org" };
      if (["NoLimit", "TenOrMore"].includes(attempts)) return { status: "warn", detail: `Max login attempts: ${attempts} — consider tightening to 5 or fewer` };
      return { status: "pass", detail: `Max login attempts before lockout: ${attempts}` };
    },
  },
  {
    id: "enforce_ip_ranges_every_request", label: "Enforce IP Ranges Per Request", category: "Security",
    tip: "By default, IP ranges are only checked at login — a session started inside a trusted IP can continue from an untrusted one. Enable 'Enforce login IP ranges on every request' in Setup → Session Settings to check IP on every API call.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const ranges  = r.data.ipRanges ?? [];
      const enforce = r.data.sessionSettings?.enforceIpRangesEveryRequest;
      if (ranges.length === 0) return { status: "info", detail: "No IP ranges configured — this setting has no effect" };
      if (enforce === "false") return { status: "warn", detail: "IP ranges are configured but not enforced on every request" };
      return { status: "pass", detail: "IP ranges enforced on every request" };
    },
  },
  {
    id: "admin_login_as", label: "Admins Can Log In As Any User", category: "Security",
    tip: "When enabled, System Admins can log in as any user without knowing their password. This is convenient for troubleshooting but is a significant privilege. Disable in Setup → Security → Login Access Policies unless actively needed, and monitor usage via Setup Audit Trail.",
    drillQuery: null,
    async run(alias, _api) {
      const r = await fetchSecuritySettings(alias, _api);
      if (!r.ok) return { status: "info", detail: `Security settings unavailable: ${r.error}` };
      const val = r.data.loginAccessPolicies?.administratorsCanLogInAsAny;
      if (val === "true") return { status: "warn", detail: "Admins can log in as any user — monitor and disable if not required" };
      return { status: "pass", detail: "Admin login-as is disabled" };
    },
  },

  // ── Audit & Changes ────────────────────────────────────────────────────────
  {
    id: "setup_audit_24h", label: "Setup Changes (Last 24h)", category: "Audit & Changes",
    tip: "Unexpected setup changes can indicate unauthorized admin activity. Review the Setup Audit Trail in Setup → Security → View Setup Audit Trail. For sensitive changes (profile edits, sharing rule changes, connected app additions), consider setting up Change Data Capture or email alerts.",
    drillQuery: "SELECT Action, Section, CreatedBy.Name, CreatedDate FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:1 ORDER BY CreatedDate DESC LIMIT 25",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:1" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 50) return { status: "warn", detail: `${count} setup changes in last 24h — review for unexpected activity` };
      return { status: "info", detail: `${count} setup changes in last 24h` };
    },
  },
  {
    id: "setup_audit_profile", label: "Profile/Permission Changes (Last 7 Days)", category: "Audit & Changes",
    tip: "Profile and permission set changes are high-risk configuration actions — they can silently grant broad data access to users. Ensure any changes were intentional and authorized. Consider requiring change management tickets before modifying profiles in production.",
    drillQuery: "SELECT Action, Section, Display, CreatedBy.Name, CreatedDate FROM SetupAuditTrail WHERE (Section = 'Profiles' OR Section = 'Permission Sets') AND CreatedDate = LAST_N_DAYS:7 ORDER BY CreatedDate DESC LIMIT 25",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM SetupAuditTrail WHERE (Section = 'Profiles' OR Section = 'Permission Sets') AND CreatedDate = LAST_N_DAYS:7" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 10) return { status: "warn", detail: `${count} profile/permset changes in last 7 days` };
      return { status: "info", detail: `${count} profile/permset changes in last 7 days` };
    },
  },

  // ── Automation ─────────────────────────────────────────────────────────────
  {
    id: "active_flows", label: "Active Flows", category: "Automation",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM FlowDefinitionView WHERE IsActive = true" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?";
      return { status: "info", detail: `${count} active flows in org` };
    },
  },
  {
    id: "inactive_flows", label: "Inactive / Obsolete Flows", category: "Automation",
    tip: "Inactive flows accumulate as flows are versioned and retired. In Setup → Flows, filter by Status = Inactive and delete old versions. Keep only the latest version of each flow. Unused flows slow down metadata deploys.",
    drillQuery: "SELECT Label, ProcessType, LastModifiedDate FROM FlowDefinitionView WHERE IsActive = false ORDER BY LastModifiedDate ASC LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM FlowDefinitionView WHERE IsActive = false" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?";
      if (count > 50) return { status: "warn", detail: `${count} inactive flows — consider cleanup to reduce technical debt` };
      return { status: "pass", detail: `${count} inactive flows` };
    },
  },
  {
    id: "scheduled_jobs", label: "Failed Scheduled Apex Jobs", category: "Automation",
    tip: "Failed scheduled jobs often indicate an unhandled exception in Apex code. Go to Setup → Apex Jobs to see the error message. Fix the underlying Apex class, then re-schedule the job. Consider adding try/catch with email notification to prevent silent failures.",
    drillQuery: "SELECT CronJobDetail.Name, State, NextFireTime, PreviousFireTime FROM CronTrigger WHERE State = 'ERROR' LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM CronTrigger WHERE State = 'ERROR'" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 0) return { status: "fail", detail: `${count} scheduled job(s) in ERROR state` };
      return { status: "pass", detail: "No failed scheduled jobs" };
    },
  },
  {
    id: "async_jobs", label: "Queued Async Apex Jobs", category: "Automation",
    tip: "A large async job queue can indicate a processing bottleneck or a looping trigger. Check Setup → Apex Jobs for jobs queued unusually long. Review the Apex class for inefficiencies or consider using Batch Apex with appropriate scope sizes.",
    drillQuery: "SELECT ApexClass.Name, Status, NumberOfErrors, CreatedDate FROM AsyncApexJob WHERE Status IN ('Queued','Processing','Holding') ORDER BY CreatedDate ASC LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM AsyncApexJob WHERE Status IN ('Queued','Processing','Holding')" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 20) return { status: "warn", detail: `${count} async jobs queued — check for backlog` };
      return { status: "pass", detail: `${count} async jobs queued` };
    },
  },
  {
    id: "failed_batch_jobs", label: "Failed Batch Apex Jobs (Last 24h)", category: "Automation",
    tip: "Batch Apex failures often go unnoticed because they fail silently. Add Database.BatchableContext logging and an email notification in your finish() method. Review failed jobs in Setup → Apex Jobs → filter by Status = Failed.",
    drillQuery: "SELECT ApexClass.Name, Status, NumberOfErrors, TotalJobItems, CompletedDate FROM AsyncApexJob WHERE JobType = 'BatchApex' AND Status = 'Failed' AND CreatedDate = LAST_N_DAYS:1 LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM AsyncApexJob WHERE JobType = 'BatchApex' AND Status = 'Failed' AND CreatedDate = LAST_N_DAYS:1" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 0) return { status: "fail", detail: `${count} batch Apex job(s) failed in last 24h` };
      return { status: "pass", detail: "No failed batch jobs in last 24h" };
    },
  },

  // ── Storage ────────────────────────────────────────────────────────────────
  {
    id: "data_storage", label: "Data Storage Usage", category: "Storage",
    tip: "When data storage is full, users cannot create new records. Identify large objects in Setup → Storage Usage and archive or delete old records using Bulk API hard-delete. Consider using Big Objects for historical data that doesn't need to be queried frequently.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api(`/api/orgs/${alias}/limits`);
      const ds = d.limits?.DataStorageMB;
      if (!ds) return { status: "info", detail: "Data storage limit not available" };
      const used = ds.Max - ds.Remaining;
      const pct  = ds.Max ? Math.round((used / ds.Max) * 100) : 0;
      const detail = `${used.toLocaleString()} MB / ${ds.Max.toLocaleString()} MB (${pct}% used)`;
      if (pct >= 80) return { status: "fail", detail };
      if (pct >= 60) return { status: "warn", detail };
      return { status: "pass", detail };
    },
  },
  {
    id: "file_storage", label: "File Storage Usage", category: "Storage",
    tip: "File storage fills up with Salesforce Files (ContentDocument), email attachments, and Chatter files. Run 'SELECT SUM(ContentSize) FROM ContentVersion' to identify large files. Archive old files to an external system using Salesforce Files Connect or a third-party archival tool.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api(`/api/orgs/${alias}/limits`);
      const fs = d.limits?.FileStorageMB;
      if (!fs) return { status: "info", detail: "File storage limit not available" };
      const used = fs.Max - fs.Remaining;
      const pct  = fs.Max ? Math.round((used / fs.Max) * 100) : 0;
      const detail = `${used.toLocaleString()} MB / ${fs.Max.toLocaleString()} MB (${pct}% used)`;
      if (pct >= 80) return { status: "fail", detail };
      if (pct >= 60) return { status: "warn", detail };
      return { status: "pass", detail };
    },
  },

  // ── Data Volume ────────────────────────────────────────────────────────────
  {
    id: "account_count", label: "Account Records", category: "Data Volume",
    tip: "Orgs with 5M+ Account records should evaluate Salesforce Big Objects or an archival strategy. Consider using the Bulk API with hard-delete to archive stale records. Review Data Storage in Setup → Storage Usage.",
    drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM Account" }) });
      const n = Number(d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0);
      if (n > 5_000_000) return { status: "warn", detail: `${n.toLocaleString()} records — consider archival strategy` };
      return { status: "info", detail: `${n.toLocaleString()} records` };
    },
  },
  {
    id: "contact_count", label: "Contact Records", category: "Data Volume",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM Contact" }) });
      return { status: "info", detail: `${Number(d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0).toLocaleString()} records` };
    },
  },
  {
    id: "opportunity_count", label: "Opportunity Records", category: "Data Volume",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM Opportunity" }) });
      return { status: "info", detail: `${Number(d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0).toLocaleString()} records` };
    },
  },
  {
    id: "case_count", label: "Case Records", category: "Data Volume",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM Case" }) });
      return { status: "info", detail: `${Number(d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0).toLocaleString()} records` };
    },
  },

  // ── Metadata ───────────────────────────────────────────────────────────────
  {
    id: "custom_objects", label: "Custom Objects", category: "Metadata",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM EntityDefinition WHERE IsCustomizable = true AND QualifiedApiName LIKE '%\\_\\_c' LIMIT 1" }) });
      return { status: "info", detail: `${d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?"} custom objects defined` };
    },
  },
  {
    id: "apex_classes", label: "Apex Classes", category: "Metadata",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM ApexClass" }) });
      return { status: "info", detail: `${d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?"} Apex classes` };
    },
  },
  {
    id: "apex_triggers", label: "Apex Triggers", category: "Metadata",
    tip: null, drillQuery: null,
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM ApexTrigger WHERE Status = 'Active'" }) });
      return { status: "info", detail: `${d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? "?"} active triggers` };
    },
  },
  {
    id: "email_deliverability", label: "Email Deliverability Setting", category: "Metadata",
    tip: "If Email Deliverability is set to 'System Email Only', all workflow/flow/process builder emails are silently blocked — only password resets and system notifications go through. Go to Setup → Email → Deliverability and set it to 'All Email' for production orgs.",
    drillQuery: null,
    async run(alias, _api) {
      // Query OrgWideEmailAddress as a proxy — if none exist, email may not be configured
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM OrgWideEmailAddress WHERE IsAllowAllProfiles = true" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count === 0) return { status: "warn", detail: "No org-wide email addresses configured for all profiles — check email deliverability in Setup" };
      return { status: "info", detail: `${count} org-wide email address(es) configured` };
    },
  },
  {
    id: "debug_logs", label: "Debug Log Accumulation", category: "Metadata",
    tip: "Debug logs consume file storage and can fill up quickly in active orgs. In Setup → Debug Logs, remove stale log entries and disable debug log monitoring for users who no longer need it. Production debug logs should be enabled temporarily, not permanently.",
    drillQuery: "SELECT LogUser.Name, Operation, Status, LogLength, StartTime FROM ApexLog ORDER BY StartTime DESC LIMIT 20",
    async run(alias, _api) {
      const d = await _api("/api/soql", { method: "POST", body: JSON.stringify({ alias, query: "SELECT COUNT(Id) total FROM ApexLog" }) });
      const count = d.records?.[0]?.total ?? d.records?.[0]?.expr0 ?? 0;
      if (count > 500) return { status: "warn", detail: `${count} debug logs accumulated — consider clearing to free storage` };
      return { status: "pass", detail: `${count} debug logs on file` };
    },
  },
];

export const CHECK_CATEGORIES = [...new Set(HEALTH_CHECKS.map(c => c.category))];
