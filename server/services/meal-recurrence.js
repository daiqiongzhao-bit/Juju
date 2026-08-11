function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mealWeekday(dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return (day + 6) % 7;
}

function datesForTemplateInRange(template, from, to) {
  const start = template.start_date > from ? template.start_date : from;
  // end_date ist die letzte erlaubte Wiederholung (einschließlich); NULL heißt
  // unbegrenzt. Ohne diese Grenze materialisierte jede aufgeschlagene Woche eine
  // weitere Instanz, ohne dass die Serie je hätte enden können (#619).
  const end = template.end_date && template.end_date < to ? template.end_date : to;
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    if (mealWeekday(cursor) === template.weekday) dates.push(cursor);
  }
  return dates;
}

export { addDays, mealWeekday, datesForTemplateInRange };
