// J.A.R.V.I.S. — caras del carrusel: Calendar (la semana), Mail (la bandeja) y Clima (Buenos Aires).
// Solo pinta: los datos llegan del servidor (GET /api/feeds y el evento `feeds`). Todo lo que viene de
// afuera (títulos, asuntos, remitentes) entra con textContent, nunca con innerHTML.

(() => {
  'use strict';

  const { agoLabel } = window.JarvisNav;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // 'AAAA-MM-DD' → «LUN», «MIÉ»… (al mediodía, así ninguna zona horaria la corre de día)
  const dayName = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short' }).replace('.', '').toUpperCase();
  const dayNum = (ymd) => String(Number(ymd.slice(8, 10)));
  const monthName = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('es-AR', { month: 'short' }).replace('.', '').toUpperCase();
  // «Hoy» en la zona horaria del servidor (la de los eventos), no la del navegador
  function todayIn(timeZone) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch { return null; }
  }
  const num = (v, digits = 0) => (typeof v === 'number' ? v.toLocaleString('es-AR', { maximumFractionDigits: digits }) : '—');

  // Encabezado común: título y «actualizado hace…», o el error si no hay nada que mostrar
  function head(el, title, feed) {
    const top = h('header', 'face-head');
    top.append(h('h4', '', title));
    let status = agoLabel(feed?.updatedAt ?? null, Date.now());
    if (feed?.error && !feed?.data) status = 'ERROR: ' + feed.error;
    else if (feed?.error) status += ' · ÚLTIMO REFRESCO FALLÓ';
    else if (feed?.refreshing && !feed?.data) status = 'TRAYENDO DATOS…';
    const st = h('span', 'face-status' + (feed?.error ? ' err' : ''), status);
    if (feed?.error) st.title = feed.error;
    top.append(st);
    el.replaceChildren(top);
  }

  function renderCalendar(el, google) {
    const g = google?.data;
    const week = g?.week;
    head(el, week ? `SEMANA · ${dayNum(week.start)} ${monthName(week.start)} – ${dayNum(week.end)} ${monthName(week.end)}` : 'SEMANA', google);
    const grid = h('div', 'week');
    const today = (g?.timezone && todayIn(g.timezone)) || g?.today;
    for (const day of g?.days || []) {
      const col = h('div', 'day' + (day.date === today ? ' today' : ''));
      col.append(h('b', '', `${dayName(day.date)} ${dayNum(day.date)}`));
      for (const ev of day.events) {
        // Lo que viene del día anterior (cruzó la medianoche o empezó antes del lunes) va con «…» y su hora de fin
        const label = ev.allDay ? ev.title : ev.continued ? `… ${ev.title}${ev.endTime ? ' (hasta ' + ev.endTime + ')' : ''}` : `${ev.time} ${ev.title}`;
        const row = h('div', 'ev' + (ev.allDay ? ' allday' : '') + (ev.continued ? ' continued' : ''), label);
        row.title = [ev.allDay ? 'Todo el día' : `${ev.time}${ev.endTime ? '–' + ev.endTime : ''}`, ev.title, ev.calendar].filter(Boolean).join(' · ');
        col.append(row);
      }
      grid.append(col);
    }
    el.append(grid);
  }

  // `inbox`: la lista a mostrar (la congelada mientras la cara está abierta); por defecto la de la caché
  function renderMail(el, google, inbox = google?.data?.inbox || []) {
    head(el, 'BANDEJA DE ENTRADA', google);
    const list = h('ol', 'threads');
    inbox.forEach((t, i) => {
      const li = h('li', 'thread' + (t.unread ? ' unread' : ''));
      li.append(h('span', 'n', String(i + 1)), h('span', 'u', t.unread ? '●' : ''), h('span', 'from', t.from), h('span', 'subject', t.subject));
      li.title = `${t.from} · ${t.subject}`;
      list.append(li);
    });
    if (!inbox.length && google?.data) list.append(h('li', 'empty', 'BANDEJA VACÍA'));
    el.append(list);
  }

  function renderWeather(el, weather) {
    const w = weather?.data;
    head(el, `CLIMA · ${(w?.place || 'Buenos Aires').toUpperCase()}`, weather);
    if (!w) return;
    const now = h('div', 'now');
    now.append(h('div', 'temp', `${num(w.current.temp, 1)}°`));
    const info = h('div', 'info');
    info.append(
      h('div', 'label', w.current.label),
      h('div', 'meta', `SENSACIÓN ${num(w.current.feels, 1)}° · VIENTO ${num(w.current.wind)} KM/H · HUMEDAD ${num(w.current.humidity)} %`),
    );
    now.append(info);
    const days = h('ul', 'days');
    for (const d of w.days) {
      const li = h('li', 'wday');
      li.append(h('b', '', `${dayName(d.date)} ${dayNum(d.date)}`), h('span', 'label', d.label), h('span', 'mm', `${num(d.max)}° / ${num(d.min)}°`), h('span', 'rain', `LLUVIA ${num(d.rainProb)} %`));
      days.append(li);
    }
    el.append(now, days);
  }

  window.JarvisFaces = { renderCalendar, renderMail, renderWeather };
})();
