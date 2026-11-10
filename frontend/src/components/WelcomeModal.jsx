import { useState, useEffect } from "react";

const STORAGE_KEY = "vendavis_welcome_seen_v1";

const TABS = [
  { id: "fls",      label: "🔍 FLS Explorer" },
  { id: "profiles", label: "👤 Profiles & PermSets" },
];

function FlsTab() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">
          What is FLS Explorer?
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          Field-Level Security (FLS) controls which users can read or edit each field on a
          Salesforce object. Getting it wrong causes silent data loss, broken integrations,
          and compliance gaps — but Salesforce Setup makes it nearly impossible to audit at
          scale.
        </p>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">
          What you can do with it
        </h3>
        <div className="flex flex-col gap-2">
          {[
            ["🔎", "Audit field access",       "See every profile's and permission set's read/edit access to every field on any object — in one view."],
            ["📋", "Build a permissions template", "Export field access to Excel. The template is structured so you can define a new profile or permission set row by row."],
            ["🔄", "Apply changes (MVP-1)",    "Import a filled template back into Vendavis to deploy the Profile or Permission Set directly to your org."],
          ].map(([icon, title, desc]) => (
            <div key={title} className="flex gap-3 px-3.5 py-3 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800">
              <span className="text-lg shrink-0 mt-0.5">{icon}</span>
              <div>
                <p className="text-sm font-semibold text-gray-800 dark:text-white">{title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
        <span className="font-semibold">Workflow tip:</span> Start by selecting an org and
        object, then use the column headers to filter by Profile or Permission Set. Export
        to Excel when you're ready to share or build a new template.
      </div>
    </div>
  );
}

function ProfilesTab() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">
          Profiles &amp; Permission Sets
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          Profiles define a user's baseline access — what objects they can see, what fields
          they can edit, and what record types they can create. Permission Sets layer
          additional access on top without changing the profile.
        </p>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">
          Access control tiers
        </h3>
        <div className="flex flex-col gap-1.5 text-xs">
          {[
            ["Objects",       "Can a user see and interact with the object at all?",            "bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300"],
            ["Fields (FLS)",  "Can a user read or edit a specific field on that object?",       "bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800 text-blue-700 dark:text-blue-300"],
            ["Record Types",  "Which record types can a user create or see?",                   "bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800 text-teal-700 dark:text-teal-300"],
          ].map(([tier, desc, style]) => (
            <div key={tier} className={`flex gap-3 px-3 py-2.5 rounded-lg border ${style}`}>
              <span className="font-bold w-24 shrink-0">{tier}</span>
              <span className="leading-relaxed">{desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2">
          What you can do here
        </h3>
        <div className="flex flex-col gap-2">
          {[
            ["📊", "Compare side by side",   "Load any two profiles or permission sets and diff their object, field, and record type access in one table."],
            ["📤", "Export for audit",        "Export the full access matrix to Excel — useful for compliance reviews, security audits, or onboarding docs."],
            ["🏗️", "Template for deployment", "Use the export as a starting template: define a new permission set in the spreadsheet, import it back (MVP-1) to deploy without touching Setup."],
          ].map(([icon, title, desc]) => (
            <div key={title} className="flex gap-3 px-3.5 py-3 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
              <span className="text-lg shrink-0 mt-0.5">{icon}</span>
              <div>
                <p className="text-sm font-semibold text-gray-800 dark:text-white">{title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
        <span className="font-semibold">Profiles vs. Permission Sets:</span> Salesforce
        recommends keeping profiles minimal (baseline access only) and granting additional
        access through Permission Sets. Vendavis makes it easy to spot when a profile is
        doing too much.
      </div>
    </div>
  );
}

export default function WelcomeModal({ onClose }) {
  const [tab, setTab] = useState("fls");

  const handleClose = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden flex flex-col"
        style={{ maxHeight: "90vh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#1a2d5a] px-6 pt-6 pb-0 shrink-0">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <img src="/icon-32.png" alt="Vendavis" className="w-7 h-7 object-contain" />
                <h2 className="text-xl font-bold text-white tracking-tight">Welcome to Vendavis</h2>
              </div>
              <p className="text-xs text-blue-300 leading-relaxed">
                Unofficial Salesforce metadata explorer — audit, compare, and template
                your org's access control without leaving your desktop.
              </p>
            </div>
            <button
              onClick={handleClose}
              className="text-blue-300 hover:text-white text-lg leading-none mt-0.5 ml-4 shrink-0"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          {/* Tabs */}
          <div className="flex gap-1">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                  tab === id
                    ? "bg-white dark:bg-gray-900 text-[#1a2d5a] dark:text-blue-400"
                    : "text-blue-200 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {tab === "fls"      && <FlsTab />}
          {tab === "profiles" && <ProfilesTab />}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between shrink-0">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            You can reopen this guide from the Help menu.
          </p>
          <button
            onClick={handleClose}
            className="px-5 py-2 bg-[#1a2d5a] hover:bg-[#233d7a] text-white text-sm font-medium rounded-lg transition-colors"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

/** Returns true if the welcome modal should be shown (first launch). */
export function shouldShowWelcome() {
  return !localStorage.getItem(STORAGE_KEY);
}
