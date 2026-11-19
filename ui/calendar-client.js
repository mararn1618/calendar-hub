export async function calendarAction(operation, input) {
  if (!window.calendar?.invoke) throw new Error('Open the Calendar Hub Mac app to use your calendars.');
  const reply = await window.calendar.invoke(operation, input);
  if (reply.ok) return reply.value;
  throw Object.assign(new Error(reply.message), { code: reply.code });
}
