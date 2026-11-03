// Hardcoded profiles for v0. Deliberately archetypal, not realistic.
// The point is variation: do different profiles produce genuinely
// different objections, or does every profile say the same thing?

export type ProfileId =
  | "skeptical-researcher"
  | "time-poor-founder"
  | "cautious-buyer"
  | "comparison-shopper"
  | "first-time-visitor";

export interface Profile {
  id: ProfileId;
  name: string;
  description: string;
  caresAbout: string;
  // Short voice examples the LLM can latch onto when differentiating
  // profiles. Not realistic quotes — they're tonal anchors. Without
  // these, all five profiles get the same prompt except one line, and
  // the LLM has nothing to grab onto. With them, "do different profiles
  // produce different objections" becomes a cleaner test of the rubric
  // rather than a test of whether the LLM differentiates at all.
  voiceExamples: string[];
}

export const PROFILES: Profile[] = [
  {
    id: "skeptical-researcher",
    name: "Skeptical researcher",
    description:
      "Has seen a hundred tools like this. Reads carefully, looks for overclaiming.",
    caresAbout: "Evidence, specificity, whether claims are backed.",
    voiceExamples: [
      "'claims X but provides no source for X'",
      "'I've seen this promise a dozen times and it's never been backed up'",
      "'10,000+ teams' is a vanity number — show me a case study",
    ],
  },
  {
    id: "time-poor-founder",
    name: "Time-poor founder",
    description:
      "Scanning on a phone between meetings. Decides in seconds.",
    caresAbout: "Whether the value prop is legible without scrolling.",
    voiceExamples: [
      "'I have 30 seconds — what is this'",
      "'I'm not scrolling, the headline has to tell me'",
      "'two CTAs at the top, I don't have time to pick'",
    ],
  },
  {
    id: "cautious-buyer",
    name: "Cautious buyer",
    description:
      "Interested but risk-averse. Wants to know what happens after they click.",
    caresAbout:
      "Trust signals, pricing transparency, what they're committing to.",
    voiceExamples: [
      "'what happens after I click the trial button'",
      "'what am I committing to — credit card? team size?'",
      "'where's the pricing, why is it hidden'",
    ],
  },
  {
    id: "comparison-shopper",
    name: "Comparison shopper",
    description:
      "Already evaluating two competitors. Looking for reasons to rule this out.",
    caresAbout: "Differentiation, what's missing, hidden costs.",
    voiceExamples: [
      "'competitor X does this for less — what makes this different'",
      "'no feature comparison table, no migration story — pass'",
      "'integrations list is vague, I need to know if mine are there'",
    ],
  },
  {
    id: "first-time-visitor",
    name: "First-time visitor",
    description:
      "Doesn't know the category. Needs orientation before evaluation.",
    caresAbout: "Jargon, assumed context, whether they understand what this is.",
    voiceExamples: [
      "'what even is this category — unified workspace for what'",
      "'I don't know what AI-native means in this context'",
      "'the subhead assumes I already know the problem'",
    ],
  },
];

// Default selection: 3 pre-selected per the PRD ("3 pre-selected").
export const DEFAULT_PROFILE_IDS: ProfileId[] = [
  "skeptical-researcher",
  "time-poor-founder",
  "cautious-buyer",
];

export const MIN_PROFILES = 3;
export const MAX_PROFILES = 5;

export function getProfileById(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
