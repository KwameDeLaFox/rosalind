// Fixed rubric. Every profile answers the same five fields.
// No free-form chat. No scores. No severity badges.
// The "top objection" field is the one that earns or kills the prototype.

export type RubricField =
  | "clarity"
  | "trust"
  | "friction"
  | "next_action"
  | "top_objection";

export interface RubricFeedback {
  clarity: string;
  trust: string;
  friction: string;
  next_action: string;
  top_objection: string;
}

// Used to label and describe fields in the UI and to instruct the LLM.
export const RUBRIC: {
  key: RubricField;
  label: string;
  asks: string;
  length: string;
}[] = [
  {
    key: "clarity",
    label: "Clarity",
    asks: "Is the value proposition understandable within five seconds? What, if anything, is unclear?",
    length: "1-2 sentences",
  },
  {
    key: "trust",
    label: "Trust",
    asks: "What signals reduce or fail to reduce scepticism?",
    length: "1-2 sentences",
  },
  {
    key: "friction",
    label: "Friction",
    asks:
      "What on this page would cause hesitation, confusion, or abandonment? Be concrete — name a specific element (a form field, a missing price, an ambiguous CTA, a vague subhead). Avoid generic observations like 'could be clearer'.",
    length: "1-2 sentences",
  },
  {
    key: "next_action",
    label: "Next",
    asks:
      "Would this profile click the primary CTA, scroll for more, or leave? Directional only — no percentages.",
    length: "1 sentence",
  },
  {
    key: "top_objection",
    label: "Top objection",
    asks:
      "The single biggest unanswered question this profile would have before acting. Phrase it as a question. This is the most important field — make it specific to this profile's concerns, not a generic question like 'what does it cost?'",
    length: "1 sentence, phrased as a question",
  },
];

// Strict JSON schema description (sent to the LLM as part of the prompt).
export const RUBRIC_JSON_SHAPE = `{
  "clarity": string,        // 1-2 sentences
  "trust": string,           // 1-2 sentences
  "friction": string,        // 1-2 sentences, must reference a specific element on the page
  "next_action": string,     // 1 sentence: "click" | "scroll" | "leave" plus reasoning
  "top_objection": string    // 1 sentence, phrased as a question, specific to this profile
}`;
