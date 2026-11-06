# Handoff — sf-metadata-exp

**Date:** 2026-11-04  
**Status:** Working MVP — ready to run against a real org  
**Goal:** Export Salesforce Profiles & Permission Sets → Field Level Security + Object access → formatted Excel workbook

---

## What was built

A single-file Python desktop app (`sf_fls_exporter.py`) with:

- **Tkinter UI** — 3-step workflow: pick org → pick Profiles/PermSets → pick output path → run
- **SFDX integration** — shells out to `sf` (falls back to `sfdx`) with `--json` for all data retrieval; runs in background threads so the UI stays responsive
- **Excel export via openpyxl** — no Excel install required

### Excel structure

| Sheet | Rows | Columns |
|---|---|---|
| 📋 Summary | One per Salesforce object | One 6-col group per Profile/PermSet (Read, Create, Edit, Delete, Read All, Modify All) |
| Per-object (one per object) | One per field | One 2-col group per Profile/PermSet (Read, Read/Write) |

---

## How data is fetched

All queries use the Salesforce REST API via `sf data query --json`. No Metadata API or package deploys needed.

| Data | SOQL / CLI command |
|---|---|
| Org list | `sf org list` |
| All objects | `sf sobject list --sobject-type all` |
| Object describe (fields) | `sf sobject describe --sobject <ObjectName>` |
| Profile names | `SELECT Id, Name FROM Profile` |
| PermSet names | `SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = false` |
| Object perms (Profile) | `SELECT ... FROM ObjectPermissions WHERE Parent.Profile.Name = '...' AND SobjectType = '...'` |
| Field perms (Profile) | `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Parent.Profile.Name = '...' AND SobjectType = '...'` |
| Object perms (PermSet) | Same but `Parent.Name = '...' AND Parent.IsOwnedByProfile = false` |
| Field perms (PermSet) | Same pattern |

---

## Known limitations & improvement ideas

### Performance
The current approach fires **2 SOQL queries per (principal × object)** pair. For 10 profiles × 500 objects = 10,000 queries — slow.

**Fix:** Batch with `IN` clauses:
```sql
SELECT Field, PermissionsRead, PermissionsEdit, Parent.Profile.Name
FROM FieldPermissions
WHERE Parent.Profile.Name IN ('Admin', 'Standard User', ...)
  AND SobjectType = 'Account'
```
Then fan-out the results in Python. One query per object instead of one per (profile × object).

### Object filtering
Currently exports **all** objects. Consider adding:
- A checkbox list to pick specific objects
- A filter toggle: "Custom objects only" (API name ends in `__c`)
- A "recently used objects" cache

### Auth / multi-org
Currently relies on `sf org list` which only shows locally authenticated orgs. Could add:
- Direct username + password + security token login (via simple-salesforce)
- A "connect new org" button that fires `sf org login web`

### Error handling
`FieldPermissions` and `ObjectPermissions` are not queryable in all org editions or for all object types (e.g., some standard objects don't expose FLS). The tool catches and logs these silently — could surface them more clearly in the Excel output (e.g., a "N/A" cell with a note).

### Output enhancements
- Add a "Legend" sheet explaining color coding
- Add a filter/pivot-friendly flat export option (Object, Field, Principal, Type, Read, Edit)
- Freeze panes and auto-filters are already set; could add conditional formatting formulas

---

## Project structure

```
sf-metadata-exp/
├── sf_fls_exporter.py   # Full application (UI + data + Excel)
├── requirements.txt     # openpyxl>=3.1.0
├── README.md            # Setup and usage guide
└── HANDOFF.md           # This file
```

---

## Quick start for a new developer

```bash
cd /Users/jsantisi/dev/python/sf-metadata-exp
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
sf org login web          # authenticate if needed
python sf_fls_exporter.py
```

The main entry point is at the bottom of `sf_fls_exporter.py`:
```python
if __name__ == "__main__":
    app = App()
    app.mainloop()
```

The three logical sections are clearly separated with comments:
1. `# SFDX helpers` — all CLI/SOQL calls
2. `# Excel builder` — `build_excel()` function + openpyxl styles
3. `# Tkinter UI` — `App(tk.Tk)` class
