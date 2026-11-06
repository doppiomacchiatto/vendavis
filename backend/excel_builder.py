"""
excel_builder.py — Excel workbook construction for sf_fls_exporter.

Requires: openpyxl, lxml (optional, for checkbox injection)
"""

import sys

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    print("openpyxl not found. Install with: pip install openpyxl")
    sys.exit(1)

from sf_cli import _get_record_types_fallback

# ── Style constants ────────────────────────────────────────────────────────────

HEADER_FILL  = PatternFill("solid", fgColor="1F4E79")
SUBHEAD_FILL = PatternFill("solid", fgColor="2E75B6")
OBJ_HDR_FILL = PatternFill("solid", fgColor="D6E4F0")
READ_FILL    = PatternFill("solid", fgColor="E2EFDA")
NONE_FILL    = PatternFill("solid", fgColor="FCE4D6")
BOTH_FILL    = PatternFill("solid", fgColor="C6EFCE")

WHITE_FONT  = Font(name="Arial", bold=True, color="FFFFFF", size=10)
BOLD_FONT   = Font(name="Arial", bold=True, size=10)
NORMAL_FONT = Font(name="Arial", size=9)
SMALL_FONT  = Font(name="Arial", size=8)

THIN_BORDER = Border(
    left=Side(style="thin"), right=Side(style="thin"),
    top=Side(style="thin"),  bottom=Side(style="thin"),
)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT   = Alignment(horizontal="left",   vertical="center", wrap_text=True)

CHECK = "✓"
DASH  = "—"

CHECK_FILL = PatternFill("solid", fgColor="C6EFCE")   # green  — permission granted
DASH_FILL  = PatternFill("solid", fgColor="FCE4D6")   # red/orange — not granted

NEW_PROFILE_HDR_FILL = PatternFill("solid", fgColor="E2EFDA")   # soft green header for new profiles
NEW_PROFILE_CB_FILL  = PatternFill("solid", fgColor="F0FFF0")   # very light green cell background


# ── Helpers ────────────────────────────────────────────────────────────────────

def _safe_sheet_name(name, used_names):
    """Return a unique, Excel-safe sheet name (max 31 chars)."""
    for ch in r'\/*?:[]':
        name = name.replace(ch, "_")
    name = name[:31]
    base, n = name, 1
    while name in used_names:
        suffix = f"_{n}"
        name = base[:31 - len(suffix)] + suffix
        n += 1
    used_names.add(name)
    return name


def _write_section_header(ws, row, col, text, total_cols, fill=None):
    """Write a bold section header spanning total_cols columns."""
    fill = fill or OBJ_HDR_FILL
    if total_cols > 1:
        ws.merge_cells(start_row=row, start_column=col,
                       end_row=row, end_column=col + total_cols - 1)
    c = ws.cell(row, col, text)
    c.font  = BOLD_FONT
    c.fill  = fill
    c.alignment = LEFT
    c.border = THIN_BORDER
    return row + 1


def _write_col_headers(ws, row, headers, start_col=1, fill=None):
    """Write a row of column header cells; return next row."""
    fill = fill or OBJ_HDR_FILL
    for i, h in enumerate(headers):
        c = ws.cell(row, start_col + i, h)
        c.font      = BOLD_FONT
        c.fill      = fill
        c.alignment = CENTER
        c.border    = THIN_BORDER
    return row + 1


def _check_cell(ws, row, col, value):
    """Write a ✓ or — access cell."""
    granted = bool(value)
    c = ws.cell(row, col, CHECK if granted else DASH)
    c.font      = NORMAL_FONT
    c.fill      = CHECK_FILL if granted else DASH_FILL
    c.alignment = CENTER
    c.border    = THIN_BORDER


# ── Checkbox injection ─────────────────────────────────────────────────────────

def _inject_checkboxes(xlsx_path, checkbox_cells):
    """Post-process an xlsx file to add native Excel 365 checkboxes.

    checkbox_cells: dict mapping sheet_name → list of (col_letter, row, checked)

    Falls back silently if lxml is not available.
    """
    try:
        from lxml import etree
    except ImportError:
        return

    import zipfile, io, xml.etree.ElementTree as ET

    CB_URI = "{7F270B02-E91A-4E3E-B976-1F9CBDE69BE7}"
    CB_NS  = "http://schemas.microsoft.com/office/spreadsheetml/2022/formmlfeatures"
    XL_NS  = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

    with zipfile.ZipFile(xlsx_path, "r") as zin:
        file_map  = {n: zin.read(n) for n in zin.namelist()}
        zip_infos = {n: zin.getinfo(n) for n in zin.namelist()}

    wb_rels_xml = file_map.get("xl/_rels/workbook.xml.rels", b"")
    wb_xml      = file_map.get("xl/workbook.xml", b"")

    rid_to_name = {}
    if wb_xml:
        root = ET.fromstring(wb_xml)
        for sh in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
            rid  = sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            name = sh.get("name", "")
            if rid:
                rid_to_name[rid] = name

    rid_to_path = {}
    if wb_rels_xml:
        root = ET.fromstring(wb_rels_xml)
        for rel in root.iter("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
            rid    = rel.get("Id", "")
            target = rel.get("Target", "")
            if target and not target.startswith("/"):
                target = "xl/" + target
            rid_to_path[rid] = target

    name_to_path = {rid_to_name[r]: rid_to_path[r]
                    for r in rid_to_name if r in rid_to_path}

    modified = False
    for sheet_name, cells in checkbox_cells.items():
        zip_path = name_to_path.get(sheet_name)
        if not zip_path or zip_path not in file_map:
            continue

        tree   = etree.fromstring(file_map[zip_path])
        extLst = tree.find(f"{{{XL_NS}}}extLst")
        if extLst is None:
            extLst = etree.SubElement(tree, f"{{{XL_NS}}}extLst")

        for col_letter, row_num, checked in cells:
            cell_ref = f"{col_letter}{row_num}"
            val      = "1" if checked else "0"
            ext_xml  = (
                f'<ext xmlns:xcf="{CB_NS}" uri="{CB_URI}">'
                f'<xcf:formmlFeatures>'
                f'<xcf:checkbox checked="{val}" linkedCell="{cell_ref}"/>'
                f'</xcf:formmlFeatures>'
                f'</ext>'
            )
            extLst.append(etree.fromstring(ext_xml))

        file_map[zip_path] = etree.tostring(
            tree, xml_declaration=True, encoding="UTF-8", standalone=True)
        modified = True

    if not modified:
        return

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in file_map.items():
            zout.writestr(zip_infos[name], data)
    buf.seek(0)
    with open(xlsx_path, "wb") as f:
        f.write(buf.read())


# ── Sheet builders ─────────────────────────────────────────────────────────────

def _build_principal_sheet(wb, used_names, obj_name, obj_label, ptype, pname,
                            obj_perms, fls_map, layout_assignments, fields,
                            new_profile_cols=None):
    """Build one sheet for a single principal × object combination.

    Returns (ws, checkbox_cells) where checkbox_cells is a list of
        (col_letter, row_num, checked=False) for post-processing by _inject_checkboxes.
    """
    new_profile_cols = new_profile_cols or []
    n_new   = len(new_profile_cols)
    FIXED   = 4                        # always 4 data columns (A–D)
    TOTAL_COLS = FIXED + n_new

    icon  = "👤" if ptype == "Profile" else "🔑"
    sname = _safe_sheet_name(f"{pname} — {obj_label}", used_names)
    ws    = wb.create_sheet(sname)
    ws.freeze_panes = "A2"

    checkbox_cells = []   # (col_letter, row_num, checked)

    # ── Page title row ──────────────────────────────────────────────────────
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=FIXED)
    title = ws.cell(1, 1, f"{icon} {pname}  |  {obj_label} ({obj_name})")
    title.font      = WHITE_FONT
    title.fill      = HEADER_FILL if ptype == "Profile" else SUBHEAD_FILL
    title.alignment = LEFT
    ws.row_dimensions[1].height = 22

    # ── New profile column headers (E, F, …) ────────────────────────────────
    if n_new:
        for i, npname in enumerate(new_profile_cols):
            col_idx = FIXED + 1 + i
            col_ltr = get_column_letter(col_idx)
            hc = ws.cell(1, col_idx, f"🆕 {npname}")
            hc.font      = Font(name="Arial", bold=True, color="FFFFFF", size=9)
            hc.fill      = PatternFill("solid", fgColor="1A7F37")
            hc.alignment = CENTER
            hc.border    = THIN_BORDER
            ws.column_dimensions[col_ltr].width = 16

    row = 2  # current write row

    def _new_profile_blank_cells(r):
        for i in range(n_new):
            col_idx = FIXED + 1 + i
            c = ws.cell(r, col_idx, "")
            c.border = THIN_BORDER

    def _new_profile_checkbox_cells(r):
        for i in range(n_new):
            col_idx = FIXED + 1 + i
            col_ltr = get_column_letter(col_idx)
            c = ws.cell(r, col_idx, False)
            c.fill      = NEW_PROFILE_CB_FILL
            c.alignment = CENTER
            c.border    = THIN_BORDER
            checkbox_cells.append((col_ltr, r, False))

    # ── SECTION 1: Record Types & Page Layout Assignments ───────────────────
    row = _write_section_header(ws, row, 1,
                                "Record Types & Page Layout Assignments",
                                TOTAL_COLS, OBJ_HDR_FILL)
    row = _write_col_headers(ws, row,
                             ["Record Type", "Page Layout", "Assigned", "Default"]
                             + new_profile_cols,
                             fill=OBJ_HDR_FILL)

    if layout_assignments:
        for rt in layout_assignments:
            rt_name     = rt.get("record_type_name", "")
            page_layout = rt.get("page_layout", "—")
            is_assigned = rt.get("is_assigned", False)
            is_default  = rt.get("is_default", False)

            ws.cell(row, 1, rt_name).font   = NORMAL_FONT
            ws.cell(row, 1).border          = THIN_BORDER
            pl_cell = ws.cell(row, 2, page_layout)
            pl_cell.font   = NORMAL_FONT
            pl_cell.border = THIN_BORDER
            _check_cell(ws, row, 3, is_assigned)
            _check_cell(ws, row, 4, is_default)
            _new_profile_checkbox_cells(row)
            row += 1
    elif ptype == "PermSet":
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=FIXED)
        note = ws.cell(row, 1, "Permission Sets do not have page layout assignments.")
        note.font   = SMALL_FONT
        note.fill   = PatternFill("solid", fgColor="F2F2F2")
        note.border = THIN_BORDER
        _new_profile_blank_cells(row)
        row += 1
    else:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=FIXED)
        no_rt = ws.cell(row, 1, "No record types / layout assignments found for this object.")
        no_rt.font  = SMALL_FONT
        no_rt.fill  = PatternFill("solid", fgColor="F2F2F2")
        no_rt.border = THIN_BORDER
        _new_profile_blank_cells(row)
        row += 1

    row += 1  # blank spacer

    # ── SECTION 2: Object Permissions ───────────────────────────────────────
    row = _write_section_header(ws, row, 1, "Object Permissions",
                                TOTAL_COLS, OBJ_HDR_FILL)
    row = _write_col_headers(ws, row,
                             ["Permission Name", "Enabled", "", ""] + new_profile_cols,
                             fill=OBJ_HDR_FILL)

    OBJ_PERM_ROWS = [
        ("Read",              "AllowRead"),
        ("Create",            "AllowCreate"),
        ("Edit",              "AllowEdit"),
        ("Delete",            "AllowDelete"),
        ("View All Records",  "ViewAllRecords"),
        ("Modify All Records","ModifyAllRecords"),
        ("View All Fields",   None),
    ]
    for perm_label, perm_key in OBJ_PERM_ROWS:
        if perm_key:
            granted = bool(obj_perms.get(perm_key, False))
        else:
            granted = bool(obj_perms.get("ViewAllRecords") or obj_perms.get("ModifyAllRecords"))

        ws.cell(row, 1, perm_label).font = NORMAL_FONT
        ws.cell(row, 1).border           = THIN_BORDER
        _check_cell(ws, row, 2, granted)
        for col in (3, 4):
            bc = ws.cell(row, col, "")
            bc.border = THIN_BORDER
        _new_profile_checkbox_cells(row)
        row += 1

    row += 1  # blank spacer

    # ── SECTION 3: Field Permissions ─────────────────────────────────────────
    row = _write_section_header(ws, row, 1, "Field Permissions",
                                TOTAL_COLS, OBJ_HDR_FILL)
    row = _write_col_headers(ws, row,
                             ["Field Label", "Field API Name", "Read Access", "Edit Access"]
                             + new_profile_cols,
                             fill=OBJ_HDR_FILL)

    for i, field in enumerate(sorted(fields, key=lambda f: f.get("label", ""))):
        fname    = field.get("name", "")
        flabel   = field.get("label", fname)
        fls      = fls_map.get(fname, {})
        readable = fls.get("readable", False)
        editable = fls.get("editable", False)

        row_fill = PatternFill("solid", fgColor="EAF2FB") if i % 2 == 0 else None

        for col, val in [(1, flabel), (2, fname)]:
            c        = ws.cell(row, col, val)
            c.font   = NORMAL_FONT
            c.border = THIN_BORDER
            if row_fill:
                c.fill = row_fill

        _check_cell(ws, row, 3, readable)
        _check_cell(ws, row, 4, editable)
        _new_profile_checkbox_cells(row)
        row += 1

    # ── Column widths ────────────────────────────────────────────────────────
    ws.column_dimensions["A"].width = 32
    ws.column_dimensions["B"].width = 32
    ws.column_dimensions["C"].width = 14
    ws.column_dimensions["D"].width = 14

    return ws, checkbox_cells


def _build_summary_sheet(wb, objects_data, all_principals):
    """Build the Summary sheet (cross-object object-permissions overview)."""
    ws_sum = wb.create_sheet("📋 Summary", 0)
    ws_sum.freeze_panes = "C3"

    OBJ_COLS    = 6
    START_COL   = 3
    ACCESS_KEYS = ["AllowRead", "AllowCreate", "AllowEdit", "AllowDelete",
                   "ViewAllRecords", "ModifyAllRecords"]

    for lbl, col_idx in [("Object Label", 1), ("API Name", 2)]:
        for r in (1, 2):
            c = ws_sum.cell(r, col_idx, lbl)
            c.font = BOLD_FONT; c.fill = OBJ_HDR_FILL
            c.alignment = CENTER; c.border = THIN_BORDER

    if not all_principals:
        ws_sum.cell(1, 3,
                    "ℹ️  No Profiles or Permission Sets selected — field inventory only."
                    ).font = NORMAL_FONT
    else:
        for idx, (ptype, pname) in enumerate(all_principals):
            col   = START_COL + idx * OBJ_COLS
            label = f"{'👤' if ptype == 'Profile' else '🔑'} {pname}"
            ws_sum.merge_cells(start_row=1, start_column=col,
                               end_row=1,   end_column=col + OBJ_COLS - 1)
            c      = ws_sum.cell(1, col, label)
            c.font = WHITE_FONT
            c.fill = HEADER_FILL if ptype == "Profile" else SUBHEAD_FILL
            c.alignment = CENTER
            for si, sh in enumerate(["Read", "Create", "Edit", "Delete", "Read All", "Mod All"]):
                sc = ws_sum.cell(2, col + si, sh)
                sc.font = BOLD_FONT; sc.fill = OBJ_HDR_FILL
                sc.alignment = CENTER; sc.border = THIN_BORDER

    for row_idx, (obj_name, obj_data) in enumerate(sorted(objects_data.items()), start=3):
        lbl_cell = ws_sum.cell(row_idx, 1, obj_data.get("label", obj_name))
        lbl_cell.font = NORMAL_FONT; lbl_cell.border = THIN_BORDER
        api_cell = ws_sum.cell(row_idx, 2, obj_name)
        api_cell.font = NORMAL_FONT; api_cell.border = THIN_BORDER

        for idx, (ptype, pname) in enumerate(all_principals):
            col   = START_COL + idx * OBJ_COLS
            perms = (obj_data.get("profiles" if ptype == "Profile" else "permsets", {})
                     .get(pname, {}).get("obj_perms", {}))
            for ki, key in enumerate(ACCESS_KEYS):
                val = CHECK if perms.get(key) else DASH
                c   = ws_sum.cell(row_idx, col + ki, val)
                c.font = NORMAL_FONT; c.alignment = CENTER; c.border = THIN_BORDER
                c.fill = CHECK_FILL if perms.get(key) else DASH_FILL

    ws_sum.column_dimensions["A"].width = 30
    ws_sum.column_dimensions["B"].width = 30
    for idx in range(len(all_principals)):
        col = START_COL + idx * OBJ_COLS
        for offset in range(OBJ_COLS):
            ws_sum.column_dimensions[get_column_letter(col + offset)].width = 9

    return ws_sum


def _build_fls_matrix_sheet(wb, obj_name, obj_data, all_principals):
    """Build a compact FLS matrix sheet: fields as rows, principals as column pairs (R/E)."""
    ws = wb.create_sheet(f"📊 {obj_name[:25]}")
    ws.freeze_panes = "C3"

    fields    = sorted(obj_data.get("fields", []), key=lambda f: f.get("label", ""))
    obj_label = obj_data.get("label", obj_name)

    # Row 1: principal group headers (merged over R+E pairs)
    ws.cell(1, 1, "Field Label").font      = BOLD_FONT
    ws.cell(1, 1).fill      = OBJ_HDR_FILL
    ws.cell(1, 1).border    = THIN_BORDER
    ws.cell(1, 1).alignment = CENTER
    ws.cell(1, 2, "API Name").font      = BOLD_FONT
    ws.cell(1, 2).fill      = OBJ_HDR_FILL
    ws.cell(1, 2).border    = THIN_BORDER
    ws.cell(1, 2).alignment = CENTER

    for idx, (ptype, pname) in enumerate(all_principals):
        col   = 3 + idx * 2
        label = f"{'👤' if ptype == 'Profile' else '🔑'} {pname}"
        ws.merge_cells(start_row=1, start_column=col, end_row=1, end_column=col + 1)
        c      = ws.cell(1, col, label)
        c.font = WHITE_FONT
        c.fill = HEADER_FILL if ptype == "Profile" else SUBHEAD_FILL
        c.alignment = CENTER
        c.border    = THIN_BORDER

    # Row 2: R / E sub-headers
    ws.cell(2, 1, "Field Label").font   = BOLD_FONT
    ws.cell(2, 1).fill   = OBJ_HDR_FILL
    ws.cell(2, 1).border = THIN_BORDER
    ws.cell(2, 2, "API Name").font   = BOLD_FONT
    ws.cell(2, 2).fill   = OBJ_HDR_FILL
    ws.cell(2, 2).border = THIN_BORDER
    for idx in range(len(all_principals)):
        col = 3 + idx * 2
        for offset, lbl in enumerate(["R", "E"]):
            c        = ws.cell(2, col + offset, lbl)
            c.font   = BOLD_FONT
            c.fill   = OBJ_HDR_FILL
            c.alignment = CENTER
            c.border = THIN_BORDER

    # Data rows
    for row_idx, field in enumerate(fields, start=3):
        fname  = field.get("name", "")
        flabel = field.get("label", fname)
        row_fill = PatternFill("solid", fgColor="EAF2FB") if row_idx % 2 == 0 else None

        for col, val in [(1, flabel), (2, fname)]:
            c        = ws.cell(row_idx, col, val)
            c.font   = NORMAL_FONT
            c.border = THIN_BORDER
            if row_fill:
                c.fill = row_fill

        for idx, (ptype, pname) in enumerate(all_principals):
            key   = "profiles" if ptype == "Profile" else "permsets"
            fls   = obj_data.get(key, {}).get(pname, {}).get("fls", {})
            fperm = fls.get(fname, {})
            col   = 3 + idx * 2
            _check_cell(ws, row_idx, col,     fperm.get("readable", False))
            _check_cell(ws, row_idx, col + 1, fperm.get("editable", False))

    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 30
    for idx in range(len(all_principals)):
        col = 3 + idx * 2
        for offset in range(2):
            ws.column_dimensions[get_column_letter(col + offset)].width = 5

    return ws


def _build_manifest_sheet(wb, objects_data):
    """📦 Manifest — one row per exported object: label, API name, field count."""
    ws = wb.create_sheet("📦 Manifest", 0)
    ws.freeze_panes = "A2"

    headers = ["Object Label", "API Name", "Field Count"]
    for col, h in enumerate(headers, 1):
        c           = ws.cell(1, col, h)
        c.font      = WHITE_FONT
        c.fill      = HEADER_FILL
        c.alignment = CENTER
        c.border    = THIN_BORDER

    for row_idx, (obj_name, obj_data) in enumerate(sorted(objects_data.items()), start=2):
        fields    = obj_data.get("fields", [])
        obj_label = obj_data.get("label", obj_name)
        row_fill  = PatternFill("solid", fgColor="EAF2FB") if row_idx % 2 == 0 else None

        for col, val in [(1, obj_label), (2, obj_name), (3, len(fields))]:
            c        = ws.cell(row_idx, col, val)
            c.font   = NORMAL_FONT
            c.border = THIN_BORDER
            c.alignment = LEFT if col < 3 else CENTER
            if row_fill:
                c.fill = row_fill

    ws.column_dimensions["A"].width = 35
    ws.column_dimensions["B"].width = 35
    ws.column_dimensions["C"].width = 14
    return ws


def _build_record_types_sheet(wb, obj_name, obj_data, target_org=None):
    """📋 Record Types — active record types for this object."""
    obj_label = obj_data.get("label", obj_name)

    # Try to pull record types from the describe result first
    record_type_infos = obj_data.get("recordTypeInfos", [])

    # Fall back to sf_cli if not already in obj_data
    if not record_type_infos and target_org:
        try:
            from sf_cli import _get_record_types_fallback
            rt_list = _get_record_types_fallback(target_org, obj_name)
            record_type_infos = [
                {
                    "name":      rt.get("record_type_name", ""),
                    "developerName": rt.get("record_type_name", ""),
                    "active":    True,
                    "master":    rt.get("record_type_name") == "--Master--",
                    "defaultRecordTypeMapping": rt.get("is_default", False),
                }
                for rt in rt_list
            ]
        except Exception:
            record_type_infos = []

    ws = wb.create_sheet(f"🏷 {obj_label[:25]} RT")

    headers = ["Name", "Developer Name", "Active", "Master", "Default"]
    for col, h in enumerate(headers, 1):
        c           = ws.cell(1, col, h)
        c.font      = WHITE_FONT
        c.fill      = SUBHEAD_FILL
        c.alignment = CENTER
        c.border    = THIN_BORDER

    if not record_type_infos:
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=5)
        c        = ws.cell(2, 1, "No record type information available.")
        c.font   = SMALL_FONT
        c.fill   = PatternFill("solid", fgColor="F2F2F2")
        c.border = THIN_BORDER
    else:
        for row_idx, rt in enumerate(record_type_infos, start=2):
            row_fill = PatternFill("solid", fgColor="EAF2FB") if row_idx % 2 == 0 else None
            vals = [
                rt.get("name", ""),
                rt.get("developerName", ""),
                rt.get("active", False),
                rt.get("master", False),
                rt.get("defaultRecordTypeMapping", False),
            ]
            for col, val in enumerate(vals, 1):
                c        = ws.cell(row_idx, col, val)
                c.font   = NORMAL_FONT
                c.border = THIN_BORDER
                if isinstance(val, bool):
                    c.value     = CHECK if val else DASH
                    c.fill      = CHECK_FILL if val else DASH_FILL
                    c.alignment = CENTER
                else:
                    c.alignment = LEFT
                    if row_fill:
                        c.fill = row_fill

    ws.column_dimensions["A"].width = 35
    ws.column_dimensions["B"].width = 35
    ws.column_dimensions["C"].width = 10
    ws.column_dimensions["D"].width = 10
    ws.column_dimensions["E"].width = 10
    return ws


def _build_object_sheet(wb, obj_name, obj_data, target_org=None):
    """One sheet per object: Record Types section at top, then Field Inventory below."""
    fields    = sorted(obj_data.get("fields", []), key=lambda f: f.get("label", ""))
    obj_label = obj_data.get("label", obj_name)

    ws = wb.create_sheet(f"📋 {obj_label[:28]}")
    ws.freeze_panes = "A1"

    row = 1

    # ── Section title: object name ─────────────────────────────────────────
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
    c           = ws.cell(row, 1, f"{obj_label}  ({obj_name})")
    c.font      = WHITE_FONT
    c.fill      = HEADER_FILL
    c.alignment = LEFT
    c.border    = THIN_BORDER
    ws.row_dimensions[row].height = 22
    row += 1

    # ── Section: Record Types & Page Layout Assignments ────────────────────
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
    c           = ws.cell(row, 1, "Record Types & Page Layout Assignments")
    c.font      = BOLD_FONT
    c.fill      = OBJ_HDR_FILL
    c.alignment = LEFT
    c.border    = THIN_BORDER
    row += 1

    rt_headers = ["Record Type", "Page Layout Assignment", "Assigned", "Default", ""]
    for col, h in enumerate(rt_headers, 1):
        c           = ws.cell(row, col, h)
        c.font      = BOLD_FONT
        c.fill      = OBJ_HDR_FILL
        c.alignment = CENTER
        c.border    = THIN_BORDER
    row += 1

    record_type_infos = obj_data.get("recordTypeInfos", [])
    if not record_type_infos and target_org:
        try:
            from sf_cli import _get_record_types_fallback
            rt_list = _get_record_types_fallback(target_org, obj_name)
            record_type_infos = [
                {
                    "name":                    rt.get("record_type_name", ""),
                    "developerName":           rt.get("record_type_name", ""),
                    "active":                  True,
                    "master":                  rt.get("record_type_name") == "--Master--",
                    "defaultRecordTypeMapping": rt.get("is_default", False),
                }
                for rt in rt_list
            ]
        except Exception:
            record_type_infos = []

    if record_type_infos:
        for rt in record_type_infos:
            name    = rt.get("name", "")
            devname = rt.get("developerName", "")
            active  = rt.get("active", False)
            master  = rt.get("master", False)
            default = rt.get("defaultRecordTypeMapping", False)
            # Page layout not available from describe recordTypeInfos alone; show devName
            layout  = devname if not master else "--Master--"

            row_fill = PatternFill("solid", fgColor="FFF9E6") if not master else None
            for col, val in [(1, name), (2, layout)]:
                c        = ws.cell(row, col, val)
                c.font   = NORMAL_FONT
                c.border = THIN_BORDER
                c.alignment = LEFT
                if row_fill: c.fill = row_fill
            _check_cell(ws, row, 3, not master)   # Assigned = non-master RT
            _check_cell(ws, row, 4, default)
            c = ws.cell(row, 5, ""); c.border = THIN_BORDER
            row += 1
    else:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
        c        = ws.cell(row, 1, "No record type information available.")
        c.font   = SMALL_FONT
        c.fill   = PatternFill("solid", fgColor="F2F2F2")
        c.border = THIN_BORDER
        row += 1

    row += 1  # spacer

    # ── Section: Field Inventory ───────────────────────────────────────────
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
    c           = ws.cell(row, 1, "Field Inventory")
    c.font      = BOLD_FONT
    c.fill      = OBJ_HDR_FILL
    c.alignment = LEFT
    c.border    = THIN_BORDER
    row += 1

    fld_headers = ["Field Label", "API Name", "Type", "Readable", "Editable"]
    for col, h in enumerate(fld_headers, 1):
        c           = ws.cell(row, col, h)
        c.font      = WHITE_FONT
        c.fill      = HEADER_FILL
        c.alignment = CENTER
        c.border    = THIN_BORDER
    row += 1

    for field in fields:
        fname    = field.get("name", "")
        flabel   = field.get("label", fname)
        ftype    = field.get("type", "")
        readable = field.get("filterable", True)
        editable = not field.get("calculated", False) and not field.get("autoNumber", False)

        row_fill = PatternFill("solid", fgColor="EAF2FB") if row % 2 == 0 else None
        for col, val in [(1, flabel), (2, fname), (3, ftype)]:
            c        = ws.cell(row, col, val)
            c.font   = NORMAL_FONT
            c.border = THIN_BORDER
            c.alignment = LEFT
            if row_fill: c.fill = row_fill
        _check_cell(ws, row, 4, readable)
        _check_cell(ws, row, 5, editable)
        row += 1

    ws.column_dimensions["A"].width = 35
    ws.column_dimensions["B"].width = 35
    ws.column_dimensions["C"].width = 16
    ws.column_dimensions["D"].width = 11
    ws.column_dimensions["E"].width = 11

    return ws


def build_excel(output_path, objects_data, profiles, permsets, log_fn=print,
                new_profile_cols=None, target_org=None):
    """Build one Excel workbook per selected object.

    Each workbook contains:
      - 📋 Summary  — object-level permissions matrix (all principals × objects)
      - 📊 <ObjName> — field-level FLS matrix (all principals × fields, R/E columns)

    No per-principal detail sheets (avoids 100-tab bloat for orgs with many profiles).

    Returns a list of saved file paths.
    """
    from pathlib import Path

    base    = Path(output_path)
    stem    = base.stem
    suffix  = base.suffix or ".xlsx"
    out_dir = base.parent

    all_principals = (
        [("Profile", p) for p in profiles] +
        [("PermSet", ps) for ps in permsets]
    )
    # One workbook for all selected objects
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    # Sheet 1: Manifest
    _build_manifest_sheet(wb, objects_data)

    # One combined sheet per object (record types at top + field inventory below)
    for obj_name, obj_data in sorted(objects_data.items()):
        fields = obj_data.get("fields", [])
        if not fields:
            log_fn(f"  ⚠️  {obj_name}: no fields — skipping.")
            continue
        log_fn(f"  Writing sheet for {obj_data.get('label', obj_name)}…")
        _build_object_sheet(wb, obj_name, obj_data, target_org=target_org)

    wb.save(str(base))
    log_fn(f"  ✅ Saved: {base.name}")
    return [str(base)]
