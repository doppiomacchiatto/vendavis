export default function TabBar({ tabs, active, onChange }) {
  return (
    <nav className="flex bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            active === t.id
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
