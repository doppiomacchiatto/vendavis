"""
Salesforce FLS & Object Access Exporter
========================================
Exports Profiles and Permission Sets → Object-level access + Field-Level Security
to an Excel workbook (one sheet per object).

Requirements:
  pip install openpyxl
  Salesforce CLI (sf or sfdx) installed and authenticated to a target org.
  The authenticated user must be a System Administrator (or have a permission set
  that grants Read on FieldPermissions, ObjectPermissions, Profile, and PermissionSet).

Usage:
  python sf_fls_exporter.py
"""

import os
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
from pathlib import Path
import traceback

# ── Extracted modules ─────────────────────────────────────────────────────────
from query_history import (
    _QUERY_HISTORY_DB, _QUERY_HISTORY_MAX,
    _qh_connect, _qh_save, _qh_load, _qh_delete, _qh_clear,
)
from claude_client import (
    _CLAUDE_CONFIG_PATH, _CLAUDE_MODEL,
    _load_claude_config, _save_claude_config, _get_claude_client,
)
from sf_cli import (
    SF_CLI, _find_sf_cli, _sf,
    list_orgs, list_objects, describe_object,
    list_profiles, list_permission_sets,
    get_object_perms_for_profile, get_fls_for_profile,
    get_object_perms_for_permset, get_fls_for_permset,
    get_profile_layout_assignments, run_apex_anonymous,
    _get_record_types_fallback,
)
from excel_builder import (
    HEADER_FILL, SUBHEAD_FILL, OBJ_HDR_FILL, READ_FILL, NONE_FILL, BOTH_FILL,
    WHITE_FONT, BOLD_FONT, NORMAL_FONT, SMALL_FONT,
    THIN_BORDER, CENTER, LEFT,
    CHECK, DASH, CHECK_FILL, DASH_FILL,
    NEW_PROFILE_HDR_FILL, NEW_PROFILE_CB_FILL,
    _safe_sheet_name, _write_section_header, _write_col_headers, _check_cell,
    _inject_checkboxes, _build_principal_sheet, _build_summary_sheet, build_excel,
)

# Maximum number of objects that can be selected for a single export run.
# Each object requires SOQL calls per profile/permset, so large selections
# can take several minutes and risk CLI timeouts.
MAX_EXPORT_OBJECTS = 25

# ──────────────────────────────────────────────────────────────────────────────
# Data fetcher (background thread)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_and_export(
    target_org, selected_objects, selected_profiles,
    selected_permsets, output_path, log_fn, done_fn, error_fn,
):
    try:
        objects_data = {}
        total = len(selected_objects)

        for i, (obj_name, obj_label) in enumerate(selected_objects, 1):
            log_fn(f"[{i}/{total}] Describing {obj_name}…")
            try:
                desc = describe_object(target_org, obj_name)
            except Exception as e:
                log_fn(f"   ⚠️  Describe failed for {obj_name}: {e}")
                continue

            fields = [f for f in desc.get("fields", [])
                      if f.get("name", "").lower() != "id"]
            if not fields:
                log_fn(f"   ⚠️  No fields found for {obj_name}, skipping.")
                continue

            obj_entry = {
                "label":   obj_label or desc.get("label", obj_name),
                "fields":  fields,
                "profiles": {},
                "permsets": {},
            }

            for prof in selected_profiles:
                log_fn(f"   👤 Profile: {prof}")
                try:
                    layout_assignments = get_profile_layout_assignments(target_org, prof, obj_name)
                    obj_entry["profiles"][prof] = {
                        "obj_perms":          get_object_perms_for_profile(target_org, prof, obj_name),
                        "fls":                get_fls_for_profile(target_org, prof, obj_name),
                        "layout_assignments": layout_assignments,
                    }
                except Exception as e:
                    log_fn(f"      ⚠️  {e}")
                    obj_entry["profiles"][prof] = {"obj_perms": {}, "fls": {}, "layout_assignments": []}

            for ps in selected_permsets:
                log_fn(f"   🔑 PermSet: {ps}")
                try:
                    obj_entry["permsets"][ps] = {
                        "obj_perms": get_object_perms_for_permset(target_org, ps, obj_name),
                        "fls":       get_fls_for_permset(target_org, ps, obj_name),
                    }
                except Exception as e:
                    log_fn(f"      ⚠️  {e}")
                    obj_entry["permsets"][ps] = {"obj_perms": {}, "fls": {}}

            objects_data[obj_name] = obj_entry

        log_fn("\n📊 Building Excel workbooks…")
        saved = build_excel(output_path, objects_data, selected_profiles, selected_permsets, log_fn,
                            target_org=target_org)
        done_fn(saved)

    except Exception:
        error_fn(traceback.format_exc())


# ──────────────────────────────────────────────────────────────────────────────
# Tkinter UI
# ──────────────────────────────────────────────────────────────────────────────

BG       = "#F0F4F8"
TITLE_BG = "#1F4E79"
BLUE     = "#2E75B6"

MODAL_BG      = "#FFFFFF"
MODAL_SECTION = "#F2F2F7"   # Apple-style grouped section background
MODAL_BORDER  = "#D1D1D6"
MODAL_BTN_BG  = "#E5E5EA"
MODAL_SEL_BG  = "#007AFF"   # iOS/macOS selection blue
MODAL_SEL_FG  = "#FFFFFF"
MODAL_TEXT    = "#1C1C1E"
MODAL_SUBTEXT = "#6C6C70"


class OrgPickerDialog(tk.Toplevel):
    """Startup org-picker modal — groups orgs by type, returns selected org."""

    # Map sf org list section names → display labels
    _SECTION_LABELS = {
        "scratchOrgs":    "Scratch",
        "sandboxOrgs":    "Sandbox",
        "nonScratchOrgs": "Production",
        "regularOrgs":    "Production",
    }
    # Preferred display order
    _SECTION_ORDER = ["Production", "Sandbox", "Scratch"]

    def __init__(self, parent):
        super().__init__(parent)
        self.title("Connect to Salesforce")
        self.resizable(False, False)
        self.configure(bg=MODAL_BG)
        self.transient(parent)
        self.grab_set()

        self.selected_org   = None   # set on confirm
        self._orgs_by_group = {}     # {group_label: [(alias, username, is_default)]}
        self._btn_widgets   = []     # (btn_widget, alias, username) — for selection tracking
        self._selected_btn  = None
        self._loading       = False

        self._build()

        # Centre over parent
        self.update_idletasks()
        pw, ph = parent.winfo_width(), parent.winfo_height()
        px, py = parent.winfo_rootx(), parent.winfo_rooty()
        w, h   = self.winfo_width(), self.winfo_height()
        self.geometry(f"{w}x{h}+{px + (pw - w)//2}+{py + (ph - h)//2}")

        # Fetch orgs in background
        self.after(50, self._load_orgs)

    # ── Build ──────────────────────────────────────────────────────────────────
    def _build(self):
        # ── Header ──
        hdr = tk.Frame(self, bg=MODAL_BG)
        hdr.pack(fill="x", padx=0, pady=0)

        # Tab switcher (Saved Logins | New Login) — purely visual for now
        tab_row = tk.Frame(hdr, bg=MODAL_BG)
        tab_row.pack(pady=(18, 10))

        self._tab_var = tk.StringVar(value="saved")

        def _make_tab(text, value):
            def _select():
                self._tab_var.set(value)
                _refresh_tabs()
                if value == "new":
                    self._open_new_login()
            return tk.Button(tab_row, text=text, font=("Arial", 11),
                             bg=MODAL_BTN_BG, fg=MODAL_TEXT,
                             relief="flat", bd=0, padx=18, pady=5,
                             cursor="hand2", command=_select)

        self._saved_tab_btn = _make_tab("Saved Logins", "saved")
        self._saved_tab_btn.pack(side="left", padx=(0, 1))
        self._new_tab_btn   = _make_tab("New Login", "new")
        self._new_tab_btn.pack(side="left")

        def _refresh_tabs():
            v = self._tab_var.get()
            self._saved_tab_btn.configure(
                relief="solid" if v == "saved" else "flat",
                bd=1 if v == "saved" else 0,
            )

        _refresh_tabs()

        # Separator
        tk.Frame(hdr, bg=MODAL_BORDER, height=1).pack(fill="x", pady=(4, 0))

        # ── Scrollable org list area ──
        list_outer = tk.Frame(self, bg=MODAL_BG)
        list_outer.pack(fill="both", expand=True, padx=0)

        self._canvas = tk.Canvas(list_outer, bg=MODAL_BG, highlightthickness=0,
                                 width=480, height=440)
        vsb = ttk.Scrollbar(list_outer, orient="vertical", command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self._canvas.pack(side="left", fill="both", expand=True)

        self._list_frame = tk.Frame(self._canvas, bg=MODAL_BG)
        self._list_frame.columnconfigure(0, weight=1)
        self._cwin = self._canvas.create_window((0, 0), window=self._list_frame, anchor="nw")

        self._list_frame.bind("<Configure>",
            lambda e: self._canvas.configure(scrollregion=self._canvas.bbox("all")))
        self._canvas.bind("<Configure>",
            lambda e: self._canvas.itemconfig(self._cwin, width=e.width))
        self._canvas.bind_all("<MouseWheel>",
            lambda e: self._canvas.yview_scroll(int(-1*(e.delta/120)), "units"))

        # Loading placeholder
        self._loading_lbl = tk.Label(self._list_frame,
            text="Loading orgs…", font=("Arial", 11), fg=MODAL_SUBTEXT, bg=MODAL_BG)
        self._loading_lbl.pack(pady=40)

        # ── Footer ──
        tk.Frame(self, bg=MODAL_BORDER, height=1).pack(fill="x")
        footer = tk.Frame(self, bg=MODAL_BG)
        footer.pack(fill="x", padx=20, pady=12)

        self._edit_btn = ttk.Button(footer, text="Edit", command=self._open_new_login)
        self._edit_btn.pack(side="right", padx=(6, 0))
        ttk.Button(footer, text="Cancel", command=self._cancel).pack(side="right")

    # ── Data loading ────────────────────────────────────────────────────────────
    def _load_orgs(self):
        def _work():
            try:
                data = _sf("org", "list")
                result = data.get("result", {})
                by_group = {}
                for section, label in self._SECTION_LABELS.items():
                    for o in result.get(section, []):
                        alias    = o.get("alias") or ""
                        username = o.get("username") or ""
                        default  = bool(o.get("isDefaultDevHubUsername") or o.get("isDefault"))
                        if username:
                            by_group.setdefault(label, [])
                            # Deduplicate
                            if not any(u == username for _, u, _ in by_group[label]):
                                by_group[label].append((alias, username, default))
                self.after(0, lambda: self._populate(by_group))
            except Exception as e:
                self.after(0, lambda: self._populate({}, error=str(e)))

        threading.Thread(target=_work, daemon=True).start()

    def _populate(self, by_group, error=None):
        self._loading_lbl.destroy()
        self._btn_widgets.clear()

        if error:
            tk.Label(self._list_frame,
                     text=f"⚠️  Could not load orgs:\n{error}",
                     font=("Arial", 10), fg="#C0392B", bg=MODAL_BG,
                     wraplength=420, justify="left").pack(padx=24, pady=20)
            return

        if not by_group:
            tk.Label(self._list_frame,
                     text="No authenticated orgs found.\nClick 'New Login' to connect one.",
                     font=("Arial", 11), fg=MODAL_SUBTEXT, bg=MODAL_BG,
                     justify="center").pack(pady=40)
            return

        first_btn = None
        for group in self._SECTION_ORDER:
            orgs = by_group.get(group)
            if not orgs:
                continue

            # Section header
            tk.Label(self._list_frame,
                     text=group, font=("Arial", 10, "bold"),
                     fg=MODAL_TEXT, bg=MODAL_BG, anchor="w"
                     ).pack(fill="x", padx=24, pady=(14, 4))

            # Section container
            section = tk.Frame(self._list_frame, bg=MODAL_SECTION,
                                highlightbackground=MODAL_BORDER,
                                highlightthickness=1)
            section.pack(fill="x", padx=20, pady=(0, 4))
            section.columnconfigure(0, weight=1)

            for row_idx, (alias, username, is_default) in enumerate(orgs):
                display = username
                sub     = alias if alias else ("Default" if is_default else "")

                btn_frame = tk.Frame(section, bg=MODAL_SECTION, cursor="hand2")
                btn_frame.grid(row=row_idx, column=0, sticky="ew")
                btn_frame.columnconfigure(0, weight=1)

                if row_idx > 0:
                    tk.Frame(section, bg=MODAL_BORDER, height=1).grid(
                        row=row_idx * 2 - 1, column=0, sticky="ew")

                name_lbl = tk.Label(btn_frame, text=display,
                                    font=("Arial", 11), bg=MODAL_SECTION,
                                    fg=MODAL_TEXT, anchor="center", pady=10)
                name_lbl.pack(fill="x", padx=12)

                # Capture for closure
                _alias, _username = alias, username
                _frame, _lbl = btn_frame, name_lbl

                def _click(a=_alias, u=_username, f=_frame, l=_lbl):
                    self._select_org(a, u, f, l)

                btn_frame.bind("<Button-1>", lambda e, fn=_click: fn())
                name_lbl.bind("<Button-1>",  lambda e, fn=_click: fn())
                # Hover highlight
                def _enter(e, f=btn_frame, l=name_lbl):
                    if f != self._selected_btn:
                        f.configure(bg="#E5E5EA")
                        l.configure(bg="#E5E5EA")
                def _leave(e, f=btn_frame, l=name_lbl):
                    if f != self._selected_btn:
                        f.configure(bg=MODAL_SECTION)
                        l.configure(bg=MODAL_SECTION)
                btn_frame.bind("<Enter>", _enter)
                btn_frame.bind("<Leave>", _leave)
                name_lbl.bind("<Enter>",  _enter)
                name_lbl.bind("<Leave>",  _leave)
                # Double-click to confirm immediately
                btn_frame.bind("<Double-Button-1>", lambda e, fn=_click: (fn(), self._confirm()))
                name_lbl.bind("<Double-Button-1>",  lambda e, fn=_click: (fn(), self._confirm()))

                self._btn_widgets.append((_frame, _lbl, _alias, _username))

                if first_btn is None or is_default:
                    first_btn = (_frame, _lbl, _alias, _username)

        # Auto-select default/first org
        if first_btn:
            f, l, a, u = first_btn
            self._select_org(a, u, f, l)

        # Swap footer: show Connect button
        self._edit_btn.configure(text="Connect", command=self._confirm)

    def _select_org(self, alias, username, frame, lbl):
        # Deselect previous
        if self._selected_btn:
            prev_f, prev_l = self._selected_btn
            prev_f.configure(bg=MODAL_SECTION)
            prev_l.configure(bg=MODAL_SECTION)
        # Highlight new
        frame.configure(bg=MODAL_SEL_BG)
        lbl.configure(bg=MODAL_SEL_BG, fg=MODAL_SEL_FG)
        self._selected_btn   = (frame, lbl)
        self._pending_alias   = alias
        self._pending_username = username

    def _confirm(self):
        if not hasattr(self, "_pending_username"):
            return
        self.selected_org = self._pending_alias or self._pending_username
        self.grab_release()
        self.destroy()

    def _cancel(self):
        self.selected_org = None
        self.grab_release()
        self.destroy()

    def _open_new_login(self):
        """Fire sf org login web in background; refresh org list when done."""
        self._tab_var.set("saved")   # keep Saved Logins tab active

        def _refresh_ui():
            # Clear the list pane and show a loading label
            for w in self._list_frame.winfo_children():
                w.destroy()
            self._selected_btn = None
            self._btn_widgets  = []
            self._loading_lbl  = tk.Label(
                self._list_frame,
                text="Refreshing orgs…",
                font=("Arial", 11), fg=MODAL_SUBTEXT, bg=MODAL_BG,
            )
            self._loading_lbl.pack(pady=40)
            self._load_orgs()

        def _work():
            try:
                subprocess.run(
                    [_find_sf_cli(), "org", "login", "web", "--json"],
                    timeout=300,
                )
            except Exception:
                pass
            self.after(0, _refresh_ui)

        threading.Thread(target=_work, daemon=True).start()


class FilterableListbox(tk.Frame):
    """A Listbox with a search filter entry above it and All/None buttons."""

    def __init__(self, parent, label, height=9, **kwargs):
        super().__init__(parent, bg=BG, **kwargs)
        self.columnconfigure(0, weight=1)

        # Header + buttons row
        hdr = tk.Frame(self, bg=BG)
        hdr.grid(row=0, column=0, sticky="ew", pady=(0, 2))
        tk.Label(hdr, text=label, font=("Arial", 9, "bold"), bg=BG, fg=TITLE_BG).pack(side="left")
        ttk.Button(hdr, text="All",  width=4,
                   command=lambda: self._lb.select_set(0, "end")).pack(side="right")
        ttk.Button(hdr, text="None", width=4,
                   command=lambda: self._lb.select_clear(0, "end")).pack(side="right", padx=(0, 2))

        # Search entry
        self._filter_var = tk.StringVar()
        self._filter_var.trace_add("write", self._on_filter)
        tk.Entry(self, textvariable=self._filter_var, font=("Arial", 9),
                 bg="#FFFFFF", fg="#1C1C1E", insertbackground="#1C1C1E").grid(
            row=1, column=0, columnspan=2, sticky="ew", pady=(0, 2))

        # Listbox + scrollbar
        self._lb = tk.Listbox(self, selectmode="multiple", height=height,
                              font=("Arial", 9), exportselection=False,
                              bg="#FFFFFF", fg="#1C1C1E",
                              selectbackground="#B5D5FF", selectforeground="#1C1C1E")
        sb = ttk.Scrollbar(self, orient="vertical", command=self._lb.yview)
        self._lb.configure(yscrollcommand=sb.set)
        self._lb.grid(row=2, column=0, sticky="nsew")
        sb.grid(row=2, column=1, sticky="ns")
        self.rowconfigure(2, weight=1)

        self._all_items = []   # list of (display_label, value)

    def set_items(self, items):
        """items: list of (display_label, value) tuples."""
        self._all_items = items
        self._filter_var.set("")
        self._repopulate(items)

    def _on_filter(self, *_):
        q = self._filter_var.get().lower()
        filtered = [(d, v) for d, v in self._all_items if q in d.lower() or q in v.lower()]
        self._repopulate(filtered)

    def _repopulate(self, items):
        self._lb.delete(0, "end")
        self._displayed = items
        for display, _ in items:
            self._lb.insert("end", display)

    def get_selected_values(self):
        return [self._displayed[i][1] for i in self._lb.curselection()]

    def select_by_value(self, api_name):
        """Clear filter, then select (and scroll to) the item matching api_name."""
        self._filter_var.set("")          # show all items
        self._lb.selection_clear(0, "end")
        for i, (_, val) in enumerate(self._displayed):
            if val == api_name:
                self._lb.selection_set(i)
                self._lb.see(i)
                self._lb.event_generate("<<ListboxSelect>>")
                return True
        return False

    def count(self):
        return self._lb.size()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Salesforce Tools")
        self.geometry("1060x860")
        self.minsize(800, 680)
        self.resizable(True, True)
        # Force light mode — override macOS dark mode so all widgets are readable
        try:
            self.tk.call("tk", "scaling", 1.0)
        except Exception:
            pass
        try:
            # aqua theme on macOS: force appearance to light
            self.tk.call("set", "::tk::mac::useThemedToplevel", "1")
        except Exception:
            pass
        # tk_setPalette forces classic Tk widget palette globally (most reliable for macOS dark mode)
        try:
            self.tk_setPalette(
                background=BG,
                foreground="#1C1C1E",
                activeBackground="#D0E4FF",
                activeForeground="#1C1C1E",
                highlightBackground=BG,
                highlightColor="#2E75B6",
                selectBackground="#B5D5FF",
                selectForeground="#1C1C1E",
                insertBackground="#1C1C1E",
            )
        except Exception:
            pass
        self.configure(bg=BG)
        # Belt-and-suspenders: option_add as fallback
        self.option_add("*Background",        BG,       "userDefault")
        self.option_add("*Foreground",        "#1C1C1E","userDefault")
        self.option_add("*Entry.Background",  "#FFFFFF","userDefault")
        self.option_add("*Entry.Foreground",  "#1C1C1E","userDefault")
        self.option_add("*Text.Background",   "#FFFFFF","userDefault")
        self.option_add("*Text.Foreground",   "#1C1C1E","userDefault")
        self.option_add("*Listbox.Background","#FFFFFF","userDefault")
        self.option_add("*Listbox.Foreground","#1C1C1E","userDefault")
        self.option_add("*Listbox.selectBackground","#B5D5FF","userDefault")
        self.option_add("*Listbox.selectForeground","#1C1C1E","userDefault")
        self.option_add("*Label.Background",  BG,       "userDefault")
        self.option_add("*Label.Foreground",  "#1C1C1E","userDefault")
        self._all_objects    = []
        self._startup_org    = None   # org chosen in the picker modal
        self._claude_objects_loaded = False   # flag: lazy-load triggered on Claude tab open
        self._build_ui()
        # Show the org picker after the window is drawn
        self.after(100, self._show_org_picker)

    # ── Layout ─────────────────────────────────────────────────────────────────
    def _build_ui(self):
        # Title bar
        title_frame = tk.Frame(self, bg=TITLE_BG, height=56)
        title_frame.pack(fill="x")
        title_frame.pack_propagate(False)
        tk.Label(
            title_frame,
            text="  🔐  Salesforce Tools",
            font=("Arial", 15, "bold"), fg="white", bg=TITLE_BG, anchor="w",
        ).pack(side="left", padx=16, pady=10)
        ttk.Button(title_frame, text="⚙️  Settings",
                   command=self._open_settings).pack(side="right", padx=12, pady=10)

        # Admin notice banner
        notice = tk.Frame(self, bg="#FFF3CD")
        notice.pack(fill="x", padx=0)
        tk.Label(
            notice,
            text="⚠️  The authenticated Salesforce user must be a System Administrator "
                 "(or have a permission set granting Read on FieldPermissions, ObjectPermissions, "
                 "Profile, PermissionSet, and Apex objects).",
            font=("Arial", 9), bg="#FFF3CD", fg="#856404", anchor="w", wraplength=1020,
        ).pack(padx=14, pady=6, anchor="w")

        # ── Bottom widgets FIRST — pack these before the notebook so they
        #    reserve their space before expand=True grabs everything ────────────

        # Status bar (very bottom)
        self.status_var = tk.StringVar(value="Ready — load an org to begin.")
        self._status_bar = tk.Label(self, textvariable=self.status_var, font=("Arial", 9),
                                    fg="#555", bg="#DDE8F0", anchor="w")
        self._status_bar.pack(fill="x", side="bottom", padx=8, pady=4)

        # Run Export footer (sits above status bar)
        self._fls_footer = tk.Frame(self, bg="#E8F0F7", bd=1, relief="ridge")
        self.run_btn = ttk.Button(self._fls_footer, text="▶  Run Export", command=self._run)
        self.run_btn.pack(side="left", padx=16, pady=8)
        tk.Label(self._fls_footer,
                 text="Complete Steps 1–2 (required) and Steps 3–4 (optional/output) then click Run.",
                 font=("Arial", 9), bg="#E8F0F7", fg="#444").pack(side="left", padx=4)
        self._fls_footer.pack(fill="x", side="bottom")

        # ── Tab bar (fills remaining space after bottom widgets are reserved) ──
        style = ttk.Style()
        # Force light theme regardless of OS dark mode
        try:
            style.theme_use("aqua")   # macOS native light; falls back gracefully
        except Exception:
            try:
                style.theme_use("clam")
            except Exception:
                pass
        style.configure(".",          background=BG, foreground="#1C1C1E")
        style.configure("TFrame",     background=BG)
        style.configure("TLabel",     background=BG, foreground="#1C1C1E")
        style.configure("TEntry",     fieldbackground="#FFFFFF", foreground="#1C1C1E")
        style.configure("TCombobox",  fieldbackground="#FFFFFF", foreground="#1C1C1E")
        style.configure("TSpinbox",   fieldbackground="#FFFFFF", foreground="#1C1C1E")
        style.configure("TNotebook",  background=BG)
        style.configure("TNotebook.Tab", font=("Arial", 10, "bold"), padding=[12, 6])
        style.configure("Treeview",
                        background="#FFFFFF", foreground="#1C1C1E",
                        fieldbackground="#FFFFFF", rowheight=22)
        style.configure("Treeview.Heading",
                        background="#E8EFF5", foreground="#1C1C1E",
                        font=("Arial", 9, "bold"), relief="flat")
        style.map("Treeview",
                  background=[("selected", "#B5D5FF")],
                  foreground=[("selected", "#1C1C1E")])

        self._notebook = ttk.Notebook(self)
        self._notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)

        # ── Tab 1: FLS Exporter ────────────────────────────────────────────────
        fls_tab = tk.Frame(self._notebook, bg=BG)
        self._notebook.add(fls_tab, text="📊  FLS Exporter")
        self._build_fls_tab(fls_tab)

        # ── Tab 2: SOQL Runner ────────────────────────────────────────────────
        soql_tab = tk.Frame(self._notebook, bg=BG)
        self._notebook.add(soql_tab, text="🔍  SOQL Runner")
        self._build_soql_tab(soql_tab)

        # ── Tab 3: Apex Runner ─────────────────────────────────────────────────
        apex_tab = tk.Frame(self._notebook, bg=BG)
        self._notebook.add(apex_tab, text="⚡  Apex Runner")
        self._build_apex_tab(apex_tab)

        # ── Tab 4: Claude Assistant ────────────────────────────────────────────
        self._claude_tab_frame = tk.Frame(self._notebook, bg=BG)
        self._notebook.add(self._claude_tab_frame, text="🤖  Claude")
        self._build_claude_tab(self._claude_tab_frame)

        # Pack notebook last so expand=True only fills remaining space
        self._notebook.pack(fill="both", expand=True, padx=0, pady=0)
        # Orgs are loaded by the startup org picker — not auto-loaded here

    def _show_org_picker(self):
        """Show the org picker modal on startup; pre-select the chosen org."""
        picker = OrgPickerDialog(self)
        self.wait_window(picker)

        chosen = picker.selected_org
        if not chosen:
            # User cancelled — still load orgs in the background so the combo populates
            self._load_orgs()
            return

        # Load orgs and pre-select the one the user picked
        self._log(f"⏳ Connecting to {chosen}…")
        self._startup_org = chosen

        def _work():
            try:
                orgs = list_orgs()
                items, target_idx = [], 0
                for i, (alias, username, is_default) in enumerate(orgs):
                    label = f"{alias} ({username})" if alias else username
                    items.append(label)
                    # Match by alias or username
                    if chosen in (alias, username):
                        target_idx = i

                def _update():
                    self.org_combo["values"] = items
                    self._orgs = orgs
                    if items:
                        self.org_combo.current(target_idx)
                        self._log(f"✅ Connected: {items[target_idx]}")
                        self._set_status(f"Connected to {items[target_idx]}")
                self.after(0, _update)
            except Exception as e:
                self._log(f"❌ Error loading orgs: {e}")

        threading.Thread(target=_work, daemon=True).start()

    def _on_org_changed(self, event=None):
        """Reset Claude lazy-load flag when user picks a different org."""
        self._claude_objects_loaded  = False
        self._claude_objects_loading = False
        self._all_objects            = {}

    def _on_tab_changed(self, event=None):
        """Show the FLS footer only on the FLS Exporter tab; lazy-load objects on Claude tab."""
        idx = self._notebook.index(self._notebook.select())
        if idx == 0:
            # Re-pack above the status bar so it stays visible
            self._fls_footer.pack(fill="x", side="bottom", before=self._status_bar)
        else:
            self._fls_footer.pack_forget()

        # Claude tab (index 3) — silently load objects in background if not already loaded
        if idx == 3:
            self._claude_lazy_load_objects()

    def _build_fls_tab(self, parent):
        """Build the FLS Exporter content inside the given tab frame."""
        # ── Scrollable main area ───────────────────────────────────────────────
        outer = tk.Frame(parent, bg=BG)
        outer.pack(fill="both", expand=True)

        _canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        _vsb    = ttk.Scrollbar(outer, orient="vertical", command=_canvas.yview)
        _canvas.configure(yscrollcommand=_vsb.set)
        _vsb.pack(side="right", fill="y")
        _canvas.pack(side="left", fill="both", expand=True)

        content = tk.Frame(_canvas, bg=BG)
        content.columnconfigure(0, weight=1)
        _canvas_win = _canvas.create_window((0, 0), window=content, anchor="nw")

        def _on_frame_configure(e):
            _canvas.configure(scrollregion=_canvas.bbox("all"))
        content.bind("<Configure>", _on_frame_configure)

        def _on_canvas_resize(e):
            _canvas.itemconfig(_canvas_win, width=e.width)
        _canvas.bind("<Configure>", _on_canvas_resize)

        # Mouse-wheel scrolling
        def _on_mousewheel(e):
            _canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")
        _canvas.bind_all("<MouseWheel>", _on_mousewheel)
        # macOS two-finger trackpad
        _canvas.bind_all("<Button-4>", lambda e: _canvas.yview_scroll(-1, "units"))
        _canvas.bind_all("<Button-5>", lambda e: _canvas.yview_scroll( 1, "units"))

        # Add padding inside content
        tk.Frame(content, bg=BG, height=10).grid(row=999, column=0)  # bottom padding
        content_pad = tk.Frame(content, bg=BG)
        content_pad.grid(row=0, column=0, sticky="nsew", padx=18, pady=10)
        content_pad.columnconfigure(0, weight=1)
        content = content_pad   # redirect all subsequent layout to padded inner frame

        # ── Step 1: Org ────────────────────────────────────────────────────────
        self._section(content, "Step 1 — Select Salesforce Org", row=0)
        org_row = tk.Frame(content, bg=BG)
        org_row.grid(row=1, column=0, sticky="ew", pady=(0, 6))
        tk.Label(org_row, text="Target Org:", font=("Arial", 10), bg=BG).pack(side="left")
        self.org_var   = tk.StringVar()
        self.org_combo = ttk.Combobox(org_row, textvariable=self.org_var, width=44, state="readonly")
        self.org_combo.pack(side="left", padx=(8, 6))
        # Reset Claude lazy-load flag when org changes so context reloads for new org
        self.org_combo.bind("<<ComboboxSelected>>", self._on_org_changed)
        ttk.Button(org_row, text="🔄 Refresh Orgs", command=self._load_orgs).pack(side="left", padx=4)

        # ── Step 2: Objects ────────────────────────────────────────────────────
        self._section(content, "Step 2 — Select Objects to Export", row=2)

        obj_outer = tk.Frame(content, bg=BG)
        obj_outer.grid(row=3, column=0, sticky="nsew", pady=(0, 6))
        obj_outer.columnconfigure(0, weight=2)   # objects list
        obj_outer.columnconfigure(1, weight=3)   # field preview
        obj_outer.rowconfigure(1, weight=1)

        # Button row
        obj_btn_row = tk.Frame(obj_outer, bg=BG)
        obj_btn_row.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 4))
        self._load_obj_btn = ttk.Button(obj_btn_row, text="Load Objects",
                                        command=self._load_objects)
        self._load_obj_btn.pack(side="left")
        ttk.Button(obj_btn_row, text="Load Fields for Selected",
                   command=self._load_fields_for_selected).pack(side="left", padx=(8, 0))
        ttk.Button(obj_btn_row, text="🗑 Clear All",
                   command=self._clear_objects_and_fields).pack(side="left", padx=(8, 0))
        self._fields_count_var = tk.StringVar(value="")
        tk.Label(obj_btn_row, textvariable=self._fields_count_var,
                 font=("Arial", 9), bg=BG, fg="#2E75B6").pack(side="left", padx=12)
        # Limit hint — right-aligned
        tk.Label(obj_btn_row, text=f"⚠️  Max {MAX_EXPORT_OBJECTS} objects per export",
                 font=("Arial", 9, "italic"), bg=BG, fg="#888888").pack(side="right", padx=4)

        # Left — object list
        self.obj_list = FilterableListbox(obj_outer,
                                          label="Objects  (select to preview fields)",
                                          height=14)
        self.obj_list.grid(row=1, column=0, sticky="nsew", padx=(0, 6))

        # Right — field preview panel (hidden until an object is selected)
        self._preview_frame = tk.LabelFrame(obj_outer, text="Field Preview",
                                            font=("Arial", 9, "bold"),
                                            bg=BG, fg=TITLE_BG, padx=4, pady=4)
        # Don't grid it yet — shown on first selection
        self._preview_frame.columnconfigure(0, weight=1)
        self._preview_frame.rowconfigure(1, weight=1)

        self._preview_obj_var = tk.StringVar(value="")
        tk.Label(self._preview_frame, textvariable=self._preview_obj_var,
                 font=("Arial", 9, "bold"), bg=BG, fg=TITLE_BG, anchor="w").grid(
            row=0, column=0, sticky="ew", pady=(0, 4))

        tree_frame = tk.Frame(self._preview_frame, bg=BG)
        tree_frame.grid(row=1, column=0, sticky="nsew")
        tree_frame.columnconfigure(0, weight=1)
        tree_frame.rowconfigure(0, weight=1)

        self._field_tree = ttk.Treeview(
            tree_frame,
            columns=("label", "api", "type"),
            show="headings",
            height=13,
            selectmode="none",
        )
        self._field_tree.heading("label", text="Field Label")
        self._field_tree.heading("api",   text="API Name")
        self._field_tree.heading("type",  text="Type")
        self._field_tree.column("label", width=180, stretch=True)
        self._field_tree.column("api",   width=180, stretch=True)
        self._field_tree.column("type",  width=90,  stretch=False)

        tree_sb = ttk.Scrollbar(tree_frame, orient="vertical",
                                command=self._field_tree.yview)
        self._field_tree.configure(yscrollcommand=tree_sb.set)
        self._field_tree.grid(row=0, column=0, sticky="nsew")
        tree_sb.grid(row=0, column=1, sticky="ns")

        self._field_tree.tag_configure("even", background="#F4F8FC")
        self._field_tree.tag_configure("odd",  background="#FFFFFF")
        self._preview_visible = False

        # Wire up selection → live preview
        self.obj_list._lb.bind("<<ListboxSelect>>", self._on_obj_select)

        # ── Step 3: Profiles & PermSets (optional) ────────────────────────────
        self._section(
            content,
            "Step 3 — Select Profiles & Permission Sets  (Optional — for access audit)",
            row=4,
        )
        # Subtitle
        tk.Label(
            content,
            text="Skip this step to export a plain object/field inventory.  "
                 "Select Profiles and/or Permission Sets to validate access: "
                 "object permissions (Read / Create / Edit / Delete / Read All / Modify All) "
                 "and field-level security (Read / Read-Write) are mapped per principal.",
            font=("Arial", 9), bg=BG, fg="#444", anchor="w", wraplength=940, justify="left",
        ).grid(row=4, column=0, sticky="w", pady=(32, 4))

        lists_frame = tk.Frame(content, bg=BG)
        lists_frame.grid(row=5, column=0, sticky="ew", pady=(0, 6))
        lists_frame.columnconfigure(0, weight=1)
        lists_frame.columnconfigure(1, weight=1)

        self.profile_list = FilterableListbox(lists_frame, label="Profiles", height=6)
        self.profile_list.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        ttk.Button(lists_frame, text="Load Profiles",
                   command=self._load_profiles).grid(row=1, column=0, sticky="w", pady=(4, 0))

        self.permset_list = FilterableListbox(lists_frame, label="Permission Sets", height=6)
        self.permset_list.grid(row=0, column=1, sticky="nsew")
        ttk.Button(lists_frame, text="Load Permission Sets",
                   command=self._load_permsets).grid(row=1, column=1, sticky="w", pady=(4, 0))

        lists_frame.rowconfigure(0, weight=1)

        # ── Step 4: New / Target Profiles & Perm Sets ─────────────────────────
        self._section(
            content,
            "Step 4 — Add New or Target Profiles / Permission Sets  (Optional)",
            row=6,
        )
        tk.Label(
            content,
            text="Use Case 1 — New implementation: add names of profiles/perm sets that "
                 "don't exist yet in the org. They appear as blank checkbox columns for planning.\n"
                 "Use Case 2 — Existing org: skip this step and use the org profiles selected above.",
            font=("Arial", 9), bg=BG, fg="#444", anchor="w", wraplength=940, justify="left",
        ).grid(row=6, column=0, sticky="w", pady=(32, 4))

        new_principals_frame = tk.Frame(content, bg=BG)
        new_principals_frame.grid(row=7, column=0, sticky="ew", pady=(0, 6))
        new_principals_frame.columnconfigure(0, weight=1)
        new_principals_frame.columnconfigure(1, weight=1)

        # Left: new profiles
        np_frame = tk.LabelFrame(new_principals_frame, text="New Profiles",
                                 font=("Arial", 9, "bold"), bg=BG, fg=TITLE_BG, padx=6, pady=6)
        np_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        np_frame.columnconfigure(0, weight=1)

        self._new_profiles_lb = tk.Listbox(np_frame, height=5, font=("Arial", 9),
                                            selectmode="single", exportselection=False,
                                            bg="#FFFFFF", fg="#1C1C1E",
                                            selectbackground="#B5D5FF", selectforeground="#1C1C1E")
        self._new_profiles_lb.grid(row=0, column=0, sticky="ew")
        np_btn_row = tk.Frame(np_frame, bg=BG)
        np_btn_row.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        self._new_profile_entry = ttk.Entry(np_btn_row, font=("Arial", 9), width=28)
        self._new_profile_entry.pack(side="left", padx=(0, 4))
        self._new_profile_entry.bind("<Return>", lambda e: self._add_new_profile())
        ttk.Button(np_btn_row, text="Add", command=self._add_new_profile).pack(side="left")
        ttk.Button(np_btn_row, text="Remove",
                   command=lambda: self._remove_listbox_item(self._new_profiles_lb)
                   ).pack(side="left", padx=(4, 0))

        # Right: new perm sets
        nps_frame = tk.LabelFrame(new_principals_frame, text="New Permission Sets",
                                  font=("Arial", 9, "bold"), bg=BG, fg=TITLE_BG, padx=6, pady=6)
        nps_frame.grid(row=0, column=1, sticky="nsew")
        nps_frame.columnconfigure(0, weight=1)

        self._new_permsets_lb = tk.Listbox(nps_frame, height=5, font=("Arial", 9),
                                            selectmode="single", exportselection=False,
                                            bg="#FFFFFF", fg="#1C1C1E",
                                            selectbackground="#B5D5FF", selectforeground="#1C1C1E")
        self._new_permsets_lb.grid(row=0, column=0, sticky="ew")
        nps_btn_row = tk.Frame(nps_frame, bg=BG)
        nps_btn_row.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        self._new_permset_entry = ttk.Entry(nps_btn_row, font=("Arial", 9), width=28)
        self._new_permset_entry.pack(side="left", padx=(0, 4))
        self._new_permset_entry.bind("<Return>", lambda e: self._add_new_permset())
        ttk.Button(nps_btn_row, text="Add", command=self._add_new_permset).pack(side="left")
        ttk.Button(nps_btn_row, text="Remove",
                   command=lambda: self._remove_listbox_item(self._new_permsets_lb)
                   ).pack(side="left", padx=(4, 0))

        # ── Step 5: Output ─────────────────────────────────────────────────────
        self._section(content, "Step 5 — Choose Output File", row=10)
        out_row = tk.Frame(content, bg=BG)
        out_row.grid(row=11, column=0, sticky="ew", pady=(0, 6))
        self.output_var = tk.StringVar(value=str(Path.home() / "sf_fls_export.xlsx"))
        tk.Entry(out_row, textvariable=self.output_var, font=("Arial", 10), width=58,
                 bg="#FFFFFF", fg="#1C1C1E", insertbackground="#1C1C1E").pack(side="left")
        ttk.Button(out_row, text="📂 Browse", command=self._browse_output).pack(side="left", padx=(8, 0))

        # ── Log (collapsible) ──────────────────────────────────────────────────
        self._log_expanded = True
        log_hdr = tk.Frame(content, bg=BG)
        log_hdr.grid(row=12, column=0, sticky="ew", pady=(12, 0))
        tk.Frame(log_hdr, bg=BLUE, height=2).pack(fill="x", side="bottom")

        self._log_toggle_var = tk.StringVar(value="▼  Log")
        tk.Button(
            log_hdr,
            textvariable=self._log_toggle_var,
            font=("Arial", 10, "bold"), fg=TITLE_BG, bg=BG,
            bd=0, cursor="hand2", activebackground=BG, activeforeground=BLUE,
            command=self._toggle_log,
        ).pack(side="left")
        tk.Label(log_hdr, text="(click to collapse)",
                 font=("Arial", 8), fg="#999", bg=BG).pack(side="left", padx=6)

        self.log_box = scrolledtext.ScrolledText(
            content, height=10, font=("Courier", 9),
            state="disabled", bg="#1A1A2E", fg="#A0FFB0")
        self.log_box.grid(row=13, column=0, sticky="nsew")
        content.rowconfigure(13, weight=1)

    # ── SOQL Runner tab ───────────────────────────────────────────────────────
    def _build_soql_tab(self, parent):
        """Build the SOQL query executor tab."""
        # Two-column layout: main area (col 0) + history sidebar (col 1)
        parent.columnconfigure(0, weight=1)
        parent.columnconfigure(1, weight=0)   # history panel — fixed width
        parent.rowconfigure(0, weight=0)
        parent.rowconfigure(1, weight=1)   # editor
        parent.rowconfigure(3, weight=2)   # results grid

        # ── Toolbar ────────────────────────────────────────────────────────────
        toolbar = tk.Frame(parent, bg="#E8EFF5", bd=1, relief="ridge")
        toolbar.grid(row=0, column=0, sticky="ew", padx=18, pady=(12, 0))

        self._soql_run_btn = ttk.Button(toolbar, text="  ▶  Run Query  ",
                                        command=self._run_soql)
        self._soql_run_btn.pack(side="left", padx=(8, 12), pady=6)

        tk.Label(toolbar, text="Limit:", font=("Arial", 9), bg="#E8EFF5",
                 fg="#333333").pack(side="left")
        self._soql_limit_var = tk.StringVar(value="200")
        ttk.Spinbox(toolbar, from_=1, to=50000, textvariable=self._soql_limit_var,
                    width=7, font=("Arial", 9)).pack(side="left", padx=(2, 16))

        self._soql_status_var = tk.StringVar(value="")
        tk.Label(toolbar, textvariable=self._soql_status_var,
                 font=("Arial", 9), bg="#E8EFF5", fg="#555555").pack(side="left", padx=4)

        # Write Query / Explain / Export CSV moved to the history sidebar panel

        # ── Query editor ───────────────────────────────────────────────────────
        editor_frame = tk.Frame(parent, bg="#F5F5F5", bd=1, relief="sunken")
        editor_frame.grid(row=1, column=0, sticky="nsew", padx=18, pady=(4, 0))
        editor_frame.columnconfigure(1, weight=1)
        editor_frame.rowconfigure(0, weight=1)

        self._soql_linenums = tk.Text(
            editor_frame, width=3, state="disabled",
            font=("Courier", 11), bg="#E8E8E8", fg="#AAAAAA",
            bd=0, padx=4, pady=6, cursor="arrow",
        )
        self._soql_linenums.grid(row=0, column=0, sticky="ns")
        tk.Frame(editor_frame, bg="#DDDDDD", width=1).grid(row=0, column=1, sticky="ns")

        self._soql_editor = tk.Text(
            editor_frame,
            font=("Courier", 11), bg="#FFFFFF", fg="#1E1E1E",
            insertbackground="#333333", selectbackground="#B5D5FF",
            bd=0, padx=8, pady=6, undo=True, wrap="none", height=6,
        )
        soql_vsb = ttk.Scrollbar(editor_frame, orient="vertical",
                                  command=self._soql_editor.yview)
        soql_hsb = ttk.Scrollbar(editor_frame, orient="horizontal",
                                  command=self._soql_editor.xview)
        self._soql_editor.configure(yscrollcommand=soql_vsb.set,
                                     xscrollcommand=soql_hsb.set)
        self._soql_editor.grid(row=0, column=2, sticky="nsew")
        soql_vsb.grid(row=0, column=3, sticky="ns")
        soql_hsb.grid(row=1, column=2, sticky="ew")
        editor_frame.columnconfigure(2, weight=1)

        def _soql_update_linenums(event=None):
            self._soql_linenums.configure(state="normal")
            self._soql_linenums.delete("1.0", "end")
            lines = int(self._soql_editor.index("end-1c").split(".")[0])
            self._soql_linenums.insert("1.0", "\n".join(str(i) for i in range(1, lines + 1)))
            self._soql_linenums.configure(state="disabled")
        self._soql_editor.bind("<KeyRelease>", _soql_update_linenums)

        # Bind Cmd/Ctrl+Enter to run
        self._soql_editor.bind("<Command-Return>", lambda e: self._run_soql())
        self._soql_editor.bind("<Control-Return>", lambda e: self._run_soql())

        starter = "SELECT Id, Name FROM Account LIMIT 10"
        self._soql_editor.insert("1.0", starter)
        _soql_update_linenums()

        # ── Results area ───────────────────────────────────────────────────────
        results_label = tk.Frame(parent, bg=BG)
        results_label.grid(row=2, column=0, sticky="ew", padx=18, pady=(6, 0))
        tk.Label(results_label, text="Results", font=("Arial", 9, "bold"),
                 bg=BG, fg=TITLE_BG).pack(side="left")
        self._soql_row_count_var = tk.StringVar(value="")
        tk.Label(results_label, textvariable=self._soql_row_count_var,
                 font=("Arial", 9), bg=BG, fg="#555555").pack(side="left", padx=8)

        results_frame = tk.Frame(parent, bg=BG, bd=1, relief="sunken")
        results_frame.grid(row=3, column=0, sticky="nsew", padx=18, pady=(2, 12))
        results_frame.columnconfigure(0, weight=1)
        results_frame.rowconfigure(0, weight=1)

        self._soql_tree = ttk.Treeview(results_frame, show="headings",
                                        selectmode="browse")
        tree_vsb = ttk.Scrollbar(results_frame, orient="vertical",
                                   command=self._soql_tree.yview)
        tree_hsb = ttk.Scrollbar(results_frame, orient="horizontal",
                                   command=self._soql_tree.xview)
        self._soql_tree.configure(yscrollcommand=tree_vsb.set,
                                    xscrollcommand=tree_hsb.set)
        self._soql_tree.grid(row=0, column=0, sticky="nsew")
        tree_vsb.grid(row=0, column=1, sticky="ns")
        tree_hsb.grid(row=1, column=0, sticky="ew")

        # Store last results for CSV export / pagination
        self._soql_last_rows    = []
        self._soql_last_columns = []
        self._soql_page         = 0          # current 0-based page index
        self._soql_page_size    = 50         # rows per page

        # Double-click → record detail modal
        self._soql_tree.bind("<Double-1>", self._soql_on_row_dblclick)

        # ── Pagination bar (row=4) ─────────────────────────────────────────────
        self._soql_page_bar = tk.Frame(parent, bg=BG)
        self._soql_page_bar.grid(row=4, column=0, sticky="ew", padx=18, pady=(0, 6))
        self._soql_page_bar.grid_remove()   # hidden until results arrive

        self._soql_prev_btn = ttk.Button(self._soql_page_bar, text="◀  Prev",
                                          width=8, command=self._soql_page_prev)
        self._soql_prev_btn.pack(side="left")

        self._soql_page_label_var = tk.StringVar(value="")
        tk.Label(self._soql_page_bar, textvariable=self._soql_page_label_var,
                 font=("Arial", 9), bg=BG, fg="#555555", width=22, anchor="center"
                 ).pack(side="left", padx=8)

        self._soql_next_btn = ttk.Button(self._soql_page_bar, text="Next  ▶",
                                          width=8, command=self._soql_page_next)
        self._soql_next_btn.pack(side="left")

        # Page-size selector
        tk.Label(self._soql_page_bar, text="Rows/page:",
                 font=("Arial", 9), bg=BG, fg="#555555").pack(side="left", padx=(20, 4))
        self._soql_pagesize_var = tk.StringVar(value="50")
        ps_cb = ttk.Combobox(self._soql_page_bar, textvariable=self._soql_pagesize_var,
                              values=["25", "50", "100", "200"], width=5, state="readonly")
        ps_cb.pack(side="left")
        ps_cb.bind("<<ComboboxSelected>>", self._soql_on_pagesize_change)

        # ── Query History sidebar (col 1, all rows) ────────────────────────────
        self._soql_history_panel = tk.Frame(parent, bg="#F0F4F8", bd=1, relief="ridge", width=240)
        self._soql_history_panel.grid(row=0, column=1, rowspan=6, sticky="nsew",
                                       padx=(0, 18), pady=12)
        self._soql_history_panel.columnconfigure(0, weight=1)
        self._soql_history_panel.rowconfigure(1, weight=1)   # history list expands
        self._soql_history_panel.rowconfigure(3, weight=0)   # actions panel fixed
        self._soql_history_panel.grid_propagate(False)

        # ── Top: History header ───────────────────────────────────────────────
        hdr = tk.Frame(self._soql_history_panel, bg=TITLE_BG)
        hdr.grid(row=0, column=0, sticky="ew")
        tk.Label(hdr, text="  🕐 Query History", font=("Arial", 9, "bold"),
                 bg=TITLE_BG, fg="#FFFFFF", anchor="w", pady=5).pack(side="left", fill="x", expand=True)
        ttk.Button(hdr, text="Clear", width=5,
                   command=self._soql_history_clear).pack(side="right", padx=4, pady=3)

        # History list — top half
        hist_list_frame = tk.Frame(self._soql_history_panel, bg="#F0F4F8")
        hist_list_frame.grid(row=1, column=0, sticky="nsew")
        hist_list_frame.columnconfigure(0, weight=1)
        hist_list_frame.rowconfigure(0, weight=1)

        self._soql_hist_lb = tk.Listbox(
            hist_list_frame, font=("Arial", 8), activestyle="none",
            bg="#FFFFFF", fg="#1C1C1E", selectbackground="#B5D5FF",
            selectforeground="#1C1C1E", relief="flat", bd=0, cursor="hand2",
        )
        hist_vsb = ttk.Scrollbar(hist_list_frame, orient="vertical",
                                  command=self._soql_hist_lb.yview)
        self._soql_hist_lb.configure(yscrollcommand=hist_vsb.set)
        self._soql_hist_lb.grid(row=0, column=0, sticky="nsew")
        hist_vsb.grid(row=0, column=1, sticky="ns")
        self._soql_hist_lb.bind("<<ListboxSelect>>", self._soql_history_on_select)
        self._soql_hist_lb.bind("<Double-1>",        self._soql_history_on_run)

        tk.Label(self._soql_history_panel, text="click to load · double-click to run",
                 font=("Arial", 7, "italic"), bg="#F0F4F8", fg="#AAAAAA").grid(
            row=2, column=0, sticky="ew", pady=(2, 0))

        # ── Divider ───────────────────────────────────────────────────────────
        tk.Frame(self._soql_history_panel, bg="#C8D4E0", height=1).grid(
            row=3, column=0, sticky="ew", padx=6, pady=6)

        # ── Bottom: Claude actions panel ──────────────────────────────────────
        actions = tk.Frame(self._soql_history_panel, bg="#F0F4F8")
        actions.grid(row=4, column=0, sticky="ew", padx=8, pady=(0, 10))
        actions.columnconfigure(0, weight=1)

        tk.Label(actions, text="✨  Claude Actions", font=("Arial", 8, "bold"),
                 bg="#F0F4F8", fg=TITLE_BG, anchor="w").grid(
            row=0, column=0, sticky="w", pady=(0, 6))

        ttk.Button(actions, text="✨  Write Query",
                   command=lambda: self._claude_check_or_setup(self._soql_ask_claude)
                   ).grid(row=1, column=0, sticky="ew", pady=(0, 4))

        ttk.Button(actions, text="✨  Explain Results",
                   command=lambda: self._claude_check_or_setup(self._soql_explain)
                   ).grid(row=2, column=0, sticky="ew", pady=(0, 4))

        ttk.Button(actions, text="⬇  Export CSV",
                   command=self._soql_export_csv
                   ).grid(row=3, column=0, sticky="ew")

        # Internal store
        self._soql_hist_data = []
        self._soql_history_refresh()

    def _soql_history_refresh(self):
        """Reload history from DB and repopulate the listbox."""
        org = self._get_target_org() or ""
        self._soql_hist_data = _qh_load(org=org, limit=50)
        self._soql_hist_lb.delete(0, "end")
        for h in self._soql_hist_data:
            # One-line summary: truncate SOQL to fit sidebar width
            soql_oneline = " ".join(h["soql"].split())
            label = soql_oneline[:42] + "…" if len(soql_oneline) > 42 else soql_oneline
            ts    = h["ran_at"][5:16]   # MM-DD HH:MM
            rows  = h["row_count"]
            self._soql_hist_lb.insert("end", f"{ts}  [{rows}r]  {label}")

    def _soql_history_on_select(self, _event=None):
        """Load selected query into the editor (don't run it yet)."""
        sel = self._soql_hist_lb.curselection()
        if not sel:
            return
        h = self._soql_hist_data[sel[0]]
        self._soql_editor.delete("1.0", "end")
        self._soql_editor.insert("1.0", h["soql"])

    def _soql_history_on_run(self, _event=None):
        """Load selected query into editor and run it immediately."""
        self._soql_history_on_select()
        self._run_soql()

    def _soql_history_clear(self):
        if not messagebox.askyesno("Clear History",
                                    "Delete all saved query history for this org?"):
            return
        org = self._get_target_org() or ""
        _qh_clear(org=org)
        self._soql_history_refresh()

    def _soql_on_row_dblclick(self, event):
        """Open a record detail modal when the user double-clicks a result row."""
        item = self._soql_tree.identify_row(event.y)
        if not item:
            return
        cols = self._soql_last_columns
        if not cols:
            return
        # Map tree item index → absolute row index in full dataset
        children  = self._soql_tree.get_children()
        local_idx = list(children).index(item)
        abs_idx   = self._soql_page * self._soql_page_size + local_idx
        if abs_idx >= len(self._soql_last_rows):
            return
        record = self._soql_last_rows[abs_idx]
        self._soql_show_record_modal(record)

    def _soql_show_record_modal(self, record: dict):
        """Show a modal with all field→value pairs for a single record, plus Export CSV."""
        dlg = tk.Toplevel(self)
        dlg.title("Record Detail")
        dlg.resizable(True, True)
        dlg.grab_set()
        dlg.configure(bg=BG)
        dlg.geometry("620x520")
        dlg.minsize(480, 320)

        # ── Header ────────────────────────────────────────────────────────────
        hdr = tk.Frame(dlg, bg=TITLE_BG)
        hdr.pack(fill="x")
        # Use Id or first value as title
        record_id = record.get("Id") or record.get("id") or next(iter(record.values()), "")
        tk.Label(hdr, text=f"  {record_id}", font=("Arial", 10, "bold"),
                 bg=TITLE_BG, fg="#FFFFFF", anchor="w", pady=6).pack(side="left", fill="x", expand=True)

        # ── Scrollable field list ─────────────────────────────────────────────
        body = tk.Frame(dlg, bg=BG)
        body.pack(fill="both", expand=True, padx=0, pady=0)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)

        canvas = tk.Canvas(body, bg=BG, bd=0, highlightthickness=0)
        vsb    = ttk.Scrollbar(body, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=vsb.set)
        canvas.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")

        inner = tk.Frame(canvas, bg=BG)
        inner_win = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _on_inner_configure(e):
            canvas.configure(scrollregion=canvas.bbox("all"))
        def _on_canvas_configure(e):
            canvas.itemconfig(inner_win, width=e.width)

        inner.bind("<Configure>", _on_inner_configure)
        canvas.bind("<Configure>", _on_canvas_configure)

        # Mousewheel scroll
        def _on_mousewheel(e):
            canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)
        dlg.bind("<Destroy>", lambda e: canvas.unbind_all("<MouseWheel>"))

        # Two-column grid: Field | Value
        tk.Label(inner, text="Field", font=("Arial", 9, "bold"),
                 bg="#E8EFF5", fg="#1C1C1E", anchor="w", padx=10, pady=4,
                 relief="flat", bd=0).grid(row=0, column=0, sticky="ew", padx=(8,2), pady=(8,1))
        tk.Label(inner, text="Value", font=("Arial", 9, "bold"),
                 bg="#E8EFF5", fg="#1C1C1E", anchor="w", padx=10, pady=4,
                 relief="flat", bd=0).grid(row=0, column=1, sticky="ew", padx=(2,8), pady=(8,1))
        inner.columnconfigure(0, weight=1, uniform="col")
        inner.columnconfigure(1, weight=2, uniform="col")

        for i, (field, value) in enumerate(record.items()):
            row_bg = "#FFFFFF" if i % 2 == 0 else "#F4F8FC"
            tk.Label(inner, text=field, font=("Courier", 9),
                     bg=row_bg, fg="#555555", anchor="w", padx=10, pady=5,
                     wraplength=180).grid(row=i+1, column=0, sticky="ew", padx=(8,2), pady=0)
            val_str = str(value) if value is not None else ""
            tk.Label(inner, text=val_str, font=("Arial", 9),
                     bg=row_bg, fg="#1C1C1E", anchor="w", padx=10, pady=5,
                     wraplength=340, justify="left").grid(row=i+1, column=1, sticky="ew", padx=(2,8), pady=0)

        # ── Footer: Export CSV + Close ────────────────────────────────────────
        footer = tk.Frame(dlg, bg="#F0F4F8", bd=0)
        footer.pack(fill="x", side="bottom")
        tk.Frame(footer, bg="#D0D8E4", height=1).pack(fill="x")  # divider

        def _export_this_record():
            import csv
            path = filedialog.asksaveasfilename(
                parent=dlg,
                defaultextension=".csv",
                filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
                initialfile="record_export.csv",
            )
            if not path:
                return
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=list(record.keys()))
                writer.writeheader()
                writer.writerow(record)
            messagebox.showinfo("Exported", f"Record saved to:\n{Path(path).name}", parent=dlg)

        def _export_all_results():
            import csv
            if not self._soql_last_rows:
                return
            path = filedialog.asksaveasfilename(
                parent=dlg,
                defaultextension=".csv",
                filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
                initialfile="soql_results.csv",
            )
            if not path:
                return
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=self._soql_last_columns)
                writer.writeheader()
                writer.writerows(self._soql_last_rows)
            messagebox.showinfo("Exported",
                f"{len(self._soql_last_rows)} row(s) saved to:\n{Path(path).name}", parent=dlg)

        btn_frame = tk.Frame(footer, bg="#F0F4F8")
        btn_frame.pack(anchor="e", padx=14, pady=8)

        ttk.Button(btn_frame, text="⬇  Export This Record",
                   command=_export_this_record).pack(side="left", padx=(0, 6))
        ttk.Button(btn_frame, text=f"⬇  Export All {len(self._soql_last_rows)} Row(s)",
                   command=_export_all_results).pack(side="left", padx=(0, 6))
        ttk.Button(btn_frame, text="Close",
                   command=dlg.destroy).pack(side="left")

    def _run_soql(self):
        """Execute the SOQL query in the editor and display results."""
        org = self._get_target_org()
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return

        query = self._soql_editor.get("1.0", "end").strip()
        if not query:
            return

        # Append LIMIT if user hasn't written one and limit spinbox has a value
        limit_str = self._soql_limit_var.get().strip()
        if limit_str and "limit" not in query.lower():
            try:
                query += f" LIMIT {int(limit_str)}"
            except ValueError:
                pass

        self._app_spinner_start("Running query", btn=self._soql_run_btn)
        self._soql_status_var.set("Running…")
        self._soql_row_count_var.set("")

        def _work(target_org=org, q=query):
            try:
                data    = _sf("data", "query", "--query", q,
                               "--target-org", target_org)
                records = data.get("result", {}).get("records", [])
                # Flatten: remove Salesforce metadata keys starting with "attributes"
                def _flatten(rec, prefix=""):
                    out = {}
                    for k, v in rec.items():
                        if k == "attributes":
                            continue
                        full_key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
                        if isinstance(v, dict):
                            out.update(_flatten(v, full_key))
                        else:
                            out[full_key] = "" if v is None else str(v)
                    return out
                flat = [_flatten(r) for r in records]
                # Preserve column order from first record
                cols = list(flat[0].keys()) if flat else []
                # Save to query history (fire-and-forget)
                threading.Thread(
                    target=_qh_save,
                    args=(target_org, q, len(flat)),
                    daemon=True,
                ).start()
                self.after(0, lambda c=cols, f=flat: self._soql_show_results(c, f))
                self.after(0, self._soql_history_refresh)
            except Exception as e:
                self.after(0, lambda err=str(e): self._soql_show_error(err))

        threading.Thread(target=_work, daemon=True).start()

    def _soql_show_results(self, cols, rows):
        self._app_spinner_stop(btn=self._soql_run_btn)
        self._soql_last_columns = cols
        self._soql_last_rows    = rows
        self._soql_page         = 0
        try:
            self._soql_page_size = int(self._soql_pagesize_var.get())
        except Exception:
            self._soql_page_size = 50

        # Rebuild treeview column headers (done once; rows rendered per-page)
        self._soql_tree.configure(columns=cols)
        for col in cols:
            self._soql_tree.heading(col, text=col)
            self._soql_tree.column(col, width=120, minwidth=60, stretch=True)

        self._soql_render_page()

        n = len(rows)
        self._soql_row_count_var.set(f"{n} row(s)")
        self._soql_status_var.set(f"✅ {n} row(s) returned")

    def _soql_render_page(self):
        """Populate the Treeview with the current page slice and update pagination bar."""
        cols     = self._soql_last_columns
        rows     = self._soql_last_rows
        ps       = self._soql_page_size
        page     = self._soql_page
        total    = len(rows)
        n_pages  = max(1, -(-total // ps))   # ceil division

        start = page * ps
        end   = min(start + ps, total)
        page_rows = rows[start:end]

        self._soql_tree.delete(*self._soql_tree.get_children())
        for row in page_rows:
            self._soql_tree.insert("", "end", values=[row.get(c, "") for c in cols])

        # Pagination bar — show only when more than one page
        if n_pages > 1:
            self._soql_page_bar.grid()
            self._soql_page_label_var.set(
                f"Page {page + 1} of {n_pages}  ({start + 1}–{end} of {total})")
            self._soql_prev_btn.configure(state="normal" if page > 0 else "disabled")
            self._soql_next_btn.configure(state="normal" if page < n_pages - 1 else "disabled")
        else:
            self._soql_page_bar.grid_remove()

    def _soql_page_prev(self):
        if self._soql_page > 0:
            self._soql_page -= 1
            self._soql_render_page()

    def _soql_page_next(self):
        ps      = self._soql_page_size
        n_pages = max(1, -(-len(self._soql_last_rows) // ps))
        if self._soql_page < n_pages - 1:
            self._soql_page += 1
            self._soql_render_page()

    def _soql_on_pagesize_change(self, _event=None):
        try:
            self._soql_page_size = int(self._soql_pagesize_var.get())
        except Exception:
            self._soql_page_size = 50
        self._soql_page = 0
        self._soql_render_page()

    def _soql_show_error(self, msg):
        self._app_spinner_stop(btn=self._soql_run_btn)
        self._soql_status_var.set(f"❌ {msg[:120]}")
        self._soql_tree.configure(columns=("error",))
        self._soql_tree.heading("error", text="Error")
        self._soql_tree.column("error", width=800)
        self._soql_tree.delete(*self._soql_tree.get_children())
        self._soql_tree.insert("", "end", values=(msg,))
        self._soql_row_count_var.set("")

    def _soql_export_csv(self):
        """Save last query results to a CSV file."""
        if not self._soql_last_columns:
            messagebox.showinfo("No Results", "Run a query first.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile="soql_results.csv",
        )
        if not path:
            return
        import csv
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=self._soql_last_columns)
            writer.writeheader()
            writer.writerows(self._soql_last_rows)
        self._soql_status_var.set(f"✅ Exported to {Path(path).name}")

    # ── Apex Runner tab ────────────────────────────────────────────────────────
    def _build_apex_tab(self, parent):
        """Build the Anonymous Apex executor tab."""
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(1, weight=3)   # editor
        parent.rowconfigure(3, weight=2)   # output

        # ── Org row (mirrors FLS tab org selector) ─────────────────────────────
        org_bar = tk.Frame(parent, bg=BG)
        org_bar.grid(row=0, column=0, sticky="ew", padx=18, pady=(10, 4))
        tk.Label(org_bar, text="Target Org:", font=("Arial", 10), bg=BG).pack(side="left")
        tk.Label(org_bar, text="(uses same org selected on FLS Exporter tab)",
                 font=("Arial", 9), fg="#777", bg=BG).pack(side="left", padx=8)

        # ── Code editor ────────────────────────────────────────────────────────
        editor_frame = tk.Frame(parent, bg="#F5F5F5", bd=1, relief="sunken")
        editor_frame.grid(row=1, column=0, sticky="nsew", padx=18, pady=(0, 0))
        editor_frame.columnconfigure(1, weight=1)
        editor_frame.rowconfigure(0, weight=1)

        # Line-number gutter + text widget side by side
        self._apex_linenums = tk.Text(
            editor_frame, width=3, state="disabled",
            font=("Courier", 11), bg="#E8E8E8", fg="#AAAAAA",
            bd=0, padx=4, pady=6, cursor="arrow",
        )
        self._apex_linenums.grid(row=0, column=0, sticky="ns")

        # Thin separator between gutter and editor
        tk.Frame(editor_frame, bg="#DDDDDD", width=1).grid(row=0, column=1, sticky="ns")

        self._apex_editor = tk.Text(
            editor_frame,
            font=("Courier", 11), bg="#FFFFFF", fg="#1E1E1E",
            insertbackground="#333333", selectbackground="#B5D5FF",
            bd=0, padx=8, pady=6, undo=True, wrap="none",
        )
        apex_vsb = ttk.Scrollbar(editor_frame, orient="vertical",
                                 command=self._apex_editor.yview)
        apex_hsb = ttk.Scrollbar(editor_frame, orient="horizontal",
                                 command=self._apex_editor.xview)
        self._apex_editor.configure(yscrollcommand=apex_vsb.set,
                                    xscrollcommand=apex_hsb.set)
        self._apex_editor.grid(row=0, column=2, sticky="nsew")
        apex_vsb.grid(row=0, column=3, sticky="ns")
        apex_hsb.grid(row=1, column=2, sticky="ew")
        editor_frame.columnconfigure(2, weight=1)

        # Sync line numbers on key/scroll
        def _update_linenums(event=None):
            self._apex_linenums.configure(state="normal")
            self._apex_linenums.delete("1.0", "end")
            lines = int(self._apex_editor.index("end-1c").split(".")[0])
            self._apex_linenums.insert("1.0", "\n".join(str(i) for i in range(1, lines + 1)))
            self._apex_linenums.configure(state="disabled")
        self._apex_editor.bind("<KeyRelease>", _update_linenums)
        self._apex_editor.bind("<MouseWheel>", _update_linenums)

        # Seed with a useful starter snippet (no trailing newline to avoid phantom line)
        starter = (
            "// Anonymous Apex — executed in the context of the logged-in user\n"
            "// System.debug() output appears in the Logs panel below.\n\n"
            "System.debug('Hello from Apex!');"
        )
        self._apex_editor.insert("1.0", starter)
        _update_linenums()

        # ── Debug-level toolbar ────────────────────────────────────────────────
        # Two-row toolbar: dropdowns on top, Execute + status on bottom
        toolbar_outer = tk.Frame(parent, bg="#E8EFF5", bd=1, relief="ridge")
        toolbar_outer.grid(row=2, column=0, sticky="ew", padx=18, pady=(2, 0))

        # Row 1: debug level dropdowns
        toolbar = tk.Frame(toolbar_outer, bg="#E8EFF5", padx=8, pady=4)
        toolbar.pack(fill="x")

        DEBUG_LEVELS = ["None", "Error", "Warn", "Info", "Debug", "Fine", "Finer", "Finest"]

        def _make_debug_picker(label, default, parent_frame):
            tk.Label(parent_frame, text=label, font=("Arial", 9), bg="#E8EFF5",
                     fg="#333333").pack(side="left", padx=(8, 2))
            var = tk.StringVar(value=default)
            cb = ttk.Combobox(parent_frame, textvariable=var, values=DEBUG_LEVELS,
                              width=7, state="readonly", font=("Arial", 9))
            cb.pack(side="left")
            return var

        self._dbg_db        = _make_debug_picker("Db",         "Info",  toolbar)
        self._dbg_workflow  = _make_debug_picker("Workflow",   "Debug", toolbar)
        self._dbg_validation= _make_debug_picker("Validation", "None",  toolbar)
        self._dbg_callout   = _make_debug_picker("Callouts",   "None",  toolbar)
        self._dbg_apex_code = _make_debug_picker("Apex Code",  "Debug", toolbar)
        self._dbg_profiling = _make_debug_picker("Profiling",  "None",  toolbar)

        # Row 2: Execute button + status indicators
        action_row = tk.Frame(toolbar_outer, bg="#E8EFF5")
        action_row.pack(fill="x", padx=8, pady=(0, 6))

        self._apex_run_btn = ttk.Button(action_row, text="  ▶  Execute  ",
                                        command=self._run_apex)
        self._apex_run_btn.pack(side="left", padx=(0, 8))
        ttk.Button(action_row, text="✨ Write Apex",
                   command=lambda: self._claude_check_or_setup(self._apex_ask_claude)
                   ).pack(side="left", padx=(0, 16))

        self._apex_compiled_var = tk.StringVar(value="Compiled  —")
        self._apex_executed_var = tk.StringVar(value="Executed  —")
        tk.Label(action_row, textvariable=self._apex_compiled_var,
                 font=("Arial", 9), bg="#E8EFF5", fg="#555555").pack(side="left", padx=(0, 14))
        tk.Label(action_row, textvariable=self._apex_executed_var,
                 font=("Arial", 9), bg="#E8EFF5", fg="#555555").pack(side="left")

        # ── Output pane (Results left | Logs right) ────────────────────────────
        output_frame = tk.Frame(parent, bg=BG)
        output_frame.grid(row=3, column=0, sticky="nsew", padx=18, pady=(4, 12))
        output_frame.columnconfigure(0, weight=1)
        output_frame.columnconfigure(1, weight=2)
        output_frame.rowconfigure(1, weight=1)

        # Left: Results
        tk.Label(output_frame, text="Results", font=("Arial", 9, "bold"),
                 bg=BG, fg=TITLE_BG, anchor="w").grid(row=0, column=0, sticky="w", pady=(0, 2))
        self._apex_results = scrolledtext.ScrolledText(
            output_frame, height=12, font=("Courier", 9),
            state="disabled", bg="#F8F8F8", fg="#222222",
            bd=1, relief="sunken",
        )
        self._apex_results.grid(row=1, column=0, sticky="nsew", padx=(0, 6))

        # Right: Logs
        tk.Label(output_frame, text="Debug Log", font=("Arial", 9, "bold"),
                 bg=BG, fg=TITLE_BG, anchor="w").grid(row=0, column=1, sticky="w", pady=(0, 2))
        self._apex_logs = scrolledtext.ScrolledText(
            output_frame, height=12, font=("Courier", 9),
            state="disabled", bg="#1A1A2E", fg="#A0FFB0",
            bd=1, relief="sunken",
        )
        self._apex_logs.grid(row=1, column=1, sticky="nsew")

    # ── Apex execution ────────────────────────────────────────────────────────
    def _run_apex(self):
        org = self._get_target_org()
        if not org:
            messagebox.showwarning("No Org", "Select an org on the FLS Exporter tab first.")
            return

        code = self._apex_editor.get("1.0", "end-1c").strip()
        if not code:
            messagebox.showwarning("Empty", "Enter some Apex code first.")
            return

        self._app_spinner_start("Executing Apex", btn=self._apex_run_btn)
        self._apex_compiled_var.set("Compiled  …")
        self._apex_executed_var.set("Executed  …")
        self._apex_write_results("")
        self._apex_write_log("")
        self._set_status("Executing Apex…")

        def _work(target_org=org, apex=code):
            try:
                success, logs, error = run_apex_anonymous(target_org, apex)

                def _ui():
                    self._app_spinner_stop(btn=self._apex_run_btn)
                    if success:
                        self._apex_compiled_var.set("Compiled  ✓")
                        self._apex_executed_var.set("Executed  ✓")
                        self._apex_write_results("✅  Execution successful.")
                        self._set_status("✅  Apex executed successfully.")
                    else:
                        compiled_ok = not error.startswith("Compile error")
                        self._apex_compiled_var.set(f"Compiled  {'✓' if compiled_ok else '✗'}")
                        self._apex_executed_var.set("Executed  ✗")
                        self._apex_write_results(f"❌  Error:\n\n{error}")
                        self._set_status("❌  Apex execution failed — see Results.")
                    if logs:
                        self._apex_write_log(logs)
                self.after(0, _ui)
            except Exception as e:
                def _err():
                    self._app_spinner_stop(btn=self._apex_run_btn)
                    self._apex_compiled_var.set("Compiled  ✗")
                    self._apex_executed_var.set("Executed  ✗")
                    self._apex_write_results(f"❌  CLI error:\n\n{e}")
                    self._set_status("❌  Apex CLI error — see Results.")
                self.after(0, _err)

        threading.Thread(target=_work, daemon=True).start()

    def _apex_write_results(self, text):
        self._apex_results.configure(state="normal")
        self._apex_results.delete("1.0", "end")
        self._apex_results.insert("1.0", text)
        self._apex_results.configure(state="disabled")

    def _apex_write_log(self, text):
        self._apex_logs.configure(state="normal")
        self._apex_logs.delete("1.0", "end")
        self._apex_logs.insert("1.0", text)
        self._apex_logs.see("end")
        self._apex_logs.configure(state="disabled")

    # ── Settings dialog ───────────────────────────────────────────────────────
    def _open_settings(self):
        cfg = _load_claude_config()
        dlg = tk.Toplevel(self)
        dlg.title("Settings")
        dlg.resizable(False, False)
        dlg.grab_set()
        dlg.configure(bg="#F0F4F8")

        pad = {"padx": 14, "pady": 6}
        # Force light colors on all inputs regardless of OS theme
        ENTRY_BG, ENTRY_FG = "#FFFFFF", "#1C1C1E"
        LBL_BG = "#F0F4F8"

        tk.Label(dlg, text="Claude / AI Settings", font=("Arial", 12, "bold"),
                 bg=LBL_BG, fg=TITLE_BG).grid(row=0, column=0, columnspan=2, sticky="w", **pad)

        tk.Label(dlg, text="API Key:", font=("Arial", 10), bg=LBL_BG, fg="#1C1C1E").grid(
            row=1, column=0, sticky="e", padx=(14, 4), pady=4)
        api_var = tk.StringVar(value=cfg.get("api_key", ""))
        api_entry = tk.Entry(dlg, textvariable=api_var, width=48, show="*",
                             font=("Arial", 10), bg=ENTRY_BG, fg=ENTRY_FG,
                             insertbackground=ENTRY_FG, relief="solid", bd=1)
        api_entry.grid(row=1, column=1, sticky="ew", padx=(0, 14), pady=4)

        tk.Label(dlg, text="Gateway URL\n(leave blank for\napi.anthropic.com):",
                 font=("Arial", 10), bg=LBL_BG, fg="#1C1C1E", justify="right").grid(
            row=2, column=0, sticky="e", padx=(14, 4), pady=4)
        url_var = tk.StringVar(value=cfg.get("base_url", ""))
        tk.Entry(dlg, textvariable=url_var, width=48, font=("Arial", 10),
                 bg=ENTRY_BG, fg=ENTRY_FG, insertbackground=ENTRY_FG,
                 relief="solid", bd=1).grid(
            row=2, column=1, sticky="ew", padx=(0, 14), pady=4)

        tk.Label(dlg, text="Model:", font=("Arial", 10), bg=LBL_BG, fg="#1C1C1E").grid(
            row=3, column=0, sticky="e", padx=(14, 4), pady=4)
        model_var = tk.StringVar(value=cfg.get("model", _CLAUDE_MODEL))
        tk.Entry(dlg, textvariable=model_var, width=48, font=("Arial", 10),
                 bg=ENTRY_BG, fg=ENTRY_FG, insertbackground=ENTRY_FG,
                 relief="solid", bd=1).grid(
            row=3, column=1, sticky="ew", padx=(0, 14), pady=4)

        status_var = tk.StringVar(value="")
        tk.Label(dlg, textvariable=status_var, font=("Arial", 9), bg=LBL_BG,
                 fg="#2E75B6", wraplength=380).grid(
            row=4, column=0, columnspan=2, sticky="w", padx=14)

        def _test():
            _save_claude_config({"api_key": api_var.get().strip(),
                                  "base_url": url_var.get().strip(),
                                  "model": model_var.get().strip()})
            client, err = _get_claude_client()
            if err:
                status_var.set(f"❌ {err}")
                return
            status_var.set("Testing…")
            def _work():
                try:
                    m = cfg.get("model", model_var.get().strip()) or _CLAUDE_MODEL
                    resp = client.messages.create(
                        model=m, max_tokens=20,
                        messages=[{"role": "user", "content": "Reply with just: OK"}])
                    self.after(0, lambda: status_var.set("✅ Connected successfully!"))
                except Exception as e:
                    self.after(0, lambda err=str(e): status_var.set(f"❌ {err[:120]}"))
            threading.Thread(target=_work, daemon=True).start()

        def _save():
            _save_claude_config({"api_key": api_var.get().strip(),
                                  "base_url": url_var.get().strip(),
                                  "model": model_var.get().strip()})
            dlg.destroy()

        btn_row = tk.Frame(dlg, bg=BG)
        btn_row.grid(row=5, column=0, columnspan=2, pady=(4, 12), padx=14, sticky="e")
        ttk.Button(btn_row, text="Test Connection", command=_test).pack(side="left", padx=(0, 8))
        ttk.Button(btn_row, text="Save", command=_save).pack(side="left", padx=(0, 4))
        ttk.Button(btn_row, text="Cancel", command=dlg.destroy).pack(side="left")

        dlg.wait_window()

    # ── Claude helpers ────────────────────────────────────────────────────────
    def _claude_ask(self, system: str, user: str, on_result, on_error):
        """Run a Claude API call in a background thread.
        on_result(text) and on_error(msg) are called on the main thread.
        """
        client, err = _get_claude_client()
        if err:
            self.after(0, lambda: on_error(err))
            return
        cfg   = _load_claude_config()
        model = cfg.get("model", _CLAUDE_MODEL) or _CLAUDE_MODEL

        def _work():
            try:
                resp = client.messages.create(
                    model=model, max_tokens=2048,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                text = resp.content[0].text
                self.after(0, lambda: on_result(text))
            except Exception as e:
                self.after(0, lambda err=str(e): on_error(err))

        threading.Thread(target=_work, daemon=True).start()

    def _soql_ask_claude(self):
        """Switch to Claude tab with a Write Query prompt pre-loaded, using full RAG pipeline."""
        # Get any current editor content as context hint
        current = self._soql_editor.get("1.0", "end").strip()
        hint = f"\n\nCurrent editor content for reference:\n```sql\n{current}\n```" if current else ""

        prompt = (
            "I want to write a SOQL query. "
            "Please ask me which object I want to query, then use the available objects "
            f"from this org to find the best match.{hint}"
        )
        # Pre-load into Claude tab input and switch
        self._notebook.select(3)
        self.after(100, lambda: self._claude_prefill_and_send(prompt))

    def _soql_explain(self):
        """Inject query + results into Claude tab and switch to it for a plain-language explanation."""
        if not self._soql_last_columns:
            messagebox.showinfo("No Results", "Run a query first.")
            return
        cols  = self._soql_last_columns
        rows  = self._soql_last_rows[:50]
        table_lines = ["\t".join(cols)]
        for r in rows:
            table_lines.append("\t".join(r.get(c, "") for c in cols))
        table_text = "\n".join(table_lines)
        query_text = self._soql_editor.get("1.0", "end").strip()
        n_total    = len(self._soql_last_rows)

        prompt = (
            f"Please explain these SOQL results in plain English. "
            f"Highlight anything interesting or worth acting on.\n\n"
            f"**Query:**\n```sql\n{query_text}\n```\n\n"
            f"**Results** ({min(50, n_total)} of {n_total} rows shown, tab-delimited):\n"
            f"```\n{table_text}\n```"
        )
        self._notebook.select(3)
        self.after(100, lambda: self._claude_prefill_and_send(prompt))

    # ── Claude Assistant tab ──────────────────────────────────────────────────
    def _build_claude_tab(self, parent):
        """Show setup screen or chat UI depending on whether Claude is configured."""
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(0, weight=1)
        self._claude_tab_parent = parent
        client, _ = _get_claude_client()
        if client is None:
            self._build_claude_setup_screen(parent)
        else:
            self._build_claude_chat_ui(parent)

    def _build_claude_setup_screen(self, parent):
        """Welcome / authorisation screen shown before Claude is configured."""
        for w in parent.winfo_children():
            w.destroy()

        center = tk.Frame(parent, bg=BG)
        center.place(relx=0.5, rely=0.5, anchor="center")

        tk.Label(center, text="🤖", font=("Arial", 48), bg=BG).pack(pady=(0, 8))
        tk.Label(center, text="Claude AI Assistant",
                 font=("Arial", 18, "bold"), bg=BG, fg=TITLE_BG).pack()
        tk.Label(center,
                 text="Connect Claude to write SOQL queries, generate Apex code,\n"
                      "explain results, and answer Salesforce questions.",
                 font=("Arial", 11), bg=BG, fg="#555555", justify="center").pack(pady=(8, 24))

        ttk.Button(center, text="  🔑  Set Up Claude  ",
                   command=self._claude_setup_flow).pack(ipadx=8, ipady=4)

        tk.Label(center,
                 text="Requires an Anthropic API key or a compatible gateway URL.",
                 font=("Arial", 9, "italic"), bg=BG, fg="#AAAAAA").pack(pady=(12, 0))

    def _claude_setup_flow(self, then=None):
        """Open settings dialog; if successful, rebuild the Claude tab as chat UI.
        Optional `then` callable is invoked after successful setup.
        """
        self._open_settings()
        client, err = _get_claude_client()
        if client is not None:
            self._build_claude_chat_ui(self._claude_tab_parent)
            if then:
                then()
        # If still not configured, setup screen stays visible

    def _claude_check_or_setup(self, action):
        """If Claude is configured run action(); otherwise open setup flow first."""
        client, _ = _get_claude_client()
        if client is not None:
            action()
        else:
            self._claude_setup_flow(then=action)

    def _build_claude_chat_ui(self, parent):
        """Full chat interface with Claude."""
        for w in parent.winfo_children():
            w.destroy()
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(0, weight=1)

        # Main pane: history on top, input on bottom
        pane = tk.Frame(parent, bg=BG)
        pane.pack(fill="both", expand=True, padx=18, pady=12)
        pane.columnconfigure(0, weight=1)
        pane.rowconfigure(0, weight=1)

        # Chat history
        self._claude_history = scrolledtext.ScrolledText(
            pane, wrap="word", font=("Arial", 10),
            state="disabled", bd=1, relief="sunken",
            bg="#FAFAFA",
        )
        self._claude_history.grid(row=0, column=0, sticky="nsew", pady=(0, 8))
        self._claude_history.tag_config("user",    foreground="#1A56A0", font=("Arial", 10, "bold"))
        self._claude_history.tag_config("claude",  foreground="#1E1E1E", font=("Arial", 10))
        self._claude_history.tag_config("error",   foreground="#CC0000", font=("Arial", 10))
        self._claude_history.tag_config("label",   foreground="#888888", font=("Arial", 9, "italic"))

        # Input area
        input_frame = tk.Frame(pane, bg=BG)
        input_frame.grid(row=1, column=0, sticky="ew")
        input_frame.columnconfigure(0, weight=1)

        self._claude_input = tk.Text(input_frame, height=4, font=("Arial", 10),
                                      wrap="word", bd=1, relief="sunken",
                                      bg="#FFFFFF", fg="#1E1E1E",
                                      insertbackground="#333333")
        self._claude_input.grid(row=0, column=0, sticky="ew", pady=(0, 4))
        self._claude_input.bind("<Command-Return>", lambda e: self._claude_send())
        self._claude_input.bind("<Control-Return>", lambda e: self._claude_send())

        btn_row = tk.Frame(input_frame, bg=BG)
        btn_row.grid(row=1, column=0, sticky="ew")

        self._claude_send_btn = ttk.Button(btn_row, text="  ▶  Send  (⌘↩)",
                                            command=self._claude_send)
        self._claude_send_btn.pack(side="left")
        ttk.Button(btn_row, text="Clear Chat", command=self._claude_clear).pack(
            side="left", padx=(8, 0))

        # Context helpers
        ttk.Button(btn_row, text="+ Add SOQL Results",
                   command=self._claude_add_soql_context).pack(side="left", padx=(16, 0))
        ttk.Button(btn_row, text="+ Add Apex Code",
                   command=self._claude_add_apex_context).pack(side="left", padx=(8, 0))
        ttk.Button(btn_row, text="+ Add Object Context",
                   command=self._claude_add_object_context).pack(side="left", padx=(8, 0))

        tk.Label(btn_row, text="⌘↩ to send",
                 font=("Arial", 9, "italic"), bg=BG, fg="#AAAAAA").pack(side="right")

        # Internal message history for API calls
        self._claude_messages = []
        self._claude_system = (
            "You are an expert Salesforce developer and administrator assistant embedded in the "
            "FLS Explorer desktop tool. You help with SOQL queries, Apex code, Profile/Permission "
            "Set configuration, Field Level Security, and general Salesforce best practices.\n\n"
            "When the user asks you to help build a SOQL query or work with a specific object:\n"
            "1. Check the Live App Context section (injected below) for available objects and fields.\n"
            "2. If the user's intent matches exactly one object, emit [SELECT_OBJECT: ApiName] to "
            "auto-select it in the UI and load its fields.\n"
            "3. If multiple objects could match, list them and ask the user to clarify.\n"
            "4. Once fields are loaded, write the SOQL query using the exact API field names.\n\n"
            "Be concise and practical. When writing SOQL or Apex, use code blocks."
        )

    def _claude_toast(self, msg: str, duration_ms: int = 0, style: str = "info"):
        """
        Show a centered floating toast over the Claude chat history.
        style: "info" | "success" | "loading"
        duration_ms: auto-dismiss after this many ms (0 = stay until dismissed manually).
        Returns the toast frame so caller can destroy it early.
        """
        # Dismiss any existing toast first
        existing = getattr(self, "_claude_toast_frame", None)
        if existing:
            try:
                existing.destroy()
            except Exception:
                pass
            self._claude_toast_frame = None

        if not msg:
            return None

        colors = {
            "info":    ("#2E75B6", "#FFFFFF"),
            "success": ("#1A7A4A", "#FFFFFF"),
            "loading": ("#555555", "#FFFFFF"),
        }
        bg_color, fg_color = colors.get(style, colors["info"])

        icons = {"loading": "⏳", "success": "✅", "info": "ℹ️"}
        icon  = icons.get(style, "ℹ️")

        # Place over the chat history widget
        parent = self._claude_history.master   # the pane frame

        toast = tk.Frame(parent, bg=bg_color, padx=18, pady=10,
                         relief="flat", bd=0)

        tk.Label(toast, text=f"{icon}  {msg}",
                 font=("Arial", 10, "bold"), bg=bg_color, fg=fg_color,
                 wraplength=380, justify="center").pack()

        # Center it using place — anchored to the middle of the parent
        toast.place(relx=0.5, rely=0.42, anchor="center")
        toast.lift()

        self._claude_toast_frame = toast

        if duration_ms > 0:
            self.after(duration_ms, lambda: self._claude_toast(""))

        return toast

    # ── Claude thinking spinner ───────────────────────────────────────────────

    # ── Shared app-level ora spinner ─────────────────────────────────────────
    # One reusable component — any tab calls _app_spinner_start(msg, btn)
    # and _app_spinner_stop(btn) to show the centred toast and disable/restore
    # the triggering button without touching its label text.

    _ORA_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")

    def _app_spinner_start(self, msg: str, btn=None):
        """Show centred ora spinner toast. Optionally disable a button."""
        # Cancel any existing spinner
        self._app_spinner_stop()

        self._app_spinner_active = True
        self._app_spinner_job    = None
        self._app_spinner_btn    = btn

        if btn:
            try:
                btn.configure(state="disabled")
            except Exception:
                pass

        # Pick the right toast parent: Claude tab has _claude_history, others use self
        parent = getattr(self, "_claude_history", None)
        if parent and self._notebook.index(self._notebook.select()) == 3:
            self._claude_toast(f"⠋  {msg}", style="loading")
            _update_lbl = lambda text: self._claude_toast_frame.winfo_children()[0].configure(text=text) \
                if getattr(self, "_claude_toast_frame", None) and \
                   self._claude_toast_frame.winfo_exists() and \
                   self._claude_toast_frame.winfo_children() else None
        else:
            # Generic centred overlay on the root window
            existing = getattr(self, "_app_spinner_frame", None)
            if existing:
                try: existing.destroy()
                except Exception: pass
            frame = tk.Frame(self, bg="#444444", padx=20, pady=12)
            lbl   = tk.Label(frame, text=f"⠋  {msg}",
                             font=("Arial", 11, "bold"), bg="#444444", fg="#FFFFFF")
            lbl.pack()
            frame.place(relx=0.5, rely=0.5, anchor="center")
            frame.lift()
            self._app_spinner_frame = frame
            _update_lbl = lambda text: lbl.configure(text=text)

        def _spin(step=0):
            if not getattr(self, "_app_spinner_active", False):
                return
            try:
                frame_char = self._ORA_FRAMES[step % len(self._ORA_FRAMES)]
                _update_lbl(f"{frame_char}  {msg}")
                self._app_spinner_job = self.after(80, lambda: _spin(step + 1))
            except Exception:
                pass

        self.after(80, lambda: _spin(1))

    def _app_spinner_stop(self, btn=None):
        """Dismiss the ora spinner and restore button state."""
        self._app_spinner_active = False
        if getattr(self, "_app_spinner_job", None):
            try: self.after_cancel(self._app_spinner_job)
            except Exception: pass
            self._app_spinner_job = None

        # Dismiss toast (Claude tab) or overlay frame (other tabs)
        try:
            self._claude_toast("")
        except Exception:
            pass
        frame = getattr(self, "_app_spinner_frame", None)
        if frame:
            try: frame.destroy()
            except Exception: pass
            self._app_spinner_frame = None

        # Restore whichever button was passed (or the one stored at start time)
        target_btn = btn or getattr(self, "_app_spinner_btn", None)
        if target_btn:
            try: target_btn.configure(state="normal")
            except Exception: pass
            self._app_spinner_btn = None

    # ── Claude-tab convenience wrappers (keep existing call sites working) ──

    def _claude_thinking_start(self):
        self._app_spinner_start("Claude is thinking",
                                btn=getattr(self, "_claude_send_btn", None))

    def _claude_thinking_stop(self):
        self._app_spinner_stop(btn=getattr(self, "_claude_send_btn", None))

    def _claude_append(self, role: str, text: str):
        """Append a message to the chat history widget."""
        self._claude_history.configure(state="normal")
        if role == "user":
            self._claude_history.insert("end", "You\n", "user")
        elif role == "claude":
            self._claude_history.insert("end", "Claude\n", "label")
        elif role == "error":
            self._claude_history.insert("end", "Error\n", "label")
        tag = role if role in ("user", "claude", "error") else "claude"
        self._claude_history.insert("end", text + "\n\n", tag)
        self._claude_history.see("end")
        self._claude_history.configure(state="disabled")

    def _claude_clear(self):
        self._claude_messages = []
        self._claude_history.configure(state="normal")
        self._claude_history.delete("1.0", "end")
        self._claude_history.configure(state="disabled")

    def _claude_prefill_and_send(self, prompt: str):
        """Pre-fill the Claude chat input with prompt and send immediately."""
        try:
            self._claude_input.delete("1.0", "end")
            self._claude_input.insert("1.0", prompt)
            self._claude_send()
        except Exception:
            pass

    def _claude_send(self):
        text = self._claude_input.get("1.0", "end").strip()
        if not text:
            return
        self._claude_input.delete("1.0", "end")
        self._claude_append("user", text)
        self._claude_messages.append({"role": "user", "content": text})
        self._claude_thinking_start()

        client, err = _get_claude_client()
        if err:
            self._claude_append("error", err)
            self._claude_thinking_stop()
            return

        cfg   = _load_claude_config()
        model = cfg.get("model", _CLAUDE_MODEL) or _CLAUDE_MODEL
        msgs  = list(self._claude_messages)   # snapshot

        # Build enriched system prompt with live app context
        context_snapshot = self._get_app_context_snapshot()
        all_objs = getattr(self, "_all_objects", {})   # {api: label}
        if context_snapshot.strip():
            # Emit a flat, numbered list of EXACT api names so Claude can't hallucinate
            obj_lines = "\n".join(
                f"  {i+1}. {api} ({lbl})"
                for i, (api, lbl) in enumerate(sorted(all_objs.items()))
            ) or "  (none loaded yet)"
            enriched_system = (
                self._claude_system
                + "\n\n---\n"
                + "## Live App Context (FLS Explorer state)\n"
                + context_snapshot
                + "\n\n---\n"
                + "## EXACT object API names available (use ONLY these)\n"
                + obj_lines
                + "\n\n---\n"
                + "## How to select an object in the UI\n"
                + "When the user asks you to select or work with an object:\n"
                + "1. Fuzzy-match the user's description against the EXACT API names listed above.\n"
                + "2. If exactly one object clearly matches, emit this tag on its own line:\n"
                + "   [SELECT_OBJECT: ExactApiName]\n"
                + "   where ExactApiName is copied VERBATIM from the numbered list above.\n"
                + "3. If zero or multiple objects could match, list the candidates by number "
                + "and ask the user which one they mean. Do NOT emit the tag until confirmed.\n"
                + "4. NEVER invent or guess an API name. Only use names from the list above."
            )
        else:
            enriched_system = self._claude_system

        def _work():
            try:
                resp = client.messages.create(
                    model=model, max_tokens=4096,
                    system=enriched_system,
                    messages=msgs,
                )
                reply = resp.content[0].text
                self._claude_messages.append({"role": "assistant", "content": reply})
                self.after(0, lambda r=reply: self._claude_append("claude", r))
                self.after(0, lambda r=reply: self._claude_execute_action(r))
            except Exception as e:
                self.after(0, lambda err=str(e): self._claude_append("error", err))
            finally:
                self.after(0, self._claude_thinking_stop)

        threading.Thread(target=_work, daemon=True).start()

    def _claude_add_soql_context(self):
        """Paste the last SOQL query + results into the input box as context."""
        if not self._soql_last_columns:
            messagebox.showinfo("No Results", "Run a SOQL query first.")
            return
        cols = self._soql_last_columns
        rows = self._soql_last_rows[:20]
        lines = ["\t".join(cols)]
        for r in rows:
            lines.append("\t".join(r.get(c, "") for c in cols))
        query = self._soql_editor.get("1.0", "end").strip()
        snippet = f"SOQL Query:\n```\n{query}\n```\n\nResults (first {len(rows)} rows):\n```\n" + "\n".join(lines) + "\n```\n\n"
        self._claude_input.insert("end", snippet)
        self._notebook.select(3)   # switch to Claude tab
        self._claude_input.focus()

    # ── RAG helpers: expose app state to Claude ───────────────────────────────

    def _get_app_context_snapshot(self) -> str:
        """Return a compact text snapshot of loaded objects & fields for Claude's system prompt."""
        import json
        all_objs = getattr(self, "_all_objects", {})   # {api: label}
        obj_fields = getattr(self, "_object_fields", {})  # {api: {label, fields}}

        lines = []
        org = self._get_target_org() or "unknown"
        lines.append(f"# Salesforce Org: {org}")
        lines.append(f"# {len(all_objs)} objects loaded in FLS Explorer.\n")

        if all_objs:
            lines.append("## Available Objects (API Name → Label)")
            for api, lbl in sorted(all_objs.items()):
                detail = " [fields loaded]" if api in obj_fields else ""
                lines.append(f"  - {api}: {lbl}{detail}")
            lines.append("")

        if obj_fields:
            lines.append("## Field Details (for objects with fields loaded)")
            for obj_api, data in sorted(obj_fields.items()):
                fields = data.get("fields", [])
                obj_lbl = data.get("label", obj_api)
                lines.append(f"\n### {obj_api} ({obj_lbl}) — {len(fields)} fields")
                for f in fields:
                    fname  = f.get("name", "")
                    flabel = f.get("label", fname)
                    ftype  = f.get("type", "")
                    lines.append(f"  - {fname} ({flabel}) [{ftype}]")

        return "\n".join(lines)

    def _claude_add_object_context(self):
        """Inject the current object/field inventory into the Claude chat input."""
        snapshot = self._get_app_context_snapshot()
        if not getattr(self, "_all_objects", {}):
            messagebox.showinfo("No Data", "Load objects first (Step 2 → Load Objects).")
            return
        snippet = (
            "Here is my current Salesforce org context from the FLS Explorer:\n\n"
            f"```\n{snapshot}\n```\n\n"
        )
        self._claude_input.insert("end", snippet)
        self._claude_input.focus()

    def _fuzzy_match_object(self, name: str) -> tuple:
        """
        Given a potentially wrong/hallucinated API name, find the best match in _all_objects.
        Returns (matched_api, score) or (None, 0) if nothing close enough.
        Score: 1.0 = exact, 0.8+ = strong match, below 0.5 = ignored.
        """
        all_objs = getattr(self, "_all_objects", {})
        if not all_objs:
            return None, 0.0

        name_lower = name.lower().replace("_", "")

        best_api, best_score = None, 0.0
        for api, lbl in all_objs.items():
            api_lower = api.lower().replace("_", "")
            lbl_lower = lbl.lower().replace("_", " ").replace("  ", " ")

            # Exact match
            if api == name:
                return api, 1.0

            # Case-insensitive exact
            if api_lower == name_lower:
                best_api, best_score = api, 0.95
                continue

            # Substring match: name is contained in api or vice versa
            score = 0.0
            if name_lower in api_lower:
                score = max(score, 0.8 * len(name_lower) / len(api_lower))
            if api_lower in name_lower:
                score = max(score, 0.8 * len(api_lower) / len(name_lower))

            # Token overlap: split on _ and count shared tokens
            name_tokens = set(name.lower().split("_"))
            api_tokens  = set(api.lower().split("_"))
            overlap = len(name_tokens & api_tokens)
            if overlap:
                token_score = overlap / max(len(name_tokens), len(api_tokens))
                score = max(score, token_score * 0.75)

            if score > best_score:
                best_api, best_score = api, score

        return (best_api, best_score) if best_score >= 0.5 else (None, 0.0)

    def _claude_execute_action(self, reply: str):
        """
        Parse Claude's reply for structured action tags and execute them in the UI.
        Supported tags:
          [SELECT_OBJECT: ApiName]  — selects the object in the list & loads fields
        If ApiName isn't exact, fuzzy-match it against the loaded object list.
        """
        import re

        # SELECT_OBJECT
        m = re.search(r"\[SELECT_OBJECT:\s*([A-Za-z0-9_]+)\]", reply)
        if not m:
            return

        raw_name = m.group(1)
        all_objs = getattr(self, "_all_objects", {})

        # Determine actual API name to use
        if raw_name in all_objs:
            # Exact hit — proceed directly
            self._claude_select_object(raw_name)
        else:
            matched, score = self._fuzzy_match_object(raw_name)
            if matched and score >= 0.5:
                # Fuzzy hit — ask for confirmation before acting
                self._claude_confirm_object(raw_name, matched)
            else:
                self._claude_append("claude",
                    f"⚠️ I couldn't find an object matching '{raw_name}' in the loaded list. "
                    f"Make sure you've loaded objects first (Step 2 → Load Objects), then ask again.")

    def _claude_confirm_object(self, guessed: str, matched: str):
        """Show an inline confirmation widget: 'Did you mean X? [Yes] [No]'"""
        history = self._claude_history

        history.configure(state="normal")

        # Insert the question text
        history.insert("end", "Claude\n", "label")
        history.insert("end",
            f"I couldn't find '{guessed}' exactly. Did you mean:\n\n"
            f"  📦 {matched}\n\n",
            "claude")

        # Inline button frame embedded in the Text widget
        btn_frame = tk.Frame(history, bg="#F0F4F8", padx=6, pady=4)

        def _confirm():
            btn_frame.destroy()
            history.configure(state="normal")
            history.insert("end", f"✅ Yes — selecting {matched}\n\n", "claude")
            history.see("end")
            history.configure(state="disabled")
            self._claude_select_object(matched)

        def _deny():
            btn_frame.destroy()
            history.configure(state="normal")
            history.insert("end",
                "OK, I won't select it. Please clarify which object you meant.\n\n",
                "claude")
            history.see("end")
            history.configure(state="disabled")

        ttk.Button(btn_frame, text=f"✅  Yes, use {matched}",
                   command=_confirm).pack(side="left", padx=(0, 6))
        ttk.Button(btn_frame, text="✗  No, that's wrong",
                   command=_deny).pack(side="left")

        history.window_create("end", window=btn_frame)
        history.insert("end", "\n\n")
        history.see("end")
        history.configure(state="disabled")

    def _claude_select_object(self, api_name: str):
        """Select an object in the UI and kick off field loading."""
        found = self.obj_list.select_by_value(api_name)
        if found:
            # Only briefly flash to FLS tab if fields aren't already loaded —
            # otherwise stay on Claude tab so the query flow isn't interrupted
            already_loaded = bool(getattr(self, "_object_fields", {}).get(api_name))
            if not already_loaded:
                self._notebook.select(0)
                self.after(600, lambda: self._notebook.select(3))
            self._claude_append("claude",
                f"✅ Selected **{api_name}** in the Objects list. "
                f"Loading fields now — I'll let you know when ready.")
            org = self._get_target_org()
            if org and not already_loaded:
                self._load_fields_for_object(api_name, org)
        else:
            self._claude_append("claude",
                f"⚠️ Couldn't select '{api_name}' — it may not be visible in the list. "
                f"Try loading objects first (Step 2 → Load Objects).")

    def _load_fields_for_object(self, obj_name: str, org: str):
        """Load fields for a single object (called by Claude action handler)."""
        if not hasattr(self, "_object_fields"):
            self._object_fields = {}
        def _work():
            try:
                desc   = describe_object(org, obj_name)
                fields = [f for f in desc.get("fields", [])
                          if f.get("name", "").lower() != "id"]
                label  = desc.get("label", obj_name)
                self._object_fields[obj_name] = {"label": label, "fields": fields}
                # Re-populate field preview panel
                self.after(0, lambda: self._populate_field_preview(obj_name))

                # Build compact field list for Claude
                field_lines = "\n".join(
                    f"  {f.get('name')} ({f.get('label','')}) [{f.get('type','')}]"
                    for f in fields
                )
                field_summary = (
                    f"Fields loaded for {obj_name} ({len(fields)} total):\n{field_lines}"
                )

                def _notify():
                    self._notebook.select(3)
                    # Inject field list into Claude message history as a tool/system note
                    # so Claude can immediately write a proper query with real field names
                    self._claude_messages.append({
                        "role": "user",
                        "content": (
                            f"[System: Fields have finished loading for {obj_name}. "
                            f"Here are all {len(fields)} fields with their API names, "
                            f"labels, and types:\n\n{field_lines}\n\n"
                            f"Please now write the SOQL query the user originally asked for, "
                            f"using the exact API field names above.]"
                        )
                    })
                    # Show a brief notice in chat, then auto-trigger Claude to respond
                    self._claude_append("claude",
                        f"✅ {len(fields)} fields loaded for **{obj_name}**. Writing query…")
                    self._claude_thinking_start()

                    # Fire Claude automatically with the injected context
                    client, err = _get_claude_client()
                    if err:
                        self._claude_append("error", err)
                        self._claude_thinking_stop()
                        return

                    cfg   = _load_claude_config()
                    model = cfg.get("model", _CLAUDE_MODEL) or _CLAUDE_MODEL
                    msgs  = list(self._claude_messages)
                    all_objs = getattr(self, "_all_objects", {})
                    obj_lines = "\n".join(
                        f"  {i+1}. {api} ({lbl})"
                        for i, (api, lbl) in enumerate(sorted(all_objs.items()))
                    ) or "  (none loaded yet)"
                    system = (
                        self._claude_system
                        + "\n\n---\n## EXACT object API names available\n" + obj_lines
                        + "\n\n---\n## Field details for " + obj_name + "\n" + field_lines
                    )

                    def _auto_reply():
                        try:
                            resp  = client.messages.create(
                                model=model, max_tokens=4096,
                                system=system, messages=msgs)
                            reply = resp.content[0].text
                            self._claude_messages.append({"role": "assistant", "content": reply})
                            self.after(0, lambda r=reply: self._claude_append("claude", r))
                            self.after(0, lambda r=reply: self._claude_execute_action(r))
                        except Exception as e:
                            self.after(0, lambda err=str(e): self._claude_append("error", err))
                        finally:
                            self.after(0, self._claude_thinking_stop)

                    threading.Thread(target=_auto_reply, daemon=True).start()

                self.after(200, _notify)
            except Exception as e:
                self.after(0, lambda err=str(e): self._claude_append(
                    "error", f"Failed to load fields for {obj_name}: {err}"))
        threading.Thread(target=_work, daemon=True).start()

    def _apex_ask_claude(self):
        """Prompt user for a plain-English description, generate Apex code."""
        dlg = tk.Toplevel(self)
        dlg.title("✨ Write Apex with Claude")
        dlg.resizable(True, False)
        dlg.grab_set()
        dlg.configure(bg=BG)

        tk.Label(dlg, text="Describe what you want the Apex code to do:",
                 font=("Arial", 10), bg=BG).pack(anchor="w", padx=14, pady=(12, 2))
        desc_entry = tk.Text(dlg, height=3, font=("Arial", 10), wrap="word",
                              bd=1, relief="sunken")
        desc_entry.pack(fill="x", padx=14, pady=(0, 6))
        desc_entry.focus()

        status_var = tk.StringVar(value="")
        tk.Label(dlg, textvariable=status_var, font=("Arial", 9),
                 bg=BG, fg="#2E75B6").pack(anchor="w", padx=14)

        btn_row = tk.Frame(dlg, bg=BG)
        btn_row.pack(anchor="e", padx=14, pady=(6, 12))

        def _generate():
            desc = desc_entry.get("1.0", "end").strip()
            if not desc:
                return
            status_var.set("Generating…")
            gen_btn.configure(state="disabled")

            system = (
                "You are a Salesforce Apex expert. "
                "Return ONLY the raw anonymous Apex code with no explanation, "
                "no markdown fences, no commentary. "
                "The code must be valid anonymous Apex executable in Developer Console."
            )
            user = f"Write anonymous Apex code that: {desc}"

            def _ok(text):
                code = text.strip().strip("`").strip()
                if code.startswith("apex"):
                    code = code[4:].strip()
                self._apex_editor.delete("1.0", "end")
                self._apex_editor.insert("1.0", code)
                dlg.destroy()

            def _err(msg):
                status_var.set(f"❌ {msg[:100]}")
                gen_btn.configure(state="normal")

            self._claude_ask(system, user, _ok, _err)

        gen_btn = ttk.Button(btn_row, text="Generate", command=_generate)
        gen_btn.pack(side="left", padx=(0, 8))
        ttk.Button(btn_row, text="Cancel", command=dlg.destroy).pack(side="left")
        desc_entry.bind("<Command-Return>", lambda e: _generate())
        desc_entry.bind("<Control-Return>", lambda e: _generate())

    def _claude_add_apex_context(self):
        """Paste the current Apex code into the input box as context."""
        code = self._apex_editor.get("1.0", "end").strip()
        if not code:
            messagebox.showinfo("No Code", "Write some Apex code first.")
            return
        snippet = f"Apex Code:\n```apex\n{code}\n```\n\n"
        self._claude_input.insert("end", snippet)
        self._notebook.select(3)   # switch to Claude tab
        self._claude_input.focus()

    def _section(self, parent, text, row):
        tk.Label(parent, text=text, font=("Arial", 10, "bold"),
                 bg=BG, fg=TITLE_BG).grid(row=row, column=0, sticky="w", pady=(12, 0))
        tk.Frame(parent, bg=BLUE, height=2).grid(row=row, column=0, sticky="ew", pady=(28, 2))

    def _toggle_log(self):
        if self._log_expanded:
            self.log_box.grid_remove()
            self._log_toggle_var.set("▶  Log")
            self._log_expanded = False
        else:
            self.log_box.grid()
            self._log_toggle_var.set("▼  Log")
            self._log_expanded = True

    # ── Helpers ─────────────────────────────────────────────────────────────────
    def _log(self, msg):
        def _do():
            self.log_box.configure(state="normal")
            self.log_box.insert("end", msg + "\n")
            self.log_box.see("end")
            self.log_box.configure(state="disabled")
        self.after(0, _do)

    def _set_status(self, msg):
        self.after(0, lambda: self.status_var.set(msg))

    # ── Spinner (animates status bar while background work runs) ───────────────
    _SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def _spinner_start(self, label="Working"):
        self._spinner_running = True
        self._spinner_idx     = 0
        self._spinner_label   = label
        self._spinner_tick()

    def _spinner_tick(self):
        if not getattr(self, "_spinner_running", False):
            return
        frame = self._SPINNER_FRAMES[self._spinner_idx % len(self._SPINNER_FRAMES)]
        self.status_var.set(f"{frame}  {self._spinner_label}…")
        self._spinner_idx += 1
        self._spinner_after_id = self.after(120, self._spinner_tick)

    def _spinner_stop(self):
        self._spinner_running = False
        if hasattr(self, "_spinner_after_id"):
            self.after_cancel(self._spinner_after_id)

    # ── New principal helpers ───────────────────────────────────────────────
    def _add_new_profile(self):
        name = self._new_profile_entry.get().strip()
        if not name:
            return
        existing = list(self._new_profiles_lb.get(0, "end"))
        if name not in existing:
            self._new_profiles_lb.insert("end", name)
        self._new_profile_entry.delete(0, "end")

    def _add_new_permset(self):
        name = self._new_permset_entry.get().strip()
        if not name:
            return
        existing = list(self._new_permsets_lb.get(0, "end"))
        if name not in existing:
            self._new_permsets_lb.insert("end", name)
        self._new_permset_entry.delete(0, "end")

    def _remove_listbox_item(self, lb):
        sel = lb.curselection()
        if sel:
            lb.delete(sel[0])

    def _get_new_profile_cols(self):
        """Return list of new profile names from the Step 4 listbox."""
        return list(self._new_profiles_lb.get(0, "end"))

    def _get_new_permset_cols(self):
        """Return list of new perm set names from the Step 4 listbox."""
        return list(self._new_permsets_lb.get(0, "end"))

    def _browse_output(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=[("Excel Workbook", "*.xlsx")],
            initialfile="sf_fls_export.xlsx",
        )
        if path:
            self.output_var.set(path)

    def _get_target_org(self):
        idx = self.org_combo.current()
        if idx < 0 or not hasattr(self, "_orgs") or not self._orgs:
            return None
        alias, username, _ = self._orgs[idx]
        return alias or username

    # ── Data loaders ─────────────────────────────────────────────────────────
    def _load_orgs(self):
        self._log("Loading authenticated orgs…")
        def _work():
            try:
                orgs = list_orgs()
                items, default_idx = [], 0
                for i, (alias, username, is_default) in enumerate(orgs):
                    label = f"{alias} ({username})" if alias else username
                    items.append(label)
                    if is_default:
                        default_idx = i
                def _update():
                    # Remember what was selected before (if anything)
                    prev_username = None
                    if hasattr(self, "_orgs") and self._orgs:
                        prev_idx = self.org_combo.current()
                        if prev_idx >= 0:
                            prev_username = self._orgs[prev_idx][1]

                    self.org_combo["values"] = items
                    self._orgs = orgs

                    if not items:
                        self._log("⚠️  No authenticated orgs found. Run: sf org login web")
                        self._set_status("No orgs found.")
                        return

                    # Try to restore previous selection; otherwise use default
                    new_idx = default_idx
                    if prev_username:
                        for i, (a, u, d) in enumerate(orgs):
                            if u == prev_username:
                                new_idx = i
                                break
                    self.org_combo.current(new_idx)
                    self._log(f"✅ Found {len(items)} org(s). Selected: {items[new_idx]}")
                    self._set_status("Orgs loaded.")
                self.after(0, _update)
            except Exception as e:
                self._log(f"❌ Error loading orgs: {e}")
        threading.Thread(target=_work, daemon=True).start()

    def _load_objects(self):
        # Capture org NOW at click time — don't re-read the combo from the thread
        org = self._get_target_org()
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return
        self._log(f"Loading objects from {org}…")
        self._app_spinner_start("Loading objects", btn=self._load_obj_btn)
        self._spinner_start("Loading objects")

        def _work(target_org=org):
            try:
                cli = _find_sf_cli()
                self._log(f"   Using CLI: {cli}")
                self._log(f"   Querying EntityDefinition from {target_org} (paged)…")
                items = list_objects(target_org)   # [(api_name, label), ...]
                self._log(f"   Result count: {len(items)}")
                if items:
                    self._log(f"   First few: {[api for api, _ in items[:5]]}")
                display_items = [(f"{label}  ({api})", api) for api, label in items]
                def _update():
                    self._spinner_stop()
                    self._app_spinner_stop(btn=self._load_obj_btn)
                    if not display_items:
                        self._log("⚠️  No objects returned. The authenticated user may lack "
                                  "SObject metadata access. Ensure the org user is a System Admin "
                                  "or has the 'View Setup and Configuration' permission.")
                        self._set_status("⚠️  No objects returned — check log.")
                    else:
                        self.obj_list.set_items(display_items)
                        self._all_objects = {api: label for api, label in items}
                        self._log(f"✅ {len(display_items)} objects loaded.")
                        self._set_status(f"✅ {len(display_items)} objects loaded — select some, then click 'Load Fields'.")
                self.after(0, _update)
            except Exception as e:
                def _err():
                    self._spinner_stop()
                    self._app_spinner_stop(btn=self._load_obj_btn)
                    self._log(f"❌ Error loading objects:\n{e}")
                    self._set_status("❌ Object load failed — see log.")
                self.after(0, _err)

        threading.Thread(target=_work, daemon=True).start()

    def _claude_lazy_load_objects(self):
        """
        Silently load the object list in the background when the Claude tab is opened.
        Runs only once per org session (flag resets if org changes).
        Shows a subtle spinner in the Claude tab status bar; never blocks the UI.
        """
        org = self._get_target_org()
        if not org:
            return   # no org selected yet — nothing to load

        # Already loaded for this org — skip
        if self._claude_objects_loaded and getattr(self, "_all_objects", {}):
            return

        # Guard against concurrent loads
        if getattr(self, "_claude_objects_loading", False):
            return
        self._claude_objects_loading = True

        # Show loading toast with animated dots
        org_short = org.split("(")[0].strip() if "(" in org else org
        self._claude_toast(f"⠋  Loading objects from {org_short}", style="loading")
        self._claude_dots_job = None

        _ORA_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")

        def _animate_dots(step=0):
            try:
                if getattr(self, "_claude_objects_loading", False):
                    toast = getattr(self, "_claude_toast_frame", None)
                    if toast and toast.winfo_exists():
                        lbl = toast.winfo_children()
                        if lbl:
                            frame = _ORA_FRAMES[step % len(_ORA_FRAMES)]
                            lbl[0].configure(text=f"{frame}  Loading objects from {org_short}")
                    self._claude_dots_job = self.after(80, lambda: _animate_dots(step + 1))
            except Exception:
                pass

        self.after(80, lambda: _animate_dots(0))

        def _work(target_org=org):
            try:
                items = list_objects(target_org)   # [(api_name, label), ...]
                display_items = [(f"{label}  ({api})", api) for api, label in items]

                def _update():
                    # Stop dot animation
                    if getattr(self, "_claude_dots_job", None):
                        try:
                            self.after_cancel(self._claude_dots_job)
                        except Exception:
                            pass
                        self._claude_dots_job = None
                    self._claude_objects_loading = False

                    if display_items:
                        # Populate the FLS tab list too if not already loaded
                        if not getattr(self, "_all_objects", {}):
                            self.obj_list.set_items(display_items)
                        self._all_objects = {api: label for api, label in items}
                        self._claude_objects_loaded = True
                        self._claude_toast(
                            f"{len(items)} objects loaded from {org_short}",
                            duration_ms=3500, style="success")
                    else:
                        self._claude_toast(
                            f"No objects returned from {org_short}\nCheck org permissions.",
                            duration_ms=5000, style="info")
                self.after(0, _update)
            except Exception as e:
                def _err():
                    if getattr(self, "_claude_dots_job", None):
                        try:
                            self.after_cancel(self._claude_dots_job)
                        except Exception:
                            pass
                    self._claude_objects_loading = False
                    self._claude_toast(
                        f"Could not load objects\n{str(e)[:80]}",
                        duration_ms=6000, style="info")
                self.after(0, _err)

        threading.Thread(target=_work, daemon=True).start()

    def _show_preview(self):
        if not self._preview_visible:
            self._preview_frame.grid(row=1, column=1, sticky="nsew")
            self._preview_visible = True

    def _hide_preview(self):
        if self._preview_visible:
            self._preview_frame.grid_remove()
            self._preview_visible = False

    def _on_obj_select(self, event=None):
        """Populate the field preview panel when an object is clicked in the list."""
        selected = self.obj_list.get_selected_values()
        if not selected:
            self._hide_preview()
            self._field_tree.delete(*self._field_tree.get_children())
            return

        obj_name = selected[-1]   # show the last-clicked object

        # If already loaded, show immediately
        if hasattr(self, "_object_fields") and obj_name in self._object_fields:
            self._populate_field_preview(obj_name)
            return

        # Otherwise fetch on demand
        org = self._get_target_org()
        if not org:
            return

        self._preview_obj_var.set(f"⏳ Loading fields for {obj_name}…")
        self._field_tree.delete(*self._field_tree.get_children())
        self._show_preview()

        def _work(target_org=org, name=obj_name):
            try:
                desc   = describe_object(target_org, name)
                fields = [f for f in desc.get("fields", [])
                          if f.get("name", "").lower() != "id"]
                label  = desc.get("label", name)
                if not hasattr(self, "_object_fields"):
                    self._object_fields = {}
                self._object_fields[name] = {"label": label, "fields": fields}
                self.after(0, lambda n=name: self._populate_field_preview(n))
            except Exception as e:
                self.after(0, lambda: self._preview_obj_var.set(f"⚠️  Error: {e}"))

        threading.Thread(target=_work, daemon=True).start()

    def _populate_field_preview(self, obj_name):
        """Refresh the Treeview with fields for obj_name."""
        data   = self._object_fields.get(obj_name, {})
        label  = data.get("label", obj_name)
        fields = data.get("fields", [])
        self._preview_obj_var.set(f"🗂️  {label}  ({obj_name})  —  {len(fields)} fields")
        self._field_tree.delete(*self._field_tree.get_children())
        self._show_preview()
        for i, f in enumerate(sorted(fields, key=lambda x: x.get("label", ""))):
            tag = "even" if i % 2 == 0 else "odd"
            self._field_tree.insert("", "end", values=(
                f.get("label", ""),
                f.get("name", ""),
                f.get("type", ""),
            ), tags=(tag,))

    def _clear_objects_and_fields(self):
        """Clear the object list and all cached field data."""
        self.obj_list.set_items([])
        self._object_fields = {}
        self._all_objects   = {}
        self._fields_count_var.set("")
        self._set_status("Object list and field cache cleared.")
        self._log("🗑  Object list and field cache cleared.")

    def _load_fields_for_selected(self):
        org      = self._get_target_org()   # capture at click time
        selected = self.obj_list.get_selected_values()
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return
        if not selected:
            messagebox.showwarning("No Objects", "Select at least one object first.")
            return
        self._log(f"⏳ Loading fields for {len(selected)} object(s) from {org}…")
        self._spinner_start(f"Loading fields for {len(selected)} object(s)")
        if not hasattr(self, "_object_fields"):
            self._object_fields = {}

        def _work(target_org=org, objs=selected):
            total_fields = 0
            for i, obj_name in enumerate(objs, 1):
                self._log(f"   [{i}/{len(objs)}] Describing {obj_name}…")
                try:
                    desc   = describe_object(target_org, obj_name)
                    fields = [f for f in desc.get("fields", [])
                              if f.get("name", "").lower() != "id"]
                    label  = desc.get("label", obj_name)
                    self._object_fields[obj_name] = {"label": label, "fields": fields}
                    total_fields += len(fields)
                    self._log(f"      ✅ {len(fields)} fields")
                    # Refresh preview if this obj is the last-selected one
                    cur = self.obj_list.get_selected_values()
                    if cur and cur[-1] == obj_name:
                        self.after(0, lambda n=obj_name: self._populate_field_preview(n))
                except Exception as e:
                    self._log(f"      ⚠️  {e}")

            def _update():
                self._spinner_stop()
                loaded = len(self._object_fields)
                all_fields = sum(len(v.get("fields", [])) for v in self._object_fields.values())
                self._fields_count_var.set(
                    f"✅ {loaded} object(s) ready for export — {all_fields} fields total"
                )
                self._set_status(f"✅ Fields loaded for {loaded} object(s).")
            self.after(0, _update)

        threading.Thread(target=_work, daemon=True).start()

    def _load_profiles(self):
        org = self._get_target_org()   # capture at click time
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return
        self._log(f"Loading profiles from {org}…")
        def _work(target_org=org):
            try:
                profiles = list_profiles(target_org)
                def _update():
                    self.profile_list.set_items([(p, p) for p in profiles])
                    self._log(f"✅ Loaded {len(profiles)} profiles.")
                self.after(0, _update)
            except Exception as e:
                self._log(f"❌ Error: {e}")
        threading.Thread(target=_work, daemon=True).start()

    def _load_permsets(self):
        org = self._get_target_org()   # capture at click time
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return
        self._log(f"Loading permission sets from {org}…")
        def _work(target_org=org):
            try:
                permsets = list_permission_sets(target_org)
                def _update():
                    self.permset_list.set_items([(ps, ps) for ps in permsets])
                    self._log(f"✅ Loaded {len(permsets)} permission sets.")
                self.after(0, _update)
            except Exception as e:
                self._log(f"❌ Error: {e}")
        threading.Thread(target=_work, daemon=True).start()

    # ── Run ──────────────────────────────────────────────────────────────────
    def _run(self):
        org = self._get_target_org()
        if not org:
            messagebox.showwarning("No Org", "Select an org first.")
            return

        selected_obj_apis = self.obj_list.get_selected_values()
        if not selected_obj_apis:
            messagebox.showwarning("No Objects", "Select at least one object in Step 2.")
            return

        if len(selected_obj_apis) > MAX_EXPORT_OBJECTS:
            messagebox.showwarning(
                "Too Many Objects",
                f"You selected {len(selected_obj_apis)} objects.\n\n"
                f"The maximum per export run is {MAX_EXPORT_OBJECTS}.\n\n"
                f"Please deselect some objects and try again.\n"
                f"(You can change this limit by editing MAX_EXPORT_OBJECTS in the script.)"
            )
            return

        if not hasattr(self, "_object_fields"):
            self._object_fields = {}

        # Find any selected objects whose fields haven't been loaded yet
        missing = [api for api in selected_obj_apis if api not in self._object_fields]
        if missing:
            self._log(f"Fetching fields for {len(missing)} object(s) before export…")
            self._app_spinner_start(f"Fetching fields for {len(missing)} object(s)", btn=self.run_btn)
            self._spinner_start("Fetching fields")

            def _fetch_missing(target_org=org, objs=missing):
                for obj_name in objs:
                    try:
                        desc   = describe_object(target_org, obj_name)
                        fields = [f for f in desc.get("fields", [])
                                  if f.get("name", "").lower() != "id"]
                        label  = desc.get("label", obj_name)
                        self._object_fields[obj_name] = {"label": label, "fields": fields}
                        self._log(f"   ✅ {obj_name}: {len(fields)} fields")
                    except Exception as e:
                        self._log(f"   ⚠️  {obj_name}: {e}")
                        self._object_fields[obj_name] = {"label": obj_name, "fields": []}
                # Pass the captured list so we don't re-read the Listbox selection
                self.after(0, lambda: self._run_export(selected_obj_apis))

            threading.Thread(target=_fetch_missing, daemon=True).start()
            return   # _run_export will be called once fields are ready

        self._run_export(selected_obj_apis)

    def _run_export(self, selected_obj_apis=None):
        """Called after all selected objects have fields loaded."""
        org = self._get_target_org()
        if selected_obj_apis is None:
            selected_obj_apis = self.obj_list.get_selected_values()

        self._spinner_stop()

        # Build the objects list, logging field counts so we can verify
        selected_objects = []
        for api in selected_obj_apis:
            data   = self._object_fields.get(api, {})
            label  = data.get("label", api)
            fields = data.get("fields", [])
            self._log(f"   📦 {api}: {len(fields)} fields queued for export")
            if fields:
                selected_objects.append((api, label))
            else:
                self._log(f"      ⚠️  Skipping {api} — no fields loaded")

        if not selected_objects:
            self._app_spinner_stop(btn=self.run_btn)
            messagebox.showwarning("No Fields", "None of the selected objects have any fields. "
                                   "Try clicking an object first to load its fields.")
            return

        profiles = self.profile_list.get_selected_values()
        permsets = self.permset_list.get_selected_values()
        new_prof_cols   = self._get_new_profile_cols()
        new_ps_cols     = self._get_new_permset_cols()
        # Combined list of new column names (profiles first, then perm sets)
        all_new_cols    = new_prof_cols + new_ps_cols

        # Step 3 is optional — but always include at least one blank planning column
        if not profiles and not permsets and not all_new_cols:
            if not messagebox.askyesno(
                "No Profiles / Permission Sets Selected",
                "No Profiles or Permission Sets are selected (existing or new).\n\n"
                "The export will include a blank 'New Profile' planning column "
                "so you can start mapping access.\n\nContinue?",
            ):
                return
            # Auto-seed one blank column for planning
            all_new_cols = ["New Profile"]

        output_path = self.output_var.get().strip()
        if not output_path:
            messagebox.showwarning("No Output", "Choose an output file path in Step 5.")
            return

        self._app_spinner_start("Exporting", btn=self.run_btn)
        self._set_status("Export running — please wait…")
        self._spinner_start("Exporting")

        def _done(paths):
            def _ui():
                self._spinner_stop()
                self._app_spinner_stop(btn=self.run_btn)
                n = len(paths)
                folder = str(Path(paths[0]).parent) if paths else ""
                self._set_status(f"✅ Export complete — {n} file(s) saved to {folder}")
                if paths and messagebox.askyesno(
                    "Done!",
                    f"{n} workbook(s) saved to:\n{folder}\n\nOpen folder now?"
                ):
                    import platform
                    if platform.system() == "Darwin":
                        subprocess.run(["open", folder])
                    elif platform.system() == "Windows":
                        subprocess.run(["explorer", folder])
                    else:
                        subprocess.run(["xdg-open", folder])
            self.after(0, _ui)

        def _error(tb):
            def _ui():
                self._spinner_stop()
                self._app_spinner_stop(btn=self.run_btn)
                self._set_status("❌ Export failed — see log.")
                self._log(f"\n❌ FATAL ERROR:\n{tb}")
                messagebox.showerror("Export Failed", f"An error occurred:\n{tb[:400]}")
            self.after(0, _ui)

        if all_new_cols:
            self._log(f"   🆕 New columns: {', '.join(all_new_cols)}")

        threading.Thread(
            target=_fetch_with_preloaded,
            args=(org, selected_objects, self._object_fields, profiles, permsets,
                  output_path, self._log, _done, _error),
            kwargs={"new_profile_cols": all_new_cols},
            daemon=True,
        ).start()


def _fetch_with_preloaded(
    target_org, selected_objects, preloaded,
    selected_profiles, selected_permsets,
    output_path, log_fn, done_fn, error_fn,
    new_profile_cols=None,
):
    """Like fetch_and_export but uses already-described field data.

    Fetches ProfileLayout assignments per profile per object.
    PermSets do not have page layout assignments so no layout fetch for them.
    """
    try:
        objects_data = {}
        total = len(selected_objects)

        for i, (obj_name, obj_label) in enumerate(selected_objects, 1):
            log_fn(f"[{i}/{total}] Processing {obj_name}…")
            fields = preloaded.get(obj_name, {}).get("fields", [])
            if not fields:
                log_fn(f"   ⚠️  No fields — skipping.")
                continue

            obj_entry = {
                "label":    obj_label,
                "fields":   fields,
                "profiles": {},
                "permsets": {},
            }

            for prof in selected_profiles:
                log_fn(f"   👤 Profile: {prof}")
                try:
                    log_fn(f"      Fetching layout assignments…")
                    layout_assignments = get_profile_layout_assignments(target_org, prof, obj_name)
                    log_fn(f"      {len(layout_assignments)} layout assignment(s) found.")
                    obj_entry["profiles"][prof] = {
                        "obj_perms":          get_object_perms_for_profile(target_org, prof, obj_name),
                        "fls":                get_fls_for_profile(target_org, prof, obj_name),
                        "layout_assignments": layout_assignments,
                    }
                except Exception as e:
                    log_fn(f"      ⚠️  {e}")
                    obj_entry["profiles"][prof] = {"obj_perms": {}, "fls": {}, "layout_assignments": []}

            for ps in selected_permsets:
                log_fn(f"   🔑 PermSet: {ps}")
                try:
                    obj_entry["permsets"][ps] = {
                        "obj_perms": get_object_perms_for_permset(target_org, ps, obj_name),
                        "fls":       get_fls_for_permset(target_org, ps, obj_name),
                        # PermSets don't have page layout assignments
                    }
                except Exception as e:
                    log_fn(f"      ⚠️  {e}")
                    obj_entry["permsets"][ps] = {"obj_perms": {}, "fls": {}}

            objects_data[obj_name] = obj_entry

        log_fn("\n📊 Building Excel workbooks…")
        saved = build_excel(output_path, objects_data, selected_profiles, selected_permsets, log_fn,
                            new_profile_cols=new_profile_cols or [], target_org=target_org)
        done_fn(saved)

    except Exception:
        error_fn(traceback.format_exc())


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()
