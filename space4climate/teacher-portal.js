/* CommonBoard teacher portal: current boards, combined availability and teacher hours. */
(() => {
  'use strict';
  const API = '/api/orbit';
  const ORIGIN = 'https://www.space4climate.org';
  const pad = n => String(n).padStart(2, '0');
  const isoMs = date => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (date, n) => new Date(isoMs(date) + n * 86400000).toISOString().slice(0, 10);
  const days = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 32; d = addDays(d, 1)) out.push(d); return out; };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const boardPath = id => `commonboard.html?b=${encodeURIComponent(id)}&role=teacher&view=group`;
  const teacherStorageKeys = id => ({ me: `cb:teacher:me:${id}`, pending: `cb:teacher:pending:${id}`, profile: 'cb:teacher:profile' });

  function dateKey(ms, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function tzOffset(timezone, ms) {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, hourCycle:'h23', year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'}).formatToParts(new Date(ms));
    const part = type => Number(parts.find(p => p.type === type).value);
    return Math.round((Date.UTC(part('year'),part('month')-1,part('day'),part('hour')%24,part('minute'))-Math.floor(ms/60000)*60000)/60000);
  }
  function slotInstant(date, hour, timezone) {
    const naive = isoMs(date) + hour * 3600000;
    const first = naive - tzOffset(timezone, naive) * 60000;
    return naive - tzOffset(timezone, first) * 60000;
  }
  function validSlots(doc, participant) {
    const b = doc.board;
    return [...new Set(participant.slots || [])].filter(slot => {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(slot);
      if (!match || !Number.isFinite(isoMs(match[1])) || new Date(isoMs(match[1])).toISOString().slice(0,10) !== match[1]) return false;
      return match[1] >= b.startDate && match[1] <= b.endDate && +match[2] >= b.startHour && +match[2] < b.endHour;
    }).sort();
  }
  function aggregateAvailability(docs, {from, to, timezone, includeBooked = false}) {
    const first = slotInstant(from, 0, timezone);
    const last = slotInstant(addDays(to, 1), 0, timezone);
    const events = new Map();
    const event = at => { if (!events.has(at)) events.set(at, {add:new Map(), remove:new Set()}); return events.get(at); };
    docs.forEach(doc => {
      if (doc.booking && !includeBooked) return;
      Object.values(doc.participants || {}).filter(p => p.role === 'facilitator').forEach(p => {
        const entry = {id:`${doc.board.id}:${p.id}`,name:p.name,boardId:doc.board.id,boardTitle:doc.board.title};
        validSlots(doc,p).forEach(slot => {
          const date = slot.slice(0,10), hour = +slot.slice(11);
          const start = Math.max(first, slotInstant(date,hour,doc.board.timezone));
          const end = Math.min(last, slotInstant(date,hour+1,doc.board.timezone));
          if (start >= end) return;
          event(start).add.set(entry.id,entry); event(end).remove.add(entry.id);
        });
      });
    });
    // Midnight boundaries keep each row on a single day in the chosen display zone.
    days(from,addDays(to,1)).forEach(date => event(slotInstant(date,0,timezone)));
    const active = new Map(), rows = []; let previous = null;
    [...events.keys()].sort((a,b)=>a-b).forEach(at => {
      if (previous != null && at > previous && active.size) {
        const entries = [...active.values()].sort((a,b)=>a.id.localeCompare(b.id));
        const signature = entries.map(p=>p.id).join('|');
        const prior = rows[rows.length-1];
        if (prior && prior.end === previous && prior.signature === signature && dateKey(prior.start,timezone) === dateKey(previous,timezone)) prior.end = at;
        else rows.push({start:previous,end:at,entries,signature});
      }
      const change = events.get(at);
      change.remove.forEach(id=>active.delete(id)); change.add.forEach((p,id)=>active.set(id,p)); previous = at;
    });
    return rows.map(({signature,...row})=>row);
  }
  const formatDate = (ms,timezone) => new Intl.DateTimeFormat('en-GB',{timeZone:timezone,weekday:'short',day:'numeric',month:'short',year:'numeric'}).format(new Date(ms));
  const clock = (ms,timezone) => new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(ms));
  const timeRange = (row,timezone) => `${clock(row.start,timezone)}–${clock(row.end,timezone)}${dateKey(row.start,timezone)!==dateKey(row.end,timezone)?' (+1 day)':''}`;
  function availabilityText(rows, timezone, heading = 'Facilitator availability') {
    return [heading,`All times: ${timezone}`,...rows.map(row=>`${formatDate(row.start,timezone)} · ${timeRange(row,timezone)}\nAvailable: ${row.entries.map(p=>p.name).join(', ')}\n${[...new Map(row.entries.map(p=>[p.boardId,p])).values()].map(p=>`${p.boardTitle}: ${ORIGIN}/${boardPath(p.boardId)}`).join('\n')}`)].join('\n\n');
  }
  function buildAvailabilityGrid(rows, {from,to,timezone}) {
    const dates=days(from,to);
    if(!rows.length)return {dates,bands:[],maxCount:0};
    const minute=ms=>{const [h,m]=clock(ms,timezone).split(':').map(Number);return h*60+m;};
    const bounds=rows.flatMap(row=>[minute(row.start),dateKey(row.start,timezone)!==dateKey(row.end,timezone)?1440:minute(row.end)]);
    const gcd=(a,b)=>b?gcd(b,a%b):a;
    const step=bounds.reduce((n,value)=>gcd(n,value),60)||60;
    const first=Math.floor(Math.min(...bounds)/step)*step,last=Math.ceil(Math.max(...bounds)/step)*step;
    let maxCount=0;const bands=[];
    for(let startMinute=first;startMinute<last;startMinute+=step){
      const endMinute=startMinute+step;
      const cells=dates.map(date=>{
        const start=slotInstant(date,startMinute/60,timezone),end=slotInstant(date,endMinute/60,timezone),entries=new Map();
        if(end>start)rows.filter(row=>row.start<=start&&row.end>=end).forEach(row=>row.entries.forEach(entry=>entries.set(entry.id,entry)));
        const list=[...entries.values()].sort((a,b)=>a.id.localeCompare(b.id));maxCount=Math.max(maxCount,list.length);
        return {date,start,end,entries:list};
      });
      bands.push({startMinute,endMinute,cells});
    }
    return {dates,bands,maxCount};
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = {dateKey,slotInstant,validSlots,aggregateAvailability,teacherStorageKeys,availabilityText,buildAvailabilityGrid};
    return;
  }

  const $ = id => document.getElementById(id);
  const local = {get(key){try{return JSON.parse(localStorage.getItem(key));}catch{return null;}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}},del(key){try{localStorage.removeItem(key);}catch{}}};
  const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const S = {docs:[],rows:[],visible:[],calendar:null,selectedCell:null,editor:null,loading:false,lastSync:null};
  function randomKey(bytes=18) {const data=crypto.getRandomValues(new Uint8Array(bytes));return btoa(String.fromCharCode(...data)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function toast(message){$('portal-toast').textContent=message;$('portal-toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('portal-toast').classList.remove('show'),3500);}
  async function api(method,params,body,key) {
    const response = await fetch(API+'?'+new URLSearchParams(params),{method,cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(key?{'X-Orbit-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let data;try{data=await response.json();}catch{throw new Error('The server returned an unreadable response. Please try again.');}
    if(!response.ok){const error=new Error(data.error||'Could not save. Please try again.');error.status=response.status;throw error;}return data;
  }
  const getMe = doc => {
    const key=teacherStorageKeys(doc.board.id).me;let identity=local.get(key);
    if(identity&&doc.participants[identity.pid]&&doc.participants[identity.pid].role!=='teacher'){local.del(key);identity=null;}
    if(!identity){const previous=local.get(`cb:me:${doc.board.id}`);if(previous&&doc.participants[previous.pid]?.role==='teacher'){identity=previous;local.set(key,identity);}}
    return identity;
  };
  const myEntry = doc => {const me=getMe(doc);return me?doc.participants[me.pid]:null;};
  const facPeople = doc => Object.values(doc.participants||{}).filter(p=>p.role==='facilitator'&&validSlots(doc,p).length);
  const shortDate = date => new Date(isoMs(date)).toLocaleDateString('en-GB',{timeZone:'UTC',day:'numeric',month:'short'});
  function filterSettings() {
    const from=$('filter-from').value,to=$('filter-to').value;
    const valid=!!from&&!!to&&from<=to&&(isoMs(to)-isoMs(from))/86400000<28;
    $('filter-error').hidden=valid;$('filter-error').textContent=valid?'':'Choose a date range of up to 28 days, with the last day on or after the first.';
    return valid?{from,to,timezone:$('display-tz').value,query:$('board-search').value.trim().toLowerCase()}:null;
  }
  function filteredDocs(filters) {
    return S.docs.filter(doc=>{
      const b=doc.board;
      // Keep boards whose dates overlap in the DISPLAY zone, including overnight shifts.
      const start=dateKey(slotInstant(b.startDate,b.startHour,b.timezone),filters.timezone);
      const end=dateKey(slotInstant(b.endDate,b.endHour,b.timezone)-1,filters.timezone);
      return start<=filters.to&&end>=filters.from&&(!filters.query||[b.title,...Object.values(doc.participants||{}).map(p=>p.name)].join(' ').toLowerCase().includes(filters.query));
    });
  }
  function render() {
    const filters=filterSettings();if(!filters){$('copy-combined').disabled=true;return;}
    const matching=filteredDocs(filters);
    S.rows=aggregateAvailability(matching,filters);
    S.visible=matching.filter(doc=>$('show-empty').checked||facPeople(doc).length);
    $('stat-boards').textContent=String(S.docs.length);
    $('stat-facilitators').textContent=String(S.docs.reduce((n,doc)=>n+facPeople(doc).length,0));
    $('stat-hours').textContent=String(S.docs.reduce((n,doc)=>n+(myEntry(doc)?validSlots(doc,myEntry(doc)).length:0),0));
    $('board-count').textContent=String(S.visible.length);
    $('copy-combined').disabled=!S.rows.length;
    renderCombined(filters);renderBoards(filters);
    if(S.editor) reconcileEditor();
  }
  function renderCombined(filters) {
    $('combined-note').textContent=`Availability across matching, unbooked boards · ${filters.timezone.replace(/_/g,' ')} time`;
    const focused=document.activeElement?.dataset.calendarCell;
    S.calendar=buildAvailabilityGrid(S.rows,filters);
    if(!S.rows.length){$('combined-list').innerHTML='<p class="tp-empty">No facilitator hours match these filters. Try different dates or a different search, or open a board below to share your hours.</p>';$('calendar-details').hidden=true;return;}
    const {dates,bands,maxCount}=S.calendar,today=dateKey(Date.now(),filters.timezone);
    const label=mins=>`${pad(Math.floor(mins/60))}:${pad(mins%60)}`;
    let firstAvailable=true;
    $('combined-list').innerHTML=`<table class="tp-calendar" style="min-width:${96+dates.length*104}px"><caption>Facilitator availability · ${esc(filters.timezone.replace(/_/g,' '))} time. Dates are columns; times are rows.</caption><thead><tr><th scope="col" class="tp-calendar-corner">Time ↓ / Date →</th>${dates.map(date=>`<th scope="col" class="${date===today?'is-today':''}"><span>${esc(new Date(isoMs(date)).toLocaleDateString('en-GB',{timeZone:'UTC',weekday:'short'}))}</span><strong>${esc(shortDate(date))}</strong></th>`).join('')}</tr></thead><tbody>${bands.map((band,r)=>`<tr><th scope="row" class="tp-calendar-time"><strong>${label(band.startMinute)}</strong><span>${label(band.endMinute)}</span></th>${band.cells.map((cell,c)=>{
      const n=cell.entries.length,key=`${cell.date}|${band.startMinute}`,selected=S.selectedCell===key;
      const level=n?Math.max(1,Math.ceil(n/maxCount*5)):0;
      const tab=n&&firstAvailable?0:-1;if(n)firstAvailable=false;
      return `<td data-level="${level}">${n?`<button type="button" class="tp-calendar-cell" data-calendar-cell="${key}" data-calendar-row="${r}" data-calendar-col="${c}" tabindex="${tab}" aria-controls="calendar-details" aria-expanded="${selected}" aria-label="${esc(formatDate(cell.start,filters.timezone))}, ${label(band.startMinute)} to ${label(band.endMinute)}, ${plural(n,'facilitator')} available. Show names and boards."><strong>${n}</strong><span>available</span></button>`:`<span class="tp-calendar-none" aria-label="No facilitators available">—</span>`}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
    if(focused){const button=[...$('combined-list').querySelectorAll('[data-calendar-cell]')].find(el=>el.dataset.calendarCell===focused);if(button){$('combined-list').querySelectorAll('[data-calendar-cell]').forEach(el=>{el.tabIndex=-1;});button.tabIndex=0;button.focus({preventScroll:true});}}
    renderCellDetails();
  }
  function selectedCalendarCell(){
    if(!S.selectedCell||!S.calendar)return null;
    const [date,minute]=S.selectedCell.split('|');return S.calendar.bands.find(band=>band.startMinute===+minute)?.cells.find(cell=>cell.date===date)||null;
  }
  function renderCellDetails(){
    const cell=selectedCalendarCell(),el=$('calendar-details');
    el.hidden=!cell?.entries.length;if(el.hidden)return;
    const timezone=$('display-tz').value;
    const next=`<div class="tp-section-head"><div><span class="tp-section-number">SELECTED TIME</span><h3>${esc(formatDate(cell.start,timezone))} · ${esc(timeRange(cell,timezone))}</h3><p>${plural(cell.entries.length,'facilitator')} available · ${esc(timezone.replace(/_/g,' '))}</p></div><button type="button" class="tp-btn tp-secondary" id="copy-selected-time">Copy this time ↗</button></div><div class="tp-calendar-people">${cell.entries.map(p=>`<div><strong>${esc(p.name)}</strong><a href="${boardPath(p.boardId)}">${esc(p.boardTitle)} ↗</a><button type="button" class="tp-btn tp-secondary" data-edit-calendar-board="${esc(p.boardId)}">Add my hours</button></div>`).join('')}</div>`;
    if(el.innerHTML!==next)el.innerHTML=next;
  }
  function participantSummary(doc,p) {
    const slots=validSlots(doc,p);const count=slots.length;
    const perDay=new Map();slots.forEach(slot=>{const date=slot.slice(0,10);if(!perDay.has(date))perDay.set(date,[]);perDay.get(date).push(+slot.slice(11));});
    const lines=[...perDay].map(([date,hours])=>{const spans=[];hours.forEach(hour=>{const previous=spans[spans.length-1];if(previous&&previous[1]===hour)previous[1]=hour+1;else spans.push([hour,hour+1]);});return `${shortDate(date)}: ${spans.map(([a,b])=>`${pad(a)}:00–${pad(b)}:00`).join(', ')}`;});
    return {count,text:lines.slice(0,2).join(' · ')+(lines.length>2?` · +${lines.length-2} more days`:'')};
  }
  function renderBoards() {
    $('board-list').innerHTML=!S.visible.length?'<p class="tp-empty">No current boards match. Clear your search or include boards without facilitator hours. <a href="commonboard.html#orbit-launch">Launch a board ↗</a></p>':S.visible.map(doc=>{
      const b=doc.board,fac=facPeople(doc),mine=myEntry(doc),count=mine?validSlots(doc,mine).length:0;
      return `<article class="tp-board"><div class="tp-board-head"><h3>${esc(b.title)}</h3><span class="tp-badge${doc.booking?' is-booked':''}">${doc.booking?'Booked':'Open'}</span></div><p class="tp-board-meta">${shortDate(b.startDate)}–${shortDate(b.endDate)} ${b.startDate.slice(0,4)}<br>${pad(b.startHour)}:00–${pad(b.endHour)}:00 · ${esc(b.timezone.replace(/_/g,' '))}<br>${plural(b.sessionHours,'hour')} per session</p><div class="tp-facilitators">${fac.length?fac.map(p=>{const summary=participantSummary(doc,p);return `<div class="tp-facilitator"><span class="tp-avatar" aria-hidden="true">${esc(p.name.trim().slice(0,2).toUpperCase())}</span><div><strong>${esc(p.name)}</strong><p>${esc(summary.text)}</p></div></div>`;}).join(''):'<p class="tp-facilitator-empty">Facilitators have not shared hours on this board yet.</p>'}</div>${count?`<p class="tp-your-hours">✓ You have shared ${plural(count,'hour')}.</p>`:''}<div class="tp-board-actions"><button class="tp-btn tp-primary" type="button" data-edit-board="${esc(b.id)}">${mine?'Update my hours':'Add my availability'} <span aria-hidden="true">↗</span></button><div class="tp-board-links-row"><a href="${boardPath(b.id)}">Open full board ↗</a><button type="button" data-copy-board="${esc(b.id)}">Copy availability</button></div></div></article>`;
    }).join('');
  }
  async function loadBoards(quiet=false) {
    if(S.loading)return;S.loading=true;$('refresh-btn').disabled=true;
    if(!quiet)$('sync-status').textContent='Refreshing current boards…';
    try{
      const docs=new Map();let cursor=null;const seen=new Set();let pages=0;
      do{
        const result=await api('GET',{action:'boards',...(cursor?{cursor}:{})});
        if(!Array.isArray(result.boards))throw new Error('The board directory is not available yet. Please refresh in a moment.');
        result.boards.forEach(doc=>docs.set(doc.board.id,doc));cursor=result.nextCursor;
        if(cursor&&seen.has(cursor))throw new Error('The board directory could not finish loading. Please refresh.');
        if(cursor)seen.add(cursor);
        if(++pages>100)throw new Error('There are too many boards to load at once. Please try again.');
      }while(cursor);
      S.docs=[...docs.values()].sort((a,b)=>b.board.updatedAt-a.board.updatedAt);S.lastSync=Date.now();
      $('load-error').hidden=true;$('sync-status').textContent=`Live · updated ${clock(S.lastSync,VIEWER_TZ)}`;render();
    }catch(error){$('load-error').hidden=false;$('load-error').textContent=`Could not refresh boards: ${error.message} ${S.docs.length?'Showing the last successful update.':''}`;$('sync-status').textContent='Connection problem · retrying';}
    finally{S.loading=false;$('refresh-btn').disabled=false;}
  }
  function openEditor(id) {
    const doc=S.docs.find(d=>d.board.id===id);if(!doc)return;
    if(S.editor?.dirty&&S.editor.doc.board.id!==id&&!confirm('Leave your unsaved hours and open this board?'))return;
    let identity=getMe(doc);if(!identity){identity={pid:'p_'+randomKey(9),key:randomKey()};local.set(teacherStorageKeys(id).me,identity);}
    const mine=doc.participants[identity.pid],profile=local.get('cb:teacher:profile')||{};
    const pending=local.get(teacherStorageKeys(id).pending);
    S.editor={doc,identity,slots:new Set(pending?pending.slots:mine?validSlots(doc,mine):[]),name:pending?pending.name:mine?.name||profile.name||'',dirty:!!pending,saving:false};
    $('teacher-name').value=S.editor.name;$('teacher-editor').hidden=false;$('save-status').textContent='';
    renderEditor();$('teacher-editor').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function reconcileEditor() {
    const editor=S.editor,latest=S.docs.find(d=>d.board.id===editor.doc.board.id);
    if(!latest){editor.unavailable=true;$('save-hours').disabled=true;$('save-status').textContent='This board is no longer current. Choose another board.';return;}
    editor.unavailable=false;
    const latestMine=latest.participants[editor.identity.pid];
    if(latestMine&&latestMine.role!=='teacher'){editor.unavailable=true;$('save-hours').disabled=true;$('save-status').textContent='This saved entry is no longer a teacher. Close this editor and open it again to create a separate teacher entry.';return;}
    if(!editor.dirty&&latestMine){editor.slots=new Set(validSlots(latest,latestMine));editor.name=latestMine.name;$('teacher-name').value=latestMine.name;}
    const prior=editor.slots.size;editor.doc=latest;editor.slots=new Set(validSlots(latest,{slots:[...editor.slots]}));
    if(prior!==editor.slots.size){$('save-status').textContent='The organiser changed this board. Hours outside its new dates have been removed from your selection.';saveDraft();}
    renderEditor();
  }
  function renderEditor() {
    const editor=S.editor;if(!editor)return;const b=editor.doc.board;
    $('editor-board').textContent=b.title;
    $('editor-tz').textContent=`Mark hours in ${b.timezone.replace(/_/g,' ')} time. The combined timetable above uses your selected display time zone.`;
    const boardDays=days(b.startDate,b.endDate);const free=new Map();facPeople(editor.doc).forEach(p=>validSlots(editor.doc,p).forEach(slot=>free.set(slot,(free.get(slot)||0)+1)));
    const cells=[`<span class="tp-grid-corner">${esc(b.timezone.split('/').pop().replace(/_/g,' '))}</span>`,...boardDays.map(day=>`<button type="button" class="tp-grid-day" data-select-day="${day}" aria-label="Select or clear all of ${esc(shortDate(day))}" ${editor.saving?'disabled':''}>${esc(shortDate(day))}</button>`)];
    for(let hour=b.startHour;hour<b.endHour;hour++){
      cells.push(`<span class="tp-grid-time">${pad(hour)}:00</span>`);
      boardDays.forEach(day=>{const slot=`${day}T${pad(hour)}`,available=free.get(slot)||0;cells.push(`<button type="button" class="tp-grid-cell" data-slot="${slot}" ${available?`data-facilitators="${available}"`:''} aria-pressed="${editor.slots.has(slot)}" aria-label="${esc(shortDate(day))}, ${pad(hour)}:00–${pad(hour+1)}:00, ${available} facilitators available, ${editor.slots.has(slot)?'selected':'not selected'}" ${editor.saving?'disabled':''}>${editor.slots.has(slot)?'✓':available?String(available):'·'}</button>`);});
    }
    // Preserve keyboard focus when polling or toggling the grid rebuilds its buttons.
    const focused=document.activeElement?.dataset.slot;
    $('teacher-grid').style.gridTemplateColumns=`72px repeat(${boardDays.length},minmax(80px,1fr))`;$('teacher-grid').innerHTML=cells.join('');
    if(focused){const target=$('teacher-grid').querySelector(`[data-slot="${focused}"]`);if(target)target.focus({preventScroll:true});}
    $('selection-count').textContent=plural(editor.slots.size,'hour')+' selected';$('save-hours').disabled=!!(editor.saving||editor.unavailable);$('teacher-name').disabled=editor.saving;$('clear-hours').disabled=editor.saving;
  }
  function saveDraft() {const e=S.editor;if(!e)return;e.name=$('teacher-name').value;e.dirty=true;local.set(teacherStorageKeys(e.doc.board.id).pending,{name:e.name,role:'teacher',slots:[...e.slots]});}
  async function saveTeacher(event) {
    event.preventDefault();const editor=S.editor;if(!editor||editor.saving||editor.unavailable)return;
    const name=$('teacher-name').value.trim();if(!name){$('teacher-name').focus();$('save-status').textContent='Enter your name first.';return;}
    saveDraft();editor.saving=true;renderEditor();$('save-status').textContent='Saving your availability…';
    try{
      const result=await api('PUT',{id:editor.doc.board.id,p:editor.identity.pid},{name,role:'teacher',slots:[...editor.slots]},editor.identity.key);
      editor.doc.participants[editor.identity.pid]=result.participant;editor.doc.version=result.version;editor.dirty=false;
      local.del(teacherStorageKeys(editor.doc.board.id).pending);local.set('cb:teacher:profile',{name,role:'teacher'});
      $('save-status').textContent=`Saved. ${plural(result.participant.slots.length,'hour')} shared with ${editor.doc.board.title}.`;$('save-status').className='tp-note tp-success';toast('Your teacher availability is saved.');
      render();
    }catch(error){$('save-status').textContent=`Not saved: ${error.message} Your selection is kept for retry.`;$('save-status').className='tp-note';}
    finally{editor.saving=false;if(S.editor===editor)renderEditor();}
  }
  async function copyDetails(text) {
    try{await navigator.clipboard.writeText(text);toast('Availability copied.');}
    catch{$('copy-text').value=text;$('copy-fallback').hidden=false;$('copy-fallback').scrollIntoView({behavior:'smooth',block:'center'});$('copy-text').focus();$('copy-text').select();}
  }
  function setup() {
    const today=dateKey(Date.now(),VIEWER_TZ);$('filter-from').value=today;$('filter-to').value=addDays(today,6);
    let zones;try{zones=Intl.supportedValuesOf('timeZone');}catch{zones=[];}
    zones=[...new Set([VIEWER_TZ,'Europe/Berlin','Asia/Kolkata','UTC',...zones])];
    $('display-tz').innerHTML=zones.map(tz=>`<option value="${esc(tz)}">${esc(tz.replace(/_/g,' '))}</option>`).join('');$('display-tz').value=VIEWER_TZ;
    const initialSearch=new URLSearchParams(location.search).get('search');if(initialSearch)$('board-search').value=initialSearch;
    $('filters-form').addEventListener('submit',event=>event.preventDefault());
    ['board-search','filter-from','filter-to','display-tz','show-empty'].forEach(id=>$(id).addEventListener(id==='board-search'?'input':'change',()=>{S.selectedCell=null;render();}));
    $('refresh-btn').addEventListener('click',()=>loadBoards());
    $('copy-combined').addEventListener('click',()=>copyDetails(availabilityText(S.rows,$('display-tz').value)));
    $('combined-list').addEventListener('click',event=>{const button=event.target.closest('[data-calendar-cell]');if(!button)return;S.selectedCell=button.dataset.calendarCell;$('combined-list').querySelectorAll('[data-calendar-cell]').forEach(el=>{el.setAttribute('aria-expanded',String(el===button));el.tabIndex=el===button?0:-1;});renderCellDetails();});
    $('combined-list').addEventListener('keydown',event=>{
      const button=event.target.closest('[data-calendar-cell]');if(!button)return;
      const directions={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};const move=directions[event.key];if(!move)return;
      event.preventDefault();let row=+button.dataset.calendarRow,col=+button.dataset.calendarCol;
      while(true){row+=move[0];col+=move[1];if(row<0||col<0||row>=S.calendar.bands.length||col>=S.calendar.dates.length)break;const target=$('combined-list').querySelector(`[data-calendar-row="${row}"][data-calendar-col="${col}"]`);if(target){button.tabIndex=-1;target.tabIndex=0;target.focus();break;}}
    });
    $('calendar-details').addEventListener('click',event=>{if(event.target.closest('#copy-selected-time')){const cell=selectedCalendarCell();if(cell)copyDetails(availabilityText([cell],$('display-tz').value));}const edit=event.target.closest('[data-edit-calendar-board]');if(edit)openEditor(edit.dataset.editCalendarBoard);});
    $('board-list').addEventListener('click',event=>{
      const edit=event.target.closest('[data-edit-board]');if(edit){openEditor(edit.dataset.editBoard);return;}
      const copy=event.target.closest('[data-copy-board]');if(copy){const doc=S.docs.find(d=>d.board.id===copy.dataset.copyBoard);const timezone=$('display-tz').value;const b=doc.board;const from=dateKey(slotInstant(b.startDate,b.startHour,b.timezone),timezone),to=dateKey(slotInstant(b.endDate,b.endHour,b.timezone)-1,timezone);const rows=aggregateAvailability([doc],{from,to,timezone,includeBooked:true});copyDetails(rows.length?availabilityText(rows,timezone,b.title):`${b.title}\nNo facilitator hours have been shared yet.\n${ORIGIN}/${boardPath(b.id)}`);}
    });
    $('teacher-grid').addEventListener('click',event=>{if(!S.editor||S.editor.saving)return;const cell=event.target.closest('[data-slot]'),day=event.target.closest('[data-select-day]');if(cell){const slot=cell.dataset.slot;S.editor.slots.has(slot)?S.editor.slots.delete(slot):S.editor.slots.add(slot);}else if(day){const b=S.editor.doc.board;const slots=Array.from({length:b.endHour-b.startHour},(_,i)=>`${day.dataset.selectDay}T${pad(b.startHour+i)}`);const remove=slots.every(slot=>S.editor.slots.has(slot));slots.forEach(slot=>remove?S.editor.slots.delete(slot):S.editor.slots.add(slot));}else return;saveDraft();renderEditor();});
    $('teacher-name').addEventListener('input',saveDraft);$('teacher-form').addEventListener('submit',saveTeacher);
    $('clear-hours').addEventListener('click',()=>{S.editor.slots.clear();saveDraft();renderEditor();});
    $('close-editor').addEventListener('click',()=>{if(S.editor?.saving)return;$('teacher-editor').hidden=true;S.editor=null;});
    $('close-copy').addEventListener('click',()=>$('copy-fallback').hidden=true);
    window.addEventListener('beforeunload',event=>{if(S.editor?.dirty){event.preventDefault();event.returnValue='';}});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadBoards(true);});
    loadBoards();setInterval(()=>{if(!document.hidden)loadBoards(true);},15000);
  }
  setup();
})();
