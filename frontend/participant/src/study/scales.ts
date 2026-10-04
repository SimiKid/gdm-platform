/**
 * Answer scales shared by several questionnaire pages. The option text is part
 * of the validated instruments, so change it only together with the study
 * materials.
 */

/** Five-point agreement scale (GAAIS attitudes, exit questionnaire matrices). */
export const AGREE_SCALE_5 = [
  "Disagree strongly",
  "Disagree moderately",
  "Neither disagree nor agree",
  "Agree moderately",
  "Agree strongly",
];

/** Five-point familiarity scale (spaceflight / survival topics). */
export const FAMILIARITY_OPTIONS = [
  { value: "1", label: "Not familiar at all" },
  { value: "2", label: "Rather unfamiliar" },
  { value: "3", label: "Neither" },
  { value: "4", label: "Rather familiar" },
  { value: "5", label: "Very familiar" },
];
