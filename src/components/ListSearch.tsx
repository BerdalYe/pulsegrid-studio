import { SEARCH_FROM } from "../lib/search";

interface ListSearchProps {
  query: string;
  onChange: (query: string) => void;
  /** How many projects the list holds before searching. */
  total: number;
  /** How many match right now. */
  shown: number;
  label: string;
}

/**
 * A small search box for a list of projects. It only appears once the list is
 * long enough to need it (or while something is typed, so it can be cleared).
 */
export function ListSearch({ query, onChange, total, shown, label }: ListSearchProps) {
  if (total < SEARCH_FROM && query === "") return null;

  return (
    <div className="list-search">
      <input
        type="search"
        value={query}
        placeholder="Search projects…"
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Esc clears the search first, and only then does anything else get it.
          if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {query !== "" ? (
        <>
          <span className="list-search-count">
            {shown} of {total}
          </span>
          <button className="list-search-clear" aria-label="Clear the search" title="Clear the search" onClick={() => onChange("")}>
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}
