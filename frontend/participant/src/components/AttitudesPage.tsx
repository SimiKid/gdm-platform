import { useState } from "react";
import Likert from "./Likert";
import LikertMatrix from "./LikertMatrix";

export interface AttitudesAnswers {
  [key: string]: string | number;
}

interface Props {
  onContinue: (answers: AttitudesAnswers) => void;
}

const AI_ITEMS = [
  { key: "gaais1", label: "I am interested in using artificially intelligent (AI) systems in my daily life." },
  { key: "gaais2", label: "AI can have positive impacts on people's well-being." },
  { key: "gaais3", label: "AI is exciting." },
  { key: "gaais4", label: "Much of society will benefit from a future full of AI." },
  { key: "gaais5", label: "I would like to use AI in my own job." },
  { key: "gaais6", label: "I would find AI sinister." },
  { key: "gaais7", label: "AI might take control of people." },
  { key: "gaais8", label: "I think AI is dangerous." },
  { key: "gaais9", label: "I shiver with discomfort when I think about future uses of AI." },
  { key: "gaais10", label: "People like me will suffer if AI is used more and more." },
];

const AI_SCALE = [
  "Disagree strongly",
  "Disagree moderately",
  "Neither disagree nor agree",
  "Agree moderately",
  "Agree strongly",
];

const PERSONALITY_ITEMS = [
  { key: "tipi1", label: "Extraverted, enthusiastic" },
  { key: "tipi2", label: "Critical, quarrelsome" },
  { key: "tipi3", label: "Dependable, self-disciplined" },
  { key: "tipi4", label: "Anxious, easily upset" },
  { key: "tipi5", label: "Open to new experiences, complex" },
  { key: "tipi6", label: "Reserved, quiet" },
  { key: "tipi7", label: "Sympathetic, warm" },
  { key: "tipi8", label: "Disorganized, careless" },
  { key: "tipi9", label: "Calm, emotionally stable" },
  { key: "tipi10", label: "Conventional, uncreative" },
];

const PERSONALITY_SCALE = [
  "Disagree strongly",
  "Disagree moderately",
  "Disagree a little",
  "Neither disagree nor agree",
  "Agree a little",
  "Agree moderately",
  "Agree strongly",
];

const TEAMWORK_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
  { value: "very_often", label: "Very often" },
];

const CHAT_COMFORT_OPTIONS = [
  { value: "1", label: "Not comfortable at all" },
  { value: "2", label: "Rather uncomfortable" },
  { value: "3", label: "Neither" },
  { value: "4", label: "Rather comfortable" },
  { value: "5", label: "Very comfortable" },
];

const SPACEFLIGHT_OPTIONS = [
  { value: "1", label: "Not familiar at all" },
  { value: "2", label: "Rather unfamiliar" },
  { value: "3", label: "Neither" },
  { value: "4", label: "Rather familiar" },
  { value: "5", label: "Very familiar" },
];

const SURVIVAL_OPTIONS = [
  { value: "1", label: "Not familiar at all" },
  { value: "2", label: "Rather unfamiliar" },
  { value: "3", label: "Neither" },
  { value: "4", label: "Rather familiar" },
  { value: "5", label: "Very familiar" },
];

/** The three screens this page walks through, in order. */
type Section = "ai" | "personality" | "experience";

function Actions({ ready, onNext }: { ready: boolean; onNext: () => void }) {
  return (
    <div className="card-actions">
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ready}
        onClick={onNext}
      >
        Continue
      </button>
      {!ready && (
        <p className="action-hint">Please answer all questions to continue.</p>
      )}
    </div>
  );
}

/**
 * Page 3 — Attitudes & Traits and Skills & Experience, as three screens:
 * the AI-attitude matrix, the personality matrix, then the single items.
 * Answers accumulate here and are handed up once at the end.
 */
export default function AttitudesPage({ onContinue }: Props) {
  const [section, setSection] = useState<Section>("ai");
  const [aiValues, setAiValues] = useState<Record<string, string>>({});
  const [personalityValues, setPersonalityValues] = useState<Record<string, string>>({});
  const [teamwork, setTeamwork] = useState("");
  const [chatComfort, setChatComfort] = useState("");
  const [spaceflightFamiliarity, setSpaceflightFamiliarity] = useState("");
  const [survivalFamiliarity, setSurvivalFamiliarity] = useState("");

  const aiComplete = AI_ITEMS.every((item) => aiValues[item.key]);
  const personalityComplete = PERSONALITY_ITEMS.every(
    (item) => personalityValues[item.key],
  );
  const experienceComplete = Boolean(
    teamwork && chatComfort && spaceflightFamiliarity && survivalFamiliarity,
  );

  function collectAnswers(): AttitudesAnswers {
    const answers: AttitudesAnswers = {};
    if (teamwork) answers.teamworkFrequency = teamwork;
    if (chatComfort) answers.chatComfort = Number(chatComfort);
    if (spaceflightFamiliarity) answers.spaceflightFamiliarity = Number(spaceflightFamiliarity);
    if (survivalFamiliarity) answers.survivalFamiliarity = Number(survivalFamiliarity);
    for (const item of AI_ITEMS) {
      if (aiValues[item.key]) answers[item.key] = Number(aiValues[item.key]);
    }
    for (const item of PERSONALITY_ITEMS) {
      if (personalityValues[item.key]) answers[item.key] = Number(personalityValues[item.key]);
    }
    return answers;
  }

  if (section === "ai") {
    return (
      <div className="study-card">
        <h1>Attitudes &amp; Traits (1/2)</h1>

        <LikertMatrix
          name="ai"
          legend="We are interested in your attitudes towards Artificial Intelligence (AI). By AI we mean devices that can perform tasks that would usually require human intelligence. These can be computers, robots or other hardware devices, possibly augmented with sensors or cameras, etc. Please indicate the extent to which you agree or disagree with each of those."
          items={AI_ITEMS}
          scaleLabels={AI_SCALE}
          values={aiValues}
          onChange={(key, value) =>
            setAiValues((prev) => ({ ...prev, [key]: value }))
          }
        />

        <Actions ready={aiComplete} onNext={() => setSection("personality")} />
      </div>
    );
  }

  if (section === "personality") {
    return (
      <div className="study-card">
        <h1>Attitudes &amp; Traits (2/2)</h1>

        <LikertMatrix
          name="personality"
          legend="Below is a list of several personality characteristics. Please indicate the extent to which you agree or disagree that each one describes you."
          items={PERSONALITY_ITEMS}
          scaleLabels={PERSONALITY_SCALE}
          values={personalityValues}
          onChange={(key, value) =>
            setPersonalityValues((prev) => ({ ...prev, [key]: value }))
          }
        />

        <Actions
          ready={personalityComplete}
          onNext={() => setSection("experience")}
        />
      </div>
    );
  }

  return (
    <div className="study-card">
      <h1>Skills &amp; Experience</h1>

      <Likert
        name="teamwork"
        layout="list"
        legend="How often do you usually work in teams of three or more people?"
        options={TEAMWORK_OPTIONS}
        value={teamwork}
        onChange={setTeamwork}
      />

      <Likert
        name="chat-comfort"
        layout="list"
        legend="How comfortable are you communicating via text chat?"
        options={CHAT_COMFORT_OPTIONS}
        value={chatComfort}
        onChange={setChatComfort}
      />

      <Likert
        name="spaceflight"
        layout="list"
        legend="How familiar are you with spaceflight-related topics?"
        options={SPACEFLIGHT_OPTIONS}
        value={spaceflightFamiliarity}
        onChange={setSpaceflightFamiliarity}
      />

      <Likert
        name="survival"
        layout="list"
        legend="How familiar are you with wilderness / survival-related topics?"
        options={SURVIVAL_OPTIONS}
        value={survivalFamiliarity}
        onChange={setSurvivalFamiliarity}
      />

      <Actions
        ready={experienceComplete}
        onNext={() => onContinue(collectAnswers())}
      />
    </div>
  );
}
