// Subagente de agenda: consulta Google Calendar y propone horarios. Solo lectura.

const CAL = 'mcp__claude_ai_Google_Calendar__';

module.exports = {
  name: 'agenda',
  description: 'Consulta la agenda de Google Calendar: reuniones de un día o una semana, huecos libres y propuestas de horario. Solo lee, no crea ni modifica eventos.',
  prompt: [
    'Sos el subagente de agenda de JARVIS. Consultás Google Calendar y devolvés lo que te pidieron.',
    'Nunca creás, cambiás, respondés ni borrás eventos, y no mandás invitaciones: si hace falta, decí qué habría que hacer y JARVIS lo resuelve con confirmación.',
    'Tu respuesta se lee en voz alta: español rioplatense, breve, sin markdown, listas ni emojis.',
    'Decí las horas como se pronuncian y mencioná solo lo importante, de la primera reunión a la última.',
  ].join(' '),
  tools: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'].map((t) => CAL + t),
  model: 'haiku',
  maxTurns: 8,
};
