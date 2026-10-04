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
}

/**
 * A single question block with its answer options as real radio inputs, one
 * per line, so it stays keyboard- and screen-reader-accessible.
 */
export default function Likert({ name, legend, options, value, onChange }: Props) {
  return (
    <fieldset className="q-block">
      <legend className="q-label">{legend}</legend>
      <div className="radio-list" role="presentation">
        {options.map((opt) => (
          <label key={opt.value} className="radio-list-option">
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
    </fieldset>
  );
}
