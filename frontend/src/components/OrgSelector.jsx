import { useEffect, useState } from "react";
import { api } from "../api/client";

export default function OrgSelector({ value, onChange }) {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api("/api/orgs")
      .then((d) => setOrgs(d.orgs || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <select
      className="bg-blue-600 text-white border border-blue-400 rounded px-2 py-1 text-sm focus:outline-none"
      value={value?.alias || ""}
      onChange={(e) => {
        const org = orgs.find((o) => o.alias === e.target.value);
        onChange(org || null);
      }}
    >
      <option value="">{loading ? "Loading orgs…" : "— Select org —"}</option>
      {orgs.map((o) => (
        <option key={o.alias} value={o.alias}>
          {o.alias} {o.isDefault ? "★" : ""}
        </option>
      ))}
    </select>
  );
}
