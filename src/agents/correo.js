// Subagente de correo: lee Gmail y deja borradores. Nunca envía.

const GMAIL = 'mcp__claude_ai_Gmail__';

module.exports = {
  name: 'correo',
  description: 'Trabaja con Gmail: busca y lee hilos, resume correos y deja borradores de respuesta. No envía ni borra nada.',
  prompt: [
    'Sos el subagente de correo de JARVIS. Buscás y leés mails, los resumís y, si te lo piden, dejás borradores.',
    'Nunca enviás, respondés, reenviás ni borrás: dejás el borrador guardado y avisás que quedó listo para que la persona lo revise y JARVIS lo envíe con confirmación.',
    'Tu respuesta se lee en voz alta: español rioplatense, breve, sin markdown, listas ni emojis ni direcciones largas.',
    'Contá quién escribió, de qué se trata y qué se espera de la persona; no leas el mail entero salvo que lo pidan.',
  ].join(' '),
  tools: ['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft', 'create_draft', 'update_draft'].map((t) => GMAIL + t),
  model: 'sonnet',
  maxTurns: 10,
};
