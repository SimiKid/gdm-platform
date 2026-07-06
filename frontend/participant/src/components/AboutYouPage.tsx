import { useState } from "react";
import Likert from "./Likert";

export interface AboutYouAnswers {
  age: number;
  gender: string;
  education: string;
  fieldOfStudy: string;
}

interface Props {
  onContinue: (answers: AboutYouAnswers) => void;
}

const GENDER_OPTIONS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "nonbinary", label: "Non-binary" },
  { value: "na", label: "Prefer not to say" },
];

const EDUCATION_OPTIONS = [
  "Compulsory schooling",
  "Secondary school (e.g. Matura / high-school diploma)",
  "Vocational training / apprenticeship",
  "Bachelor's degree",
  "Master's degree",
  "Doctorate",
  "Other",
];

/** Page 2 — About You. */
export default function AboutYouPage({ onContinue }: Props) {
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [education, setEducation] = useState("");
  const [fieldOfStudy, setFieldOfStudy] = useState("");

  const ageNum = Number(age);
  const ageValid = age !== "" && ageNum >= 18 && ageNum <= 120;
  const ready = ageValid && gender && education && fieldOfStudy.trim();

  return (
    <div className="study-card">
      <h1>A few questions about you</h1>
      <p>
        These questions help us describe our participant sample. Your answers
        cannot be linked to your identity.
      </p>

      <div className="q-block">
        <label className="q-label" htmlFor="about-age">
          Age
        </label>
        <input
          id="about-age"
          className="text-input"
          type="number"
          inputMode="numeric"
          min={18}
          max={120}
          value={age}
          onChange={(e) => setAge(e.target.value)}
        />
      </div>

      <Likert
        name="gender"
        legend="Gender"
        options={GENDER_OPTIONS}
        value={gender}
        onChange={setGender}
      />

      <div className="q-block">
        <label className="q-label" htmlFor="about-education">
          Highest level of education
        </label>
        <select
          id="about-education"
          className="text-input"
          value={education}
          onChange={(e) => setEducation(e.target.value)}
        >
          <option value="">Please choose…</option>
          {EDUCATION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>

      <div className="q-block">
        <label className="q-label" htmlFor="about-field">
          Field of study or occupation
        </label>
        <input
          id="about-field"
          className="text-input"
          type="text"
          value={fieldOfStudy}
          onChange={(e) => setFieldOfStudy(e.target.value)}
        />
      </div>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={() =>
            onContinue({
              age: ageNum,
              gender,
              education,
              fieldOfStudy: fieldOfStudy.trim(),
            })
          }
        >
          Continue
        </button>
        {!ready && (
          <p className="action-hint">Please answer all questions to continue.</p>
        )}
      </div>
    </div>
  );
}
