import { useState } from "react";
import Likert from "./Likert";

export interface AboutYouAnswers {
  age?: number;
  agePreferNotToSay?: boolean;
  gender?: string;
  genderCustom?: string;
  education?: string;
  educationOther?: string;
  englishProficiency?: string;
}

interface Props {
  onContinue: (answers: AboutYouAnswers) => void;
  onIneligible?: (reason: string) => void;
}

const GENDER_OPTIONS = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "nonbinary", label: "Non-Binary" },
  { value: "self-describe", label: "Prefer to self-describe" },
  { value: "na", label: "Prefer not to say" },
];

const EDUCATION_OPTIONS = [
  { value: "high_school_or_less", label: "High school or less" },
  { value: "some_college", label: "Some college/university (no degree)" },
  { value: "vocational", label: "Vocational / trade certificate" },
  { value: "bachelors", label: "Bachelor's degree" },
  { value: "masters_or_higher", label: "Master's degree or higher" },
  { value: "other", label: "Other" },
  { value: "na", label: "Prefer not to say" },
];

const ENGLISH_OPTIONS = [
  { value: "native_bilingual", label: "Native / Bilingual" },
  { value: "fluent", label: "Fluent (advanced)" },
  { value: "intermediate", label: "Intermediate" },
  { value: "basic", label: "Basic" },
  { value: "none", label: "None" },
];

/** Page 2 — Background Info (demographics). */
export default function AboutYouPage({ onContinue, onIneligible }: Props) {
  const [age, setAge] = useState("");
  const [ageNa, setAgeNa] = useState(false);
  const [gender, setGender] = useState("");
  const [genderCustom, setGenderCustom] = useState("");
  const [education, setEducation] = useState("");
  const [educationOther, setEducationOther] = useState("");
  const [english, setEnglish] = useState("");

  const ageNum = Number(age);
  // "Answered plausibly" — not "eligible". An under-18 age still enables
  // Continue so that ineligibility is only acted on when the page is
  // submitted; a typo like 121 is a correctable mistake, so it does not.
  const ageComplete =
    ageNa || (age !== "" && Number.isInteger(ageNum) && ageNum >= 1 && ageNum <= 120);
  const ageEligible = ageNa || ageNum >= 18;
  const genderValid =
    gender !== "" && (gender !== "self-describe" || genderCustom.trim() !== "");
  const educationValid =
    education !== "" && (education !== "other" || educationOther.trim() !== "");
  const ready = ageComplete && genderValid && educationValid && english !== "";

  /**
   * Eligibility is decided here, never while the participant is still typing
   * or clicking: a mis-click on "None" must be correctable.
   */
  function submit() {
    if (!ageEligible) {
      onIneligible?.(
        "The participant reported being younger than the minimum age of 18.",
      );
      return;
    }
    if (english === "none") {
      onIneligible?.(
        "The participant reported no English proficiency for the live group discussion.",
      );
      return;
    }
    onContinue(collectAnswers());
  }

  function collectAnswers(): AboutYouAnswers {
    const answers: AboutYouAnswers = {};
    if (genderValid) answers.gender = gender;
    if (educationValid) answers.education = education;
    if (english) answers.englishProficiency = english;
    if (ageNa) {
      answers.agePreferNotToSay = true;
    } else if (ageComplete && ageEligible) {
      answers.age = ageNum;
    }
    if (gender === "self-describe" && genderCustom.trim()) {
      answers.genderCustom = genderCustom.trim();
    }
    if (education === "other" && educationOther.trim()) {
      answers.educationOther = educationOther.trim();
    }
    return answers;
  }

  return (
    <div className="study-card">
      <h1>Background Info</h1>
      <p>
        Before starting with the task, we ask you to answer some questions on the
        next two pages. Note that there are no right or wrong answers. Please
        respond as accurately and honestly as applies to you.
      </p>

      <div className="q-block">
        <label className="q-label" htmlFor="about-age">
          How old are you?
        </label>
        <input
          id="about-age"
          className="text-input"
          type="number"
          inputMode="numeric"
          min={18}
          max={120}
          value={age}
          disabled={ageNa}
          onChange={(e) => setAge(e.target.value)}
          aria-invalid={!ageNa && age !== "" && !(ageComplete && ageEligible)}
          aria-describedby={
            !ageNa && age !== "" && !(ageComplete && ageEligible)
              ? "about-age-error"
              : undefined
          }
        />
        {!ageNa && age !== "" && ageNum < 18 && (
          <p id="about-age-error" className="error" role="alert">
            You must be at least 18 years old to participate.
          </p>
        )}
        {!ageNa && age !== "" && ageNum > 120 && (
          <p id="about-age-error" className="error" role="alert">
            Please enter a valid age between 18 and 120.
          </p>
        )}
        <label className="consent-check" style={{ marginTop: "0.5rem" }}>
          <input
            type="checkbox"
            checked={ageNa}
            onChange={() => {
              setAgeNa((v) => !v);
              setAge("");
            }}
          />
          <span>Prefer not to say</span>
        </label>
      </div>

      <Likert
        name="gender"
        layout="list"
        legend="What is your gender?"
        options={GENDER_OPTIONS}
        value={gender}
        onChange={setGender}
      />
      {gender === "self-describe" && (
        <div className="q-block" style={{ marginTop: "0.75rem" }}>
          <label className="q-label" htmlFor="about-gender-custom">
            Please describe
          </label>
          <input
            id="about-gender-custom"
            className="text-input"
            type="text"
            value={genderCustom}
            onChange={(e) => setGenderCustom(e.target.value)}
          />
        </div>
      )}

      <Likert
        name="education"
        layout="list"
        legend="What is the highest level of education you have completed?"
        options={EDUCATION_OPTIONS}
        value={education}
        onChange={setEducation}
      />
      {education === "other" && (
        <div className="q-block" style={{ marginTop: "0.75rem" }}>
          <label className="q-label" htmlFor="about-education-other">
            Please specify
          </label>
          <input
            id="about-education-other"
            className="text-input"
            type="text"
            value={educationOther}
            onChange={(e) => setEducationOther(e.target.value)}
          />
        </div>
      )}

      <Likert
        name="english"
        layout="list"
        legend="What is your level of English proficiency?"
        options={ENGLISH_OPTIONS}
        value={english}
        onChange={setEnglish}
      />

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={submit}
        >
          Continue
        </button>
        {!ready && (
          <p className="action-hint">
            Please answer all questions to continue.
          </p>
        )}
      </div>
    </div>
  );
}
