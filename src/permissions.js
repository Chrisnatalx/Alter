// Permisos de JARVIS: decide qué herramientas corren solas y cuáles esperan confirmación
// de la persona (las que envían o borran algo). Los subagentes nunca pueden confirmar.

const crypto = require('crypto');

// "mcp__claude_ai_Google_Calendar__create_event" → { app: "Google Calendar", action: "create event" }
function describeTool(toolName, mcpServer) {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (m) {
    const app = (mcpServer?.name || m[1])
      .replace(/^claude\.ai\s+/i, '').replace(/^claude_ai_/i, '').replace(/^plugin:[^:]+:/, '')
      .replace(/_/g, ' ').trim();
    return { app, action: m[2].replace(/_/g, ' ') };
  }
  const builtin = { WebSearch: 'búsqueda web', WebFetch: 'lectura de una página web' };
  return { app: builtin[toolName] || toolName, action: '' };
}

// Solo piden confirmación las acciones que envían algo a otras personas, publican o borran algo.
// Todo lo demás (leer, buscar, consultar, crear borradores) se autoriza solo.
// 'respond' cubre responder a una invitación (RSVP): le llega un mail al organizador.
const SENDS = /(^|_)(send|reply|forward|share|invite|publish|push|merge|respond)(_|$)|^(add|create)_.*comment/i;
const DELETES = /(^|_)(delete|trash|remove|revoke|destroy)(_|$)/i;
// Herramientas de GitHub que publican o modifican algo visible para otros (escribir, abrir, comentar, crear)
const PUBLISHES = /^(issue_write|sub_issue_write|create_pull_request|update_pull_request|create_or_update_file|update_issue_comment|pull_request_review_write|add_comment_to_pending_review|create_repository|fork_repository)$/i;
// Campos de un evento de Calendar que llevan invitados (algunos están obsoletos pero siguen funcionando)
const ATTENDEE_FIELDS = ['attendees', 'attendeeEmails', 'addedAttendees', 'addedAttendeeEmails'];
function needsConfirm(toolName, input) {
  const action = /^mcp__.+?__(.+)$/.exec(toolName)?.[1];
  if (!action) return false; // herramientas internas: solo web (búsqueda y lectura)
  if (SENDS.test(action) || DELETES.test(action) || PUBLISHES.test(action)) return true;
  if (/event/i.test(action)) {
    // Crear o mover un evento con invitados les manda la invitación por mail
    if (ATTENDEE_FIELDS.some((f) => Array.isArray(input?.[f]) && input[f].length)) return true;
    // update_event avisa a todos los invitados por defecto: solo pasa sin preguntar si se pide no notificar
    if (/(^|_)update(_|$)/i.test(action) && input?.notificationLevel !== 'NONE') return true;
  }
  return false;
}

// Resume el input de la herramienta para mostrarlo en pantalla (no se lee en voz alta).
function summarizeInput(input) {
  try {
    return Object.entries(input || {}).slice(0, 8).map(([k, v]) => {
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s.length > 160) s = s.slice(0, 157) + '…';
      return `${k}: ${s}`;
    }).join('\n');
  } catch { return ''; }
}

// Cada puerta guarda sus confirmaciones pendientes (id → { resolve, timer }).
// `emit(evento, datos)` avisa a la interfaz; sin respuesta en `timeoutMs` se deniega.
function createPermissionGate({ emit, timeoutMs }) {
  const pending = new Map();

  // Toda herramienta pasa por acá: si envía o borra algo, preguntamos en la interfaz y esperamos.
  const canUseTool = (toolName, input, opts = {}) => new Promise((resolve) => {
    if (!needsConfirm(toolName, input)) {
      console.log(`  [AUTOMÁTICO] ${toolName}`);
      resolve({ behavior: 'allow', updatedInput: input });
      return;
    }
    // Un subagente trabaja en segundo plano: no hay nadie mirando la pantalla para confirmar
    if (opts.agentID) {
      console.log(`  [DENEGADO A SUBAGENTE] ${toolName}`);
      emit('denied', { ...describeTool(toolName, opts.mcpServer), agent: opts.agentID });
      resolve({ behavior: 'deny', message: 'Los subagentes no pueden enviar ni borrar: pedíselo a JARVIS.' });
      return;
    }
    const id = crypto.randomUUID();
    const { app, action } = describeTool(toolName, opts.mcpServer);
    const finish = (allowed) => {
      if (!pending.has(id)) return;
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
      emit('confirm_closed', { id, allowed }); // la interfaz cierra el panel si sigue abierto (timeout, corte, etc.)
      console.log(`  [${allowed ? 'CONFIRMADO' : 'RECHAZADO'}] ${toolName}`);
      resolve(allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'La persona no autorizó esta acción.' });
    };
    const payload = { id, app, action, title: opts.title || '', detail: summarizeInput(input) };
    const timer = setTimeout(() => finish(false), timeoutMs);
    pending.set(id, { resolve: finish, timer, payload });
    opts.signal?.addEventListener('abort', () => finish(false));
    emit('confirm', payload);
  });

  return {
    canUseTool,
    confirm(id, allow) {
      const p = pending.get(String(id || ''));
      if (!p) return false;
      p.resolve(allow === true);
      return true;
    },
    denyAll() { for (const p of [...pending.values()]) p.resolve(false); },
    pendingCount: () => pending.size,
    // Confirmaciones sin responder: se reenvían a la interfaz cuando se reconecta
    pending: () => [...pending.values()].map((p) => p.payload),
  };
}

module.exports = { describeTool, needsConfirm, summarizeInput, createPermissionGate };
