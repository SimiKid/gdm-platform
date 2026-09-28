interface Option {
  value: string;
  label: string;
}

interface Props {
  /** Groups the radios; must be unique per question on the page. */
  name: string;
  legend: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  /** Optional scale anchors shown under the buttons, e.g. ["not at all", "very"]. */
  anchors?: [string, string];
  /**
   * "buttons" (default) = horizontal pill group, right for numeric scales.
   * "list" = one radio per line, right for categorical options whose labels
   * are words rather than points on a scale.
   */
  layout?: "buttons" | "list";
}

/**
 * A single question block with its answer options as real radio inputs, so it
 * stays keyboard- and screen-reader-accessible in either layout.
 */
export default function Likert({
  name,
  legend,
  options,
  value,
  onChange,
  anchors,
  layout = "buttons",
}: Props) {
  const list = layout === "list";
  return (
    <fieldset className="q-block">
      <legend className="q-label">{legend}</legend>
      <div className={list ? "radio-list" : "likert-group"} role="presentation">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={list ? "radio-list-option" : "likert-option"}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      {anchors && (
        <div className="likert-anchors" aria-hidden="true">
          <span>{anchors[0]}</span>
          <span>{anchors[1]}</span>
        </div>
      )}
    </fieldset>
  );
}
