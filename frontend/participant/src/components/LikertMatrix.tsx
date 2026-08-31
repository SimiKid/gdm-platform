interface Item {
  key: string;
  label: string;
}

interface Props {
  /** Groups the radios; must be unique per matrix on the page. */
  name: string;
  legend: string;
  items: Item[];
  scaleLabels: string[];
  /** Current values keyed by item key. */
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

/**
 * A Likert-style matrix: rows are items, columns are scale points,
 * with radio buttons at each intersection.
 */
export default function LikertMatrix({
  name,
  legend,
  items,
  scaleLabels,
  values,
  onChange,
}: Props) {
  return (
    <fieldset className="q-block">
      <legend className="q-label" style={{ fontWeight: "normal" }}>
        {legend}
      </legend>
      <div className="likert-matrix-wrapper">
        <table className="likert-matrix" role="presentation">
          <thead>
            <tr>
              <th />
              {scaleLabels.map((label) => (
                <th key={label} className="likert-matrix-col-header">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key} className="likert-matrix-row">
                <td className="likert-matrix-item">{item.label}</td>
                {scaleLabels.map((label, i) => (
                  <td key={label} className="likert-matrix-cell">
                    <label>
                      <input
                        type="radio"
                        name={`${name}-${item.key}`}
                        value={String(i + 1)}
                        checked={values[item.key] === String(i + 1)}
                        onChange={() => onChange(item.key, String(i + 1))}
                        aria-label={`${item.label}: ${label}`}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}
