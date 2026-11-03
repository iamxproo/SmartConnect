// Shared Motion timings, matching the design tokens (--sc-duration-base 200ms, --sc-ease-enter).
// Motion runs inside <MotionConfig reducedMotion="user">, which drops transform animation for people who ask.
export const enterTransition = { duration: 0.2, ease: [0, 0, 0, 1] } as const;
