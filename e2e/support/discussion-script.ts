/**
 * Scripted Moon Survival voices for simulated participants. Persona 0 is
 * deliberately dominant so the contribution bot has someone to nudge; one
 * voice asks the group a question so the invitation exclusion is exercised.
 * Pacing (`everyMs`) is written for a 3-minute chat; callers stretch it.
 */
export interface Persona {
  everyMs: number;
  lines: string[];
  /** Said right after the bot nudges (visible to this participant). */
  afterNudge: string[];
}

export const PERSONAS: Persona[] = [
  {
    everyMs: 7_000,
    lines: [
      "Okay let's be systematic. Oxygen tanks first, obviously, nobody survives without air.",
      "Water second. You lose fluid fast on the lit side of the moon.",
      "The stellar map is third, we have to navigate 200 miles somehow.",
      "Food concentrate fourth, then the FM receiver for the last stretch.",
      "I'd put the parachute silk mid-table, sun protection matters more than people think.",
      "The pistols are near the bottom for me, maybe useful as propulsion, that's it.",
      "Matches are last. There is no oxygen outside, nothing burns.",
      "So my full order: oxygen, water, map, food, radio, rope, first aid, silk, raft, flares, pistols, milk, heater, compass, matches.",
      "The heater is useless on the lit side, we can drop it to the bottom third.",
      "Let me summarise where we are so we can lock it in.",
      "I think we are close. Rope above first aid, otherwise as I said.",
      "One more: the raft as a sled for the oxygen tanks, that changes the weight calculation.",
    ],
    afterNudge: [
      "Fair point, I have been talking a lot. I'll hold back — what do the rest of you think?",
    ],
  },
  {
    everyMs: 14_000,
    lines: [
      "Agree on oxygen and water at the top.",
      "I'd move the FM receiver higher than food, we might not need 50 pounds of food for 200 miles.",
      "The life raft can carry stuff, and the CO2 bottles give propulsion. Not bottom.",
      "Fine with the map third.",
      "Signal flares are pointless without atmosphere, they only work as a distress signal at the end.",
      "Rope is more useful than first aid on this terrain.",
    ],
    afterNudge: [
      "Thanks, I do have a view: the radio should be above food, we can go hungry for a day.",
      "And I'd push the raft up a few places, it doubles as a sled.",
    ],
  },
  {
    everyMs: 17_000,
    lines: [
      "Compass is worthless on the moon, no magnetic field. Last for me.",
      "Powdered milk below food concentrate, it is bulkier per calorie.",
      "I'd keep first aid above rope, injuries are more likely than cliffs.",
      "Can we agree the bottom three are matches, compass, heater?",
      "Happy with the top four.",
    ],
    afterNudge: [
      "Okay, my take: first aid stays above rope, and the compass is dead last.",
      "Also the heater is pointless on the sunlit side, agree to drop it.",
    ],
  },
  {
    everyMs: 21_000,
    lines: [
      "Parachute silk higher please, the sun exposure is brutal.",
      "What do the rest of you think about the radio, fourth or fifth?",
      "Okay with the overall order.",
      "One more thought: the raft as a sled for carrying oxygen.",
    ],
    afterNudge: [
      "Since we're asked: silk should be top six, sun exposure kills you slower than thirst but it kills you.",
      "And flares only matter at the very end, near the mothership.",
    ],
  },
  {
    everyMs: 26_000,
    lines: [
      "Mostly agree with everything said so far.",
      "Flares above pistols, at least they signal at the end.",
      "Fine by me.",
    ],
    afterNudge: [
      "I'll add something then: pistols are almost useless, but the recoil could help as propulsion in a pinch.",
      "Milk is the odd one, I'd put it just above the heater.",
    ],
  },
];

const REPEAT_PREFIX = ["Again: ", "To repeat, ", "Still think ", "As I said, "];

/** The n-th line a persona says; later passes are prefixed so text stays distinct. */
export function lineFor(persona: Persona, index: number): string {
  const pass = Math.floor(index / persona.lines.length);
  const line = persona.lines[index % persona.lines.length];
  return pass === 0 ? line : `${REPEAT_PREFIX[pass % REPEAT_PREFIX.length]}${line}`;
}
