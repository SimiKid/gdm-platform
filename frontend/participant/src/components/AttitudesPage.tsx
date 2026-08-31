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

/** Page 3 — Attitudes & personality (before the individual task). */
export default function AttitudesPage({ onContinue }: Props) {
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
  const ready =
    aiComplete &&
    personalityComplete &&
    teamwork &&
    chatComfort &&
    spaceflightFamiliarity &&
    survivalFamiliarity;

  function submit() {
    const answers: AttitudesAnswers = {
      teamworkFrequency: teamwork,
      chatComfort: Number(chatComfort),
      spaceflightFamiliarity: Number(spaceflightFamiliarity),
      survivalFamiliarity: Number(survivalFamiliarity),
    };
    for (const item of AI_ITEMS) {
      answers[item.key] = Number(aiValues[item.key]);
    }
    for (const item of PERSONALITY_ITEMS) {
      answers[item.key] = Number(personalityValues[item.key]);
    }
    onContinue(answers);
  }

  return (
    <div className="study-card">
      <h1>About You</h1>

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

      <LikertMatrix
        name="personality"
        legend="Below are a number of personality traits that may or may not apply to you. Please indicate the extent to which you agree or disagree with each of those. I see myself as…"
        items={PERSONALITY_ITEMS}
        scaleLabels={PERSONALITY_SCALE}
        values={personalityValues}
        onChange={(key, value) =>
          setPersonalityValues((prev) => ({ ...prev, [key]: value }))
        }
      />

      <Likert
        name="teamwork"
        legend="How often do you usually work in teams of three or more people?"
        options={TEAMWORK_OPTIONS}
        value={teamwork}
        onChange={setTeamwork}
      />

      <Likert
        name="chat-comfort"
        legend="How comfortable are you communicating via text chat?"
        options={CHAT_COMFORT_OPTIONS}
        value={chatComfort}
        onChange={setChatComfort}
      />

      <Likert
        name="spaceflight"
        legend="How familiar are you with spaceflight-related topics?"
        options={SPACEFLIGHT_OPTIONS}
        value={spaceflightFamiliarity}
        onChange={setSpaceflightFamiliarity}
      />

      <Likert
        name="survival"
        legend="How familiar are you with wilderness / survival-related topics?"
        options={SURVIVAL_OPTIONS}
        value={survivalFamiliarity}
        onChange={setSurvivalFamiliarity}
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
