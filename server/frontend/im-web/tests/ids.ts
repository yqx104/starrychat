// Fixed canonical UUIDv7 values for fixtures; production IDs come from IM.
export const testID = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
