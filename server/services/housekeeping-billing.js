export function roundMinutesTo15(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  return Math.round(m / 15) * 15;
}

export function computeHourlyAmount(minutes, hourlyRate) {
  const rounded = roundMinutesTo15(minutes);
  return (rounded / 60) * (Number(hourlyRate) || 0);
}

export function minutesBetween(checkInIso, checkOutIso) {
  if (!checkInIso || !checkOutIso) return null;
  const ms = new Date(checkOutIso).getTime() - new Date(checkInIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}
