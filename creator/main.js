'use strict';
/* Creator workspace page boot. Shared code comes from ../js, the workspace itself from creator.js. */
function afterRender(hash){
  try{ syncWishIcons(); }catch(e){}
  setupBackToTop();
}
function setupBackToTop(){
  let bt = $('#backTop');
  if(!bt){
    bt = document.createElement('button');
    bt.id = 'backTop'; bt.className = 'back-top icon-btn'; bt.innerHTML = '↑';
    bt.onclick = () => window.scrollTo({top:0, behavior:'smooth'});
    document.body.appendChild(bt);
  }
  window.onscroll = debounce(() => { bt.classList.toggle('show', window.scrollY > 400); }, 80);
}
seedIfNeeded();
applyTheme();
registerServiceWorker();
setTimeout(warmBackend, 800);
render();
